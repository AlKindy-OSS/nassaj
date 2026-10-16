/**
 * Display-time secret masking (ADR-210, T-2036).
 *
 * ADR-089 lets every member read every session, so credentials an agent prints
 * (API keys, tokens, passwords) must not reach a viewer verbatim. Masking runs
 * at each egress to a viewer — the live WebSocket chokepoint, attach-replay,
 * history, search, /btw, agent reports and the sidebar — and never touches what
 * is stored on disk or what the agent/model sees. The rules are the display
 * profile of secret-patterns.js plus one shared set of known secret values.
 *
 * Kill switches: env `NASSAJ_DISPLAY_MASKING=0` (wins), or app_config
 * `display_secret_masking` set to `false`/`0`/`off`. Default ON.
 */
import { createHash } from 'node:crypto';

import { listServiceSecretValues } from '@/shared/secret-path-guard.js';
import { collectDisplayHits, displayMarker } from '@/services/secret-patterns.js';

/** Bumped whenever the display rules change what a viewer sees (history revision folds it in). */
export const DISPLAY_MASK_VERSION = 2;

/** app_config key of the admin toggle. */
export const DISPLAY_MASK_SETTING_KEY = 'display_secret_masking';

/**
 * Top-level message fields that are identity or protocol metadata, never
 * free text: every OTHER field is walked. A new text field is therefore
 * masked by default (fail closed) instead of needing to be listed.
 */
const UNMASKED_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
  'id', 'type', 'kind', 'role', 'provider', 'sessionId', 'timestamp', 'sequence', 'rowid', 'requestId',
  'toolId', 'toolUseId', 'parentToolUseId', 'toolName', 'clientMsgId', 'displayClientMsgId',
  'steerClientMsgId', 'responseToMessageId', 'transcriptMessageId', 'newSessionId', 'parentSessionId',
  'forkedSessionId', 'btwId', 'wfId', 'userId', 'coordinatorId', 'coordinationLevel', 'deliveryStatus',
  'originKind', 'model', 'code', 'mode', 'taskStatus', 'images', 'historyLease', 'deferredPayload',
]);
/** Containers nested deeper than this are replaced by a marker (fail closed), never returned raw. */
const MAX_WALK_DEPTH = 12;
/** Strings longer than this are replaced whole: masking them is not worth the latency. */
const MAX_MASKED_STRING = 16 * 1024 * 1024;
const SETTING_TTL_MS = 5_000;
const KNOWN_VALUES_TTL_MS = 60_000;

export type DisplayMaskContext = { literals?: readonly string[] };

type DisplayMaskRepositories = {
  readSetting: (key: string) => string | null;
  allUserIds: () => Array<string | number>;
  vendorLiterals: (userId: string | number) => string[];
  sharedVendorLiterals: () => string[];
};

/**
 * The database and provider-secret services are loaded lazily, never as static
 * imports: the WebSocket writer imports this module, so a static edge would
 * pull the whole repository graph into every writer consumer (and break the
 * many tests that replace the database barrel with a partial mock). Until they
 * load, masking runs on the rules and the service secrets with the default ON.
 */
let repositories: DisplayMaskRepositories | null = null;
export const displayMaskRepositoriesReady: Promise<void> = Promise.all([
  import('@/modules/database/repositories/app-config.js'),
  import('@/modules/database/repositories/users.js'),
  import('@/modules/providers/services/provider-secrets.service.js'),
  import('@/services/isolation/provider-slot-key.js'),
]).then(([{ appConfigDb }, { userDb }, { providerSecretsService }, { resolveSlotKey }]) => {
  repositories = {
    readSetting: (key) => appConfigDb.get(key),
    allUserIds: () => userDb.listUsers().map((row) => row.id),
    vendorLiterals: (userId) => providerSecretsService.getVendorRedactionSecrets(userId),
    // The organisation-wide (shared) vendor slots: no member owns them, every run may print them.
    // Qwen has no shared slot (ADR-101), so it is not listed. Read through the one
    // door into the shared slot (T-1260): no identity means the shared slot only.
    sharedVendorLiterals: () => (['kimi', 'deepseek', 'glm'] as const).flatMap((provider) => {
      try {
        const key = resolveSlotKey(null, provider, { sharedFallback: true })?.key;
        return typeof key === 'string' && key ? [key] : [];
      } catch {
        return [];
      }
    }),
  };
}).catch((error: unknown) => {
  // Logged once: without these sources the admin toggle and member vendor keys are not applied.
  console.warn('[display-mask] known-value sources unavailable; masking uses rules and service secrets only', {
    error: error instanceof Error ? error.name : 'unknown',
  });
});

/** Injectable sources; tests replace them, production uses the defaults. */
export type DisplayMaskSources = {
  /** False until the lazily loaded sources are available; results are not cached before. */
  ready: () => boolean;
  env: () => string | undefined;
  readSetting: () => string | null;
  serviceLiterals: () => string[];
  allUserIds: () => Array<string | number>;
  vendorLiterals: (userId: string | number) => string[];
  sharedVendorLiterals: () => string[];
  now: () => number;
};

const defaultSources: DisplayMaskSources = {
  ready: () => repositories !== null,
  env: () => process.env.NASSAJ_DISPLAY_MASKING,
  readSetting: () => repositories?.readSetting(DISPLAY_MASK_SETTING_KEY) ?? null,
  serviceLiterals: () => listServiceSecretValues(),
  allUserIds: () => repositories?.allUserIds() ?? [],
  vendorLiterals: (userId) => repositories?.vendorLiterals(userId) ?? [],
  sharedVendorLiterals: () => repositories?.sharedVendorLiterals() ?? [],
  now: () => Date.now(),
};

let sources: DisplayMaskSources = defaultSources;
let settingCache: { at: number; enabled: boolean } | null = null;
let knownValuesCache: { at: number; values: string[]; fingerprint: string } | null = null;

/** Test seam: override sources (null restores defaults) and clear every cache. */
export function configureDisplayMaskForTests(overrides: Partial<DisplayMaskSources> | null): void {
  sources = overrides ? { ...defaultSources, ready: () => true, ...overrides } : defaultSources;
  settingCache = null;
  knownValuesCache = null;
  liveStreamMasker.clear();
  liveViews.clear();
}

/** True unless the env kill switch or the admin setting turned masking off. */
export function isDisplayMaskingEnabled(): boolean {
  if (sources.env() === '0') return false;
  const now = sources.now();
  if (settingCache && now - settingCache.at < SETTING_TTL_MS) return settingCache.enabled;
  let enabled = true;
  try {
    const raw = sources.readSetting();
    enabled = !(typeof raw === 'string' && /^(?:false|0|off|no)$/i.test(raw.trim()));
  } catch {
    enabled = true; // An unreadable setting never disables protection.
  }
  if (sources.ready()) settingCache = { at: now, enabled };
  return enabled;
}

/** Collects literals from one source, swallowing failures (a missing store masks less, never crashes). */
function safeLiterals(read: () => string[]): string[] {
  try {
    return read().filter((value) => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

/** Every user id, or none when the user store is unreadable. */
function safeUserIds(): Array<string | number> {
  try {
    return sources.allUserIds();
  } catch {
    return [];
  }
}

/**
 * The one set of known secret values every egress masks verbatim: the
 * service's own secrets, the organisation's shared vendor keys and every
 * member's own vendor keys. A member's key may be
 * printed in any session, so the set is global, not per session. Rebuilt at
 * most every 60 s; the cost is O(users × vendors).
 */
function knownValues(): { values: string[]; fingerprint: string } {
  const now = sources.now();
  if (knownValuesCache && now - knownValuesCache.at < KNOWN_VALUES_TTL_MS) return knownValuesCache;
  const vendor = safeUserIds().flatMap((userId) => safeLiterals(() => sources.vendorLiterals(userId)));
  const shared = safeLiterals(sources.sharedVendorLiterals);
  const values = [...new Set([...safeLiterals(sources.serviceLiterals), ...shared, ...vendor])].sort();
  // Only a digest of the set leaves this module (folded into history revisions).
  const fingerprint = createHash('sha256').update(values.join('\u0000')).digest('base64url').slice(0, 16);
  const entry = { at: now, values, fingerprint };
  if (sources.ready()) knownValuesCache = entry;
  return entry;
}

/** Known secret values to mask verbatim. The set is global; `sessionId` is accepted for call-site clarity. */
export function displayLiteralsForSession(_sessionId?: string | null): string[] {
  return knownValues().values;
}

/**
 * Masks credentials in one string. Values become `[masked:<rule-id>]`; the
 * NAME of `NAME=value` stays. Non-strings are returned unchanged.
 */
export function maskText<T>(text: T, ctx: DisplayMaskContext = {}): T {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (text.length > MAX_MASKED_STRING) return displayMarker('oversize') as T;
  return renderHits(text, hitsOf(text, ctx), 0, text.length) as T;
}

type Hit = { start: number; end: number; rule: string };

function hitsOf(text: string, ctx: DisplayMaskContext): Hit[] {
  return collectDisplayHits(text, ctx) as Hit[];
}

/**
 * Renders `source[from, to)`, replacing every hit that overlaps it. A hit that
 * straddles either edge becomes a marker on this side too — never a fragment.
 */
function renderHits(source: string, hits: readonly Hit[], from: number, to: number): string {
  let out = '';
  let cursor = from;
  for (const hit of hits) {
    if (hit.end <= from) continue;
    if (hit.start >= to) break;
    out += source.slice(cursor, Math.max(hit.start, from)) + displayMarker(hit.rule);
    cursor = Math.min(hit.end, to);
  }
  return out + source.slice(cursor, to);
}

/** Recursively masks every string of `value`; containers are copied only when something changed. */
function maskValue(value: unknown, ctx: DisplayMaskContext, depth: number): unknown {
  if (typeof value === 'string') return maskText(value, ctx);
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_WALK_DEPTH) return displayMarker('depth');
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    value.forEach((item, index) => {
      const masked = maskValue(item, ctx, depth + 1);
      if (masked !== item) (copy ??= [...value])[index] = masked;
    });
    return copy ?? value;
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const masked = maskValue(item, ctx, depth + 1);
    if (masked !== item) (copy ??= { ...(value as Record<string, unknown>) })[key] = masked;
  }
  return copy ?? value;
}

/**
 * Returns a masked copy of a message: every field except the identity and
 * protocol metadata above is walked (plan items, subagent tools, status text
 * included). The input is never mutated; an unchanged message is returned as
 * the same object.
 */
export function maskMessage<T>(message: T, ctx: DisplayMaskContext = {}): T {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return maskValue(message, ctx, 0) as T;
  let copy: Record<string, unknown> | null = null;
  const source = message as Record<string, unknown>;
  for (const [field, value] of Object.entries(source)) {
    if (UNMASKED_TOP_LEVEL_FIELDS.has(field)) continue;
    const masked = maskValue(value, ctx, 1);
    if (masked !== value) (copy ??= { ...source })[field] = masked;
  }
  return (copy ?? message) as T;
}

/**
 * History revision a masked reader sees: the source revision folded with the
 * mask version and a digest of the known-value set, so a rule change or a new
 * member key invalidates every client-held revision.
 */
export function displayHistoryRevision(revision: string): string {
  return createHash('sha256')
    .update(`display-mask-v${DISPLAY_MASK_VERSION}:${knownValues().fingerprint}:${revision}`)
    .digest('base64url');
}

/** Masks a list-row label (sidebar title, search summary); unchanged when masking is off. */
export function maskDisplayLabel<T>(label: T): T {
  if (typeof label !== 'string' || !isDisplayMaskingEnabled()) return label;
  return maskText(label, { literals: knownValues().values });
}

/** Masks one viewer-bound text of a session's transcript; unchanged when masking is off. */
export function maskSessionText<T>(text: T, _sessionId: string | null): T {
  if (typeof text !== 'string' || !isDisplayMaskingEnabled()) return text;
  return maskText(text, { literals: knownValues().values });
}

/**
 * Masks a text that was clipped at a size cap (`truncated`): the clipped edge
 * may sit inside a secret whose remainder is gone, where no rule can match
 * it, so the partial last line (or, on a very long line, the partial last
 * token) is dropped before masking.
 */
export function maskClippedSessionText<T>(text: T, truncated: boolean, sessionId: string | null): T {
  if (typeof text !== 'string' || !truncated || !isDisplayMaskingEnabled()) return maskSessionText(text, sessionId);
  const newline = text.lastIndexOf('\n');
  const cut = newline >= text.length - LINE_HOLD_MAX ? newline + 1 : lastWhitespace(text, 0) + 1;
  return maskSessionText(text.slice(0, cut), sessionId) as T;
}

const MARKER_SPLIT = /(\[masked:[a-z-]{1,40}\])/;

/**
 * Rename round-trip (ADR-210): a client edits the title it was shown, which
 * may carry `[masked:<rule>]` markers. The stored raw values are put back only
 * when the result masks to EXACTLY the submitted text — i.e. the submitter
 * kept every value in the context that masks it. Moving a marker out of that
 * context (`leak: [masked:assignment]`) would unmask it, so such a title is
 * stored as submitted, markers and all.
 */
export function restoreMaskedLabel(submitted: string, storedRaw: string | null | undefined): string {
  if (typeof storedRaw !== 'string' || typeof submitted !== 'string' || !submitted.includes('[masked:')) return submitted;
  if (!isDisplayMaskingEnabled()) return submitted;
  const hits = hitsOf(storedRaw, { literals: knownValues().values });
  const parts = submitted.split(MARKER_SPLIT);
  if ((parts.length - 1) / 2 !== hits.length) return submitted;
  for (let index = 1; index < parts.length; index += 2) {
    const hit = hits[(index - 1) / 2];
    if (parts[index] !== displayMarker(hit.rule)) return submitted;
    parts[index] = storedRaw.slice(hit.start, hit.end);
  }
  const restored = parts.join('');
  return maskDisplayLabel(restored) === submitted ? restored : submitted;
}

/** Masks a list of messages with the known-value set. */
export function maskMessagesForSession<T>(messages: readonly T[], _sessionId: string | null): T[] {
  const ctx = { literals: knownValues().values };
  return messages.map((message) => maskMessage(message, ctx));
}

// ── Streaming ──────────────────────────────────────────────────────────────

/** Normal hold ceiling for one line. */
const LINE_HOLD_MAX = 4 * 1024;
/** Hold ceiling when no safe blank exists within a long line (still bounded). */
const HARD_HOLD_MAX = 16 * 1024;
const PEM_HOLD_MAX = 16 * 1024;
/** A long-line cut is re-evaluated only after the hold grew by this much (keeps streaming linear). */
const FORCED_STEP = 4 * 1024;
/** Emitted context kept per line: enough for every rule's prefix (`NAME = `, `Bearer `, `"key": "`). */
const CTX_MAX = 512;
/** Scan overlap so a risky opener or PEM marker split across deltas is still seen. */
const SCAN_OVERLAP = 16;
const MAX_STREAMS = 2_000;
const STREAM_IDLE_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
/**
 * A line holding one of these may carry a secret that contains blanks, so it
 * is not cut at blanks: a quote opening a VALUE (after `=` or `:`), a table
 * pipe, a cookie header or a PEM marker. A quote in prose ("don't") is not.
 */
const RISKY_LINE = /[=:][ \t]{0,8}\\?["'`]|\||cookie|-----/i;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/;
/** A complete `-----END …-----` line (a partial one keeps the block open). */
const PEM_ANY_END = /-----END [A-Z0-9 ]{0,40}-----/;

type StreamState = {
  sessionId: string;
  /** Tail (≤ CTX_MAX) of the emitted part of the current line. */
  ctx: string;
  /** Parity of `"` in the emitted part of the current line. */
  quoteParity: number;
  /** Raw text not emitted yet. */
  pending: string;
  /** Start of the current line inside `pending` (0 when it began before). */
  lineStart: number;
  /** The current line holds a risky opener. */
  risky: boolean;
  /** Start of an open PEM block inside `pending`, or -1. */
  pemStart: number;
  /** Offset just past a PEM block that closed inside `pending`, or 0. */
  pemClosedEnd: number;
  /** Dropping a PEM body after the hold ceiling was reached. */
  inPem: boolean;
  /** `pending.length` at the last long-line evaluation. */
  forcedAt: number;
  template: Record<string, unknown> | null;
  touchedAt: number;
};

const countQuotes = (text: string): number => {
  let count = 0;
  for (let at = text.indexOf('"'); at !== -1; at = text.indexOf('"', at + 1)) count += 1;
  return count;
};

/** Last whitespace index in `text` within [from, end), or -1. */
function lastWhitespace(text: string, from: number): number {
  for (let at = text.length - 1; at >= from; at -= 1) {
    const ch = text.charCodeAt(at);
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 160) return at;
  }
  return -1;
}

/**
 * Updates line, risk and PEM bookkeeping for `appended` text at `prev`;
 * O(appended). A marker split across deltas is completed by the appended
 * text, so each check only needs a short overlap window, and is skipped when
 * the appended text cannot complete it.
 */
function scanAppended(state: StreamState, prev: number, appended: string): void {
  const hasNewline = appended.includes('\n');
  if (state.risky && !hasNewline && !appended.includes('N') && state.pemStart === -1) return;
  const from = Math.max(0, prev - SCAN_OVERLAP);
  const window = state.pending.slice(from);
  const newline = hasNewline ? window.lastIndexOf('\n') : -1;
  if (newline !== -1 && from + newline + 1 > state.lineStart) {
    state.lineStart = from + newline + 1;
    state.risky = RISKY_LINE.test(state.pending.slice(state.lineStart));
  } else if (!state.risky) {
    // The opener may have been emitted already (`password = ` then `"a b"`):
    // the line's emitted tail is part of the window when the line began there.
    const emittedTail = state.lineStart === 0 && newline === -1 ? state.ctx.slice(-SCAN_OVERLAP) : '';
    state.risky = RISKY_LINE.test(emittedTail + window);
  }
  if (state.pemStart === -1 && appended.includes('N')) {
    const begin = window.lastIndexOf('-----BEGIN');
    if (begin !== -1 && from + begin >= state.pemClosedEnd) state.pemStart = from + begin;
  }
  if (state.pemStart !== -1) {
    const end = state.pending.indexOf('-----END', Math.max(state.pemStart, prev - 72));
    const marker = end === -1 ? null : PEM_ANY_END.exec(state.pending.slice(end, end + 64));
    if (marker) {
      state.pemClosedEnd = end + marker[0].length;
      state.pemStart = -1;
    }
  }
}

type CutDecision = { cut: number; forcePem: boolean; hits?: Hit[] };

/**
 * Where `pending` may be cut: everything before it is safe to emit now.
 * Rules are line-local (PEM aside), so a complete line is always safe; inside
 * the current line a blank is safe unless the line carries a risky opener.
 */
function decideCut(state: StreamState, prev: number, ctx: DisplayMaskContext): CutDecision {
  const { pending } = state;
  if (state.pemStart !== -1) {
    return { cut: state.pemStart, forcePem: pending.length - state.pemStart > PEM_HOLD_MAX };
  }
  let cut = Math.max(state.lineStart, state.pemClosedEnd);
  if (!state.risky) {
    // Blanks before `prev` were already considered by the previous push.
    const blank = lastWhitespace(pending, Math.max(cut, prev - 1));
    if (blank !== -1) cut = blank + 1;
  }
  if (pending.length - cut <= LINE_HOLD_MAX || pending.length - state.forcedAt < FORCED_STEP) {
    return { cut, forcePem: false };
  }
  state.forcedAt = pending.length;
  return forcedCut(state, cut, ctx);
}

/**
 * Cut for a line longer than the hold: the latest blank at or before the 4 KiB
 * mark that lies outside every hit and outside an open `"…"` value, so the
 * stream equals whole-text masking. When none exists the hold grows up to
 * 16 KiB; only past that is the line cut at the mark (a straddling hit still
 * becomes a marker). The hits found here are reused to render the chunk.
 */
function forcedCut(state: StreamState, floor: number, ctx: DisplayMaskContext): CutDecision {
  const { pending } = state;
  const target = pending.length - LINE_HOLD_MAX;
  const offset = state.ctx.length;
  const hits = hitsOf(state.ctx + pending, ctx);
  let quotes = (floor === 0 && state.lineStart === 0 ? state.quoteParity : 0) + countQuotes(pending.slice(floor, target));
  let hitIndex = hits.length - 1;
  for (let cut = target; cut > floor; cut -= 1) {
    while (hitIndex >= 0 && hits[hitIndex].start >= offset + cut) hitIndex -= 1;
    const touchesHit = hitIndex >= 0 && hits[hitIndex].end >= offset + cut;
    if (/\s/.test(pending[cut - 1]) && !touchesHit && quotes % 2 === 0) return { cut, forcePem: false, hits };
    if (pending[cut - 1] === '"') quotes -= 1;
  }
  return { cut: pending.length - floor <= HARD_HOLD_MAX ? floor : target, forcePem: false, hits };
}

/** Emits `pending[0, cut)` masked and advances the line context. */
function emit(state: StreamState, decision: CutDecision, ctx: DisplayMaskContext): string {
  const { cut } = decision;
  const source = state.ctx + state.pending;
  const offset = state.ctx.length;
  const out = cut > 0 ? renderHits(source, decision.hits ?? hitsOf(source, ctx), offset, offset + cut) : '';
  const chunk = state.pending.slice(0, cut);
  const newline = chunk.lastIndexOf('\n');
  const lineChunk = newline === -1 ? chunk : chunk.slice(newline + 1);
  state.quoteParity = ((newline === -1 ? state.quoteParity : 0) + countQuotes(lineChunk)) % 2;
  state.ctx = ((newline === -1 ? state.ctx : '') + lineChunk).slice(-CTX_MAX);
  state.pending = state.pending.slice(cut);
  state.lineStart = Math.max(0, state.lineStart - cut);
  state.pemClosedEnd = Math.max(0, state.pemClosedEnd - cut);
  state.pemStart = state.pemStart === -1 ? -1 : Math.max(0, state.pemStart - cut);
  state.forcedAt = Math.max(0, state.forcedAt - cut);
  return out;
}

/**
 * Masks token streams without ever emitting a partial secret. Each stream key
 * holds back only the unsafe tail (≤4 KiB; up to 16 KiB inside an open PEM
 * block or a line with no safe blank) and masks new text with the emitted part
 * of its line as context. Work per delta is linear in the delta, plus one scan
 * of the hold per 4 KiB of growth on lines longer than the hold.
 */
export class DisplayStreamMasker {
  private readonly streams = new Map<string, StreamState>();
  private readonly keysBySession = new Map<string, Set<string>>();
  private lastSweep = 0;

  /** Masks one delta of stream `key` (owned by `sessionId`); returns the text safe to emit now. */
  push(key: string, delta: string, template: Record<string, unknown> | null, ctx: DisplayMaskContext, sessionId = key): string {
    const state = this.state(key, sessionId);
    state.template = template;
    let appended = delta;
    if (state.inPem) {
      const buf = state.pending + delta;
      const end = PEM_END.exec(buf);
      if (!end) { state.pending = buf.slice(-64); return ''; }
      appended = buf.slice(end.index + end[0].length);
      Object.assign(state, { inPem: false, pending: '', ctx: '', quoteParity: 0, lineStart: 0, risky: false });
    }
    const prev = state.pending.length;
    state.pending += appended;
    scanAppended(state, prev, appended);
    const decision = decideCut(state, prev, ctx);
    let out = decision.cut > 0 ? emit(state, decision, ctx) : '';
    if (decision.forcePem) {
      out += displayMarker('pem-private-key');
      Object.assign(state, {
        inPem: true, pending: '', ctx: '', quoteParity: 0, lineStart: 0, risky: false, pemStart: -1, pemClosedEnd: 0, forcedAt: 0,
      });
    }
    return out;
  }

  /** True while `key` has an open stream. */
  has(key: string): boolean {
    return this.streams.has(key);
  }

  /** Open stream keys of a session. */
  keysFor(sessionId: string): string[] {
    return [...(this.keysBySession.get(sessionId) ?? [])];
  }

  /** Ends the stream: returns its masked held-back tail and the last delta frame, then forgets it. */
  flush(key: string, ctx: DisplayMaskContext): { text: string; template: Record<string, unknown> | null } {
    const state = this.streams.get(key);
    if (!state) return { text: '', template: null };
    this.forget(key);
    if (state.inPem || !state.pending) return { text: '', template: state.template };
    const source = state.ctx + state.pending;
    return { text: renderHits(source, hitsOf(source, ctx), state.ctx.length, source.length), template: state.template };
  }

  clear(): void {
    this.streams.clear();
    this.keysBySession.clear();
  }

  size(): number {
    return this.streams.size;
  }

  private forget(key: string): void {
    const state = this.streams.get(key);
    this.streams.delete(key);
    if (!state) return;
    const keys = this.keysBySession.get(state.sessionId);
    keys?.delete(key);
    if (keys?.size === 0) this.keysBySession.delete(state.sessionId);
  }

  private state(key: string, sessionId: string): StreamState {
    const now = sources.now();
    this.sweep(now);
    let state = this.streams.get(key);
    if (!state) {
      if (this.streams.size >= MAX_STREAMS) this.forget(this.leastRecentKey());
      state = {
        sessionId, ctx: '', quoteParity: 0, pending: '', lineStart: 0, risky: false, pemStart: -1, pemClosedEnd: 0,
        inPem: false, forcedAt: 0, template: null, touchedAt: now,
      };
      if (!this.keysBySession.has(sessionId)) this.keysBySession.set(sessionId, new Set());
      this.keysBySession.get(sessionId)!.add(key);
      this.streams.set(key, state);
    }
    state.touchedAt = now;
    return state;
  }

  /** Key touched longest ago (an O(n) scan, only when the stream cap is reached). */
  private leastRecentKey(): string {
    let oldest = '';
    let at = Infinity;
    for (const [key, state] of this.streams) {
      if (state.touchedAt < at) { at = state.touchedAt; oldest = key; }
    }
    return oldest;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [key, state] of this.streams) {
      if (now - state.touchedAt > STREAM_IDLE_MS) this.forget(key);
    }
  }
}

// ── Live frames ────────────────────────────────────────────────────────────

/** Kinds whose payload can carry agent or user text; every other kind passes byte-for-byte. */
const MASKED_KINDS: ReadonlySet<string> = new Set([
  'text', 'stream_delta', 'thinking', 'tool_use', 'tool_result', 'error', 'permission_request',
  'interactive_prompt', 'task_notification',
]);
/** Kinds that end every stream of the session. */
const SESSION_TERMINAL_KINDS: ReadonlySet<string> = new Set(['complete', 'error']);
/** The run owner answers these with the input it saw, so its sockets must see it raw. */
const OWNER_RAW_KINDS: ReadonlySet<string> = new Set(['permission_request', 'interactive_prompt']);
/**
 * Providers whose `thinking` frames are deltas of one reasoning stream (not
 * whole blocks): they get their own stream channel so a split secret is held.
 */
const STREAMED_THINKING_PROVIDERS: ReadonlySet<string> = new Set(['qwen', 'opencode', 'kimi', 'deepseek', 'glm']);

/** Frames to deliver in place of one live payload. */
export type DisplayFrames = {
  /** Synthetic frames (flushed stream tails) delivered to everyone first. */
  before: unknown[];
  /** What a socket of the run owner receives (raw permission input). */
  owner: unknown;
  /** What every other viewer receives. */
  viewer: unknown;
};

/** The stream a frame belongs to: a subagent's own deltas stream separately. */
function streamOf(frame: Record<string, unknown>): string {
  return typeof frame.parentToolUseId === 'string' && frame.parentToolUseId ? frame.parentToolUseId : 'main';
}

/** The delta channel of a frame, or null when the frame is a whole message. */
function channelOf(frame: Record<string, unknown>): 'text' | 'thinking' | null {
  if (frame.kind === 'stream_delta') return 'text';
  if (frame.kind === 'thinking' && STREAMED_THINKING_PROVIDERS.has(String(frame.provider))) return 'thinking';
  return null;
}

const streamKey = (sessionId: string, stream: string, channel: string) => `${sessionId}\u0000${stream}\u0000${channel}`;
const streamOfKey = (key: string) => key.split('\u0000')[1];

/** Builds the synthetic delta carrying a flushed tail (same kind as its channel). */
function tailFrame(template: Record<string, unknown> | null, text: string, sessionId: string): unknown {
  const base = template ?? { kind: 'stream_delta', sessionId };
  const { sequence: _sequence, ...rest } = base;
  const id = typeof rest.id === 'string' ? `${rest.id}:masked-tail` : `masked-tail:${sessionId}`;
  return { ...rest, id, content: text };
}

/** Flushes `keys` into tail frames. */
function flushKeys(masker: DisplayStreamMasker, keys: readonly string[], sessionId: string, ctx: DisplayMaskContext): unknown[] {
  const frames: unknown[] = [];
  for (const key of keys) {
    const tail = masker.flush(key, ctx);
    if (tail.text) frames.push(tailFrame(tail.template, tail.text, sessionId));
  }
  return frames;
}

/**
 * Streams whose held tail a frame releases: every stream for complete/error;
 * for a stream_end or any other text-bearing frame, both channels of its own
 * stream (providers without stream_end still release their tail); for a
 * delta, the OTHER channel of its stream (reasoning ended, text began).
 */
function keysReleasedBy(masker: DisplayStreamMasker, frame: Record<string, unknown>, sessionId: string, channel: string | null): string[] {
  const kind = String(frame.kind);
  if (SESSION_TERMINAL_KINDS.has(kind)) return masker.keysFor(sessionId);
  const stream = streamOf(frame);
  if (channel) {
    // Hot path (every delta): only the other channel of this stream can be open.
    const other = streamKey(sessionId, stream, channel === 'text' ? 'thinking' : 'text');
    return masker.has(other) ? [other] : [];
  }
  return masker.keysFor(sessionId).filter((key) => streamOfKey(key) === stream);
}

/**
 * Decides what each viewer receives for one live payload, or null when the
 * payload passes untouched (unmasked kind, masking off, or no session).
 */
export function prepareDisplayFrames(
  data: unknown, sessionId: string | null, masker: DisplayStreamMasker = liveStreamMasker,
): DisplayFrames | null {
  if (!data || typeof data !== 'object' || !sessionId) return null;
  const frame = data as Record<string, unknown>;
  const kind = typeof frame.kind === 'string' ? frame.kind : '';
  const masked = MASKED_KINDS.has(kind);
  if (!masked && kind !== 'stream_end' && !SESSION_TERMINAL_KINDS.has(kind)) return null;
  const enabled = isDisplayMaskingEnabled();
  // Switched off mid-stream: open streams finish masked so no tail is lost or half-shown.
  if (!enabled && masker.keysFor(sessionId).length === 0) return null;
  const ctx = { literals: knownValues().values };
  const channel = channelOf(frame);
  const before = flushKeys(masker, keysReleasedBy(masker, frame, sessionId, channel), sessionId, ctx);
  if (channel && typeof frame.content === 'string' && (enabled || masker.has(streamKey(sessionId, streamOf(frame), channel)))) {
    const key = streamKey(sessionId, streamOf(frame), channel);
    const out = { ...frame, content: masker.push(key, frame.content, frame, ctx, sessionId) };
    return remember(masker, frame, sessionId, { before, owner: out, viewer: out }, out);
  }
  if (!masked || !enabled) return before.length > 0 ? remember(masker, frame, sessionId, { before, owner: data, viewer: data }) : null;
  const view = maskMessage(frame, ctx);
  return remember(masker, frame, sessionId, { before, owner: OWNER_RAW_KINDS.has(kind) ? data : view, viewer: view });
}

// ── Replay ─────────────────────────────────────────────────────────────────

/**
 * What live viewers were sent, keyed by `sessionId:sequence` — the sequence is
 * stamped on the buffered ORIGINAL before it is sent, so a copy made on the
 * way to the writer (the clientMsgId echo) still finds its record. Only the
 * stream-dependent parts are kept: the flushed tails sent before a frame and a
 * delta's masked content; a whole message is re-masked at replay. Bounded LRU.
 */
/**
 * Kept per recorded frame: identity for verification, the tails flushed
 * before it, and for a delta its raw and masked text (strings shared with
 * the frames, no object copies). A whole message with nothing flushed before
 * it is not recorded at all — it is re-masked at replay.
 */
type LiveView = { kind: string; id: unknown; before: readonly unknown[]; delta: boolean; raw?: unknown; masked?: string };
const NO_FRAMES: readonly unknown[] = Object.freeze([]);
/** Per session, sized above the replay ring (2000 frames per session), so a ring frame keeps its view. */
const liveViews = new Map<string, Map<number, LiveView>>();
const MAX_VIEWS_PER_SESSION = 2_048;
/**
 * Sessions with recorded views, most recently written kept. Only sessions
 * that are streaming matter for a mid-turn joiner; a session evicted here
 * replays through the stateful pass masker instead (still masked, never a
 * raw prefix). Measured ceiling: 64 × 2048 entries ≈ 20 MB with their delta
 * strings retained (T-2036); the replay rings hold those strings anyway.
 */
const MAX_VIEW_SESSIONS = 64;

function remember(
  masker: DisplayStreamMasker, frame: Record<string, unknown>, sessionId: string, frames: DisplayFrames, delta?: unknown,
): DisplayFrames {
  if (masker !== liveStreamMasker || typeof frame.sequence !== 'number') return frames;
  if (delta === undefined && frames.before.length === 0) {
    liveViews.get(sessionId)?.delete(frame.sequence); // never leave an older run's view under this seq
    return frames;
  }
  let views = liveViews.get(sessionId);
  if (!views) {
    if (liveViews.size >= MAX_VIEW_SESSIONS) {
      const oldest = liveViews.keys().next().value;
      if (oldest !== undefined) liveViews.delete(oldest);
    }
    views = new Map();
  }
  liveViews.delete(sessionId);
  liveViews.set(sessionId, views); // most recently written session last
  views.delete(frame.sequence);
  if (views.size >= MAX_VIEWS_PER_SESSION) {
    const oldest = views.keys().next().value;
    if (oldest !== undefined) views.delete(oldest);
  }
  const before = frames.before.length > 0 ? frames.before : NO_FRAMES;
  const masked = delta === undefined ? undefined : (delta as { content: string }).content;
  views.set(frame.sequence, masked === undefined
    ? { kind: String(frame.kind), id: frame.id, before, delta: false }
    // Most deltas carry nothing to mask: then only the raw string (shared with the frame) is kept.
    : { kind: String(frame.kind), id: frame.id, before, delta: true, raw: frame.content, ...(masked === frame.content ? {} : { masked }) });
  return frames;
}

/** The masker behind the live WebSocket chokepoint. */
export const liveStreamMasker = new DisplayStreamMasker();

export type DisplayReplaySink = ((payload: unknown) => void) & { finish: () => void };

/**
 * Wraps a unicast raw sink (attach-replay). A buffered frame the live
 * chokepoint recorded is replayed exactly as live viewers saw it (same splits,
 * same held tails), so the live stream that follows continues without gap or
 * overlap. Anything unrecorded goes through ONE stateful masker for the whole
 * pass; `finish()` flushes its held tails. `keepRaw(frame)` keeps a replayed
 * permission prompt raw for a socket of the run owner (same rule as live).
 */
export function createDisplayReplaySink(
  send: (payload: unknown) => void,
  options: { sessionId?: string | null; keepRaw?: (frame: Record<string, unknown>) => boolean } = {},
): DisplayReplaySink {
  const pass = new DisplayStreamMasker();
  const deliver = (frames: DisplayFrames, payload: unknown) => {
    for (const frame of frames.before) send(frame);
    const raw = frames.owner !== frames.viewer && options.keepRaw?.(payload as Record<string, unknown>) === true;
    send(raw ? frames.owner : frames.viewer);
  };
  const sink = ((payload: unknown) => {
    const frame = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
    // A buffered payload without its own sessionId belongs to the attached session.
    const sessionId = typeof frame?.sessionId === 'string' ? frame.sessionId : options.sessionId ?? null;
    const recorded = frame && sessionId && typeof frame.sequence === 'number'
      ? liveViews.get(sessionId)?.get(frame.sequence) : undefined;
    // A sequence reused by a later run must not replay an earlier run's view.
    const matches = frame && recorded && recorded.kind === frame.kind && recorded.id === frame.id
      && (!recorded.delta || recorded.raw === frame.content);
    if (frame && recorded && matches) {
      const before = [...recorded.before];
      if (recorded.delta) {
        const view = { ...frame, content: recorded.masked ?? recorded.raw };
        deliver({ before, owner: view, viewer: view }, payload);
      } else {
        const whole = prepareDisplayFrames(frame, sessionId, new DisplayStreamMasker());
        deliver(whole ? { ...whole, before } : { before, owner: payload, viewer: payload }, payload);
      }
      return;
    }
    const frames = prepareDisplayFrames(payload, sessionId, pass);
    if (!frames) { send(payload); return; }
    deliver(frames, payload);
  }) as DisplayReplaySink;
  sink.finish = () => {
    if (!options.sessionId) return;
    const ctx = { literals: knownValues().values };
    // A stream still open live is released by the live stream itself (this
    // socket is a mirror from now on): flushing it here would emit a tail the
    // live masker still holds — a raw prefix of a key, and a duplicate.
    const closed = pass.keysFor(options.sessionId).filter((key) => !liveStreamMasker.has(key));
    for (const frame of flushKeys(pass, closed, options.sessionId, ctx)) send(frame);
  };
  return sink;
}

/**
 * Masks a pending-permissions listing for one viewer: entries whose run the
 * viewer owns stay raw (their edited input is executed verbatim), every other
 * entry is masked. `ownerOf(entry)` returns the run owner's user id.
 */
export function maskPendingPermissionsFor(
  entries: readonly unknown[], viewerUserId: string | number | null, _sessionId: string | null,
  ownerOf: (entry: Record<string, unknown>) => unknown,
): unknown[] {
  if (!isDisplayMaskingEnabled()) return [...entries];
  const ctx = { literals: knownValues().values };
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const owned = isSameUser(ownerOf(entry as Record<string, unknown>), viewerUserId);
    return owned ? entry : maskMessage(entry, ctx);
  });
}

/** True when both ids are present and name the same user. */
export function isSameUser(left: unknown, right: unknown): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right);
}

/**
 * Wraps the unicast `/btw` sink: streamed `btw-chunk` text goes through a
 * stream masker keyed by `btwId`, the held tail is flushed as one more chunk
 * before the terminal frame, and every other frame is masked whole.
 */
export function createBtwDisplaySink(
  send: (payload: Record<string, unknown>) => void,
): (payload: Record<string, unknown>) => void {
  const masker = new DisplayStreamMasker();
  return (payload) => {
    const key = `btw:${String(payload.btwId ?? '')}`;
    if (!isDisplayMaskingEnabled() && !masker.has(key)) { send(payload); return; }
    const ctx = { literals: knownValues().values };
    if (payload.type === 'btw-chunk' && typeof payload.text === 'string') {
      send({ ...payload, text: masker.push(key, payload.text, null, ctx, 'btw') });
      return;
    }
    if (masker.has(key) && payload.type !== 'btw-accepted') {
      const tail = masker.flush(key, ctx).text;
      if (tail) send({ type: 'btw-chunk', btwId: payload.btwId, text: tail });
    }
    send(maskMessage(payload, ctx));
  };
}

/**
 * A permission answer whose `updatedInput` carries a display marker was built
 * from a masked view: executing it would feed `[masked:…]` to the model. Keep
 * the run's recorded input and take only the user's `answers` from the reply.
 */
export function restoreMaskedUpdatedInput(updatedInput: unknown, recordedInput: unknown): unknown {
  if (updatedInput === undefined || updatedInput === null) return updatedInput;
  let serialized = '';
  try {
    serialized = JSON.stringify(updatedInput) ?? '';
  } catch {
    return recordedInput;
  }
  if (!serialized.includes('[masked:')) return updatedInput;
  const answers = (updatedInput as { answers?: unknown }).answers;
  const base = recordedInput && typeof recordedInput === 'object' ? recordedInput as Record<string, unknown> : {};
  return answers !== undefined ? { ...base, answers } : recordedInput;
}
