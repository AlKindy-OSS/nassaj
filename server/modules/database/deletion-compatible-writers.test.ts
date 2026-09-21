import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import Database from 'better-sqlite3';

import { PROJECTS_TABLE_SCHEMA_SQL, SESSIONS_TABLE_SCHEMA_SQL, SESSION_TOMBSTONES_TABLE_SCHEMA_SQL } from './schema.js';
import { DELETION_PREPARATION_SQL, SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL } from './deletion-schema.js';
import { registerPlatformProtocol, PLATFORM_PROTOCOL_GUARDS_SQL } from './platform-protocol-registry.js';
import { registerDeletionIntents, DELETION_GUARDS_SQL } from './deletion-guards.js';

test('actual compatible writer updates existing rows without INSERT triggers, preserves metadata/children and refuses unknown source bindings',async(t)=>{
 const dir=mkdtempSync(fileURLToPath(new URL('./deletion-writer-fixture-',import.meta.url)));
 const previous={DATABASE_PATH:process.env.DATABASE_PATH,TMPDIR:process.env.TMPDIR};
 process.env.DATABASE_PATH=`${dir}/db.sqlite`;process.env.TMPDIR=dir;
 let closeConnection: (()=>void)|undefined;
 try{
  writeFileSync(process.env.DATABASE_PATH!,'',{flag:'wx',mode:0o600});
  const seed=new Database(process.env.DATABASE_PATH!);
  try{seed.exec('CREATE TABLE users(id INTEGER PRIMARY KEY)');seed.exec(PROJECTS_TABLE_SCHEMA_SQL);seed.exec(SESSIONS_TABLE_SCHEMA_SQL);seed.exec(SESSION_TOMBSTONES_TABLE_SCHEMA_SQL);}finally{seed.close();}
  const exists=fs.existsSync;
  const denied: string[]=[];
  t.mock.method(fs,'existsSync',(path:fs.PathLike)=>{if(String(path).endsWith('/database/auth.db')){denied.push(String(path));throw new Error('fixture forbids reference database access');}return exists(path);});
  t.mock.method(fs,'copyFileSync',()=>{denied.push('copyFileSync');throw new Error('fixture forbids fallback copy');});
  const connection=await import('./connection.js');closeConnection=connection.closeConnection;
  const {sessionsDb}=await import('./repositories/sessions.db.js');
  const {projectsDb}=await import('./repositories/projects.db.js');
  const db=connection.getConnection();db.pragma('recursive_triggers=ON');db.pragma('synchronous=FULL');
  assert.deepEqual(denied,[]);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sessions').get() as {n:number}).n,0);
  sessionsDb.createSession('s','claude','/fixture','saved','2025-01-01','2025-01-01','/source');
  sessionsDb.updateSessionIsArchived('s',true);db.prepare("UPDATE sessions SET engine_provider='anthropic',engine_provider_source='server_verdict' WHERE session_id='s'").run();
  db.exec('CREATE TABLE fixture_children(session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE)');db.prepare('INSERT INTO fixture_children VALUES(?)').run('s');
  db.exec(DELETION_PREPARATION_SQL);db.exec(SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL);
  const project=projectsDb.getProjectPath('/fixture')!;
  db.prepare("INSERT INTO project_generations VALUES(?,'g','fp',1,'active','create','hash')").run(project.project_id);
  db.prepare("INSERT INTO session_generation_bindings VALUES('s',?,'g','source','nassaj_created','proof')").run(project.project_id);
  db.prepare("INSERT INTO platform_protocol_marker VALUES('deletion',1,'fixture','now')").run();
  registerPlatformProtocol(db,{buildId:'fixture',supports:{deletion:[1],credential_scope:[],outcomes:[]}});registerDeletionIntents(db,()=>false);db.exec(PLATFORM_PROTOCOL_GUARDS_SQL);db.exec(DELETION_GUARDS_SQL);
  sessionsDb.createSession('s','claude','/fixture',undefined,'2026-01-01','2026-01-02','/source');
  const row=sessionsDb.getSessionById('s')!;assert.equal(row.custom_name,'saved');assert.equal(row.isArchived,1);assert.equal(row.engine_provider,'anthropic');assert.equal(row.created_at,'2025-01-01T00:00:00.000Z');assert.equal(row.updated_at,'2026-01-02T00:00:00.000Z');assert.ok(db.prepare('SELECT 1 FROM fixture_children').get());
  assert.throws(()=>sessionsDb.createSession('late','claude','/fixture'));
  assert.throws(()=>sessionsDb.createSession('s','codex','/fixture'));
  assert.equal(sessionsDb.getSessionById('s')!.provider,'claude');
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  assert.deepEqual(denied,[]);
 }finally{closeConnection?.();t.mock.restoreAll();for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(dir,{recursive:true,force:true});}
});
