/**
 * T-1730 W7 (ADR-156 §3.3, M8). When a DEFERRED job's updater refuses on live
 * sessions, the worker hands it back to the scheduler instead of failing it —
 * writing a rearm receipt that carries intervention:null so it never inflates
 * the automatic-repair metric — until the rearm cap is spent, when it fails
 * with deferral_rearm_exhausted. This is a new file; the existing
 * source-update-worker.test.js belongs to the tester and is untouched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSourceUpdateWorker, summarizeUpdateMetrics } from './source-update-worker.js';

const identity = { workerId: 'worker', pid: 1, startTicks: '1', bootId: 'boot', pgid: 1 };
const release = {
    releaseId: 7, version: '1.44.0.2', tagName: 'v1.44.0.2', commit: 'a'.repeat(40),
    assetId: 9, assetName: 'nassaj.tar.gz', assetSize: 123, assetSha256: 'b'.repeat(64),
};

function fakeDeferredJobs({ rearmCount = 0, deadlineAt = Date.now() + 3_600_000 } = {}) {
    const calls = [];
    const receipts = [];
    const job = {
        id: 'job-1', state: 'accepted', worker_fence: 7, expected_version: '1.44.0.2',
        strategy: 'git-checkout-v2', defer_until_idle: 1, deferral_rearm_count: rearmCount,
        deferral_deadline_at: deadlineAt,
    };
    let claimable = true;
    let rearmOutcome = null;
    let sequence = 0;
    return {
        calls, job, receipts, get rearmOutcome() { return rearmOutcome; },
        claim() { if (!claimable) return null; claimable = false; return { ...job }; },
        renew() { return true; },
        assertFence() { return true; },
        listRuntimeReferences() { return []; },
        listReceipts() { return receipts.slice(); },
        transition(_id, _fence, expected, next, fields = {}) {
            calls.push(['transition', next]);
            if (!expected.includes(job.state)) return false;
            job.state = next; Object.assign(job, fields); return true;
        },
        appendReceipt(_id, fence, phase, kind, facts = {}) {
            sequence += 1;
            const row = { job_id: 'job-1', sequence, worker_fence: fence, phase, kind,
                facts_json: JSON.stringify(facts), facts_sha256: 'f'.repeat(64) };
            receipts.push(row);
            calls.push(['receipt', kind, facts]);
            return { sequence, factsJson: row.facts_json, factsSha256: row.facts_sha256, workerFence: fence };
        },
        rearmDeferred(_id) { rearmOutcome = job.deferral_rearm_count < 3 ? 'rearmed' : 'exhausted';
            if (rearmOutcome === 'rearmed') job.state = 'awaiting_sessions'; return rearmOutcome; },
        release() { calls.push(['release']); return true; },
    };
}

const throwsActiveSessions = async () => {
    const error = new Error('Finish all active agent sessions before updating.');
    error.code = 'active_sessions';
    throw error;
};

test('W7 worker: a deferred active_sessions refusal rearms with an un-metered receipt', async () => {
    const jobs = fakeDeferredJobs({ rearmCount: 0 });
    const worker = createSourceUpdateWorker({
        jobs, identity, now: () => Date.now(),
        resolveRelease: async () => ({ release }),
        runUpdate: throwsActiveSessions,
    });
    assert.equal(await worker.processOne(), false, 'the job is handed back, not failed');
    assert.equal(jobs.rearmOutcome, 'rearmed');
    assert.ok(!jobs.calls.some((c) => c[0] === 'transition' && c[1] === 'failed'), 'never transitions to failed');

    const rearmReceipt = jobs.calls.find((c) => c[0] === 'receipt' && c[2]?.deferral === 'rearmed');
    assert.ok(rearmReceipt, 'a rearm receipt was written');
    assert.equal(rearmReceipt[2].intervention, null, 'explicit intervention:null');

    const metrics = summarizeUpdateMetrics({ receipts: jobs.receipts });
    assert.equal(metrics.automaticRepairs, 0, 'the rearm is not scored as an automatic repair');
    assert.equal(metrics.intervention, null);
});

test('W7 worker: the rearm cap yields deferral_rearm_exhausted, still un-metered', async () => {
    const jobs = fakeDeferredJobs({ rearmCount: 3 });
    const worker = createSourceUpdateWorker({
        jobs, identity, now: () => Date.now(),
        resolveRelease: async () => ({ release }),
        runUpdate: throwsActiveSessions,
    });
    assert.equal(await worker.processOne(), false);
    assert.equal(jobs.job.state, 'failed');
    const rollback = jobs.calls.find((c) => c[0] === 'receipt' && c[2]?.code === 'deferral_rearm_exhausted');
    assert.ok(rollback, 'failed with the exhausted code');
    assert.equal(rollback[2].intervention, null, 'the terminal deferral receipt is also un-metered');

    const metrics = summarizeUpdateMetrics({ receipts: jobs.receipts });
    assert.equal(metrics.automaticRepairs, 0);
});

test('W7 worker: a non-deferred active_sessions refusal fails normally', async () => {
    const jobs = fakeDeferredJobs({ rearmCount: 0 });
    jobs.job.defer_until_idle = 0;
    const worker = createSourceUpdateWorker({
        jobs, identity, now: () => Date.now(),
        resolveRelease: async () => ({ release }),
        runUpdate: throwsActiveSessions,
    });
    assert.equal(await worker.processOne(), false);
    assert.equal(jobs.job.state, 'failed');
    assert.equal(jobs.rearmOutcome, null, 'rearm is never attempted without consent to defer');
});
