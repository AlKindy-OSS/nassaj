import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { applySessionActorsV2Schema, SESSION_ACTORS_DDL, SESSION_ACTORS_OBJECTS } from './session-actors-v2.migration.js';

function fixture() {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  db.exec("CREATE TABLE sessions(session_id TEXT PRIMARY KEY); INSERT INTO sessions VALUES('s'); CREATE TABLE session_agents_cache(value TEXT); INSERT INTO session_agents_cache VALUES('legacy')");return db;
}
test('pure component creates exactly three empty tables/two indexes and preserves old data',()=>{
  const db=fixture();try{
    assert.throws(()=>applySessionActorsV2Schema(db),/transaction_required/);
    db.transaction(()=>applySessionActorsV2Schema(db)).immediate();
    const objects=db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[];
    assert.deepEqual(objects.map(x=>x.name),[...SESSION_ACTORS_OBJECTS,'sessions','session_agents_cache'].sort());
    for(const name of ['session_actors_v2','session_actor_model_observations_v2','session_actors_meta_v2'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n,0);
    assert.deepEqual(db.prepare('SELECT * FROM session_agents_cache').all(),[{value:'legacy'}]);
    assert.throws(()=>db.transaction(()=>applySessionActorsV2Schema(db)).immediate(),/source_invalid/);
    assert.deepEqual(db.pragma('foreign_key_check'),[]);
  }finally{db.close();}
});
for(let fault=0;fault<5;fault++)test(`caller-owned transaction rolls back after DDL ${fault}`,()=>{
  const db=fixture();try{
    assert.throws(()=>db.transaction(()=>{for(const [i,ddl] of SESSION_ACTORS_DDL.entries()){db.exec(ddl);if(i===fault)throw Error('fault');}}).immediate());
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name LIKE '%actors%v2%' OR name LIKE '%observations_v2%'").get().n,0);
    assert.deepEqual(db.prepare('SELECT * FROM session_agents_cache').all(),[{value:'legacy'}]);
  }finally{db.close();}
});
test('partial schema and name collisions fail closed without further objects',()=>{
  const db=fixture();try{db.exec('CREATE VIEW session_actors_v2 AS SELECT 1');
    assert.throws(()=>db.transaction(()=>applySessionActorsV2Schema(db)).immediate(),/source_invalid/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='session_actors_meta_v2'").get().n,0);
  }finally{db.close();}
});
test('DDL exactly matches accepted bytes and contains no mutation/transaction or v1 references',()=>{
  assert.equal(SESSION_ACTORS_DDL.length,5);
  for(const sql of SESSION_ACTORS_DDL){assert.match(sql,/^CREATE (TABLE|INDEX) /);assert.doesNotMatch(sql,/\b(UPDATE|INSERT|BEGIN|COMMIT|ALTER|DROP)\b|session_agents_cache|session_agents_meta/);}
});
test('DDL integer and hash defenses reject representable invalid storage, repo rejects coercion earlier',()=>{
  const db=fixture();try{db.transaction(()=>applySessionActorsV2Schema(db)).immediate();
    const insert=db.prepare('INSERT INTO session_actors_meta_v2 VALUES (?,?,?,?,?,?,?,?)');
    const valid=['s','a'.repeat(64),'b'.repeat(64),1,'complete','no_children',0,0];
    for(const i of [3,6,7])for(const value of [-1,0.5,Buffer.from('1'),Number.MAX_SAFE_INTEGER+1]){
      const row=[...valid];row[i]=value as never;assert.throws(()=>insert.run(...row));
    }
    for(const i of [1,2])for(const value of ['A'.repeat(64),'a'.repeat(63),Buffer.from('a'.repeat(64))]){
      const row=[...valid];row[i]=value as never;assert.throws(()=>insert.run(...row));
    }
    assert.doesNotThrow(()=>insert.run(...valid));
  }finally{db.close();}
});
