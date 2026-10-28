/**
 * ADR-219 S1 — the relay's intake: a relayed SendMessage becomes a durable
 * `peer_messages` row (queued or refused), and ListAgents becomes the caller
 * user's own sessions. Identity, mode and hop come from the sender's run entry
 * and the server's tables, never from the tool input.
 *
 * External seams (project write predicate, dispatcher kick, UI fan-out) are
 * injected at the composition root; unconfigured they fail closed.
 */

import { randomUUID } from 'node:crypto';

import { auditLogDb, sessionsDb, type AuditAction, type PeerMessageRow } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/dependencies -- ADR-219: the relay's own tables, imported as leaves so a test that mocks the database barrel (for claude-sdk.js) does not have to know them.
import { peerMessagesDb } from '@/modules/database/repositories/peer-messages.db.js';

import { buildPeerMessageFrame, toPeerMessageView, type PeerMessageView } from './peer-events.js';
import type { PeerHookDependencies } from './peer-hook.js';
import {
  decideS1Acl, isThrottled, modeCategory, S1_REFUSAL_TEXT, type AclVerdict, type PeerModeCategory,
} from './peer-policy.js';
import type { ListedSession } from './peer-recipient.js';
import { readActiveMembers } from './peer-spawn-policy.js';
import { toPeerTurnResult, type PeerDeliveryTurn, type PeerRunState } from './peer-run.js';
import { escapePeerWrapperTags, isAttributeId, newPeerRefToken, preparePeerBody, sha256Hex } from './peer-wire.js';

const HOUR_MS = 60 * 60 * 1000;
const LIST_LIMIT = 20;
const SUMMARY_MAX = 200;

export type PeerRelayDependencies = {
  /** ADR-089 write predicate (chat-websocket isSessionWritableByUser). */
  canWriteSession: (sessionId: string, userId: number) => boolean;
  /** Wakes the dispatcher after a row was queued. */
  kickDispatcher: () => void;
  /** Delivers a serialized frame to a session's gated mirrors. */
  notifySession: (sessionId: string, serialized: string) => void;
  activeMemberCount: () => number;
  /** The session's recorded effective mode for its owner (null = unknown). */
  sessionPermissionMode: (sessionId: string, ownerUserId: number | null) => string | null;
  /** Why delivery cannot run on this node (kill switch, ignoring dispatch path), or null. */
  deliveryUnavailable: () => string | null;
  now: () => number;
};

/**
 * A session's EFFECTIVE permission mode as nassaj last spawned it for `ownerUserId`
 * (the `session_permission_modes` record), or null when no such spawn was recorded.
 * The relay's only mode source: never the transcript (ADR-219). Never throws.
 */
export function readSessionMode(sessionId: string, ownerUserId: number | null): string | null {
  if (ownerUserId === null) return null;
  try {
    return peerMessagesDb.getSessionMode(sessionId, ownerUserId);
  } catch {
    return null;
  }
}

/** Records the mode a spawn actually handed the CLI (called by claude-sdk.js at spawn). Never throws. */
export function recordSessionMode(sessionId: string | null, ownerUserId: unknown, permissionMode: unknown): void {
  if (!sessionId || !Number.isInteger(ownerUserId) || (ownerUserId as number) <= 0) return;
  if (typeof permissionMode !== 'string' || !permissionMode) return;
  try {
    peerMessagesDb.setSessionMode(sessionId, ownerUserId as number, permissionMode, deps.now());
  } catch {
    /* a missing table on an old node: the relay then fails closed (mode_unknown) */
  }
}

const defaults: PeerRelayDependencies = {
  canWriteSession: () => false,
  kickDispatcher: () => undefined,
  notifySession: () => undefined,
  activeMemberCount: () => readActiveMembers(),
  sessionPermissionMode: readSessionMode,
  deliveryUnavailable: () => null,
  now: Date.now,
};

let deps: PeerRelayDependencies = { ...defaults };

/** Composition-root seam (server/index.js); tests reset through it too. */
export function configurePeerRelay(overrides: Partial<PeerRelayDependencies>): void {
  deps = { ...deps, ...overrides };
}

/** Test seam: back to the fail-closed defaults plus `overrides`. */
export function resetPeerRelayForTests(overrides: Partial<PeerRelayDependencies> = {}): void {
  deps = { ...defaults, ...overrides };
}

/** Active member count for the spawn-time relay mode (never throws; errors → relay). */
export function readActiveMemberCount(): number {
  return readActiveMembers(() => deps.activeMemberCount());
}

export type PeerSendRequest = {
  run: PeerRunState;
  senderSessionId: string;
  senderAgentId: string | null;
  targetSessionId: string;
  message: string;
  summary: string | null;
  hop: number;
  notifyWhenIdle: boolean;
};

export type PeerSendOutcome = { status: 'queued' | 'refused'; id: string | null; text: string };

const refusal = (text: string, id: string | null = null): PeerSendOutcome => ({ status: 'refused', id, text });

type TargetFacts = { targetUserId: number | null; targetMode: PeerModeCategory | null; projectPath: string | null };

/** The category of a recorded mode; null when the session has no recorded spawn. */
function recordedCategory(mode: string | null): PeerModeCategory | null {
  return mode === null ? null : modeCategory(mode);
}

/** Server facts about the target session, or a refusal text. */
function readTarget(req: PeerSendRequest): TargetFacts | string {
  if (!isAttributeId(req.targetSessionId)) return 'the address is not a nassaj session id';
  if (req.targetSessionId === req.senderSessionId) return 'a session cannot relay a message to itself';
  const row = sessionsDb.getSessionById(req.targetSessionId);
  if (!row || row.provider !== 'claude') return 'no such nassaj Claude session';
  const targetUserId = peerMessagesDb.strictSpawnOwner(req.targetSessionId);
  return {
    targetUserId,
    targetMode: recordedCategory(deps.sessionPermissionMode(req.targetSessionId, targetUserId)),
    projectPath: row.project_path ?? null,
  };
}

function refusalText(verdict: Exclude<AclVerdict, { ok: true }>): string {
  if (verdict.cause === 'unwritable') return 'you cannot write to the target session\'s project';
  if (verdict.cause === 'mode_unknown') return 'the target session\'s permission mode is not known yet (it has not run in nassaj since this update)';
  return S1_REFUSAL_TEXT;
}

/** Inserts the row and returns it (refused rows are kept for audit and the UI). */
function insertRow(req: PeerSendRequest, facts: TargetFacts, verdict: AclVerdict): { row: PeerMessageRow; truncated: boolean } {
  const { body, bytes, truncated } = preparePeerBody(req.message);
  const id = `pm_${randomUUID()}`;
  peerMessagesDb.insert({
    id, ref_token: newPeerRefToken(), chain_id: req.run.chainId ?? `pc_${randomUUID()}`,
    from_user_id: req.run.userId as number, from_session_id: req.senderSessionId, from_agent_id: req.senderAgentId,
    from_mode: req.run.modeCategory, to_user_id: facts.targetUserId, to_session_id: req.targetSessionId,
    project_id: null, body, body_sha256: sha256Hex(body), body_bytes: bytes,
    summary: req.summary ? [...req.summary].slice(0, SUMMARY_MAX).join('') : null, hop: req.hop,
    parent_id: req.run.parentId, notify_when_idle: req.notifyWhenIdle ? 1 : 0,
    state: verdict.ok ? 'queued' : 'refused', cause: verdict.ok ? null : verdict.cause, now: deps.now(),
  });
  return { row: peerMessagesDb.get(id) as PeerMessageRow, truncated };
}

/** Refusals per sender session per hour (qa م-4); beyond it, a refusal leaves no row. */
const REFUSED_ROWS_PER_HOUR = 20;

/** A refusal before any row: no identity, delivery off on this node, or a throttle. */
function preIntakeRefusal(req: PeerSendRequest): string | null {
  if (req.run.userId === null) return 'relay unavailable: the sending run has no member identity';
  const unavailable = deps.deliveryUnavailable();
  if (unavailable) return `relay unavailable: ${unavailable}`;
  const since = deps.now() - HOUR_MS;
  if (isThrottled({ sessionLastHour: peerMessagesDb.countFromSessionSince(req.senderSessionId, since),
    userLastHour: peerMessagesDb.countFromUserSince(req.run.userId, since) })) {
    return 'relay rate limit reached (20 per hour per session, 60 per hour per member); try later';
  }
  return null;
}

/** A refused verdict: a row (for the sender's view) only under the per-session refusal cap. */
function refuseVerdict(req: PeerSendRequest, facts: TargetFacts, verdict: Exclude<AclVerdict, { ok: true }>): PeerSendOutcome {
  const text = `refused: ${refusalText(verdict)}`;
  if (peerMessagesDb.countRefusedFromSessionSince(req.senderSessionId, deps.now() - HOUR_MS) >= REFUSED_ROWS_PER_HOUR) {
    return refusal(text);
  }
  const { row } = insertRow(req, facts, verdict);
  publishPeerMessage(row);
  return refusal(text, row.id);
}

/**
 * Intake of one relayed send. Never throws: a failure is a refusal text the
 * hook returns to the sender. The 20/h and 60/h throttles count accepted rows;
 * refused rows are capped separately (20/h per sender session).
 */
export function enqueuePeerMessage(req: PeerSendRequest): PeerSendOutcome {
  try {
    const early = preIntakeRefusal(req);
    if (early) return refusal(early);
    const facts = readTarget(req);
    if (typeof facts === 'string') return refusal(facts);
    const verdict = decideS1Acl({ senderUserId: req.run.userId as number, senderMode: req.run.modeCategory,
      targetUserId: facts.targetUserId, targetMode: facts.targetMode,
      senderCanWriteTarget: deps.canWriteSession(req.targetSessionId, req.run.userId as number) });
    if (!verdict.ok) return refuseVerdict(req, facts, verdict);
    const { row, truncated } = insertRow(req, facts, verdict);
    publishPeerMessage(row);
    deps.kickDispatcher();
    return { status: 'queued', id: row.id, text: queuedText(row, truncated) };
  } catch (error) {
    auditPeer('peer_relay_intake_failed', null, { error: error instanceof Error ? error.message : String(error) });
    return refusal('relay unavailable: the message could not be recorded');
  }
}

/** The hook's success text (Alternative 3: the deny reason states success). */
export function queuedText(row: Pick<PeerMessageRow, 'id' | 'to_session_id'>, truncated = false): string {
  return `SUCCESS (not an error): nassaj queued this message for session nassaj:${row.to_session_id} `
    + `(relay id ${row.id}). It is delivered when that session is idle. Do not send it again.`
    + (truncated ? ' Note: the message was longer than 8 KB and was cut to 8 KB.' : '');
}

/** A session title as ListAgents shows it: one line, no controls, wrapper tags escaped, ≤ 80 chars. */
function listTitle(title: string): string {
  const plain = title.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return escapePeerWrapperTags([...plain].slice(0, 80).join(''));
}

/** The caller user's own Claude sessions for ListAgents (never cwd, pid or socket paths). */
export function listOwnSessions(userId: number | null, excludeSessionId: string | null): ListedSession[] {
  if (userId === null) return [];
  try {
    return peerMessagesDb.listOwnedClaudeSessions(userId, LIST_LIMIT + 1)
      .filter((s) => s.sessionId !== excludeSessionId)
      .slice(0, LIST_LIMIT)
      .map((s) => ({ sessionId: s.sessionId, title: s.title }));
  } catch {
    return [];
  }
}

/** The ListAgents answer the hook returns. */
export function formatSessionList(sessions: readonly ListedSession[]): string {
  if (sessions.length === 0) return 'SUCCESS (not an error): no other nassaj sessions of yours are available for messages.';
  const lines = sessions.map((s) => `- nassaj:${s.sessionId}${s.title ? ` — ${listTitle(s.title)}` : ''}`);
  return 'SUCCESS (not an error): your nassaj sessions (address one with SendMessage to "nassaj:<id>"):\n'
    + lines.join('\n');
}

/**
 * Sends the row's UI frame to the sender's mirrors, and to the target's unless
 * the row was refused (qa م-4: a refused send never reaches the target). Never throws.
 */
export function publishPeerMessage(row: PeerMessageRow): void {
  try {
    const serialized = JSON.stringify(buildPeerMessageFrame(row, senderName(row.from_session_id), senderName(row.to_session_id)));
    deps.notifySession(row.from_session_id, serialized);
    if (row.state !== 'refused' && row.to_session_id !== row.from_session_id) deps.notifySession(row.to_session_id, serialized);
  } catch {
    /* the UI view must never break the relay */
  }
}

/** Server-derived display name of a session (its sanitized title), never message text. */
export function senderName(sessionId: string): string {
  try {
    const name = sessionsDb.getSessionById(sessionId)?.custom_name;
    const title = typeof name === 'string' ? listTitle(name) : '';
    return title || 'session';
  } catch {
    return 'session';
  }
}

/** Audit line for relay decisions (no body text). Never throws. */
export function auditPeer(action: AuditAction, userId: number | null, metadata: Record<string, unknown>): void {
  try {
    auditLogDb.record(action, { userId, metadata });
  } catch {
    /* auditing must never break the relay */
  }
}

/** Records the session's latest reported total (the next peer turn's baseline). Never throws. */
export function notePeerSessionCost(sessionId: string | null, totalCostUsd: unknown): void {
  if (!sessionId || typeof totalCostUsd !== 'number' || !Number.isFinite(totalCostUsd) || totalCostUsd < 0) return;
  try {
    peerMessagesDb.setCostTotal(sessionId, totalCostUsd, deps.now());
  } catch {
    /* a missing table on an old node must not break a run */
  }
}

/** Records an agent born in a peer-woken run (ح-2 c). Never throws. */
export function notePeerAgentBirth(run: PeerRunState, sessionId: string | null, agentId: unknown): void {
  if (!sessionId || run.peerHop <= 0 || typeof agentId !== 'string' || !agentId) return;
  try {
    peerMessagesDb.recordAgentOriginHop(sessionId, agentId, run.peerHop, deps.now());
  } catch {
    /* fail open on the record: the run's own hop still applies */
  }
}

/** An agent's origin hop (0 when unknown). Never throws; an error reads as the cap. */
export function readAgentOriginHop(sessionId: string, agentId: string): number {
  try {
    return peerMessagesDb.getAgentOriginHop(sessionId, agentId);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

type RunMessage = {
  type?: unknown; subtype?: unknown; parent_tool_use_id?: unknown; claude_code_version?: unknown;
  task_id?: unknown; total_cost_usd?: unknown; is_error?: unknown;
};

/**
 * Live hook for every raw SDK message of a Claude run: records the CLI version
 * (init), agents born in a peer-woken run (task_started), the session's running
 * cost total (each top-level result) and hands a delivery turn its results.
 * Never throws.
 */
export function observePeerRunMessage(run: PeerRunState, delivery: PeerDeliveryTurn | null,
  sessionId: string | null, raw: unknown): void {
  const message = raw && typeof raw === 'object' ? raw as RunMessage : null;
  if (!message) return;
  try {
    if (sessionId && !run.sessionId) run.sessionId = sessionId;
    if (message.type === 'system' && message.subtype === 'init' && typeof message.claude_code_version === 'string') {
      run.cliVersion = message.claude_code_version;
    }
    if (message.type === 'system' && message.subtype === 'task_started') notePeerAgentBirth(run, sessionId, message.task_id);
    if (message.type !== 'result' || message.parent_tool_use_id) return;
    notePeerSessionCost(sessionId, message.total_cost_usd);
    delivery?.onResult(toPeerTurnResult(message as Record<string, unknown>));
  } catch {
    /* the relay's bookkeeping must never break a run */
  }
}

/** The hook's dependencies: this service plus the caller's ADR-218 registry lookup. */
export function createPeerHookDependencies(isKnownAgent: (sessionId: string, value: string) => boolean): PeerHookDependencies {
  return {
    isKnownAgent,
    agentOriginHop: readAgentOriginHop,
    listOwnSessions,
    formatSessionList,
    enqueue: enqueuePeerMessage,
    audit: auditPeer,
  };
}

const HISTORY_LIMIT = 200;

/**
 * The peer rows of a session for `GET /api/sessions/:id/peer-messages` (the
 * caller has passed the session read gate). Refused rows are listed only on
 * the sender's session, as the live frame is (qa م-4).
 */
export function listPeerMessageViews(sessionId: string): PeerMessageView[] {
  return peerMessagesDb.listForSession(sessionId, HISTORY_LIMIT)
    .filter((row) => row.state !== 'refused' || row.from_session_id === sessionId)
    .map((row) => toPeerMessageView(row, senderName(row.from_session_id), senderName(row.to_session_id)))
    .reverse();
}
