import type { ScheduledMessage } from '@/modules/database/index.js';

import { isDeferrableGateDenial, runOutsideWriterContext } from '../../services/update-writer-lease.js';

import { UPDATE_MAINTENANCE_ACTIVE } from './scheduled-messages.service.js';
import type {
  ScheduledDispatchAcceptance, ScheduledDispatchResult, ScheduledTurnOutcome,
} from './scheduled-messages.service.js';

export { UPDATE_MAINTENANCE_ACTIVE };

type ActiveUser = { id: number; role: string; authorization_generation: number };
type TurnWriter = { send(payload: unknown): void };
type WriterLease = { release(): void };
type TerminalFrame = {
  kind: 'complete' | 'error'; success?: unknown; exitCode?: unknown; code?: unknown;
  notStarted?: unknown; sameClientMsgIdRetryable?: unknown;
};

export type ScheduledTurnDispatcherDeps<W extends TurnWriter> = {
  getSession(sessionId: string): { project_path?: string | null; provider?: string | null } | null | undefined;
  /** A real writer (mirror fan-out, durable side effects) with an inert primary sink. */
  createWriter(userId: number, sessionId: string): W;
  dispatchProviderCommand(
    messageType: string, data: Record<string, unknown>, writer: W, userId: number, principal: unknown,
  ): Promise<void>;
  /** The same allow-list the coordination ingress uses to mark a turn `started`. */
  isAcceptanceFrame(payload: { kind?: unknown; role?: unknown }): boolean;
  /** Admits one writer through the update gate; rejects with an `update_*` code while it is closed. */
  acquireWriterLease(kind: string): Promise<WriterLease>;
  logger?: Pick<Console, 'error'>;
};

function isTerminalFrame(payload: unknown): payload is TerminalFrame {
  return Boolean(payload) && typeof payload === 'object'
    && ((payload as TerminalFrame).kind === 'complete' || (payload as TerminalFrame).kind === 'error');
}

/** Maps a terminal frame that arrived BEFORE acceptance to the queue verdict. */
export function verdictFromTerminal(terminal: TerminalFrame | null): ScheduledDispatchResult {
  if (!terminal) return { success: false, retryable: true, errorCode: 'missing_terminal_verdict' };
  if (terminal.success === true || (terminal.success === undefined && terminal.exitCode === 0)) {
    return { success: true, retryable: false };
  }
  return {
    success: false,
    retryable: terminal.notStarted === true || terminal.sameClientMsgIdRetryable === true,
    errorCode: typeof terminal.code === 'string' ? terminal.code : 'provider_failed',
  };
}

function turnPayload(message: ScheduledMessage, user: ActiveUser, projectPath: string) {
  const principal = {
    ...user,
    authenticationKind: 'internal_service',
    authenticationCredentialId: `scheduled-message:${message.id}`,
    authorizationGeneration: user.authorization_generation,
  };
  const data = {
    command: message.content,
    sessionId: message.sessionId,
    options: {
      ...message.options,
      sessionId: message.sessionId,
      cwd: projectPath,
      clientMsgId: `scheduled:${message.id}`,
    },
  };
  return { principal, data };
}

/**
 * Pre-acceptance verdict for a turn the update gate refused: retryable, and a
 * TRANSIENT refusal (lock contended / maintenance) does not spend an attempt.
 * The service bounds that refund in time (MAINTENANCE_REFUND_WINDOW_MS).
 */
function maintenanceRefusal(error: unknown): ScheduledDispatchResult {
  return {
    success: false,
    retryable: true,
    errorCode: UPDATE_MAINTENANCE_ACTIVE,
    ...(isDeferrableGateDenial(error) ? { refundAttempt: true } : {}),
  };
}

function isUpdateRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('update_');
}

/**
 * Runs `turn` detached from any enclosing writer context (never retaining the
 * queue tick's lease) under its own `provider-turn` lease, released only when
 * the whole turn ends — completed, failed, or thrown.
 *
 * @returns the pre-acceptance verdict when the update gate refused admission,
 *   `null` once the turn ran; any other acquisition failure rejects as itself.
 */
function runLeasedTurn(
  acquireWriterLease: (kind: string) => Promise<WriterLease>,
  turn: () => Promise<void>,
): Promise<ScheduledDispatchResult | null> {
  return runOutsideWriterContext(async () => {
    let lease: WriterLease;
    try {
      lease = await acquireWriterLease('provider-turn');
    } catch (error) {
      if (isUpdateRefusal(error)) return maintenanceRefusal(error);
      throw error;
    }
    try {
      await turn();
    } finally {
      lease.release();
    }
    return null;
  });
}

/** Maps the frame that ended an ACCEPTED turn to its post-acceptance outcome. */
function turnOutcome(terminal: TerminalFrame | null): ScheduledTurnOutcome {
  if (!terminal) return { success: true };
  const verdict = verdictFromTerminal(terminal);
  return verdict.success ? { success: true } : { success: false, errorCode: verdict.errorCode };
}

/**
 * B-1390: builds the scheduled-message dispatch. It resolves as soon as the
 * provider accepts the turn (first model-activity frame) or refuses it with a
 * terminal frame, never after the whole turn; `completion` carries the rest
 * and resolves with the turn's own outcome (it never rejects).
 *
 * The turn is started OUTSIDE the queue tick's writer context (`runLeasedTurn`),
 * so nothing inside a turn can retain the tick's shared update lease. Instead
 * the turn takes its own `provider-turn` writer lease (parity with interactive
 * turns) before the provider command and holds it until the whole turn ends,
 * so an update cannot swap the source under a running scheduled turn. A gate
 * refusal is a retryable pre-acceptance verdict: the row stays pending.
 */
export function createScheduledTurnDispatcher<W extends TurnWriter>(deps: ScheduledTurnDispatcherDeps<W>) {
  const logger = deps.logger ?? console;
  return (message: ScheduledMessage, user: ActiveUser): Promise<ScheduledDispatchAcceptance> => {
    const session = deps.getSession(message.sessionId);
    if (!session?.project_path || !session.provider) {
      return Promise.resolve({ success: false, retryable: false, errorCode: 'session_unavailable' });
    }
    const provider = session.provider;
    const { principal, data } = turnPayload(message, user, session.project_path);
    let finishTurn!: (outcome: ScheduledTurnOutcome) => void;
    const completion = new Promise<ScheduledTurnOutcome>((settle) => { finishTurn = settle; });
    return new Promise((resolve, reject) => {
      let decided = false;
      let terminal: TerminalFrame | null = null;
      const decide = (verdict: ScheduledDispatchResult) => {
        if (decided) return;
        decided = true;
        resolve({ ...verdict, completion });
      };
      const writer = deps.createWriter(message.userId, message.sessionId);
      const forward = writer.send.bind(writer);
      writer.send = (payload: unknown) => {
        if (isTerminalFrame(payload)) {
          terminal = payload;
          decide(verdictFromTerminal(terminal));
        } else if (payload && typeof payload === 'object' && deps.isAcceptanceFrame(payload)) {
          decide({ success: true, retryable: false });
        }
        forward(payload);
      };
      runLeasedTurn(deps.acquireWriterLease, () => deps.dispatchProviderCommand(
        `${provider}-command`, data, writer, message.userId, principal,
      ))
        .then((refusal) => {
          if (refusal) {
            decide(refusal);
            finishTurn({ success: false, errorCode: UPDATE_MAINTENANCE_ACTIVE });
            return;
          }
          decide(verdictFromTerminal(terminal));
          finishTurn(turnOutcome(terminal));
        }, (error: unknown) => {
          finishTurn({ success: false, errorCode: 'turn_failed' });
          if (!decided) { decided = true; reject(error); return; }
          logger.error('[scheduled-messages] accepted turn failed', {
            scheduledMessageId: message.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
  };
}
