/**
 * B-1551 M1 — isOpenCodeSessionOnlyOnGrantTree: a spawn-vendor turn runs on the
 * sender's OWN opencode data dir, so a session that lives only in the grantor's
 * dir is refused before spawn. True only on positive evidence: absent from the
 * own opencode.db AND present in the grant dir's. Any unreadable store → false.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import Database from 'better-sqlite3';

// B-1544: must stay the first app-side import (HOME, DATABASE_PATH, harness roots).
import { removeSandbox, sandboxRoot } from '@/modules/providers/tests/helpers/hermetic-sandbox.js';

const OWN = path.join(sandboxRoot, 'own');
const GRANT = path.join(sandboxRoot, 'grant');
let underGrant = true;
const calls: unknown[] = [];

mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: {
    resolveProviderEnv: (_userId: unknown, _provider: unknown, _base: unknown, _mode: unknown, options?: { honorGrants?: boolean }) => {
      calls.push(options);
      const own = options?.honorGrants === false || !underGrant;
      return { XDG_DATA_HOME: own ? OWN : GRANT };
    },
  },
});

const { isOpenCodeSessionOnlyOnGrantTree } = await import('./opencode-home.js');

function writeDb(dataRoot: string, sessionIds: string[]): void {
  const dir = path.join(dataRoot, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'opencode.db'));
  db.exec('CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY)');
  for (const id of sessionIds) db.prepare('INSERT OR IGNORE INTO session (id) VALUES (?)').run(id);
  db.close();
}

beforeEach(() => {
  underGrant = true;
  calls.length = 0;
  fs.rmSync(OWN, { recursive: true, force: true });
  fs.rmSync(GRANT, { recursive: true, force: true });
});
after(() => { mock.restoreAll(); removeSandbox(); });

test('a session only in the grantor dir is refused; the own dir is read with grants off', () => {
  writeDb(OWN, ['ses_own']);
  writeDb(GRANT, ['ses_grant']);
  assert.equal(isOpenCodeSessionOnlyOnGrantTree(7, 'ses_grant'), true);
  assert.ok(calls.some((options) => (options as { honorGrants?: boolean })?.honorGrants === false));
  assert.equal(isOpenCodeSessionOnlyOnGrantTree(7, 'ses_own'), false, 'own session resumes');
});

test('an own dir with no opencode.db yet still refuses a grant-dir session', () => {
  writeDb(GRANT, ['ses_grant']);
  assert.equal(isOpenCodeSessionOnlyOnGrantTree(7, 'ses_grant'), true);
});

test('no evidence, no refusal: unknown session, no grant, unreadable store, no id', () => {
  writeDb(OWN, []);
  writeDb(GRANT, []);
  assert.equal(isOpenCodeSessionOnlyOnGrantTree(7, 'ses_nowhere'), false, 'opencode keeps the final word');
  writeDb(GRANT, ['ses_both']);
  writeDb(OWN, ['ses_both']);
  assert.equal(isOpenCodeSessionOnlyOnGrantTree(7, 'ses_both'), false);
  fs.writeFileSync(path.join(GRANT, 'opencode', 'opencode.db'), 'not a database');
  assert.equal(isOpenCodeSessionOnlyOnGrantTree(7, 'ses_grant'), false, 'unreadable grant store');
  underGrant = false;
  assert.equal(isOpenCodeSessionOnlyOnGrantTree(7, 'ses_both'), false, 'no grant: same dir');
  for (const [userId, sessionId] of [[7, ''], [7, null], [null, 'ses_both'], ['', 'ses_both']] as const) {
    assert.equal(isOpenCodeSessionOnlyOnGrantTree(userId, sessionId), false);
  }
});
