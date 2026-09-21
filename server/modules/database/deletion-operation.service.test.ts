import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import * as schema from './schema.js';
import { DELETION_PREPARATION_SQL, SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL } from './deletion-schema.js';
import { DELETION_OPERATION_EXPANSION_SQL } from './deletion-operation.schema.js';
import { registerPlatformProtocol, PLATFORM_PROTOCOL_GUARDS_SQL } from './platform-protocol-registry.js';
import { registerDeletionIntents, DELETION_GUARDS_SQL } from './deletion-guards.js';
import { createDeletionOperationService } from './deletion-operation.service.js';
import { createDeletionOperationRepository } from './deletion-operation.repository.js';
import { createFixtureDeletionIssuer } from './__tests__/deletion-capability-fixture.js';
import type { DeletionOperationBoundaries, DeleteCommand, DeleteTarget, VerifiedInventory } from './deletion-operation.contract.js';

function fixture(count=1,actorRole='owner'){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');db.pragma('recursive_triggers=ON');db.pragma('synchronous=FULL');
 for(const value of Object.values(schema))if(typeof value==='string')for(const match of value.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+\w+\s*\([\s\S]*?\);/gi))db.exec(match[0]);
 db.exec(DELETION_PREPARATION_SQL);db.exec(SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL);db.exec(DELETION_OPERATION_EXPANSION_SQL);
 const user=db.prepare("INSERT INTO users(id,username,password_hash,role,is_active,status) VALUES(?,?,'fixture-hash',?,1,'active')");user.run(1,'actor',actorRole);user.run(2,'other','user');
 db.prepare('INSERT INTO projects(project_id,project_path,created_by) VALUES(?,?,?)').run('p','/fixture',1);
 db.prepare('INSERT INTO project_generations VALUES(?,?,?,?,?,?,?)').run('p','g','fingerprint',1,'active','create-p','create-hash');
 const insert=db.prepare("INSERT INTO sessions(session_id,provider,project_path) VALUES(?,'claude','/fixture')");
 const bind=db.prepare("INSERT INTO session_generation_bindings VALUES(?,'p','g',?,'nassaj_created','proof')");
 for(let i=0;i<count;i++){insert.run(`s${i}`);bind.run(`s${i}`,`source${i}`);}
 db.prepare("INSERT INTO platform_protocol_marker VALUES('deletion',1,'test-build','now')").run();
 registerPlatformProtocol(db,{buildId:'test-build',supports:{deletion:[1],credential_scope:[],outcomes:[]}});
 registerDeletionIntents(db,(p,f,k)=>p==='/fixture'&&f==='fingerprint'&&k===1);db.exec(PLATFORM_PROTOCOL_GUARDS_SQL);db.exec(DELETION_GUARDS_SQL);
 const published:Array<{user:number;ids:readonly string[]}> = [];
 const readVerifiedInventory=(target:DeleteTarget):VerifiedInventory=>({projectId:'p',generation:'g',complete:true,directoryTargets:[],sources:target.sessions.length?[{storeIdentity:'fixture-store',writerFence:'fixture-held',inventoryDigest:'fixture-digest',boundaryProof:'fixture-boundary',members:target.sessions.map((s)=>({sessionId:s.sessionId,provider:s.provider,sourceIdentity:s.sourceIdentity,targetIdentity:`target-${s.sessionId}`,targetKind:'session_artifact' as const}))}]:[]});
 const boundary:DeletionOperationBoundaries={
  retireUniversalLinks:()=>{assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_legacy_links'").get(),undefined);},
  captureAuthorizedAudience:(_db,target)=>new Map([[1,target.sessions.map(row=>row.sessionId)]]),
  publishToUser:(user,ids)=>published.push({user,ids}),log:()=>{},
 };
 const capability=createFixtureDeletionIssuer(db);const tokens=new Map<string,object>();
 const helpers={db,boundary,published,capability,readVerifiedInventory,
  token(cmd:DeleteCommand):object{
   let token=tokens.get(cmd.operationId);if(!token){const target=createDeletionOperationRepository(db).loadTarget(cmd);token=capability.issue(cmd,target,helpers.readVerifiedInventory(target));tokens.set(cmd.operationId,token);}return token;
  },
  service:()=>({execute:(cmd:DeleteCommand,token?:unknown)=>createDeletionOperationService(db,helpers.boundary,capability.issuer).execute(cmd,token??helpers.token(cmd))}),
 };
 return helpers;
}
function command(targetKind:'session'|'project'='session',actorId=1):DeleteCommand{return {operationId:'op',actorId,targetKind,targetId:targetKind==='session'?'s0':'p',scope:'nassaj_only'};}
function n(db:Database.Database,table:string):number{
 const sql:{[key:string]:string}={sessions:'SELECT count(*) AS n FROM sessions',projects:'SELECT count(*) AS n FROM projects',tombstones:'SELECT count(*) AS n FROM session_tombstones',outbox:'SELECT count(*) AS n FROM session_artifact_cleanup_outbox',records:'SELECT count(*) AS n FROM project_deletion_records',audit:'SELECT count(*) AS n FROM audit_log'};
 return (db.prepare(sql[table]).get() as {n:number}).n;
}

test('single-session transaction persists operation, source manifest, honest pending cleanup and immutable minimal witness; replay is exact',()=>{
 const f=fixture();try{
  f.db.prepare("INSERT INTO pending_server_actions(id,action_type,session_id) VALUES('a','safe-restart','s0')").run();
  const result=f.service().execute(command());assert.equal(result.status,202);assert.equal(result.artifactCleanup,'pending');assert.equal(n(f.db,'sessions'),0);assert.equal(n(f.db,'outbox'),1);assert.equal(n(f.db,'tombstones'),1);
  assert.equal(f.db.prepare('SELECT 1 FROM pending_server_actions').get(),undefined);assert.equal(n(f.db,'audit'),1);assert.equal(f.published.length,1);
  assert.deepEqual(f.service().execute(command()),result);assert.equal(f.published.length,1);assert.equal(n(f.db,'outbox'),1);
  assert.throws(()=>f.service().execute({...command(),targetId:'other'}),{code:'DELETION_OPERATION_CONFLICT'});
  assert.throws(()=>f.service().execute(command('session',2)),{code:'DELETION_NOT_FOUND'});
 }finally{f.db.close();}
});

for(const failure of ['audit','outbox','sidecar','fence','live','manifest','unknown-table'])test(`rollback every table on ${failure} failure`,()=>{
 const f=fixture();try{
  f.db.prepare("INSERT INTO pending_server_actions(id,action_type,session_id) VALUES('a','safe-restart','s0')").run();
  if(failure==='audit')f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'injected'); END;");
  if(failure==='outbox')f.db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON session_artifact_cleanup_outbox BEGIN SELECT RAISE(ABORT,'injected'); END;");
  if(failure==='sidecar')f.db.exec("CREATE TRIGGER fail_sidecar BEFORE DELETE ON pending_server_actions BEGIN SELECT RAISE(ABORT,'injected'); END;");
  if(failure==='fence')f.capability.controls.revokeAfterChecks=2;
  if(failure==='live')f.capability.controls.live=true;
  if(failure==='manifest')f.readVerifiedInventory=t=>({projectId:t.projectId,generation:t.generation,complete:true,directoryTargets:[],sources:[]});
  if(failure==='unknown-table')f.db.exec('CREATE TABLE unclassified(session_id TEXT)');
  assert.throws(()=>f.service().execute(command()));
  assert.equal(n(f.db,'sessions'),1);for(const table of ['tombstones','outbox','records','audit'])assert.equal(n(f.db,table),0);assert.equal(f.published.length,0);
  assert.ok(f.db.prepare('SELECT 1 FROM pending_server_actions').get());
 }finally{f.db.close();}
});

for(const kind of ['spawn','author','provenance','participant-owner','admin','project-write','inactive','status-revoked','system-owner'])test(`authority keeps approved consent: ${kind}`,()=>{
 const f=fixture(1,kind==='system-owner'?'owner':kind==='admin'?'admin':'user');try{
  if(['spawn','provenance','participant-owner','inactive','status-revoked'].includes(kind))f.db.prepare('INSERT INTO session_participants(session_id,user_id,role,attribution) VALUES(?,?,?,?)').run('s0',1,kind==='participant-owner'?'owner':'participant',kind==='spawn'||kind==='inactive'||kind==='status-revoked'?'spawn':'provenance');
  if(kind==='author')f.db.prepare("INSERT INTO message_authors(session_id,user_id,content_hash,created_at) VALUES('s0',1,'hash','now')").run();
  if(kind==='inactive')f.db.prepare('UPDATE users SET is_active=0 WHERE id=1').run();
  if(kind==='status-revoked')f.db.prepare("UPDATE users SET status='revoked' WHERE id=1").run();
  if(['spawn','author','system-owner'].includes(kind))assert.equal(f.service().execute(command()).status,202);
  else {assert.throws(()=>f.service().execute(command()),{code:'DELETION_NOT_FOUND'});assert.equal(n(f.db,'tombstones'),0);}
 }finally{f.db.close();}
});

test('a single unauthorized session aborts a manageable project; empty project is still audited',()=>{
 const f=fixture(2,'user');try{
  f.db.prepare("INSERT INTO session_participants(session_id,user_id,role,attribution) VALUES('s0',1,'participant','spawn')").run();
  assert.throws(()=>f.service().execute(command('project')),{code:'DELETION_NOT_FOUND'});assert.equal(n(f.db,'projects'),1);assert.equal(n(f.db,'sessions'),2);assert.equal(n(f.db,'audit'),0);
 }finally{f.db.close();}
 const empty=fixture(0);try{assert.equal(empty.service().execute(command('project')).artifactCleanup,'not_applicable');assert.equal(n(empty.db,'projects'),0);assert.equal(n(empty.db,'audit'),1);}finally{empty.db.close();}
});

test('2000-session project uses bounded batch statements, preserves declared history, and queues every owned source',()=>{
 const f=fixture(2000);try{
  f.db.prepare("INSERT INTO project_cost_daily(source_key,project_id,project_path,day,vendor,model,cost_usd) VALUES('retained','p','/fixture','2026-09-09','claude','model',9)").run();
  const result=f.service().execute(command('project'));assert.equal(result.artifactCleanup,'pending');assert.equal(n(f.db,'sessions'),0);assert.equal(n(f.db,'projects'),0);assert.equal(n(f.db,'tombstones'),2000);assert.equal(n(f.db,'outbox'),2000);assert.equal(n(f.db,'audit'),2001);
  assert.equal((f.db.prepare("SELECT cost_usd FROM project_cost_daily WHERE source_key='retained'").get() as {cost_usd:number}).cost_usd,9);
  assert.equal(f.db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
 }finally{f.db.close();}
});

test('broadcast failure after commit never rolls back deletion or sends an unfiltered global event',()=>{
 const f=fixture();try{
  let logged=0;f.boundary={...f.boundary,publishToUser:()=>{throw new Error('disconnected');},log:()=>{logged++;}};
  assert.equal(f.service().execute(command()).databaseDeletion,'committed');assert.equal(n(f.db,'sessions'),0);assert.equal(logged,1);
 }finally{f.db.close();}
});

test('default composition and forged DTO authority fail closed before any durable effect',()=>{
 const f=fixture();try{
  const absent=createDeletionOperationService(f.db,f.boundary);
  assert.throws(()=>absent.execute(command(),{}),{code:'DELETION_UNAVAILABLE'});
  const core=createDeletionOperationService(f.db,f.boundary,f.capability.issuer);
  for(const token of [undefined,null,true,{operationId:'op',verified:true},{...f.token(command())}])assert.throws(()=>core.execute(command(),token));
  assert.equal(n(f.db,'records'),0);assert.equal(n(f.db,'sessions'),1);
 }finally{f.db.close();}
});

test('opaque capability is not re-authorized by field mutation, new service instance or changed operation after success',()=>{
 const f=fixture();try{
  const token=f.token(command());assert.throws(()=>Object.assign(token,{operationId:'other'}));
  f.service().execute(command(),token);const claims=f.capability.controls.claims;
  assert.equal(f.service().execute(command(),token).status,202);assert.equal(f.capability.controls.claims,claims,'receipt replay mints no new authority');
  // Target remains absent, and a fabricated token cannot resurrect it or mutate the recorded operation.
  assert.throws(()=>createDeletionOperationService(f.db,f.boundary,f.capability.issuer).execute({...command(),operationId:'other'},token));
  assert.equal(n(f.db,'records'),1);assert.equal(n(f.db,'audit'),1);
 }finally{f.db.close();}
});

for(const failure of ['callback','commit'])test(`capability is spent after ${failure} failure; a fresh capability is required`,()=>{
 const f=fixture();try{
  if(failure==='callback')f.db.exec("CREATE TRIGGER fail_first BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'injected'); END");
  else f.db.exec("CREATE TABLE commit_failure_guard(user_id INTEGER REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_first BEFORE INSERT ON audit_log BEGIN INSERT INTO commit_failure_guard VALUES(999999); END");
  const token=f.token(command());assert.throws(()=>f.service().execute(command(),token));
  assert.equal(n(f.db,'records'),0);assert.equal(n(f.db,'sessions'),1);
  f.db.exec('DROP TRIGGER fail_first');
  assert.throws(()=>createDeletionOperationService(f.db,f.boundary,f.capability.issuer).execute(command(),token),{code:'FIXTURE_CAPABILITY_INVALID'});
  assert.equal(n(f.db,'records'),0);
 }finally{f.db.close();}
});

for(const failure of ['expired','revoked','wrong-generation','wrong-operation','wrong-db','changed-session-set'])test(`capability ${failure} rejects before witness creation`,()=>{
 const f=fixture();let extra:ReturnType<typeof fixture>|undefined;try{
  const cmd=command(failure==='changed-session-set'?'project':'session');
  const target=createDeletionOperationRepository(f.db).loadTarget(cmd);
  let token=f.capability.issue(failure==='wrong-operation'?{...cmd,operationId:'wrong'}:cmd,failure==='wrong-generation'?{...target,generation:'wrong'}:target,f.readVerifiedInventory(target));
  if(failure==='expired')f.capability.controls.expired=true;
  if(failure==='revoked')f.capability.revoke(token);
  if(failure==='wrong-db')extra=fixture();
  if(failure==='changed-session-set'){
   f.db.prepare("INSERT INTO session_generation_bindings VALUES('late','p','g','late-source','nassaj_created','proof')").run();
   f.db.prepare("INSERT INTO sessions(session_id,provider,project_path) VALUES('late','claude','/fixture')").run();
  }
  const db=extra?.db??f.db;const boundary=extra?.boundary??f.boundary;
  assert.throws(()=>createDeletionOperationService(db,boundary,f.capability.issuer).execute(cmd,token));
  assert.equal(n(db,'records'),0);assert.equal(n(db,'tombstones'),0);
 }finally{f.db.close();extra?.db.close();}
});

test('async/thenable boundary work is refused and cannot commit a partial operation',()=>{
 const f=fixture();try{
  for(const retireUniversalLinks of [async()=>{},()=>Promise.resolve()]){
   const target=createDeletionOperationRepository(f.db).loadTarget(command());const token=f.capability.issue(command(),target,f.readVerifiedInventory(target));
   assert.throws(()=>createDeletionOperationService(f.db,{...f.boundary,retireUniversalLinks},f.capability.issuer).execute(command(),token),{code:'DELETION_ASYNC_BOUNDARY'});
   assert.equal(n(f.db,'records'),0);assert.equal(n(f.db,'tombstones'),0);
  }
 }finally{f.db.close();}
});


test('unindexed proved source receives a permanent witness and its own strict audit; nonparticipant cannot extend authority',()=>{
 for(const role of ['owner','user']){
  const f=fixture(1,role);try{
   f.db.prepare("INSERT INTO session_participants(session_id,user_id,role,attribution) VALUES('s0',1,'participant','spawn')").run();
   const read=f.readVerifiedInventory;
   f.readVerifiedInventory=target=>{const inventory=read(target);inventory.sources[0].members.push({sessionId:'unindexed',provider:'claude',sourceIdentity:'unindexed-source',targetIdentity:'unindexed-target',targetKind:'session_artifact'});return inventory;};
   if(role==='owner'){
    f.service().execute(command('project'));assert.equal(n(f.db,'tombstones'),2);assert.equal(n(f.db,'audit'),3);assert.equal(n(f.db,'outbox'),2);
   }else{assert.throws(()=>f.service().execute(command('project')),{code:'DELETION_NOT_FOUND'});assert.equal(n(f.db,'tombstones'),0);assert.equal(n(f.db,'audit'),0);}
  }finally{f.db.close();}
 }
});
