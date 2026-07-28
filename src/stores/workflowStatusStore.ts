/**
 * Global active-workflow store (B-103 honest background-workflow surface).
 *
 * Mirrors sessionProcessStateStore's shape, but its source is a POLLED endpoint
 * (GET /api/providers/workflows/active) rather than a WebSocket broadcast: the
 * single driver hook (useActiveWorkflows, mounted once in AppContent) fetches the
 * envelope and pushes it here via `setActiveWorkflows`. Any component — sidebar
 * session rows, the chat header, the project rollup — subscribes per sessionId
 * (or across a project's sessions) without prop drilling.
 *
 * The store holds:
 *   - a Map<sessionId, ActiveWorkflow[]> of the caller's running/orphaned runs;
 *   - the envelope counters { eligible, scanned, capped } so the UI can tell
 *     "scanned everything, nothing active" from "hit the scan cap, did not look".
 *
 * Referential stability: `setActiveWorkflows` reuses the previous per-session
 * array reference when a session's workflows are unchanged, and skips emitting
 * entirely when the whole snapshot signature is identical — so an 8s poll that
 * returns the same data triggers zero re-renders and useSyncExternalStore's
 * Object.is check never spuriously fires.
 */

import { useSyncExternalStore } from 'react';

import type { ActiveWorkflow, ActiveWorkflowsEnvelope } from './workflowStatus';

/** Envelope counters kept alongside the per-session workflow map. */
export type WorkflowEnvelope = {
  eligible: number;
  scanned: number;
  capped: boolean;
};

/** Project rollup verdict: the most salient workflow state across a project. */
export type WorkflowRollup = 'running' | 'orphan' | 'unknown' | null;

// Frozen shared empty list so sessions with no workflows return a stable ref.
const EMPTY_LIST: readonly ActiveWorkflow[] = Object.freeze([]);

const bySession = new Map<string, readonly ActiveWorkflow[]>();
let envelope: WorkflowEnvelope = { eligible: 0, scanned: 0, capped: false };
let snapshotSig = '';

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function workflowSig(w: ActiveWorkflow): string {
  // The agent rows MUST be part of the signature. `updatedAt` is the JOURNAL's
  // mtime, and a journal only moves when an agent starts or finishes — so a live
  // agent racking up tool calls changes nothing else in this string, and the
  // store would suppress the update as "identical snapshot". The strip would then
  // freeze on the first sample it ever received.
  const agentsSig = w.agents
    .map((a) => `${a.agentId}:${a.status}:${a.callCount}:${a.currentTool ?? ''}`)
    .join(',');
  return `${w.wfId}|${w.status}|${w.agentsDone}|${w.agentsTotal}|${w.updatedAt ?? ''}|${agentsSig}`;
}

function listSig(list: readonly ActiveWorkflow[]): string {
  return list.map(workflowSig).join(';');
}

function computeSnapshotSig(next: Map<string, readonly ActiveWorkflow[]>, env: WorkflowEnvelope): string {
  const parts: string[] = [`e:${env.eligible},${env.scanned},${env.capped ? 1 : 0}`];
  for (const sid of [...next.keys()].sort()) {
    parts.push(`${sid}=${listSig(next.get(sid)!)}`);
  }
  return parts.join('||');
}

/**
 * Replaces the store's contents from a fresh endpoint envelope. Groups the flat
 * workflow list by sessionId, reuses unchanged per-session array references for
 * referential stability, and only notifies subscribers when the overall snapshot
 * actually changed (so a repeat poll of identical data is a no-op).
 */
export function setActiveWorkflows(result: ActiveWorkflowsEnvelope): void {
  const grouped = new Map<string, ActiveWorkflow[]>();
  for (const w of result.workflows) {
    if (!w || typeof w.sessionId !== 'string' || !w.sessionId) {
      continue;
    }
    const arr = grouped.get(w.sessionId);
    if (arr) {
      arr.push(w);
    } else {
      grouped.set(w.sessionId, [w]);
    }
  }

  // Reuse the prior array reference for any session whose list is byte-identical.
  const next = new Map<string, readonly ActiveWorkflow[]>();
  for (const [sid, list] of grouped) {
    const prev = bySession.get(sid);
    next.set(sid, prev && listSig(prev) === listSig(list) ? prev : list);
  }

  const nextEnvelope: WorkflowEnvelope = {
    eligible: result.eligible,
    scanned: result.scanned,
    capped: result.capped,
  };

  const nextSig = computeSnapshotSig(next, nextEnvelope);
  if (nextSig === snapshotSig) {
    return; // Identical snapshot — no re-render.
  }

  bySession.clear();
  for (const [sid, list] of next) {
    bySession.set(sid, list);
  }
  // Keep the envelope reference stable when only the workflow map changed, so
  // subscribers of the counters alone don't re-render on unrelated updates.
  if (
    envelope.eligible !== nextEnvelope.eligible ||
    envelope.scanned !== nextEnvelope.scanned ||
    envelope.capped !== nextEnvelope.capped
  ) {
    envelope = nextEnvelope;
  }
  snapshotSig = nextSig;
  emitChange();
}

/** Test seam: clears the store back to empty. */
export function __resetWorkflowStatusStore(): void {
  bySession.clear();
  envelope = { eligible: 0, scanned: 0, capped: false };
  snapshotSig = '';
  emitChange();
}

/**
 * Reactive per-session workflow list. Returns a stable, possibly-empty array
 * reference — safe to use directly in render and as a hook dependency.
 */
export function useSessionWorkflows(sessionId?: string | null): readonly ActiveWorkflow[] {
  return useSyncExternalStore(subscribe, () =>
    sessionId ? (bySession.get(sessionId) ?? EMPTY_LIST) : EMPTY_LIST,
  );
}

/**
 * Reactive project rollup across a set of session ids. Returns the most salient
 * state as a primitive (stable by value): `running` if any session has a live
 * workflow, else `orphan` if any is orphaned, else `unknown` if any workflow's
 * liveness could not be verified (T-907: kept consistent with the per-session
 * badge, which already surfaces `unknown` via pickPrimaryWorkflow — hiding it
 * here would contradict what the same session shows on its row), else null.
 * Frozen stays quiet at the rollup level (unchanged, out of T-907's scope).
 */
export function useProjectWorkflowRollup(
  sessionIds: ReadonlyArray<string | null | undefined>,
): WorkflowRollup {
  return useSyncExternalStore(subscribe, () => {
    let hasOrphan = false;
    let hasUnknown = false;
    for (const id of sessionIds) {
      if (!id) {
        continue;
      }
      const list = bySession.get(id);
      if (!list) {
        continue;
      }
      for (const w of list) {
        if (w.status === 'running') {
          return 'running'; // running outranks everything — return early.
        }
        if (w.status === 'orphan') {
          hasOrphan = true;
        } else if (w.status === 'unknown') {
          hasUnknown = true;
        }
      }
    }
    if (hasOrphan) {
      return 'orphan';
    }
    return hasUnknown ? 'unknown' : null;
  });
}

/**
 * Reactive envelope counters. The returned object reference is stable across
 * renders until `setActiveWorkflows` changes it, so it is safe in render.
 */
export function useWorkflowsEnvelope(): WorkflowEnvelope {
  return useSyncExternalStore(subscribe, () => envelope);
}
