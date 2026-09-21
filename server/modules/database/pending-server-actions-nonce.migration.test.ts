import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migratePendingServerActionAttemptNonce } from './migrations.js';

/** SQL tracing proves that an additive repair never rewrites receipts or indexes. */
function fixture(column = '') {
  const statements: string[] = [];
  const db = new Database(':memory:', { verbose: sql => statements.push(sql) });
  db.exec(`CREATE TABLE pending_server_actions (id TEXT PRIMARY KEY, status TEXT${column ? `, ${column}` : ''});
    CREATE INDEX fixture_status ON pending_server_actions(status);
    CREATE UNIQUE INDEX fixture_pending ON pending_server_actions(id) WHERE status = 'pending';
    CREATE TABLE unrelated (id INTEGER PRIMARY KEY, content TEXT);
    INSERT INTO unrelated VALUES (1, 'keep');`);
  db.prepare('INSERT INTO pending_server_actions(id,status) VALUES (?,?)').run('pending-1', 'pending');
  db.prepare('INSERT INTO pending_server_actions(id,status) VALUES (?,?)').run('failed-1', 'failed');
  statements.length = 0;
  return {db, statements};
}
const indexes = (db: Database.Database) => db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' ORDER BY name").all();
const shape = (db: Database.Database) => db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();

test('nonce repair adds one nullable TEXT column, preserves rows and indexes, and has no other DDL/DML', () => {
  const {db, statements} = fixture();
  try {
    const beforeIndexes = indexes(db);
    const rows = db.prepare('SELECT * FROM pending_server_actions ORDER BY id').all();
    statements.length = 0;
    migratePendingServerActionAttemptNonce(db);
    assert.deepEqual(statements, ['PRAGMA table_xinfo(pending_server_actions)',
      'ALTER TABLE pending_server_actions ADD COLUMN execution_attempt_nonce TEXT']);
    assert.deepEqual(db.prepare('SELECT * FROM pending_server_actions ORDER BY id').all(),
      rows.map(row => ({...row as object, execution_attempt_nonce:null})));
    const column = (db.prepare('PRAGMA table_xinfo(pending_server_actions)').all() as Array<Record<string,unknown>>)
      .find(row => row.name === 'execution_attempt_nonce');
    assert.deepEqual(column, {cid:2,name:'execution_attempt_nonce',type:'TEXT',notnull:0,dflt_value:null,pk:0,hidden:0});
    assert.deepEqual(indexes(db),beforeIndexes);
    assert.deepEqual(db.prepare('SELECT * FROM unrelated').all(),[{id:1,content:'keep'}]);
  } finally { db.close(); }
});

test('already-correct nonce storage is a read-only no-op preserving populated and null receipts', () => {
  const {db,statements} = fixture('execution_attempt_nonce TEXT');
  try {
    db.prepare('UPDATE pending_server_actions SET execution_attempt_nonce = ? WHERE id = ?').run('nonce-original','pending-1');
    const rows=db.prepare('SELECT * FROM pending_server_actions ORDER BY id').all();
    const schema=shape(db);
    statements.length=0;
    migratePendingServerActionAttemptNonce(db);
    migratePendingServerActionAttemptNonce(db);
    assert.deepEqual(statements,['PRAGMA table_xinfo(pending_server_actions)','PRAGMA table_xinfo(pending_server_actions)']);
    assert.deepEqual(db.prepare('SELECT * FROM pending_server_actions ORDER BY id').all(),rows);
    assert.deepEqual(shape(db),schema);
  } finally { db.close(); }
});

for (const column of [
  'execution_attempt_nonce INTEGER',
  "execution_attempt_nonce TEXT NOT NULL DEFAULT ''",
  'execution_attempt_nonce TEXT DEFAULT NULL',
  "execution_attempt_nonce TEXT DEFAULT 'invented'",
  'execution_attempt_nonce TEXT GENERATED ALWAYS AS (id) VIRTUAL',
  'execution_attempt_nonce TEXT GENERATED ALWAYS AS (id) STORED',
]) test(`incompatible nonce storage rejects without writes: ${column}`, () => {
  const {db,statements}=fixture(column);
  try {
    const schema=shape(db);
    const rows=db.prepare('SELECT * FROM pending_server_actions ORDER BY id').all();
    statements.length=0;
    assert.throws(()=>migratePendingServerActionAttemptNonce(db),/schema_incompatible/);
    assert.deepEqual(statements,['PRAGMA table_xinfo(pending_server_actions)']);
    assert.deepEqual(shape(db),schema);
    assert.deepEqual(db.prepare('SELECT * FROM pending_server_actions ORDER BY id').all(),rows);
  } finally { db.close(); }
});

test('missing action table is rejected without creating a substitute', () => {
  const db=new Database(':memory:');
  try {
    assert.throws(()=>migratePendingServerActionAttemptNonce(db),/table_missing/);
    assert.deepEqual(shape(db),[]);
  } finally { db.close(); }
});

test('NOT NULL alone is incompatible even without any default expression', () => {
  const statements: string[]=[];
  const db=new Database(':memory:',{verbose:sql=>statements.push(sql)});
  try {
    db.exec('CREATE TABLE pending_server_actions (id TEXT PRIMARY KEY, execution_attempt_nonce TEXT NOT NULL)');
    statements.length=0;
    assert.throws(()=>migratePendingServerActionAttemptNonce(db),/schema_incompatible/);
    assert.deepEqual(statements,['PRAGMA table_xinfo(pending_server_actions)']);
  } finally {db.close();}
});
