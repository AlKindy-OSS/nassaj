import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

export type CodexSpawn = {
  callId: string | null;
  taskName: string;
  linkKind: 'legacy' | 'direct' | 'custom';
  agentPath: string | null;
  agentThreadId: string | null;
  childRolloutPath: string | null;
  occurredAtMs: number | null;
};

export type CodexRolloutMetadata = {
  /** Distinct models observed in this rollout, ordered by first use. */
  models: string[];
  model: string | null;
  threadId: string | null;
  sessionId: string | null;
  parentThreadId: string | null;
  threadSource: string | null;
  sourceIsSubagent: boolean;
  agentPath: string | null;
  /** Role declared by this rollout's own session metadata. */
  agentRole: string | null;
  spawns: CodexSpawn[];
  /** False when the same open file descriptor changed during the metadata pass. */
  snapshotStable: boolean;
  snapshotSize: number;
  snapshotMtimeMs: number;
};

export type CodexRolloutFile = {
  rolloutPath: string;
  model: string | null;
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
      if (insideSessionsRoot && path.dirname(realCandidate) === realDirectory) return realCandidate;
    }
  } catch {
    signal?.throwIfAborted();
    return null;
  }
  return null;
}

/** Reads only Codex-native actor/link fields from one rollout. */
export async function readCodexRolloutMetadata(
  rolloutPath: string,
  signal?: AbortSignal,
): Promise<CodexRolloutMetadata> {
  return withCodexRolloutRead(signal, async () => {
  let model: string | null = null;
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

  const handle = await open(rolloutPath, 'r');
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
      const payload = isRecord(entry.payload) ? entry.payload : null;
      if (!payload) continue;

      // A forked child may embed the parent's historical session_meta after its
      // own first line. The first session_meta is the identity of THIS file.
      if (entry.type === 'session_meta' && threadId === null) {
        threadId = validThreadId(payload.id) ? payload.id : threadId;
        sessionId = validThreadId(payload.session_id) ? payload.session_id : sessionId;
        parentThreadId = validThreadId(payload.parent_thread_id) ? payload.parent_thread_id : parentThreadId;
        threadSource = typeof payload.thread_source === 'string' ? payload.thread_source : threadSource;
        sourceIsSubagent = isRecord(payload.source) && 'subagent' in payload.source;
        ownAgentPath = typeof payload.agent_path === 'string' ? payload.agent_path : ownAgentPath;
        agentRole = readAgentRole(payload);
      }

      if (typeof payload.model === 'string' && payload.model) {
        model = payload.model;
        if (!modelsSeen.has(payload.model)) {
          modelsSeen.add(payload.model);
          models.push(payload.model);
        }
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
    await handle.close().catch(() => undefined);
  }

  const spawns: CodexSpawn[] = started.map((spawn) => ({
    ...spawn,
    childRolloutPath: null,
  }));

  return {
    models,
    model,
    threadId,
    sessionId,
    parentThreadId,
    threadSource,
    sourceIsSubagent,
    agentPath: ownAgentPath,
    agentRole,
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
  spawn: CodexSpawn;
};

/** Follows explicit parent→thread links recursively, never scanning unrelated days/users. */
async function buildCodexRolloutManifest(
  rootRolloutPath: string,
  signal?: AbortSignal,
  afterMetadata?: () => Promise<void> | void,
): Promise<CodexRolloutManifest> {
  const root = await readCodexRolloutMetadata(rootRolloutPath, signal);
  const linked: CodexLinkedRollout[] = [];
  const spawns: CodexSpawn[] = [];
  const visitedPaths = new Set([rootRolloutPath]);
  const metadataByPath = new Map<string, CodexRolloutMetadata>([[rootRolloutPath, root]]);

  const rootSessionId = root.sessionId ?? root.threadId;
  // These are safeguards against a malformed/cyclic transcript consuming the
  // server indefinitely. They deliberately exceed normal fan-out; hitting one
  // is returned to callers, never converted into a silently partial tree.
  const MAX_DEPTH = 64;
  const MAX_NODES = 4_096;
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
    const rootStat = await stat(rootRolloutPath);
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
        model: root.model,
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
      const legacyPathValid = spawn.linkKind !== 'legacy' || Boolean(
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
      linked.push({ rolloutPath: childPath, model: child.model, spawn });
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
    model: metadata.model,
    size: metadata.snapshotSize,
    mtimeMs: metadata.snapshotMtimeMs,
  }));
  const changedAfterMetadata = await Promise.all(files.map(async (file) => {
    signal?.throwIfAborted();
    const current = await stat(file.rolloutPath).catch(() => null);
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

/** Canonical-path singleflight; one caller leaving does not cancel remaining readers. */
export async function resolveCodexLinkedRollouts(
  rootRolloutPath: string,
  signal?: AbortSignal,
  /** Deterministic race seam for unit tests; production callers omit it. */
  afterMetadata?: () => Promise<void> | void,
): Promise<CodexRolloutManifest> {
  const canonicalPath = await realpath(rootRolloutPath);
  signal?.throwIfAborted();
  if (afterMetadata) return buildCodexRolloutManifest(canonicalPath, signal, afterMetadata);
  let flight = manifestFlights.get(canonicalPath);
  if (!flight) {
    const controller = new AbortController();
    const created = { controller, refs: 0 } as ManifestFlight;
    created.promise = buildCodexRolloutManifest(canonicalPath, controller.signal)
      .finally(() => {
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
