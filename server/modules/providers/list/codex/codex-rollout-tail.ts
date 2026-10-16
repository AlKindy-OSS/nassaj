/**
 * ADR-199 P4b (Addendum B, decision 20): live Codex subagents from the run's
 * own parent rollout.
 *
 * The `codex exec --json` stream never names a spawned agent, so during a live
 * run this module tails exactly one file — the parent rollout of the thread the
 * process itself announced in `thread.started` — and surfaces each
 * `spawn_agent` call (id = its `call_id`, the id the history fold uses) and its
 * settlement by the child's FINAL_ANSWER `agent_message`, which Codex writes
 * into the same parent rollout. Child rollouts are never opened.
 *
 * File rules (M5):
 * - The candidate must realpath under the run's principal
 *   `<CODEX_HOME>/sessions`, and is opened once by the pinned transcript reader
 *   (ADR-201 A1: no symlink, single link, `/proc/self/fd` realpath check, name
 *   and `session_meta` bound to the thread id). Every later read is `fstat` +
 *   `read` on that fd; the path is never re-opened.
 * - Before each tick `lstat(path)` and `fstat(fd)` must both match the opened
 *   `dev`+`ino`, and the size must not drop below the offset; otherwise the tail
 *   stops (rotation, replacement, symlink swap, truncation).
 * - Poll every 500 ms (no fs.watch). A tick consumes at most 256 KB of complete
 *   lines; a line over 1 MB is discarded unparsed and does not consume that
 *   budget (separate 8 MB/tick discard cap), so a spawn queued behind a large
 *   tool output still surfaces in the same tick. Lines without a spawn marker
 *   are skipped before JSON.parse. Worst-case lag for ordinary lines is the
 *   backlog / 512 KB/s; spawns can be late under a burst but are not lost.
 * - The transcript read permit is taken per tick and never held between ticks.
 * - The fd is closed on stop (complete, cancel, process exit, error). The final
 *   drain tick runs only after a spawn was seen and waits at most
 *   `drainTimeoutMs` for its permit, so a run's completion is never held by a
 *   busy read gate.
 * All state is per tail and bounded; there is no module-level mutable state.
 */
import type { Stats } from 'node:fs';
import { lstat, readdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

import { isTranscriptHandle, openRunTranscript } from '../../shared/session-transcript-reader.js';

import { codexSpawnSubagent, humanizeCodexToolName, parseCodexSubagentMessage } from './codex-progress.js';
import {
  createCodexOwnHistoryFilter, resolveCodexChildRolloutPath, withTranscriptReadPermit,
} from './codex-rollout-links.js';

export type CodexTailLimits = {
  pollMs: number;
  tickBytes: number;
  chunkBytes: number;
  maxLineBytes: number;
  discardBytesPerTick: number;
  waitStepMs: number;
  waitMaxMs: number;
  maxTracked: number;
  drainTimeoutMs: number;
};

export const CODEX_TAIL_LIMITS: Readonly<CodexTailLimits> = Object.freeze({
  pollMs: 500,
  tickBytes: 256 * 1024,
  chunkBytes: 64 * 1024,
  maxLineBytes: 1024 * 1024,
  discardBytesPerTick: 8 * 1024 * 1024,
  waitStepMs: 250,
  waitMaxMs: 5000,
  maxTracked: 64,
  drainTimeoutMs: 1000,
});

/** A spawn surfaced from the rollout, or its settlement. */
export type CodexTailSignal = {
  kind: 'spawn' | 'settle' | 'progress'; callId: string; label: string;
  agentType?: string; model?: string; effort?: string;
  agentPath?: string; agentThreadId?: string; occurredAtMs?: number | null;
  tools?: Array<{ id: string; name: string; status: string }>;
};

const SPAWN_MARKER = Buffer.from('"spawn_agent"');
const AGENT_MESSAGE_MARKER = Buffer.from('"agent_message"');
const THREAD_ID = /^[A-Za-z0-9-]{8,128}$/;
const MAX_CALL_ID_CHARS = 200;

const isRecord = (value: unknown): value is AnyRecord => typeof value === 'object' && value !== null;
const nonEmpty = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

function parseJsonRecord(value: unknown): AnyRecord | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type TrackedSpawn = {
  callId: string; label: string; agentPath: string | null; settled: boolean;
  agentThreadId?: string; occurredAtMs?: number | null;
  agentType?: string; model?: string; effort?: string;
};

/**
 * Folds rollout entries into spawn/settle signals, mirroring the history fold:
 * a spawn's agent path comes from its `function_call_output` (`task_name`) or a
 * SubAgentActivity `started` event, and a FINAL_ANSWER from that path with a
 * non-empty payload settles it. Tracks at most `maxTracked` spawns.
 */
export function createCodexSpawnFold(maxTracked = CODEX_TAIL_LIMITS.maxTracked) {
  const byCall = new Map<string, TrackedSpawn>();
  const byPath = new Map<string, TrackedSpawn>();

  const track = (spawn: TrackedSpawn) => {
    if (byCall.size >= maxTracked) {
      const oldest = byCall.values().next().value as TrackedSpawn;
      byCall.delete(oldest.callId);
      if (oldest.agentPath) byPath.delete(oldest.agentPath);
    }
    byCall.set(spawn.callId, spawn);
  };
  const bindPath = (callId: unknown, agentPath: unknown, agentThreadId?: unknown,
    occurredAtMs?: unknown): CodexTailSignal | null => {
    const spawn = typeof callId === 'string' ? byCall.get(callId) : undefined;
    const pathValue = nonEmpty(agentPath);
    if (!spawn || !pathValue) return null;
    if (spawn.agentPath && spawn.agentPath !== pathValue) byPath.delete(spawn.agentPath);
    spawn.agentPath = pathValue;
    byPath.set(pathValue, spawn);
    const threadId = nonEmpty(agentThreadId);
    if (!threadId || spawn.agentThreadId === threadId) return null;
    spawn.agentThreadId = threadId;
    spawn.occurredAtMs = typeof occurredAtMs === 'number' ? occurredAtMs : null;
    return { kind: 'progress', callId: spawn.callId, label: spawn.label,
      agentType: spawn.agentType, agentPath: pathValue,
      agentThreadId: threadId,
      ...(typeof occurredAtMs === 'number' ? { occurredAtMs } : {}) };
  };

  return {
    /** Cheap byte prefilter: only lines that can carry a spawn signal are parsed. */
    wants(line: Buffer): boolean {
      if (line.includes(SPAWN_MARKER) || line.includes(AGENT_MESSAGE_MARKER)) return true;
      for (const spawn of byCall.values()) {
        if (!spawn.agentPath && line.includes(spawn.callId)) return true;
      }
      return false;
    },
    /** Signal for one parsed rollout entry, or null. */
    accept(entry: unknown): CodexTailSignal | null {
      const payload = isRecord(entry) && isRecord(entry.payload) ? entry.payload : null;
      if (!payload) return null;
      if (payload.type === 'function_call' && payload.name === 'spawn_agent') {
        const callId = nonEmpty(payload.call_id);
        if (!callId || callId.length > MAX_CALL_ID_CHARS || byCall.has(callId)) return null;
        const args = parseJsonRecord(payload.arguments);
        const label = humanizeCodexToolName(nonEmpty(args?.task_name) ?? 'agent');
        const metadata = {
          ...(nonEmpty(args?.agent_type) ? { agentType: nonEmpty(args?.agent_type)! } : {}),
          ...(nonEmpty(args?.model) ? { model: nonEmpty(args?.model)! } : {}),
          ...(nonEmpty(args?.reasoning_effort)
            ? { effort: nonEmpty(args?.reasoning_effort)! } : {}),
        };
        track({ callId, label, agentPath: null, settled: false, ...metadata });
        return { kind: 'spawn', callId, label, ...metadata };
      }
      if (payload.type === 'function_call_output') {
        return bindPath(payload.call_id, parseJsonRecord(payload.output)?.task_name);
      }
      if (payload.type === 'item_completed' && isRecord(payload.item) && payload.item.type === 'SubAgentActivity') {
        if (payload.item.kind === 'started') return bindPath(payload.item.id, payload.item.agent_path,
          payload.item.agent_thread_id, payload.started_at_ms);
        return null;
      }
      if (payload.type === 'sub_agent_activity' && payload.kind === 'started') {
        return bindPath(payload.event_id, payload.agent_path, payload.agent_thread_id, payload.timestamp);
      }
      if (payload.type !== 'agent_message') return null;
      const message = parseCodexSubagentMessage(payload);
      if (!message || message.messageType !== 'FINAL_ANSWER' || !message.result) return null;
      const spawn = byPath.get(message.author);
      if (!spawn || spawn.settled) return null;
      spawn.settled = true;
      return { kind: 'settle', callId: spawn.callId, label: spawn.label,
        agentType: spawn.agentType, model: spawn.model, effort: spawn.effort };
    },
  };
}

/** Byte position and torn-line buffer of one tail; bounded by `maxLineBytes`. */
export type RolloutReadState = { offset: number; carry: Buffer[]; carryBytes: number; discarding: boolean };

type TickCounters = { lineBytes: number; discarded: number };

function consumeChunk(
  bytes: Buffer,
  state: RolloutReadState,
  limits: CodexTailLimits,
  onLine: (line: Buffer) => void,
  counters: TickCounters,
): void {
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline === -1 ? bytes.length : newline;
    const piece = bytes.subarray(start, end);
    if (state.discarding || state.carryBytes + piece.length > limits.maxLineBytes) {
      // Oversize line: dropped unparsed; counts against the discard cap only.
      counters.discarded += state.carryBytes + piece.length;
      state.carry = [];
      state.carryBytes = 0;
      state.discarding = newline === -1;
    } else if (newline === -1) {
      state.carry.push(Buffer.from(piece));
      state.carryBytes += piece.length;
    } else {
      const line = state.carryBytes > 0 ? Buffer.concat([...state.carry, piece]) : piece;
      state.carry = [];
      state.carryBytes = 0;
      counters.lineBytes += line.length + 1;
      if (line.length > 0) onLine(line);
    }
    start = end + 1;
  }
}

/**
 * Reads appended bytes from `handle` at `state.offset` within one tick's
 * budget, calling `onLine` for every complete line of at most `maxLineBytes`.
 * A trailing torn line stays buffered in `state` for the next tick.
 */
export async function readRolloutTick(
  handle: FileHandle,
  state: RolloutReadState,
  limits: CodexTailLimits,
  onLine: (line: Buffer) => void,
): Promise<void> {
  const counters: TickCounters = { lineBytes: 0, discarded: 0 };
  const chunk = Buffer.allocUnsafe(limits.chunkBytes);
  while (counters.lineBytes < limits.tickBytes && counters.discarded < limits.discardBytesPerTick) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, state.offset);
    if (bytesRead === 0) return;
    state.offset += bytesRead;
    consumeChunk(chunk.subarray(0, bytesRead), state, limits, onLine, counters);
  }
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Candidate parent rollout of `threadId`: the run's stored transcript when its
 * name carries the thread id (a resume), else `rollout-*-<threadId>.jsonl` in
 * today's or yesterday's local date directory under `sessionsRoot` (a new
 * thread; Codex files rollouts by local start date). Containment is checked by
 * the caller.
 */
export async function locateCodexRollout(
  threadId: string,
  sessionsRoot: string,
  storedPath: string | null,
  now: Date,
): Promise<string | null> {
  if (!THREAD_ID.test(threadId)) return null;
  const suffix = `-${threadId}.jsonl`;
  if (storedPath && path.basename(storedPath).endsWith(suffix)) return storedPath;
  for (const day of [now, new Date(now.getTime() - 86_400_000)]) {
    const dir = path.join(sessionsRoot, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    const names = await readdir(dir).catch(() => [] as string[]);
    const match = names.find((name) => name.startsWith('rollout-') && name.endsWith(suffix));
    if (match) return path.join(dir, match);
  }
  return null;
}

/** Resolves after `ms`, or early (false) when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(false); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

type FileIdentity = { dev: number; ino: number };
const sameFile = (stats: Stats | null, identity: FileIdentity): boolean =>
  Boolean(stats) && stats!.dev === identity.dev && stats!.ino === identity.ino;

export type CodexRolloutTailOptions = {
  threadId: string;
  /** `<principal CODEX_HOME>/sessions` of this run; the only containment root. */
  sessionsRoot: string;
  /** Resumed thread: start at the file size when opened, so earlier turns' spawns are not re-emitted. */
  resumed: boolean;
  storedPath?: string | null;
  signal?: AbortSignal;
  onSignal: (signal: CodexTailSignal) => void;
  limits?: Partial<CodexTailLimits>;
  now?: () => Date;
  permit?: <T>(signal: AbortSignal | undefined, read: () => Promise<T>) => Promise<T>;
};

export type CodexRolloutTail = {
  /** True once a labelled spawn was emitted in this run. */
  readonly spawnSeen: boolean;
  /** 'waiting' for the file, 'tailing', or 'closed' (fd released). */
  readonly phase: 'waiting' | 'tailing' | 'closed';
  /**
   * Stops the tail and closes its fd. `drain` reads one last tick first, only
   * when a spawn was seen and within `drainTimeoutMs`. Idempotent.
   */
  stop(options?: { drain?: boolean }): Promise<void>;
};

class RolloutTail implements CodexRolloutTail {
  spawnSeen = false;
  phase: 'waiting' | 'tailing' | 'closed' = 'waiting';
  private handle: FileHandle | null = null;
  private filePath = '';
  private identity: FileIdentity = { dev: -1, ino: -1 };
  private drain = false;
  private readonly stopper = new AbortController();
  private readonly read: RolloutReadState = { offset: 0, carry: [], carryBytes: 0, discarding: false };
  private readonly fold: ReturnType<typeof createCodexSpawnFold>;
  private readonly children = new Map<string, {
    path: string; handle: FileHandle; identity: FileIdentity; read: RolloutReadState;
    agentType?: string; label: string; model?: string; effort?: string;
    tools: Map<string, { id: string; name: string; status: string }>;
    ownHistory: ReturnType<typeof createCodexOwnHistoryFilter>;
    snapshot?: string;
  }>();
  private readonly pendingChildren = new Map<string, CodexTailSignal>();
  private readonly skippedChildren = new Set<string>();
  private nextChildRefreshAt = 0;
  private childRefreshRunning = false;
  private childRefresh: Promise<void> | null = null;
  private readonly permit: NonNullable<CodexRolloutTailOptions['permit']>;
  private readonly onAbort = () => { void this.stop(); };
  private readonly done: Promise<void>;

  constructor(private readonly options: CodexRolloutTailOptions, private readonly limits: CodexTailLimits) {
    this.fold = createCodexSpawnFold(limits.maxTracked);
    this.permit = options.permit ?? withTranscriptReadPermit;
    if (options.signal?.aborted) this.stopper.abort();
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.done = this.run();
  }

  async stop(options: { drain?: boolean } = {}): Promise<void> {
    if (options.drain) this.drain = true;
    this.stopper.abort();
    await this.done;
  }

  private async run(): Promise<void> {
    try {
      if (!(await this.attach())) return;
      while (this.phase === 'tailing' && await pause(this.limits.pollMs, this.stopper.signal)) {
        await this.permit(this.stopper.signal, () => this.tick()).catch((error: unknown) => {
          if (!this.stopper.signal.aborted) throw error;
        });
        if (!this.childRefresh && Date.now() >= this.nextChildRefreshAt) {
          this.nextChildRefreshAt = Date.now() + 2000;
          this.childRefresh = this.updateLinkedChildren().finally(() => {
            this.childRefresh = null;
          });
        }
      }
      if (this.drain && this.phase === 'tailing' && this.spawnSeen) {
        // Bounded: a saturated read gate gives up the drain instead of delaying completion.
        await this.permit(AbortSignal.timeout(this.limits.drainTimeoutMs), () => this.tick());
      }
    } catch {
      // Best effort: history stays canonical, so a failed tail ends silently.
    } finally {
      await this.close();
    }
  }

  /** Waits for the rollout with bounded retries; true once the fd is open. */
  private async attach(): Promise<boolean> {
    const attempts = Math.floor(this.limits.waitMaxMs / this.limits.waitStepMs) + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0 && !(await pause(this.limits.waitStepMs, this.stopper.signal))) return false;
      const opened = await this.permit(this.stopper.signal, () => this.tryOpen()).catch(() => false);
      if (opened) {
        this.phase = 'tailing';
        return true;
      }
      if (this.stopper.signal.aborted) return false;
    }
    return false;
  }

  /**
   * ADR-201 A1 for a run-named rollout: there is no requester (the run itself
   * announced the thread) and maybe no row yet, so the DB-free core is used —
   * confined to this run's sessions root, pinned, and bound to the thread id.
   */
  private async tryOpen(): Promise<boolean> {
    const { threadId, sessionsRoot, storedPath = null } = this.options;
    const candidate = await locateCodexRollout(threadId, sessionsRoot, storedPath, (this.options.now ?? (() => new Date()))());
    if (!candidate || this.stopper.signal.aborted) return false;
    const opened = await openRunTranscript({
      provider: 'codex', sessionId: threadId, candidate, root: sessionsRoot, purpose: 'rollout-tail',
    });
    if (!isTranscriptHandle(opened)) return false;
    if (this.stopper.signal.aborted) {
      await opened.fd.close();
      return false;
    }
    this.handle = opened.fd;
    this.filePath = opened.realpath;
    this.identity = { dev: Number(opened.stat.dev), ino: Number(opened.stat.ino) };
    this.read.offset = this.options.resumed ? Number(opened.stat.size) : 0;
    return true;
  }

  private async tick(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    const [onPath, onFd] = await Promise.all([lstat(this.filePath).catch(() => null), handle.stat()]);
    if (!sameFile(onPath, this.identity) || !sameFile(onFd, this.identity) || onFd.size < this.read.offset) {
      this.phase = 'closed';
      this.stopper.abort();
      return;
    }
    await readRolloutTick(handle, this.read, this.limits, (line) => this.onLine(line));
  }

  private async updateLinkedChildren(): Promise<void> {
    if (!this.spawnSeen || !this.filePath || this.stopper.signal.aborted
      || this.childRefreshRunning) return;
    this.childRefreshRunning = true;
    try {
      for (const [callId, spawn] of this.pendingChildren) {
        if (!spawn.agentThreadId || this.children.has(callId)
          || this.skippedChildren.has(callId)) continue;
        const candidate = await resolveCodexChildRolloutPath(this.filePath,
          spawn.agentThreadId, spawn.occurredAtMs ?? null, this.stopper.signal);
        if (!candidate || this.stopper.signal.aborted) continue;
        const opened = await openRunTranscript({ provider: 'codex', sessionId: spawn.agentThreadId,
          candidate, root: this.options.sessionsRoot, purpose: 'rollout-tail' });
        if (!isTranscriptHandle(opened)) continue;
        this.children.set(callId, { path: opened.realpath, handle: opened.fd,
          identity: { dev: Number(opened.stat.dev), ino: Number(opened.stat.ino) },
          read: { offset: 0, carry: [], carryBytes: 0, discarding: false },
          agentType: spawn.agentType, label: spawn.label, tools: new Map(),
          ownHistory: createCodexOwnHistoryFilter() });
      }
      for (const [callId, child] of this.children) {
        const [onPath, onFd] = await Promise.all([lstat(child.path).catch(() => null), child.handle.stat()]);
        if (!sameFile(onPath, child.identity) || !sameFile(onFd, child.identity)
          || onFd.size < child.read.offset) {
          console.warn('Codex child rollout replaced or truncated; skipping live tools');
          await child.handle.close().catch(() => undefined);
          this.children.delete(callId);
          this.skippedChildren.add(callId);
          continue;
        }
        await readRolloutTick(child.handle, child.read, this.limits, (line) => {
          let entry: unknown;
          try { entry = JSON.parse(line.toString('utf8')); } catch { return; }
          if (!isRecord(entry) || !isRecord(entry.payload)) return;
          if (!child.ownHistory.accept(entry)) return;
          const payload = entry.payload;
          if (typeof payload.model === 'string') child.model = payload.model;
          if (typeof payload.effort === 'string') child.effort = payload.effort;
          if (entry.type === 'turn_context' && typeof payload.reasoning_effort === 'string') {
            child.effort = payload.reasoning_effort;
          }
          if (payload.type === 'function_call' && typeof payload.call_id === 'string'
            && typeof payload.name === 'string') {
            child.tools.set(payload.call_id, { id: payload.call_id, name: payload.name, status: 'running' });
          } else if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
            const tool = child.tools.get(payload.call_id);
            if (tool) tool.status = payload.is_error ? 'failed' : 'completed';
          }
        });
        const snapshot = JSON.stringify([child.model, child.effort, [...child.tools.values()]]);
        if (snapshot === child.snapshot) continue;
        child.snapshot = snapshot;
        this.emit({ kind: 'progress', callId, label: child.label,
          ...(child.agentType ? { agentType: child.agentType } : {}),
          ...(child.model ? { model: child.model } : {}), ...(child.effort ? { effort: child.effort } : {}),
          tools: [...child.tools.values()] });
      }
    } catch {
      // Child rollout enrichment is optional; the parent tail remains live.
    } finally {
      this.childRefreshRunning = false;
    }
  }

  private emit(signal: CodexTailSignal): void {
    try { this.options.onSignal(signal); } catch { /* Consumer failures do not stop the tail. */ }
  }

  private onLine(line: Buffer): void {
    if (!this.fold.wants(line)) return;
    let entry: unknown;
    try {
      entry = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    const signal = this.fold.accept(entry);
    if (!signal) return;
    if (signal.kind === 'spawn') this.spawnSeen = true;
    if (signal.kind === 'progress') {
      if (signal.agentPath) this.pendingChildren.set(signal.callId, signal);
      return;
    }
    this.emit(signal);
  }

  private async close(): Promise<void> {
    this.options.signal?.removeEventListener('abort', this.onAbort);
    await this.childRefresh;
    await Promise.all([...this.children.values()].map((child) => child.handle.close().catch(() => undefined)));
    this.phase = 'closed';
    this.read.carry = [];
    this.read.carryBytes = 0;
    const handle = this.handle;
    this.handle = null;
    await handle?.close().catch(() => {});
  }
}

/** Starts one parent-rollout tail; see the module comment for its rules. */
export function startCodexRolloutTail(options: CodexRolloutTailOptions): CodexRolloutTail {
  return new RolloutTail(options, { ...CODEX_TAIL_LIMITS, ...options.limits });
}

/**
 * Live row for a tail signal: a spawn opens the `Task` card under the spawn's
 * `call_id` (the history row's id, so dedup keeps one and history wins after a
 * reload); a settlement is a `tool_result` on that card. Text-only bounded label.
 */
export function codexTailRow(signal: CodexTailSignal, sessionId: string | null, timestamp: string): NormalizedMessage {
  const base = { sessionId, timestamp, provider: 'codex' as const, toolId: signal.callId };
  if (signal.kind === 'progress') {
    return createNormalizedMessage({
      ...base,
      id: `${signal.callId}-live-progress`,
      kind: 'status',
      subagent: codexSpawnSubagent(signal.callId, signal.label, 'running', signal),
    });
  }
  if (signal.kind === 'spawn') {
    return createNormalizedMessage({
      ...base,
      id: signal.callId,
      kind: 'tool_use',
      toolName: 'Task',
      toolInput: {
        description: signal.label,
        ...(signal.agentType ? { subagent_type: signal.agentType } : {}),
      },
      subagent: codexSpawnSubagent(signal.callId, signal.label, 'started', signal),
    });
  }
  return createNormalizedMessage({
    ...base,
    id: `${signal.callId}-settled`,
    kind: 'tool_result',
    content: '',
    isError: false,
    subagent: codexSpawnSubagent(signal.callId, signal.label, 'completed', signal),
  });
}

const HIDDEN_COLLAB_MAX = 200;

/** Tail of a run whose `features.multi_agent` is off: inert by construction. */
const DORMANT_RUN_TAIL: CodexRunSubagentTail = Object.freeze({
  onThreadStarted() {},
  hidesCollab: () => false,
  stop: async () => {},
});

export type CodexRunSubagentTail = {
  /** Starts the run's single tail on the thread the process announced. Later calls are ignored. */
  onThreadStarted(threadId: unknown, resumed: boolean, storedPath: string | null): void;
  /** True when an anonymous `collab_tool_call` row must be dropped because a labelled spawn exists. */
  hidesCollab(transformed: AnyRecord | null | undefined): boolean;
  stop(options?: { drain?: boolean }): Promise<void>;
};

/**
 * Per-run owner of the rollout tail for openai-codex.js. Once a labelled spawn
 * exists, new anonymous collab cards are hidden (an already shown one may still
 * settle, so no card is left running); the hidden-id set is bounded.
 */
export function createCodexRunSubagentTail(options: {
  /**
   * Effective `features.multi_agent` of the run. When false no spawn can occur,
   * so the tail is dormant: no fd, no permit, no polling.
   */
  enabled: boolean;
  codexHome: () => string;
  signal: AbortSignal;
  sessionId: () => string | null;
  emit: (message: NormalizedMessage) => void;
  start?: typeof startCodexRolloutTail;
}): CodexRunSubagentTail {
  if (!options.enabled) return DORMANT_RUN_TAIL;
  let tail: CodexRolloutTail | null = null;
  let stopped = false;
  const hidden = new Set<string>();
  return {
    onThreadStarted(threadId, resumed, storedPath) {
      if (tail || stopped || typeof threadId !== 'string') return;
      tail = (options.start ?? startCodexRolloutTail)({
        threadId,
        sessionsRoot: path.join(options.codexHome(), 'sessions'),
        resumed,
        storedPath,
        signal: options.signal,
        onSignal: (signal) => options.emit(codexTailRow(signal, options.sessionId(), new Date().toISOString())),
      });
    },
    hidesCollab(transformed) {
      if (transformed?.itemType !== 'collab_tool_call' || typeof transformed.uuid !== 'string') return false;
      const id = transformed.uuid;
      if (hidden.has(id)) {
        if (transformed.progressPhase === 'completed') hidden.delete(id);
        return true;
      }
      if (!tail?.spawnSeen || transformed.progressOpened === true) return false;
      if (transformed.progressPhase === 'started' && hidden.size < HIDDEN_COLLAB_MAX) hidden.add(id);
      return true;
    },
    async stop(stopOptions) {
      stopped = true;
      await tail?.stop(stopOptions);
    },
  };
}
