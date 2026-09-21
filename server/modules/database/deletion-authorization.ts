import type Database from 'better-sqlite3';

import { DeletionOperationError, DELETION_MAX_SESSIONS } from './deletion-operation.contract.js';
import type { DeleteCommand, DeleteTarget } from './deletion-operation.contract.js';

/** Reload persisted authentication inside IMMEDIATE; request roles are never trusted. */
export function requireActiveDeletionActor(db: Database.Database, actorId: number): { owner: boolean } {
  if (!db.inTransaction || !Number.isSafeInteger(actorId) || actorId < 1) throw new DeletionOperationError('DELETION_NOT_FOUND',404);
  const user=db.prepare("SELECT role FROM users WHERE id=? AND is_active=1 AND status='active'").get(actorId) as {role:string}|undefined;
  if (!user) throw new DeletionOperationError('DELETION_NOT_FOUND',404);
  return {owner:user.role==='owner'};
}

/** ADR-104 existing consent predicate: spawn OR message_authors. JSON batch binds values, never identifiers. */
export function readDeletionParticipants(db:Database.Database,sessionIds:readonly string[],actorId:number):ReadonlySet<string> {
  requireActiveDeletionActor(db,actorId);
  if(sessionIds.length>DELETION_MAX_SESSIONS)throw new DeletionOperationError('DELETION_BATCH_LIMIT');
  const rows=db.prepare(`SELECT value AS sessionId FROM json_each(?) candidate WHERE
    EXISTS(SELECT 1 FROM session_participants sp WHERE sp.session_id=candidate.value AND sp.user_id=? AND sp.attribution='spawn') OR
    EXISTS(SELECT 1 FROM message_authors ma WHERE ma.session_id=candidate.value AND ma.user_id=?)`).all(JSON.stringify(sessionIds),actorId,actorId) as {sessionId:string}[];
  return new Set(rows.map(row=>row.sessionId));
}

/** Existing project-management rule: creator/project owner/system owner; project-write alone is insufficient. */
export function assertDeletionProjectManager(db:Database.Database,projectId:string,actorId:number):void {
  const actor=requireActiveDeletionActor(db,actorId);
  const row=db.prepare(`SELECT p.project_id FROM projects p WHERE p.project_id=? AND (?=1 OR p.created_by=? OR
    EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.project_id AND pm.user_id=? AND pm.role='owner'))`).get(projectId,actor.owner?1:0,actorId,actorId);
  if(!row)throw new DeletionOperationError('DELETION_NOT_FOUND',404);
}

/** Each source/session identity needs the same established consent; system owner is the ADR-120-only override. */
export function assertDeletionSessionAuthority(db:Database.Database,sessionIds:readonly string[],actorId:number):void {
  if(requireActiveDeletionActor(db,actorId).owner)return;
  const participating=readDeletionParticipants(db,sessionIds,actorId);
  if(sessionIds.some(id=>!participating.has(id)))throw new DeletionOperationError('DELETION_NOT_FOUND',404);
}

/** Project authority supplements, never replaces, the authority over every captured session. */
export function assertDeletionAuthority(db: Database.Database, command: DeleteCommand, target: DeleteTarget): void {
  if(command.targetKind==='project')assertDeletionProjectManager(db,target.projectId,command.actorId);
  assertDeletionSessionAuthority(db,target.sessions.map(row=>row.sessionId),command.actorId);
}
