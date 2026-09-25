import crypto from 'node:crypto';

import type Database from 'better-sqlite3';

import { getConnection } from '../connection.js';

import {
  isWorkspaceTopologyFenceCurrent,
  type WorkspaceTopologyFence,
} from './project-access.js';
import type { EngineRestampIntent } from './engine-restamp-intent.db.js';

declare const engineRestampAuthorityBrand: unique symbol;
export type EngineRestampAuthorityCapture = Readonly<{
  readonly [engineRestampAuthorityBrand]: true;
  sessionId: string;
  actor: EngineRestampIntent['actor'];
  workspaceFence: WorkspaceTopologyFence;
  projectBinding: EngineRestampIntent['projectBinding'];
}>;

const captures = new WeakSet<object>();
const tokenIds = new WeakMap<object, string>();
const tokenId = (token: object): string => {
  let value = tokenIds.get(token);
  if (!value) { value = crypto.randomUUID(); tokenIds.set(token, value); }
  return value;
};
const sha256 = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const fail = (code: string): never => { throw new Error(code); };
const actorEqual = (left: EngineRestampIntent['actor'], right: EngineRestampIntent['actor']): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
const bindingEqual = (
  left: EngineRestampIntent['projectBinding'],
  right: EngineRestampIntent['projectBinding'],
): boolean => JSON.stringify(left) === JSON.stringify(right);

function fenceDigest(fence: WorkspaceTopologyFence): string {
  return sha256(fence.kind === 'project'
    ? JSON.stringify({ schema: 'nassaj-engine-restamp-project-fence/v1', kind: fence.kind,
      projectId: fence.projectId, userId: fence.userId, process: tokenId(fence.processInstance),
      subject: tokenId(fence.subjectAccessToken), structure: tokenId(fence.projectStructureToken) })
    : JSON.stringify({ schema: 'nassaj-engine-restamp-project-fence/v1', kind: fence.kind,
      userId: fence.userId, resolvedPath: fence.resolvedPath, sessionId: fence.sessionId,
      consent: fence.consent, process: tokenId(fence.processInstance),
      topology: tokenId(fence.workspaceTopologyToken) }));
}

/** Captures the exact boot-local project/session authority used to construct one durable intent. */
export function captureEngineRestampAuthority(input: Readonly<{
  sessionId: string;
  actor: EngineRestampIntent['actor'];
  workspaceFence: WorkspaceTopologyFence;
  controllerUserId: number;
}>): EngineRestampAuthorityCapture {
  if (!input.sessionId || input.workspaceFence.userId !== input.actor.userId
      || !Number.isSafeInteger(input.controllerUserId) || input.controllerUserId <= 0
      || !isWorkspaceTopologyFenceCurrent(input.workspaceFence)) {
    return fail('ENGINE_RESTAMP_AUTHORITY_CAPTURE_INVALID');
  }
  if (input.workspaceFence.kind === 'projectless'
      && (input.workspaceFence.sessionId !== input.sessionId
        || input.workspaceFence.consent !== 'control')) {
    return fail('ENGINE_RESTAMP_AUTHORITY_CAPTURE_INVALID');
  }
  const authorityFenceSha256 = fenceDigest(input.workspaceFence);
  const actor = Object.freeze({ ...input.actor }) as EngineRestampIntent['actor'];
  const projectBinding: EngineRestampIntent['projectBinding'] = input.workspaceFence.kind === 'project'
    ? { kind: 'project', projectId: input.workspaceFence.projectId,
      participantUserId: actor.userId, controllerUserId: input.controllerUserId,
      authorityFenceSha256 }
    : { kind: 'projectless', workspaceId: input.workspaceFence.resolvedPath, authorityFenceSha256 };
  const capture = Object.freeze({ sessionId: input.sessionId, actor,
    workspaceFence: input.workspaceFence, projectBinding: Object.freeze(projectBinding) }) as EngineRestampAuthorityCapture;
  captures.add(capture);
  return capture;
}

function assertPrincipal(db: Database.Database, actor: EngineRestampIntent['actor']): void {
  const user = db.prepare(`SELECT 1 FROM users WHERE id = ? AND authorization_generation = ?
    AND is_active = 1 AND status = 'active'`).get(actor.userId, actor.authorizationGeneration);
  if (!user) fail('ENGINE_RESTAMP_PRINCIPAL_STALE');
  if (actor.kind === 'device') {
    const current = db.prepare(`SELECT 1 FROM device_sessions d JOIN device_account_slots s
      ON s.id = d.active_slot_id AND s.device_session_id = d.id AND s.revoked_at IS NULL
      JOIN users u ON u.id = s.user_id AND u.is_active = 1 AND u.status = 'active'
        AND u.must_change_password = 0 AND s.password_stamp = u.password_changed_at
      WHERE d.id = ? AND d.active_slot_id = ? AND d.generation = ? AND s.user_id = ?
        AND u.authorization_generation = ? AND d.revoked_at IS NULL AND d.expires_at > ?`).get(
      actor.deviceSessionId, actor.slotId, actor.deviceGeneration, actor.userId,
      actor.authorizationGeneration, Date.now());
    if (!current) fail('ENGINE_RESTAMP_DEVICE_STALE');
  }
  if (actor.kind === 'ck') {
    const match = /^api-key:(\d+)$/u.exec(actor.authenticationCredentialId);
    const current = match && db.prepare(`SELECT 1 FROM api_keys
      WHERE id = ? AND user_id = ? AND is_active = 1`).get(Number(match[1]), actor.userId);
    if (!current) fail('ENGINE_RESTAMP_CREDENTIAL_STALE');
  }
}

/** Revalidates every captured principal, session and project dimension on the caller's transaction. */
export function assertEngineRestampAuthorityOnConnection(
  db: Database.Database,
  capture: EngineRestampAuthorityCapture,
  intent: EngineRestampIntent,
): void {
  if (!db.inTransaction || db !== getConnection() || !captures.has(capture)
      || capture.sessionId !== intent.sessionId || !actorEqual(capture.actor, intent.actor)
      || !bindingEqual(capture.projectBinding, intent.projectBinding)
      || intent.projectBinding.authorityFenceSha256 !== fenceDigest(capture.workspaceFence)) {
    return fail('ENGINE_RESTAMP_AUTHORITY_STALE');
  }
  assertPrincipal(db, intent.actor);
  if (!isWorkspaceTopologyFenceCurrent(capture.workspaceFence)) fail('ENGINE_RESTAMP_PROJECT_FENCE_STALE');
  const session = db.prepare(`SELECT project_path AS projectPath, provider,
    engine_provider AS engine, engine_provider_source AS source
    FROM sessions WHERE session_id = ?`).get(intent.sessionId) as
    { projectPath: string | null; provider: string; engine: string | null; source: string | null } | undefined;
  if (!session || session.provider !== 'claude') throw new Error('ENGINE_RESTAMP_SESSION_PIN_STALE');
  if (session.engine !== intent.fromPin.engine || session.source !== intent.fromPin.source) {
    fail('ENGINE_RESTAMP_SESSION_PIN_STALE');
  }
  const currentSession = session;
  const participant = db.prepare(`SELECT 1 FROM session_participants
    WHERE session_id = ? AND user_id = ? AND attribution = 'spawn' LIMIT 1`).get(
    intent.sessionId, intent.actor.userId);
  if (!participant) fail('ENGINE_RESTAMP_PARTICIPANT_STALE');
  if (intent.projectBinding.kind === 'project') {
    if (intent.projectBinding.participantUserId !== intent.actor.userId
        || capture.workspaceFence.kind !== 'project'
        || capture.workspaceFence.projectId !== intent.projectBinding.projectId) {
      fail('ENGINE_RESTAMP_PROJECT_BINDING_STALE');
    }
    const project = db.prepare(`SELECT 1 FROM projects
      WHERE project_id = ? AND project_path = ? AND isArchived = 0`).get(
      intent.projectBinding.projectId, currentSession.projectPath);
    const controller = db.prepare(`SELECT MIN(user_id) AS userId,
      MIN(attribution) AS attribution FROM session_participants
      WHERE session_id = ? AND role = 'owner' HAVING COUNT(*) = 1`).get(intent.sessionId) as
      { userId: number; attribution: string } | undefined;
    if (!project || controller?.userId !== intent.projectBinding.controllerUserId
        || controller.attribution !== 'spawn') {
      fail('ENGINE_RESTAMP_PROJECT_BINDING_STALE');
    }
  } else if (capture.workspaceFence.kind !== 'projectless'
      || currentSession.projectPath !== intent.projectBinding.workspaceId
      || capture.workspaceFence.resolvedPath !== intent.projectBinding.workspaceId
      || capture.workspaceFence.sessionId !== intent.sessionId
      || capture.workspaceFence.consent !== 'control') {
    fail('ENGINE_RESTAMP_PROJECT_BINDING_STALE');
  }
}
