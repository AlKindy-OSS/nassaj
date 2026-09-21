import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DELETION_PREPARATION_SQL, SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL } from './deletion-schema.js';
import { DELETION_GUARDS_SQL, registerDeletionIntents, withDeletionTransaction, assertDeletionConnection, deletionGuardDigest } from './deletion-guards.js';
import { registerPlatformProtocol, assertPlatformSupport, assertRecoveryBinding, PLATFORM_PROTOCOL_GUARDS_SQL, protocolFloorHash } from './platform-protocol-registry.js';
import { deletionPosture, readDeletionFeature } from './deletion-feature.js';
import { PROJECTS_TABLE_SCHEMA_SQL, SESSIONS_TABLE_SCHEMA_SQL, SESSION_TOMBSTONES_TABLE_SCHEMA_SQL } from './schema.js';

function fixture(guards = true, credentialFloor = false) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON'); db.pragma('recursive_triggers=ON'); db.pragma('synchronous=FULL');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY)');
  db.exec(PROJECTS_TABLE_SCHEMA_SQL); db.exec(SESSIONS_TABLE_SCHEMA_SQL); db.exec(SESSION_TOMBSTONES_TABLE_SCHEMA_SQL);
  db.prepare('INSERT INTO projects(project_id,project_path) VALUES(?,?)').run('p','/a');
  db.prepare('INSERT INTO sessions(session_id,provider,project_path) VALUES(?,?,?)').run('s','claude','/a');
  db.exec(DELETION_PREPARATION_SQL); db.exec(SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL);
  registerPlatformProtocol(db, {buildId:'sealed-test-only',supports:{deletion:[1],credential_scope:[],outcomes:[1]}});
  registerDeletionIntents(db,(path,fingerprint,keyVersion)=>path==='/a' && fingerprint==='fingerprint' && keyVersion===1);
  if (guards) {
    db.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('deletion',1,'sealed-test-only','now');
    if (credentialFloor) db.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('credential_scope',1,'sealed','now');
    db.prepare('INSERT INTO project_generations VALUES(?,?,?,?,?,?,?)').run('p','g','fingerprint',1,'active','bootstrap-p','request');
    db.exec(PLATFORM_PROTOCOL_GUARDS_SQL); db.exec(DELETION_GUARDS_SQL);
  }
  return db;
}
function intent(db: Database.Database, id='s') {
  db.prepare(`INSERT INTO session_delete_intents VALUES(?,nassaj_deletion_operation(),nassaj_deletion_intent(),nassaj_deletion_restore(),nassaj_deletion_transaction())`).run(id);
}
function tombstone(db: Database.Database,id='s') {
  db.prepare("INSERT INTO session_tombstones(session_id,provider,project_path,source_path,deleted_by,operation_id) VALUES(?,?,NULL,NULL,NULL,COALESCE(NULLIF(nassaj_deletion_operation(),''),'historical-op'))").run(id,'claude');
}

for(const recursive of [0,1]) test(`raw delete/replace, identity and immutable witnesses (recursive=${recursive})`,()=>{
  const db=fixture();
  try {
    db.pragma(`recursive_triggers=${recursive}`);
    for(const sql of ["DELETE FROM sessions", "INSERT OR REPLACE INTO sessions(session_id,provider,project_path) VALUES('s','claude','/a')", "UPDATE sessions SET session_id='x'", "UPDATE sessions SET project_path='/b'", "DELETE FROM projects", "INSERT OR REPLACE INTO projects(project_id,project_path) VALUES('p','/a')"]) assert.throws(()=>db.exec(sql));
    withDeletionTransaction(db,{operationId:'op',intentType:'permanent_session'},()=>{
      tombstone(db); intent(db); db.prepare('DELETE FROM sessions WHERE session_id=?').run('s');
    });
    for(const sql of ["DELETE FROM session_tombstones", "UPDATE session_tombstones SET provider='codex'", "INSERT OR REPLACE INTO session_tombstones(session_id,provider,project_path,source_path) VALUES('s','claude',NULL,NULL)", "INSERT INTO sessions(session_id,provider,project_path) VALUES('s','claude','/new')"]) assert.throws(()=>db.exec(sql));
    assert.equal((db.prepare('SELECT count(*) AS n FROM session_delete_intents').get() as {n:number}).n,0);
    assert.equal((db.prepare('SELECT nassaj_deletion_transaction() AS n').get() as {n:string}).n,'');
  } finally {db.close();}
});

test('one-shot intents reject missing witness, stale/wrong tuples, leftover and manual consumption; rollback all',()=>{
 const db=fixture();
 try {
  for(const failure of ['missing','leftover','wrong_operation','wrong_type','stale','manual_consume','audit']) {
   assert.throws(()=>withDeletionTransaction(db,{operationId:'op',intentType:'permanent_session'},()=>{
    if(failure!=='missing') tombstone(db);
    if(['wrong_operation','wrong_type','stale'].includes(failure)) db.prepare('INSERT INTO session_delete_intents VALUES(?,?,?,?,?)').run('s',failure==='wrong_operation'?'bad':'op',failure==='wrong_type'?'artifact_gone':'permanent_session','',failure==='stale'?'stale':(db.prepare('SELECT nassaj_deletion_transaction() AS n').get() as {n:string}).n);
    else intent(db);
    if(failure==='manual_consume') db.exec('DELETE FROM session_delete_intents');
    if(failure!=='leftover') db.exec('DELETE FROM sessions');
    if(failure==='audit') throw new Error('INJECTED_AUDIT_FAILURE');
   }));
   assert.equal((db.prepare('SELECT count(*) AS n FROM sessions').get() as {n:number}).n,1);
   assert.equal((db.prepare('SELECT count(*) AS n FROM session_tombstones').get() as {n:number}).n,0);
  }
 } finally {db.close();}
});

test('maintenance cannot mint tombstones; context always resets and async/nesting are rejected',()=>{
 const db=fixture();
 try {
  assert.throws(()=>withDeletionTransaction(db,{operationId:'op',intentType:'artifact_gone'},()=>tombstone(db)));
  assert.throws(()=>withDeletionTransaction(db,{operationId:'op',intentType:'restore_reconcile_session'},()=>{}));
  assert.throws(()=>withDeletionTransaction(db,{operationId:'op',intentType:'permanent_session'},()=>Promise.resolve()));
  assert.throws(()=>withDeletionTransaction(db,{operationId:'op',intentType:'permanent_session'},()=>withDeletionTransaction(db,{operationId:'other',intentType:'permanent_session'},()=>{})));
  assert.throws(()=>intent(db));
  withDeletionTransaction(db,{operationId:'maintenance',intentType:'artifact_gone'},()=>{intent(db);db.exec('DELETE FROM sessions');});
  assert.equal((db.prepare('SELECT count(*) AS n FROM session_tombstones').get() as {n:number}).n,0);
 } finally {db.close();}
});

test('project generation permits same fingerprint after suppression, with a distinct immutable identity',()=>{
 const db=fixture(false);
 try {
  const add=db.prepare('INSERT INTO project_generations VALUES(?,?,?,?,?,?,?)');
  add.run('a','ga','fingerprint',1,'active','oa','request-a');
  assert.throws(()=>add.run('b','gb','fingerprint',1,'active','ob','request-b'));
  db.prepare("UPDATE project_generations SET state='suppressed' WHERE project_id=?").run('a');
  add.run('b','gb','fingerprint',1,'active','ob','request-b');
  assert.throws(()=>add.run('c','ga','other',1,'active','oc','request-c'));
  assert.equal((db.prepare('SELECT count(*) AS n FROM project_generations').get() as {n:number}).n,2);
  assert.throws(()=>db.prepare('INSERT INTO session_generation_bindings VALUES(?,?,?,?,?,?)').run('old','b','wrong','source','nassaj_created','proof'));
 } finally {db.close();}
});

test('explicit support sets are snapshotted: {2} rejects {1}; unknown names reject',()=>{
 const db=new Database(':memory:');
 try {
  const supports={deletion:[2],credential_scope:[],outcomes:[]};
  registerPlatformProtocol(db,{buildId:'sealed',supports}); supports.deletion.push(1);
  assert.throws(()=>assertPlatformSupport(db,[{feature:'deletion',protocolVersion:1,minimumBuild:'a'}]));
  assertPlatformSupport(db,[{feature:'deletion',protocolVersion:2,minimumBuild:'a'}]);
  assert.equal((db.prepare('SELECT nassaj_platform_supports(?,?) AS n').get('unknown',1) as {n:number}).n,0);
  assert.throws(()=>registerPlatformProtocol(db,{buildId:'sealed',supports}));
 } finally {db.close();}
});

test('flag matrix preserves every installed feature and never activates S1a',()=>{
 for(const mode of ['off','observe','guard','on'] as const) {
  const floor=[{feature:'outcomes' as const,protocolVersion:1,minimumBuild:'sealed'}];
  if(mode==='guard'||mode==='on') assert.throws(()=>deletionPosture(mode,floor));
  else assert.deepEqual(deletionPosture(mode,floor).preserveFeatureGuards,['outcomes']);
  const after=deletionPosture(mode,[...floor,{feature:'deletion',protocolVersion:1,minimumBuild:'sealed'}]);
  assert.equal(after.deletionGuardsRequired,true);assert.equal(after.legacyDeletionAllowed,false);assert.equal(after.permanentDeletionAllowed,false);
 }
 const env={NASSAJ_HONEST_DELETION:'observe'};const captured=readDeletionFeature(env);env.NASSAJ_HONEST_DELETION='on';assert.equal(captured,'observe');
 assert.equal(readDeletionFeature({}),'off');assert.throws(()=>readDeletionFeature({NASSAJ_HONEST_DELETION:'ON'}));
});

test('same path cannot authorize a journal for substituted DB, restore epoch, file, tool or payload',()=>{
 const binding={operationId:'op',database:{databaseId:'db',restoreEpoch:'epoch',fileIdentity:'dev:inode',approvedPath:'/approved'},toolBuild:'sealed',previousFloorHash:'a',targetFloorHash:'b',guardHash:'c'};
 assertRecoveryBinding(binding,binding);
 for(const key of ['databaseId','restoreEpoch','fileIdentity','approvedPath'] as const) assert.throws(()=>assertRecoveryBinding({...binding,database:{...binding.database,[key]:'other'}},binding));
 for(const key of ['operationId','toolBuild','previousFloorHash','targetFloorHash','guardHash'] as const) assert.throws(()=>assertRecoveryBinding({...binding,[key]:'other'},binding));
});

test('connection PRAGMAs, other feature support and persisted guard digest fail closed',()=>{
 const db=fixture(true,true);
 try {
  assertDeletionConnection(db);const digest=deletionGuardDigest(db);
  db.pragma('recursive_triggers=OFF');assert.throws(()=>assertDeletionConnection(db));db.pragma('recursive_triggers=ON');
  assert.throws(()=>db.prepare('UPDATE sessions SET provider=provider').run());
  db.exec('DROP TRIGGER nassaj_deletion_session_delete'); assert.notEqual(deletionGuardDigest(db),digest);
 } finally {db.close();}
});

test('restore only uses existing witnesses; no fresh witness or leftover intent survives',()=>{
 const db=fixture(false);
 try {
  tombstone(db);
  db.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('deletion',1,'sealed','now');db.exec(DELETION_GUARDS_SQL);
  assert.throws(()=>withDeletionTransaction(db,{operationId:'op',intentType:'permanent_session'},()=>{intent(db);db.exec('DELETE FROM sessions');}));
  withDeletionTransaction(db,{operationId:'restore',intentType:'restore_reconcile_session',restoreNonce:'offline-verified-test'},()=>{
   assert.throws(()=>tombstone(db,'other'));intent(db);db.exec('DELETE FROM sessions');
  });
  assert.equal((db.prepare('SELECT count(*) AS n FROM session_tombstones').get() as {n:number}).n,1);
 } finally {db.close();}
});

test('a project and its sessions consume separate intents in one atomic transaction',async()=>{
 const {withProjectMemberIntent}=await import('./deletion-guards.js');
 const db=fixture();
 try {
  withDeletionTransaction(db,{operationId:'project-op',intentType:'permanent_project'},()=>{
   db.prepare('INSERT INTO project_tombstones VALUES(?,?,?,?,?,?)').run('p','g','project-op','now','fingerprint',1);
   withProjectMemberIntent(db,()=>{tombstone(db);intent(db);db.exec('DELETE FROM sessions');});
   db.prepare('INSERT INTO project_delete_intents VALUES(?,nassaj_deletion_operation(),nassaj_deletion_intent(),nassaj_deletion_restore(),nassaj_deletion_transaction())').run('p');
   db.exec('DELETE FROM projects');
  });
  assert.equal((db.prepare('SELECT count(*) AS n FROM projects').get() as {n:number}).n,0);
  assert.throws(()=>withProjectMemberIntent(db,()=>{}));
 } finally {db.close();}
});

test('mismatched floors require locked offline recovery supporting BOTH endpoint sets',async()=>{
 const {assertPlatformAdmission,assertLockedRecovery}=await import('./platform-protocol-registry.js');
 const db=fixture(false);
 try {
  const previousFloor=[{feature:'outcomes' as const,protocolVersion:1,minimumBuild:'sealed'}];
  const targetFloor=[...previousFloor,{feature:'deletion' as const,protocolVersion:1,minimumBuild:'sealed'}];
  assert.throws(()=>assertPlatformAdmission(db,previousFloor,targetFloor));
  assertPlatformAdmission(db,targetFloor,[...targetFloor].reverse());
  const journal={operationId:'op',database:{databaseId:'db',restoreEpoch:'epoch',fileIdentity:'file',approvedPath:'/approved'},toolBuild:'sealed-test-only',previousFloorHash:protocolFloorHash(previousFloor),targetFloorHash:protocolFloorHash(targetFloor),guardHash:'c'};
  const input={journal,expected:journal,previousFloor,targetFloor,assertWriterLockHeld:()=>{},listenerRunning:false,schedulerRunning:false,providerRunning:false};
  assertLockedRecovery(db,input);
  assert.throws(()=>assertLockedRecovery(db,{...input,assertWriterLockHeld:()=>{throw new Error('LOCK_NOT_HELD');}}));
  for(const runtime of ['listenerRunning','schedulerRunning','providerRunning'] as const) assert.throws(()=>assertLockedRecovery(db,{...input,[runtime]:true}));
  assert.throws(()=>assertLockedRecovery(db,{...input,targetFloor:[{feature:'deletion',protocolVersion:2,minimumBuild:'other'}]}));
 } finally {db.close();}
});

test('unproven late sessions and missing fingerprint verifier cannot enter a fresh generation',()=>{
 const db=fixture();
 try {
  db.prepare('INSERT INTO project_generations VALUES(?,?,?,?,?,?,?)').run('new','g-new','different-fingerprint',1,'active','manual-op','request');
  assert.throws(()=>db.prepare('INSERT INTO projects(project_id,project_path) VALUES(?,?)').run('new','/a'));
  assert.throws(()=>db.prepare('INSERT INTO projects(project_id,project_path) VALUES(?,?)').run('new','/b'));
  assert.throws(()=>db.prepare('INSERT INTO sessions(session_id,provider,project_path) VALUES(?,?,?)').run('late','claude','/a'));
 } finally {db.close();}
});

for (const recursive of [0,1]) test(`QA regression: credential floor cannot be removed to reopen session writes (recursive=${recursive})`,()=>{
 const db=fixture(true,true);
 try {
  db.pragma(`recursive_triggers=${recursive}`);
  for(const sql of ["DELETE FROM platform_protocol_marker WHERE feature='credential_scope'", "UPDATE platform_protocol_marker SET protocol_version=2 WHERE feature='credential_scope'", "INSERT OR REPLACE INTO platform_protocol_marker VALUES('credential_scope',2,'other','now')", "UPDATE platform_protocol_marker SET feature='outcomes' WHERE feature='credential_scope'"]) {
   assert.throws(()=>db.exec(sql));
   assert.equal((db.prepare("SELECT protocol_version AS version FROM platform_protocol_marker WHERE feature='credential_scope'").get() as {version:number}).version,1);
   assert.throws(()=>db.exec('UPDATE sessions SET custom_name=custom_name'));
  }
 } finally {db.close();}
});

test('QA regression: project deletion binds generation, fingerprint, key and operation, and deletes root last',async()=>{
 const {withProjectMemberIntent}=await import('./deletion-guards.js');
 const db=fixture();
 try {
  for(const wrong of ['generation','fingerprint','key','operation','children']) {
   assert.throws(()=>withDeletionTransaction(db,{operationId:'project-op',intentType:'permanent_project'},()=>{
    db.prepare('INSERT INTO project_tombstones VALUES(?,?,?,?,?,?)').run('p',wrong==='generation'?'wrong':'g',wrong==='operation'?'wrong':'project-op','now',wrong==='fingerprint'?'wrong':'fingerprint',wrong==='key'?2:1);
    if(wrong!=='children') withProjectMemberIntent(db,()=>{tombstone(db);intent(db);db.exec('DELETE FROM sessions');});
    db.prepare('INSERT INTO project_delete_intents VALUES(?,nassaj_deletion_operation(),nassaj_deletion_intent(),nassaj_deletion_restore(),nassaj_deletion_transaction())').run('p');
    db.exec('DELETE FROM projects');
   }));
   assert.equal((db.prepare('SELECT count(*) AS n FROM sessions').get() as {n:number}).n,1);
   assert.equal((db.prepare('SELECT count(*) AS n FROM projects').get() as {n:number}).n,1);
   assert.equal((db.prepare('SELECT count(*) AS n FROM project_tombstones').get() as {n:number}).n,0);
  }
 } finally {db.close();}
});

test('QA regression: actual tombstone schema keeps immutable operation evidence and rejects private actor/path fields',()=>{
 const db=fixture();
 try {
  db.prepare('INSERT INTO users(id) VALUES(?)').run(7);
  for(const patch of [{operation_id:'wrong'}, {operation_id:null}, {operation_id:''}, {deleted_by:7}, {project_path:'/private'}, {source_path:'/private/file'}]) {
   assert.throws(()=>withDeletionTransaction(db,{operationId:'op',intentType:'permanent_session'},()=>{
    const row={operation_id:'op',deleted_by:null,project_path:null,source_path:null,...patch};
    db.prepare('INSERT INTO session_tombstones(session_id,provider,operation_id,deleted_by,project_path,source_path) VALUES(?,?,?,?,?,?)').run('s','claude',row.operation_id,row.deleted_by,row.project_path,row.source_path);
   }));
  }
  withDeletionTransaction(db,{operationId:'persistent-op',intentType:'permanent_session'},()=>{tombstone(db);intent(db);db.exec('DELETE FROM sessions');});
  const row=db.prepare('SELECT operation_id,deleted_by,project_path,source_path FROM session_tombstones WHERE session_id=?').get('s');
  assert.deepEqual(row,{operation_id:'persistent-op',deleted_by:null,project_path:null,source_path:null});
  assert.throws(()=>db.exec("UPDATE session_tombstones SET operation_id='other'"));
  assert.throws(()=>db.exec('DELETE FROM session_tombstones'));
 } finally {db.close();}
});
