/**
 * T-2095: wire shapes of the per-turn checkpoint routes
 * (`GET /api/git/turn-checkpoints` and `/turn-checkpoints/diff`).
 */

/** Why the server withheld a path instead of capturing it. */
export type TurnWithheldReason =
  | 'too_large'
  | 'secret_content'
  | 'secret_container'
  | 'denied_path'
  | 'budget'
  | 'hardlink'
  | 'special'
  | 'protected_content';

export type TurnCheckpointFile =
  | { path: string; status: 'A' | 'M' | 'D' }
  | { path: string; status: 'withheld'; reason?: string; size?: number; phase?: 'pre' };

export type TurnCheckpointCounts = {
  added: number;
  modified: number;
  deleted: number;
  withheld: number;
};

export type TurnCheckpointSummary = {
  turnSeq: number;
  status: 'complete' | 'running' | 'interrupted';
  provider: string | null;
  startedAt: string | null;
  completedAt: string | null;
  counts: TurnCheckpointCounts;
  files: TurnCheckpointFile[];
  filesTruncated: boolean;
};

export type TurnCheckpointListResponse = {
  turns: TurnCheckpointSummary[];
  nextBefore: number | null;
};

export type TurnFileDiffResponse =
  | { path: string; diff: string; truncated: boolean }
  | { path: string; withheld: true; reason?: string };

/** Load state of the turn list: one neutral 404, one retryable error. */
export type TurnListStatus = 'idle' | 'loading' | 'ready' | 'notFound' | 'error';

export type TurnFileDiffState =
  | { status: 'loading' }
  | { status: 'ready'; diff: string; truncated: boolean }
  | { status: 'withheld'; reason?: string }
  | { status: 'unavailable' };
