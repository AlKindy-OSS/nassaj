import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { SystemResourceSampler } from '@/services/system-resource-sampler.service.js';

import {
  AdapterTerminalProofAuthority,
  activeLeaseCount,
  admitResources,
  heartbeatOwner,
  releaseWithExitProof,
} from './resource-admission.js';
import { ResourceLeaseWatchdog } from './watchdog.js';

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE turn_resource_leases (
    lease_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, user_id INTEGER NOT NULL,
    owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL, cpu_reserved REAL NOT NULL,
    memory_reserved REAL NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
    heartbeat_at_ms INTEGER NOT NULL, exit_proof_at_ms INTEGER, exit_proof_kind TEXT,
    released_at_ms INTEGER,
    CHECK (status = 'active' OR (exit_proof_at_ms IS NOT NULL AND released_at_ms IS NOT NULL))
  );
  CREATE UNIQUE INDEX one_active_turn ON turn_resource_leases(turn_id) WHERE status = 'active';`);
  return db;
}

const sample = (cpuPercent: number, memoryPercent = 10, measuredAt = 1_000) =>
  async () => ({ cpuPercent, memoryPercent, measuredAt });

function request(turnId: string, userId = 1, ownerId = 'owner-a', ownerPid = 111) {
  return {
    turnId,
    userId,
    ownerId,
    ownerPid,
    reservation: { cpuPercent: 0.5, memoryPercent: 0.5 },
  };
}

test('BEGIN IMMEDIATE reservations close the concurrent 79→80 admission race', async () => {
  const db = database();
  try {
    const deps = { sample: sample(79), now: () => 1_000 };
    const [first, second] = await Promise.all([
      admitResources(db, request('turn-1'), {}, { ...deps, leaseId: () => 'lease-1' }),
      admitResources(db, request('turn-2'), {}, { ...deps, leaseId: () => 'lease-2' }),
    ]);
    assert.equal(first.admitted, true);
    assert.deepEqual(second, {
      admitted: false,
      code: 'capacity',
      reason: 'projected resources must stay below 80%',
    });
    assert.equal(activeLeaseCount(db), 1);
  } finally {
    db.close();
  }
});

test('measurement failure and stale/malformed samples fail closed', async () => {
  const db = database();
  try {
    const failed = await admitResources(db, request('failed'), {}, {
      sample: async () => { throw new Error('probe failed'); },
      now: () => 1_000,
    });
    assert.equal(failed.admitted, false);
    if (!failed.admitted) assert.equal(failed.code, 'measurement_unavailable');

    const stale = await admitResources(db, request('stale'), {}, {
      sample: sample(1, 1, 0),
      now: () => 2_000,
    });
    assert.equal(stale.admitted, false);
    if (!stale.admitted) assert.equal(stale.code, 'measurement_unavailable');
    assert.equal(activeLeaseCount(db), 0);
  } finally {
    db.close();
  }
});

test('storage failure fails closed instead of escaping as an ambiguous launch decision', async () => {
  const db = new Database(':memory:');
  try {
    const verdict = await admitResources(db, request('no-schema'), {}, {
      sample: sample(1), now: () => 1_000,
    });
    assert.equal(verdict.admitted, false);
    if (!verdict.admitted) assert.equal(verdict.code, 'admission_unavailable');
  } finally {
    db.close();
  }
});

test('global and per-user caps are enforced inside the reservation transaction', async () => {
  const db = database();
  try {
    const deps = { sample: sample(1), now: () => 1_000 };
    assert.equal((await admitResources(db, request('u1-a'), { perUserCap: 1 }, deps)).admitted, true);
    const perUser = await admitResources(db, request('u1-b'), { perUserCap: 1 }, deps);
    assert.equal(perUser.admitted, false);
    if (!perUser.admitted) assert.equal(perUser.code, 'user_cap');

    const global = await admitResources(
      db,
      request('u2-a', 2, 'owner-b', 222),
      { globalCap: 1, perUserCap: 2 },
      deps,
    );
    assert.equal(global.admitted, false);
    if (!global.admitted) assert.equal(global.code, 'global_cap');
  } finally {
    db.close();
  }
});

test('normal release requires and durably records exit proof', async () => {
  const db = database();
  try {
    const verdict = await admitResources(db, request('turn-exit'), {}, {
      sample: sample(1), now: () => 1_000, leaseId: () => 'lease-exit',
    });
    assert.equal(verdict.admitted, true);
    assert.equal(releaseWithExitProof(db, {
      leaseId: 'lease-exit', ownerId: 'wrong-owner',
      proof: { kind: 'process_exit', observedAtMs: 1_100 },
    }), false);
    assert.equal(activeLeaseCount(db), 1);
    assert.equal(releaseWithExitProof(db, {
      leaseId: 'lease-exit', ownerId: 'owner-a',
      proof: { kind: 'process_exit', observedAtMs: 1_100 },
    }), true);
    const row = db.prepare('SELECT * FROM turn_resource_leases WHERE lease_id = ?')
      .get('lease-exit') as Record<string, unknown>;
    assert.equal(row.status, 'released');
    assert.equal(row.exit_proof_kind, 'process_exit');
    assert.equal(row.exit_proof_at_ms, 1_100);
  } finally {
    db.close();
  }
});

test('hosted lease release requires registry-settled adapter terminal proof identity', async () => {
  const db = database();
  try {
    await admitResources(db, request('hosted'), {}, {
      sample: sample(1), now: () => 1_000, leaseId: () => 'hosted-lease',
    });
    const authority = new AdapterTerminalProofAuthority();
    const issue = authority.bindIssuer();
    const proof = issue({
      adapterId: 'hosted-vendor-ephemeral', runId: 'run-hosted', writerEpoch: 4,
      observedAtMs: 1_100, settled: true,
    });
    assert.equal(releaseWithExitProof(db, {
      leaseId: 'hosted-lease', ownerId: 'owner-a', proof,
    }), false, 'unverified proof must retain the lease');
    assert.equal(activeLeaseCount(db), 1);
    assert.equal(releaseWithExitProof(db, {
      leaseId: 'hosted-lease', ownerId: 'owner-a', proof, adapterProofAuthority: authority,
    }), true);
    assert.equal(activeLeaseCount(db), 0);
  } finally {
    db.close();
  }
});

test('watchdog heartbeats its owner and releases only stale leases with dead owners', async () => {
  const db = database();
  try {
    const deps = { sample: sample(1), now: () => 1_000 };
    await admitResources(db, request('mine', 1, 'current', 100), {}, deps);
    await admitResources(db, request('dead', 2, 'crashed', 200), {}, deps);
    db.prepare("UPDATE turn_resource_leases SET heartbeat_at_ms = 0 WHERE owner_id = 'crashed'").run();
    const watchdog = new ResourceLeaseWatchdog(db, {
      ownerId: 'current', heartbeatIntervalMs: 10, staleAfterMs: 20,
      now: () => 2_000,
      probeProcess: (pid) => pid === 200 ? 'dead' : 'alive',
    });
    const result = await watchdog.tick();
    assert.deepEqual(result, {
      heartbeated: 1, examined: 1, released: 1, retainedAlive: 0, retainedUnknown: 0,
    });
    assert.equal(activeLeaseCount(db), 1);
    const mine = db.prepare("SELECT heartbeat_at_ms FROM turn_resource_leases WHERE owner_id = 'current'")
      .get() as { heartbeat_at_ms: number };
    assert.equal(mine.heartbeat_at_ms, 2_000);
  } finally {
    db.close();
  }
});

test('watchdog retains stale leases when owner liveness is alive or unknown', async () => {
  const db = database();
  try {
    const deps = { sample: sample(1), now: () => 1_000 };
    await admitResources(db, request('alive', 1, 'old-a', 201), {}, deps);
    await admitResources(db, request('unknown', 2, 'old-b', 202), {}, deps);
    db.prepare('UPDATE turn_resource_leases SET heartbeat_at_ms = 0').run();
    const watchdog = new ResourceLeaseWatchdog(db, {
      ownerId: 'current', heartbeatIntervalMs: 10, staleAfterMs: 20,
      now: () => 2_000,
      probeProcess: (pid) => pid === 201 ? 'alive' : 'unknown',
    });
    const result = await watchdog.tick();
    assert.equal(result.released, 0);
    assert.equal(result.retainedAlive, 1);
    assert.equal(result.retainedUnknown, 1);
    assert.equal(activeLeaseCount(db), 2);
  } finally {
    db.close();
  }
});

test('sampler computes CPU/RAM once for concurrent callers and rejects bad counters', async () => {
  let cpuRead = 0;
  const sampler = new SystemResourceSampler({
    readCpuTimes: () => (++cpuRead === 1 ? { idle: 50, total: 100 } : { idle: 80, total: 200 }),
    readMemory: () => ({ free: 25, total: 100 }),
    now: () => 5_000,
    sleep: async () => {},
  }, { cacheMaxAgeMs: 100 });
  const [a, b] = await Promise.all([sampler.sample(), sampler.sample()]);
  assert.deepEqual(a, { cpuPercent: 70, memoryPercent: 75, measuredAt: 5_000 });
  assert.deepEqual(b, a);
  assert.equal(cpuRead, 2);

  const broken = new SystemResourceSampler({
    readCpuTimes: () => { throw new Error('unavailable'); },
    sleep: async () => {},
  });
  await assert.rejects(broken.sample(), /measurement unavailable/);
});

test('heartbeat update does not revive a released lease', async () => {
  const db = database();
  try {
    await admitResources(db, request('ended'), {}, {
      sample: sample(1), now: () => 1_000, leaseId: () => 'ended-lease',
    });
    releaseWithExitProof(db, {
      leaseId: 'ended-lease', ownerId: 'owner-a',
      proof: { kind: 'process_exit', observedAtMs: 1_100 },
    });
    assert.equal(heartbeatOwner(db, 'owner-a', 2_000), 0);
  } finally {
    db.close();
  }
});

test('a released pre-dispatch reservation can be admitted again', async () => {
  const db = database();
  try {
    const first = await admitResources(db, request('retryable'), {}, {
      sample: sample(1), now: () => 1_000, leaseId: () => 'lease-first',
    });
    assert.equal(first.admitted, true);
    releaseWithExitProof(db, {
      leaseId: 'lease-first', ownerId: 'owner-a',
      proof: { kind: 'process_exit', observedAtMs: 1_100 },
    });
    const second = await admitResources(db, request('retryable'), {}, {
      sample: sample(1), now: () => 1_200, leaseId: () => 'lease-second',
    });
    assert.equal(second.admitted, true);
    assert.equal(activeLeaseCount(db), 1);
    assert.equal((db.prepare(
      "SELECT COUNT(*) AS count FROM turn_resource_leases WHERE turn_id = 'retryable'",
    ).get() as { count: number }).count, 2);
  } finally {
    db.close();
  }
});
