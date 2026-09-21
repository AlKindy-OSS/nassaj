import assert from 'node:assert/strict';

import type Database from 'better-sqlite3';

import type { DeleteCommand, DeleteTarget, VerifiedInventory } from '../deletion-operation.contract.js';
import { DeletionOperationError } from '../deletion-operation.contract.js';
import type { DeletionCapabilityIssuer } from '../deletion-writer-context.js';

/** Test-only issuer excluded by server/tsconfig.json. This is NOT evidence of an external provider fence. */
export function createFixtureDeletionIssuer(database:Database.Database){
 const entries=new WeakMap<object,{command:string;target:string;inventory:VerifiedInventory;state:'issued'|'reserved'|'spent';expires:number;revoked:boolean;checks:number}>();
 const controls={revokeAfterChecks:Infinity,expired:false,live:false,claims:0};
 const commandKey=(c:DeleteCommand)=>JSON.stringify([c.operationId,c.actorId,c.targetKind,c.targetId,c.scope]);
 const targetKey=(t:DeleteTarget)=>JSON.stringify([t.projectId,t.generation,t.projectPath,t.fingerprint,t.keyVersion,[...t.sessions].sort((a,b)=>a.sessionId.localeCompare(b.sessionId)).map(s=>[s.sessionId,s.provider,s.sourceIdentity,s.projectId,s.generation])]);
 const issuer:DeletionCapabilityIssuer={
  claim(token,db,command,target){
   const entry=entries.get(token);controls.claims++;
   if(db!==database||!db.inTransaction||!entry||entry.state!=='issued'||entry.command!==commandKey(command)||entry.target!==targetKey(target))throw new DeletionOperationError('FIXTURE_CAPABILITY_INVALID');
   entry.state='reserved';
   return {
    inventory:structuredClone(entry.inventory),
    recheck(){
     entry.checks++;assert.equal(db.inTransaction,true);
     if(entry.revoked||controls.expired||Date.now()>=entry.expires||entry.checks>=controls.revokeAfterChecks||controls.live)throw new DeletionOperationError('FIXTURE_CAPABILITY_REVOKED');
    },
    finish(){entry.state='spent';},
   };
  },
 };
 return {issuer,controls,
  issue(command:DeleteCommand,target:DeleteTarget,inventory:VerifiedInventory):object{
   const token=Object.freeze({});entries.set(token,{command:commandKey(command),target:targetKey(target),inventory:structuredClone(inventory),state:'issued',expires:Date.now()+60000,revoked:false,checks:0});return token;
  },
  revoke(token:object):void{const entry=entries.get(token);if(entry)entry.revoked=true;},
 };
}
