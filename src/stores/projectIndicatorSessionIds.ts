/**
 * Project-indicator session-id selector (B-1431 / T-1949 client stage).
 *
 * The sidebar header dot (`ProjectBusyDot`) used to see only the project's
 * loaded/paginated session ids (`SidebarProjectItem`'s `sessions.map(...)`),
 * so a running/question/error/done/frozen session outside the loaded page
 * never lit the header — the exact defect this file exists to close.
 *
 * The server now carries a DB `projectId` on every indicator (presence
 * `runningSessions`, `session_outcome`, `workflows/active`) — see
 * server/modules/websocket/services/presence.service.ts and siblings — so this
 * selector unions the loaded ids with whatever ids the three client stores
 * already attribute to this project, regardless of whether a row for them was
 * ever mounted.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';

import {
  getOutcomeSessionIdsForProject,
  subscribeSessionCompletion,
} from './sessionCompletionStore';
import {
  getProcessStateSessionIdsForProject,
  subscribeSessionProcessState,
} from './sessionProcessStateStore';
import {
  getWorkflowSessionIdsForProject,
  subscribeWorkflowStatus,
} from './workflowStatusStore';

const EMPTY_IDS: ReadonlyArray<string> = Object.freeze([]);

/** Sorted, de-duplicated signature of the three stores' ids for one project. */
function computeStoreIdsSignature(projectId: string | null): string {
  if (!projectId) return '';
  const ids = new Set<string>([
    ...getProcessStateSessionIdsForProject(projectId),
    ...getOutcomeSessionIdsForProject(projectId),
    ...getWorkflowSessionIdsForProject(projectId),
  ]);
  return Array.from(ids).sort().join(',');
}

/**
 * Ids of a project's loaded sessions, unioned with any session id the presence
 * feed / outcome store / workflow store attribute to the same `projectId` —
 * whether or not the sidebar ever loaded a row for it.
 *
 * The returned array is a stable reference across renders whenever its content
 * is unchanged (loadedIds may be a fresh array every render, as
 * `SidebarProjectItem` already produces one from `sessions.map(...)`), so it is
 * safe to feed straight into `ProjectBusyDot` without causing render churn.
 */
export function useProjectIndicatorSessionIds(
  projectId: string | null,
  loadedIds: ReadonlyArray<string | null | undefined>,
): ReadonlyArray<string> {
  const subscribeAll = useCallback((listener: () => void) => {
    const unsubProcess = subscribeSessionProcessState(listener);
    const unsubOutcome = subscribeSessionCompletion(listener);
    const unsubWorkflow = subscribeWorkflowStatus(listener);
    return () => {
      unsubProcess();
      unsubOutcome();
      unsubWorkflow();
    };
  }, []);

  // A primitive snapshot (string) makes useSyncExternalStore's Object.is check
  // exact and cheap — no risk of "always different reference" render churn.
  const storeIdsSig = useSyncExternalStore(
    subscribeAll,
    () => computeStoreIdsSignature(projectId),
  );

  const loadedSig = loadedIds.filter((id): id is string => Boolean(id)).sort().join(',');

  const cacheRef = useRef<{ loadedSig: string; storeIdsSig: string; ids: ReadonlyArray<string> }>({
    loadedSig: '',
    storeIdsSig: '',
    ids: EMPTY_IDS,
  });

  if (cacheRef.current.loadedSig !== loadedSig || cacheRef.current.storeIdsSig !== storeIdsSig) {
    const merged = new Set<string>();
    for (const id of loadedIds) {
      if (id) merged.add(id);
    }
    if (storeIdsSig) {
      for (const id of storeIdsSig.split(',')) {
        merged.add(id);
      }
    }
    cacheRef.current = { loadedSig, storeIdsSig, ids: Array.from(merged) };
  }

  return cacheRef.current.ids;
}
