import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import * as schema from './schema.js';
import { DELETION_PREPARATION_SQL } from './deletion-schema.js';
import { DELETION_DEPENDENCIES, assertDeletionDependencies } from './deletion-dependency-manifest.js';

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
