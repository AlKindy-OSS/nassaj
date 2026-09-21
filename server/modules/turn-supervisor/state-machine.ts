import type {
  RunState,
  TerminalOutcome,
  TransitionRunInput,
  TransitionTurnInput,
  TurnState,
} from '@/modules/turn-supervisor/types.js';

export class TurnStateTransitionError extends Error {
  constructor(readonly code: 'ILLEGAL_TRANSITION' | 'INVALID_TERMINAL_OUTCOME') {
    super(code);
    this.name = 'TurnStateTransitionError';
  }
}

const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  claimed: ['dispatching', 'terminal'],
  dispatching: ['running', 'terminal'],
  running: ['terminal'],
  terminal: [],
};

const TURN_TRANSITIONS: Readonly<Record<TurnState, readonly TurnState[]>> = {
  accepted: ['running', 'terminal'],
  running: ['terminal'],
  terminal: [],
};

function assertTerminalOutcome(
  nextState: RunState | TurnState,
  terminalOutcome: TerminalOutcome | undefined,
): void {
  if ((nextState === 'terminal') !== (terminalOutcome !== undefined)) {
    throw new TurnStateTransitionError('INVALID_TERMINAL_OUTCOME');
  }
}

/** Validates a run transition before its CAS statement touches durable state. */
export function assertRunTransition(input: TransitionRunInput): void {
  if (!RUN_TRANSITIONS[input.expectedState].includes(input.nextState)) {
    throw new TurnStateTransitionError('ILLEGAL_TRANSITION');
  }
  assertTerminalOutcome(input.nextState, input.terminalOutcome);
}

/** Validates a turn transition before its CAS statement touches durable state. */
export function assertTurnTransition(input: TransitionTurnInput): void {
  if (!TURN_TRANSITIONS[input.expectedState].includes(input.nextState)) {
    throw new TurnStateTransitionError('ILLEGAL_TRANSITION');
  }
  assertTerminalOutcome(input.nextState, input.terminalOutcome);
}

/**
 * A duplicate is safe to resume only before the dispatch boundary. Once a run
 * reaches `dispatching`, a crash may have happened immediately after the
 * provider accepted the request; redispatching would duplicate the effect.
 */
export function classifyDuplicateRun(state: RunState): 'resume_safe' | 'ambiguous' | 'replay_terminal' {
  if (state === 'claimed') return 'resume_safe';
  if (state === 'terminal') return 'replay_terminal';
  return 'ambiguous';
}
