import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import * as schema from './schema.js';
import { DELETION_PREPARATION_SQL } from './deletion-schema.js';
import { DELETION_DEPENDENCIES, assertDeletionDependencies } from './deletion-dependency-manifest.js';
import { deleteSessionSidecars } from './deletion-sidecars.js';
import { migrateDocumentShares } from './document-shares.js';
import { migrateSessionShares } from './session-shares.js';

test('every exported schema and S1a session/project/path dependency is classified',()=>{
 const db=new Database(':memory:');
 try {
  // Execute CREATE TABLE statements only, avoiding migrations and every production connection.
  const statements=new Set<string>();
  for(const value of [...Object.values(schema),DELETION_PREPARATION_SQL]) {
   if(typeof value!=='string') continue;
   for(const match of value.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+\w+\s*\([\s\S]*?\);/gi)) statements.add(match[0]);
  }
  for(const statement of statements) db.exec(statement);
  assertDeletionDependencies(db);
  assert.equal(new Set(DELETION_DEPENDENCIES.map(row=>`${row.table}.${row.column}`)).size,DELETION_DEPENDENCIES.length);
  db.exec('CREATE TABLE unexpected_sidecar (session_id TEXT)');
  assert.throws(()=>assertDeletionDependencies(db),/UNCLASSIFIED/);
 } finally {db.close();}
});

test('pending server actions are deleted transactionally, not retained after session deletion',()=>{
 assert.equal(DELETION_DEPENDENCIES.find(row=>row.table==='pending_server_actions'&&row.column==='session_id')?.disposition,'transactional_delete');
});

// B-1514: share tables are created by startup migrations, not schema.js, so the scan above never saw them.
test('startup-migrated share tables are classified and session sidecar deletion passes with share rows',()=>{
 const db=new Database(':memory:');
 try {
  db.exec(schema.PROJECTS_TABLE_SCHEMA_SQL);
  db.exec(DELETION_PREPARATION_SQL);
  migrateDocumentShares(db);
  migrateSessionShares(db);
  db.prepare("INSERT INTO projects (project_id, project_path) VALUES ('p1','/srv/p1')").run();
  db.prepare(`INSERT INTO document_shares (id,project_id,relative_path,audience,root_dev,root_ino,created_by,created_at)
   VALUES ('d1','p1','README.md','members','1','2',1,'2026-10-04T00:00:00Z')`).run();
  db.prepare(`INSERT INTO session_shares (id,session_id,project_id,owner_user_id,token_hash,created_by,created_at,expires_at,
   snapshot_sha256,up_to_message_id,message_count,redaction_counts)
   VALUES ('s1','sess-1','p1',1,'h',1,'2026-10-04T00:00:00Z','2026-10-05T00:00:00Z','x','m1',1,'{}')`).run();
  db.prepare("INSERT INTO session_delete_batch_members (operation_id,session_id,project_id,generation) VALUES ('op1','sess-1','p1','g1')").run();
  assert.equal(DELETION_DEPENDENCIES.find(row=>row.table==='document_shares'&&row.column==='project_id')?.disposition,'cascade');
  assert.doesNotThrow(()=>deleteSessionSidecars(db,'op1'));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_shares').get() as {n:number}).n,0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM document_shares').get() as {n:number}).n,1,'project-scoped shares survive session deletion');
 } finally {db.close();}
});
