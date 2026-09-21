import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { responseTurnMetricsDb } from '@/modules/database/repositories/response-turn-metrics.db.js';

async function withDb(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  // Tests must not allocate in /tmp: it is tmpfs on Nassaj hosts.
  const directory = await mkdtemp('/var/tmp/response-turn-metrics-');
  const databasePath = path.join(directory, 'db.sqlite');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
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

test('response timing migration is idempotent and indexed', async () => {
  await withDb(() => {
    const db = getConnection();
    assert.doesNotThrow(() => runMigrations(db));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='response_turn_metrics'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_response_turn_metrics_session_message'").get());
    const fk = db.pragma('foreign_key_list(response_turn_metrics)') as Array<{
      table: string; from: string; on_delete: string;
    }>;
    assert.ok(fk.some((row) => row.table === 'sessions' && row.from === 'session_id' && row.on_delete === 'CASCADE'));
  });
});

test('legacy timing rows gain cascade, keep old facts, and discard only orphans', async () => {
  await withDb(() => {
    const db = getConnection();
    db.exec('DROP TABLE response_turn_metrics');
    db.exec(`CREATE TABLE response_turn_metrics (
      turn_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, assistant_message_id)
    )`);
    db.prepare("INSERT INTO sessions(session_id, provider) VALUES ('kept', 'claude')").run();
    const insert = db.prepare(`INSERT INTO response_turn_metrics
      (turn_id, session_id, assistant_message_id, started_at, completed_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run('old-fact', 'kept', 'assistant-old',
      '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:01.000Z', 1000);
    insert.run('orphan', 'missing', 'assistant-orphan',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:01.000Z', 1000);

    runMigrations(db);
    assert.equal(responseTurnMetricsDb.sumSessionDuration('kept'), 1000,
      '30 days limits duration value; it does not expire old records');
    const orphanCount = db.prepare(
      "SELECT COUNT(*) AS count FROM response_turn_metrics WHERE turn_id = 'orphan'",
    ).get() as { count: number };
    assert.equal(orphanCount.count, 0);
    assert.throws(() => insert.run('too-long', 'kept', 'assistant-long',
      '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.001Z', 2678400001));
  });
});

test('completed response timing is replay-safe and never returns its internal turn id', async () => {
  await withDb(() => {
    getConnection().prepare("INSERT INTO sessions(session_id, provider) VALUES ('session-a', 'codex')").run();
    const input = {
      turnId: 'server-turn-1',
      sessionId: 'session-a',
      assistantMessageId: 'assistant-a',
      startedAt: '2026-08-17T10:00:00.000Z',
      completedAt: '2026-08-17T10:00:04.250Z',
    };
    assert.equal(responseTurnMetricsDb.recordCompleted(input).status, 'inserted');
    assert.equal(responseTurnMetricsDb.recordCompleted(input).status, 'idempotent');
    assert.equal(responseTurnMetricsDb.recordCompleted({ ...input, turnId: 'server-turn-2' }).status, 'conflict',
      'a conflicting replay cannot overwrite the message fact');
    assert.equal(responseTurnMetricsDb.recordCompleted({
      turnId: 'server-turn-page-2',
      sessionId: 'session-a',
      assistantMessageId: 'assistant-page-2',
      startedAt: '2026-08-17T11:00:00.000Z',
      completedAt: '2026-08-17T11:00:00.750Z',
    }).status, 'inserted');

    const visible = responseTurnMetricsDb.listForMessages('session-a', ['assistant-a']);
    assert.deepEqual(visible, [{
      assistantMessageId: 'assistant-a',
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      durationMs: 4250,
    }]);
    assert.deepEqual(responseTurnMetricsDb.listForMessages('session-a', ['assistant-other']), [],
      'a paginated history page cannot discover timing for omitted messages');
    assert.deepEqual(responseTurnMetricsDb.listForMessages('session-b', ['assistant-a']), [],
      'session scope prevents cross-conversation reads');
    assert.equal('turnId' in visible[0], false, 'run identity is never in the history read model');
    assert.equal(responseTurnMetricsDb.sumSessionDuration('session-a'), 5000,
      'the full conversation total includes durable replies outside this history page');
    getConnection().prepare("DELETE FROM sessions WHERE session_id = 'session-a'").run();
    assert.deepEqual(responseTurnMetricsDb.listForMessages('session-a', ['assistant-a']), [],
      'session deletion cascades to timing facts');
  });
});

test('invalid, cancelled-like boundaries are not persisted', async () => {
  await withDb(() => {
    getConnection().prepare("INSERT INTO sessions(session_id, provider) VALUES ('session-a', 'codex')").run();
    assert.equal(responseTurnMetricsDb.recordCompleted({
      turnId: 'exactly-30-days', sessionId: 'session-a', assistantMessageId: 'assistant-limit',
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-31T00:00:00.000Z',
    }).status, 'inserted', 'the documented 30-day ceiling is inclusive');
    assert.equal(responseTurnMetricsDb.recordCompleted({
      turnId: 'bad-turn', sessionId: 'session-a', assistantMessageId: 'assistant-a',
      startedAt: '2026-08-17T10:00:05.000Z', completedAt: '2026-08-17T10:00:04.000Z',
    }).status, 'invalid');
    assert.equal(responseTurnMetricsDb.recordCompleted({
      turnId: 'too-long', sessionId: 'session-a', assistantMessageId: 'assistant-b',
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-02-01T00:00:00.001Z',
    }).status, 'invalid', '30 days is a duration ceiling, not record retention');
    assert.equal(responseTurnMetricsDb.recordCompleted({
      turnId: 'missing', sessionId: 'missing-session', assistantMessageId: 'assistant-c',
      startedAt: '2026-08-17T10:00:00.000Z', completedAt: '2026-08-17T10:00:01.000Z',
    }).status, 'missing_session');
    assert.deepEqual(responseTurnMetricsDb.listForMessages('session-a', ['assistant-a']), []);
    assert.equal(responseTurnMetricsDb.sumSessionDuration('session-a'), 2_592_000_000);
  });
});

test('an unmeasured conversation reads as unknown, not as a zero total', async () => {
  await withDb(() => {
    const db = getConnection();
    db.prepare("INSERT INTO sessions(session_id, provider) VALUES ('never-measured', 'opencode')").run();
    db.prepare("INSERT INTO sessions(session_id, provider) VALUES ('instant', 'claude')").run();

    // B-822: "no measurement exists" and "the work took no time" are different
    // facts. Collapsing the first into 0 rendered it as the literal "0ms".
    assert.equal(responseTurnMetricsDb.sumSessionDuration('never-measured'), null);
    assert.equal(responseTurnMetricsDb.sumSessionDuration('no-such-session'), null);
    assert.equal(responseTurnMetricsDb.sumSessionDuration(''), null);

    const instant = {
      sessionId: 'instant',
      startedAt: '2026-09-02T10:00:00.000Z',
      completedAt: '2026-09-02T10:00:00.000Z',
    };
    assert.equal(responseTurnMetricsDb.recordCompleted({
      ...instant, turnId: 'instant-1', assistantMessageId: 'assistant-1',
    }).status, 'inserted');
    assert.equal(responseTurnMetricsDb.recordCompleted({
      ...instant, turnId: 'instant-2', assistantMessageId: 'assistant-2',
    }).status, 'inserted');
    assert.equal(responseTurnMetricsDb.sumSessionDuration('instant'), 0,
      'a real total of zero stays 0 and must not be hidden as unknown');
  });
});
