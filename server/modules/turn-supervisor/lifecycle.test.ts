import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  cleanupEphemeralRoleHome, createEphemeralRoleHome,
} from './adapters/isolated-cli-cage.js';
import { createTurnSupervisorLifecycle } from './lifecycle.js';

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE turn_resource_leases (
    lease_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, cpu_reserved REAL NOT NULL,
    memory_reserved REAL NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL, exit_proof_at_ms INTEGER, exit_proof_kind TEXT,
    released_at_ms INTEGER,
    CHECK (status = 'active' OR (exit_proof_at_ms IS NOT NULL AND released_at_ms IS NOT NULL))
  );`);
  return db;
}

function insertLease(
  db: Database.Database, leaseId: string, turnId: string, ownerId: string, ownerPid: number,
): void {
  db.prepare(`INSERT INTO turn_resource_leases (
    lease_id, turn_id, user_id, owner_id, owner_pid, cpu_reserved, memory_reserved,
    status, created_at_ms, heartbeat_at_ms
  ) VALUES (?, ?, 1, ?, ?, 1, 1, 'active', 0, 0)`).run(
    leaseId, turnId, ownerId, ownerPid,
  );
}

test('startup releases dead-owner leases, retains live owners, and initializes after sweep', async () => {
  const db = database();
  try {
    insertLease(db, 'dead-lease', 'dead-turn', 'predecessor-dead', 101);
    insertLease(db, 'live-lease', 'live-turn', 'predecessor-live', 102);
    const events: string[] = [];
    const lifecycle = createTurnSupervisorLifecycle({
      db,
      ownerIds: ['hosted-current', 'cli-current'],
      supervisors: [
        { async initialize() { events.push('hosted:initialize'); } },
        { async initialize() { events.push('cli:initialize'); } },
      ],
      sweepRoleHomes: async () => { events.push('roles:sweep'); return []; },
      processProbe: (pid) => pid === 101 ? 'dead' : 'alive',
      now: () => 10_000,
      heartbeatIntervalMs: 10,
      staleAfterMs: 20,
    });

    await lifecycle.prepare();
    assert.equal(events[0], 'roles:sweep');
    assert.deepEqual(new Set(events.slice(1)), new Set(['hosted:initialize', 'cli:initialize']));
    const rows = db.prepare(
      'SELECT lease_id, status, exit_proof_kind FROM turn_resource_leases ORDER BY lease_id',
    ).all();
    assert.deepEqual(rows, [
      { lease_id: 'dead-lease', status: 'released', exit_proof_kind: 'process_dead' },
      { lease_id: 'live-lease', status: 'active', exit_proof_kind: null },
    ]);
    lifecycle.start();
    await lifecycle.stop();
  } finally {
    db.close();
  }
});

test('prepare, start, stop, and restart are idempotent', async () => {
  const db = database();
  try {
    let sweeps = 0;
    let initializations = 0;
    const calls = new Map<string, { tick: number; start: number; stop: number }>();
    const lifecycle = createTurnSupervisorLifecycle({
      db,
      ownerIds: ['hosted-current', 'cli-current'],
      supervisors: [
        { async initialize() { initializations += 1; } },
        { async initialize() { initializations += 1; } },
      ],
      sweepRoleHomes: async () => { sweeps += 1; return []; },
      createWatchdog(ownerId) {
        const count = { tick: 0, start: 0, stop: 0 };
        calls.set(ownerId, count);
        return {
          async tick() {
            count.tick += 1;
            return {
              heartbeated: 0, examined: 0, released: 0,
              retainedAlive: 0, retainedUnknown: 0,
            };
          },
          start() { count.start += 1; },
          stop() { count.stop += 1; },
        };
      },
    });

    await Promise.all([lifecycle.prepare(), lifecycle.prepare()]);
    await lifecycle.prepare();
    lifecycle.start(); lifecycle.start();
    await Promise.all([lifecycle.stop(), lifecycle.stop()]);
    lifecycle.start(); await lifecycle.stop();

    assert.equal(sweeps, 1);
    assert.equal(initializations, 2);
    assert.deepEqual([...calls.values()], [
      { tick: 1, start: 2, stop: 2 }, { tick: 1, start: 2, stop: 2 },
    ]);
  } finally {
    db.close();
  }
});

test('startup safely removes only dead-owner CLI role homes', async () => {
  const db = database();
  const dead = await createEphemeralRoleHome(2_147_483_647);
  const live = await createEphemeralRoleHome(process.pid);
  try {
    const lifecycle = createTurnSupervisorLifecycle({
      db,
      ownerIds: ['hosted-current', 'cli-current'],
      supervisors: [{ async initialize() {} }, { async initialize() {} }],
    });
    await lifecycle.prepare();
    await assert.rejects(cleanupEphemeralRoleHome(dead));
    await cleanupEphemeralRoleHome(live);
  } finally {
    // Best effort only for an assertion failure before the normal cleanup.
    await cleanupEphemeralRoleHome(live).catch(() => undefined);
    await cleanupEphemeralRoleHome(dead).catch(() => undefined);
    db.close();
  }
});
