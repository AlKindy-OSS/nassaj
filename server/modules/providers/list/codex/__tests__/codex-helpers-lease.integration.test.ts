/**
 * ADR-206 S2 §3.3 integration: the lease reclaimer and release against this host's REAL /proc
 * (real strict scan, real /proc clock, real server identity), in a throwaway SQLite file with
 * the production lease schema. A real host always has same-uid processes with an unreadable
 * environ (systemd --user, (sd-pam), ssh-agent, gpg-agent); they must not block reclaim.
 * Only this test's own `sleep` child carries a tag.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import Database from 'better-sqlite3';

// eslint-disable-next-line boundaries/dependencies -- the production lease DDL (not in the barrel)
import { TURN_RESOURCE_LEASES_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';

import { CodexHelpersLeases, codexLeaseTurnId, defaultCodexLeaseDeps } from '../codex-helpers-lease.js';

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'codex-lease-int-'));
const children: ChildProcess[] = [];

after(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function realLeases(): { db: Database.Database; leases: CodexHelpersLeases } {
  const db = new Database(path.join(dir, `${randomUUID()}.db`));
  db.exec(TURN_RESOURCE_LEASES_TABLE_SCHEMA_SQL);
  const leases = new CodexHelpersLeases({
    ...defaultCodexLeaseDeps(),
    db: () => db,
    // Only the memory sample is pinned, so the check does not depend on this host's load.
    sample: async () => ({ cpuPercent: 10, memoryPercent: 10, measuredAt: Date.now() }),
    startTimer: () => () => {},
  });
  return { db, leases };
}

/** A lease of another (dead) server instance, created and last heartbeated `ageMs` ago. */
function insertForeignLease(db: Database.Database, tag: string, ageMs: number): void {
  const at = Date.now() - ageMs;
  db.prepare(
    `INSERT INTO turn_resource_leases (lease_id, turn_id, user_id, owner_id, owner_pid, cpu_reserved,
       memory_reserved, status, created_at_ms, heartbeat_at_ms) VALUES (?, ?, 1, 'codex-sdk:gone:1:1', 1, 0, 9, 'active', ?, ?)`,
  ).run(randomUUID(), codexLeaseTurnId(tag), at, at);
}

const kinds = (db: Database.Database): Array<[string, string | null]> => (
  db.prepare('SELECT status, exit_proof_kind FROM turn_resource_leases').all() as Array<{ status: string; exit_proof_kind: string | null }>
).map(row => [row.status, row.exit_proof_kind]);

function sleeper(tag: string): Promise<ChildProcess> {
  const child = spawn('sleep', ['60'], {
    cwd: '/var/tmp', stdio: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CCUI_PROCESS_TAG: tag, ...(process.env.pm_id ? { pm_id: process.env.pm_id } : {}) },
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

describe('codex helpers lease on the real host', () => {
  it('a stale lease whose tag is absent is reclaimed despite unreadable same-uid daemons', () => {
    const { db, leases } = realLeases();
    insertForeignLease(db, `pe-${randomUUID()}`, 25_000);
    assert.equal(leases.reclaim(), 1);
    assert.deepEqual(kinds(db), [['released', 'process_dead']]);
  });

  it('a stale lease whose tag a live process still carries is kept, then reclaimed once it exits', async () => {
    const { db, leases } = realLeases();
    const tag = `pe-${randomUUID()}`;
    insertForeignLease(db, tag, 25_000);
    // Started after the lease row: the 5 s floor still admits it as the turn's process.
    const child = await sleeper(tag);
    assert.equal(leases.reclaim(), 0);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    assert.equal(leases.reclaim(), 1);
    assert.deepEqual(kinds(db), [['released', 'process_dead']]);
  });

  it('a turn that never started is released at once with dispatch_not_started', async () => {
    const { db, leases } = realLeases();
    const tag = `pe-${randomUUID()}`;
    assert.equal(await leases.reserve({ tag, userId: 1 }), true);
    assert.equal(leases.finish(tag, { started: false, succeeded: false, cleanup: null, notBeforeMs: null }), 'released');
    assert.deepEqual(kinds(db), [['released', 'dispatch_not_started']]);
  });
});
