// Per-session replay registry for non-claude providers (ADR-021 / PHASE-SR-0).
//
// This module is the single seam that backs three Work Items, all gated behind
// the per-provider flag `SESSION_REGISTRY_<P>` (e.g. SESSION_REGISTRY_agy):
//
//   * B-N5  — a session may start under a temporary `connectionId` before its
//             real `sessionId` is known, then be `rekey`-ed to the sessionId
//             without losing or duplicating any buffered message.
//   * B-N7  — a single `active` flag per session is the ONE source of truth for
//             "is this session processing", consumed by both check-session-status
//             (attach) and the future drain path.
//   * B-N-ATTACH — read-only differential replay: a reconnecting socket receives
//             only buffered messages whose `seq > lastSeq`. It NEVER swaps the
//             active writer and NEVER aborts the running session.
//
// Injection point for the RingBuffer is the provider's LIVE stream emit
// (`safeSend(stream_delta)` in agy-cli.js), NOT normalizeMessage (a dead layer
// that returns []). See ADR-021 §"ثلاثة تصحيحات".
//
// Coexistence contract: when the flag is OFF, every method here is a cheap no-op
// and callers behave exactly as they did before this slice existed.

const DEFAULT_RING_CAPACITY = 2000;

// Upper bound on the number of live entries the registry retains at once
// (B-N-EVICT). When an insertion would exceed this, the least-recently-used
// INACTIVE entry is evicted first; an all-active registry is never trimmed
// (evicting a live session would break a concurrent attach / drain). The cap is
// a backstop against unbounded growth across long uptimes — the per-entry
// RingBuffer already bounds memory per session; this bounds the session count.
const MAX_LIVE_SESSIONS = 200;

// Truthy-string flag parse: "1", "true", "yes", "on" (case-insensitive) enable.
function flagEnabled(name) {
    const raw = process.env[name];
    if (typeof raw !== 'string') return false;
    const v = raw.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// A bounded, monotonic-seq message ring for one session. `seq` never resets and
// never repeats for the life of the entry, so differential replay (seq > lastSeq)
// is always unambiguous even after the oldest payloads are evicted.
class RingBuffer {
    constructor(capacity = DEFAULT_RING_CAPACITY) {
        this.capacity = Math.max(1, capacity | 0);
        this.items = []; // [{ seq, payload }], ordered by ascending seq
        this.seq = 0; // last assigned seq; first push yields 1
    }

    // Append a payload, assign it the next seq, evict oldest beyond capacity.
    // Returns the assigned seq.
    push(payload) {
        this.seq += 1;
        this.items.push({ seq: this.seq, payload });
        if (this.items.length > this.capacity) {
            this.items.splice(0, this.items.length - this.capacity);
        }
        return this.seq;
    }

    // Return buffered entries strictly newer than `lastSeq`, oldest-first.
    // lastSeq <= 0 (or undefined) replays everything still retained.
    since(lastSeq = 0) {
        const floor = Number.isFinite(lastSeq) ? lastSeq : 0;
        if (floor <= 0) return this.items.slice();
        return this.items.filter((it) => it.seq > floor);
    }

    // Highest seq assigned so far (0 before the first push).
    get lastSeq() {
        return this.seq;
    }
}

// One session's mutable state inside the registry.
class SessionEntry {
    constructor(capacity) {
        this.buffer = new RingBuffer(capacity);
        // B-N7 single source of truth for "processing". Set true on spawn,
        // false when the run reaches a terminal state (complete/error/exit).
        this.active = false;
        // B-N-EVICT recency stamp: a monotonic tick bumped on every open/record
        // touch, used to pick the least-recently-used inactive entry to evict
        // when the live-session cap is exceeded.
        this.touch = 0;
    }
}

// A per-provider registry. One instance per provider keeps flags and buffers
// isolated so agy can ship before codex without cross-talk.
class SessionRegistry {
    constructor(flagName, { capacity = DEFAULT_RING_CAPACITY, maxEntries = MAX_LIVE_SESSIONS } = {}) {
        this.flagName = flagName;
        this.capacity = capacity;
        this.maxEntries = Math.max(1, maxEntries | 0);
        this.entries = new Map(); // key (connectionId | sessionId) -> SessionEntry
        // Monotonic recency counter for LRU eviction (B-N-EVICT). Never resets.
        this._tick = 0;
    }

    // Bump and return the next recency tick. Used to stamp an entry on touch so
    // eviction can pick the oldest-touched inactive entry.
    _nextTick() {
        this._tick += 1;
        return this._tick;
    }

    // B-N-EVICT: enforce the live-session cap. Called right before inserting a
    // NEW key. Evicts the least-recently-used INACTIVE entry when the map is at
    // capacity; if every entry is active it logs a warning and trims nothing —
    // dropping a live session would break a concurrent attach / drain.
    _enforceCap() {
        if (this.entries.size < this.maxEntries) return;

        let victimKey = null;
        let victimTouch = Infinity;
        for (const [key, entry] of this.entries) {
            if (entry.active) continue;
            if (entry.touch < victimTouch) {
                victimTouch = entry.touch;
                victimKey = key;
            }
        }

        if (victimKey === null) {
            // All retained sessions are still active — never evict a live one.
            console.warn(
                `[session-registry:${this.flagName}] live-session cap (${this.maxEntries}) reached with all entries active; not evicting.`,
            );
            return;
        }
        this.entries.delete(victimKey);
    }

    // Live read of the gating flag so tests/ops can toggle it without re-import.
    get enabled() {
        return flagEnabled(this.flagName);
    }

    // Ensure an entry exists for `key` and mark it active. No-op (returns null)
    // when the flag is off so the legacy path is untouched.
    open(key) {
        if (!this.enabled || !key) return null;
        let entry = this.entries.get(key);
        if (!entry) {
            this._enforceCap();
            entry = new SessionEntry(this.capacity);
            this.entries.set(key, entry);
        }
        entry.active = true;
        entry.touch = this._nextTick();
        return entry;
    }

    // Buffer a live payload under `key`, assigning it the next seq. The entry is
    // created on demand (covers the temporary-connectionId window before rekey).
    // Returns the assigned seq, or null when disabled / no key.
    record(key, payload) {
        if (!this.enabled || !key) return null;
        let entry = this.entries.get(key);
        if (!entry) {
            this._enforceCap();
            entry = new SessionEntry(this.capacity);
            entry.active = true;
            this.entries.set(key, entry);
        }
        entry.touch = this._nextTick();
        return entry.buffer.push(payload);
    }

    // B-N5: move the entry from a temporary key to the real sessionId without
    // losing or duplicating buffered messages.
    //
    //   * oldKey absent           -> nothing buffered yet; create the target.
    //   * newKey free             -> plain move (seq counter preserved).
    //   * newKey already present  -> a collision: the production caller always
    //                                clears a prior same-sessionId entry (drop +
    //                                open) BEFORE rekeying a fresh connectionId
    //                                onto it (B-N-RESUME clean buffer), so a live
    //                                target here means two distinct runs are
    //                                racing the same sessionId. Throw rather than
    //                                silently merge them into a corrupt stream.
    rekey(oldKey, newKey) {
        if (!this.enabled || !oldKey || !newKey || oldKey === newKey) return;

        const source = this.entries.get(oldKey);
        const target = this.entries.get(newKey);

        if (!source) {
            // Late capture with no buffered preamble: just ensure the target slot.
            if (!target) this.open(newKey);
            return;
        }

        if (target) {
            // Unexpected collision (see contract above): refuse to merge.
            throw new Error(
                `[session-registry:${this.flagName}] rekey collision: target key "${newKey}" already exists; refusing to merge two runs.`,
            );
        }

        // Fast path: hand the whole entry over, seq counter intact.
        this.entries.set(newKey, source);
        this.entries.delete(oldKey);
    }

    // B-N7: read the single source of truth for "is this session processing".
    isActive(key) {
        if (!this.enabled || !key) return false;
        return this.entries.get(key)?.active === true;
    }

    // B-N7: flip the active flag. Called false on terminal states.
    setActive(key, active) {
        if (!this.enabled || !key) return;
        const entry = this.entries.get(key);
        if (entry) entry.active = active === true;
    }

    // Current highest seq for a session (0 if unknown). Lets a fresh socket
    // bound its replay request.
    lastSeq(key) {
        if (!this.enabled || !key) return 0;
        return this.entries.get(key)?.buffer.lastSeq ?? 0;
    }

    // B-N-ATTACH: read-only differential replay. Invokes `send(payload)` for each
    // buffered message with `seq > lastSeq`, oldest-first. Returns the highest seq
    // replayed (or the supplied lastSeq when nothing newer exists). Performs NO
    // writer swap and NO abort — it only re-emits buffered payloads to the caller's
    // socket. Returns null when disabled or the session is unknown.
    attach(key, lastSeq, send) {
        if (!this.enabled || !key || typeof send !== 'function') return null;
        const entry = this.entries.get(key);
        if (!entry) return null;
        let highest = Number.isFinite(lastSeq) ? lastSeq : 0;
        for (const { seq, payload } of entry.buffer.since(lastSeq)) {
            send(payload);
            if (seq > highest) highest = seq;
        }
        return highest;
    }

    // Drop a session's buffer once the run is fully terminal and replay is no
    // longer needed. Keeps the registry from growing unbounded across uptime.
    drop(key) {
        if (!key) return;
        this.entries.delete(key);
    }
}

export { SessionRegistry, RingBuffer, flagEnabled, DEFAULT_RING_CAPACITY, MAX_LIVE_SESSIONS };
