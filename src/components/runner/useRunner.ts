import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../utils/api';
import { useWebSocket } from '../../contexts/WebSocketContext';

/**
 * Live runner status for one project, kept fresh by the same mechanism as
 * useProjectBoard: the bridge watches the runner's on-disk files with chokidar
 * and broadcasts `runner-updated`; this hook re-fetches GET /api/runner/:id.
 *
 * Architectural contract: ADR-RUNNER-BRIDGE-001. The hook only ever READS
 * status and POSTs control verbs — it never touches the runner's files.
 */

/**
 * v2: checkpoint.json pointer + progress + blocked (§4 of minwal-v2-design.md).
 * Replaces the old CycleState + ActivityState from v1.
 */
export type CheckpointPointer = {
  phase?: string;
  cycle?: number;
  active_task_id?: string;
  stage?: string | number;
};

export type CheckpointProgress = {
  done?: string[];
  remaining?: string[];
  partial?: Record<
    string,
    {
      step?: number;
      step_name?: string;
      agents_done?: string[];
      agents_pending?: string[];
    }
  >;
};

export type RunnerCheckpoint = {
  schema_version?: string;
  project?: string;
  pointer?: CheckpointPointer;
  progress?: CheckpointProgress;
  open_questions?: string[];
  blocked?: Record<string, string>;
  last_commit?: string;
  last_updated?: string;
};

/**
 * v2: supervisor.json session liveness + cycle_stats.
 * Replaces the old ActivityState liveness fields from v1.
 */
export type RunnerSupervisor = {
  schema_version?: string;
  project?: string;
  session?: {
    pid?: number;
    unit?: string;
    started?: string;
    heartbeat?: string;
    exit_reason?: string | null;
  };
  cycle_stats?: {
    total_cycles?: number;
    last_cycle_duration_s?: number | null;
    tokens_this_session?: number;
    hung_recoveries?: number;
  };
};

/** One completed stage result inside a cycle record. */
export type CycleStageResult = {
  status?: string;
  model?: string;
  duration_s?: number;
  approved_at?: string;
  approved_by?: string;
};

/** One closed cycle entry from cycle-history.json `cycles[]`. */
export type CycleRecord = {
  cycle?: number;
  phase_id?: string | null;
  task_id?: string | null;
  task_title?: string;
  status?: 'succeeded' | 'failed' | 'interrupted' | string;
  started_at?: string | null;
  ended_at?: string | null;
  fix_loops?: number;
  stages?: {
    build?: CycleStageResult;
    verify?: CycleStageResult;
    verdict?: CycleStageResult;
    gate?: CycleStageResult;
  };
};

/**
 * cycle-history.json surfaced by the bridge under RunnerStatus.history.
 * null when the file is absent (no cycles yet) or unparseable.
 */
export type CycleHistory = {
  $version?: number;
  project?: string;
  updated?: string;
  total_cycles?: number;
  current?: {
    cycle?: number;
    phase_id?: string | null;
    task_id?: string | null;
    stage?: string;
    status?: string;
    started_at?: string | null;
    heartbeat_at?: string | null;
  } | null;
  cycles?: CycleRecord[];
};

/**
 * One sensitive action the auto-mode runner logged for the owner's review
 * (Phase ب — approval queue). Surfaced by the bridge under
 * RunnerStatus.pendingApprovals (GET-only; the runner writes them, the UI reads
 * + POSTs approve/reject). Non-blocking: the runner does not wait on these.
 * Server contract: PendingApproval (id = `${task_id}__${kind}`).
 */
export type PendingApproval = {
  id: string;
  task_id: string;
  phase_id: string;
  kind: string;
  reason: string;
  commit?: string | null;
  cycle?: number;
  created_at?: string;
  log_file?: string | null;
};

export type RunnerStatus = {
  registered: boolean;
  name: string | null;
  dir: string | null;
  enabled: boolean | null;
  priority: number | null;
  paused: boolean;
  /**
   * v2: pointer + progress + blocked from checkpoint.json.
   * null when the coordinator has not written a checkpoint yet (normal initial state).
   */
  checkpoint: RunnerCheckpoint | null;
  /**
   * v2: session liveness + cycle_stats from supervisor.json.
   * null when the supervisor has not started yet.
   */
  supervisor: RunnerSupervisor | null;
  /**
   * Journey log (cycle-history.json). null when the file is absent
   * (project with no cycles yet). The UI degrades gracefully.
   */
  history: CycleHistory | null;
  config: { model: string | null; models: Record<string, string> | null; threshold: number | null } | null;
  /**
   * Sensitive actions the auto-mode runner logged for owner review (Phase ب).
   * Absent/empty when there is nothing pending. Read-only from the bridge.
   */
  pendingApprovals?: PendingApproval[];
  stateError: boolean;
};

type RunnerWebSocketMessage = { type?: string; projectId?: string };

/**
 * Control verbs POSTed to /api/runner/:id/:action. The action string IS the URL
 * segment (see api.runnerControl), so it must match the server route exactly:
 *  - 'pause'      → soft stop: writes the pause file; the in-flight cycle finishes.
 *  - 'resume'     → deletes the pause file.
 *  - 'stop'       → hard-disable: registry enabled=false (re-enable with 'start').
 *  - 'start'      → re-enable a disabled project (registry enabled=true).
 *  - 'force-stop' → immediate kill: systemctl --user stop ends the live cycle's
 *                   session now, then writes the pause file to block relaunch.
 *  - 'approve'    → advance past an awaiting-approval phase gate.
 */
export type RunnerAction = 'start' | 'stop' | 'pause' | 'resume' | 'approve' | 'force-stop';

export function useRunner(projectId: string | null | undefined) {
  const [runner, setRunner] = useState<RunnerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [actionPending, setActionPending] = useState<RunnerAction | null>(null);
  const { latestMessage } = useWebSocket();
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const refresh = useCallback(async (targetProjectId: string) => {
    try {
      const response = await api.runnerStatus(targetProjectId);
      if (projectIdRef.current !== targetProjectId) {
        return; // stale response for a previously selected project
      }
      if (!response.ok) {
        setRunner(null);
        return;
      }
      const data = (await response.json()) as RunnerStatus;
      if (projectIdRef.current !== targetProjectId) {
        return;
      }
      setRunner(data);
    } catch {
      if (projectIdRef.current === targetProjectId) {
        setRunner(null);
      }
    } finally {
      if (projectIdRef.current === targetProjectId) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setRunner(null);
    if (!projectId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    void refresh(projectId);
  }, [projectId, refresh]);

  // Live: re-fetch when the bridge broadcasts a runner change for this project.
  useEffect(() => {
    const message = latestMessage as RunnerWebSocketMessage | null;
    if (message?.type === 'runner-updated' && projectId && message.projectId === projectId) {
      void refresh(projectId);
    }
  }, [latestMessage, projectId, refresh]);

  const runAction = useCallback(
    async (action: RunnerAction): Promise<{ ok: boolean; status?: number }> => {
      if (!projectId) {
        return { ok: false };
      }
      setActionPending(action);
      try {
        const response = await api.runnerControl(projectId, action);
        if (response.ok) {
          // The endpoint returns the fresh merged state; adopt it optimistically.
          try {
            const data = (await response.json()) as RunnerStatus;
            if (projectIdRef.current === projectId) {
              setRunner(data);
            }
          } catch {
            void refresh(projectId);
          }
        }
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false };
      } finally {
        if (projectIdRef.current === projectId) {
          setActionPending(null);
        }
      }
    },
    [projectId, refresh],
  );

  const start = useCallback(() => runAction('start'), [runAction]);
  const stop = useCallback(() => runAction('stop'), [runAction]);
  const pause = useCallback(() => runAction('pause'), [runAction]);
  const resume = useCallback(() => runAction('resume'), [runAction]);
  const approve = useCallback(() => runAction('approve'), [runAction]);
  // Immediate kill of the live cycle (systemctl --user stop + pause file).
  // May return 502 when systemctl fails — the caller surfaces that distinctly.
  const forceStop = useCallback(() => runAction('force-stop'), [runAction]);

  // Approval queue (Phase ب). Each verb POSTs to the per-approval endpoint then
  // refetches the merged state so the resolved item drops out of the queue. The
  // optimistic local removal keeps the UI snappy before the WS/refetch lands.
  const resolveApproval = useCallback(
    async (approvalId: string, verb: 'approve' | 'reject'): Promise<{ ok: boolean; status?: number }> => {
      if (!projectId) {
        return { ok: false };
      }
      try {
        const response = await api.post(
          `/runner/${encodeURIComponent(projectId)}/approvals/${encodeURIComponent(approvalId)}/${verb}`,
        );
        if (response.ok && projectIdRef.current === projectId) {
          setRunner((prev) =>
            prev
              ? { ...prev, pendingApprovals: (prev.pendingApprovals ?? []).filter((a) => a.id !== approvalId) }
              : prev,
          );
          void refresh(projectId);
        }
        return { ok: response.ok, status: response.status };
      } catch {
        return { ok: false };
      }
    },
    [projectId, refresh],
  );

  const approveApproval = useCallback(
    (approvalId: string) => resolveApproval(approvalId, 'approve'),
    [resolveApproval],
  );
  const rejectApproval = useCallback(
    (approvalId: string) => resolveApproval(approvalId, 'reject'),
    [resolveApproval],
  );

  return {
    runner,
    isLoading,
    registered: Boolean(runner?.registered),
    actionPending,
    refresh: () => projectId && refresh(projectId),
    start,
    stop,
    pause,
    resume,
    approve,
    forceStop,
    approveApproval,
    rejectApproval,
  };
}
