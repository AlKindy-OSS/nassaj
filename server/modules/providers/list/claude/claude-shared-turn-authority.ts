/**
 * claude-shared-turn-authority — ADR-173 rev.3 P5: what a member other than the
 * starter of a Claude turn may do with it.
 *
 * - Approvals: prompts belong to the starter. A non-starter's answer is admitted only
 *   while `isSharedSessionWriter` holds AT ANSWER TIME, is reduced to allow/deny (no
 *   edited input, no remember rule), and a deny text is capped and attributed.
 * - External-identity tools (`mcp__*`, connectors included) act on the starter's
 *   accounts, an AskUserQuestion answer is edited input (M-c) and a plan approval is
 *   the starter's decision (qa r2 #3), so only the starter may answer them.
 * - Stop (owner decision 2): the starter, the project owner and a platform admin
 *   always; any other shared writer only while the turn is stuck.
 *
 * The authority lives at the chat boundary; the composition root injects it, so this
 * module never imports the websocket graph. Unconfigured = nobody is admitted.
 */

import crypto from 'node:crypto';

import * as database from '@/modules/database/index.js';
import { createNormalizedMessage } from '@/shared/utils.js';

import { isForeignRunSender } from './claude-run-occupancy.js';

export const NON_STARTER_DENY_TEXT_MAX = 500;

const EXTERNAL_IDENTITY_TOOL = /^mcp__/u;

type SessionUserCheck = (sessionId: string, userId: unknown) => boolean;

export interface SharedTurnAuthority {
  /** ADR-173 isSharedSessionWriter (send gate AND explicit membership). */
  isSharedWriter: SessionUserCheck;
  /** Project owner or platform owner/admin, with write. */
  isStopPrivileged: SessionUserCheck;
}

const DENY_ALL: SharedTurnAuthority = { isSharedWriter: () => false, isStopPrivileged: () => false };
let authority: SharedTurnAuthority = DENY_ALL;

/** Composition root wiring; a partial update keeps the other predicate. */
export function configureClaudeSharedTurnAuthority(next: Partial<SharedTurnAuthority>): void {
  authority = { ...authority, ...next };
}

function holds(check: SessionUserCheck, sessionId: string, userId: unknown): boolean {
  if (!sessionId) return false;
  try {
    return check(sessionId, userId) === true;
  } catch {
    return false;
  }
}

/** Fail-closed shared-writer check, evaluated at the moment it is asked. */
export function isSharedTurnWriter(sessionId: string, userId: unknown): boolean {
  return holds(authority.isSharedWriter, sessionId, userId);
}

/** Whether `toolName` acts on the starter's external identity (MCP servers, connectors). */
export function isExternalIdentityTool(toolName: unknown): boolean {
  return typeof toolName === 'string' && EXTERNAL_IDENTITY_TOOL.test(toolName);
}

/** Interactive prompts that are the starter's own decision (M-c, qa r2 #3). */
const STARTER_ONLY_INTERACTIVE_TOOLS: ReadonlySet<unknown> = new Set(['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode']);

/**
 * Prompts only the turn's starter may answer: external-identity tools; AskUserQuestion
 * (M-c), whose answer IS edited input a non-starter cannot supply; and the plan approval
 * (ExitPlanMode), which other members see read-only.
 */
export function isStarterOnlyTool(toolName: unknown): boolean {
  return isExternalIdentityTool(toolName) || STARTER_ONLY_INTERACTIVE_TOOLS.has(toolName);
}

/** A non-starter's answer: allow or deny only; a deny text capped and prefixed with its author. */
export function boundNonStarterDecision(
  decision: { allow?: unknown; message?: unknown },
  authorName: string,
): { allow: boolean; message?: string } {
  if (decision.allow === true) return { allow: true };
  const text = typeof decision.message === 'string' ? decision.message.trim() : '';
  const capped = text.slice(0, NON_STARTER_DENY_TEXT_MAX);
  return { allow: false, message: capped ? `${authorName}: ${capped}` : `${authorName} denied this tool use.` };
}

/** sha256 of an answer text for the audit row (the text itself is never stored). */
export function hashDecisionText(text: unknown): string | null {
  return typeof text === 'string' && text
    ? crypto.createHash('sha256').update(text, 'utf8').digest('hex')
    : null;
}

export type TurnStopRole = 'starter' | 'privileged' | 'stuck_writer';

/** Stop rights over a running turn (owner decision 2). */
export function decideTurnStop(input: {
  sessionId: string;
  requesterUserId: unknown;
  starterUserId: unknown;
  stuck: boolean;
}): { allowed: boolean; role: TurnStopRole | null } {
  const { sessionId, requesterUserId } = input;
  if (!isForeignRunSender(input.starterUserId, requesterUserId)) return { allowed: true, role: 'starter' };
  if (requesterUserId === null || requesterUserId === undefined) return { allowed: false, role: null };
  if (holds(authority.isStopPrivileged, sessionId, requesterUserId)) return { allowed: true, role: 'privileged' };
  if (input.stuck && isSharedTurnWriter(sessionId, requesterUserId)) return { allowed: true, role: 'stuck_writer' };
  return { allowed: false, role: null };
}

/** The member's display name for an attributed deny text. */
export function memberDisplayName(userId: unknown): string {
  const id = Number(userId);
  try {
    const name = Number.isInteger(id) ? database.userDb.getUserById(id)?.username : null;
    if (typeof name === 'string' && name) return name;
  } catch {
    /* fall through to the neutral label */
  }
  return Number.isInteger(id) ? `member ${id}` : 'another member';
}

/** Records a P5 audit row; a failed write is logged, never thrown into the run path. */
export function auditSharedTurn(
  action: 'shared_turn_approval' | 'shared_turn_stop',
  userId: unknown,
  metadata: Record<string, unknown>,
): void {
  const id = Number(userId);
  try {
    database.auditLogDb.record(action, { userId: Number.isInteger(id) ? id : null, metadata });
  } catch (error) {
    console.warn(`[ADR-173] ${action} audit not recorded`, {
      sessionId: metadata.sessionId ?? null, error: (error as { code?: unknown })?.code ?? 'error',
    });
  }
}

/**
 * ADR-173 P8 B3: whether a turn's prompt is announced as `user_turn`. A shared
 * writer's bridged turn always was (P6); since P8 every turn is, the creator's own
 * included, while another viewer watches the conversation. A relayed peer delivery
 * is never a human prompt; flag '0' keeps today's behaviour.
 */
export function shouldAnnounceUserTurn(input: {
  sharingEnabled: boolean;
  peerDelivery: boolean;
  bridgedSharedResume: boolean;
  otherViewers: boolean;
}): boolean {
  if (!input.sharingEnabled || input.peerDelivery) return false;
  return input.bridgedSharedResume || input.otherViewers;
}

/**
 * ADR-173 P6: the `user_turn` frame carrying a turn's prompt to the other viewers.
 * Sent through the run's writer, so it takes the ADR-210 masking and reaches only the
 * session's mirrors (registered behind the B-137 visibility gate). P8 B1:
 * `messageUuid` is the uuid the CLI writes for this prompt's transcript row, so a
 * viewer replaces the live bubble with the synced row (row id `messageUuid`, or
 * `${messageUuid}_text_<n>` for block content).
 */
export function sharedUserTurnFrame(input: {
  sessionId: string;
  content: string;
  authorUserId: unknown;
  clientMsgId: unknown;
  imageCount: number;
  messageUuid?: string | null;
}): ReturnType<typeof createNormalizedMessage> {
  return createNormalizedMessage({
    kind: 'user_turn', provider: 'claude', sessionId: input.sessionId, role: 'user',
    content: input.content, authorUserId: input.authorUserId ?? null,
    authorName: memberDisplayName(input.authorUserId),
    ...(typeof input.clientMsgId === 'string' && input.clientMsgId ? { clientMsgId: input.clientMsgId } : {}),
    ...(input.imageCount > 0 ? { imageCount: input.imageCount } : {}),
    ...(typeof input.messageUuid === 'string' && input.messageUuid ? { messageUuid: input.messageUuid } : {}),
  });
}
