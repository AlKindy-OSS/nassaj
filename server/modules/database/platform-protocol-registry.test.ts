import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DELETION_PREPARATION_SQL } from './deletion-schema.js';
import { registerPlatformProtocol, assertPlatformAdmission, assertLockedRecovery, protocolFloorHash, withPlatformTransition, PLATFORM_PROTOCOL_GUARDS_SQL } from './platform-protocol-registry.js';
import type { ProtocolFloor, LockedRecoveryInput } from './platform-protocol-registry.js';

const credential={feature:'credential_scope' as const,protocolVersion:1,minimumBuild:'credential-build'};
const deletion={feature:'deletion' as const,protocolVersion:1,minimumBuild:'deletion-build'};
function fixture(floor:ProtocolFloor=[], versions=[1,2]) {
 const db=new Database(':memory:');db.pragma('synchronous=FULL');
 db.exec(DELETION_PREPARATION_SQL);
 for(const row of floor) db.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run(row.feature,row.protocolVersion,row.minimumBuild,'fixture');
 registerPlatformProtocol(db,{buildId:'sealed-review',supports:{deletion:versions,credential_scope:[1],outcomes:[1]}});
 db.exec(PLATFORM_PROTOCOL_GUARDS_SQL);
 return db;
}
function recovery(previousFloor:ProtocolFloor,targetFloor:ProtocolFloor):LockedRecoveryInput {
 const journal={operationId:'reviewed-op',database:{databaseId:'db-id',restoreEpoch:'epoch',fileIdentity:'file-id',approvedPath:'/test-db'},toolBuild:'sealed-review',previousFloorHash:protocolFloorHash(previousFloor),targetFloorHash:protocolFloorHash(targetFloor),guardHash:'reviewed-guards'};
 return {journal,expected:structuredClone(journal),previousFloor,targetFloor,assertWriterLockHeld:()=>{},listenerRunning:false,schedulerRunning:false,providerRunning:false};
}
function receipt(db:Database.Database,input:LockedRecoveryInput) {
 const j=input.journal;
 db.prepare('INSERT INTO platform_activation_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(j.operationId,j.database.databaseId,j.database.restoreEpoch,j.database.fileIdentity,j.database.approvedPath,j.toolBuild,j.previousFloorHash,j.targetFloorHash,j.guardHash);
}

test('canonical admission uses tuples, independent of row order AND property insertion order',()=>{
 const db=fixture();
 try {
  const reversed=[{minimumBuild:deletion.minimumBuild,protocolVersion:1,feature:'deletion' as const},{minimumBuild:credential.minimumBuild,feature:'credential_scope' as const,protocolVersion:1}];
  assertPlatformAdmission(db,[credential,deletion],reversed);
  assert.equal(protocolFloorHash([credential,deletion]),protocolFloorHash(reversed));
  assert.throws(()=>assertPlatformAdmission(db,[credential,deletion],[credential]));
 } finally {db.close();}
});

test('shared platform guards protect a credential-only floor before any deletion marker',()=>{
 const db=fixture([credential]);
 try {
  for(const sql of ["DELETE FROM platform_protocol_marker", "UPDATE platform_protocol_marker SET minimum_build='bad'", "INSERT OR REPLACE INTO platform_protocol_marker VALUES('credential_scope',1,'bad','now')", "INSERT INTO platform_protocol_marker VALUES('deletion',1,'bad','now')"]) assert.throws(()=>db.exec(sql));
 } finally {db.close();}
});

test('only locked journal-bound bootstrap can append a marker and its immutable receipt atomically',()=>{
 const db=fixture([credential]);const input=recovery([credential],[credential,deletion]);
 try {
  withPlatformTransition(db,input,()=>{
   assert.equal((db.prepare('SELECT nassaj_platform_business_writes_allowed() AS n').get() as {n:number}).n,0);
   assert.throws(()=>db.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('outcomes',1,'not-journal','now'));
   db.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('deletion',1,'deletion-build','now');receipt(db,input);
  });
  assert.equal((db.prepare('SELECT nassaj_platform_business_writes_allowed() AS n').get() as {n:number}).n,1);
  withPlatformTransition(db,input,()=>{}); // exact replay uses the existing database receipt
  for(const sql of ["DELETE FROM platform_activation_receipts", "UPDATE platform_activation_receipts SET database_id='other'"]) assert.throws(()=>db.exec(sql));
  assert.throws(()=>receipt(db,input));
  assert.throws(()=>db.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('outcomes',1,'other','now'));
 } finally {db.close();}
});

test('reviewed protocol upgrade is possible only with BOTH contracts supported and unchanged other features',()=>{
 const oldFloor=[credential,deletion];const next={feature:'deletion' as const,protocolVersion:2,minimumBuild:'v2-build'};
 const input=recovery(oldFloor,[credential,next]);const db=fixture(oldFloor);
 try {
  assert.throws(()=>db.exec("UPDATE platform_protocol_marker SET protocol_version=2,minimum_build='v2-build' WHERE feature='deletion'"));
  withPlatformTransition(db,input,()=>{
   db.prepare('UPDATE platform_protocol_marker SET protocol_version=?,minimum_build=? WHERE feature=?').run(2,'v2-build','deletion');receipt(db,input);
  });
  assert.equal((db.prepare("SELECT protocol_version AS v FROM platform_protocol_marker WHERE feature='deletion'").get() as {v:number}).v,2);
  assert.equal((db.prepare("SELECT count(*) AS n FROM platform_protocol_marker WHERE feature='credential_scope'").get() as {n:number}).n,1);
 } finally {db.close();}
 const onlyNew=fixture(oldFloor,[2]);
 try {assert.throws(()=>assertLockedRecovery(onlyNew,input),/UNSUPPORTED/);} finally {onlyNew.close();}
});

test('journal floor hashes bind actual tuples: matching copies of a forged hash are insufficient; no feature removal/downlevel',()=>{
 const db=fixture([credential,deletion]);
 try {
  const valid=recovery([credential,deletion],[credential,deletion]);
  for(const hash of ['previousFloorHash','targetFloorHash'] as const) {
   const forged=structuredClone({...valid,assertWriterLockHeld:undefined});
   forged.journal[hash]='forged';forged.expected[hash]='forged';
   assert.throws(()=>assertLockedRecovery(db,{...forged,assertWriterLockHeld:()=>{}}),/HASH_MISMATCH/);
  }
  assert.throws(()=>assertLockedRecovery(db,recovery([credential,deletion],[deletion])),/DOWNGRADE/);
  assert.throws(()=>assertLockedRecovery(db,recovery([{...deletion,protocolVersion:2}],[deletion])),/DOWNGRADE/);
  assert.throws(()=>assertLockedRecovery(db,recovery([deletion],[{...deletion,minimumBuild:'changed'}])),/DOWNGRADE/);
  assert.throws(()=>withPlatformTransition(db,recovery([],[]),()=>{}),/DB_FLOOR_MISMATCH/);
 } finally {db.close();}
});

test('missing receipt, async callback, lock loss, wrong receipt and callback failure roll back markers and revoke capability',()=>{
 for(const failure of ['missing_receipt','async','lock_lost','wrong_receipt','callback']) {
  const db=fixture([credential]);const input=recovery([credential],[credential,deletion]);
  try {
   assert.throws(()=>withPlatformTransition(db,input,()=>{
    db.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('deletion',1,'deletion-build','now');
    if(failure==='async') return Promise.resolve();
    if(failure==='lock_lost') input.assertWriterLockHeld=()=>{throw new Error('LOCK_LOST');};
    if(failure==='wrong_receipt') receipt(db,{...input,journal:{...input.journal,operationId:'other'}});
    if(failure==='callback') throw new Error('INJECTED');
   }));
   assert.equal((db.prepare('SELECT count(*) AS n FROM platform_protocol_marker').get() as {n:number}).n,1);
   assert.throws(()=>receipt(db,input));
   assert.throws(()=>db.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('deletion',1,'deletion-build','now'));
  } finally {db.close();}
 }
});
