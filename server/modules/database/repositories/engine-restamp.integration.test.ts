import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { PIN_SOURCE } from '@/services/isolation/engine-pin.js';

/**
 * ADR-099/T-1237 — the precedence rules that make a user's engine switch stick
 * without re-opening what ADR-088 closed.
 *
 * These run against real migrations on a temp database (the established harness)
 * because the whole subject is a WHERE clause: a mocked repository would assert
 * the test's own idea of the rule rather than SQLite's.
 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'engine-restamp-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * `sessions.project_path` carries a FOREIGN KEY into `projects`, so a session
 * cannot be seeded against a path that does not exist. Left NULL here: the pin
 * rules under test are keyed by session_id alone and never read the path.
 */
function seedSession(sessionId: string): void {
  getConnection()
    .prepare(
      `INSERT INTO sessions (session_id, provider, project_path, jsonl_path)
       VALUES (?, 'claude', NULL, '/tmp/p.jsonl')`,
    )
    .run(sessionId);
}

test('user_switch overwrites a settled server_verdict pin — the whole feature', async () => {
  await withIsolatedDatabase(() => {
    seedSession('s1');
    sessionsDb.setSessionEnginePin('s1', 'glm', PIN_SOURCE.SERVER_VERDICT);
    assert.equal(sessionsDb.getSessionEnginePin('s1')?.engine, 'glm');

    const result = sessionsDb.setSessionEnginePin('s1', 'anthropic', PIN_SOURCE.USER_SWITCH, {
      intent: true,
    });

    assert.equal(result.outcome, 'restamped');
    assert.equal(sessionsDb.getSessionEnginePin('s1')?.engine, 'anthropic');
    assert.equal(sessionsDb.getSessionEnginePin('s1')?.source, 'user_switch');
  });
});

test('a later server_verdict does NOT demote a user_switch pin', async () => {
  await withIsolatedDatabase(() => {
    seedSession('s2');
    sessionsDb.setSessionEnginePin('s2', 'anthropic', PIN_SOURCE.USER_SWITCH, { intent: true });

    // This is what the FIRST spawn after a switch does: it observes the engine it
    // engaged and records it. Without the guard it would silently undo the user's
    // choice one turn later — the failure mode that makes this test load-bearing.
    const result = sessionsDb.setSessionEnginePin('s2', 'glm', PIN_SOURCE.SERVER_VERDICT);

    assert.equal(result.outcome, 'kept');
    assert.equal(sessionsDb.getSessionEnginePin('s2')?.engine, 'anthropic');
  });
});

test('an inferred backfill cannot demote a user_switch pin either', async () => {
  await withIsolatedDatabase(() => {
    seedSession('s3');
    sessionsDb.setSessionEnginePin('s3', 'glm', PIN_SOURCE.USER_SWITCH, { intent: true });

    const result = sessionsDb.setSessionEnginePin('s3', 'kimi', PIN_SOURCE.INFERRED);

    assert.equal(result.outcome, 'kept');
    assert.equal(sessionsDb.getSessionEnginePin('s3')?.engine, 'glm');
  });
});

test('user_switch without explicit intent throws — a spawn can never acquire it', async () => {
  await withIsolatedDatabase(() => {
    seedSession('s4');
    sessionsDb.setSessionEnginePin('s4', 'glm', PIN_SOURCE.SERVER_VERDICT);

    assert.throws(
      () => sessionsDb.setSessionEnginePin('s4', 'anthropic', PIN_SOURCE.USER_SWITCH),
      /requires options\.intent/,
    );
    // And the pin is untouched by the refusal.
    assert.equal(sessionsDb.getSessionEnginePin('s4')?.engine, 'glm');
  });
});

test('user_switch can move between two vendor engines, and back again', async () => {
  await withIsolatedDatabase(() => {
    seedSession('s5');
    sessionsDb.setSessionEnginePin('s5', 'glm', PIN_SOURCE.SERVER_VERDICT);

    sessionsDb.setSessionEnginePin('s5', 'anthropic', PIN_SOURCE.USER_SWITCH, { intent: true });
    assert.equal(sessionsDb.getSessionEnginePin('s5')?.engine, 'anthropic');

    // The rollback path the route uses when a turn starts mid-switch (TOCTOU).
    sessionsDb.setSessionEnginePin('s5', 'glm', PIN_SOURCE.USER_SWITCH, { intent: true });
    assert.equal(sessionsDb.getSessionEnginePin('s5')?.engine, 'glm');
  });
});

test('ADR-088 rules still hold for the two observation sources', async () => {
  await withIsolatedDatabase(() => {
    seedSession('s6');
    sessionsDb.setSessionEnginePin('s6', 'glm', PIN_SOURCE.INFERRED);
    // inferred → server_verdict on an ENGINE id upgrades…
    assert.equal(
      sessionsDb.setSessionEnginePin('s6', 'kimi', PIN_SOURCE.SERVER_VERDICT).outcome,
      'upgraded',
    );
    // …but a settled server_verdict is never overwritten by another verdict.
    assert.equal(
      sessionsDb.setSessionEnginePin('s6', 'glm', PIN_SOURCE.SERVER_VERDICT).outcome,
      'kept',
    );

    seedSession('s7');
    sessionsDb.setSessionEnginePin('s7', 'glm', PIN_SOURCE.INFERRED);
    // An 'anthropic' VERDICT must not launder a leaked official turn into a pin.
    assert.equal(
      sessionsDb.setSessionEnginePin('s7', 'anthropic', PIN_SOURCE.SERVER_VERDICT).outcome,
      'kept',
    );
  });
});
