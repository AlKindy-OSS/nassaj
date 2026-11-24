/**
 * Long-lived ACP agent processes (T-2094), one per (member, conversation).
 *
 * Generic: an entry holds whatever handle the adapter's `spawn()` returns
 * (`{ pid, kill(signal), onExit(cb) }`) plus adapter state. Rules (design +
 * qa-critic conditions):
 *   - one process per member per conversation, never shared; the key is
 *     chosen by the adapter and includes the member;
 *   - the env fingerprint is compared on EVERY acquire: a mismatch kills the
 *     process and spawns a new one (QA 3);
 *   - lazy spawn; idle processes die after `idleTimeoutMs` (10 min);
 *   - capacity from available memory, ≤3 per member; when full the oldest idle
 *     process is evicted, and with none idle the acquire reports `full` so the
 *     caller runs that turn without the pool (QA 4);
 *   - `drainProvider()` (harness update, QA 2) kills idle processes at once and
 *     retires busy ones, which then die when their turn releases them.
 * The module imports nothing of the server, so the harness-update lease may
 * import it without an import cycle.
 */

import fs from 'node:fs';

export const ACP_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const ACP_PER_MEMBER_CAP = 3;
export const ACP_MAX_PROCESSES = 12;
/** Conservative per-process estimate (idle unauthenticated agy ≈ 164 MB RSS). */
export const ACP_PROCESS_ESTIMATE_BYTES = 512 * 1024 * 1024;

/** provider → live pools, for drainProvider(). */
const poolsByProvider = new Map();

/** MemAvailable from /proc/meminfo in bytes, or null when unreadable. */
export function readMemAvailableBytes(readFile = fs.readFileSync) {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFile('/proc/meminfo', 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** floor(MemAvailable × 0.5 / per-process estimate), clamped to 1..max. */
export function computeAcpCapacity({
  memAvailableBytes = readMemAvailableBytes(),
  perProcessBytes = ACP_PROCESS_ESTIMATE_BYTES,
  max = ACP_MAX_PROCESSES,
} = {}) {
  if (!Number.isFinite(memAvailableBytes) || memAvailableBytes <= 0) return 1;
  const fit = Math.floor((memAvailableBytes * 0.5) / perProcessBytes);
  return Math.min(max, Math.max(1, fit));
}

/**
 * Kills every pooled process of `provider` that is idle now; busy ones are
 * retired (killed at release). Synchronous by contract: the harness updater
 * calls it right after taking its lease and before touching the binary.
 * @returns {number} processes killed now
 */
export function drainProvider(provider) {
  let killed = 0;
  for (const pool of poolsByProvider.get(provider) ?? []) {
    try {
      killed += pool.drain('harness_update');
    } catch {
      // Never throws: the caller holds a lease and must not be interrupted.
    }
  }
  return killed;
}

/** Kills one entry (idempotent) and drops it from the pool. */
function killEntry(ctx, entry, reason) {
  clearTimeout(entry.idleTimer);
  if (ctx.entries.get(entry.key) === entry) ctx.entries.delete(entry.key);
  if (entry.dead) return;
  entry.dead = true;
  // Why the pool ended it (revoke, eviction, …): the adapter reports it to a live turn.
  entry.killReason = reason;
  ctx.logger.info(JSON.stringify({ event: 'acp_pool_kill', provider: ctx.provider, pid: entry.handle?.pid ?? null, reason }));
  try {
    entry.handle?.kill('SIGTERM');
  } catch {
    // Already gone.
  }
}

function oldestIdle(ctx, filter) {
  return [...ctx.entries.values()]
    .filter((e) => !e.busy && filter(e))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0] ?? null;
}

/** Frees one slot when a limit is reached; false when nothing idle can go. */
function makeRoom(ctx, userId) {
  const mine = (e) => e.userId === userId;
  if ([...ctx.entries.values()].filter(mine).length >= ctx.perMemberCap) {
    const victim = oldestIdle(ctx, mine);
    if (!victim) return false;
    killEntry(ctx, victim, 'member_cap');
  }
  if (ctx.entries.size >= ctx.capacity()) {
    const victim = oldestIdle(ctx, () => true);
    if (!victim) return false;
    killEntry(ctx, victim, 'pool_full');
  }
  return true;
}

/** Spawns a busy entry for `spec` and forgets it when its process exits. */
function spawnEntry(ctx, { key, userId, fingerprint, cwd, spawn }) {
  const entry = {
    key, userId, fingerprint, cwd, handle: null, busy: true, retired: false, dead: false,
    lastUsedAt: ctx.now(), idleTimer: null, state: {},
  };
  entry.handle = spawn();
  ctx.entries.set(key, entry);
  entry.handle.onExit?.(() => {
    entry.dead = true;
    clearTimeout(entry.idleTimer);
    if (ctx.entries.get(entry.key) === entry) ctx.entries.delete(entry.key);
  });
  return entry;
}

/** Takes the process for `spec.key` for one turn, spawning it when absent. */
function acquireEntry(ctx, spec) {
  const existing = ctx.entries.get(spec.key);
  if (existing?.busy) return { status: 'busy' };
  if (existing && existing.fingerprint === spec.fingerprint) {
    clearTimeout(existing.idleTimer);
    existing.busy = true;
    return { status: 'reused', entry: existing };
  }
  if (existing) killEntry(ctx, existing, 'fingerprint_changed');
  if (!makeRoom(ctx, spec.userId)) return { status: 'full' };
  return { status: 'spawned', entry: spawnEntry(ctx, spec) };
}

/** Ends a turn: back to idle (with its timer), or killed if retired/dead. */
function releaseEntry(ctx, entry, { keep = true } = {}) {
  entry.busy = false;
  entry.lastUsedAt = ctx.now();
  if (!keep || entry.retired || entry.dead) {
    killEntry(ctx, entry, entry.retired ? 'retired' : 'released');
    return;
  }
  entry.idleTimer = setTimeout(() => killEntry(ctx, entry, 'idle_timeout'), ctx.idleTimeoutMs);
  entry.idleTimer.unref?.();
}

function rekeyEntry(ctx, entry, nextKey) {
  if (ctx.entries.get(entry.key) === entry) ctx.entries.delete(entry.key);
  const clash = ctx.entries.get(nextKey);
  if (clash && clash !== entry) killEntry(ctx, clash, 'rekey_replaced');
  entry.key = nextKey;
  if (!entry.dead) ctx.entries.set(nextKey, entry);
}

function killMemberEntries(ctx, userId, { cwdPrefix = null, reason = 'member_revoked' } = {}) {
  const base = cwdPrefix ? cwdPrefix.replace(/\/+$/, '') : null;
  const inScope = (e) => !base || e.cwd === base || String(e.cwd).startsWith(`${base}/`);
  const victims = [...ctx.entries.values()].filter((e) => e.userId === userId && inScope(e));
  victims.forEach((e) => killEntry(ctx, e, reason));
  return victims.length;
}

/** Kills idle entries now; retires busy ones (killed at release). */
function drainEntries(ctx, reason) {
  let killed = 0;
  for (const entry of [...ctx.entries.values()]) {
    if (entry.busy) entry.retired = true;
    else { killEntry(ctx, entry, reason); killed += 1; }
  }
  return killed;
}

/**
 * @param {{ provider: string, capacity?: () => number, idleTimeoutMs?: number,
 *   perMemberCap?: number, now?: () => number, logger?: Pick<Console, 'info'> }} options
 */
export function createAcpProcessPool(options) {
  const ctx = {
    provider: options.provider,
    capacity: options.capacity ?? (() => computeAcpCapacity()),
    idleTimeoutMs: options.idleTimeoutMs ?? ACP_IDLE_TIMEOUT_MS,
    perMemberCap: options.perMemberCap ?? ACP_PER_MEMBER_CAP,
    now: options.now ?? Date.now,
    logger: options.logger ?? console,
    entries: new Map(),
  };
  const pool = {
    acquire: (spec) => acquireEntry(ctx, spec),
    release: (entry, opts) => releaseEntry(ctx, entry, opts),
    rekey: (entry, nextKey) => rekeyEntry(ctx, entry, nextKey),
    kill: (entry, reason) => killEntry(ctx, entry, reason),
    killKey(key, reason = 'killed') {
      const entry = ctx.entries.get(key);
      if (!entry) return false;
      killEntry(ctx, entry, reason);
      return true;
    },
    killMember: (userId, opts) => killMemberEntries(ctx, userId, opts),
    drain: (reason = 'drain') => drainEntries(ctx, reason),
    shutdown: () => [...ctx.entries.values()].forEach((e) => killEntry(ctx, e, 'shutdown')),
    get: (key) => ctx.entries.get(key) ?? null,
    size: () => ctx.entries.size,
  };
  if (!poolsByProvider.has(ctx.provider)) poolsByProvider.set(ctx.provider, new Set());
  poolsByProvider.get(ctx.provider).add(pool);
  return pool;
}
