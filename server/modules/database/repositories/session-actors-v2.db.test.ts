import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { applySessionActorsV2Schema } from '../session-actors-v2.migration.js';

import { SessionActorsV2Repository } from './session-actors-v2.db.js';
import { actorSnapshotDto, assertActorSnapshot, type ActorSnapshot } from './session-actors-v2.validation.js';

const H = 'a'.repeat(64), B = 'b'.repeat(64);
function snapshot(): ActorSnapshot {
  return { session_id: 's', source_revision_sha256: H, parser_contract_sha256: B, cache_revision: 1,
    actors_status: 'complete', status_reason: 'complete', actor_count: 1, parsed_at_ms: 0,
    actors: [{ actor_id: 'act_'+H, launch_link_sha256: H, launch_evidence_sha256: B,
      requested_role: 'tester', requested_model: 'model-a', requested_reasoning_effort: null, observed_role: 'tester',
      evidence_status: 'complete', evidence_code: 'complete', role_mismatch: 0, model_mismatch: 0, sort_order: 0,
      observations: [{ observation_ordinal: 0, source_record_ordinal: 3, turn_id_sha256: H, model: 'model-a', evidence_sha256: B }] }] };
}
function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE sessions(session_id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('s'); CREATE TABLE session_agents_cache(value TEXT); INSERT INTO session_agents_cache VALUES('untouched')");
  db.transaction(() => applySessionActorsV2Schema(db)).immediate();
  return db;
}
test('exact revision CAS never yields to newer parsed time and stale source cannot be read', () => {
  const db = fixture(); try {
    const repo = new SessionActorsV2Repository(db), first = snapshot();
    assert.equal(repo.publish(first, null), 'published');
    const second = structuredClone(first); second.cache_revision=2; second.parsed_at_ms=10;
    assert.equal(repo.publish(second, 1), 'published');
    second.parsed_at_ms=Number.MAX_SAFE_INTEGER;
    assert.equal(repo.publish(second, 1), 'lost_race');
    assert.equal(repo.captureRevision('s'), 2);
    assert.equal(repo.readMatching('s', B, B), null);
    assert.equal(repo.readMatching('s', H, H), null);
    assert.equal(repo.readMatching('s', H, B)?.cache_revision, 2);
    assert.deepEqual(db.prepare('SELECT * FROM session_agents_cache').all(), [{value:'untouched'}]);
  } finally { db.close(); }
});
test('unavailable replaces current actors with empty collection and DTO hides internal proof', () => {
  const db=fixture(); try {
    const repo=new SessionActorsV2Repository(db); assert.equal(repo.publish(snapshot(),null),'published');
    const next=snapshot(); Object.assign(next,{cache_revision:2,actors_status:'unavailable',status_reason:'child_binding_invalid',actor_count:0,actors:[]});
    assert.equal(repo.publish(next,1),'published');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM session_actor_model_observations_v2').get().n,0);
    const dto=actorSnapshotDto(repo.readMatching('s',H,B)!);
    assert.deepEqual(dto,{schemaVersion:2,actorsStatus:'unavailable',actorsEvidenceCode:'child_binding_invalid',actors:[]});
  } finally {db.close();}
});
test('requested_invalid still computes other valid dimension mismatch independently', () => {
  for(const dimension of ['role','model']) {
    const row=snapshot(); row.actors_status='partial';row.status_reason='partial_actor_evidence';
    const a=row.actors[0];a.evidence_status='partial';a.evidence_code='requested_invalid';
    if(dimension==='role'){a.requested_role=null;a.requested_model='other';a.model_mismatch=1;}
    else{a.requested_model=null;a.requested_role='other';a.role_mismatch=1;}
    assert.doesNotThrow(()=>assertActorSnapshot(row));
    a.role_mismatch=0;a.model_mismatch=0;assert.throws(()=>assertActorSnapshot(row));
  }
});
const invalid: Array<[string,(x:ActorSnapshot)=>void]> = [
  ['unsafe timestamp',x=>{x.parsed_at_ms=Number.MAX_SAFE_INTEGER+1;}], ['numeric text',x=>{x.cache_revision='1' as never;}],
  ['fraction',x=>{x.cache_revision=1.2;}], ['NaN',x=>{x.parsed_at_ms=NaN;}], ['negative',x=>{x.parsed_at_ms=-1;}],
  ['count mismatch',x=>{x.actor_count=0;}], ['unavailable with actors',x=>{x.actors_status='unavailable';x.status_reason='source_drift';}],
  ['complete with partial',x=>{x.actors[0].evidence_status='partial';}], ['partial with complete',x=>{x.actors_status='partial';x.status_reason='partial_actor_evidence';}],
  ['unavailable actor',x=>{x.actors[0].evidence_status='unavailable';}], ['sparse observation',x=>{x.actors[0].observations[0].observation_ordinal=1;}],
  ['false mismatch',x=>{x.actors[0].model_mismatch=1;}], ['actor hash mismatch',x=>{x.actors[0].actor_id='act_'+B;}],
  ['model 129 bytes',x=>{x.actors[0].observations[0].model='é'.repeat(64)+'a';}], ['control',x=>{x.actors[0].observed_role='test\0er';}],
  ['noncanonical',x=>{x.actors[0].observed_role='e\u0301';}], ['session 257 bytes',x=>{x.session_id='s'.repeat(257);}],
];
for(const [name,mutate] of invalid)test(`validator rejects ${name} before SQL and DTO`,()=>{
  const db=fixture();try{const row=snapshot();mutate(row);assert.throws(()=>actorSnapshotDto(row));
    assert.equal(new SessionActorsV2Repository(db).publish(row,null),'rejected');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM session_actors_meta_v2').get().n,0);
  }finally{db.close();}
});
test('128 byte model and ordered repeated models remain valid',()=>{
  const row=snapshot();row.actors[0].requested_model=null;
  row.actors[0].observations=[0,1,2].map(i=>({observation_ordinal:i,source_record_ordinal:i+1,turn_id_sha256:String(i).repeat(64),model:i===1?'other':'é'.repeat(64),evidence_sha256:H}));
  assert.doesNotThrow(()=>assertActorSnapshot(row));assert.equal(actorSnapshotDto(row).actors[0].observedModels.length,3);
});
test('post-read validation suppresses SQL-valid but cross-field corrupt rows',()=>{
  const db=fixture();try{const repo=new SessionActorsV2Repository(db);repo.publish(snapshot(),null);
    db.exec("UPDATE session_actors_meta_v2 SET actor_count=0");assert.equal(repo.readMatching('s',H,B),null);
  }finally{db.close();}
});
test('replacement SQL failure rolls back old snapshot',()=>{
  const db=fixture();try{const repo=new SessionActorsV2Repository(db);repo.publish(snapshot(),null);
    db.exec("CREATE TRIGGER reject_actor BEFORE INSERT ON session_actors_v2 BEGIN SELECT RAISE(ABORT,'fixture'); END");
    const row=snapshot();row.cache_revision=2;assert.throws(()=>repo.publish(row,1));assert.equal(repo.captureRevision('s'),1);
    assert.equal(repo.readMatching('s',H,B)?.actors.length,1);
  }finally{db.close();}
});
for (const code of ['role_mismatch','model_mismatch','observed_role_missing','turn_evidence_conflict','model_missing']) {
  test(`cross-field positive ${code} survives CAS/read/DTO`,()=>{
    const db=fixture();try{
      const row=snapshot(),a=row.actors[0];row.actors_status='partial';row.status_reason='partial_actor_evidence';
      a.evidence_code=code;a.evidence_status='partial';
      if(code==='role_mismatch'){a.requested_role='architect';a.role_mismatch=1;a.evidence_status='mismatch';}
      if(code==='model_mismatch'){a.requested_model='model-b';a.model_mismatch=1;a.evidence_status='mismatch';}
      if(code==='observed_role_missing')a.observed_role=null;
      if(code==='model_missing')a.observations=[];
      const repo=new SessionActorsV2Repository(db);assert.equal(repo.publish(row,null),'published');
      assert.equal(actorSnapshotDto(repo.readMatching('s',H,B)!).actors[0].evidenceCode,code);
    }finally{db.close();}
  });
}
test('no children is complete and two equal-role executions retain separate identities',()=>{
  const db=fixture();try{
    const repo=new SessionActorsV2Repository(db);const row=snapshot();row.actors=[];row.actor_count=0;row.status_reason='no_children';
    assert.equal(repo.publish(row,null),'published');const next=snapshot();next.cache_revision=2;
    const second=structuredClone(next.actors[0]);second.actor_id='act_'+B;second.launch_link_sha256=B;second.sort_order=1;
    next.actors.push(second);next.actor_count=2;assert.equal(repo.publish(next,1),'published');
    assert.equal(repo.readMatching('s',H,B)?.actors.length,2);
  }finally{db.close();}
});
test('missing session, exhausted revision and externally nested transaction do not publish',()=>{
  const db=fixture();try{
    const repo=new SessionActorsV2Repository(db),row=snapshot();row.session_id='absent';assert.equal(repo.publish(row,null),'session_missing');
    row.session_id='s';assert.equal(repo.publish(row,Number.MAX_SAFE_INTEGER),'rejected');
    db.transaction(()=>assert.equal(repo.publish(row,null),'rejected'))();assert.equal(repo.captureRevision('s'),null);
  }finally{db.close();}
});
test('both valid mismatches select role first',()=>{
  const row=snapshot(),a=row.actors[0];row.actors_status='partial';row.status_reason='partial_actor_evidence';
  a.requested_role='other';a.requested_model='other';a.role_mismatch=1;a.model_mismatch=1;a.evidence_status='mismatch';a.evidence_code='role_mismatch';
  assert.doesNotThrow(()=>assertActorSnapshot(row));a.evidence_code='model_mismatch';assert.throws(()=>assertActorSnapshot(row));
});
test('all bounded actor/request identifiers reject byte overflow and non-string coercion',()=>{
  for(const [key,cap] of [['requested_role',128],['requested_model',128],['requested_reasoning_effort',32],['observed_role',128]] as const){
    for(const value of ['é'.repeat(cap/2)+'x',Buffer.from('tester'),1,{},'a\n']){
      const row=snapshot();row.actors[0][key]=value as never;assert.throws(()=>assertActorSnapshot(row));
    }
  }
  for(const key of ['launch_link_sha256','launch_evidence_sha256'] as const){
    for(const value of ['f'.repeat(65),'F'.repeat(64),Buffer.from(H)]){
      const row=snapshot();row.actors[0][key]=value as never;assert.throws(()=>assertActorSnapshot(row));
    }
  }
});
test('source ordinals must strictly increase and turn identities cannot repeat',()=>{
  const row=snapshot(),a=row.actors[0];a.observations.push({...a.observations[0],observation_ordinal:1,turn_id_sha256:B});
  assert.throws(()=>assertActorSnapshot(row));a.observations[1].source_record_ordinal=4;
  assert.doesNotThrow(()=>assertActorSnapshot(row));a.observations[1].turn_id_sha256=H;assert.throws(()=>assertActorSnapshot(row));
});

for (const code of ['requested_invalid', 'role_mismatch', 'observed_role_missing', 'turn_evidence_conflict']) {
  for (const count of [0, 1]) test(`CASE-18 ${code} keeps priority with ${count} observations through CAS/read/DTO`, () => {
    const db = fixture();
    try {
      const row = snapshot(), actor = row.actors[0];
      row.actors_status = 'partial'; row.status_reason = 'partial_actor_evidence';
      actor.evidence_status = 'partial'; actor.evidence_code = code;
      if (code === 'requested_invalid') actor.requested_role = null;
      if (code === 'role_mismatch') {
        actor.requested_role = 'architect'; actor.role_mismatch = 1; actor.evidence_status = 'mismatch';
      }
      if (code === 'observed_role_missing') actor.observed_role = null;
      if (count === 0) actor.observations = [];
      const repo = new SessionActorsV2Repository(db);
      assert.equal(repo.publish(row, null), 'published');
      const dto = actorSnapshotDto(repo.readMatching('s', H, B)!);
      assert.equal(dto.actors[0].evidenceCode, code);
      assert.equal(dto.actors[0].observedModels.length, count);
      assert.equal(dto.actors[0].modelMismatch, false);
    } finally { db.close(); }
  });
}
for (const kind of ['complete', 'model_mismatch']) test(`CASE-18 rejects ${kind} with no model evidence`, () => {
  const db = fixture();
  try {
    const row = snapshot(); row.actors[0].observations = [];
    if (kind === 'model_mismatch') {
      row.actors_status = 'partial'; row.status_reason = 'partial_actor_evidence';
      Object.assign(row.actors[0], { evidence_status: 'mismatch', evidence_code: 'model_mismatch', model_mismatch: 1 });
    }
    assert.equal(new SessionActorsV2Repository(db).publish(row, null), 'rejected');
    assert.throws(() => actorSnapshotDto(row));
  } finally { db.close(); }
});
test('CASE-18 model_missing cannot displace a higher-priority role reason', () => {
  for (const observedRole of [null, 'architect']) {
    const row = snapshot(), actor = row.actors[0];
    row.actors_status = 'partial'; row.status_reason = 'partial_actor_evidence';
    actor.observations = []; actor.observed_role = observedRole;
    actor.role_mismatch = observedRole === null ? 0 : 1;
    actor.evidence_status = 'partial'; actor.evidence_code = 'model_missing';
    assert.throws(() => assertActorSnapshot(row));
  }
});
test('lexical amendment preserves decomposed model bytes rather than NFC normalization',()=>{
  const db=fixture();try{const row=snapshot();row.actors[0].requested_model='e\u0301';row.actors[0].observations[0].model='e\u0301';
    const repo=new SessionActorsV2Repository(db);assert.equal(repo.publish(row,null),'published');
    assert.equal(repo.readMatching('s',H,B)?.actors[0].observations[0].model,'e\u0301');
  }finally{db.close();}
});
