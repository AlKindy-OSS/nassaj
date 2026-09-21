import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { captureDatabasePreservation, verifyDatabasePreservation } from './lib/release-database-preservation.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const RELEASE = 'a'.repeat(64); const SOURCE = 'b'.repeat(64); const KEY = Buffer.alloc(32, 0x31);
const sqlite = (file, sql) => execFileSync('/usr/bin/sqlite3', [file, sql]);

test('final-database receipts detect stable-row tampering', (t) => {
    const root = mkdtempSync(path.join(TEMP, 'preservation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'database.sqlite');
    sqlite(file, `CREATE TABLE projects(project_id TEXT PRIMARY KEY,project_path TEXT,custom_project_name TEXT,
      isStarred INTEGER,isArchived INTEGER,visibility TEXT,created_by INTEGER);
      INSERT INTO projects VALUES('p1','/srv/p1','P1',1,0,'private',7);`);
    const before = captureDatabasePreservation(file, KEY, RELEASE, SOURCE);
    sqlite(file, "UPDATE projects SET custom_project_name='tampered' WHERE project_id='p1';");
    const after = captureDatabasePreservation(file, KEY, RELEASE, SOURCE);
    assert.deepEqual(verifyDatabasePreservation(before, after), { passed: false, mismatches: ['projects'] });
});

test('API-key receipts disclose no plaintext and prove the exact digest migration', (t) => {
    const root = mkdtempSync(path.join(TEMP, 'preservation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const beforeFile = path.join(root, 'before.sqlite'); const afterFile = path.join(root, 'after.sqlite');
    const secret = `ck_${'1'.repeat(64)}`; const digest = `sha256:${createHash('sha256').update(secret).digest('hex')}`;
    sqlite(beforeFile, `CREATE TABLE api_keys(id INTEGER PRIMARY KEY,user_id INTEGER,key_name TEXT,api_key TEXT,
      created_at TEXT,last_used TEXT,is_active INTEGER); INSERT INTO api_keys VALUES(1,7,'ci','${secret}','now',NULL,1);`);
    sqlite(afterFile, `CREATE TABLE api_keys(id INTEGER PRIMARY KEY,user_id INTEGER,key_name TEXT,key_digest TEXT,key_prefix TEXT,
      created_at TEXT,last_used TEXT,is_active INTEGER); INSERT INTO api_keys VALUES(1,7,'ci','${digest}','${secret.slice(0, 10)}','now',NULL,1);`);
    const before = captureDatabasePreservation(beforeFile, KEY, RELEASE, SOURCE);
    const after = captureDatabasePreservation(afterFile, KEY, RELEASE, SOURCE);
    assert.equal(JSON.stringify(before).includes(secret), false);
    assert.equal(verifyDatabasePreservation(before, after).passed, true);
});
