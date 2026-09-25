import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { DeletionOperationError } from './deletion-operation.contract.js';
import { requireActiveDeletionActor } from './deletion-authorization.js';
import { recordStrictAuditOnConnection } from './repositories/audit-log.js';

export type PathFingerprint = Readonly<{keyVersion:number;fingerprint:string}>;
export type GenerationAdmission = Readonly<{operationId:string;actorId:number;canonicalPath:string;fingerprints:readonly PathFingerprint[];writeKeyVersion:number}>;
export type ProvenSessionBinding = Readonly<{sessionId:string;projectId:string;generation:string;sourceIdentity:string;proofKind:'nassaj_created'|'provider_boundary';proofDigest:string}>;

/** Data-only repository: caller already owns the verified lifecycle/source capability through commit. No issuer is supplied here. */
export function createDeletionGenerationRepository(
 db:Database.Database,
 options:{offlineProjectionWriter?:boolean}={},
){
 return {
  /** Insert a fresh manual generation or return the same exact replay; never clear earlier identities/history. */
  manualReadd(input:GenerationAdmission):{projectId:string;generation:string}{
   if(options.offlineProjectionWriter!==true)throw new DeletionOperationError('DELETION_OFFLINE_WRITER_REQUIRED');
   requireActiveDeletionActor(db,input.actorId);validateAdmission(input);
   const sortedFingerprints=[...input.fingerprints].sort((a,b)=>a.keyVersion-b.keyVersion);
   const hashes=JSON.stringify(sortedFingerprints);
   const canonicalTuples=sortedFingerprints.map(({keyVersion,fingerprint})=>[keyVersion,fingerprint]);
   const requestHash=createHash('sha256').update(JSON.stringify([input.actorId,input.canonicalPath,canonicalTuples,input.writeKeyVersion])).digest('hex');
   const prior=db.prepare('SELECT project_id AS projectId,generation,request_hash AS requestHash FROM project_lifecycle_transitions WHERE operation_id=?').get(input.operationId) as {projectId:string;generation:string;requestHash:string}|undefined;
   if(prior){if(prior.requestHash!==requestHash)throw new DeletionOperationError('DELETION_OPERATION_CONFLICT',409);return {projectId:prior.projectId,generation:prior.generation};}
   assertRequiredReadKeys(db,input.fingerprints);
   const matching=db.prepare(`SELECT g.project_id AS projectId,g.generation,g.state FROM project_generations g WHERE EXISTS(
    SELECT 1 FROM json_each(?) f WHERE json_extract(f.value,'$.keyVersion')=g.key_version AND json_extract(f.value,'$.fingerprint')=g.path_fingerprint)`).all(hashes) as {projectId:string;generation:string;state:string}[];
   if(matching.some(row=>row.state==='active')||db.prepare('SELECT 1 FROM projects WHERE project_path=?').get(input.canonicalPath))throw new DeletionOperationError('DELETION_PATH_ALREADY_ACTIVE',409);
   assertNoDirectoryCleanup(db,matching);
   const projectId=randomUUID();const generation=randomUUID();const fingerprint=input.fingerprints.find(row=>row.keyVersion===input.writeKeyVersion)!;
   db.prepare("INSERT INTO project_generations(project_id,generation,path_fingerprint,key_version,state,operation_id,request_hash) VALUES(?,?,?,?,'active',?,?)").run(projectId,generation,fingerprint.fingerprint,fingerprint.keyVersion,input.operationId,requestHash);
   db.prepare('INSERT INTO projects(project_id,project_path,created_by) VALUES(?,?,?)').run(projectId,input.canonicalPath,input.actorId);
   db.prepare("INSERT INTO project_lifecycle_transitions(operation_id,project_id,generation,previous_generation,action,request_hash,created_at) VALUES(?,?,?,NULL,'manual_readd',?,CURRENT_TIMESTAMP)").run(input.operationId,projectId,generation,requestHash);
   recordStrictAuditOnConnection(db,'project_manually_readded',{userId:input.actorId,metadata:{operationId:input.operationId,projectId,generation}});
   return {projectId,generation};
  },
  /** Persist ONLY a source binding already admitted by a trusted source capability; this method does not establish source proof. */
  bindProvenSession(input:ProvenSessionBinding):void{
   if(!db.inTransaction||![input.sessionId,input.projectId,input.generation,input.sourceIdentity,input.proofDigest].every(value=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=512)||!['nassaj_created','provider_boundary'].includes(input.proofKind))throw new DeletionOperationError('DELETION_SOURCE_UNPROVEN');
   if(db.prepare('SELECT 1 FROM session_tombstones WHERE session_id=?').get(input.sessionId))throw new DeletionOperationError('DELETION_SESSION_TOMBSTONED');
   if(!db.prepare("SELECT 1 FROM project_generations WHERE project_id=? AND generation=? AND state='active'").get(input.projectId,input.generation))throw new DeletionOperationError('DELETION_GENERATION_UNPROVEN');
   const row=db.prepare('SELECT project_id AS projectId,generation,source_identity AS sourceIdentity,proof_kind AS proofKind,proof_digest AS proofDigest FROM session_generation_bindings WHERE session_id=?').get(input.sessionId) as Omit<ProvenSessionBinding,'sessionId'>|undefined;
   if(row){if(['projectId','generation','sourceIdentity','proofKind','proofDigest'].some(key=>row[key as keyof typeof row]!==input[key as keyof ProvenSessionBinding]))throw new DeletionOperationError('DELETION_SOURCE_IDENTITY_MISMATCH');return;}
   db.prepare('INSERT INTO session_generation_bindings(session_id,project_id,generation,source_identity,proof_kind,proof_digest) VALUES(?,?,?,?,?,?)').run(input.sessionId,input.projectId,input.generation,input.sourceIdentity,input.proofKind,input.proofDigest);
  },
 };
}
function validateAdmission(input:GenerationAdmission):void{
 if(!input.operationId||input.operationId.length>128||!path.posix.isAbsolute(input.canonicalPath)||path.posix.normalize(input.canonicalPath)!==input.canonicalPath||input.canonicalPath.includes('\0')||Buffer.byteLength(input.canonicalPath)>4096||!input.fingerprints.length||input.fingerprints.length>64||!input.fingerprints.some(row=>row.keyVersion===input.writeKeyVersion))throw new DeletionOperationError('DELETION_GENERATION_INPUT_INVALID',400);
 if(new Set(input.fingerprints.map(row=>row.keyVersion)).size!==input.fingerprints.length||input.fingerprints.some(row=>!Number.isSafeInteger(row.keyVersion)||row.keyVersion<1||!/^[a-f0-9]{64}$/.test(row.fingerprint)))throw new DeletionOperationError('DELETION_FINGERPRINT_INVALID',400);
}
function assertRequiredReadKeys(db:Database.Database,fingerprints:readonly PathFingerprint[]):void{
 const required=db.prepare('SELECT DISTINCT key_version AS version FROM project_generations').all() as {version:number}[];
 if(required.some(row=>!fingerprints.some(fp=>fp.keyVersion===row.version)))throw new DeletionOperationError('DELETION_READ_KEY_MISSING');
}
function assertNoDirectoryCleanup(db:Database.Database,generations:readonly {projectId:string;generation:string}[]):void{
 const pending=db.prepare("SELECT operation_id FROM session_artifact_cleanup_outbox WHERE project_id=? AND generation=? AND target_kind='project_directory' AND state!='succeeded' LIMIT 1");
 for(const row of generations)if(pending.get(row.projectId,row.generation))throw new DeletionOperationError('DELETION_DIRECTORY_CLEANUP_PENDING',409);
}
