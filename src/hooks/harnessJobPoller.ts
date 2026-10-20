import type { HarnessUpdateJob } from '../../shared/harness-update.contract';
import { authenticatedFetch } from '../utils/api';

import { isTerminalJob } from './harnessVersionMapping';

export const HARNESS_JOB_POLL_MS = 1000;

/** Callbacks of one job poll loop; `isValid` is re-checked after every await so a superseded loop goes silent. */
export interface HarnessJobPollHandlers {
  isValid: () => boolean;
  onJob: (job: HarnessUpdateJob) => void;
  /** Non-2xx job read; the loop stops. */
  onHttpError: (status: number) => void;
  /** Receives each scheduled timer so the owner can clear it. */
  setTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Polls `GET /api/providers/update-jobs/:jobId` every second until the job is
 * terminal (shared by the update and install flows). Network errors retry;
 * an HTTP error stops the loop.
 */
export function pollHarnessJob(jobId: string, handlers: HarnessJobPollHandlers): void {
  const { isValid, onJob, onHttpError, setTimer } = handlers;
  const poll = async () => {
    try {
      const response = await authenticatedFetch(`/api/providers/update-jobs/${encodeURIComponent(jobId)}`);
      if (!isValid()) return;
      if (!response.ok) { onHttpError(response.status); return; }
      const job = await response.json() as HarnessUpdateJob;
      if (!isValid()) return;
      onJob(job);
      if (!isTerminalJob(job.status)) setTimer(setTimeout(() => void poll(), HARNESS_JOB_POLL_MS));
    } catch (error) {
      if (isValid() && (error as Error).name !== 'AbortError') setTimer(setTimeout(() => void poll(), HARNESS_JOB_POLL_MS));
    }
  };
  void poll();
}

/** Window event fired after a harness CLI install succeeds (version/auth views refetch on it). */
export const HARNESS_INSTALLED_EVENT = 'harness-installed';
