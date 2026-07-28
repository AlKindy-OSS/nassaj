import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  OpenCodeProviderModels,
  parseOpenCodeSessionModelValue,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';

/**
 * B-239 — resuming an OpenCode session must hand `--model` a WIRE id.
 *
 * The defect: `session.model` in opencode.db is split into `{id, providerID}`,
 * and the reader returned `id` alone. Its production caller is
 * `resolveResumeModel`, so every resume of an existing session spawned
 * `opencode run --model glm-5.2` with the provider half amputated. Measured on
 * the owner's session: turn 1 answered on GLM, turn 2 died with exit code 1 and
 * no reply, turn 3 came back silently on `opencode/big-pickle`.
 *
 * WHY THESE TESTS ARE SHAPED THIS WAY — two deliberate choices:
 *
 *   1. **The fixtures are the operator's real rows**, read out of the live
 *      opencode.db (`select model, count(*) from session group by model`), not
 *      invented ones. A synthetic fixture is exactly what let this ship: the
 *      carrier was proven with a single one-shot `opencode run`, and a one-shot
 *      run is the only case that never reads this code.
 *   2. **One test drives the real SQLite read**, not just the parser. A parser
 *      unit test alone re-asserts the function against itself; the bug lived in
 *      what the DB column actually contains, so at least one test has to start
 *      from a row in a real table with the real schema.
 *
 * RUNNER: `npm run test:server`.
 */

/**
 * Every distinct `session.model` value present in the operator's opencode.db on
 * 2026-07-27, with its row count. Transcribed verbatim.
 */
const PRODUCTION_ROWS = [
  { rows: 8, raw: '{"id":"glm-5.2","providerID":"glm","variant":"default"}', wire: 'glm/glm-5.2' },
  { rows: 4, raw: '{"id":"glm-5.2[1m]","providerID":"glm","variant":"default"}', wire: 'glm/glm-5.2[1m]' },
  { rows: 4, raw: '{"id":"deepseek-v4-flash-free","providerID":"opencode","variant":"default"}', wire: 'opencode/deepseek-v4-flash-free' },
  { rows: 3, raw: '{"id":"glm-5.2","providerID":"opencode","variant":"default"}', wire: 'opencode/glm-5.2' },
  { rows: 3, raw: '{"id":"big-pickle","providerID":"opencode","variant":"default"}', wire: 'opencode/big-pickle' },
  { rows: 1, raw: '{"id":"claude-fable-5","providerID":"opencode","variant":"default"}', wire: 'opencode/claude-fable-5' },
  // The wreckage a failed resume leaves behind: opencode read the amputated
  // `glm-5.2` as a PROVIDER name and stored an empty model id.
  { rows: 1, raw: '{"id":"","providerID":"glm-5.2","variant":"default"}', wire: null },
] as const;

test('every real stored row parses to the id opencode run would accept (B-239)', () => {
  for (const { raw, wire } of PRODUCTION_ROWS) {
    assert.equal(parseOpenCodeSessionModelValue(raw), wire, `row ${raw}`);
  }
});

test('the two same-slug rows stay distinguishable — this is why the prefix matters', () => {
  // `glm-5.2` exists under BOTH our carrier and opencode's own paid route. With
  // the provider half dropped they collapsed to one string, so a session pinned
  // to z.ai and a session pinned to opencode's route resumed identically.
  const ours = parseOpenCodeSessionModelValue('{"id":"glm-5.2","providerID":"glm"}');
  const theirs = parseOpenCodeSessionModelValue('{"id":"glm-5.2","providerID":"opencode"}');
  assert.equal(ours, 'glm/glm-5.2');
  assert.equal(theirs, 'opencode/glm-5.2');
  assert.notEqual(ours, theirs);
});

test('a corrupted row yields no model rather than a string that names nothing', () => {
  // Must not become `glm-5.2/`. Null lets the caller fall back to the catalog
  // default instead of failing the next resume for a brand-new reason.
  assert.equal(parseOpenCodeSessionModelValue('{"id":"","providerID":"glm-5.2"}'), null);
  assert.equal(parseOpenCodeSessionModelValue('{"providerID":"glm"}'), null);
  assert.equal(parseOpenCodeSessionModelValue('{}'), null);
  assert.equal(parseOpenCodeSessionModelValue(''), null);
  assert.equal(parseOpenCodeSessionModelValue(null), null);
});

test('an id already in wire form is never prefixed twice', () => {
  assert.equal(parseOpenCodeSessionModelValue('glm/glm-5.2'), 'glm/glm-5.2');
  assert.equal(
    parseOpenCodeSessionModelValue('{"id":"glm/glm-5.2","providerID":"glm"}'),
    'glm/glm-5.2',
  );
});

test('a row with no providerID keeps the bare id (unchanged behaviour)', () => {
  assert.equal(parseOpenCodeSessionModelValue('{"id":"big-pickle"}'), 'big-pickle');
});

/**
 * The integration half: a real SQLite file, the real `session` schema (copied
 * from the live database), read through the real provider method. HOME is
 * redirected because `getOpenCodeDatabasePath()` derives the path from
 * `os.homedir()`, which honours $HOME on POSIX.
 */
test('getCurrentActiveModel reads a real row and returns a resumable id (B-239)', async () => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-resume-'));
  const dbDir = path.join(home, '.local', 'share', 'opencode');
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new Database(path.join(dbDir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (
      id TEXT NOT NULL,
      model TEXT,
      agent TEXT,
      directory TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      PRIMARY KEY (id)
    )
  `);
  const insert = db.prepare(
    'INSERT INTO session (id, model, agent, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('ses_carrier', PRODUCTION_ROWS[0].raw, 'build', '/tmp', 1, 2);
  insert.run('ses_builtin', PRODUCTION_ROWS[4].raw, 'build', '/tmp', 1, 2);
  db.close();

  process.env.HOME = home;
  try {
    const models = new OpenCodeProviderModels();

    // The carrier session: the exact pair that died on the owner's second turn.
    assert.equal((await models.getCurrentActiveModel('ses_carrier')).model, 'glm/glm-5.2');
    // A built-in session: the same amputation happened here, it was merely
    // survivable because opencode resolves a bare known slug from its catalog.
    assert.equal((await models.getCurrentActiveModel('ses_builtin')).model, 'opencode/big-pickle');
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
