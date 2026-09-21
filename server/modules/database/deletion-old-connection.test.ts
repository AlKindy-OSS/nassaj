import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { DELETION_PREPARATION_SQL, SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL } from './deletion-schema.js';
import { DELETION_GUARDS_SQL, registerDeletionIntents, assertDeletionConnection } from './deletion-guards.js';
import { registerPlatformProtocol, PLATFORM_PROTOCOL_GUARDS_SQL } from './platform-protocol-registry.js';
import { PROJECTS_TABLE_SCHEMA_SQL, SESSIONS_TABLE_SCHEMA_SQL, SESSION_TOMBSTONES_TABLE_SCHEMA_SQL } from './schema.js';

test('an old connection opened before guards install fails closed at prepare/reprepare, including ordinary writes',()=>{
 const dir=mkdtempSync(fileURLToPath(new URL('./deletion-fixture-',import.meta.url)));
 let old: Database.Database|undefined;let current: Database.Database|undefined;
 try {
  old=new Database(`${dir}/test.db`);old.exec('CREATE TABLE users(id INTEGER PRIMARY KEY)');
  old.exec(PROJECTS_TABLE_SCHEMA_SQL);old.exec(SESSIONS_TABLE_SCHEMA_SQL);old.exec(SESSION_TOMBSTONES_TABLE_SCHEMA_SQL);
  old.prepare('INSERT INTO projects(project_id,project_path) VALUES(?,?)').run('p','/a');
  old.prepare('INSERT INTO sessions(session_id,provider,project_path) VALUES(?,?,?)').run('s','claude','/a');
  current=new Database(`${dir}/test.db`);current.pragma('foreign_keys=ON');current.pragma('recursive_triggers=ON');current.pragma('synchronous=FULL');
  registerPlatformProtocol(current,{buildId:'fixture-sealed',supports:{deletion:[1],credential_scope:[],outcomes:[]}});registerDeletionIntents(current);
  current.exec(DELETION_PREPARATION_SQL);current.exec(SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL);
  current.transaction(()=>{current!.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('deletion',1,'fixture-sealed','now');current!.prepare('INSERT INTO platform_protocol_marker VALUES(?,?,?,?)').run('credential_scope',1,'fixture-sealed','now');current!.exec(PLATFORM_PROTOCOL_GUARDS_SQL);current!.exec(DELETION_GUARDS_SQL);})();
  assertDeletionConnection(current);
  for(const sql of ['DELETE FROM sessions',"UPDATE sessions SET provider=provider","INSERT INTO sessions(session_id,provider,project_path) VALUES('new','claude','/a')"]) assert.throws(()=>old!.prepare(sql).run(),/no such function/);
  for(const sql of ["DELETE FROM platform_protocol_marker WHERE feature='credential_scope'","UPDATE platform_protocol_marker SET protocol_version=2 WHERE feature='credential_scope'","INSERT OR REPLACE INTO platform_protocol_marker VALUES('credential_scope',2,'other','now')"]) assert.throws(()=>old!.prepare(sql).run());
  assert.throws(()=>current!.prepare('UPDATE sessions SET provider=provider').run());
  assert.equal((old.prepare('SELECT count(*) AS n FROM sessions').get() as {n:number}).n,1);
 } finally {old?.close();current?.close();rmSync(dir,{recursive:true,force:true});}
});
