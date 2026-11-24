/**
 * T-2093 (ADR-TURN-SCOPED-CONTROL) — client state for turn-scoped control.
 *
 *  - turnKey per session: the server stamps `turnKey` (the clientMsgId that
 *    started the turn) on every run frame; a STOP names that key so it can
 *    never kill a newer turn. Before the first run frame arrives, the pending
 *    send id is the target (QA condition 4).
 *  - one commandId per intent (per targeted turn for STOP, per requestId for an
 *    approval): a double press or a reconnect resend reuses it, so the server
 *    executes once and replays the stored result.
 *  - a small outbox: a command without a receipt is resent with the same
 *    commandId after a reconnect, within 30 s; any receipt is final.
 *
 * Module state, like `messageOutbox`: the WebSocket context feeds it frames
 * synchronously, before React batching can drop one.
 */

export type ControlSendResult = { ok: boolean; reason?: string } | void;

type PendingCommand = { payload: Record<string, unknown>; firstSentAt: number };

const RESEND_WINDOW_MS = 30_000;
const MAX_REMEMBERED = 200;
/** Receipt statuses after which the same intent may be tried again with a new id. */
// `refused` too: an ADR-173 foreign stop may be allowed once the turn is stuck.
const RETRYABLE_STATUSES = new Set(['failed', 'command_id_reused', 'refused']);

const turnKeys = new Map<string, string>();
/** Pending send id per session ('' = a conversation not created yet). */
const pendingSends = new Map<string, string>();
const intentCommandIds = new Map<string, string>();
const pendingCommands = new Map<string, PendingCommand>();

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value as string);
}

function isNotStartedFrame(frame: Record<string, unknown>): boolean {
  return frame.notStarted === true || frame.code === 'session_busy';
}

function frameSessionId(frame: Record<string, unknown>): string {
  const id = frame.newSessionId ?? frame.sessionId;
  return typeof id === 'string' ? id : '';
}

/** Learns the turnKey of a session from one incoming frame (any frame is safe). */
export function recordTurnKeyFrame(frame: unknown): void {
  if (!frame || typeof frame !== 'object') return;
  const data = frame as Record<string, unknown>;
  const turnKey = typeof data.turnKey === 'string' ? data.turnKey : '';
  if (!turnKey) return;
  const sessionId = frameSessionId(data);
  for (const [key, pending] of pendingSends) {
    if (pending === turnKey) pendingSends.delete(key);
  }
  if (!sessionId || isNotStartedFrame(data)) return;
  remember(turnKeys, sessionId, turnKey);
}

/** Records the clientMsgId of a send that has not produced run frames yet. */
export function rememberSentTurnKey(sessionId: string | null, clientMsgId: string): void {
  if (clientMsgId) remember(pendingSends, sessionId ?? '', clientMsgId);
}

/** The turn a STOP on this session should name, or null (legacy session-wide stop). */
export function resolveStopTarget(sessionId: string | null): string | null {
  const key = sessionId ?? '';
  return pendingSends.get(key) ?? (key ? turnKeys.get(key) : undefined) ?? null;
}

function newCommandId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `cmd_${random}`;
}

/** One commandId per intent key (e.g. `stop:<session>:<turnKey>`, `approval:<requestId>`). */
export function commandIdForIntent(intentKey: string): string {
  const existing = intentCommandIds.get(intentKey);
  if (existing) return existing;
  const commandId = newCommandId();
  remember(intentCommandIds, intentKey, commandId);
  return commandId;
}

/** Records then sends a control command; it stays pending until its receipt. */
export function submitControlCommand(
  payload: Record<string, unknown>,
  send: (message: Record<string, unknown>) => ControlSendResult,
  now: number = Date.now(),
): ControlSendResult {
  const commandId = typeof payload.commandId === 'string' ? payload.commandId : '';
  if (commandId && !pendingCommands.has(commandId)) {
    remember(pendingCommands, commandId, { payload, firstSentAt: now });
  }
  return send(payload);
}

/** A receipt is final: forget the pending command; a retryable status frees the intent. */
export function acknowledgeControlCommand(receipt: { commandId?: unknown; status?: unknown }): void {
  if (typeof receipt.commandId !== 'string') return;
  pendingCommands.delete(receipt.commandId);
  if (!RETRYABLE_STATUSES.has(String(receipt.status))) return;
  for (const [intent, commandId] of intentCommandIds) {
    if (commandId === receipt.commandId) intentCommandIds.delete(intent);
  }
}

/** After a reconnect: resends commands younger than 30 s, drops older ones. */
export function resendPendingControlCommands(
  send: (message: Record<string, unknown>) => unknown,
  now: number = Date.now(),
): number {
  let resent = 0;
  for (const [commandId, pending] of [...pendingCommands]) {
    if (now - pending.firstSentAt > RESEND_WINDOW_MS) {
      pendingCommands.delete(commandId);
      continue;
    }
    send(pending.payload);
    resent += 1;
  }
  return resent;
}

/** Clears all module state (tests, identity change). */
export function resetControlCommandState(): void {
  turnKeys.clear();
  pendingSends.clear();
  intentCommandIds.clear();
  pendingCommands.clear();
}
