/** ADR-145: request-owned history bounds. No ambient API patches or provider SDK state. */
import fs, { type BigIntStats, type Dir } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { types as utilTypes } from 'node:util';
import type Database from 'better-sqlite3';

const MiB = 1024 * 1024;
// B-1025 (2026-09-10, owner decision): the interim envelope (4MiB / 10000
// records / 20000 tokens) rejected most real Claude sessions with 413. Raised to
// the measured T-1632 acceptance corpus (128MiB source, 100000 rows) so the
// bounded reader can be evaluated on live sessions; still opt-in via
// NASSAJ_BOUNDED_HISTORY=1 (sessions.service.usesBoundedHistory).
export const HISTORY_LIMITS = Object.freeze({
  sourceBytes: 128 * MiB, files: 32, directoryEntries: 1024, recordBytes: MiB,
  chunkBytes: 64 * 1024, records: 100000, tokens: 2_000_000, depth: 64,
  retainedBytes: 64 * MiB, responseBytes: 32 * MiB, jobBytes: 256 * MiB,
  dbRows: 10000, dbBytes: 4 * MiB, dbScalarBytes: 64 * 1024,
  comparisons: 100000, queue: 8, queueMs: 5000, executionMs: 10000, atomicMs: 2,
});
export type HistoryLimits = { [K in keyof typeof HISTORY_LIMITS]: number };
export type HistoryFailureCode = 'HISTORY_BUDGET_EXCEEDED' | 'HISTORY_SOURCE_INVALID'
  | 'HISTORY_SOURCE_UNAVAILABLE' | 'HISTORY_REVISION_CHANGED' | 'HISTORY_BUSY'
  | 'HISTORY_TIMEOUT' | 'HISTORY_ABORTED' | 'HISTORY_SOURCE_INCOMPLETE' | 'SESSION_NOT_FOUND';
const STATUS: Record<HistoryFailureCode, number> = {
  HISTORY_BUDGET_EXCEEDED: 413, HISTORY_SOURCE_INVALID: 422,
  HISTORY_SOURCE_UNAVAILABLE: 409, HISTORY_REVISION_CHANGED: 409,
  HISTORY_BUSY: 503, HISTORY_TIMEOUT: 504, HISTORY_ABORTED: 499, HISTORY_SOURCE_INCOMPLETE: 409, SESSION_NOT_FOUND: 404,
};
/** Stable public error codes; diagnostics never contain transcript text or paths. */
export class HistoryBudgetError extends Error {
  readonly statusCode: number;
  constructor(readonly code: HistoryFailureCode) {
    super('History is unavailable for this request.'); this.statusCode = STATUS[code];
  }
}
type Descriptor = { user: string; session: string; provider: string };
type Waiter = { resolve: (release: () => void) => void; cleanup: () => void; cancel: (code: HistoryFailureCode) => void };
/** A single admission owner includes serialization and transport completion. */
export class HistoryAdmission {
  private running = 0;
  private waiting: Waiter[] = [];
  private cleanupOwner?: { lease: HistoryReadLease; release: () => void };
  private cleanupPromise?: Promise<void>;
  private cleanupFailed = false;
  constructor(private readonly limits: HistoryLimits = HISTORY_LIMITS) {}
  get active(): number { return this.running; }
  get queued(): number { return this.waiting.length; }
  get quarantined(): boolean { return this.cleanupFailed; }
  /** Keep the existing admission and job owner until its resources have actually settled. */
  async closeAndRelease(lease: HistoryReadLease, release: () => void): Promise<void> {
    if (this.cleanupOwner && this.cleanupOwner.lease !== lease) throw new HistoryBudgetError('HISTORY_BUSY');
    this.cleanupOwner ??= { lease, release };
    await this.retryCleanup();
  }
  /** One explicit retry on the retained owner; concurrent calls join it, with no background retry loop. */
  async retryCleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    const owner = this.cleanupOwner;
    if (!owner) return;
    const pending = (async () => {
      try {
        await owner.lease.close();
        this.cleanupOwner = undefined; this.cleanupFailed = false; this.cleanupPromise = undefined; owner.release();
      } catch (error) {
        this.cleanupFailed = true;
        for (const waiter of [...this.waiting]) waiter.cancel('HISTORY_BUSY');
        throw error;
      }
    })();
    this.cleanupPromise = pending;
    try { await pending; } finally { if (this.cleanupPromise === pending) this.cleanupPromise = undefined; }
  }
  async acquire(descriptor: Descriptor, signal: AbortSignal): Promise<() => void> {
    for (const value of [descriptor.user, descriptor.session, descriptor.provider]) {
      if (typeof value !== 'string' || !value || value.length > 256) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    }
    if (signal.aborted) throw new HistoryBudgetError('HISTORY_ABORTED');
    if (this.cleanupFailed) throw new HistoryBudgetError('HISTORY_BUSY');
    if (!this.running) { this.running = 1; return this.releaseHandle(); }
    if (this.waiting.length >= this.limits.queue) throw new HistoryBudgetError('HISTORY_BUSY');
    return new Promise((resolve, reject) => {
      const entry: Waiter = { resolve, cleanup: () => {}, cancel: () => {} };
      const cancel = (code: HistoryFailureCode) => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1); entry.cleanup(); reject(new HistoryBudgetError(code));
      };
      entry.cancel = cancel;
      const abort = () => cancel('HISTORY_ABORTED');
      const timer = setTimeout(() => cancel('HISTORY_BUSY'), this.limits.queueMs);
      entry.cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      signal.addEventListener('abort', abort, { once: true }); this.waiting.push(entry);
    });
  }
  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released || this.cleanupOwner) return;
      released = true;
      const next = this.waiting.shift();
      if (!next) { this.running = 0; return; }
      next.cleanup(); next.resolve(this.releaseHandle());
    };
  }
}
export const historyAdmission = new HistoryAdmission();
type Source = { file: string; fd: FileHandle; stat: BigIntStats; digest?: string; consumed: boolean };

/** JSON string byte count without allocating an encoded copy. */
export function stringJsonBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes += 2;
    else if (code < 32) bytes += 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

/** Counts JSON structure without allocating a parsed tree or decoded strings. */
export function countHistoryTokens(text: string, limit: number, maxDepth: number): number {
  let tokens = 0, depth = 0, quoted = false, escaped = false, primitive = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') { tokens++; quoted = true; primitive = false; }
    else if (ch === '[' || ch === '{') { tokens++; depth++; primitive = false; }
    else if (ch === ']' || ch === '}') { depth--; primitive = false; }
    else if (ch === ',' || ch === ':' || /\s/u.test(ch)) primitive = false;
    else if (!primitive) { tokens++; primitive = true; }
    if (tokens > limit || depth > maxDepth) throw new HistoryBudgetError('HISTORY_BUDGET_EXCEEDED');
  }
  return tokens;
}

/** Explicit per-request context. The owner must close it before releasing admission. */
export class HistoryReadLease {
  readonly limits: HistoryLimits;
  readonly counts: Record<string, number> = Object.create(null) as Record<string, number>;
  private readonly deadline: number;
  private failure?: HistoryBudgetError;
  private readonly sources = new Map<string, Source>();
  private readonly streams = new Set<Readable>();
  private readonly handles = new Set<FileHandle | Dir>();
  private readonly closingHandles = new Map<FileHandle | Dir, Promise<void>>();
  private readonly pendingOperations = new Set<Promise<unknown>>();
  private readonly iterators = new Set<AsyncGenerator<string>>();
  private closing?: Promise<void>;
  private cleanupStarted = false;
  private closed = false;
  private readonly opening = new Set<string>();
  private root?: string;
  private nativeFile?: string;
  get mainFile(): string | undefined { return this.nativeFile; }
  constructor(readonly signal: AbortSignal, limits: Partial<HistoryLimits> = {}) {
    this.limits = { ...HISTORY_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    }
    this.deadline = Date.now() + this.limits.executionMs;
    // Admission reserves the entire measured job before any source/DB allocation.
    this.charge('jobBytes', HISTORY_LIMITS.jobBytes);
  }
  /** Latch failures because existing best-effort provider catches must not turn them into 200. */
  fail(code: HistoryFailureCode): never {
    this.failure ??= new HistoryBudgetError(code); throw this.failure;
  }
  check(atomic = false): void {
    if (this.cleanupStarted) throw new HistoryBudgetError('HISTORY_SOURCE_UNAVAILABLE');
    if (this.failure) throw this.failure;
    if (this.signal.aborted) this.fail(this.signal.reason instanceof HistoryBudgetError ? this.signal.reason.code : 'HISTORY_ABORTED');
    if (Date.now() + (atomic ? this.limits.atomicMs : 0) >= this.deadline) this.fail('HISTORY_TIMEOUT');
  }
  charge(key: string, amount: number, limit = this.limits[key as keyof HistoryLimits]): void {
    this.check();
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(limit)) this.fail('HISTORY_BUDGET_EXCEEDED');
    const next = (this.counts[key] ?? 0) + amount;
    if (next > limit) this.fail('HISTORY_BUDGET_EXCEEDED');
    this.counts[key] = next;
  }
  parse(text: string): unknown {
    this.check(true);
    if (Buffer.byteLength(text) > this.limits.recordBytes) this.fail('HISTORY_BUDGET_EXCEEDED');
    try {
      this.charge('tokens', countHistoryTokens(text, this.limits.tokens - (this.counts.tokens ?? 0), this.limits.depth));
      const value: unknown = JSON.parse(text); this.check(); return value;
    } catch (error) {
      if (error instanceof HistoryBudgetError) this.fail(error.code);
      return this.fail('HISTORY_SOURCE_INVALID');
    }
  }
  /** Optional embedded payloads keep their existing syntax fallback, but never bypass allocation bounds. */
  parseNested(text: string): unknown {
    this.check(true);
    if (Buffer.byteLength(text) > this.limits.recordBytes) this.fail('HISTORY_BUDGET_EXCEEDED');
    try { this.charge('tokens', countHistoryTokens(text, this.limits.tokens - (this.counts.tokens ?? 0), this.limits.depth)); }
    catch (error) { if (error instanceof HistoryBudgetError) this.fail(error.code); throw error; }
    return JSON.parse(text);
  }
  /** Reserve a conservative complete DTO bound before stringify/clone/copy. */
  reserveDto(value: unknown): number {
    let bytes = 0, nodes = 0;
    const visiting = new Set<object>();
    const visit = (item: unknown, depth: number): void => {
      if (++nodes > this.limits.tokens || depth > this.limits.depth) this.fail('HISTORY_BUDGET_EXCEEDED');
      if (typeof item === 'string') { bytes += 64 + stringJsonBytes(item); }
      else if (item === null || typeof item !== 'object') { bytes += 32; }
      else {
        if (visiting.has(item)) this.fail('HISTORY_SOURCE_INVALID');
        visiting.add(item); bytes += 128;
        for (const key of Object.keys(item)) {
          bytes += 64 + stringJsonBytes(key); visit((item as Record<string, unknown>)[key], depth + 1);
          if (bytes > this.limits.responseBytes) this.fail('HISTORY_BUDGET_EXCEEDED');
        }
        visiting.delete(item);
      }
      if (bytes > this.limits.responseBytes) this.fail('HISTORY_BUDGET_EXCEEDED');
    };
    visit(value, 0); this.charge('copyBytes', bytes * 3, this.limits.jobBytes);
    this.charge('retainedBytes', bytes); return bytes;
  }
  /** Reserve before each allocating serialization, including repeated tool-result fanout. */
  stringify(value: unknown): string {
    this.reserveDto(value); this.check(true); return JSON.stringify(value);
  }
  /** Probe scalar sizes inside the same SQLite read snapshot before materializing rows. */
  queryRows<T>(db: Database.Database, sql: string, parameters: readonly unknown[]): T[] {
    this.check();
    db.exec('SAVEPOINT bounded_history_read');
    try {
      const statement = db.prepare(sql);
      if (!statement.readonly) this.fail('HISTORY_SOURCE_INVALID');
      const columns = statement.columns();
      if (columns.length > 64 || new Set(columns.map(column => column.name)).size !== columns.length) this.fail('HISTORY_SOURCE_INVALID');
      const fields = columns.map((column, index) =>
        `octet_length("${column.name.replaceAll('"', '""')}") AS n${index}`);
      const probe = db.prepare(`SELECT ${fields.join(',')} FROM (${sql.replace(/;\s*$/u, '')})`);
      for (const sizes of probe.iterate(...parameters)) {
        this.charge('dbRows', 1);
        this.charge('comparisons', Math.max(1, 4 * (this.counts.normalizedRows ?? 0)));
        let bytes = 0;
        for (const value of Object.values(sizes as Record<string, unknown>)) {
          const size = Number(value ?? 0);
          if (!Number.isSafeInteger(size) || size < 0 || size > this.limits.dbScalarBytes) this.fail('HISTORY_BUDGET_EXCEEDED');
          bytes += size;
        }
        this.charge('dbBytes', bytes); this.charge('retainedBytes', 256 + 2 * bytes);
      }
      this.check(true); return statement.all(...parameters) as T[];
    } catch (error) {
      if (error instanceof HistoryBudgetError) throw error;
      return this.fail('HISTORY_SOURCE_UNAVAILABLE');
    } finally { db.exec('RELEASE bounded_history_read'); }
  }

  /** Establish scope from the existing authorized session's native transcript locator. */
  async initialize(mainFile: string): Promise<void> { return this.operation(() => this.initializeSource(mainFile)); }
  private async initializeSource(mainFile: string): Promise<void> {
    this.check();
    if (!path.isAbsolute(mainFile) || mainFile.length > 4096) this.fail('HISTORY_SOURCE_UNAVAILABLE');
    this.root = path.dirname(mainFile);
    if (await fsp.realpath(this.root) !== this.root) this.fail('HISTORY_SOURCE_UNAVAILABLE');
    await this.open(mainFile); this.nativeFile = mainFile;
  }
  private async scoped(file: string): Promise<string> {
    this.check();
    const resolved = path.resolve(file);
    if (!this.root || !resolved.startsWith(this.root + path.sep)) this.fail('HISTORY_SOURCE_UNAVAILABLE');
    if (await fsp.realpath(resolved) !== resolved) this.fail('HISTORY_SOURCE_UNAVAILABLE');
    this.check(); return resolved;
  }
  private async open(file: string): Promise<Source> { return this.operation(() => this.openSource(file)); }
  private async openSource(file: string): Promise<Source> {
    this.check();
    try {
      const resolved = await this.scoped(file);
      const previous = this.sources.get(resolved); if (previous) return previous;
      if (this.opening.has(resolved)) this.fail('HISTORY_BUSY');
      this.opening.add(resolved);
      const expected = await fsp.lstat(resolved, { bigint: true });
      if (!expected.isFile()) this.fail('HISTORY_SOURCE_UNAVAILABLE');
      this.check();
      const fd = await fsp.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      this.handles.add(fd);
      try {
        this.check();
        const stat = await fd.stat({ bigint: true }); this.check();
        if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino
          || await fsp.realpath(`/proc/self/fd/${fd.fd}`) !== resolved) this.fail('HISTORY_SOURCE_UNAVAILABLE');
        this.charge('files', 1); this.charge('sourceBytes', Number(stat.size));
        const source = { file: resolved, fd, stat, consumed: false };
        this.sources.set(resolved, source); return source;
      } catch (error) { await this.closeHandle(fd); throw error; }
    } catch (error) {
      if (error instanceof HistoryBudgetError) throw error;
      return this.fail('HISTORY_SOURCE_UNAVAILABLE');
    } finally { this.opening.delete(path.resolve(file)); }
  }
  /** Incremental enumeration never materializes an unbounded directory listing. */
  async directory(directory: string): Promise<string[]> { return this.operation(() => this.readDirectory(directory)); }
  private async readDirectory(directory: string): Promise<string[]> {
    this.check();
    try {
      const resolved = await this.scoped(directory);
      const expected = await fsp.lstat(resolved, { bigint: true });
      if (!expected.isDirectory()) this.fail('HISTORY_SOURCE_UNAVAILABLE');
      this.check();
      const fd = await fsp.open(resolved, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      this.handles.add(fd);
      try {
        this.check();
        const stat = await fd.stat({ bigint: true }); this.check();
        if (!stat.isDirectory() || stat.ino !== expected.ino || stat.dev !== expected.dev
          || await fsp.realpath(`/proc/self/fd/${fd.fd}`) !== resolved) this.fail('HISTORY_SOURCE_UNAVAILABLE');
        this.check();
        const dir = await fsp.opendir(`/proc/self/fd/${fd.fd}`); this.handles.add(dir);
        try {
          const names: string[] = [];
          while (true) {
            this.check(); const entry = await dir.read(); this.check();
            if (!entry) return names;
            this.charge('directoryEntries', 1); names.push(entry.name);
          }
        } finally { await this.closeHandle(dir); }
      } finally { await this.closeHandle(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      if (error instanceof HistoryBudgetError) throw error;
      return this.fail('HISTORY_SOURCE_UNAVAILABLE');
    }
  }
  /** Pin a discovered sidecar before allocating its content. */
  async admit(file: string): Promise<void> { await this.open(file); }
  async stat(file: string): Promise<BigIntStats | undefined> { return this.operation(() => this.statSource(file)); }
  private async statSource(file: string): Promise<BigIntStats | undefined> {
    try { await fsp.lstat(await this.scoped(file)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof HistoryBudgetError) throw error;
      return this.fail('HISTORY_SOURCE_UNAVAILABLE');
    }
    return (await this.open(file)).stat;
  }
  private async validate(source: Source): Promise<void> {
    try {
    this.check(); const current = await source.fd.stat({ bigint: true }); this.check();
    const named = await fsp.lstat(source.file, { bigint: true }); this.check();
    if (await fsp.realpath(`/proc/self/fd/${source.fd.fd}`) !== source.file
      || !named.isFile() || named.ino !== source.stat.ino || named.dev !== source.stat.dev
      || current.size < source.stat.size) this.fail('HISTORY_REVISION_CHANGED');
    } catch { this.fail('HISTORY_REVISION_CHANGED'); }
  }
  /** Bounded frame iterator uses a pinned descriptor; output stays quarantined until verify(). */
  lines(file: string): AsyncGenerator<string> {
    this.check();
    let iterator!: AsyncGenerator<string>;
    iterator = (async function* (lease: HistoryReadLease) {
      try { yield* lease.readLines(file); } finally { lease.iterators.delete(iterator); }
    })(this);
    this.iterators.add(iterator); return iterator;
  }
  private async *readLines(file: string): AsyncGenerator<string> {
    const source = await this.open(file);
    if (source.consumed) this.fail('HISTORY_BUDGET_EXCEEDED');
    source.consumed = true;
    const chunk = Buffer.alloc(this.limits.chunkBytes), record = Buffer.alloc(this.limits.recordBytes);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const hash = createHash('sha256'); let position = 0, used = 0;
    try {
      while (position < Number(source.stat.size)) {
        this.check();
        const { bytesRead } = await this.operation(() => source.fd.read(chunk, 0, Math.min(chunk.length, Number(source.stat.size) - position), position));
        if (!bytesRead) this.fail('HISTORY_REVISION_CHANGED');
        hash.update(chunk.subarray(0, bytesRead)); position += bytesRead;
        this.charge('scannedBytes', bytesRead, this.limits.sourceBytes * 2);
        for (let start = 0; start < bytesRead;) {
          const found = chunk.indexOf(10, start), newline = found < bytesRead ? found : -1;
          const end = newline < 0 ? bytesRead : newline;
          if (used + end - start > record.length) this.fail('HISTORY_BUDGET_EXCEEDED');
          chunk.copy(record, used, start, end); used += end - start;
          if (newline < 0) break;
          this.charge('records', 1); yield decoder.decode(record.subarray(0, used)); used = 0; start = newline + 1;
        }
      }
      // Interim C1 requires a completed native line boundary, even when the trailing JSON parses.
      // In particular, adding an artificial LF would manufacture Codex final-response evidence.
      if (used) this.fail('HISTORY_SOURCE_INCOMPLETE');
      await this.validate(source); source.digest = hash.digest('hex');
    } catch (error) {
      if (error instanceof HistoryBudgetError) throw error;
      this.fail(error instanceof TypeError ? 'HISTORY_SOURCE_INVALID' : 'HISTORY_SOURCE_UNAVAILABLE');
    }
  }
  /** Adapter for existing readline consumers; chunk/frame bounds are enforced before yield. */
  stream(file: string): Readable {
    this.check();
    const stream = Readable.from((async function* (lease: HistoryReadLease) {
      for await (const line of lease.lines(file)) yield line + '\n';
    })(this), { objectMode: false, highWaterMark: this.limits.chunkBytes });
    this.streams.add(stream); stream.once('close', () => this.streams.delete(stream)); return stream;
  }
  /** Verify every consumed prefix again before exposing any projected row. */
  async verify(): Promise<void> { return this.operation(() => this.verifySources()); }
  private async verifySources(): Promise<void> {
    for (const source of this.sources.values()) {
      await this.validate(source);
      if (!source.consumed) {
        const stat = await source.fd.stat({ bigint: true });
        if (stat.size !== source.stat.size || stat.mtimeNs !== source.stat.mtimeNs || stat.ctimeNs !== source.stat.ctimeNs) this.fail('HISTORY_REVISION_CHANGED');
        continue;
      }
      if (!source.digest) this.fail('HISTORY_SOURCE_UNAVAILABLE');
      const hash = createHash('sha256'), buffer = Buffer.alloc(this.limits.chunkBytes);
      for (let position = 0; position < Number(source.stat.size);) {
        this.check();
        const { bytesRead } = await source.fd.read(buffer, 0, Math.min(buffer.length, Number(source.stat.size) - position), position);
        if (!bytesRead) this.fail('HISTORY_REVISION_CHANGED');
        this.charge('scannedBytes', bytesRead, this.limits.sourceBytes * 2);
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      if (hash.digest('hex') !== source.digest) this.fail('HISTORY_REVISION_CHANGED');
      await this.validate(source);
    }
    this.check();
  }
  /** Register the operation before its first await; close drains late arrivals before closing their handles. */
  private operation<T>(run: () => Promise<T>): Promise<T> {
    this.check();
    const pending = Promise.resolve().then(() => { this.check(); return run(); });
    this.pendingOperations.add(pending);
    void pending.then(() => this.pendingOperations.delete(pending), () => this.pendingOperations.delete(pending));
    return pending;
  }
  /** Remove ownership only after close succeeds, including descriptors rejected before fstat admission. */
  private async closeHandle(fd: FileHandle | Dir): Promise<void> {
    const pending = this.closingHandles.get(fd);
    if (pending) return pending;
    const close = (async () => {
      await fd.close(); this.handles.delete(fd);
      for (const [file, source] of this.sources) if (source.fd === fd) this.sources.delete(file);
    })();
    this.closingHandles.set(fd, close);
    try { await close; } finally { this.closingHandles.delete(fd); }
  }
  /** Failed closure retains the same handles and charge; retry is explicit and never reopens a source. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closing) return this.closing;
    this.cleanupStarted = true;
    this.closing = this.settleResources();
    try { await this.closing; } finally { this.closing = undefined; }
  }
  private async settleResources(): Promise<void> {
    const streamClosures = [...this.streams].map(stream => new Promise<void>(resolve => {
      if (stream.closed) { this.streams.delete(stream); resolve(); return; }
      const ignoreClosingError = () => {};
      stream.on('error', ignoreClosingError);
      stream.once('close', () => { stream.removeListener('error', ignoreClosingError); resolve(); });
      stream.destroy();
    }));
    const iteratorClosures = [...this.iterators].map(async iterator => {
      try { await iterator.return(undefined); } finally { this.iterators.delete(iterator); }
    });
    await Promise.allSettled([...streamClosures, ...iteratorClosures]);
    while (this.pendingOperations.size) await Promise.allSettled([...this.pendingOperations]);
    const outcomes = await Promise.allSettled([...this.handles].map(fd => this.closeHandle(fd)));
    if (outcomes.some(result => result.status === 'rejected')) throw new HistoryBudgetError('HISTORY_SOURCE_UNAVAILABLE');
    this.closed = true;
  }
}

export const HISTORY_TRANSFER_LIMITS = Object.freeze({ bytes: 32 * MiB, handles: 256, branchBytes: 8 * MiB, usageBytes: 4096, promptBytes: MiB });
type TransferState = 'provisional' | 'committed' | 'released' | 'stuck';
type TransferKind = 'branch' | 'usage';
type BranchStatistics = { includedMessages: number; includedBytes: number; omittedMessages: number };
type TransferredUsage = import('../list/codex/codex-token-budget.js').CodexTokenBudget;
const transferAuthority = Symbol('history-transfer');

function ownData(value: unknown, allowed: readonly string[]): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
  }
  const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
  // Inspect a fixed allowlist, never enumerate or evaluate arbitrary provider fields.
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    descriptors[key] = descriptor;
  }
  return descriptors;
}

function boundedContextSnapshot(value: unknown): Record<string, unknown> {
  const keys = ['version', 'provider', 'sessionId', 'modelId', 'usedTokens', 'windowTokens',
    'usageKind', 'source', 'observedAt', 'nativeCompactTokens', 'proposedCompactTokens', 'newSessionTokens'];
  const fields = ownData(value, keys);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const entry = fields[key]?.value;
    if (entry === null) { copy[key] = null; continue; }
    const numeric = key.endsWith('Tokens') || key === 'version';
    if (numeric ? !Number.isSafeInteger(entry) || entry < 0
      : typeof entry !== 'string' || entry.length > 256) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    copy[key] = entry;
  }
  if (copy.version !== 1 || !['codex', 'claude'].includes(copy.provider as string)
    || !['last_request_input', 'native_reported_context', 'unknown'].includes(copy.usageKind as string)) {
    throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
  }
  return Object.freeze(copy);
}

function boundedCacheSnapshot(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  const keys = ['version', 'provider', 'sessionId', 'modelId', 'source', 'scope', 'observedAt',
    'receivedAt', 'eventId', 'sequence', 'transport', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  const fields = ownData(value, keys);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const entry = fields[key]?.value;
    if (entry === null && ['sessionId', 'modelId', 'observedAt', 'eventId', 'sequence', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens'].includes(key)) {
      copy[key] = null; continue;
    }
    const numeric = key.endsWith('Tokens') || key === 'version' || key === 'sequence';
    if (numeric ? !Number.isSafeInteger(entry) || entry < 0
      : typeof entry !== 'string' || entry.length > 256) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    copy[key] = entry;
  }
  if (copy.version !== 1 || !['codex', 'claude'].includes(copy.provider as string)
    || !['last_request', 'turn', 'session'].includes(copy.scope as string)
    || !['live', 'history'].includes(copy.transport as string)) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
  return Object.freeze(copy);
}

function boundedUsage(value: unknown): TransferredUsage | null {
  if (value == null) return null;
  const numeric = ['used', 'total', 'inputTokens', 'outputTokens', 'cumulativeUsed', 'cumulativeInputTokens', 'cumulativeOutputTokens'];
  const boolean = ['totalReported', 'cumulativeReported'];
  const fields = ownData(value, [...numeric, ...boolean, 'breakdown', 'contextSnapshot', 'cacheSnapshot']);
  const copy: Record<string, unknown> = {};
  for (const key of numeric) {
    const number = fields[key]?.value;
    if (number === undefined && key.startsWith('cumulative')) continue;
    if (number === null) { copy[key] = null; continue; }
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    copy[key] = number;
  }
  for (const key of boolean) {
    const flag = fields[key]?.value;
    if (flag === undefined && key === 'cumulativeReported') continue;
    if (typeof flag !== 'boolean') throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    copy[key] = flag;
  }
  const breakdown = ownData(fields.breakdown?.value, ['input', 'output']);
  for (const key of ['input', 'output']) {
    const number = breakdown[key]?.value;
    if (number === null) continue;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
  }
  copy.breakdown = Object.freeze({ input: breakdown.input.value, output: breakdown.output.value });
  if (fields.cacheSnapshot) copy.cacheSnapshot = boundedCacheSnapshot(fields.cacheSnapshot.value);
  if (fields.contextSnapshot) copy.contextSnapshot = boundedContextSnapshot(fields.contextSnapshot.value);
  return Object.freeze(copy) as TransferredUsage;
}

/** Opaque invocation-owned reservation. No source DTO or prompt is retained by the ledger. */
export class HistoryTransferHandle {
  #state: TransferState = 'provisional';
  #branchCommitted = false;
  #kind: TransferKind;
  #onRelease: () => void;
  constructor(authority: symbol, kind: TransferKind, onRelease: () => void) {
    if (authority !== transferAuthority) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    this.#kind = kind; this.#onRelease = onRelease; Object.freeze(this);
  }
  get state(): TransferState { return this.#state; }
  private assertOwned(): void {
    if (this.#state === 'released' || this.#state === 'stuck') throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
  }
  /** Copies a final bounded prompt through UTF-8 bytes, severing ropes and source slices. */
  commitBranch(prompt: string, statistics: BranchStatistics): Readonly<BranchStatistics & { input: string }> {
    this.assertOwned();
    if (this.#kind !== 'branch' || this.#branchCommitted || typeof prompt !== 'string') throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    if (Buffer.byteLength(prompt) > HISTORY_TRANSFER_LIMITS.promptBytes) throw new HistoryBudgetError('HISTORY_BUDGET_EXCEEDED');
    const fields = ownData(statistics, ['includedMessages', 'includedBytes', 'omittedMessages']);
    for (const key of ['includedMessages', 'includedBytes', 'omittedMessages']) {
      if (!Number.isSafeInteger(fields[key]?.value) || fields[key].value < 0 || fields[key].value > MiB) throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    }
    const input = Buffer.from(prompt, 'utf8').toString('utf8');
    const result = Object.freeze({ input, includedMessages: fields.includedMessages.value as number,
      includedBytes: fields.includedBytes.value as number, omittedMessages: fields.omittedMessages.value as number });
    this.#branchCommitted = true; this.#state = 'committed'; return result;
  }
  /** Copies only declared finite usage fields; missing usage remains unknown. */
  commitUsage(value: unknown): TransferredUsage | null {
    this.assertOwned(); const result = boundedUsage(value); this.#state = 'committed'; return result;
  }
  /** Unknown SDK teardown retains capacity without blocking the history reader slot. */
  markStuck(): void { if (this.#state !== 'released') this.#state = 'stuck'; }
  /** The owner calls this only after dropping all transferred and SDK input references. */
  release(): void {
    if (this.#state === 'released' || this.#state === 'stuck') return;
    this.#state = 'released'; this.#onRelease();
  }
}
Object.freeze(HistoryTransferHandle.prototype);

/** Fixed process-local capacity for values transferred from history to existing SDK runs. */
export class HistoryTransferLedger {
  #bytes = 0;
  #handles = new Set<HistoryTransferHandle>();
  acquire(kind: TransferKind): HistoryTransferHandle {
    if (kind !== 'branch' && kind !== 'usage') throw new HistoryBudgetError('HISTORY_SOURCE_INVALID');
    const bytes = kind === 'branch' ? HISTORY_TRANSFER_LIMITS.branchBytes : HISTORY_TRANSFER_LIMITS.usageBytes;
    if (this.#bytes + bytes > HISTORY_TRANSFER_LIMITS.bytes || this.#handles.size >= HISTORY_TRANSFER_LIMITS.handles) throw new HistoryBudgetError('HISTORY_BUSY');
    this.#bytes += bytes;
    const handle = new HistoryTransferHandle(transferAuthority, kind, () => { this.#handles.delete(handle); this.#bytes -= bytes; });
    this.#handles.add(handle); return handle;
  }
  stats(): { chargedBytes: number; handles: number; stuck: number } {
    return { chargedBytes: this.#bytes, handles: this.#handles.size, stuck: [...this.#handles].filter(handle => handle.state === 'stuck').length };
  }
}
export const historyTransferLedger = new HistoryTransferLedger();
