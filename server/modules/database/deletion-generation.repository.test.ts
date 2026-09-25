import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { PROJECTS_TABLE_SCHEMA_SQL, SESSIONS_TABLE_SCHEMA_SQL, SESSION_TOMBSTONES_TABLE_SCHEMA_SQL, AUDIT_LOG_TABLE_SCHEMA_SQL } from './schema.js';
import { DELETION_PREPARATION_SQL, SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL } from './deletion-schema.js';
import { registerPlatformProtocol, PLATFORM_PROTOCOL_GUARDS_SQL } from './platform-protocol-registry.js';
import { registerDeletionIntents, DELETION_GUARDS_SQL } from './deletion-guards.js';
import { createDeletionGenerationRepository } from './deletion-generation.repository.js';

function fixture(){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');db.pragma('recursive_triggers=ON');
 db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,status TEXT);INSERT INTO users VALUES(1,'owner',1,'active');");
 db.exec(PROJECTS_TABLE_SCHEMA_SQL);db.exec(SESSIONS_TABLE_SCHEMA_SQL);db.exec(SESSION_TOMBSTONES_TABLE_SCHEMA_SQL);db.exec(AUDIT_LOG_TABLE_SCHEMA_SQL);db.exec(DELETION_PREPARATION_SQL);db.exec(SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL);
 const fingerprint='a'.repeat(64);
 db.prepare("INSERT INTO project_generations VALUES('old','old-generation',?,1,'suppressed','old-create','old-request')").run(fingerprint);
 db.prepare("INSERT INTO project_tombstones VALUES('old','old-generation','old-delete','then',?,1)").run(fingerprint);
 db.prepare("INSERT INTO session_tombstones(session_id,provider,operation_id) VALUES('old-session','claude','old-delete')").run();
 db.prepare("INSERT INTO platform_protocol_marker VALUES('deletion',1,'fixture','now')").run();registerPlatformProtocol(db,{buildId:'fixture',supports:{deletion:[1],credential_scope:[],outcomes:[]}});registerDeletionIntents(db,(p,f,k)=>p==='/fixture'&&f===fingerprint&&k===1);db.exec(PLATFORM_PROTOCOL_GUARDS_SQL);db.exec(DELETION_GUARDS_SQL);
 const input={operationId:'readd',actorId:1,canonicalPath:'/fixture',fingerprints:[{keyVersion:1,fingerprint}],writeKeyVersion:1};
 return {db,input,repository:createDeletionGenerationRepository(db,{offlineProjectionWriter:true})};
}
test('manual re-add is unreachable without the explicit offline projection-writer gate',()=>{
 const f=fixture();try{
  const repository=createDeletionGenerationRepository(f.db);
  assert.throws(()=>f.db.transaction(()=>repository.manualReadd(f.input)).immediate(),
   {code:'DELETION_OFFLINE_WRITER_REQUIRED'});
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM projects').get() as {n:number}).n,0);
 }finally{f.db.close();}
});
test('same path yields a fresh generation, exact replay returns it, old sessions never bind or reappear',()=>{
 const f=fixture();try{
  const result=f.db.transaction(()=>f.repository.manualReadd(f.input)).immediate();assert.notEqual(result.projectId,'old');assert.notEqual(result.generation,'old-generation');
  assert.deepEqual(f.db.transaction(()=>f.repository.manualReadd(f.input)).immediate(),result);
  assert.throws(()=>f.db.transaction(()=>f.repository.manualReadd({...f.input,canonicalPath:'/other'})).immediate(),{code:'DELETION_OPERATION_CONFLICT'});
  const binding={sessionId:'new-session',...result,sourceIdentity:'proven-new-source',proofKind:'nassaj_created' as const,proofDigest:'proof'};
  f.db.transaction(()=>{f.repository.bindProvenSession(binding);f.repository.bindProvenSession(binding);f.db.prepare("INSERT INTO sessions(session_id,provider,project_path) VALUES('new-session','claude','/fixture')").run();}).immediate();
  assert.throws(()=>f.db.transaction(()=>f.repository.bindProvenSession({...binding,sessionId:'old-session'})).immediate(),{code:'DELETION_SESSION_TOMBSTONED'});
  assert.throws(()=>f.db.prepare("INSERT INTO sessions(session_id,provider,project_path) VALUES('old-session','claude','/fixture')").run());
  assert.throws(()=>f.db.transaction(()=>f.repository.bindProvenSession({...binding,sourceIdentity:'different'})).immediate(),{code:'DELETION_SOURCE_IDENTITY_MISMATCH'});
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM project_generations').get() as {n:number}).n,2);assert.equal((f.db.prepare('SELECT count(*) AS n FROM project_tombstones').get() as {n:number}).n,1);
 }finally{f.db.close();}
});
for(const state of ['pending','leased','retry','blocked','retained'])test(`old directory cleanup ${state} temporarily blocks re-add without minting generation`,()=>{
 const f=fixture();try{
  f.db.prepare("INSERT INTO session_artifact_cleanup_outbox(job_id,operation_id,project_id,generation,store_identity,target_identity,target_kind,state,lease_token,lease_until) VALUES('job','old-delete','old','old-generation','store','dir','project_directory',?,?,?)").run(state,state==='leased'?'lease':null,state==='leased'?999999:null);
  assert.throws(()=>f.db.transaction(()=>f.repository.manualReadd(f.input)).immediate(),{code:'DELETION_DIRECTORY_CLEANUP_PENDING'});
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM project_generations').get() as {n:number}).n,1);
 }finally{f.db.close();}
});
test('missing historical read keys and strict audit failure never produce a half-created project',()=>{
 const f=fixture();try{
  assert.throws(()=>f.db.transaction(()=>f.repository.manualReadd({...f.input,fingerprints:[{keyVersion:2,fingerprint:'b'.repeat(64)}],writeKeyVersion:2})).immediate(),{code:'DELETION_READ_KEY_MISSING'});
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'audit'); END");
  assert.throws(()=>f.db.transaction(()=>f.repository.manualReadd(f.input)).immediate());
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM projects').get() as {n:number}).n,0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM project_generations').get() as {n:number}).n,1);
 }finally{f.db.close();}
});


test('generation replay fingerprints use canonical tuples independent of row and property order',()=>{
 const f=fixture();try{
  const fingerprints=[{keyVersion:2,fingerprint:'b'.repeat(64)},...f.input.fingerprints];
  const first={...f.input,fingerprints};
  const result=f.db.transaction(()=>f.repository.manualReadd(first)).immediate();
  const reordered={...f.input,fingerprints:[{fingerprint:'a'.repeat(64),keyVersion:1},{fingerprint:'b'.repeat(64),keyVersion:2}]};
  assert.deepEqual(f.db.transaction(()=>f.repository.manualReadd(reordered)).immediate(),result);
  assert.throws(()=>f.db.transaction(()=>f.repository.manualReadd({...reordered,fingerprints:[{fingerprint:'a'.repeat(64),keyVersion:1},{fingerprint:'c'.repeat(64),keyVersion:2}]})).immediate(),{code:'DELETION_OPERATION_CONFLICT'});
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM project_lifecycle_transitions').get() as {n:number}).n,1);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM audit_log').get() as {n:number}).n,1);
 }finally{f.db.close();}
});
