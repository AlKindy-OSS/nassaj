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
/**
 * T-1951 qa-critic fix: ids whose indicator state transitioned and therefore
 * need a fresh fetch, but whose OLD context is deliberately kept in
 * `contextById` (stale-while-revalidate) until that fetch resolves — deleting
 * it eagerly made the row (including the SELECTED session, exempt only from
 * the separate prune loop below) vanish for the length of one fetch cycle
 * (250ms debounce, up to `RATE_LIMIT_COOLDOWN_MS` under a 429). Cleared by
 * `applySurfacedSessionContexts` once the fetch it was waiting on lands.
 */
let staleIds = new Set<string>();
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
    // The fetch this id was staled-and-waiting-for has now landed (found,
    // negative, or dropped) — the stale mark's only job was to force it back
    // into `wanted` despite an already-resolved (soon to be replaced) context.
    staleIds.delete(id);
    if (!foundIds.has(id)) {
      negativeCacheById.set(id, { epoch, expiresAt });
      contextById.delete(id);
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
      staleIds.delete(id);
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
  staleIds = new Set();
  if (contextById.size === 0 && negativeCacheById.size === 0) return;
  contextById = new Map();
  negativeCacheById = new Map();
  emitChange();
}

if (typeof window !== 'undefined') {
  window.addEventListener('auth:identity-changing', resetSurfacedSessionsStore);
}

/** Test-only: current context ids, to assert refresh/prune behaviour (T-1951) without a live fetch. */
export function __getSurfacedContextIdsForTests(): string[] {
  return [...contextById.keys()];
}

/** Test-only escape hatch; production code never needs a full reset mid-run. */
export function __resetSurfacedSessionsStoreForTests(): void {
  identityEpoch = 0;
  contextById = new Map();
  negativeCacheById = new Map();
  staleIds = new Set();
  lastActiveProjectIdsSignature = null;
  cooldownUntil = 0;
}

/** Test-only: whether `sessionId` is currently held stale-while-revalidate (T-1951). */
export function __isSurfacedContextStaleForTests(sessionId: string): boolean {
  return staleIds.has(sessionId);
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
 * Sorted signature of the surfaced ROW candidates (id + indicator state) for
 * one project — `id` alone would miss a re-rank (state changing priority),
 * `state` alone would miss a candidate entering/leaving.
 *
 * A state-less context is NOT dropped here (qa-critic T-1951 fix): a null
 * state still renders a row when the candidate is the SELECTED session (see
 * `computeSurfacedSessionsForProject`'s own `!state && !isSelected` check),
 * and this signature must change when that row's context is replaced even
 * though its state stays `null` throughout — hence the literal `-` marker
 * instead of skipping the id outright.
 */
function computeSurfacedRowSignatureForProject(projectId: string): string {
  const candidateIds = new Set<string>([
    ...getProcessStateSessionIdsForProject(projectId),
    ...getOutcomeSessionIdsForProject(projectId),
    ...getWorkflowSessionIdsForProject(projectId),
  ]);
  const parts: string[] = [];
  for (const id of candidateIds) {
    const context = contextById.get(id);
    if (!context || context.projectId !== projectId) continue;
    const state = rowState(id);
    parts.push(`${id}:${state ?? '-'}`);
  }
  return parts.sort().join(',');
}

/**
 * T-1951 (B-1431/T-1949 follow-up): `useSurfacedSessionsRenderTick` bumped on
 * EVERY emit of the four stores it read — including a workflow's `callCount`
 * ticking up on an otherwise-unchanged run — forcing the whole sidebar
 * controller (and therefore `computeSurfacedSessionsForProject` + its sort,
 * for every project, including collapsed ones) to re-render on a change no
 * row ever displays.
 *
 * This returns a primitive signature (`useSyncExternalStore`'s Object.is check
 * is then a cheap string compare) built ONLY from the currently EXPANDED
 * projects — a collapsed project's rows are not rendered, so a change inside
 * one must not cost a re-render either. `expandedProjectIds` is read through a
 * ref so the subscription itself never needs to re-arm when the expanded set
 * changes; the signature simply recomputes against the latest set the next
 * time any of the four stores emits (and once more on the render this hook's
 * own caller triggers when `expandedProjectIds` itself changes, same as any
 * other prop).
 */
export function useSurfacedSessionsSignature(expandedProjectIds: ReadonlySet<string>): string {
  const expandedRef = useRef(expandedProjectIds);
  expandedRef.current = expandedProjectIds;

  const subscribeAll = useCallback((listener: () => void) => {
    const unsubSurfaced = subscribe(listener);
    const unsubProcess = subscribeSessionProcessState(listener);
    const unsubOutcome = subscribeSessionCompletion(listener);
    const unsubWorkflow = subscribeWorkflowStatus(listener);
    return () => {
      unsubSurfaced();
      unsubProcess();
      unsubOutcome();
      unsubWorkflow();
    };
  }, []);

  const getSnapshot = useCallback(() => {
    const parts: string[] = [];
    for (const projectId of [...expandedRef.current].sort()) {
      parts.push(`${projectId}=${computeSurfacedRowSignatureForProject(projectId)}`);
    }
    return parts.join('|');
  }, []);

  return useSyncExternalStore(subscribeAll, getSnapshot);
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
 *
 * Also owns two pieces of `contextById` upkeep the driver used to skip
 * entirely (T-1951):
 *  - a candidate whose indicator state TRANSITIONS (not its first sighting —
 *    `lastStateById` must already hold a prior value) is marked STALE and put
 *    back into `wanted` so the next batch refreshes title/last-activity —
 *    but its existing context is deliberately kept in `contextById` (not
 *    deleted) until that batch resolves: a qa-critic fix, since evicting it
 *    eagerly made the row (including a SELECTED session) vanish for a whole
 *    fetch cycle. See `staleIds` and `applySurfacedSessionContexts`.
 *  - a context this project's indicator stores no longer name as a candidate
 *    is dropped (bounded memory for long-lived tabs), and its `lastStateById`
 *    / `staleIds` entries are dropped alongside it so neither map grows
 *    unbounded for a long-lived tab — `selectedSessionId` is exempt from all
 *    three, mirroring `computeSurfacedSessionsForProject`'s own rule that a
 *    row the owner is reading must not vanish the instant its indicator
 *    clears.
 */
export function collectWantedSurfacedSessionIds(
  projects: readonly Project[],
  expandedProjectIds: ReadonlySet<string>,
  bucketKeys: readonly string[],
  lastStateById: Map<string, SessionRowIndicatorState | null>,
  selectedSessionId: string | null = null,
): string[] {
  const wanted = new Set<string>();
  let contextChanged = false;
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
      const hadPriorState = lastStateById.has(id);
      if (lastStateById.get(id) !== currentState) {
        lastStateById.set(id, currentState);
        invalidateSurfacedNegativeCache(id);
        // Only a real TRANSITION marks the context stale — the first time an
        // id is ever seen (`hadPriorState` false) must not stale a context
        // `applySurfacedSessionContexts` already resolved moments earlier.
        // The context itself is kept (stale-while-revalidate): deleting it
        // here made the row disappear for the length of the refetch, even
        // for the SELECTED session (qa-critic T-1951 fix).
        if (hadPriorState && contextById.has(id)) {
          staleIds.add(id);
        }
      }
      // A fresh (non-stale) context already answers this id — nothing to
      // fetch. A stale one still counts as "resolved" for negative-cache
      // purposes (it is not missing, just due for a refresh), so only the
      // freshness check gates re-fetching, not the negative cache.
      if (contextById.has(id) && !staleIds.has(id)) continue;
      if (!staleIds.has(id) && isSurfacedSessionNegativeCached(id)) continue;
      wanted.add(id);
    }

    for (const [id, context] of contextById) {
      if (context.projectId !== project.projectId) continue;
      if (candidateIds.has(id)) continue;
      if (id === selectedSessionId) continue;
      contextById.delete(id);
      staleIds.delete(id);
      lastStateById.delete(id);
      contextChanged = true;
    }
  }
  if (contextChanged) emitChange();
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
  selectedSessionId: string | null = null,
): void {
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const expandedRef = useRef(expandedProjectIds);
  expandedRef.current = expandedProjectIds;
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const lastStateByIdRef = useRef(new Map<string, SessionRowIndicatorState | null>());

  useEffect(() => {
    let disposed = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cooldownRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
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

    const clearCooldownRecoveryTimer = () => {
      if (cooldownRecoveryTimer) {
        clearTimeout(cooldownRecoveryTimer);
        cooldownRecoveryTimer = null;
      }
    };

    // T-1951: a 429 used to sit silent until the NEXT indicator event
    // rearmed `schedule()` — on a quiet project that could be minutes away.
    // This arms one single follow-up fetch for the moment the cooldown itself
    // elapses, so recovery does not depend on unrelated activity elsewhere.
    const scheduleCooldownRecovery = () => {
      clearCooldownRecoveryTimer();
      const delay = Math.max(0, cooldownUntil - Date.now());
      cooldownRecoveryTimer = setTimeout(() => {
        cooldownRecoveryTimer = null;
        runFetch();
      }, delay);
    };

    const runFetch = () => {
      if (disposed) return;
      if (Date.now() < cooldownUntil) {
        // qa-critic T-1951 fix: this effect can re-init mid-cooldown (a fresh
        // `projects` array reference, per the comment above) — the OLD
        // effect's cleanup already cleared ITS `cooldownRecoveryTimer`, and
        // this NEW effect's own `schedule()` call on mount lands here and
        // used to just bail, leaving nothing armed to ever re-check
        // `cooldownUntil` again until unrelated indicator activity happened
        // to fire `schedule()` a second time. Re-arm on every early return so
        // recovery survives an arbitrary number of re-inits during one
        // cooldown window.
        scheduleCooldownRecovery();
        return;
      }
      const epoch = getSurfacedSessionsIdentityEpoch();
      const wanted = collectWantedSurfacedSessionIds(
        projectsRef.current,
        expandedRef.current,
        bucketKeys,
        lastStateByIdRef.current,
        selectedSessionIdRef.current,
      );
      if (wanted.length === 0) return;

      controller?.abort();
      controller = new AbortController();
      const activeController = controller;

      for (const ids of chunk(wanted, MAX_IDS_PER_BATCH)) {
        void api
          .sessionContexts(ids, { signal: activeController.signal })
          .then((response: Response) => {
            // T-1951: a response for an identity that has since changed (a
            // real account switch, mid-flight) must never throttle the NEW
            // identity's own fetches — this batch describes an account that
            // no longer exists in this tab. `disposed` is checked here too
            // (qa-critic fix): without it, a non-OK response landing after
            // this effect's own cleanup still armed a NEW
            // `cooldownRecoveryTimer` that the (already-run) cleanup could
            // never clear — a leaked timer outliving its effect.
            if (disposed || epoch !== getSurfacedSessionsIdentityEpoch()) return null;
            if (!response.ok) {
              cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
              scheduleCooldownRecovery();
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
      clearCooldownRecoveryTimer();
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
