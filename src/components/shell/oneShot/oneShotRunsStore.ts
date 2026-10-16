/**
 * T-2037 — browser-local registry of composer one-shot shell runs.
 *
 * Three responsibilities, all module-level so the composer (chat tab) and the
 * Shell tab can talk without a shared React parent:
 *
 *  1. A single pending REQUEST: the composer, after the risk confirm, asks for a
 *     run; MainContent (which owns the selected project and the tab switch)
 *     consumes it. `startOneShotRun` — the only place a runId is minted — is
 *     called from that consumer and nowhere else, so every new runId traces back
 *     to an explicit, confirmed user submit.
 *  2. The last runs per user+project (localStorage, newest first, capped, 30 min
 *     TTL, wiped on sign-out). Only runs started in THIS page lifetime are
 *     "live" and may mount a shell; anything restored from storage is a static
 *     entry. The command text goes out once: `claimOneShotLaunch` hands the
 *     launch to the first init only, every later init is attach-only.
 *     [qa critical-1: no stale replay after a reload, restart or user switch.]
 *  3. Output capture: the mounted shell of a run registers a sender; the run
 *     strip asks for the capture and awaits the matching `oneshot_capture` frame.
 */
import { useSyncExternalStore } from 'react';

export const MAX_ONESHOT_RUNS = 5;
export const CAPTURE_TIMEOUT_MS = 10_000;
/** Stored runs older than this are dropped on load (server lifetime cap). */
export const ONESHOT_RUN_TTL_MS = 30 * 60_000;
const STORAGE_PREFIX = 'nassaj.oneShotRuns.v1:';

/** Storage/registry key: runs are scoped to the signed-in user AND the project. */
export function oneShotRunsKey(userId: string | number | null | undefined, projectId: string | null | undefined): string | null {
  if (userId === null || userId === undefined || userId === '' || !projectId) return null;
  return `${String(userId)}:${projectId}`;
}

/**
 * `finished` is reserved for a real numeric exit code. `interrupted` (cut short,
 * completion unknown) and `unknown` (no record of running) must never read as
 * success (qa round 3).
 */
export type OneShotRunStatus = 'running' | 'finished' | 'interrupted' | 'unknown' | 'refused';
const RUN_STATUSES: readonly OneShotRunStatus[] = ['running', 'finished', 'interrupted', 'unknown', 'refused'];

export interface OneShotRun {
  runId: string;
  command: string;
  startedAt: number;
  status: OneShotRunStatus;
  exitCode: number | null;
  refusalCode: string | null;
}

export interface OneShotRequest {
  id: number;
  command: string;
}

export interface OneShotCapture {
  text: string;
  truncated: boolean;
  exitCode: number | null;
}

interface ProjectRuns {
  runs: readonly OneShotRun[];
  /** null = the agent's interactive CLI entry is shown. */
  activeRunId: string | null;
}

type Listener = () => void;

const EMPTY_PROJECT: ProjectRuns = Object.freeze({ runs: Object.freeze([]), activeRunId: null });
const listeners = new Set<Listener>();
const byProject = new Map<string, ProjectRuns>();
let pendingRequest: OneShotRequest | null = null;
let nextRequestId = 1;
/** Runs started in this page lifetime (in memory only, never persisted). */
const liveRunIds = new Set<string>();
/** Live runs whose single launching init has not been sent yet. */
const unlaunchedRunIds = new Set<string>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isRun(value: unknown): value is OneShotRun {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.runId === 'string' &&
    v.runId.length > 0 &&
    typeof v.command === 'string' &&
    typeof v.startedAt === 'number' &&
    RUN_STATUSES.includes(v.status as OneShotRunStatus)
  );
}

function readStored(projectKey: string): readonly OneShotRun[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + projectKey);
    if (!raw) return EMPTY_PROJECT.runs;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY_PROJECT.runs;
    const cutoff = Date.now() - ONESHOT_RUN_TTL_MS;
    return parsed
      .filter(isRun)
      .filter((run) => run.startedAt >= cutoff)
      .map((run) => ({
        ...run,
        exitCode: typeof run.exitCode === 'number' ? run.exitCode : null,
        refusalCode: typeof run.refusalCode === 'string' ? run.refusalCode : null,
      }))
      .slice(0, MAX_ONESHOT_RUNS);
  } catch {
    return EMPTY_PROJECT.runs;
  }
}

function writeStored(projectKey: string, runs: readonly OneShotRun[]): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + projectKey, JSON.stringify(runs));
  } catch {
    // Storage full or disabled: the in-memory list still works for this tab.
  }
}

function getProject(projectKey: string): ProjectRuns {
  let entry = byProject.get(projectKey);
  if (!entry) {
    entry = { runs: readStored(projectKey), activeRunId: null };
    byProject.set(projectKey, entry);
  }
  return entry;
}

function setProject(projectKey: string, next: ProjectRuns, persist: boolean): void {
  byProject.set(projectKey, next);
  if (persist) writeStored(projectKey, next.runs);
  emit();
}

function updateRun(
  projectKey: string,
  runId: string,
  patch: Partial<Pick<OneShotRun, 'status' | 'exitCode' | 'refusalCode'>>,
): void {
  const current = getProject(projectKey);
  if (!current.runs.some((run) => run.runId === runId)) return;
  const runs = current.runs.map((run) => (run.runId === runId ? { ...run, ...patch } : run));
  setProject(projectKey, { ...current, runs }, true);
}

/** Composer side: ask for a run of an already-confirmed command. */
export function requestOneShotRun(command: string): OneShotRequest | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  pendingRequest = { id: nextRequestId++, command: trimmed };
  emit();
  return pendingRequest;
}

/** Takes the pending request (at most once). */
export function consumeOneShotRequest(): OneShotRequest | null {
  const request = pendingRequest;
  if (!request) return null;
  pendingRequest = null;
  emit();
  return request;
}

function getPendingRequest(): OneShotRequest | null {
  return pendingRequest;
}

/** React view of the pending request. */
export function usePendingOneShotRequest(): OneShotRequest | null {
  return useSyncExternalStore(subscribe, getPendingRequest, getPendingRequest);
}

/**
 * Mints a runId and records the run as the project's active one. The ONLY
 * caller is the consumer of a composer request (MainContent).
 */
export function startOneShotRun(projectKey: string, command: string): OneShotRun {
  const run: OneShotRun = {
    runId: crypto.randomUUID(),
    command,
    startedAt: Date.now(),
    status: 'running',
    exitCode: null,
    refusalCode: null,
  };
  liveRunIds.add(run.runId);
  unlaunchedRunIds.add(run.runId);
  const current = getProject(projectKey);
  const runs = [run, ...current.runs].slice(0, MAX_ONESHOT_RUNS);
  setProject(projectKey, { runs, activeRunId: run.runId }, true);
  return run;
}

/** Whether the run was started in this page lifetime (may mount a shell). */
export function isLiveOneShotRun(runId: string): boolean {
  return liveRunIds.has(runId);
}

/**
 * True exactly once per live run: the caller may send the command with that
 * init. Every other init for the run must be attach-only.
 */
export function claimOneShotLaunch(runId: string): boolean {
  return unlaunchedRunIds.delete(runId);
}

/** Sign-out: forget every user's stored runs on this browser, and all state. */
export function clearOneShotRunsStorage(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing persisted to clear.
  }
  byProject.clear();
  pendingRequest = null;
  liveRunIds.clear();
  unlaunchedRunIds.clear();
  emit();
}

/** Shows a run (or, with null, the agent's interactive CLI) in the Shell tab. */
export function selectOneShotRun(projectKey: string, runId: string | null): void {
  const current = getProject(projectKey);
  if (runId !== null && !current.runs.some((run) => run.runId === runId)) return;
  if (current.activeRunId === runId) return;
  setProject(projectKey, { ...current, activeRunId: runId }, false);
}

export interface OneShotOutcome {
  exitCode: number | null;
  interrupted?: boolean;
  unknown?: boolean;
  refused?: boolean;
}

/** Terminal state of a `oneshot_finished` frame: only a numeric exit is `finished`. */
export function outcomeStatus(outcome: OneShotOutcome): OneShotRunStatus {
  if (outcome.refused) return 'refused';
  if (outcome.interrupted) return 'interrupted';
  if (outcome.unknown || typeof outcome.exitCode !== 'number') return 'unknown';
  return 'finished';
}

export function markOneShotFinished(projectKey: string, runId: string, outcome: OneShotOutcome): void {
  const status = outcomeStatus(outcome);
  updateRun(projectKey, runId, {
    status,
    exitCode: status === 'finished' ? outcome.exitCode : null,
  });
}

export function markOneShotRefused(projectKey: string, runId: string, refusalCode: string): void {
  updateRun(projectKey, runId, { status: 'refused', refusalCode });
}

/** React view of one project's runs and the active selection. */
export function useOneShotRuns(projectKey: string | null): ProjectRuns {
  const read = () => (projectKey ? getProject(projectKey) : EMPTY_PROJECT);
  return useSyncExternalStore(subscribe, read, read);
}

// ── Capture ─────────────────────────────────────────────────────────────────

type CaptureSender = () => boolean;
const captureSenders = new Map<string, CaptureSender>();
const captureWaiters = new Map<string, Array<(capture: OneShotCapture | null) => void>>();

/**
 * Registered by the mounted shell of a run; `send` writes the capture request on
 * its socket and reports whether it could. Returns the unregister function.
 */
export function registerOneShotCaptureSender(runId: string, send: CaptureSender): () => void {
  captureSenders.set(runId, send);
  emit();
  return () => {
    if (captureSenders.get(runId) === send) {
      captureSenders.delete(runId);
      emit();
    }
  };
}

function getCaptureSenderCount(): number {
  return captureSenders.size;
}

/** Whether a mounted shell can currently answer a capture for this run. */
export function useCanCaptureOneShot(runId: string | null): boolean {
  useSyncExternalStore(subscribe, getCaptureSenderCount, getCaptureSenderCount);
  return runId !== null && captureSenders.has(runId);
}

function settleCapture(runId: string, capture: OneShotCapture | null): void {
  const waiters = captureWaiters.get(runId);
  if (!waiters) return;
  captureWaiters.delete(runId);
  for (const resolve of waiters) resolve(capture);
}

/** Called with every `oneshot_capture` frame of a run (null = unavailable). */
export function resolveOneShotCapture(runId: string, capture: OneShotCapture | null): void {
  settleCapture(runId, capture);
}

/**
 * Requests the run's captured output. Resolves null when no shell can be asked
 * or the server does not answer within CAPTURE_TIMEOUT_MS.
 */
export function requestOneShotCapture(runId: string): Promise<OneShotCapture | null> {
  const send = captureSenders.get(runId);
  if (!send) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => settleCapture(runId, null), CAPTURE_TIMEOUT_MS);
    const waiters = captureWaiters.get(runId) ?? [];
    waiters.push((capture) => {
      window.clearTimeout(timer);
      resolve(capture);
    });
    captureWaiters.set(runId, waiters);
    if (!send()) settleCapture(runId, null);
  });
}

/** Test helper: forgets every run, request, sender and waiter. */
export function resetOneShotRunsForTests(): void {
  byProject.clear();
  pendingRequest = null;
  liveRunIds.clear();
  unlaunchedRunIds.clear();
  captureSenders.clear();
  for (const runId of [...captureWaiters.keys()]) settleCapture(runId, null);
  emit();
}
