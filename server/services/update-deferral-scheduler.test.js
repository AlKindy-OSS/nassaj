/**
 * T-1730 W7 (ADR-156 §3.3). The deferral scheduler advances jobs parked in
 * awaiting_sessions with kill-free, owner-safe rules. These tests drive the
 * real CAS repository behind an injected clock and injected counters, and pin:
 * the two-sample idle debounce, a session between samples resetting it, the PTY
 * case where the two counters disagree (no promotion, gate reason surfaced),
 * expiry at boot and on tick, worker-independent capability loss, and the
 * one-shot owner alert at restart_queued.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
    hashSourceUpdateIdempotencyKey,
    sourceUpdateJobsDb,
    sourceUpdateRequestFingerprint,
} from '@/modules/database/repositories/source-update-jobs.db.js';

import { createUpdateDeferralScheduler } from './update-deferral-scheduler.js';

async function withDb(run) {
    const previous = process.env.DATABASE_PATH;
    const dir = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'defer-sched-'));
    const databasePath = path.join(dir, 'auth.db');
    await writeFile(databasePath, '');
    closeConnection();
    process.env.DATABASE_PATH = databasePath;
    await initializeDatabase();
    const owner = getConnection().prepare(
        "INSERT INTO users(username, password_hash, role) VALUES ('sched-owner', 'x', 'owner')",
    ).run();
    try {
        await run(Number(owner.lastInsertRowid));
    } finally {
        closeConnection();
        if (previous === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = previous;
        await rm(dir, { recursive: true, force: true });
    }
}

let seq = 0;
function park(ownerId, state, deadlineAt) {
    seq += 1;
    const strategy = 'git-checkout-v2';
    const version = '1.47.0.17';
    return sourceUpdateJobsDb.createDeferred({
        id: `sched-job-${seq}`, ownerId, expectedVersion: version, strategy,
        idempotencyKeyHash: hashSourceUpdateIdempotencyKey(`k-${seq}`),
        requestFingerprint: sourceUpdateRequestFingerprint(ownerId, version, strategy, false),
        deferralDeadlineAt: deadlineAt,
    }, state).job;
}

test('W7: promotes only after two zero samples a debounce apart', async () => {
    await withDb(async (ownerId) => {
        const clock = { t: 1_000 };
        let sessions = 0;
        let woken = 0;
        const job = park(ownerId, 'awaiting_sessions', clock.t + 3_600_000);
        const scheduler = createUpdateDeferralScheduler({
            jobs: sourceUpdateJobsDb,
            countGovernedActiveSessions: () => sessions,
            readGateSessionCount: async () => ({ count: 0, reason: null }),
            wakeWorker: () => { woken += 1; },
            now: () => clock.t,
            idleDebounceMs: 30_000,
        });

        await scheduler.tick();
        assert.equal(sourceUpdateJobsDb.getById(job.id).state, 'awaiting_sessions', 'first sample only stamps');
        assert.notEqual(sourceUpdateJobsDb.getById(job.id).idle_observed_at, null);

        // A session reappears before the second sample: the debounce resets.
        clock.t += 10_000; sessions = 1;
        await scheduler.tick();
        assert.equal(sourceUpdateJobsDb.getById(job.id).idle_observed_at, null, 'a returning session clears it');

        clock.t += 10_000; sessions = 0;
        await scheduler.tick();
        assert.notEqual(sourceUpdateJobsDb.getById(job.id).idle_observed_at, null, 're-stamped');

        clock.t += 30_000;
        await scheduler.tick();
        assert.equal(sourceUpdateJobsDb.getById(job.id).state, 'accepted', 'promoted after the debounce');
        assert.equal(woken, 1, 'the worker was kicked exactly once');
    });
});

test('W7: an orphan PTY (counters disagree) blocks promotion and surfaces the gate reason', async () => {
    await withDb(async (ownerId) => {
        const clock = { t: 1_000 };
        const job = park(ownerId, 'awaiting_sessions', clock.t + 3_600_000);
        const scheduler = createUpdateDeferralScheduler({
            jobs: sourceUpdateJobsDb,
            countGovernedActiveSessions: () => 0,           // in-process says idle
            readGateSessionCount: async () => ({ count: 1, reason: 'pty_shell' }), // gate disagrees
            now: () => clock.t,
            idleDebounceMs: 30_000,
        });
        await scheduler.tick();
        clock.t += 60_000;
        await scheduler.tick();
        assert.equal(sourceUpdateJobsDb.getById(job.id).state, 'awaiting_sessions', 'never promoted');
        assert.equal(scheduler.getLastGateReason(), 'pty_shell', 'the panel gets the gate reason');
    });
});

test('W7: an unreadable gate blocks promotion (fail closed)', async () => {
    await withDb(async (ownerId) => {
        const clock = { t: 1_000 };
        const job = park(ownerId, 'awaiting_sessions', clock.t + 3_600_000);
        const scheduler = createUpdateDeferralScheduler({
            jobs: sourceUpdateJobsDb,
            countGovernedActiveSessions: () => 0,
            readGateSessionCount: async () => { throw new Error('gate down'); },
            now: () => clock.t,
            idleDebounceMs: 30_000,
        });
        await scheduler.tick();
        clock.t += 60_000;
        await scheduler.tick();
        assert.equal(sourceUpdateJobsDb.getById(job.id).state, 'awaiting_sessions');
        assert.equal(scheduler.getLastGateReason(), 'gate_unavailable');
    });
});

test('W7: expiry fails a past-deadline job on tick and at boot', async () => {
    await withDb(async (ownerId) => {
        const clock = { t: 100_000 };
        const onTick = park(ownerId, 'awaiting_sessions', 50_000); // already past
        const scheduler = createUpdateDeferralScheduler({
            jobs: sourceUpdateJobsDb,
            countGovernedActiveSessions: () => 0,
            readGateSessionCount: async () => ({ count: 0, reason: null }),
            now: () => clock.t,
        });
        await scheduler.tick();
        assert.equal(sourceUpdateJobsDb.getById(onTick.id).state, 'failed');
        assert.equal(sourceUpdateJobsDb.getById(onTick.id).error_code, 'deferral_expired');

        const onBoot = park(ownerId, 'awaiting_sessions', 60_000);
        scheduler.reconcileOnStartup();
        assert.equal(sourceUpdateJobsDb.getById(onBoot.id).error_code, 'deferral_expired');
    });
});

test('W7: reconcileOnStartup resumes the debounce from zero for a live job', async () => {
    await withDb(async (ownerId) => {
        const job = park(ownerId, 'awaiting_sessions', Date.now() + 3_600_000);
        sourceUpdateJobsDb.recordIdleObservation(job.id, 123);
        const scheduler = createUpdateDeferralScheduler({
            jobs: sourceUpdateJobsDb,
            countGovernedActiveSessions: () => 0,
            readGateSessionCount: async () => ({ count: 0, reason: null }),
            now: () => Date.now(),
        });
        scheduler.reconcileOnStartup();
        assert.equal(sourceUpdateJobsDb.getById(job.id).idle_observed_at, null, 'a stale pre-restart sample is dropped');
    });
});

test('W7: capability loss fails parked jobs independently of the worker', async () => {
    await withDb(async (ownerId) => {
        const job = park(ownerId, 'awaiting_sessions', Date.now() + 3_600_000);
        const scheduler = createUpdateDeferralScheduler({
            jobs: sourceUpdateJobsDb,
            countGovernedActiveSessions: () => 0,
            readGateSessionCount: async () => ({ count: 0, reason: null }),
            isReleaseSourceInvalid: () => true,
            now: () => Date.now(),
        });
        await scheduler.tick();
        const failed = sourceUpdateJobsDb.getById(job.id);
        assert.equal(failed.state, 'failed');
        assert.equal(failed.error_code, 'deferral_capability_lost');
    });
});

test('W7: the constructor rejects a missing repository or counter', () => {
    assert.throws(() => createUpdateDeferralScheduler({}), /jobs repository/);
    assert.throws(() => createUpdateDeferralScheduler({ jobs: sourceUpdateJobsDb }), /session counters/);
});

test('W7: start reconciles then ticks, and stop halts the loop', async () => {
    await withDb(async () => {
        let ticks = 0;
        const scheduler = createUpdateDeferralScheduler({
            jobs: {
                listAwaitingSessions: () => { ticks += 1; return []; },
                listRestartQueuedDeferred: () => [],
                expireDeferrals: () => 0,
            },
            countGovernedActiveSessions: () => 0,
            readGateSessionCount: async () => ({ count: 0, reason: null }),
            intervalMs: 10_000,
        });
        scheduler.start();
        scheduler.start(); // idempotent: a second start installs no second timer
        await new Promise((resolve) => setImmediate(resolve));
        scheduler.stop();
        assert.ok(ticks >= 1, 'start ran an immediate reconcile + tick');
        const after = ticks;
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(ticks, after, 'no ticks after stop');
    });
});

test('W7: the owner is alerted exactly once when a deferred job reaches restart_queued', async () => {
    await withDb(async (ownerId) => {
        const job = park(ownerId, 'awaiting_sessions', Date.now() + 3_600_000);
        getConnection().prepare("UPDATE source_update_jobs SET state = 'restart_queued' WHERE id = ?").run(job.id);
        const alerts = [];
        const scheduler = createUpdateDeferralScheduler({
            jobs: sourceUpdateJobsDb,
            countGovernedActiveSessions: () => 0,
            readGateSessionCount: async () => ({ count: 0, reason: null }),
            notifyOwner: (payload) => alerts.push(payload),
            now: () => Date.now(),
        });
        await scheduler.tick();
        await scheduler.tick();
        assert.equal(alerts.length, 1, 'a single push, not one per tick');
        assert.deepEqual(alerts[0], { userId: ownerId, jobId: job.id });
    });
});
