import { lstat, readdir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { openFileNoFollow, PinnedOpenError, type PinnedHandle } from '../../shared/pinned-fd.js';

export type CodexSpawn = {
  callId: string | null;
  taskName: string;
  /**
   * `activity` (B-1616): a 0.160 v2 parent links a child only through
   * `event_msg item_completed {item.type:"SubAgentActivity", kind:"started"}`.
   */
  linkKind: 'legacy' | 'direct' | 'custom' | 'activity';
  agentPath: string | null;
  agentThreadId: string | null;
  childRolloutPath: string | null;
  occurredAtMs: number | null;
};

export type CodexRolloutMetadata = {
  /** Distinct models observed in this rollout, ordered by first use. */
  models: string[];
  model: string | null;
  effort: string | null;
  tools: Array<{ id: string; name: string; status: string }>;
  threadId: string | null;
  sessionId: string | null;
  parentThreadId: string | null;
  threadSource: string | null;
  sourceIsSubagent: boolean;
  agentPath: string | null;
  /** Role declared by this rollout's own session metadata. */
  agentRole: string | null;
  /** First ordinal of this rollout's own history (B-1616); null when none is declared. */
  historyStartOrdinal: number | null;
  spawns: CodexSpawn[];
  /** False when the same open file descriptor changed during the metadata pass. */
  snapshotStable: boolean;
  snapshotSize: number;
  snapshotMtimeMs: number;
};

export type CodexRolloutFile = {
  rolloutPath: string;
  /** Thread id of this rollout's own first `session_meta` (its name carries it). */
  threadId: string | null;
  model: string | null;
  /** See {@link CodexRolloutMetadata.historyStartOrdinal}. */
  historyStartOrdinal: number | null;
  size: number;
  mtimeMs: number;
};

export type CodexRolloutManifest = {
  root: CodexRolloutMetadata;
  linked: CodexLinkedRollout[];
  spawns: CodexSpawn[];
  spawnCount: number;
  files: CodexRolloutFile[];
  complete: boolean;
  limitReason: string | null;
};

/** One process-wide, FIFO and abortable read gate for all Codex rollout passes. */
class FairReadSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (this.active < this.limit && this.waiters.length === 0) {
      this.active += 1;
      return this.releaseFn();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal } as (typeof this.waiters)[number];
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseFn(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.signal?.removeEventListener('abort', waiter.onAbort!);
        waiter.resolve(this.releaseFn());
      } else {
        this.active -= 1;
      }
    };
  }
}

const rolloutReadSemaphore = new FairReadSemaphore(4);

export async function withTranscriptReadPermit<T>(
  signal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T> {
  const release = await rolloutReadSemaphore.acquire(signal);
  try {
    return await read();
  } finally {
    release();
  }
}

export const withCodexRolloutRead = withTranscriptReadPermit;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const validThreadId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9-]{20,}$/i.test(value);

/**
 * B-1616: `subagent_history_start_ordinal` of a first `session_meta` payload. A
 * 0.160 child rollout replays its parent's history (a second, parent
 * `session_meta` included) before its own; records with a lower ordinal are not
 * this thread's. Only a positive safe integer counts.
 */
export function readCodexHistoryStartOrdinal(payload: unknown): number | null {
  const value = isRecord(payload) ? payload.subagent_history_start_ordinal : undefined;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * B-1616: decides, record by record in file order, whether a rollout record is
 * the file's OWN history. Identity comes from the first record only, and only
 * when it is a `session_meta`; a later `session_meta` (the forked parent's) is
 * never identity. Records whose native `ordinal` (else their position, when the
 * caller starts at byte 0) is below the declared start are inherited history.
 * `knownStart` serves incremental readers that resume mid-file.
 */
export function createCodexOwnHistoryFilter(knownStart: number | null = null, fromStart = true) {
  let start = knownStart;
  let index = -1;
  let identity: Record<string, unknown> | null = null;
  return {
    /** The first record's `session_meta` payload, or null. */
    get identity(): Record<string, unknown> | null { return identity; },
    get historyStartOrdinal(): number | null { return start; },
    /** True when `entry` belongs to this rollout's own history. */
    accept(entry: unknown): boolean {
      index += 1;
      if (fromStart && index === 0 && isRecord(entry) && entry.type === 'session_meta' && isRecord(entry.payload)) {
        identity = entry.payload;
        start ??= readCodexHistoryStartOrdinal(entry.payload);
      }
      if (start === null) return true;
      const ordinal = isRecord(entry) && Number.isSafeInteger(entry.ordinal) ? entry.ordinal as number
        : fromStart ? index : null;
      return ordinal === null || ordinal >= start;
    },
  };
}

function readSpawnArguments(value: unknown): { taskName: string } {
  if (typeof value !== 'string') return { taskName: 'subagent' };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return { taskName: 'subagent' };
    const taskName = typeof parsed.task_name === 'string'
      ? parsed.task_name.trim()
      : typeof parsed.agent_type === 'string'
        ? parsed.agent_type.trim()
        : '';
    return { taskName: taskName || 'subagent' };
  } catch {
    return { taskName: 'subagent' };
  }
}

function readCustomToolOutputAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const agentIds: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.type !== 'input_text' || typeof item.text !== 'string') continue;
    let parsed: unknown;
    try { parsed = JSON.parse(item.text); } catch { continue; }
    if (isRecord(parsed) && validThreadId(parsed.agent_id)) agentIds.push(parsed.agent_id);
  }
  return agentIds;
}

function validAgentRole(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value);
}

function readAgentRole(payload: Record<string, unknown>): string | null {
  const directPresent = Object.hasOwn(payload, 'agent_role');
  const direct = validAgentRole(payload.agent_role) ? payload.agent_role : null;
  const source = isRecord(payload.source) ? payload.source : null;
  const subagent = source && isRecord(source.subagent) ? source.subagent : null;
  const threadSpawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
  const nestedPresent = Boolean(threadSpawn && Object.hasOwn(threadSpawn, 'agent_role'));
  const nested = threadSpawn && validAgentRole(threadSpawn.agent_role) ? threadSpawn.agent_role : null;
  // Malformed or conflicting declarations are ambiguous, not a naming preference.
  if ((directPresent && !direct) || (nestedPresent && !nested)) return null;
  if (direct && nested && direct !== nested) return null;
  return direct ?? nested;
}

async function childPathForThread(
  parentRolloutPath: string,
  threadId: string,
  occurredAtMs: number | null,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (!validThreadId(threadId)) return null;
  const parentDirectory = path.dirname(parentRolloutPath);
  const directories = [parentDirectory];

  // A long-lived coordinator keeps its original rollout file while a child
  // started after midnight is written under the event's YYYY/MM/DD directory.
  const day = path.basename(parentDirectory);
  const monthDirectory = path.dirname(parentDirectory);
  const month = path.basename(monthDirectory);
  const yearDirectory = path.dirname(monthDirectory);
  const year = path.basename(yearDirectory);
  const hasDateHierarchy = /^\d{4}$/.test(year) && /^\d{2}$/.test(month) && /^\d{2}$/.test(day);
  const sessionsRoot = hasDateHierarchy ? path.dirname(yearDirectory) : parentDirectory;
  if (hasDateHierarchy && occurredAtMs !== null) {
    const eventDate = new Date(occurredAtMs);
    if (!Number.isNaN(eventDate.getTime())) {
      // Codex puts the date in its rollout *filename/directory* using the
      // writer's local clock, whereas event timestamps are UTC.  Near local
      // midnight those dates differ by one day (the source of false
      // "unresolved rollout" warnings on otherwise complete sessions).  The
      // exact thread-id suffix and sessions-root containment checks below keep
      // the adjacent-day lookup narrow and safe.
      for (const dayOffset of [-1, 0, 1]) {
        const candidateDate = new Date(eventDate.getTime() + dayOffset * 86_400_000);
        const eventDirectory = path.join(
          sessionsRoot,
          String(candidateDate.getUTCFullYear()),
          String(candidateDate.getUTCMonth() + 1).padStart(2, '0'),
          String(candidateDate.getUTCDate()).padStart(2, '0'),
        );
        if (!directories.includes(eventDirectory)) directories.push(eventDirectory);
      }
    }
  }

  try {
    const realSessionsRoot = await realpath(sessionsRoot);
    for (const directory of directories) {
      signal?.throwIfAborted();
      let names: string[];
      try { names = await readdir(directory); } catch { continue; }
      signal?.throwIfAborted();
      const suffix = `-${threadId}.jsonl`;
      const name = names.find((candidate) => candidate.endsWith(suffix));
      if (!name) continue;
      const [realDirectory, realCandidate] = await Promise.all([
        realpath(directory),
        realpath(path.join(directory, name)),
      ]);
      const relativeDirectory = path.relative(realSessionsRoot, realDirectory);
      const insideSessionsRoot = relativeDirectory === '' ||
        (!relativeDirectory.startsWith('..') && !path.isAbsolute(relativeDirectory));
      // The real directory plus the listed name: the pinned open below refuses
      // the name when it is itself a symlink (ADR-201 A1), so it is never resolved here.
      if (insideSessionsRoot && path.dirname(realCandidate) === realDirectory) return path.join(realDirectory, name);
    }
  } catch {
    signal?.throwIfAborted();
    return null;
  }
  return null;
}

/** Resolves one already-linked child once for the live incremental tail. */
export function resolveCodexChildRolloutPath(
  parentRolloutPath: string,
  threadId: string,
  occurredAtMs: number | null,
  signal?: AbortSignal,
): Promise<string | null> {
  return childPathForThread(parentRolloutPath, threadId, occurredAtMs, signal);
}

/** A refused rollout open; `reason` carries no path or content. */
export class CodexRolloutRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`Codex rollout refused: ${reason}`);
    this.name = 'CodexRolloutRefusedError';
  }
}

/** Pinned single-link open, last component never followed; a refusal throws CodexRolloutRefusedError. */
async function openRollout(rolloutPath: string): Promise<PinnedHandle> {
  try {
    return await openFileNoFollow(rolloutPath);
  } catch (error) {
    throw new CodexRolloutRefusedError(error instanceof PinnedOpenError ? error.reason : 'io_error');
  }
}

/**
 * Reads only Codex-native actor/link fields from one rollout (ADR-201 A1.5):
 * the rollout is read from a pinned single-link descriptor whose last path
 * component is never followed. Identity is bound by the caller (the manifest
 * checks the child name, `session_meta` and its sessions root). Throws
 * CodexRolloutRefusedError on a refused open.
 */
export async function readCodexRolloutMetadata(
  rolloutPath: string,
  signal?: AbortSignal,
): Promise<CodexRolloutMetadata> {
  const opened = await openRollout(rolloutPath);
  try {
    return await readRolloutMetadataFrom(opened.handle, signal);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Metadata pass over an already pinned rollout descriptor (left open). */
async function readRolloutMetadataFrom(handle: FileHandle, signal?: AbortSignal): Promise<CodexRolloutMetadata> {
  return withCodexRolloutRead(signal, async () => {
  let model: string | null = null;
  let effort: string | null = null;
  const toolCalls = new Map<string, { id: string; name: string; status: string }>();
  const models: string[] = [];
  const modelsSeen = new Set<string>();
  let threadId: string | null = null;
  let sessionId: string | null = null;
  let parentThreadId: string | null = null;
  let threadSource: string | null = null;
  let sourceIsSubagent = false;
  let ownAgentPath: string | null = null;
  let agentRole: string | null = null;
  const calls = new Map<string, {
    taskName: string;
    multiAgentV1: boolean;
    occurredAtMs: number | null;
  }>();
  const customToolCalls = new Map<string, { occurredAtMs: number | null }>();
  const started: Array<{
    callId: string | null;
    taskName: string;
    linkKind: CodexSpawn['linkKind'];
    agentPath: string | null;
    agentThreadId: string;
    occurredAtMs: number | null;
  }> = [];
  const seenThreads = new Set<string>();
  const own = createCodexOwnHistoryFilter();
  let identityRead = false;

  const before = await handle.stat();
  const stream = handle.createReadStream({ encoding: 'utf8', signal, autoClose: false });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let snapshotStable = true;
  try {
    for await (const line of lines) {
      if (!line || line.charCodeAt(0) !== 123) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!isRecord(entry)) continue;
      const isOwn = own.accept(entry);
      const identity = identityRead ? null : own.identity;
      // B-1616: identity is the FIRST record's session_meta only. A 0.160 child
      // carries its parent's session_meta as line 1 (thread_source "user"): it
      // must never re-identify the child, and nothing before the child's
      // subagent_history_start_ordinal (forked parent history) is the child's.
      if (identity !== null) {
        identityRead = true;
        const payload = identity;
        threadId = validThreadId(payload.id) ? payload.id : null;
        sessionId = validThreadId(payload.session_id) ? payload.session_id : null;
        parentThreadId = validThreadId(payload.parent_thread_id) ? payload.parent_thread_id : null;
        threadSource = typeof payload.thread_source === 'string' ? payload.thread_source : null;
        sourceIsSubagent = isRecord(payload.source) && 'subagent' in payload.source;
        ownAgentPath = typeof payload.agent_path === 'string' ? payload.agent_path : null;
        agentRole = readAgentRole(payload);
      }
      if (!isOwn) continue;
      const payload = isRecord(entry.payload) ? entry.payload : null;
      if (!payload) continue;

      if (typeof payload.model === 'string' && payload.model) {
        model = payload.model;
        if (!modelsSeen.has(payload.model)) {
          modelsSeen.add(payload.model);
          models.push(payload.model);
        }
      }

      if (entry.type === 'turn_context') {
        const nextEffort = typeof payload.effort === 'string' ? payload.effort
          : typeof payload.reasoning_effort === 'string' ? payload.reasoning_effort : '';
        if (nextEffort) effort = nextEffort;
      }
      if (entry.type === 'response_item' && payload.type === 'function_call'
        && typeof payload.call_id === 'string' && typeof payload.name === 'string') {
        toolCalls.set(payload.call_id, {
          id: payload.call_id, name: payload.name, status: 'running',
        });
      }
      if (entry.type === 'response_item' && payload.type === 'function_call_output'
        && typeof payload.call_id === 'string') {
        const tool = toolCalls.get(payload.call_id);
        if (tool) tool.status = payload.is_error ? 'failed' : 'completed';
      }

      if (entry.type === 'response_item' && payload.type === 'function_call') {
        const name = typeof payload.name === 'string' ? payload.name : '';
        const namespace = typeof payload.namespace === 'string' ? payload.namespace : '';
        const multiAgentV1 = name === 'spawn_agent' && namespace === 'multi_agent_v1';
        if (!(
          (name === 'spawn_agent' && namespace === 'collaboration') ||
          name === 'collaboration.spawn_agent' ||
          multiAgentV1
        )) {
          continue;
        }
        const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
        if (callId && !calls.has(callId)) {
          const occurredAtMs = Date.parse(String(entry.timestamp ?? ''));
          calls.set(callId, {
            ...readSpawnArguments(payload.arguments),
            multiAgentV1,
            occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : null,
          });
        }
        continue;
      }

      if (entry.type === 'response_item' && payload.type === 'function_call_output') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
        const call = callId ? calls.get(callId) : undefined;
        if (!call?.multiAgentV1 || typeof payload.output !== 'string') continue;
        let output: unknown;
        try { output = JSON.parse(payload.output); } catch { continue; }
        if (!isRecord(output) || !validThreadId(output.agent_id) || seenThreads.has(output.agent_id)) continue;
        seenThreads.add(output.agent_id);
        const occurredAtMs = Date.parse(String(entry.timestamp ?? ''));
        started.push({
          callId,
          taskName: call.taskName,
          linkKind: 'direct',
          agentPath: null,
          agentThreadId: output.agent_id,
          occurredAtMs: call.occurredAtMs ?? (Number.isFinite(occurredAtMs) ? occurredAtMs : null),
        });
        continue;
      }

      if (entry.type === 'response_item' && payload.type === 'custom_tool_call') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
        if (callId && payload.name === 'exec' && !customToolCalls.has(callId)) {
          const occurredAtMs = Date.parse(String(entry.timestamp ?? ''));
          customToolCalls.set(callId, {
            occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : null,
          });
        }
        continue;
      }

      if (entry.type === 'response_item' && payload.type === 'custom_tool_call_output') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : null;
        const call = callId ? customToolCalls.get(callId) : undefined;
        const agentIds = call ? readCustomToolOutputAgentIds(payload.output) : [];
        if (!call || agentIds.length === 0) continue;
        const occurredAtMs = Date.parse(String(entry.timestamp ?? ''));
        for (const agentThreadId of agentIds) {
          if (seenThreads.has(agentThreadId)) continue;
          seenThreads.add(agentThreadId);
          started.push({
            callId,
            taskName: 'subagent',
            linkKind: 'custom',
            agentPath: null,
            agentThreadId,
            occurredAtMs: call.occurredAtMs ?? (Number.isFinite(occurredAtMs) ? occurredAtMs : null),
          });
        }
        continue;
      }

      // B-1616: the 0.160 (v2) link form. `item.id` is the spawn's call id.
      if (entry.type === 'event_msg' && payload.type === 'item_completed') {
        const item = isRecord(payload.item) ? payload.item : null;
        if (
          !item || item.type !== 'SubAgentActivity' || item.kind !== 'started' ||
          !validThreadId(item.agent_thread_id) || seenThreads.has(item.agent_thread_id)
        ) continue;
        const agentPath = typeof item.agent_path === 'string' ? item.agent_path : null;
        // A child links only its own descendants (same path-prefix rule as legacy).
        if (threadSource === 'subagent' && (!ownAgentPath || !agentPath?.startsWith(`${ownAgentPath}/`))) continue;
        seenThreads.add(item.agent_thread_id);
        const callId = typeof item.id === 'string' ? item.id : null;
        const startedAtMs = Number(payload.started_at_ms);
        started.push({
          callId,
          taskName: (callId ? calls.get(callId)?.taskName : undefined) ?? (path.basename(agentPath ?? '') || 'subagent'),
          linkKind: 'activity',
          agentPath,
          agentThreadId: item.agent_thread_id,
          occurredAtMs: (callId ? calls.get(callId)?.occurredAtMs : null)
            ?? (Number.isFinite(startedAtMs) ? startedAtMs : Date.parse(String(entry.timestamp ?? '')) || null),
        });
        continue;
      }

      if (
        entry.type !== 'event_msg' ||
        payload.type !== 'sub_agent_activity' ||
        payload.kind !== 'started' ||
        !validThreadId(payload.agent_thread_id) ||
        seenThreads.has(payload.agent_thread_id)
      ) {
        continue;
      }
      const agentPath = typeof payload.agent_path === 'string' ? payload.agent_path : null;
      if (threadSource === 'subagent' && (!ownAgentPath || !agentPath?.startsWith(`${ownAgentPath}/`))) {
        continue;
      }
      seenThreads.add(payload.agent_thread_id);
      const callId = typeof payload.event_id === 'string' ? payload.event_id : null;
      const occurredAtMs = Number(payload.occurred_at_ms);
      started.push({
        callId,
        taskName: callId
          ? (calls.get(callId)?.taskName ?? (path.basename(agentPath ?? '') || 'subagent'))
          : (path.basename(agentPath ?? '') || 'subagent'),
        linkKind: 'legacy',
        agentPath,
        agentThreadId: payload.agent_thread_id,
        occurredAtMs: Number.isFinite(occurredAtMs) ? occurredAtMs : Date.parse(String(entry.timestamp ?? '')) || null,
      });
    }
  } finally {
    const after = await handle.stat().catch(() => null);
    snapshotStable = Boolean(after && after.size === before.size && after.mtimeMs === before.mtimeMs);
    lines.close();
    stream.destroy();
  }

  const spawns: CodexSpawn[] = started.map((spawn) => ({
    ...spawn,
    childRolloutPath: null,
  }));

  return {
    models,
    model,
    effort,
    tools: [...toolCalls.values()],
    threadId,
    sessionId,
    parentThreadId,
    threadSource,
    sourceIsSubagent,
    agentPath: ownAgentPath,
    agentRole,
    historyStartOrdinal: own.historyStartOrdinal,
    spawns,
    snapshotStable,
    snapshotSize: before.size,
    snapshotMtimeMs: before.mtimeMs,
  };
  });
}

export type CodexLinkedRollout = {
  rolloutPath: string;
  model: string | null;
  effort: string | null;
  tools: Array<{ id: string; name: string; status: string }>;
  /** Parent declared by this child's own immutable session metadata. */
  parentThreadId: string;
  spawn: CodexSpawn;
};

/** Follows explicit parent→thread links recursively, never scanning unrelated days/users. */
async function buildCodexRolloutManifest(
  rootRolloutPath: string,
  signal?: AbortSignal,
  afterMetadata?: () => Promise<void> | void,
): Promise<CodexRolloutManifest> {
  // ADR-201 A1.5: every rollout of the manifest is read from a pinned
  // descriptor; children are also confined to the root's sessions root below.
  const root = await readCodexRolloutMetadata(rootRolloutPath, signal);
  // ADR-201 A-P2c: the root's name is bound to its own thread id exactly as a
  // child's is (childPathForThread finds `…-<threadId>.jsonl`): a rollout whose
  // session_meta names another thread is refused, never read as that thread.
  if (root.threadId && !path.basename(rootRolloutPath).endsWith(`-${root.threadId}.jsonl`)) {
    throw new CodexRolloutRefusedError('name_mismatch');
  }
  const linked: CodexLinkedRollout[] = [];
  const spawns: CodexSpawn[] = [];
  const visitedPaths = new Set([rootRolloutPath]);
  const metadataByPath = new Map<string, CodexRolloutMetadata>([[rootRolloutPath, root]]);

  const rootSessionId = root.sessionId ?? root.threadId;
  // These are safeguards against a malformed/cyclic transcript consuming the
  // server indefinitely. They deliberately exceed normal fan-out; hitting one
  // is returned to callers, never converted into a silently partial tree.
  const MAX_DEPTH = 8;
  // The root is a source too, so 255 descendants preserve the 256-source cap.
  const MAX_NODES = 255;
  const MAX_EDGES = 512;
  let limitReason: string | null = null;
  let unresolved = 0;
  let unstable = root.snapshotStable ? 0 : 1;

  // Match the session synchronizer's contract: an explicit user thread is a
  // conversation root even when it is a manual fork with back-references.
  // The source-object subagent marker remains authoritative and fails closed.
  const rootIdentityValid = Boolean(
    root.threadId &&
    root.sessionId &&
    root.threadSource === 'user' &&
    !root.sourceIsSubagent
  );
  if (!rootIdentityValid) {
    signal?.throwIfAborted();
    const rootStat = await lstat(rootRolloutPath);
    const hasUnfollowableLinks = root.spawns.length > 0;
    root.spawns = [];
    const rootStable = root.snapshotStable &&
      rootStat.size === root.snapshotSize && rootStat.mtimeMs === root.snapshotMtimeMs;
    const rootReason = hasUnfollowableLinks
      ? 'The Codex root has linked rollouts but no valid root identity, so they cannot be resolved safely.'
      : rootStable ? null : 'The Codex root rollout changed during manifest discovery.';
    return {
      root, linked, spawns, spawnCount: 0,
      files: [{
        rolloutPath: rootRolloutPath,
        threadId: root.threadId,
        model: root.model,
        historyStartOrdinal: root.historyStartOrdinal,
        size: root.snapshotSize,
        mtimeMs: root.snapshotMtimeMs,
      }],
      complete: rootStable && !hasUnfollowableLinks,
      limitReason: rootReason,
    };
  }

  const visit = async (
    parentPath: string,
    metadata: CodexRolloutMetadata,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): Promise<void> => {
    const candidates = metadata.spawns;
    const trusted: CodexSpawn[] = [];
    metadata.spawns = trusted;
    const admit = (spawn: CodexSpawn): void => {
      trusted.push(spawn);
      spawns.push(spawn);
    };
    for (const spawn of candidates) {
      if (spawns.length >= MAX_EDGES) {
        limitReason ??= `Codex linked-rollout edge count exceeded the safety limit (${MAX_EDGES}).`;
        continue;
      }
      const trustedActor = spawn.linkKind !== 'custom';
      if (trustedActor) admit(spawn);
      if (!spawn.agentThreadId) continue;
      if (depth >= MAX_DEPTH) {
        limitReason ??= `Codex linked-rollout depth exceeded the safety limit (${MAX_DEPTH}).`;
        continue;
      }
      if (linked.length >= MAX_NODES) {
        limitReason ??= `Codex linked-rollout count exceeded the safety limit (${MAX_NODES}).`;
        continue;
      }
      signal?.throwIfAborted();
      const childPath = await childPathForThread(parentPath, spawn.agentThreadId, spawn.occurredAtMs, signal);
      if (!childPath) {
        unresolved += 1;
        continue;
      }
      if (visitedPaths.has(childPath)) {
        if (ancestors.has(childPath)) limitReason ??= 'A cycle was detected in Codex rollout links.';
        unresolved += 1;
        continue;
      }
      const child = await readCodexRolloutMetadata(childPath, signal);
      if (!child.snapshotStable) unstable += 1;
      const identityValid = Boolean(
        child.threadId &&
        child.parentThreadId &&
        child.sessionId &&
        child.threadId === spawn.agentThreadId &&
        child.parentThreadId === metadata.threadId &&
        child.sessionId === rootSessionId &&
        child.threadSource === 'subagent'
      );
      const legacyPathValid = (spawn.linkKind !== 'legacy' && spawn.linkKind !== 'activity') || Boolean(
        spawn.agentPath && child.agentPath && spawn.agentPath === child.agentPath
      );
      const resolvedCustomRole = spawn.linkKind === 'custom' ? child.agentRole : null;
      const customRoleValid = spawn.linkKind !== 'custom' || resolvedCustomRole !== null;
      if (!identityValid || !legacyPathValid || !customRoleValid) {
        unresolved += 1;
        continue;
      }
      if (resolvedCustomRole) spawn.taskName = resolvedCustomRole;
      if (!trustedActor) admit(spawn);
      visitedPaths.add(childPath);
      metadataByPath.set(childPath, child);
      spawn.childRolloutPath = childPath;
      linked.push({
        rolloutPath: childPath,
        model: child.model,
        effort: child.effort,
        tools: child.tools,
        parentThreadId: child.parentThreadId!,
        spawn,
      });
      await visit(childPath, child, depth + 1, new Set([...ancestors, childPath]));
    }
  };
  await visit(rootRolloutPath, root, 0, new Set([rootRolloutPath]));
  if (unresolved > 0) {
    limitReason ??= `${unresolved} explicitly linked Codex rollout(s) could not be resolved safely.`;
  }
  if (unstable > 0) {
    limitReason ??= `${unstable} Codex rollout(s) changed during manifest discovery.`;
  }
  await afterMetadata?.();
  signal?.throwIfAborted();
  const files = [...metadataByPath].map(([rolloutPath, metadata]) => ({
    rolloutPath,
    threadId: metadata.threadId,
    model: metadata.model,
    historyStartOrdinal: metadata.historyStartOrdinal,
    size: metadata.snapshotSize,
    mtimeMs: metadata.snapshotMtimeMs,
  }));
  const changedAfterMetadata = await Promise.all(files.map(async (file) => {
    signal?.throwIfAborted();
    const current = await lstat(file.rolloutPath).catch(() => null);
    return !current || current.size !== file.size || current.mtimeMs !== file.mtimeMs;
  }));
  if (changedAfterMetadata.some(Boolean)) {
    limitReason ??= 'A Codex rollout changed after metadata discovery.';
  }
  return {
    root, linked, spawns, spawnCount: spawns.length,
    files, complete: limitReason === null, limitReason,
  };
}

type ManifestFlight = {
  controller: AbortController;
  promise: Promise<CodexRolloutManifest>;
  refs: number;
};
const manifestFlights = new Map<string, ManifestFlight>();
const manifestCache = new Map<string, CodexRolloutManifest>();

/** Canonical-path singleflight; one caller leaving does not cancel remaining readers. */
export async function resolveCodexLinkedRollouts(
  rootRolloutPath: string,
  signal?: AbortSignal,
  /** Deterministic race seam for unit tests; production callers omit it. */
  afterMetadata?: () => Promise<void> | void,
): Promise<CodexRolloutManifest> {
  // The directory is canonicalised, the file name never is: a symlinked
  // rollout is refused by the pinned open instead of being resolved here.
  const canonicalPath = path.join(await realpath(path.dirname(rootRolloutPath)), path.basename(rootRolloutPath));
  signal?.throwIfAborted();
  if (afterMetadata) return buildCodexRolloutManifest(canonicalPath, signal, afterMetadata);
  let rootStat;
  try { rootStat = await lstat(canonicalPath); } catch { rootStat = null; }
  const cached = rootStat?.isFile() ? manifestCache.get(canonicalPath) : null;
  if (cached) {
    const sameSnapshot = await Promise.all(cached.files.map(async (file) => {
      try {
        const current = await lstat(file.rolloutPath);
        return current.isFile() && current.size === file.size && current.mtimeMs === file.mtimeMs;
      } catch { return false; }
    }));
    if (sameSnapshot.every(Boolean)) return cached;
  }
  let flight = manifestFlights.get(canonicalPath);
  if (!flight) {
    const controller = new AbortController();
    const created = { controller, refs: 0 } as ManifestFlight;
    created.promise = buildCodexRolloutManifest(canonicalPath, controller.signal)
      .then((manifest) => {
        if (rootStat?.isFile() && manifest.complete && manifest.root.snapshotStable) {
          manifestCache.set(canonicalPath, manifest);
          while (manifestCache.size > 100) manifestCache.delete(manifestCache.keys().next().value!);
        }
        return manifest;
      }).finally(() => {
        if (manifestFlights.get(canonicalPath) === created) manifestFlights.delete(canonicalPath);
      });
    flight = created;
    manifestFlights.set(canonicalPath, flight);
  }
  flight.refs += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      flight!.refs -= 1;
      if (flight!.refs === 0 && manifestFlights.get(canonicalPath) === flight) {
        manifestFlights.delete(canonicalPath);
        flight!.controller.abort();
      }
    };
    const onAbort = (): void => {
      release();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    flight!.promise.then(
      (manifest) => { if (!settled) { release(); resolve(manifest); } },
      (error) => { if (!settled) { release(); reject(error); } },
    );
  });
}
