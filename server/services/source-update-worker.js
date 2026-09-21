/** Durable v2 update worker: process-identity lease, fencing and mirrored receipts. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { sourceUpdateJobsDb } from '../modules/database/index.js';
import { normalizeManifestDrift } from './update-job-snapshot.js';

const LEASE_MS = 30_000;
const POLL_MS = 1_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readText(file, fallback) {
    try { return fs.readFileSync(file, 'utf8').trim() || fallback; } catch { return fallback; }
}

export function currentWorkerIdentity() {
    const stat = readText(`/proc/${process.pid}/stat`, '');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return Object.freeze({
        workerId: crypto.randomUUID(), pid: process.pid,
        startTicks: fields[19] || 'unknown',
        bootId: readText('/proc/sys/kernel/random/boot_id', 'unknown'),
        pgid: Number(fields[2]) || process.pid,
    });
}

export function durableReceiptFile(root, receipt) {
    if (!root || !SAFE_ID.test(receipt.jobId) || !Number.isSafeInteger(receipt.sequence)) throw new Error('source_update_receipt_path_invalid');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    const file = path.join(root, `${receipt.jobId}.${String(receipt.sequence).padStart(8, '0')}.json`);
    const bytes = `${JSON.stringify(receipt)}\n`;
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directoryFd = fs.openSync(root, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return file;
}

export function reconcileReceiptFiles(root, jobId, jobs) {
    if (!root) return;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const row of jobs.listReceipts(jobId)) {
        const receipt = {
            schemaVersion: 2, jobId: row.job_id, sequence: row.sequence,
            workerFence: row.worker_fence, phase: row.phase, kind: row.kind,
            factsJson: row.facts_json, factsSha256: row.facts_sha256,
        };
        const file = path.join(root, `${jobId}.${String(row.sequence).padStart(8, '0')}.json`);
        if (!fs.existsSync(file)) { durableReceiptFile(root, receipt); continue; }
        const metadata = fs.lstatSync(file);
        if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
            || fs.readFileSync(file, 'utf8') !== `${JSON.stringify(receipt)}\n`) {
            throw new Error('source_update_receipt_mismatch');
        }
    }
}

/**
 * Who a receipt says acted: its explicit `intervention` fact, else — for rows
 * written before that fact existed — a recovery/rollback receipt, which is
 * the updater repairing itself, never a person.
 */
function receiptIntervention(row) {
    let facts = null;
    try { facts = JSON.parse(row?.facts_json ?? 'null'); } catch { facts = null; }
    // A metrics receipt summarises the others; counting it would count twice.
    if (facts && typeof facts === 'object' && Object.hasOwn(facts, 'downtimeMs')) return null;
    // An explicit fact is final, including an explicit null (a refusal repaired nothing).
    if (facts && typeof facts === 'object' && Object.hasOwn(facts, 'intervention')) {
        return facts.intervention === 'human' || facts.intervention === 'automatic' ? facts.intervention : null;
    }
    return row?.kind === 'recovery' || row?.kind === 'rollback' ? 'automatic' : null;
}

/**
 * ADR-156 ت-3 (WI-14/T-1729). "Did updating get better?" was an impression, not
 * a number: the 2026-09-11 outage was never measured. Downtime and MANUAL are
 * measured by the maintenance gate, which owns the window.
 *
 * qa-critic M3: automatic repairs used to be summed INTO interventionsRequired,
 * so a run that healed itself read as needing people and the metric rewarded
 * the opposite of what it measures. They are counted apart now, and
 * `intervention` states which one this run needed: human | automatic | null.
 */
export function summarizeUpdateMetrics({ receipts = [], gate = null, state = null } = {}) {
    let human = Number.isSafeInteger(gate?.interventionsRequired) ? gate.interventionsRequired : 0;
    let automatic = Number.isSafeInteger(gate?.automaticRepairs) ? gate.automaticRepairs : 0;
    for (const row of receipts) {
        const actor = receiptIntervention(row);
        if (actor === 'human') human += 1;
        else if (actor === 'automatic') automatic += 1;
    }
    const reachedManual = state === 'manual_recovery_required' || gate?.reachedManual === true;
    return {
        interventionsRequired: human,
        automaticRepairs: automatic,
        intervention: human > 0 || reachedManual ? 'human' : (automatic > 0 ? 'automatic' : null),
        downtimeMs: Number.isSafeInteger(gate?.downtimeMs) ? gate.downtimeMs : null,
        reachedManual,
    };
}

export function createSourceUpdateWorker({
    runUpdate,
    resolveRelease,
    jobs = sourceUpdateJobsDb,
    now = Date.now,
    identity = currentWorkerIdentity(),
    leaseMs = LEASE_MS,
    receiptRoot = null,
    readGateMetrics = () => null,
    beforeWorkerClaim = () => undefined,
    afterTerminal = () => undefined,
    jobLog = null,
} = {}) {
    if (typeof runUpdate !== 'function' || typeof resolveRelease !== 'function') {
        throw new TypeError('source update worker requires runUpdate and resolveRelease');
    }
    let running = false;
    let stopped = false;

    const processOne = async () => {
        if (running || stopped) return false;
        if (typeof jobs.reapOrphanEffects === 'function' && !jobs.reapOrphanEffects()) return false;
        await beforeWorkerClaim({ references: jobs.listRuntimeReferences?.() || [] });
        const job = jobs.claim(identity, now(), leaseMs);
        if (!job) return false;
        running = true;
        const fence = job.worker_fence;
        // T-1768: the live log is a view; a failed write never fails the job.
        const logLine = (message) => { try { jobLog?.line(job.id, message); } catch { /* view only */ } };
        const logOutput = (chunk) => { try { jobLog?.append(job.id, chunk); } catch { /* view only */ } };
        const abortController = new AbortController();
        let fenced = false;
        const assertFence = () => {
            if (abortController.signal.aborted || !jobs.assertFence(job.id, identity.workerId, fence, now())) {
                fenced = true;
                abortController.abort(new Error('source_update_worker_fenced'));
                throw new Error('source_update_worker_fenced');
            }
            return true;
        };
        const transition = (expected, next, fields = {}) => {
            assertFence();
            if (!jobs.transition(job.id, fence, expected, next, fields)) throw new Error('source_update_worker_fenced');
            job.state = next;
            assertFence();
        };
        const receipt = (phase, kind, facts = {}) => {
            assertFence();
            const stored = jobs.appendReceipt(job.id, fence, phase, kind, facts);
            assertFence();
            if (receiptRoot) durableReceiptFile(receiptRoot, {
                schemaVersion: 2, jobId: job.id, sequence: stored.sequence,
                workerFence: fence, phase, kind, factsJson: stored.factsJson,
                factsSha256: stored.factsSha256,
            });
            assertFence();
            logLine(`▸ ${phase} · ${kind}`);
            return stored;
        };
        const checkpoint = (phase, kind, facts = {}) => {
            assertFence();
            receipt(phase, kind, facts);
            if (phase === 'archive_verified' && kind === 'done' && job.state === 'downloading') {
                transition(['downloading'], 'archive_verified', {
                    archive_sha256: facts.assetSha256 || job.release_asset_sha256,
                });
            } else if (phase === 'extracting' && kind === 'done' && job.state === 'archive_verified') {
                transition(['archive_verified'], 'extracting');
            } else if (phase === 'candidate_sealed' && ['intent', 'recovery'].includes(kind)
                && ['extracting', 'staging'].includes(job.state)) {
                transition([job.state], 'candidate_sealed', {
                    transaction_id: facts.generationId,
                    activation_identity_sha256: facts.activationIdentitySha256,
                });
            }
            assertFence();
        };
        /** Measurement must never be the reason a job fails, so it swallows its own errors. */
        const measure = (phase, kind, state) => {
            try {
                receipt(phase, kind, summarizeUpdateMetrics({
                    receipts: jobs.listReceipts?.(job.id) || [], gate: readGateMetrics(), state,
                }));
            } catch { /* a fenced or unreadable worker still reports its terminal state */ }
        };
        const heartbeat = setInterval(() => {
            if (!jobs.renew(job.id, identity.workerId, fence, now(), leaseMs)) {
                fenced = true;
                abortController.abort(new Error('source_update_worker_fenced'));
            }
        }, Math.max(10, Math.floor(leaseMs / 3)));
        heartbeat.unref?.();
        const registerEffect = (effect) => {
            assertFence();
            if (typeof jobs.registerEffect !== 'function'
                || !jobs.registerEffect(job.id, identity.workerId, fence, effect)) {
                throw new Error('source_update_effect_registration_failed');
            }
            receipt(job.state, 'intent', { effectId: effect.effectId, effectKind: effect.kind,
                pid: effect.pid, startTicks: effect.startTicks, bootId: effect.bootId, pgid: effect.pgid });
            assertFence();
        };
        const completeEffect = async (effectId) => {
            if (typeof jobs.completeEffect !== 'function') throw new Error('source_update_effect_completion_failed');
            let completed = false;
            for (let attempt = 0; attempt < 100 && !completed; attempt += 1) {
                assertFence();
                completed = jobs.completeEffect(job.id, fence, effectId);
                if (!completed) await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (!completed) throw new Error('source_update_effect_group_survived');
            receipt(job.state, 'done', { effectId });
            assertFence();
        };
        try {
            reconcileReceiptFiles(receiptRoot, job.id, jobs);
            if (job.state !== 'accepted') {
                receipt(job.state, 'recovery', { recoveredState: job.state });
            } else {
                receipt('resolving', 'intent', { expectedVersion: job.expected_version, strategy: job.strategy });
                transition(['accepted'], 'resolving');
            }
            let release;
            if (job.state === 'resolving') {
                assertFence();
                const discovered = await resolveRelease(job.expected_version, { signal: abortController.signal, assertFence });
                assertFence();
                release = discovered?.release;
                if (!release || release.version !== job.expected_version) throw new Error('release_identity_mismatch');
                const releaseFields = {
                    release_id: String(release.releaseId), release_tag: release.tagName,
                    release_asset_id: String(release.assetId), release_asset_name: release.assetName,
                    release_asset_size: release.assetSize, release_asset_sha256: release.assetSha256,
                    release_commit: release.commit,
                };
                receipt('resolved', 'done', releaseFields);
                transition(['resolving'], 'resolved', releaseFields);
            } else {
                release = {
                    releaseId: Number(job.release_id), tagName: job.release_tag,
                    assetId: Number(job.release_asset_id), assetName: job.release_asset_name,
                    assetSize: job.release_asset_size, assetSha256: job.release_asset_sha256,
                    commit: job.release_commit, version: job.expected_version,
                };
            }
            if (job.state === 'resolved') transition(['resolved'], job.strategy === 'release-layout-v2' ? 'downloading' : 'staging');
            const sealBeforeQueue = (facts) => {
                if (job.state === 'candidate_sealed') {
                    transition(['candidate_sealed'], 'candidate_sealed', facts);
                    return;
                }
                receipt('candidate_sealed', 'intent', facts);
                transition([job.state], 'candidate_sealed', facts);
                receipt('candidate_sealed', 'done', facts);
            };
            const result = await runUpdate(job, release, {
                jobId: job.id, workerId: identity.workerId, fence,
                signal: abortController.signal, assertFence, checkpoint,
                receipt, registerEffect, completeEffect, onOutput: logOutput,
                effectGateRoot: receiptRoot ? path.join(path.dirname(receiptRoot), 'effect-gates') : null,
                beforeQueue: sealBeforeQueue,
            });
            assertFence();
            if (job.state !== 'candidate_sealed') {
                transition([job.state], 'candidate_sealed', {
                    transaction_id: result.transactionId,
                    release_commit: result.commit,
                    archive_sha256: result.archiveSha256 || release.assetSha256,
                    source_tree_sha256: result.sourceTreeSha256 || null,
                    expected_server_build_id: result.expectedServerBuildId,
                    expected_client_build_id: result.expectedClientBuildId,
                    activation_identity_sha256: result.activationIdentitySha256,
                });
            }
            const facts = {
                transactionId: result.transactionId, releaseCommit: result.commit,
                expectedServerBuildId: result.expectedServerBuildId,
                expectedClientBuildId: result.expectedClientBuildId,
                activationIdentitySha256: result.activationIdentitySha256,
            };
            receipt('candidate_sealed', 'done', facts);
            receipt('restart_queued', 'intent', facts);
            transition(['candidate_sealed'], 'restart_queued');
            receipt('restart_queued', 'done', facts);
            measure('restart_queued', 'done', 'restart_queued');
            return true;
        } catch (error) {
            if (fenced || abortController.signal.aborted) return false;
            const code = typeof error?.code === 'string' ? error.code : (error?.message || 'update_failed');
            const message = typeof error?.message === 'string' ? error.message.slice(0, 500) : 'Update failed';
            logLine(`✗ ${code}`);
            try {
                // T-1730 W7: a deferred job whose updater refuses on live
                // sessions is handed back to the scheduler, not failed — as long
                // as the candidate is not yet sealed, the deadline has not
                // passed, and the rearm cap is not spent. The rearm receipt is
                // written while the fence is still valid (rearmDeferred voids it),
                // and carries intervention:null so it is never scored as an
                // automatic repair (M8).
                if (code === 'active_sessions' && Number(job.defer_until_idle) === 1
                    && typeof jobs.rearmDeferred === 'function') {
                    const deadline = Number(job.deferral_deadline_at) || 0;
                    const expired = deadline > 0 && now() >= deadline;
                    const canRearm = !expired && (Number(job.deferral_rearm_count) || 0) < 3;
                    if (canRearm) {
                        receipt(job.state, 'recovery', { deferral: 'rearmed', intervention: null });
                        if (jobs.rearmDeferred(job.id, now()) === 'rearmed') return false;
                        // Under the fence nothing else mutates this job, so a
                        // non-rearm here is unreachable; fall through defensively.
                    } else {
                        const deferralCode = expired ? 'deferral_expired' : 'deferral_rearm_exhausted';
                        receipt(job.state, 'rollback', { code: deferralCode, intervention: null });
                        transition([job.state], 'failed', {
                            error_code: deferralCode,
                            error_message: expired
                                ? 'The deferred update waited past its maximum window.'
                                : 'The deferred update exhausted its rearm attempts.',
                        });
                        measure('failed', 'rollback', 'failed');
                        await afterTerminal({ jobId: job.id, state: 'failed', references: jobs.listRuntimeReferences?.() || [] });
                        return false;
                    }
                }
                if (message === 'source_update_receipt_mismatch') {
                    transition([job.state], 'manual_recovery_required', {
                        error_code: 'source_update_receipt_mismatch', error_message: message,
                    });
                    measure('manual_recovery_required', 'rollback', 'manual_recovery_required');
                    await afterTerminal({ jobId: job.id, state: 'manual_recovery_required', references: jobs.listRuntimeReferences?.() || [] });
                    return false;
                }
                // T-1804: the manifest-drift file lists ride the receipt's own
                // JSON facts — the existing durable, schema-free channel — so the
                // operator sees WHICH files drifted without a new column and
                // without a migration. `normalizeManifestDrift` is the gate: an
                // unrecognised or oversized shape becomes null, never free text.
                const manifestDrift = normalizeManifestDrift(error?.details);
                receipt(job.state, 'rollback', { code, ...(manifestDrift ? { manifestDrift } : {}) });
                transition([job.state], 'failed', { error_code: code, error_message: message });
                measure('failed', 'rollback', 'failed');
                await afterTerminal({ jobId: job.id, state: 'failed', references: jobs.listRuntimeReferences?.() || [] });
            } catch { /* a newer fence owns recovery */ }
            return false;
        } finally {
            clearInterval(heartbeat);
            if (!fenced) jobs.release(job.id, identity.workerId, fence);
            running = false;
        }
    };

    let timer = null;
    return Object.freeze({
        processOne,
        start() {
            if (timer || stopped) return;
            timer = setInterval(() => { void processOne(); }, POLL_MS);
            timer.unref?.();
            void processOne();
        },
        stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
        identity,
    });
}
