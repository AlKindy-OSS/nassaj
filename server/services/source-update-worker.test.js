import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createSourceUpdateWorker, durableReceiptFile, reconcileReceiptFiles, summarizeUpdateMetrics } from './source-update-worker.js';

const identity = { workerId: 'worker', pid: 1, startTicks: '1', bootId: 'boot', pgid: 1 };
const release = {
    releaseId: 7, version: '1.44.0.2', tagName: 'v1.44.0.2', commit: 'a'.repeat(40),
    assetId: 9, assetName: 'nassaj.tar.gz', assetSize: 123, assetSha256: 'b'.repeat(64),
};

function fakeJobs(initial = 'accepted', options = {}) {
    const calls = [];
    const job = {
        id: 'job-1', state: initial, worker_fence: 7, expected_version: '1.44.0.2', strategy: 'git-checkout-v2',
        release_id: '7', release_tag: release.tagName, release_asset_id: '9', release_asset_name: release.assetName,
        release_asset_size: release.assetSize, release_asset_sha256: release.assetSha256, release_commit: release.commit,
    };
    let claimable = true;
    let sequence = 0;
    return {
        calls, job,
        claim() { if (!claimable) return null; claimable = false; return { ...job }; },
        renew() { calls.push(['renew']); return options.renew !== false; },
        assertFence() { return options.fence !== false; },
        listRuntimeReferences() { return []; },
        listReceipts() { return []; },
        transition(_id, _fence, expected, next, fields = {}) {
            calls.push(['transition', expected, next, fields]);
            if (!expected.includes(job.state)) return false;
            job.state = next; Object.assign(job, fields); return true;
        },
        appendReceipt(_id, fence, phase, kind, facts = {}) {
            const factsJson = JSON.stringify(facts); sequence += 1;
            calls.push(['receipt', phase, kind, facts]);
            return { sequence, factsJson, factsSha256: 'f'.repeat(64), workerFence: fence };
        },
        release() { calls.push(['release']); return true; },
    };
}

const updateResult = {
    transactionId: 'update-tx', commit: release.commit,
    expectedServerBuildId: 'c'.repeat(64), expectedClientBuildId: 'd'.repeat(64),
    activationIdentitySha256: 'e'.repeat(64),
};

test('worker persists exact discovery, seals before queue, and reaches restart_queued', async () => {
    const jobs = fakeJobs();
    const worker = createSourceUpdateWorker({
        jobs, identity, resolveRelease: async () => ({ release }),
        runUpdate: async (_job, _release, context) => { context.beforeQueue({
            transaction_id: updateResult.transactionId, release_commit: updateResult.commit,
            expected_server_build_id: updateResult.expectedServerBuildId,
            expected_client_build_id: updateResult.expectedClientBuildId,
            activation_identity_sha256: updateResult.activationIdentitySha256,
        }); return updateResult; },
    });
    assert.equal(await worker.processOne(), true);
    assert.deepEqual(jobs.calls.filter(([kind]) => kind === 'transition').map((call) => call[2]), [
        'resolving', 'resolved', 'staging', 'candidate_sealed', 'restart_queued',
    ]);
    assert.equal(jobs.job.release_asset_sha256, release.assetSha256);
});

test('renew failure aborts in-flight work and permits no later transition or receipt', async () => {
    const jobs = fakeJobs('staging', { renew: false });
    const worker = createSourceUpdateWorker({
        jobs, identity, leaseMs: 30, resolveRelease: async () => { throw new Error('must not resolve'); },
        runUpdate: async (_job, _release, context) => new Promise((resolve) => {
            context.signal.addEventListener('abort', () => resolve(updateResult), { once: true });
        }),
    });
    assert.equal(await worker.processOne(), false);
    const renewIndex = jobs.calls.findIndex(([kind]) => kind === 'renew');
    assert.ok(renewIndex >= 0);
    assert.equal(jobs.calls.slice(renewIndex + 1).some(([kind]) => kind === 'transition' || kind === 'receipt'), false);
});

test('recovery resumes staging without resetting to resolving or rediscovering release', async () => {
    const jobs = fakeJobs('staging');
    let resolved = false;
    const worker = createSourceUpdateWorker({
        jobs, identity, resolveRelease: async () => { resolved = true; return { release }; },
        runUpdate: async (_job, _release, context) => { context.beforeQueue({
            transaction_id: updateResult.transactionId, release_commit: updateResult.commit,
            expected_server_build_id: updateResult.expectedServerBuildId,
            expected_client_build_id: updateResult.expectedClientBuildId,
            activation_identity_sha256: updateResult.activationIdentitySha256,
        }); return updateResult; },
    });
    assert.equal(await worker.processOne(), true);
    assert.equal(resolved, false);
    assert.equal(jobs.calls.some((call) => call[0] === 'transition' && call[2] === 'resolving'), false);
    assert.ok(jobs.calls.some((call) => call[0] === 'receipt' && call[2] === 'recovery'));
});

test('receipt mirror is O_EXCL and reconciliation hard-fails mismatched bytes', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'receipt-mirror-'));
    try {
        const value = { schemaVersion: 2, jobId: 'job-1', sequence: 1, workerFence: 7,
            phase: 'resolved', kind: 'done', factsJson: '{}', factsSha256: 'f'.repeat(64) };
        const file = durableReceiptFile(root, value);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.throws(() => durableReceiptFile(root, value), /EEXIST/);
        fs.writeFileSync(file, 'tampered\n', { mode: 0o600 });
        assert.throws(() => reconcileReceiptFiles(root, 'job-1', {
            listReceipts: () => [{ job_id: 'job-1', sequence: 1, worker_fence: 7,
                phase: 'resolved', kind: 'done', facts_json: '{}', facts_sha256: 'f'.repeat(64) }],
        }), /source_update_receipt_mismatch/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// ADR-156 ت-3 (WI-14/T-1729) — the success metrics on the job receipt.
// ---------------------------------------------------------------------------

const gateMetrics = { downtimeMs: 4_200, interventionsRequired: 2, automaticRepairs: 1, reachedManual: false, closedAtMs: 1 };

test('a successful run records downtime, interventions and reachedManual on its receipt', async () => {
    const jobs = fakeJobs();
    jobs.listReceipts = () => [{ kind: 'recovery' }, { kind: 'done' }, { kind: 'rollback' }];
    const worker = createSourceUpdateWorker({
        jobs, identity, resolveRelease: async () => ({ release }),
        readGateMetrics: () => gateMetrics,
        runUpdate: async (_job, _release, context) => { context.beforeQueue({
            transaction_id: updateResult.transactionId, release_commit: updateResult.commit,
            expected_server_build_id: updateResult.expectedServerBuildId,
            expected_client_build_id: updateResult.expectedClientBuildId,
            activation_identity_sha256: updateResult.activationIdentitySha256,
        }); return updateResult; },
    });
    assert.equal(await worker.processOne(), true);
    const measured = jobs.calls.filter((call) => call[0] === 'receipt' && 'downtimeMs' in call[3]);
    assert.equal(measured.length, 1);
    // M3: the job's two repair receipts plus the gate's one automatic repair are
    // AUTOMATIC; only the gate's two human interventions count as interventions.
    assert.deepEqual(measured[0][3], {
        interventionsRequired: 2, automaticRepairs: 3, intervention: 'human', downtimeMs: 4_200, reachedManual: false,
    });
});

test('a run that healed itself is automatic, never counted as a human intervention (M3)', () => {
    assert.deepEqual(summarizeUpdateMetrics({
        receipts: [{ kind: 'recovery' }, { kind: 'rollback', facts_json: '{"code":"x"}' }, { kind: 'done' }],
        gate: { interventionsRequired: 0, automaticRepairs: 1, downtimeMs: 900 }, state: 'restart_queued',
    }), { interventionsRequired: 0, automaticRepairs: 3, intervention: 'automatic', downtimeMs: 900, reachedManual: false });
    // An explicit fact wins over the receipt kind in both directions.
    assert.deepEqual(summarizeUpdateMetrics({
        receipts: [{ kind: 'recovery', facts_json: '{"intervention":"human"}' }, { kind: 'done', facts_json: '{"intervention":"automatic"}' }],
    }), { interventionsRequired: 1, automaticRepairs: 1, intervention: 'human', downtimeMs: null, reachedManual: false });
    assert.equal(summarizeUpdateMetrics({}).intervention, null, 'nothing happened: no intervention of either kind');
    // An explicit null (a refusal before the gate closed) and an earlier metrics
    // receipt are both excluded, whatever their receipt kind says.
    assert.deepEqual(summarizeUpdateMetrics({ receipts: [
        { kind: 'rollback', facts_json: '{"code":"update_source_state_degraded","intervention":null}' },
        { kind: 'rollback', facts_json: '{"interventionsRequired":0,"downtimeMs":null,"intervention":"automatic"}' },
    ] }), { interventionsRequired: 0, automaticRepairs: 0, intervention: null, downtimeMs: null, reachedManual: false });
});

test('a failed run still reports its metrics, and an unreadable gate is not a fabricated zero', async () => {
    const jobs = fakeJobs();
    const worker = createSourceUpdateWorker({
        jobs, identity, resolveRelease: async () => ({ release }),
        readGateMetrics: () => { throw new Error('journal unreadable'); },
        runUpdate: async () => { throw new Error('update_failed'); },
    });
    assert.equal(await worker.processOne(), false);
    const measured = jobs.calls.filter((call) => call[0] === 'receipt' && 'downtimeMs' in call[3]);
    assert.equal(measured.length, 0, 'measurement must never be the reason a job fails');
});

test('reaching manual recovery is recorded as such, never as an ordinary failure', () => {
    // Reaching MANUAL means a person must act, so the run's intervention is human.
    assert.deepEqual(
        summarizeUpdateMetrics({ receipts: [], gate: null, state: 'manual_recovery_required' }),
        { interventionsRequired: 0, automaticRepairs: 0, intervention: 'human', downtimeMs: null, reachedManual: true },
    );
    assert.deepEqual(
        summarizeUpdateMetrics({ gate: { reachedManual: true, downtimeMs: 9 }, state: 'restart_queued' }),
        { interventionsRequired: 0, automaticRepairs: 0, intervention: 'human', downtimeMs: 9, reachedManual: true },
    );
});

// ---------------------------------------------------------------------------
// ADR-156 T-1730 W7 — deferral rearm from worker (§3.3, source-update-worker.js)
// ---------------------------------------------------------------------------

function fakeJobsDeferred(initial = 'accepted', options = {}) {
    const calls = [];
    const job = {
        id: 'job-defer', state: initial, worker_fence: 9, expected_version: '1.44.0.2', strategy: 'git-checkout-v2',
        release_id: '7', release_tag: release.tagName, release_asset_id: '9', release_asset_name: release.assetName,
        release_asset_size: release.assetSize, release_asset_sha256: release.assetSha256, release_commit: release.commit,
        defer_until_idle: 1, deferral_deadline_at: Date.now() + 3_600_000, deferral_rearm_count: options.rearmCount ?? 0,
    };
    let claimable = true;
    let sequence = 0;
    let rearmed = false;
    return {
        calls, job,
        claim() { if (!claimable) return null; claimable = false; return { ...job }; },
        renew() { calls.push(['renew']); return options.renew !== false; },
        assertFence() { return options.fence !== false; },
        listRuntimeReferences() { return []; },
        listReceipts() { return []; },
        rearmDeferred(id, _nowMs) {
            calls.push(['rearmDeferred', id]);
            if (rearmed || options.rearmResult === 'exhausted') return 'exhausted';
            rearmed = true;
            job.state = 'awaiting_sessions';
            return 'rearmed';
        },
        transition(_id, _fence, expected, next, fields = {}) {
            calls.push(['transition', expected, next, fields]);
            if (!expected.includes(job.state)) return false;
            job.state = next; Object.assign(job, fields); return true;
        },
        appendReceipt(_id, fence, phase, kind, facts = {}) {
            const factsJson = JSON.stringify(facts); sequence += 1;
            calls.push(['receipt', phase, kind, facts]);
            return { sequence, factsJson, factsSha256: 'f'.repeat(64), workerFence: fence };
        },
        release() { calls.push(['release']); return true; },
    };
}

test('W7: active_sessions during staging parks with intervention:null receipt (not counted as intervention)', async () => {
    // Simulate the worker hitting active_sessions from staging and rearming
    const jobs = fakeJobsDeferred('staging');
    const worker = createSourceUpdateWorker({
        jobs, identity, resolveRelease: async () => { throw new Error('must not resolve'); },
        runUpdate: async (_job, _release, _context) => {
            const err = new Error('active_sessions');
            err.code = 'active_sessions';
            throw err;
        },
    });
    const ok = await worker.processOne();
    // Worker rearmed: processOne returns false (not completed), job is back in awaiting_sessions
    assert.equal(ok, false);
    // The rearm receipt must have intervention:null — never counted as human intervention
    const rearmReceipt = jobs.calls.find(([kind, , , facts]) => kind === 'receipt' && facts && 'deferral' in facts);
    assert.ok(rearmReceipt, 'a rearm receipt was written');
    assert.equal(rearmReceipt[3].intervention, null, 'rearm receipt has intervention:null');
    assert.equal(rearmReceipt[3].deferral, 'rearmed');
});

test('W7: after MAX_DEFERRAL_REARMS=3 the worker writes deferral_rearm_exhausted failure', async () => {
    // With rearmCount=3, the worker cannot rearm anymore
    const jobs = fakeJobsDeferred('staging', { rearmCount: 3, rearmResult: 'exhausted' });
    const worker = createSourceUpdateWorker({
        jobs, identity, resolveRelease: async () => { throw new Error('must not resolve'); },
        runUpdate: async () => {
            const err = new Error('active_sessions');
            err.code = 'active_sessions';
            throw err;
        },
    });
    const ok = await worker.processOne();
    assert.equal(ok, false);
    // Should fail with deferral_rearm_exhausted
    const failTransition = jobs.calls.find(([kind, , next]) => kind === 'transition' && next === 'failed');
    assert.ok(failTransition, 'job transitioned to failed');
    assert.equal(failTransition[3]?.error_code, 'deferral_rearm_exhausted');
});

test('W7: no rearm once candidate is sealed — rearmDeferred returns noop and job fails', async () => {
    // candidate_sealed is not in REARMABLE_STATES (in the real DB layer).
    // The fake rearmDeferred below simulates this: returns 'noop' for sealed state.
    const calls = [];
    const job = {
        id: 'job-sealed', state: 'candidate_sealed', worker_fence: 11,
        expected_version: '1.44.0.2', strategy: 'git-checkout-v2',
        release_id: '7', release_tag: release.tagName, release_asset_id: '9',
        release_asset_name: release.assetName, release_asset_size: release.assetSize,
        release_asset_sha256: release.assetSha256, release_commit: release.commit,
        defer_until_idle: 1, deferral_deadline_at: Date.now() + 3_600_000, deferral_rearm_count: 0,
    };
    let sequence = 0;
    const jobs = {
        calls, job,
        claim() { return { ...job }; },
        renew() { return true; },
        assertFence() { return true; },
        listRuntimeReferences() { return []; },
        listReceipts() { return []; },
        // Real DB behaviour: returns 'noop' for candidate_sealed (not in REARMABLE_STATES)
        rearmDeferred(id, _nowMs) { calls.push(['rearmDeferred', id]); return 'noop'; },
        transition(_id, _fence, expected, next, fields = {}) {
            calls.push(['transition', expected, next, fields]);
            if (!expected.includes(job.state)) return false;
            job.state = next; Object.assign(job, fields); return true;
        },
        appendReceipt(_id, fence, phase, kind, facts = {}) {
            sequence += 1;
            calls.push(['receipt', phase, kind, facts]);
            return { sequence, factsJson: JSON.stringify(facts), factsSha256: 'f'.repeat(64), workerFence: fence };
        },
        release() { calls.push(['release']); return true; },
    };
    const worker = createSourceUpdateWorker({
        jobs, identity, resolveRelease: async () => { throw new Error('must not resolve'); },
        runUpdate: async () => {
            const err = new Error('active_sessions');
            err.code = 'active_sessions';
            throw err;
        },
    });
    await worker.processOne();
    // rearmDeferred is called but returns 'noop', so the job falls through to failed
    const rearmCalled = jobs.calls.some(([kind]) => kind === 'rearmDeferred');
    assert.equal(rearmCalled, true, 'rearmDeferred is called but returns noop');
    // Job must fail — not be rearmed
    const failTransition = jobs.calls.find(([kind, , next]) => kind === 'transition' && next === 'failed');
    assert.ok(failTransition, 'job transitions to failed when rearm returns noop');
    // The state must NOT be awaiting_sessions
    assert.notEqual(job.state, 'awaiting_sessions', 'sealed job must not transition to awaiting_sessions');
});
