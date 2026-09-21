import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import {
  createTurnSupervisorRepository,
  TurnSupervisorRepositoryError,
} from '@/modules/turn-supervisor/repository.js';

async function withDatabase(
  runTest: (databasePath: string) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'turn-supervisor-'));
  const databasePath = path.join(directory, 'auth.db');
  // An existing empty file suppresses the application's legacy-database copy,
  // keeping this integration test independent of the developer machine.
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  getConnection().prepare(
    "INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'hash', 'owner')",
  ).run();
  getConnection().prepare(
    "INSERT INTO users (id, username, password_hash, role) VALUES (2, 'member', 'hash', 'user')",
  ).run();

  try {
    await runTest(databasePath);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

test('migration creates durable turn/run identities and indexes idempotently', async () => {
  await withDatabase(async () => {
    await initializeDatabase();
    const tables = getConnection().prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('turn_supervisor_turns', 'turn_supervisor_runs')
       ORDER BY name`,
    ).all() as { name: string }[];
    assert.deepEqual(tables.map(({ name }) => name), ['turn_supervisor_runs', 'turn_supervisor_turns']);
  });
});

test('same user and client message replay identity but reject a different fingerprint', async () => {
  await withDatabase(() => {
    const repository = createTurnSupervisorRepository();
    const first = repository.claim({ userId: 1, clientMsgId: 'client-1', requestFingerprint: 'fp-a' });
    assert.equal(first.action, 'dispatch');
    if (first.action !== 'dispatch') return;

    const duplicate = repository.claim({ userId: 1, clientMsgId: 'client-1', requestFingerprint: 'fp-a' });
    assert.equal(duplicate.action, 'resume_safe');
    if (duplicate.action !== 'resume_safe') return;
    assert.equal(duplicate.turn.turnId, first.turn.turnId);
    assert.equal(duplicate.run.runId, first.run.runId);
    assert.equal(duplicate.run.attempt, 1);

    const mismatch = repository.claim({ userId: 1, clientMsgId: 'client-1', requestFingerprint: 'fp-b' });
    assert.equal(mismatch.action, 'fingerprint_mismatch');
  });
});

test('client message idempotency is scoped to the authenticated user', async () => {
  await withDatabase(() => {
    const repository = createTurnSupervisorRepository();
    const owner = repository.claim({ userId: 1, clientMsgId: 'shared-id', requestFingerprint: 'owner-fp' });
    const member = repository.claim({ userId: 2, clientMsgId: 'shared-id', requestFingerprint: 'member-fp' });
    assert.equal(owner.action, 'dispatch');
    assert.equal(member.action, 'dispatch');
    if (owner.action === 'dispatch' && member.action === 'dispatch') {
      assert.notEqual(owner.turn.turnId, member.turn.turnId);
      assert.notEqual(owner.run.runId, member.run.runId);
    }
  });
});

test('CAS fences a stale epoch and preserves the winning state', async () => {
  await withDatabase(() => {
    const repository = createTurnSupervisorRepository();
    const claimed = repository.claim({ userId: 1, clientMsgId: 'cas-1', requestFingerprint: 'fp' });
    assert.equal(claimed.action, 'dispatch');
    if (claimed.action !== 'dispatch') return;
    const dispatching = repository.transitionRun({
      runId: claimed.run.runId,
      expectedState: 'claimed',
      expectedEpoch: 0,
      nextState: 'dispatching',
    });
    assert.equal(dispatching.epoch, 1);
    assert.throws(
      () => repository.transitionRun({
        runId: claimed.run.runId,
        expectedState: 'claimed',
        expectedEpoch: 0,
        nextState: 'dispatching',
      }),
      (error) => error instanceof TurnSupervisorRepositoryError && error.code === 'CAS_FAILED',
    );
    assert.equal(repository.get(claimed.turn.turnId)?.run.state, 'dispatching');
  });
});

test('fault during cross-aggregate start rolls back both run and turn', async () => {
  await withDatabase(() => {
    const repository = createTurnSupervisorRepository();
    const claimed = repository.claim({ userId: 1, clientMsgId: 'atomic-start', requestFingerprint: 'fp' });
    assert.equal(claimed.action, 'dispatch');
    if (claimed.action !== 'dispatch') return;
    getConnection().exec(`CREATE TRIGGER fail_turn_start BEFORE UPDATE ON turn_supervisor_turns
      WHEN NEW.state = 'running' BEGIN SELECT RAISE(ABORT, 'injected start failure'); END;`);
    assert.throws(() => repository.startExecution({
      turnId: claimed.turn.turnId, runId: claimed.run.runId,
      expectedTurnEpoch: 0, expectedRunEpoch: 0,
    }), /injected start failure/);
    const after = repository.get(claimed.turn.turnId)!;
    assert.deepEqual([after.turn.state, after.turn.epoch, after.run.state, after.run.epoch],
      ['accepted', 0, 'claimed', 0]);
  });
});

test('fault during cross-aggregate finish rolls back both run and turn', async () => {
  await withDatabase(() => {
    const repository = createTurnSupervisorRepository();
    const claimed = repository.claim({ userId: 1, clientMsgId: 'atomic-finish', requestFingerprint: 'fp' });
    assert.equal(claimed.action, 'dispatch');
    if (claimed.action !== 'dispatch') return;
    const running = repository.startExecution({
      turnId: claimed.turn.turnId, runId: claimed.run.runId,
      expectedTurnEpoch: 0, expectedRunEpoch: 0,
    });
    getConnection().exec(`CREATE TRIGGER fail_turn_finish BEFORE UPDATE ON turn_supervisor_turns
      WHEN NEW.state = 'terminal' BEGIN SELECT RAISE(ABORT, 'injected finish failure'); END;`);
    assert.throws(() => repository.finishExecution({
      turnId: running.turn.turnId, runId: running.run.runId,
      expectedTurnEpoch: running.turn.epoch, expectedRunEpoch: running.run.epoch,
      terminalOutcome: 'succeeded',
    }), /injected finish failure/);
    const after = repository.get(claimed.turn.turnId)!;
    assert.deepEqual([after.turn.state, after.turn.epoch, after.run.state, after.run.epoch],
      ['running', 1, 'running', 1]);
  });
});

test('successful terminalization stores replay result in the same transaction', async () => {
  await withDatabase(() => {
    const repository = createTurnSupervisorRepository();
    const claimed = repository.claim({ userId: 1, clientMsgId: 'durable-result', requestFingerprint: 'fp' });
    assert.equal(claimed.action, 'dispatch');
    if (claimed.action !== 'dispatch') return;
    const running = repository.startExecution({
      turnId: claimed.turn.turnId, runId: claimed.run.runId,
      expectedTurnEpoch: 0, expectedRunEpoch: 0,
    });
    repository.finishExecution({
      turnId: running.turn.turnId, runId: running.run.runId,
      expectedTurnEpoch: 1, expectedRunEpoch: 1, terminalOutcome: 'succeeded',
      hostedResult: {
        provider: 'kimi', model: 'model', sessionId: 'session', isNewSession: true, text: 'answer',
      },
    });
    assert.deepEqual(getConnection().prepare(
      'SELECT text, transcript_state FROM turn_supervisor_hosted_results WHERE turn_id = ?',
    ).get(claimed.turn.turnId), { text: 'answer', transcript_state: 'pending' });
  });
});

test('result persistence fault rolls terminalization back to running', async () => {
  await withDatabase(() => {
    const repository = createTurnSupervisorRepository();
    const claimed = repository.claim({ userId: 1, clientMsgId: 'result-fault', requestFingerprint: 'fp' });
    assert.equal(claimed.action, 'dispatch');
    if (claimed.action !== 'dispatch') return;
    const running = repository.startExecution({
      turnId: claimed.turn.turnId, runId: claimed.run.runId,
      expectedTurnEpoch: 0, expectedRunEpoch: 0,
    });
    getConnection().exec(`CREATE TABLE turn_supervisor_hosted_results (
      turn_id TEXT PRIMARY KEY, run_id TEXT, provider TEXT, model TEXT, session_id TEXT,
      is_new_session INTEGER, text TEXT CHECK (text = 'never'), transcript_state TEXT,
      created_at TEXT, updated_at TEXT
    )`);
    assert.throws(() => repository.finishExecution({
      turnId: running.turn.turnId, runId: running.run.runId,
      expectedTurnEpoch: 1, expectedRunEpoch: 1, terminalOutcome: 'succeeded',
      hostedResult: {
        provider: 'kimi', model: 'model', sessionId: 'session', isNewSession: true, text: 'answer',
      },
    }));
    const after = repository.get(claimed.turn.turnId)!;
    assert.deepEqual([after.turn.state, after.run.state], ['running', 'running']);
  });
});

test('a crash after crossing dispatch boundary never produces a second dispatch', async () => {
  await withDatabase(async (databasePath) => {
    const beforeCrash = createTurnSupervisorRepository();
    const claimed = beforeCrash.claim({ userId: 1, clientMsgId: 'crash-1', requestFingerprint: 'fp' });
    assert.equal(claimed.action, 'dispatch');
    if (claimed.action !== 'dispatch') return;
    beforeCrash.transitionRun({
      runId: claimed.run.runId,
      expectedState: 'claimed',
      expectedEpoch: 0,
      nextState: 'dispatching',
    });

    closeConnection();
    process.env.DATABASE_PATH = databasePath;
    await initializeDatabase();
    const afterRestart = createTurnSupervisorRepository().claim({
      userId: 1,
      clientMsgId: 'crash-1',
      requestFingerprint: 'fp',
    });
    assert.equal(afterRestart.action, 'ambiguous');
    if (afterRestart.action === 'ambiguous') {
      assert.equal(afterRestart.run.runId, claimed.run.runId);
      assert.equal(afterRestart.run.attempt, 1);
    }
    const count = getConnection().prepare(
      'SELECT COUNT(*) AS count FROM turn_supervisor_runs WHERE turn_id = ?',
    ).get(claimed.turn.turnId) as { count: number };
    assert.equal(count.count, 1);
  });
});

test('temporary bridge adopts T-1453 ingress metadata without mutating it', async () => {
  await withDatabase(() => {
    getConnection().prepare(
      `INSERT INTO message_coordination_ingress
        (session_id, client_msg_id, user_id, provider, canonical_content, content_hash,
         request_fingerprint, coordination_level, created_at)
       VALUES ('session-1', 'legacy-1', 1, 'codex', 'hello', 'hash', 'legacy-fp', 'delegate', ?)`
    ).run(new Date().toISOString());
    const adopted = createTurnSupervisorRepository().adoptMessageCoordinationIngress({
      userId: 1,
      clientMsgId: 'legacy-1',
    });
    assert.equal(adopted.action, 'dispatch');
    if (adopted.action === 'dispatch') assert.equal(adopted.turn.sessionId, 'session-1');
    const ingress = getConnection().prepare(
      'SELECT lifecycle_status AS status FROM message_coordination_ingress WHERE client_msg_id = ?',
    ).get('legacy-1') as { status: string };
    assert.equal(ingress.status, 'claimed');
  });
});
