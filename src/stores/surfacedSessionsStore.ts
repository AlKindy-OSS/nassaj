/**
 * Surfaced-sessions store (B-1431 / T-1949 client stage 2).
 *
 * `useProjectIndicatorSessionIds` closed the busy-DOT gap: a project's header
 * now lights up for a running/question/error/done/frozen session outside the
 * loaded page. But the ROW ITSELF still never appeared — the owner could see
 * "something is happening in this project" and have no session to click. This
 * store fetches (batched, debounced) the `{projectId, provider, session}`
 * context for exactly those off-page ids via `POST /api/projects/session-contexts`
 * (`server/modules/projects/projects.routes.ts`) and lets the render path fold
 * them into the visible list — see `computeSurfacedSessionsForProject` and its
 * caller in `useSidebarController.getSearchVisibleSessions`.
 *
 * Deliberately NOT written into a project's loaded buckets
 * (`Project.sessions*`): `useProjectsState`'s `countLoadedProjectSessions` —
 * and therefore the load-more `offset` — must stay blind to this store, or a
 * surfaced row would silently shift every later page.
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { SESSION_CONTEXT_ID_PATTERN } from '../../shared/sessionContextIds';
import { api } from '../utils/api';
import type { LLMProvider, Project } from '../types/app';
import type { SessionWithProvider } from '../components/sidebar/types/types';
import {
  deriveSessionRowIndicatorState,
  type SessionRowIndicatorState,
} from '../components/sidebar/view/subcomponents/sessionRowIndicatorState';

import {
  getOutcomeSessionIdsForProject,
  getSessionOutcome,
  subscribeSessionCompletion,
} from './sessionCompletionStore';
import {
  getProcessStateSessionIdsForProject,
  getSessionProcessState,
  isSessionProcessStateAuthoritative,
  subscribeSessionProcessState,
} from './sessionProcessStateStore';
import {
  getSessionWorkflows,
  getWorkflowSessionIdsForProject,
  subscribeWorkflowStatus,
} from './workflowStatusStore';

export type SurfacedContext = {
  projectId: string;
  provider: LLMProvider;
  session: SessionWithProvider;
};

const NEGATIVE_CACHE_TTL_MS = 30_000;
/** Cap enforced per project so one noisy project cannot flood a sidebar. */
export const SURFACED_SESSIONS_CAP = 10;
/**
 * Row-cap priority (owner decision, T-1949) — deliberately its own order, not
 * `deriveProjectIndicatorState`'s rollup priority: that one picks ONE dot for
 * a whole project, this one ranks INDIVIDUAL rows competing for the 10 slots,
 * and the owner asked for live states first ("a running conversation is more
 * worth a slot than a stale done").
 */
const SURFACED_ROW_PRIORITY: readonly SessionRowIndicatorState[] = [
  'question',
  'error',
  'running',
  'frozen',
  'done',
  'orphan',
];

type NegativeCacheEntry = { epoch: number; expiresAt: number };

let contextById = new Map<string, SurfacedContext>();
let negativeCacheById = new Map<string, NegativeCacheEntry>();
let identityEpoch = 0;
/**
 * T-1949 follow-up: the 60/min-per-user rate limit is shared across every
 * mount of the driver (and every tab), so this deadline must survive the
 * effect that fetches against it re-running. `projects_updated` fires roughly
 * every 500ms during a live run — that alone doesn't re-run the effect below
 * (`projects` is read via ref) EXCEPT that `projects` is also this effect's
 * own dep, so a fresh `projects` array reference re-inits it. A cooldown
 * living inside the effect got wiped on that very re-init, and `schedule()`
 * running once on mount fired again immediately — a 429 retry loop. Module
 * level, alongside `identityEpoch`, survives remounts; only an identity
 * change or the test reset below may clear it early.
 */
let cooldownUntil = 0;

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Raw subscription for callers outside React's useSyncExternalStore. */
export { subscribe as subscribeSurfacedSessions };

/** Tags an in-flight batch with the epoch its response must still match. */
export function getSurfacedSessionsIdentityEpoch(): number {
  return identityEpoch;
}

/** True while `sessionId` is a known negative (missing/invisible) and unexpired. */
export function isSurfacedSessionNegativeCached(sessionId: string): boolean {
  const entry = negativeCacheById.get(sessionId);
  if (!entry) return false;
  if (entry.epoch !== identityEpoch || entry.expiresAt <= Date.now()) {
    negativeCacheById.delete(sessionId);
    return false;
  }
  return true;
}

/**
 * Folds one batch response into the store. `requestedIds` is the full batch
 * that was sent — every id NOT present in `contexts` becomes a negative-cache
 * entry so the driver does not refetch it for `NEGATIVE_CACHE_TTL_MS`.
 *
 * `epoch` must match the CURRENT identity epoch or the response is dropped —
 * this is what makes the identity race safe: a response that arrives after
 * `auth:identity-changing` describes a different account's sessions and must
 * never populate the map (see `resetSurfacedSessionsStore`).
 */
export function applySurfacedSessionContexts(
  requestedIds: readonly string[],
  contexts: readonly SurfacedContext[],
  epoch: number,
): void {
  if (epoch !== identityEpoch) return;
  const foundIds = new Set(contexts.map((context) => context.session.id));
  let changed = false;
  for (const context of contexts) {
    contextById.set(context.session.id, context);
    negativeCacheById.delete(context.session.id);
    changed = true;
  }
  const expiresAt = Date.now() + NEGATIVE_CACHE_TTL_MS;
  for (const id of requestedIds) {
    if (!foundIds.has(id)) {
      negativeCacheById.set(id, { epoch, expiresAt });
      changed = true;
    }
  }
  if (changed) emitChange();
}

/** Called when an id's indicator state changes so a stale negative does not block it. */
export function invalidateSurfacedNegativeCache(sessionId: string): void {
  if (negativeCacheById.delete(sessionId)) emitChange();
}

/** Signature of the project-id set last handed to `pruneSurfacedContextsToProjects`. */
let lastActiveProjectIdsSignature: string | null = null;

function activeProjectIdsSignature(activeProjectIds: ReadonlySet<string>): string {
  return [...activeProjectIds].sort().join('\u0000');
}

/**
 * `projects_updated` (and `fetchProjects`, which covers `project_membership_
 * revoked`): a project can leave the visible list (archived, access revoked).
 * Its cached contexts are dropped, and — only when a project actually LEFT the
 * set — every negative-cache entry is dropped too (a negative entry carries no
 * per-project attribution, so a departure is the only safe trigger for a full
 * wipe; a project merely being ADDED never touches the negative cache — those
 * entries are left to expire on their own via `NEGATIVE_CACHE_TTL_MS` (30s) or
 * via `invalidateSurfacedNegativeCache`/`forgetSurfacedNegativeCache` once an
 * indicator store reports that id's state actually changed).
 *
 * `projects_updated` fires roughly every 500ms during a live run while the
 * project set itself rarely changes, so this is gated on a signature compare
 * first — without it, every broadcast wiped every persistent negative (an
 * orphan workflow, a session inside an archived-but-visible project, …) and
 * forced the driver to re-request it on the very next debounced cycle,
 * producing the request storm that tripped the 429 limiter.
 */
export function pruneSurfacedContextsToProjects(activeProjectIds: ReadonlySet<string>): void {
  const signature = activeProjectIdsSignature(activeProjectIds);
  if (signature === lastActiveProjectIdsSignature) return;
  lastActiveProjectIdsSignature = signature;

  let changed = false;
  let projectLeft = false;
  for (const [id, context] of contextById) {
    if (!activeProjectIds.has(context.projectId)) {
      contextById.delete(id);
      changed = true;
      projectLeft = true;
    }
  }
  if (projectLeft && negativeCacheById.size > 0) {
    negativeCacheById = new Map();
    changed = true;
  }
  if (changed) emitChange();
}

/** `session_created`: a brand-new session cannot be a stale negative. */
export function forgetSurfacedNegativeCache(sessionId: string): void {
  invalidateSurfacedNegativeCache(sessionId);
}

/** Clears every account-derived context and invalidates in-flight batches. */
export function resetSurfacedSessionsStore(): void {
  identityEpoch += 1;
  lastActiveProjectIdsSignature = null;
  cooldownUntil = 0;
  if (contextById.size === 0 && negativeCacheById.size === 0) return;
  contextById = new Map();
  negativeCacheById = new Map();
  emitChange();
}

if (typeof window !== 'undefined') {
  window.addEventListener('auth:identity-changing', resetSurfacedSessionsStore);
}

/** Test-only escape hatch; production code never needs a full reset mid-run. */
export function __resetSurfacedSessionsStoreForTests(): void {
  identityEpoch = 0;
  contextById = new Map();
  negativeCacheById = new Map();
  lastActiveProjectIdsSignature = null;
  cooldownUntil = 0;
}

// ---------------------------------------------------------------------------
// Selection (render path)
// ---------------------------------------------------------------------------

function rowState(sessionId: string): SessionRowIndicatorState | null {
  const processState = isSessionProcessStateAuthoritative(sessionId)
    ? getSessionProcessState(sessionId)
    : null;
  const outcome = getSessionOutcome(sessionId);
  const workflows = getSessionWorkflows(sessionId);
  const hasRunningWorkflow = workflows.some((workflow) => workflow.status === 'running');
  const hasOrphanWorkflow = workflows.some((workflow) => workflow.status === 'orphan');
  return deriveSessionRowIndicatorState(processState, outcome, hasRunningWorkflow, hasOrphanWorkflow);
}

export type SurfacedSessionsSelection = {
  /** Sessions to fold into the rendered list, capped and indicator-gated. */
  sessions: SessionWithProvider[];
  /** Sessions that missed the cap — the "+N" hint's count. */
  hiddenCount: number;
};

const EMPTY_SELECTION: SurfacedSessionsSelection = Object.freeze({ sessions: [], hiddenCount: 0 });

/**
 * Non-reactive: this project's surfaced rows for the current render.
 *
 * A candidate id survives only while an indicator store still attributes it
 * to `projectId` (or it is `selectedSessionId` — a row the owner is reading
 * does not vanish out from under them the instant its indicator clears). Ids
 * already in `loadedIds` are excluded: the loaded copy always wins, and the
 * caller decides that at the union/dedup step, not here.
 */
export function computeSurfacedSessionsForProject(
  projectId: string | null,
  loadedIds: ReadonlySet<string>,
  selectedSessionId: string | null,
): SurfacedSessionsSelection {
  if (!projectId) return EMPTY_SELECTION;

  const candidateIds = new Set<string>([
    ...getProcessStateSessionIdsForProject(projectId),
    ...getOutcomeSessionIdsForProject(projectId),
    ...getWorkflowSessionIdsForProject(projectId),
  ]);
  const selectedContext = selectedSessionId ? contextById.get(selectedSessionId) : undefined;
  if (selectedContext && selectedContext.projectId === projectId && !loadedIds.has(selectedSessionId as string)) {
    candidateIds.add(selectedSessionId as string);
  }

  type Row = { session: SessionWithProvider; state: SessionRowIndicatorState | null };
  const selectedRow: Row[] = [];
  const otherRows: Row[] = [];

  for (const id of candidateIds) {
    if (loadedIds.has(id)) continue;
    const context = contextById.get(id);
    if (!context || context.projectId !== projectId) continue;

    const state = rowState(id);
    const isSelected = id === selectedSessionId;
    if (!state && !isSelected) continue; // indicator cleared, not the open row → drop

    const session: SessionWithProvider = {
      ...context.session,
      __provider: context.provider,
      __surfaced: true,
    };
    (isSelected ? selectedRow : otherRows).push({ session, state });
  }

  otherRows.sort((a, b) => {
    const priorityA = a.state ? SURFACED_ROW_PRIORITY.indexOf(a.state) : SURFACED_ROW_PRIORITY.length;
    const priorityB = b.state ? SURFACED_ROW_PRIORITY.indexOf(b.state) : SURFACED_ROW_PRIORITY.length;
    return priorityA - priorityB;
  });

  const budget = Math.max(0, SURFACED_SESSIONS_CAP - selectedRow.length);
  const kept = otherRows.slice(0, budget);
  const hiddenCount = otherRows.length - kept.length;

  return {
    sessions: [...selectedRow, ...kept].map((row) => row.session),
    hiddenCount,
  };
}

/**
 * Forces a re-render of whatever reads `computeSurfacedSessionsForProject`
 * whenever this store OR any of the three indicator stores it reads from
 * changes — those stores decide candidate membership just as much as this one
 * decides content, so a consumer subscribed only to this store would miss an
 * indicator clearing/appearing.
 */
export function useSurfacedSessionsRenderTick(): number {
  const generationRef = useRef(0);
  const subscribeAll = useCallback((listener: () => void) => {
    const bump = () => {
      generationRef.current += 1;
      listener();
    };
    const unsubSurfaced = subscribe(bump);
    const unsubProcess = subscribeSessionProcessState(bump);
    const unsubOutcome = subscribeSessionCompletion(bump);
    const unsubWorkflow = subscribeWorkflowStatus(bump);
    return () => {
      unsubSurfaced();
      unsubProcess();
      unsubOutcome();
      unsubWorkflow();
    };
  }, []);
  return useSyncExternalStore(subscribeAll, () => generationRef.current);
}

// ---------------------------------------------------------------------------
// Driver (fetch path)
// ---------------------------------------------------------------------------

const FETCH_DEBOUNCE_MS = 250;
const MAX_IDS_PER_BATCH = 50;
/** T-1949: how long a 429/non-OK batch response parks further fetches for. */
export const RATE_LIMIT_COOLDOWN_MS = 15_000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** One project's loaded ids, read straight off its provider buckets. */
function loadedIdsForProject(project: Project, bucketKeys: readonly string[]): Set<string> {
  const record = project as unknown as Record<string, Array<{ id: string }> | undefined>;
  const ids = new Set<string>();
  for (const key of bucketKeys) {
    const bucket = record[key];
    if (!bucket) continue;
    for (const session of bucket) ids.add(session.id);
  }
  return ids;
}

/**
 * Pure: the ids this project would like the driver to fetch context for —
 * indicator ids minus the loaded page minus a live negative cache. Exported
 * so "collapsed projects not fetched" and the identity-race case are
 * testable without mounting the hook.
 */
export function collectWantedSurfacedSessionIds(
  projects: readonly Project[],
  expandedProjectIds: ReadonlySet<string>,
  bucketKeys: readonly string[],
  lastStateById: Map<string, SessionRowIndicatorState | null>,
): string[] {
  const wanted = new Set<string>();
  for (const project of projects) {
    if (!expandedProjectIds.has(project.projectId)) continue;
    const loaded = loadedIdsForProject(project, bucketKeys);
    const candidateIds = new Set<string>([
      ...getProcessStateSessionIdsForProject(project.projectId),
      ...getOutcomeSessionIdsForProject(project.projectId),
      ...getWorkflowSessionIdsForProject(project.projectId),
    ]);
    for (const id of candidateIds) {
      if (loaded.has(id)) continue;
      // T-1949: the server 400s the WHOLE batch on one malformed id (see
      // `SESSION_CONTEXT_ID_PATTERN` in shared/sessionContextIds.ts, mirrored
      // by the server's own `parseSessionContextIds`) — never let one
      // odd-shaped candidate from an indicator store take every other id in
      // the batch down with it.
      if (!SESSION_CONTEXT_ID_PATTERN.test(id)) continue;
      const currentState = rowState(id);
      if (lastStateById.get(id) !== currentState) {
        lastStateById.set(id, currentState);
        invalidateSurfacedNegativeCache(id);
      }
      if (contextById.has(id)) continue;
      if (isSurfacedSessionNegativeCached(id)) continue;
      wanted.add(id);
    }
  }
  return [...wanted];
}

/**
 * Mounted once (one active `<Sidebar>` at a time — desktop/mobile are
 * mutually exclusive in `AppContent`). Debounces batches of up to
 * `MAX_IDS_PER_BATCH` ids through `POST /api/projects/session-contexts`
 * whenever an indicator store changes or the expanded-project set changes,
 * and drops any response whose epoch no longer matches the current identity.
 */
export function useSurfacedSessionsDriver(
  projects: readonly Project[],
  expandedProjectIds: ReadonlySet<string>,
  bucketKeys: readonly string[],
): void {
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const expandedRef = useRef(expandedProjectIds);
  expandedRef.current = expandedProjectIds;
  const lastStateByIdRef = useRef(new Map<string, SessionRowIndicatorState | null>());

  useEffect(() => {
    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    // T-1949: a 429 (or any non-OK response) parks every batch until the
    // module-level `cooldownUntil` deadline instead of retrying on the very
    // next debounced cycle — the limiter is 60/min PER USER, SHARED ACROSS
    // TABS, so a single sidebar hammering it on every `projects_updated`
    // (~every 500ms during a live run) is a tight retry loop that only makes
    // the 429s worse. `cooldownUntil` deliberately lives at module scope, not
    // as a local here: `projects` is both read via ref AND this effect's own
    // dep, so a fresh `projects` array reference re-inits this whole effect,
    // and a local would reset to 0 on every one of those re-inits.

    const runFetch = () => {
      if (disposed) return;
      if (Date.now() < cooldownUntil) return;
      const epoch = getSurfacedSessionsIdentityEpoch();
      const wanted = collectWantedSurfacedSessionIds(
        projectsRef.current,
        expandedRef.current,
        bucketKeys,
        lastStateByIdRef.current,
      );
      if (wanted.length === 0) return;

      controller?.abort();
      controller = new AbortController();
      const activeController = controller;

      for (const ids of chunk(wanted, MAX_IDS_PER_BATCH)) {
        void api
          .sessionContexts(ids, { signal: activeController.signal })
          .then((response: Response) => {
            if (!response.ok) {
              cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
              return null;
            }
            return response.json();
          })
          .then((data: { contexts?: SurfacedContext[] } | null) => {
            if (disposed || activeController.signal.aborted || !data) return;
            applySurfacedSessionContexts(ids, data.contexts ?? [], epoch);
          })
          .catch(() => {
            // Network/abort error — no negative-cache entry, and the cooldown
            // above keeps the next debounced cycle from immediately retrying.
          });
      }
    };

    const schedule = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runFetch, FETCH_DEBOUNCE_MS);
    };

    const unsubProcess = subscribeSessionProcessState(schedule);
    const unsubOutcome = subscribeSessionCompletion(schedule);
    const unsubWorkflow = subscribeWorkflowStatus(schedule);
    const unsubSurfaced = subscribe(schedule);
    schedule();

    return () => {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      controller?.abort();
      unsubProcess();
      unsubOutcome();
      unsubWorkflow();
      unsubSurfaced();
    };
    // projects/expandedProjectIds are read via refs; only re-arm on identity
    // of the expanded Set/array changing.
  }, [projects, expandedProjectIds, bucketKeys]);
}
