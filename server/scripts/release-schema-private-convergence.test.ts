import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  EXPECTED_PRIVATE_COMPONENT_TARGETS,
  runPrivateSchemaConvergenceGate,
} from './release-schema-private-convergence.js';

const sha256 = (filename: string): string => createHash('sha256').update(readFileSync(filename)).digest('hex');

function testRoot(): string {
  const parent = process.env.NASSAJ_TEST_TEMP_ROOT ?? process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? os.tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return mkdtempSync(path.join(parent, 'schema-private-gate-test-'));
}

function source(filename: string, variant: 'alter-history' | 'canonical-create'): void {
  const db = new Database(filename);
  try {
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, password_changed_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY NOT NULL, project_path TEXT NOT NULL UNIQUE,
        ${variant === 'canonical-create' ? 'detected_name TEXT DEFAULT NULL,' : ''}
        visibility TEXT NOT NULL DEFAULT 'public'
        ${variant === 'alter-history' ? ', detected_name TEXT' : ''}
      );
      CREATE TABLE project_members (project_id TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(project_id,user_id));
      CREATE INDEX idx_project_members_user ON project_members(user_id);
    `);
  } finally {
    db.close();
  }
}

function manifest(root: string, fixtures: string[]): string {
  const manifestPath = path.join(root, 'MANIFEST.json');
  const files = fixtures.map((filename) => ({
    path: path.relative(root, filename).split(path.sep).join('/'),
    size: statSync(filename).size,
    sha256: sha256(filename),
  }));
  writeFileSync(manifestPath, JSON.stringify({
    schema: 'nassaj-installed-artifact-rehearsal-manifest/v1',
    files,
  }));
  return manifestPath;
}

test('explicit gate converges portable archive-like fixtures without a private .git database', () => {
  const root = testRoot();
  try {
    const fixtures = [path.join(root, 'actual.sqlite'), path.join(root, 'published.sqlite')];
    source(fixtures[0], 'alter-history');
    source(fixtures[1], 'canonical-create');
    const report = runPrivateSchemaConvergenceGate({
      manifestPath: manifest(root, fixtures), fixturePaths: fixtures, tempRoot: root,
    });
    assert.deepEqual(report, { sourceCount: 2, targets: EXPECTED_PRIVATE_COMPONENT_TARGETS });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source hash drift rejects every fixture before any database is opened', () => {
  const root = testRoot();
  let opened = 0;
  try {
    const fixtures = [path.join(root, 'actual.sqlite'), path.join(root, 'published.sqlite')];
    source(fixtures[0], 'alter-history');
    source(fixtures[1], 'canonical-create');
    const manifestPath = manifest(root, fixtures);
    appendFileSync(fixtures[1], Buffer.from([0]));
    assert.throws(() => runPrivateSchemaConvergenceGate({
      manifestPath,
      fixturePaths: fixtures,
      tempRoot: root,
      databaseFactory: (filename) => { opened += 1; return new Database(filename); },
    }), /release_schema_private_gate_fixture_(size|hash)_mismatch/);
    assert.equal(opened, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
