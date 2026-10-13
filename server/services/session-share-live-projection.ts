/**
 * Shared, sanitized, in-memory projection of a live session for read links
 * (ADR-205 D2/D3). One entry per session serves every viewer of every live
 * share of it. Entries hold only sanitized parts (memo, LRU by last access) and
 * server-only locators; raw public rows of the last parse are kept only until
 * the refresh floor passes. Nothing is persisted.
 *
 * Loads are unleased full reads (`snapshotCache: 'coalesce-only'`) behind a
 * guest semaphore and per-session single-flight, at most one parse per session
 * per refresh floor. Paging is by opaque per-share cursors over message
 * identities, so appends never cause gaps or duplicates.
 */
import os from 'node:os';
import { setImmediate } from 'node:timers/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { peekHistoryRevision, type HistoryRevisionPeek } from '@/modules/providers/services/session-history-light.service.js';
import { readSessionActivity } from '@/modules/providers/services/session-activity.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { FetchHistoryResult } from '@/shared/types.js';

import { createBoundedSemaphore, type BoundedSemaphore } from './bounded-semaphore.js';
import type { AttachmentLocator } from './session-share-live-attachments.js';
import { messageKey, verifyAttachmentRef, type ShareKeyContext } from './session-share-live-keys.js';
import { servePage, type LiveMessagesResponse, type PageRequest } from './session-share-live-page.js';
import { buildRawRows, sanitizeRawRow, type LiveMemo, type RawLiveRow } from './session-share-live-rows.js';
import { LiveProjectionError, unavailable } from './session-share-live-errors.js';
import { isServableTextFile } from './session-share-live-serve.js';

export { LiveProjectionError } from './session-share-live-errors.js';
export type { LiveMessagesResponse } from './session-share-live-page.js';

export const LIVE_PROJECTION_LIMITS = Object.freeze({
  loadMessages: 1000,
  loadBytes: 8 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  globalBytes: 64 * 1024 * 1024,
  rawRetainBytes: 16 * 1024 * 1024,
  ttlMs: 5 * 60 * 1000,
  floorIdleMs: 3_000,
  floorRunningMs: 10_000,
  floorLargeMs: 15_000,
  largeTranscriptBytes: 20 * 1024 * 1024,
  metadataRefreshMs: 60_000,
  // Under the guest handler's 10 s deadline, so a slow read still answers stale-or-503 in time.
  deadlineMs: 9_000,
  semaphore: { runners: 1, queue: 4, waitMs: 5_000 },
});

/** Injected effects; tests replace them, production uses `defaultLiveProjectionDeps`. */
export type LiveProjectionDeps = {
  fetchHistory: (sessionId: string, ownerUserId: number) => Promise<FetchHistoryResult & { revision: string }>;
  peek: (sessionId: string, ownerUserId: number) => Promise<HistoryRevisionPeek>;
  isRunning: (sessionId: string, ownerUserId: number) => boolean;
  isSourceOversized: (sessionId: string) => boolean;
  projectRoot: (sessionId: string) => string | null;
  home: () => string;
  /** Projection-time policy (a) check for a file attachment (N2). */
  isTextFile: (projectRoot: string | null, locator: AttachmentLocator) => boolean;
  now: () => number;
  semaphore: BoundedSemaphore;
  limits?: Partial<typeof LIVE_PROJECTION_LIMITS>;
};

const SWEEP_INTERVAL_MS = 30_000;

const rawBytesOf = (entry: { raw: Map<string, RawLiveRow> | null }): number => {
  let bytes = 0;
  for (const row of entry.raw?.values() ?? []) bytes += row.bytes;
  return bytes;
};

/** One session's projection. `memo` is a Map in access order (oldest first). */
export type LiveEntry = {
  sessionId: string;
  revision: string;
  revisionKind: 'file' | 'metadata';
  loadedAt: number;
  checkedAt: number;
  lastAccess: number;
  floorMs: number;
  running: boolean;
  order: string[];
  memo: Map<string, LiveMemo>;
  memoBytes: number;
  raw: Map<string, RawLiveRow> | null;
  rawUntil: number;
  ctx: { projectRoot: string | null; home: string; isTextFile: (locator: AttachmentLocator) => boolean };
};

type SessionRef = { sessionId: string; ownerUserId: number };
type PendingLoad = { promise: Promise<LiveEntry>; controller: AbortController; waiters: number };
type Freshness = { entry: LiveEntry; stale: boolean; retryAfterMs?: number };
/** One attachment request: the ref as the guest sent it. */
export type ResolveAttachmentRequest = SessionRef & { share: ShareKeyContext; ref: string; signal?: AbortSignal };
/** A server-only locator plus the context it is loaded in. */
export type ResolvedAttachment = { locator: AttachmentLocator; projectRoot: string | null; home: string };
export type ReadMessagesRequest = {
  sessionId: string;
  ownerUserId: number;
  share: ShareKeyContext;
  before?: string;
  after?: string;
  signal?: AbortSignal;
};

/** Rejects when `signal` aborts; resolves/rejects with `promise` otherwise. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const isRevisionChanged = (error: unknown) => (error as { code?: unknown })?.code === 'HISTORY_REVISION_CHANGED';

/**
 * Projection store over injected effects; production uses the `liveProjection`
 * singleton. Every public read is bounded by the handler deadline.
 */
export class LiveProjection {
  private readonly limits: typeof LIVE_PROJECTION_LIMITS;
  private readonly entries = new Map<string, LiveEntry>();
  private readonly pending = new Map<string, PendingLoad>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: LiveProjectionDeps) {
    this.limits = { ...LIVE_PROJECTION_LIMITS, ...deps.limits };
  }

  /** D3 refresh floor: 15 s over 20 MiB, 10 s while running, 3 s otherwise. */
  private floorFor(sessionId: string, ownerUserId: number, bytes: number | null): { floorMs: number; running: boolean } {
    const running = this.deps.isRunning(sessionId, ownerUserId);
    if (bytes !== null && bytes > this.limits.largeTranscriptBytes) return { floorMs: this.limits.floorLargeMs, running };
    return { floorMs: running ? this.limits.floorRunningMs : this.limits.floorIdleMs, running };
  }

  /** Drops entries idle past the TTL, then whole sessions by last access over the global cap. */
  private sweep(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.lastAccess > this.limits.ttlMs && !this.pending.has(id)) this.entries.delete(id);
      else if (entry.raw && now > entry.rawUntil) entry.raw = null;
    }
    let total = 0;
    for (const entry of this.entries.values()) total += entry.memoBytes + rawBytesOf(entry);
    this.syncTimer();
    const byAccess = [...this.entries.values()].sort((a, b) => a.lastAccess - b.lastAccess);
    for (const entry of byAccess) {
      if (total <= this.limits.globalBytes) break;
      if (this.pending.has(entry.sessionId)) continue;
      this.entries.delete(entry.sessionId);
      total -= entry.memoBytes + rawBytesOf(entry);
    }
  }

  /** Runs the sweep on an unref'd interval while entries exist, so idle memory is released without requests. */
  private syncTimer(): void {
    if (this.entries.size === 0) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    } else if (!this.timer) {
      this.timer = setInterval(() => this.sweep(this.deps.now()), SWEEP_INTERVAL_MS);
      this.timer.unref();
    }
  }

  /** Sanitizer context of one session: redaction roots and the file policy check. */
  private rowContext(sessionId: string): LiveEntry['ctx'] {
    const projectRoot = this.deps.projectRoot(sessionId);
    return { projectRoot, home: this.deps.home(), isTextFile: (locator) => this.deps.isTextFile(projectRoot, locator) };
  }

  /** Builds the next entry from a parse, keeping memos whose identity survived. */
  private nextEntry(sessionId: string, ownerUserId: number, loaded: FetchHistoryResult & { revision: string },
    peek: Extract<HistoryRevisionPeek, { revision: string }>): LiveEntry {
    const now = this.deps.now();
    const previous = this.entries.get(sessionId);
    const rows = buildRawRows(sessionId, ownerUserId, loaded.messages);
    const memo = new Map<string, LiveMemo>();
    let memoBytes = 0;
    const live = new Set(rows.map((row) => row.sid));
    for (const [sid, value] of previous?.memo ?? []) if (live.has(sid)) { memo.set(sid, value); memoBytes += value.bytes; }
    const { floorMs, running } = this.floorFor(sessionId, ownerUserId, peek.bytes);
    return {
      sessionId, revision: loaded.revision, revisionKind: peek.kind, loadedAt: now, checkedAt: now,
      lastAccess: now, floorMs, running, order: rows.map((row) => row.sid), memo, memoBytes,
      raw: new Map(rows.map((row) => [row.sid, row])),
      rawUntil: now + floorMs,
      ctx: this.rowContext(sessionId),
    };
  }

  /** One guarded parse; the result is stored even when every waiter left (it serves the next viewer). */
  private async runLoad(sessionId: string, ownerUserId: number, peek: Extract<HistoryRevisionPeek, { revision: string }>,
    anchor: number | null, controller: AbortController): Promise<LiveEntry> {
    let release: () => void;
    try {
      release = await this.deps.semaphore.acquire(controller.signal);
    } catch {
      throw unavailable(this.limits.floorIdleMs);
    }
    try {
      const loaded = await this.deps.fetchHistory(sessionId, ownerUserId);
      if (loaded.readFailed) throw unavailable(this.limits.floorIdleMs, 'read_failed');
      const entry = this.nextEntry(sessionId, ownerUserId, loaded, peek);
      this.entries.set(sessionId, entry);
      this.syncTimer();
      await this.presanitize(entry, anchor ?? entry.order.length, controller.signal);
      this.retainRaw(entry);
      return entry;
    } finally {
      release();
    }
  }

  /** Sanitizes up to the per-load caps, newest first from just below `fromIndex`, skipping memoized rows. */
  private async presanitize(entry: LiveEntry, fromIndex: number, signal: AbortSignal): Promise<void> {
    let count = 0;
    let bytes = 0;
    for (let i = fromIndex - 1; i >= 0 && count < this.limits.loadMessages && bytes < this.limits.loadBytes; i -= 1) {
      if (signal.aborted) return;
      if (count > 0 && count % 50 === 0) await setImmediate();
      const memo = this.memoize(entry, entry.order[i]);
      if (!memo) return;
      count += 1;
      bytes += memo.bytes;
    }
  }

  /** Keeps the parsed raw rows until the floor passes only while they fit the retention cap. */
  private retainRaw(entry: LiveEntry): void {
    if (rawBytesOf(entry) > this.limits.rawRetainBytes) entry.raw = null;
  }

  /** Returns a row's memo, sanitizing it from retained raw rows when needed; null when unknown. */
  private memoize(entry: LiveEntry, sid: string): LiveMemo | null {
    const held = entry.memo.get(sid);
    if (held) { entry.memo.delete(sid); entry.memo.set(sid, held); return held; }
    if (!entry.raw || this.deps.now() > entry.rawUntil) { entry.raw = null; return null; }
    const row = entry.raw.get(sid);
    if (!row) return null;
    const memo = sanitizeRawRow(row, entry.ctx);
    entry.memo.set(sid, memo);
    entry.memoBytes += memo.bytes;
    this.evictMemo(entry, sid);
    return memo;
  }

  /** LRU eviction inside one entry; the row just touched (`keep`) always stays. */
  private evictMemo(entry: LiveEntry, keep: string): void {
    for (const [sid, value] of entry.memo) {
      if (entry.memoBytes <= this.limits.entryBytes) return;
      if (sid === keep) continue;
      entry.memo.delete(sid);
      entry.memoBytes -= value.bytes;
    }
  }

  /** Joins (or starts) the session's single-flight load; a leaving last waiter aborts the queue wait and sanitizing. */
  private joinLoad(sessionId: string, ownerUserId: number, peek: Extract<HistoryRevisionPeek, { revision: string }>,
    anchor: number | null, signal: AbortSignal): Promise<LiveEntry> {
    let load = this.pending.get(sessionId);
    if (!load) {
      const controller = new AbortController();
      const promise = this.runLoad(sessionId, ownerUserId, peek, anchor, controller);
      load = { promise, controller, waiters: 0 };
      this.pending.set(sessionId, load);
      void promise.finally(() => this.pending.delete(sessionId)).catch(() => undefined);
    }
    const joined = load;
    joined.waiters += 1;
    const leave = () => { joined.waiters -= 1; if (joined.waiters === 0) joined.controller.abort(); };
    signal.addEventListener('abort', leave, { once: true });
    return raceAbort(joined.promise, signal).finally(() => signal.removeEventListener('abort', leave));
  }

  /** A previous entry served on a retryable failure, or a 503 when there is none. */
  private fallback(sessionId: string, stale: boolean, retryAfterMs: number): Freshness {
    const entry = this.entries.get(sessionId);
    if (!entry) throw unavailable(retryAfterMs);
    return { entry, stale, retryAfterMs };
  }

  /** D3 poll flow: inside the floor answer from the entry; else peek, and refresh only on a new revision. */
  private async ensureFresh(sessionId: string, ownerUserId: number, signal: AbortSignal): Promise<Freshness> {
    if (this.deps.isSourceOversized(sessionId)) throw unavailable(this.limits.floorIdleMs, 'source_oversized');
    const now = this.deps.now();
    const entry = this.entries.get(sessionId);
    if (entry && now - entry.checkedAt < entry.floorMs) return { entry, stale: false };
    const peek = await raceAbort(this.deps.peek(sessionId, ownerUserId), signal);
    if (peek.readFailed) return this.fallback(sessionId, true, this.limits.floorIdleMs);
    const metadataDue = entry?.revisionKind === 'metadata' && now - entry.loadedAt >= this.limits.metadataRefreshMs;
    if (entry && peek.revision === entry.revision && !metadataDue) {
      Object.assign(entry, { checkedAt: now }, this.floorFor(sessionId, ownerUserId, peek.bytes));
      return { entry, stale: false };
    }
    return this.loadOrFallback(sessionId, ownerUserId, peek, null, signal);
  }

  /** Loads; a revision race serves the previous entry as unchanged, a failed read serves it as stale. */
  private async loadOrFallback(sessionId: string, ownerUserId: number, peek: Extract<HistoryRevisionPeek, { revision: string }>,
    anchor: number | null, signal: AbortSignal): Promise<Freshness> {
    try {
      return { entry: await this.joinLoad(sessionId, ownerUserId, peek, anchor, signal), stale: false };
    } catch (error) {
      if (signal.aborted) throw error;
      if (isRevisionChanged(error)) return this.fallback(sessionId, false, this.limits.floorIdleMs);
      if (error instanceof LiveProjectionError) return this.fallback(sessionId, true, error.retryAfterMs ?? this.limits.floorIdleMs);
      throw error;
    }
  }

  /** A `before` page that reached rows neither memoized nor held: parse again if the floor allows. */
  private async reloadForPage(request: SessionRef, entry: LiveEntry, anchor: number, signal: AbortSignal) {
    const wait = entry.floorMs - (this.deps.now() - entry.loadedAt);
    if (wait > 0) throw unavailable(wait);
    const peek = await raceAbort(this.deps.peek(request.sessionId, request.ownerUserId), signal);
    if (peek.readFailed) throw unavailable(this.limits.floorIdleMs, 'read_failed');
    return (await this.loadOrFallback(request.sessionId, request.ownerUserId, peek, anchor, signal)).entry;
  }

  /** Pages over one entry with its memo view. */
  private pageOf(entry: LiveEntry, page: PageRequest) {
    entry.lastAccess = this.deps.now();
    return servePage(entry, { memoize: (sid) => this.memoize(entry, sid) }, page);
  }

  /** Freshness check, then one page; a `before` walk into unknown rows triggers one allowed parse. */
  private async readOnce(request: ReadMessagesRequest, signal: AbortSignal): Promise<LiveMessagesResponse> {
    this.sweep(this.deps.now());
    const fresh = await this.ensureFresh(request.sessionId, request.ownerUserId, signal);
    const page: PageRequest = { share: request.share, before: request.before, after: request.after, signal };
    const result = this.pageOf(fresh.entry, page);
    if (result.needsParseAt === null) return result.response(fresh.stale, fresh.retryAfterMs ?? fresh.entry.floorMs);
    const entry = await this.reloadForPage(request, fresh.entry, result.needsParseAt, signal);
    return this.pageOf(entry, page).response(false, entry.floorMs);
  }

  /** Past the deadline: the same page from the previous entry as stale, or a retryable 503. */
  private deadlineAnswer(request: ReadMessagesRequest): LiveMessagesResponse {
    const entry = this.entries.get(request.sessionId);
    if (!entry) throw unavailable(this.limits.floorIdleMs, 'deadline');
    const result = this.pageOf(entry, { share: request.share, before: request.before, after: request.after });
    if (result.needsParseAt !== null) throw unavailable(entry.floorMs, 'deadline');
    return result.response(true, entry.floorMs);
  }

  /** Runs `run` under the deadline; past it, `onDeadline` answers instead. Caller aborts propagate. */
  private async bounded<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>,
    onDeadline: () => T): Promise<T> {
    const controller = new AbortController();
    const deadline = Symbol('deadline');
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(deadline), this.limits.deadlineMs);
    try {
      return await run(controller.signal);
    } catch (error) {
      if (controller.signal.reason !== deadline) throw error;
      return onDeadline();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * One guest messages request: newest page, `before` an anchor, or `after` an
   * anchor. Never throws a 500 for a slow or failed read: past the deadline it
   * serves the previous entry as stale, or a retryable 503.
   * @throws LiveProjectionError 503 HISTORY_UNAVAILABLE | 409 CURSOR_STALE; AppError 404 for an unreadable session.
   */
  async readMessages(request: ReadMessagesRequest): Promise<LiveMessagesResponse> {
    return this.bounded(request.signal, (signal) => this.readOnce(request, signal), () => this.deadlineAnswer(request));
  }

  /** The attachment a decoded ref names in `entry`: resolved, gone (null), or the index of an unknown row. */
  private locate(entry: LiveEntry, share: ShareKeyContext, ref: { k: string; index: number }): ResolvedAttachment | null | number {
    entry.lastAccess = this.deps.now();
    const position = entry.order.findIndex((sid) => messageKey(share, sid) === ref.k);
    if (position === -1) return null;
    const memo = this.memoize(entry, entry.order[position]);
    if (!memo) return position;
    const locator = memo.locators[ref.index];
    return locator ? { locator, projectRoot: entry.ctx.projectRoot, home: entry.ctx.home } : null;
  }

  /** Freshness check, then the lookup; a message no longer memoized re-projects once within the parse budget. */
  private async resolveOnce(request: ResolveAttachmentRequest, ref: { k: string; index: number },
    signal: AbortSignal): Promise<ResolvedAttachment | null> {
    this.sweep(this.deps.now());
    const fresh = await this.ensureFresh(request.sessionId, request.ownerUserId, signal);
    const first = this.locate(fresh.entry, request.share, ref);
    if (typeof first !== 'number') return first;
    const entry = await this.reloadForPage(request, fresh.entry, first + 1, signal);
    const second = this.locate(entry, request.share, ref);
    return typeof second === 'number' ? null : second;
  }

  /**
   * D4: maps an opaque attachment ref of one share to its server-only locator.
   * A forged ref, another share's ref, or a ref whose message or attachment is
   * gone from the current projection resolves to null (404 ATTACHMENT_GONE).
   * @throws LiveProjectionError 503 HISTORY_UNAVAILABLE (retryable)
   */
  async resolveAttachment(request: ResolveAttachmentRequest): Promise<ResolvedAttachment | null> {
    const ref = verifyAttachmentRef(request.share, request.ref);
    if (!ref) return null;
    return this.bounded(request.signal, (signal) => this.resolveOnce(request, ref, signal), () => {
      throw unavailable(this.limits.floorIdleMs, 'deadline');
    });
  }

  /** Drops a session's entry (last live share revoked, or session deleted). */
  drop(sessionId: string): void {
    this.entries.delete(sessionId);
    this.syncTimer();
  }

  /** Test and diagnostics view of one entry. */
  inspect(sessionId: string): LiveEntry | undefined {
    return this.entries.get(sessionId);
  }
}

/** Creates a projection over `deps`. */
export function createLiveProjection(deps: LiveProjectionDeps): LiveProjection {
  return new LiveProjection(deps);
}

/** Production effects: unleased coalesce-only full reads as the strict session owner. */
export const defaultLiveProjectionDeps: LiveProjectionDeps = {
  fetchHistory: (sessionId, ownerUserId) => sessionsService.fetchHistory(sessionId, ownerUserId, {
    limit: null, offset: 0, payloadMode: 'full', snapshotCache: 'coalesce-only',
  }),
  peek: peekHistoryRevision,
  isRunning: (sessionId, ownerUserId) => readSessionActivity(sessionId, ownerUserId).isProcessing,
  // ADR-205 H3: the only bounded-mode guard that applies to guests.
  isSourceOversized: (sessionId) => process.env.NASSAJ_BOUNDED_HISTORY === '1'
    && Boolean(sessionsDb.getHistorySource(sessionId)?.sourceOversized),
  projectRoot: (sessionId) => sessionsDb.getSessionById(sessionId)?.project_path ?? null,
  home: () => os.homedir(),
  isTextFile: isServableTextFile,
  now: () => Date.now(),
  semaphore: createBoundedSemaphore(LIVE_PROJECTION_LIMITS.semaphore),
};

/** The process-wide projection shared by every live share. */
export const liveProjection = createLiveProjection(defaultLiveProjectionDeps);
