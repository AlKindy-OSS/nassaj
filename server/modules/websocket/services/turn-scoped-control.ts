/**
 * T-2093 (ADR-TURN-SCOPED-CONTROL) — idempotent, turn-scoped stop and approval.
 *
 * Only clients that send a `commandId` take this path; a message without one
 * keeps the exact legacy behaviour and receives no new frame. Check order:
 *   1. the session write check (as today) — a refused requester never sees a
 *      stored result;
 *   2. the per-user LRU by (userId, commandId) with a fingerprint;
 *   3. the registry-scoped target: an empty session id resolves only to a turn
 *      this user started on THIS connection.
 * The reply is a `control-command-receipt` sent to the requesting socket only.
 */

import type { ActiveTurnRegistry } from './active-turn-registry.js';
import type { ControlCommandLru } from './control-command-lru.js';

export const CONTROL_COMMAND_RECEIPT_TYPE = 'control-command-receipt';

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export type AbortStatus = 'stopped' | 'stale_target' | 'not_running' | 'failed' | 'refused' | 'command_id_reused';
export type ApprovalStatus = 'applied' | 'already_resolved' | 'command_id_reused';

export type ControlReceipt = {
  type: typeof CONTROL_COMMAND_RECEIPT_TYPE;
  commandId: string;
  kind: 'abort' | 'approval';
  status: AbortStatus | ApprovalStatus;
  duplicate: boolean;
  result: Record<string, unknown>;
};

/** What the abort dispatch reports for one stop. */
export type TurnAbortOutcome = {
  provider: string | null;
  success: boolean;
  resolvedSessionId: string | null;
  abortReason: string | null;
  /** Another turn than the named one is running: nothing was killed. */
  staleTarget: boolean;
  /** No run was found to stop (final: the client clears its spinner). */
  notRunning: boolean;
};

type AbortResult = { status: AbortStatus; sessionId: string; provider: string | null };
type ApprovalResult = { status: ApprovalStatus };

/** Reads a client command id; anything but a bounded opaque token is null. */
export function readControlCommandId(value: unknown): string | null {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value) ? value : null;
}

/** Reads a turn key (a clientMsgId) with the same bounds as the send identity. */
export function readTurnKey(value: unknown): string | null {
  return readControlCommandId(value);
}

/** Maps an abort outcome to the final status the client acts on. */
export function classifyAbortOutcome(outcome: TurnAbortOutcome): AbortStatus {
  if (outcome.staleTarget) return 'stale_target';
  if (outcome.success) return 'stopped';
  return outcome.notRunning ? 'not_running' : 'failed';
}

function receipt(
  commandId: string,
  kind: ControlReceipt['kind'],
  status: ControlReceipt['status'],
  duplicate: boolean,
  result: Record<string, unknown>,
): ControlReceipt {
  return { type: CONTROL_COMMAND_RECEIPT_TYPE, commandId, kind, status, duplicate, result };
}

export type TurnScopedAbortRequest = {
  userId: number;
  commandId: string;
  sessionId: string;
  targetTurnKey: string | null;
};

export type TurnScopedAbortPorts = {
  lru: ControlCommandLru<unknown>;
  registry: ActiveTurnRegistry;
  /** Identity of the connection the stop arrived on. */
  connectionWriter: object;
  isWritable(sessionId: string): boolean;
  /**
   * ADR-173 P5 stop right for a named session (starter, owner, admin, or any
   * writer once stuck); sends its own refusal frame and returns false to refuse.
   * Checked before the LRU, so a refusal is never stored.
   */
  authorizeStop?(sessionId: string): boolean;
  /** The abort dispatch; compares the key and calls the bridge in one tick. */
  abort(sessionId: string, expectedTurnKey: string | null): Promise<TurnAbortOutcome>;
  /** Today's `complete`/`aborted` frame to the session's viewers. */
  sendTurnFrame(sessionId: string, outcome: TurnAbortOutcome): void;
  /** Today's 404-equivalent refusal frame. */
  sendRefusal(sessionId: string): void;
  sendReceipt(receipt: ControlReceipt): void;
};

/** An empty id resolves only to a turn this user started on this connection. */
function resolveAbortTarget(request: TurnScopedAbortRequest, ports: TurnScopedAbortPorts): string {
  if (request.sessionId || !request.targetTurnKey) return request.sessionId;
  const entry = ports.registry.findStartedTurn(request.userId, request.targetTurnKey);
  if (!entry || entry.writer !== ports.connectionWriter || entry.starterUserId !== request.userId) return '';
  return ports.isWritable(entry.sessionId) ? entry.sessionId : '';
}

async function runAbort(request: TurnScopedAbortRequest, ports: TurnScopedAbortPorts): Promise<AbortResult> {
  const target = resolveAbortTarget(request, ports);
  const outcome = await ports.abort(target, request.targetTurnKey);
  const status = classifyAbortOutcome(outcome);
  const sessionId = outcome.resolvedSessionId ?? target;
  // A stale stop must not broadcast `complete`: the newer turn keeps its spinner.
  if (status !== 'stale_target') ports.sendTurnFrame(sessionId, outcome);
  return { status, sessionId, provider: outcome.provider };
}

/** Executes one stop command: write check, LRU, then the turn-scoped abort. */
export async function executeTurnScopedAbort(
  request: TurnScopedAbortRequest,
  ports: TurnScopedAbortPorts,
): Promise<void> {
  const { commandId, sessionId } = request;
  if (sessionId && !ports.isWritable(sessionId)) {
    ports.sendRefusal(sessionId);
    ports.sendReceipt(receipt(commandId, 'abort', 'refused', false, { sessionId }));
    return;
  }
  if (sessionId && ports.authorizeStop && !ports.authorizeStop(sessionId)) {
    ports.sendReceipt(receipt(commandId, 'abort', 'refused', false, { sessionId }));
    return;
  }
  const fingerprint = JSON.stringify(['abort', sessionId, request.targetTurnKey ?? '']);
  const run = await ports.lru.run(String(request.userId), commandId, fingerprint, () => runAbort(request, ports));
  if (run.status === 'command_id_reused') {
    ports.sendReceipt(receipt(commandId, 'abort', 'command_id_reused', false, {}));
    return;
  }
  const result = run.result as AbortResult;
  ports.sendReceipt(receipt(commandId, 'abort', result.status, run.duplicate, {
    sessionId: result.sessionId,
    ...(result.provider ? { provider: result.provider } : {}),
  }));
}

export type TurnScopedApprovalRequest = {
  userId: number;
  commandId: string;
  requestId: string;
  allow: boolean;
};

export type TurnScopedApprovalPorts = {
  lru: ControlCommandLru<unknown>;
  /** The existing ownership-checked resolver (claude-sdk resolveToolApproval). */
  resolve(): { resolved?: boolean; sessionId?: string | null } | null | undefined | void;
  /** Runs the unchanged pending-question broadcast after a real resolution. */
  onResolved(sessionId: string): void;
  sendReceipt(receipt: ControlReceipt): void;
};

/**
 * Executes one approval answer. The receipt says only `applied` or
 * `already_resolved` (also for a foreign or unknown request): it reveals nothing
 * about who answered or what was decided.
 */
export async function executeTurnScopedApproval(
  request: TurnScopedApprovalRequest,
  ports: TurnScopedApprovalPorts,
): Promise<void> {
  const { commandId, requestId } = request;
  const fingerprint = JSON.stringify(['approval', requestId, request.allow]);
  const run = await ports.lru.run(String(request.userId), commandId, fingerprint, async (): Promise<ApprovalResult> => {
    const outcome = ports.resolve() || null;
    if (outcome?.resolved && outcome.sessionId) ports.onResolved(outcome.sessionId);
    return { status: outcome?.resolved ? 'applied' : 'already_resolved' };
  });
  if (run.status === 'command_id_reused') {
    ports.sendReceipt(receipt(commandId, 'approval', 'command_id_reused', false, { requestId }));
    return;
  }
  const result = run.result as ApprovalResult;
  ports.sendReceipt(receipt(commandId, 'approval', result.status, run.duplicate, { requestId }));
}
