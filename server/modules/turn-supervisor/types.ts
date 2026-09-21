export type TurnId = string;
export type RunId = string;

export type TurnState = 'accepted' | 'running' | 'terminal';
export type RunState = 'claimed' | 'dispatching' | 'running' | 'terminal';
export type TerminalOutcome = 'succeeded' | 'failed' | 'cancelled';

export type TurnRecord = {
  turnId: TurnId;
  userId: number;
  clientMsgId: string;
  requestFingerprint: string;
  sessionId: string | null;
  state: TurnState;
  epoch: number;
  terminalOutcome: TerminalOutcome | null;
  createdAt: string;
  updatedAt: string;
};

export type RunRecord = {
  runId: RunId;
  turnId: TurnId;
  attempt: number;
  state: RunState;
  epoch: number;
  terminalOutcome: TerminalOutcome | null;
  createdAt: string;
  updatedAt: string;
};

export type TurnWithRun = {
  turn: TurnRecord;
  run: RunRecord;
};

export type ClaimTurnInput = {
  userId: number;
  clientMsgId: string;
  requestFingerprint: string;
  sessionId?: string | null;
};

export type ClaimTurnResult =
  | ({ action: 'dispatch' } & TurnWithRun)
  | ({ action: 'resume_safe' } & TurnWithRun)
  | ({ action: 'ambiguous' } & TurnWithRun)
  | ({ action: 'replay_terminal' } & TurnWithRun)
  | { action: 'fingerprint_mismatch'; turn: TurnRecord };

/**
 * Narrow bridge payload for adopting an already accepted T-1453 ingress row.
 * It deliberately contains no provider prompt or enforcement fields: M1 only
 * establishes durable identity and fencing.
 */
export type AdoptIngressInput = {
  userId: number;
  clientMsgId: string;
};

export type TransitionRunInput = {
  runId: RunId;
  expectedState: RunState;
  expectedEpoch: number;
  nextState: RunState;
  terminalOutcome?: TerminalOutcome;
};

export type TransitionTurnInput = {
  turnId: TurnId;
  expectedState: TurnState;
  expectedEpoch: number;
  nextState: TurnState;
  terminalOutcome?: TerminalOutcome;
};

export type StartExecutionInput = {
  turnId: TurnId;
  runId: RunId;
  expectedTurnEpoch: number;
  expectedRunEpoch: number;
};

export type FinishExecutionInput = {
  turnId: TurnId;
  runId: RunId;
  expectedTurnEpoch: number;
  expectedRunEpoch: number;
  terminalOutcome: TerminalOutcome;
  hostedResult?: {
    provider: 'kimi' | 'deepseek' | 'glm' | 'codex' | 'claude'; model: string; sessionId: string;
    isNewSession: boolean; text: string;
    projectPath?: string;
    transcriptState?: 'pending' | 'written';
  };
  cancellationEpoch?: number;
};
