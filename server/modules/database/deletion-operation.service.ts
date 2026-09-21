import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import { createDeletionOperationRepository } from './deletion-operation.repository.js';
import { requireActiveDeletionActor, assertDeletionAuthority, assertDeletionProjectManager, assertDeletionSessionAuthority } from './deletion-authorization.js';
import { assertDeletionConnection, withDeletionTransaction } from './deletion-guards.js';
import { DeletionOperationError, DELETION_MAX_SOURCES, DELETION_MAX_SESSIONS } from './deletion-operation.contract.js';
import { claimDeletionCapability, invokeSynchronous } from './deletion-writer-context.js';
import type { DeletionCapabilityIssuer, DeletionCapabilityReservation } from './deletion-writer-context.js';
import type { DeleteCommand, DeleteTarget, DeleteResult, VerifiedInventory, DeletionOperationBoundaries } from './deletion-operation.contract.js';

function validateCommand(input:DeleteCommand):DeleteCommand {
  if(!input||Object.keys(input).some(key=>!['operationId','actorId','targetKind','targetId','scope'].includes(key))||
    !Number.isSafeInteger(input.actorId)||input.actorId<1||!validText(input.operationId,128)||!validText(input.targetId,256)||
    !['session','project'].includes(input.targetKind)||!['nassaj_only','nassaj_and_disk'].includes(input.scope)||
    (input.targetKind==='session'&&input.scope!=='nassaj_only'))throw new DeletionOperationError('DELETION_INPUT_INVALID',400);
  return Object.freeze({...input});
}
function validText(value:unknown,max=512):value is string{return typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=max&&!value.includes('\0');}
function validateInventory(target:DeleteTarget,command:DeleteCommand,inventory:VerifiedInventory):void {
  if(!inventory||inventory.complete!==true||inventory.projectId!==target.projectId||inventory.generation!==target.generation||
    !Array.isArray(inventory.sources)||!Array.isArray(inventory.directoryTargets)||inventory.sources.length>DELETION_MAX_SOURCES||inventory.directoryTargets.length>256)throw new DeletionOperationError('DELETION_MANIFEST_UNPROVEN');
  const observed=new Map<string,{provider:string;sourceIdentity:string}>();const stores=new Set<string>();let total=0;
  for(const source of inventory.sources){
    if(![source.storeIdentity,source.writerFence,source.inventoryDigest,source.boundaryProof].every(value=>validText(value))||stores.has(source.storeIdentity)||!Array.isArray(source.members))throw new DeletionOperationError('DELETION_MANIFEST_INVALID');
    stores.add(source.storeIdentity);total+=source.members.length;if(total>DELETION_MAX_SOURCES)throw new DeletionOperationError('DELETION_MANIFEST_LIMIT');
    const sourceIds=new Set<string>();
    for(const member of source.members){
      if(![member.sessionId,member.sourceIdentity,member.targetIdentity].every(value=>validText(value))||!['claude','codex','opencode'].includes(member.provider)||!['session_artifact','provider_session'].includes(member.targetKind)||sourceIds.has(member.sourceIdentity))throw new DeletionOperationError('DELETION_MANIFEST_INVALID');
      if(command.targetKind==='session'&&member.sessionId!==command.targetId)throw new DeletionOperationError('DELETION_MANIFEST_MISMATCH');
      const existing=observed.get(member.sessionId);
      if(existing&&(existing.provider!==member.provider||existing.sourceIdentity!==member.sourceIdentity))throw new DeletionOperationError('DELETION_MANIFEST_MISMATCH');
      sourceIds.add(member.sourceIdentity);observed.set(member.sessionId,member);
    }
  }
  if(observed.size>DELETION_MAX_SESSIONS||target.sessions.some(row=>observed.get(row.sessionId)?.sourceIdentity!==row.sourceIdentity||observed.get(row.sessionId)?.provider!==row.provider))throw new DeletionOperationError('DELETION_MANIFEST_INCOMPLETE');
  for(const directory of inventory.directoryTargets){
    if(command.targetKind!=='project'||!['project_directory','project_logo'].includes(directory.targetKind)||
      !validText(directory.storeIdentity)||!validText(directory.targetIdentity)||(directory.targetKind==='project_directory'&&command.scope!=='nassaj_and_disk'))throw new DeletionOperationError('DELETION_DIRECTORY_SCOPE_INVALID');
  }
  if(command.scope==='nassaj_and_disk'&&!inventory.directoryTargets.some(row=>row.targetKind==='project_directory'))throw new DeletionOperationError('DELETION_DIRECTORY_UNPROVEN');
}

/** Candidate composition only. Real execution authorization, provider fence and Universal retirement are REQUIRED dependencies. */
export function createDeletionOperationService(db:Database.Database,boundary:DeletionOperationBoundaries,issuer?:DeletionCapabilityIssuer) {
  const repository=createDeletionOperationRepository(db);
  return {
    /** A synchronous all-or-nothing DB operation; all external effects remain durable pending outbox work. */
    execute(input:DeleteCommand,token?:unknown):DeleteResult {
      const command=validateCommand(input);if(!issuer)throw new DeletionOperationError('DELETION_UNAVAILABLE');assertDeletionConnection(db);
      const requestHash=createHash('sha256').update(JSON.stringify([command.actorId,command.targetKind,command.targetId,command.scope])).digest('hex');
      let audience:ReadonlyMap<number,readonly string[]>=new Map();let committedNew=false;
      let reservation:DeletionCapabilityReservation|undefined;let result:DeleteResult;
      try {result=withDeletionTransaction(db,{operationId:command.operationId,intentType:command.targetKind==='project'?'permanent_project':'permanent_session'},()=>{
        requireActiveDeletionActor(db,command.actorId);
        const replay=repository.readReplay(command,requestHash);if(replay)return replay;
        if(command.targetKind==='session')assertDeletionSessionAuthority(db,[command.targetId],command.actorId);
        if(command.targetKind==='project')assertDeletionProjectManager(db,command.targetId,command.actorId);
        const target=repository.loadTarget(command);assertDeletionAuthority(db,command,target);
        reservation=claimDeletionCapability(issuer,token,db,command,target);invokeSynchronous(reservation.recheck,reservation,[]);
        const inventory=structuredClone(reservation.inventory);validateInventory(target,command,inventory);
        assertDeletionSessionAuthority(db,[...new Set(inventory.sources.flatMap(source=>source.members.map(row=>row.sessionId)))],command.actorId);
        repository.assertSourcesBelong(target,inventory);audience=invokeSynchronous(boundary.captureAuthorizedAudience,boundary,[db,target]);
        repository.recordBatch(command,target,inventory,requestHash);repository.recordWitnesses(command,target,inventory);
        invokeSynchronous(boundary.retireUniversalLinks,boundary,[db,target,command]);repository.recordSources(command,target,inventory);repository.recordAudit(command,target);
        repository.removeRows(command,target);invokeSynchronous(reservation.recheck,reservation,[]);committedNew=true;return repository.result(command.operationId);
      });}catch(error){try{if(reservation)invokeSynchronous(reservation.finish,reservation,['failed_or_unknown']);}catch{/* Preserve the transaction error and keep authority unavailable. */}throw error;}
      try{if(reservation)invokeSynchronous(reservation.finish,reservation,['committed']);}catch{try{boundary.log({code:'DELETION_CAPABILITY_FINALIZATION_FAILED',operationId:command.operationId});}catch{/* Commit already succeeded. */}}
      if(committedNew)publishCommitted(boundary,audience,command.operationId);
      return result;
    },
  };
}

function publishCommitted(boundary:DeletionOperationBoundaries,audience:ReadonlyMap<number,readonly string[]>,operationId:string):void {
  for(const [userId,ids] of audience){
    try{boundary.publishToUser(userId,ids,operationId);}catch{try{boundary.log({code:'DELETION_BROADCAST_FAILED',operationId});}catch{/* Commit is already durable. */}}
  }
}
