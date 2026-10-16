import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { SystemResourceSampler } from '@/services/system-resource-sampler.service.js';

import {
  AdapterTerminalProofAuthority,
  CODEX_LEASE_MAX_AGE_MS,
  activeLeaseCount,
  admitResources,
  codexLeaseMemoryContribution,
  heartbeatOwner,
  isCodexSdkLeaseOwner,
  releaseWithExitProof,
  sumCodexSdkLeaseMemory,
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

// ADR-206 S2 (§3.2 M1, §3.3): Codex SDK leases live in the same table, owner class in owner_id.
function insertCodexLease(
  db: Database.Database,
  input: { leaseId: string; memory: number; createdAtMs: number; heartbeatAtMs?: number; ownerPid?: number; userId?: number },
): void {
  db.prepare(
    `INSERT INTO turn_resource_leases (lease_id, turn_id, user_id, owner_id, owner_pid, cpu_reserved,
       memory_reserved, status, created_at_ms, heartbeat_at_ms) VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?, ?)`,
  ).run(
    input.leaseId, `codex:pe-${input.leaseId}`, input.userId ?? 1, 'codex-sdk:boot:42:777', input.ownerPid ?? 42,
    input.memory, input.createdAtMs, input.heartbeatAtMs ?? input.createdAtMs,
  );
}

test('codexLeaseMemoryContribution: stored value under 120 s, 0 from 120 s, non-codex rows unchanged', () => {
  const row = { ownerId: 'codex-sdk:boot:1:2', memoryReserved: 9, createdAtMs: 1_000 };
  assert.equal(codexLeaseMemoryContribution(row, 1_000), 9);
  assert.equal(codexLeaseMemoryContribution(row, 1_000 + CODEX_LEASE_MAX_AGE_MS - 1), 9);
  assert.equal(codexLeaseMemoryContribution(row, 1_000 + CODEX_LEASE_MAX_AGE_MS), 0);
  assert.equal(codexLeaseMemoryContribution({ ...row, createdAtMs: 5_000 }, 1_000), 0, 'future row holds nothing');
  assert.equal(codexLeaseMemoryContribution({ ...row, memoryReserved: Number.NaN }, 1_000), 0);
  assert.equal(codexLeaseMemoryContribution({ ...row, memoryReserved: -3 }, 1_000), 0);
  assert.equal(codexLeaseMemoryContribution({ ...row, ownerId: 'supervisor:hosted' }, 10_000_000), 9);
  assert.equal(isCodexSdkLeaseOwner('codex-sdk:a:1:2'), true);
  assert.equal(isCodexSdkLeaseOwner('xcodex-sdk:a'), false);
});

test('M1: an orphan codex-sdk lease older than 120 s with 9% stored counts 0 in the supervisor sum', async () => {
  const db = database();
  try {
    const now = 1_000_000;
    insertCodexLease(db, { leaseId: 'orphan', memory: 9, createdAtMs: now - CODEX_LEASE_MAX_AGE_MS - 1 });
    assert.equal(sumCodexSdkLeaseMemory(db, now), 0);
    const admitted = await admitResources(db, request('runner-1'), {}, { sample: sample(1, 75, now), now: () => now });
    assert.equal(admitted.admitted, true, '75 + 0 (orphan) + 0.5 < 80');

    insertCodexLease(db, { leaseId: 'fresh', memory: 9, createdAtMs: now - 1_000 });
    assert.equal(sumCodexSdkLeaseMemory(db, now), 9);
    const refused = await admitResources(db, request('runner-2'), {}, { sample: sample(1, 70, now), now: () => now });
    assert.equal(refused.admitted, false, '70 + 0.5 (runner-1) + 9 (fresh codex) + 0.5 >= 80');
    if (!refused.admitted) assert.equal(refused.code, 'capacity');
  } finally {
    db.close();
  }
});

test('supervisor count caps ignore codex-sdk rows; runner admission is otherwise unchanged', async () => {
  const db = database();
  try {
    const now = 2_000_000;
    for (let i = 0; i < 9; i += 1) {
      insertCodexLease(db, { leaseId: `c${i}`, memory: 0, createdAtMs: now - 500_000, userId: 1 });
    }
    const first = await admitResources(db, request('runner-a', 1), { globalCap: 1, perUserCap: 1 }, {
      sample: sample(1, 10, now), now: () => now,
    });
    assert.equal(first.admitted, true, '9 codex rows do not reach the 1-turn caps');
    const second = await admitResources(db, request('runner-b', 2), { globalCap: 1 }, {
      sample: sample(1, 10, now), now: () => now,
    });
    assert.equal(second.admitted, false);
    if (!second.admitted) assert.equal(second.code, 'global_cap');
  } finally {
    db.close();
  }
});

test('supervisor watchdog skips codex-sdk rows even when their owner pid is dead', async () => {
  const db = database();
  try {
    insertCodexLease(db, { leaseId: 'codex-dead-pid', memory: 9, createdAtMs: 0, heartbeatAtMs: 0, ownerPid: 999_999 });
    const probed: number[] = [];
    const watchdog = new ResourceLeaseWatchdog(db, {
      ownerId: 'owner-a',
      now: () => 100_000,
      probeProcess: (pid) => { probed.push(pid); return 'dead'; },
    });
    const result = await watchdog.tick();
    assert.equal(result.examined, 0);
    assert.deepEqual(probed, []);
    assert.equal(activeLeaseCount(db), 1, 'reclaim of codex rows is tag-based (§3.3), not pid-based');
  } finally {
    db.close();
  }
});
