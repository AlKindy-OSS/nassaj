/**
 * T-1912: the update restart is held while scheduled messages are due. That
 * hold is only useful if those messages can actually be DELIVERED while the job
 * sits in `restart_queued`; otherwise it would just burn the 60-minute cap.
 *
 * Why the gate is open to writers in `restart_queued` (code references):
 * - The worker that drives a job to `restart_queued`
 *   (server/services/source-update-worker.js, `transition(['candidate_sealed'],
 *   'restart_queued')`) never imports or touches the maintenance gate.
 * - The only source-update path that closes the application gate is
 *   `beginUpdate` (journal OPEN -> DRAINING/UPDATING, gateClosed: true), called
 *   only inside `executeSourceUpdateActivation` (server/routes/system.js), which
 *   runs when the queued safe-restart row is executed — i.e. AFTER the
 *   auto-activator stopped holding and called `executeAsOwner`.
 * - Writer leases (`acquireWriterLease`) are refused only when the journal is
 *   not OPEN or `gateClosed` is set (server/services/update-maintenance-gate.js).
 * The tests below pin those facts statically and prove, on a real gate, that
 * the queue tick lease and the per-turn `provider-turn` lease are both granted
 * before activation, and refused once activation has begun.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import { createUpdateMaintenanceGate } from '../../services/update-maintenance-gate.js';
import { acquireApplicationWriterLease, setApplicationWriterGateForTests } from '../../services/update-writer-lease.js';

import { createScheduledTurnDispatcher } from './scheduled-messages.dispatch.js';
import { createScheduledMessagesService } from './scheduled-messages.service.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readServer = (relative: string) => fs.readFileSync(path.join(SERVER_ROOT, relative), 'utf8');

const previous = { mode: process.env.NASSAJ_UPDATE_MODE, environment: process.env.NODE_ENV };
process.env.NODE_ENV = 'test';
after(() => {
  setApplicationWriterGateForTests(null);
  for (const [key, value] of [['NASSAJ_UPDATE_MODE', previous.mode], ['NODE_ENV', previous.environment]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

type Writer = { send(payload: unknown): void };

/** A real gate on a scratch repo, wrapped to record which writer kinds it admitted. */
function realGate(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TEMP_ROOT || '/var/tmp', 'nassaj-t1912-hold-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const gate = createUpdateMaintenanceGate({ projectPath: root });
  const admitted: string[] = [];
  setApplicationWriterGateForTests({
    async acquireWriterLease(options: { kind: string }) {
      const lease = await gate.acquireWriterLease(options);
      admitted.push(options.kind);
      return lease;
    },
  });
  return { gate, admitted };
}

/** The real service and dispatcher, production lease wiring; provider and repository faked. */
function scheduledQueue() {
  const settled: Array<{ id: string; outcome: Record<string, unknown> }> = [];
  let dispatched = 0;
  const claims = [{ id: 'm-1', userId: 1, sessionId: 's-1', content: 'go', options: {}, attempts: 1, leaseToken: 'l-1' }];
  const dispatch = createScheduledTurnDispatcher<Writer>({
    getSession: () => ({ project_path: '/p', provider: 'codex' }),
    createWriter: () => ({ send() {} }),
    dispatchProviderCommand: async (_type, _data, writer) => {
      dispatched += 1;
      writer.send({ kind: 'stream_delta', content: 'x' });
    },
    isAcceptanceFrame: (payload) => payload.kind === 'stream_delta',
    acquireWriterLease: (kind) => acquireApplicationWriterLease(kind, { waitMs: 100 }),
    logger: { error() {} },
  });
  const service = createScheduledMessagesService({
    repository: {
      failExpiredExhausted: () => [],
      claimDue: () => claims.shift() ?? null,
      renewLease: () => true,
      settle: (id: string, _token: string, outcome: Record<string, unknown>) => { settled.push({ id, outcome }); return true; },
    },
    getActiveUser: (id: number) => ({ id, role: 'user', authorization_generation: 1 }),
    sessionExists: () => true,
    canWriteSession: () => true,
    dispatch,
    audit: () => {},
    now: () => Date.parse('2026-09-28T12:00:00.000Z'),
  } as never);
  return { service, settled, dispatched: () => dispatched };
}

const identity = {
  transactionId: 'update-transaction-1912', expectedVersion: '1.44.0.2',
  originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40),
};

test('reaching restart_queued never closes the gate: the worker does not touch it', () => {
  const worker = readServer('services/source-update-worker.js');
  assert.match(worker, /transition\(\['candidate_sealed'\], 'restart_queued'\)/);
  assert.doesNotMatch(worker, /update-maintenance-gate|update-writer-lease|beginUpdate|gateClosed/);
});

test('the only source-update gate closure is inside executeSourceUpdateActivation', () => {
  const system = readServer('routes/system.js');
  const start = system.indexOf('export async function executeSourceUpdateActivation(');
  const end = system.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const calls = [...system.matchAll(/\.beginUpdate\(/g)].map((match) => match.index ?? -1);
  assert.ok(calls.length > 0);
  for (const index of calls) assert.ok(index > start && index < end, `beginUpdate outside activation at ${index}`);
  const activation = system.slice(start, end);
  assert.ok(activation.indexOf("transitionActivation(activationJobIdentity, ['restart_queued'], 'activating')") > 0,
    'activation moves the job out of restart_queued');
});

for (const mode of ['release', 'local-main'] as const) {
  test(`${mode}: before activation a due scheduled message is delivered under its leases`, async (t) => {
    if (mode === 'local-main') process.env.NASSAJ_UPDATE_MODE = 'local-main';
    else delete process.env.NASSAJ_UPDATE_MODE;
    const { gate, admitted } = realGate(t);
    const queue = scheduledQueue();

    assert.equal(gate.readPublicStatus().gateClosed, false, 'the gate is open while the job waits to restart');
    await queue.service.tick();

    assert.equal(queue.dispatched(), 1);
    assert.deepEqual(queue.settled, [{ id: 'm-1', outcome: { success: true, retryable: false } }]);
    // local-main wraps the queue tick in its own lease; release mode has no tick
    // lease (withLocalUpdateWriterLease is a pass-through there).
    const expected = mode === 'local-main' ? ['scheduled-message', 'provider-turn'] : ['provider-turn'];
    assert.deepEqual(admitted, expected);
  });
}

test('once activation began (gate closed) the turn lease is refused and the row stays retryable', async (t) => {
  delete process.env.NASSAJ_UPDATE_MODE;
  const { gate, admitted } = realGate(t);
  const update = await gate.beginUpdate(identity, { waitMs: 100 });
  const queue = scheduledQueue();
  try {
    await queue.service.tick();
  } finally {
    update.transition(['PREPARED'], 'SOURCE_APPLYING');
    update.transition(['SOURCE_APPLYING'], 'SOURCE_APPLIED');
    update.complete();
    update.release();
  }

  assert.equal(queue.dispatched(), 0);
  assert.deepEqual(admitted, []);
  assert.equal(queue.settled.length, 1);
  assert.equal(queue.settled[0].outcome.success, false);
  assert.equal(queue.settled[0].outcome.retryable, true);
  assert.equal(queue.settled[0].outcome.errorCode, 'update_maintenance_active');
});
