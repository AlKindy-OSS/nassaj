import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import { recordStrictAuditOnConnection } from './repositories/audit-log.js';
import { DeletionOperationError, DELETION_MAX_SESSIONS } from './deletion-operation.contract.js';
import type { DeleteCommand, DeleteTarget, DeleteSession, VerifiedInventory, DeleteResult, CleanupCounts } from './deletion-operation.contract.js';
import { deleteSessionSidecars, deleteProjectSidecars } from './deletion-sidecars.js';
import { withProjectMemberIntent } from './deletion-guards.js';

const RESULT_RETAINED = Object.freeze(['deletion_markers','audit','cost_ledger','existing_backups']);
type GenerationRow = {projectId:string;generation:string;projectPath:string;fingerprint:string;keyVersion:number};

/** Repository owns every SQL statement; services compose methods without issuing queries. */
export function createDeletionOperationRepository(db: Database.Database) {
  return {
    db,
    loadTarget(command: DeleteCommand): DeleteTarget {
      const root=command.targetKind==='project'
        ? db.prepare('SELECT project_id AS id FROM projects WHERE project_id=?').get(command.targetId) as {id:string}|undefined
        : db.prepare('SELECT p.project_id AS id FROM sessions s JOIN projects p ON p.project_path=s.project_path WHERE s.session_id=?').get(command.targetId) as {id:string}|undefined;
      if(!root) throw new DeletionOperationError('DELETION_NOT_FOUND',404);
      const generation=db.prepare(`SELECT p.project_id AS projectId,p.project_path AS projectPath,g.generation,g.path_fingerprint AS fingerprint,g.key_version AS keyVersion
        FROM projects p JOIN project_generations g ON g.project_id=p.project_id WHERE p.project_id=? AND g.state='active'`).get(root.id) as GenerationRow|undefined;
      if(!generation) throw new DeletionOperationError('DELETION_GENERATION_UNPROVEN');
      const sessions=db.prepare(`SELECT s.session_id AS sessionId,s.provider,b.source_identity AS sourceIdentity,b.project_id AS projectId,b.generation
        FROM sessions s LEFT JOIN session_generation_bindings b ON b.session_id=s.session_id
        WHERE ((?='project' AND (s.project_path=? OR b.project_id=?)) OR (?='session' AND s.session_id=?)) LIMIT ?`)
        .all(command.targetKind,generation.projectPath,root.id,command.targetKind,command.targetId,DELETION_MAX_SESSIONS+1) as DeleteSession[];
      if(sessions.length>DELETION_MAX_SESSIONS || sessions.some(row=>row.projectId!==root.id||row.generation!==generation.generation||!row.sourceIdentity)) throw new DeletionOperationError('DELETION_GENERATION_UNPROVEN');
      return {...generation,sessions};
    },
    readReplay(command:DeleteCommand,requestHash:string):DeleteResult|null {
      const row=readOperationSnapshot(db,command.operationId);
      if(!row)return null;
      if(row.actor_id!==command.actorId)throw new DeletionOperationError('DELETION_NOT_FOUND',404);
      if(row.request_hash!==requestHash||row.target_kind!==command.targetKind||row.target_id!==command.targetId)throw new DeletionOperationError('DELETION_OPERATION_CONFLICT',409);
      return operationResult(db,command.operationId,row);
    },
    assertSourcesBelong(target:DeleteTarget,inventory:VerifiedInventory):void {
      const members=inventory.sources.flatMap(source=>source.members);
      const mismatch=db.prepare(`SELECT 1 FROM json_each(?) member JOIN sessions s ON s.session_id=json_extract(member.value,'$.sessionId')
        LEFT JOIN session_generation_bindings b ON b.session_id=s.session_id
        WHERE s.provider IS NOT json_extract(member.value,'$.provider') OR b.project_id IS NOT ? OR b.generation IS NOT ?
          OR b.source_identity IS NOT json_extract(member.value,'$.sourceIdentity') LIMIT 1`).get(JSON.stringify(members),target.projectId,target.generation);
      if(mismatch)throw new DeletionOperationError('DELETION_SOURCE_IDENTITY_MISMATCH');
    },
    recordBatch(command:DeleteCommand,target:DeleteTarget,inventory:VerifiedInventory,requestHash:string):void {
      db.prepare(`INSERT INTO project_deletion_records(operation_id,project_id,generation,request_hash,scope,database_state,cleanup_state,created_at,actor_id,target_kind,target_id)
        VALUES(?,?,?,?,?,'prepared','pending',CURRENT_TIMESTAMP,?,?,?)`).run(command.operationId,target.projectId,target.generation,requestHash,command.scope,command.actorId,command.targetKind,command.targetId);
      const insert=db.prepare('INSERT INTO session_delete_batch_members(operation_id,session_id,project_id,generation) VALUES(?,?,?,?)');
      const ids=new Set([...target.sessions.map(row=>row.sessionId),...inventory.sources.flatMap(source=>source.members.map(row=>row.sessionId))]);
      for(const id of ids)insert.run(command.operationId,id,target.projectId,target.generation);
    },
    recordWitnesses(command:DeleteCommand,target:DeleteTarget,inventory:VerifiedInventory):void {
      const providers=new Map(target.sessions.map(row=>[row.sessionId,row.provider]));
      for(const source of inventory.sources)for(const member of source.members)providers.set(member.sessionId,member.provider);
      const record=()=>{
        const insert=db.prepare('INSERT INTO session_tombstones(session_id,provider,project_path,source_path,deleted_by,operation_id) VALUES(?,?,NULL,NULL,NULL,?)');
        for(const [id,provider] of providers)insert.run(id,provider,command.operationId);
      };
      if(command.targetKind==='project'){
        db.prepare('INSERT INTO project_tombstones(project_id,generation,operation_id,deleted_at,path_fingerprint,key_version) VALUES(?,?,?,CURRENT_TIMESTAMP,?,?)').run(target.projectId,target.generation,command.operationId,target.fingerprint,target.keyVersion);
        withProjectMemberIntent(db,record);
      }else record();
    },
    recordSources(command:DeleteCommand,target:DeleteTarget,inventory:VerifiedInventory):void {
      const sourceStmt=db.prepare('INSERT INTO deletion_source_manifests(operation_id,store_identity,project_id,generation,writer_fence,inventory_digest,boundary_proof) VALUES(?,?,?,?,?,?,?)');
      const memberStmt=db.prepare('INSERT INTO deletion_source_manifest_members(operation_id,store_identity,source_identity,session_id,target_identity) VALUES(?,?,?,?,?)');
      for(const source of inventory.sources){
        sourceStmt.run(command.operationId,source.storeIdentity,target.projectId,target.generation,source.writerFence,source.inventoryDigest,source.boundaryProof);
        for(const member of source.members){
          memberStmt.run(command.operationId,source.storeIdentity,member.sourceIdentity,member.sessionId,member.targetIdentity);
          recordOutbox(db,command,target,source.storeIdentity,member.targetIdentity,member.targetKind,member.sessionId);
        }
      }
      for(const directory of inventory.directoryTargets)recordOutbox(db,command,target,directory.storeIdentity,directory.targetIdentity,directory.targetKind,null);
    },
    recordAudit(command:DeleteCommand,target:DeleteTarget):void {
      const members=db.prepare('SELECT session_id AS sessionId FROM session_delete_batch_members WHERE operation_id=?').all(command.operationId) as {sessionId:string}[];
      for(const session of members)recordStrictAuditOnConnection(db,'session_permanently_deleted',{userId:command.actorId,metadata:{operationId:command.operationId,sessionId:session.sessionId}});
      if(command.targetKind==='project')recordStrictAuditOnConnection(db,'project_permanently_deleted',{userId:command.actorId,metadata:{operationId:command.operationId,projectId:target.projectId,generation:target.generation,scope:command.scope}});
    },
    removeRows(command:DeleteCommand,target:DeleteTarget):void {
      deleteSessionSidecars(db,command.operationId);
      const remove=()=>{
        db.prepare(`INSERT INTO session_delete_intents(session_id,operation_id,intent_type,restore_nonce,transaction_nonce)
          SELECT s.session_id,nassaj_deletion_operation(),nassaj_deletion_intent(),nassaj_deletion_restore(),nassaj_deletion_transaction()
          FROM sessions s JOIN session_delete_batch_members b ON b.session_id=s.session_id WHERE b.operation_id=?`).run(command.operationId);
        db.prepare('DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)').run(command.operationId);
      };
      if(command.targetKind==='project'){
        withProjectMemberIntent(db,remove);deleteProjectSidecars(db,target.projectId);
        db.prepare("UPDATE project_generations SET state='suppressed' WHERE project_id=? AND generation=?").run(target.projectId,target.generation);
        db.prepare('INSERT INTO project_lifecycle_transitions(operation_id,project_id,generation,previous_generation,action,request_hash,created_at) SELECT operation_id,project_id,generation,NULL,\'delete\',request_hash,CURRENT_TIMESTAMP FROM project_deletion_records WHERE operation_id=?').run(command.operationId);
        db.prepare('INSERT INTO project_delete_intents(project_id,operation_id,intent_type,restore_nonce,transaction_nonce) VALUES(?,nassaj_deletion_operation(),nassaj_deletion_intent(),nassaj_deletion_restore(),nassaj_deletion_transaction())').run(target.projectId);
        db.prepare('DELETE FROM projects WHERE project_id=?').run(target.projectId);
      }else remove();
      if(db.prepare('SELECT 1 FROM sessions s JOIN session_delete_batch_members b ON b.session_id=s.session_id WHERE b.operation_id=? LIMIT 1').get(command.operationId))throw new DeletionOperationError('DELETION_ROWS_REMAIN');
      db.prepare("UPDATE project_deletion_records SET database_state='committed' WHERE operation_id=?").run(command.operationId);
    },
    result(operationId:string):DeleteResult{return operationResult(db,operationId);},
  };
}

function recordOutbox(db:Database.Database,command:DeleteCommand,target:DeleteTarget,store:string,identity:string,kind:string,sessionId:string|null):void {
  const jobId=createHash('sha256').update(JSON.stringify([command.operationId,store,identity,kind])).digest('hex');
  db.prepare(`INSERT INTO session_artifact_cleanup_outbox(job_id,operation_id,session_id,project_id,generation,store_identity,target_identity,target_kind,state)
    VALUES(?,?,?,?,?,?,?,?,'pending')`).run(jobId,command.operationId,sessionId,target.projectId,target.generation,store,identity,kind);
}
type OperationSnapshot = CleanupCounts & {
  actor_id: number; target_kind: string; target_id: string; request_hash: string;
  database_state: string; total: number;
};

/** A single SQLite statement pins operation existence, identity, commit state and all job counts. */
function readOperationSnapshot(db: Database.Database, operationId: string): OperationSnapshot | undefined {
  try {
    return db.prepare(`SELECT o.actor_id,o.target_kind,o.target_id,o.request_hash,o.database_state,
      count(j.job_id) AS total,
      sum(CASE WHEN j.state='pending' THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN j.state='leased' THEN 1 ELSE 0 END) AS leased,
      sum(CASE WHEN j.state='retry' THEN 1 ELSE 0 END) AS retry,
      sum(CASE WHEN j.state='succeeded' THEN 1 ELSE 0 END) AS succeeded,
      sum(CASE WHEN j.state='blocked' THEN 1 ELSE 0 END) AS blocked,
      sum(CASE WHEN j.state='retained' THEN 1 ELSE 0 END) AS retained
      FROM project_deletion_records o LEFT JOIN session_artifact_cleanup_outbox j ON j.operation_id=o.operation_id
      WHERE o.operation_id=? GROUP BY o.operation_id`).get(operationId) as OperationSnapshot | undefined;
  } catch { throw new DeletionOperationError('DELETION_CLEANUP_UNAVAILABLE'); }
}

function operationResult(db: Database.Database, operationId: string, snapshot?: OperationSnapshot): DeleteResult {
  const row = snapshot ?? readOperationSnapshot(db, operationId);
  if (!row) throw new DeletionOperationError('DELETION_NOT_FOUND', 404);
  if (row.database_state !== 'committed') throw new DeletionOperationError('DELETION_OPERATION_INCOMPLETE');
  const cleanupCounts: CleanupCounts = {
    pending: row.pending, leased: row.leased, retry: row.retry,
    succeeded: row.succeeded, blocked: row.blocked, retained: row.retained,
  };
  const counts = Object.values(cleanupCounts);
  if (!Number.isSafeInteger(row.total) || row.total < 0 || counts.some(count => !Number.isSafeInteger(count) || count < 0)
    || counts.reduce((sum, count) => sum + count, 0) !== row.total) throw new DeletionOperationError('DELETION_CLEANUP_UNPROVEN');
  const artifactCleanup = row.total === 0 ? 'not_applicable' : row.blocked ? 'blocked'
    : row.pending || row.leased || row.retry ? 'pending' : row.retained ? 'retained' : 'succeeded';
  return { operationId, status: 202, databaseDeletion: 'committed', artifactCleanup, cleanupCounts, retainedClasses: RESULT_RETAINED };
}
