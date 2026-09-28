/**
 * rekeyForHandover — the ledger half of a declared agy session handover.
 * Proven against the real schema: every precondition is read inside the same
 * transaction as the rekey, and any refusal leaves the ledger untouched.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionWorkspaceModesDb } from '@/modules/database/repositories/session-workspace-modes.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

const PROJECT = '/var/tmp/handover-ledger-project';
const FROM = 'agy_1790531982349_26187fb5';
const TO = 'e70cd70d-8a4f-4694-9304-37f6e440249e';
const JSONL = `/var/tmp/brain/${TO}/.system_generated/logs/transcript.jsonl`;

async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'handover-ledger-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function seed(mode: 'overlay' | 'legacy_shared' = 'overlay'): number {
  const uid = userDb.createUser(`ledger-${Math.random()}`, 'hash', 'user').id;
  if (mode === 'overlay') sessionWorkspaceModesDb.markOverlay(FROM, PROJECT, 'antigravity');
  else sessionWorkspaceModesDb.markShared(FROM, PROJECT, 'antigravity');
  sessionsDb.createSession(TO, 'antigravity', PROJECT, undefined, undefined, undefined, JSONL);
  return uid;
}

const ledger = () => getConnection()
  .prepare('SELECT session_id, mode, project_path, provider FROM session_workspace_modes ORDER BY session_id')
  .all();

function rekey(uid: number, overrides: Record<string, unknown> = {}) {
  sessionWorkspaceModesDb.rekeyForHandover({
    fromSessionId: FROM,
    toSessionId: TO,
    mode: 'overlay',
    projectPath: PROJECT,
    provider: 'antigravity',
    principalUserId: uid,
    verifyTarget: () => undefined,
    ...overrides,
  });
}

test('overlay and shared rows move to the durable id with their mode kept', async () => {
  for (const mode of ['overlay', 'legacy_shared'] as const) {
    await withDatabase(() => {
      const uid = seed(mode);
      let verified: unknown = null;
      rekey(uid, { mode, verifyTarget: (row: unknown) => { verified = row; } });
      assert.deepEqual(ledger(), [{ session_id: TO, mode, project_path: PROJECT, provider: 'antigravity' }]);
      assert.equal((verified as { jsonl_path: string }).jsonl_path, JSONL);
    });
  }
});

test('every failed precondition refuses and leaves the ledger unchanged', async () => {
  const cases: Array<[string, (uid: number) => Record<string, unknown> | void, RegExp]> = [
    ['foreign from', () => ({ fromSessionId: 'agy_1_other' }), /source binding/],
    ['mode mismatch', () => ({ mode: 'legacy_shared' }), /source binding/],
    ['project mismatch', () => ({ projectPath: '/var/tmp/other' }), /source binding/],
    ['non-agy provider', () => ({ provider: 'claude' }), /source binding/],
    ['target already bound', () => {
      sessionWorkspaceModesDb.markOverlay(TO, PROJECT, 'antigravity');
    }, /already has a workspace binding/],
    ['foreign participant', () => {
      const stranger = userDb.createUser(`stranger-${Math.random()}`, 'hash', 'user').id;
      getConnection().prepare(
        "INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, 'owner')",
      ).run(TO, stranger);
    }, /another participant/],
    ['anonymous principal with any participant', (uid) => {
      getConnection().prepare(
        "INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, 'owner')",
      ).run(TO, uid);
      return { principalUserId: null };
    }, /another participant/],
    ['target of another provider', () => {
      getConnection().prepare("UPDATE sessions SET provider = 'claude' WHERE session_id = ?").run(TO);
    }, /target session/],
    ['target in another project', () => {
      sessionsDb.createSession(TO, 'antigravity', '/var/tmp/handover-other', undefined, undefined, undefined, JSONL);
    }, /target session/],
    ['no target row', () => ({ toSessionId: '11111111-2222-4333-8444-555555555555' }), /target session/],
    ['evidence refused', () => ({ verifyTarget: () => { throw new Error('brain predates launch'); } }),
      /brain predates launch/],
  ];
  for (const [label, arrange, expected] of cases) {
    await withDatabase(() => {
      const uid = seed();
      const before = JSON.stringify(ledger());
      const overrides = arrange(uid) ?? {};
      const snapshot = JSON.stringify(ledger());
      assert.throws(() => rekey(uid, overrides), expected, label);
      assert.equal(JSON.stringify(ledger()), snapshot, `${label}: ledger unchanged`);
      assert.ok(before.includes(FROM), label);
    });
  }
});

test('the principal itself may already participate in the target', async () => {
  await withDatabase(() => {
    const uid = seed();
    getConnection().prepare(
      "INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, 'owner')",
    ).run(TO, uid);
    rekey(uid);
    assert.equal((ledger()[0] as { session_id: string }).session_id, TO);
  });
});
