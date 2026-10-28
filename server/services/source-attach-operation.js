/**
 * ADR-216 §3.3 — the owner's "Repair release-branch link" as a background
 * operation. The HTTP request only validates, takes the non-blocking attach
 * lock and starts the work detached from the request (a 120 s fetch inside a
 * request would hit the tunnel's ~100 s limit). The operation runs the shared
 * library in the §3.3 order, then issues a dedicated safe restart and audits.
 *
 * State lives in memory and is mirrored in the receipt, so a poll after a
 * process restart is answered from the receipt and the live probe.
 * `restartPending` / `sourceAttachOffered` are derived from the tree, not from
 * stored state, so they stay right across a restart.
 */
import crypto from 'node:crypto';
import path from 'node:path';

import {
    acquireSourceAttachLock, evaluateAttachQuiescence, inspectReleaseCheckout, listAttachReceipts, readAttachReceipt, recordAttachOutcome,
    runReleaseAttachment,
} from '../../scripts/lib/release-branch-attach.mjs';

import { normalizeGitHubRepositoryIdentity } from './release-source-config.js';
import { readPrestageSlotState } from './update-prestager.js';

const SERVER_BUILD_ID = /^[a-f0-9]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OPERATIONS = 20;
const DEFAULT_TTL_MS = 10_000;

/** A queued restart row that names no update job (t5): the only kind an attach may reuse. */
function isUnboundRestartRow(row) {
    return !row.sourceUpdateJobId && !row.sourceUpdateTransactionId && !row.activationIdentitySha256 && !row.releaseCommit;
}

/**
 * The dedicated restart issuer of an attach (§3.3), not queueSourceUpdateRestart:
 * that one is bound to a job identity and supersedes other generations. This
 * one never supersedes or rewrites a row: it reuses a queued `safe-restart` for
 * the same build only when the row carries no job identity, and refuses
 * `restart_row_job_bound` otherwise. A double click cannot queue two restarts.
 * @param {object} deps
 * @param {{getQueuedByActionType: Function, insert: Function}} deps.actions pendingServerActionsDb
 * @param {(input: object) => {ok: boolean, value?: object}} deps.buildAction buildPendingAction
 * @param {() => string|null} deps.currentBuildId SERVER_BUILD_ID_LOADED_AT_STARTUP
 */
export function createSourceAttachRestartIssuer({ actions, buildAction, currentBuildId, audit = () => {} }) {
    return async function queueSourceAttachRestart({ expectedServerBuildId = currentBuildId(), operationId = null } = {}) {
        if (!SERVER_BUILD_ID.test(expectedServerBuildId || '')) return { queued: false, code: 'server_build_id_unavailable' };
        const decide = (row) => (isUnboundRestartRow(row)
            ? { queued: true, actionId: row.id, reused: true }
            : { queued: false, code: 'restart_row_job_bound' });
        const existing = actions.getQueuedByActionType('safe-restart', expectedServerBuildId);
        if (existing) return decide(existing);
        const built = buildAction({
            actionType: 'safe-restart', reason: 'source_attach', requestedBy: 'system-source-attach', expectedServerBuildId,
        });
        if (!built.ok) return { queued: false, code: 'restart_action_invalid' };
        if (actions.insert(built.value) === 1) {
            audit('server_action_queued', { metadata: { actionId: built.value.id, reason: 'source_attach', operationId } });
            return { queued: true, actionId: built.value.id, reused: false };
        }
        const raced = actions.getQueuedByActionType('safe-restart', expectedServerBuildId);
        return raced ? decide(raced) : { queued: false, code: 'restart_queue_failed' };
    };
}

/**
 * L7 for the server: the gate's public status, the job table and the prestage
 * slot. A read failure fails closed (unreadable journal, `null` jobs).
 */
export function createServerQuiescenceReader({ readGate, hasUnfinishedJobs, controlRoot }) {
    return async () => {
        let journal;
        try {
            const status = readGate();
            journal = { state: status.state, gateClosed: status.gateClosed, degraded: status.degraded };
        } catch { journal = { state: 'UNREADABLE' }; }
        let unfinishedJobs;
        try { unfinishedJobs = Boolean(hasUnfinishedJobs()); } catch { unfinishedJobs = null; }
        return { journal, unfinishedJobs, prestageState: readPrestageSlotState(controlRoot) };
    };
}

/**
 * A TTL cache with single flight (qa M7): concurrent readers share the one
 * in-flight read, so a burst of unauthenticated /health calls on a detached
 * node runs one probe, not one per request. `clear()` starts a new generation:
 * a read already in flight then answers its own callers but is not stored.
 */
export function createSingleFlightCache(ttlMs, now = Date.now) {
    const entries = new Map();
    let generation = 0;
    return {
        get(key, produce, force = false) {
            const hit = entries.get(key);
            if (hit?.pending) return hit.pending;
            if (!force && hit && 'value' in hit && now() - hit.at < ttlMs) return Promise.resolve(hit.value);
            const started = generation;
            const pending = Promise.resolve().then(produce).then((value) => {
                if (generation === started) entries.set(key, { at: now(), value });
                return value;
            }, (error) => {
                if (generation === started) entries.delete(key);
                throw error;
            });
            entries.set(key, { ...(hit || {}), pending });
            return pending;
        },
        clear() { generation += 1; entries.clear(); },
    };
}

function publicOperation(op) {
    return {
        operationId: op.id, state: op.state, code: op.code ?? null, step: op.step ?? null,
        restartActionId: op.restartActionId ?? null, restartCode: op.restartCode ?? null,
        restartReused: op.restartReused ?? null, openTerminals: op.openTerminals ?? null,
        receiptWriteFailed: op.receiptWriteFailed === true,
        startedAt: op.startedAt ?? null, finishedAt: op.finishedAt ?? null,
    };
}

/** Rebuild an operation's public state from its receipt (after a server restart). */
function operationFromReceipt(receipt, liveAttached) {
    const outcome = receipt.outcome || {};
    const base = { id: receipt.operationId, step: 'apply', startedAt: receipt.createdAt, finishedAt: outcome.at ?? null,
        restartActionId: outcome.restartActionId ?? null, restartCode: outcome.restartCode ?? null };
    if (outcome.state === 'applied') return { ...base, state: 'succeeded', code: null };
    if (outcome.state === 'failed' || outcome.state === 'rolled_back') return { ...base, state: 'failed', code: outcome.code ?? 'attach_failed' };
    return liveAttached
        ? { ...base, state: 'succeeded', code: null }
        : { ...base, state: 'failed', code: 'operation_interrupted' };
}

/**
 * @param {object} deps
 * @param {string} deps.appRoot
 * @param {string} deps.controlRoot `<git common dir>/nassaj-source-update`
 * @param {() => string} deps.configuredRemoteUrl the configured release source (throws when invalid)
 * @param {Function} deps.git createAttachGit(...)
 * @param {() => boolean} deps.bootBlockedDetached boot capability blockedReasonCode === 'detached_head'
 * @param {() => {ready: boolean}} deps.probe defaultGitCheckoutProbe for this tree
 * @param {Function} deps.acquireLease the gate's acquireExclusiveSourceRefLease
 * @param {Function} deps.readQuiescence createServerQuiescenceReader(...)
 * @param {Function} deps.queueRestart createSourceAttachRestartIssuer(...)
 */
export function createSourceAttachService({
    appRoot, controlRoot, remote = 'origin', branch = 'main', configuredRemoteUrl, git, bootBlockedDetached, probe,
    acquireLease, readQuiescence, queueRestart, verifySignedRelease, requireVerified = () => false,
    deadlineMs, summarizeOpenTerminals = () => null, audit = () => {}, logger = console,
    isPlatform = false, now = Date.now, ttlMs = DEFAULT_TTL_MS, runAttachment = runReleaseAttachment,
}) {
    const operations = new Map();
    let latestId = null;
    const cache = createSingleFlightCache(ttlMs, now);
    const inspect = () => inspectReleaseCheckout({ appRoot, remote, branch, git });
    const liveAttached = (force = false) => cache.get('probe', () => {
        try { return probe()?.ready === true; } catch { return false; }
    }, force);
    const offeredLocal = (force = false) => cache.get('offer', async () => {
        try { return (await inspect()).eligible === true; } catch { return false; }
    }, force);
    const bootDetached = () => { try { return !isPlatform && bootBlockedDetached() === true; } catch { return false; } };

    const remember = (op) => {
        operations.set(op.id, op);
        latestId = op.id;
        while (operations.size > MAX_OPERATIONS) operations.delete(operations.keys().next().value);
    };

    async function readRemoteIdentity() {
        const result = await git(['remote', 'get-url', '--all', remote]);
        const urls = result.code === 0 ? String(result.stdout).trim().split('\n').filter(Boolean) : [];
        return urls.length === 1 ? normalizeGitHubRepositoryIdentity(urls[0])?.identity ?? null : null;
    }

    async function latestOperation() {
        if (latestId && operations.has(latestId)) return publicOperation(operations.get(latestId));
        const [newest] = listAttachReceipts(controlRoot);
        if (!newest) return null;
        try {
            const receipt = readAttachReceipt(newest);
            return receipt.operationId ? publicOperation(operationFromReceipt(receipt, await liveAttached())) : null;
        } catch { return null; }
    }

    /** GET /update/source-attach: details for the owner's confirmation. */
    async function describe() {
        const [inspection, live] = [await inspect(), await liveAttached(true)];
        const boot = bootDetached();
        const quiet = boot && !live && inspection.eligible
            ? evaluateAttachQuiescence(await readQuiescence())
            : null;
        let reason = null;
        if (live) reason = 'already_attached';
        else if (!boot) reason = inspection.shape === 'attached' ? 'already_attached' : 'source_attach_not_offered';
        else reason = inspection.reason || quiet;
        return {
            eligible: boot && !live && inspection.eligible && !quiet, reason,
            version: inspection.version, tag: inspection.tag, shallow: inspection.shallow, branch,
            remoteIdentity: await readRemoteIdentity(), headCommit: inspection.head,
            restartPending: boot && live, operation: await latestOperation(),
        };
    }

    async function finish(op, result) {
        cache.clear();
        op.code = result.code;
        op.step = result.step;
        if (result.code === 'source_attach_writers_active') {
            try { op.openTerminals = summarizeOpenTerminals(); } catch { op.openTerminals = null; }
        }
        if (result.ok) {
            let restart;
            try { restart = await queueRestart({ operationId: op.id }); } catch { restart = { queued: false, code: 'restart_queue_failed' }; }
            Object.assign(op, { state: 'succeeded', restartActionId: restart.queued ? restart.actionId : null,
                restartCode: restart.queued ? null : restart.code, restartReused: restart.queued ? restart.reused : null });
        } else {
            op.state = result.state === 'refused' ? 'refused' : 'failed';
        }
        op.finishedAt = new Date(now()).toISOString();
        if (result.receiptWriteFailed) {
            op.receiptWriteFailed = true;
            logger.warn?.('[source-attach] attach applied and verified, but its receipt could not be updated');
        }
        if (result.receiptPath) {
            try {
                recordAttachOutcome(result.receiptPath, { operationState: op.state, restartActionId: op.restartActionId ?? null,
                    restartCode: op.restartCode ?? null });
            } catch { logger.error?.('[source-attach] receipt outcome not recorded'); }
        }
        const metadata = result.ok
            ? { operationId: op.id, tag: result.plan.tag, branch, head: result.plan.head, shallow: result.plan.shallow,
                receipt: path.basename(result.receiptPath), steps: result.changed, restartActionId: op.restartActionId,
                restartCode: op.restartCode }
            : { operationId: op.id, code: result.code, step: result.step, rolledBack: result.rolledBack ?? null };
        audit(result.ok ? 'source_attach_succeeded' : `source_attach_${op.state}`, { userId: op.userId, metadata });
        const line = `[source-attach] operation ${op.state}: ${result.code || 'ok'} (step ${result.step})`;
        if (result.ok) logger.info?.(line); else logger.warn?.(line);
    }

    async function execute(op, lock) {
        const controller = new AbortController();
        let configured;
        try { configured = configuredRemoteUrl(); } catch {
            lock.release();
            return finish(op, { ok: false, state: 'refused', code: 'invalid_release_source', step: 'inspect' });
        }
        const result = await runAttachment({
            appRoot, controlRoot, remote, branch, configuredRemoteUrl: configured, git, acquireLease, readQuiescence, lock,
            expectedHead: op.head, deadlineMs, verifySignedRelease, requireVerified: requireVerified(), operationId: op.id,
            onStep: (step) => { op.step = step; }, signal: controller.signal,
        });
        return finish(op, result);
    }

    /** POST /update/source-attach: validate, lock, start detached, answer 202. */
    async function start({ expectedHead, userId = null } = {}) {
        if (!COMMIT.test(expectedHead || '')) return { status: 400, body: { code: 'invalid_request' } };
        if (await liveAttached(true)) return { status: 409, body: { code: 'already_attached', restartPending: bootDetached() } };
        if (!bootDetached()) return { status: 409, body: { code: 'source_attach_not_offered' } };
        let lock;
        try { lock = acquireSourceAttachLock(controlRoot); } catch (error) {
            return { status: 409, body: { code: error.code || 'source_attach_lock_unavailable' } };
        }
        let inspection;
        try { inspection = await inspect(); } catch { lock.release(); return { status: 500, body: { code: 'source_attach_unavailable' } }; }
        const refusal = inspection.shape === 'attached' ? 'already_attached'
            : !inspection.eligible ? inspection.reason || 'release_checkout_invalid'
                : inspection.head !== expectedHead ? 'source_changed' : null;
        if (refusal) { lock.release(); return { status: 409, body: { code: refusal } }; }
        const op = { id: crypto.randomUUID(), state: 'running', step: 'inspect', code: null, userId, head: inspection.head,
            startedAt: new Date(now()).toISOString(), finishedAt: null };
        remember(op);
        audit('source_attach_requested', { userId, metadata: { operationId: op.id, head: op.head, tag: inspection.tag } });
        setImmediate(() => {
            execute(op, lock).catch(() => {
                lock.release();
                return finish(op, { ok: false, state: 'failed', code: 'source_attach_failed', step: op.step });
            }).catch(() => { op.state = 'failed'; op.code = 'source_attach_failed'; });
        });
        return { status: 202, body: { operationId: op.id } };
    }

    /** GET /update/source-attach/operations/:id. */
    async function operation(id) {
        if (!OPERATION_ID.test(id || '')) return null;
        if (operations.has(id)) return publicOperation(operations.get(id));
        for (const file of listAttachReceipts(controlRoot)) {
            try {
                const receipt = readAttachReceipt(file);
                if (receipt.operationId === id) return publicOperation(operationFromReceipt(receipt, await liveAttached()));
            } catch { /* a foreign file is skipped */ }
        }
        return null;
    }

    /** The two /health booleans (§3.3); no oid, version or path. */
    async function healthFlags() {
        if (!bootDetached()) return { sourceAttachOffered: false, restartPending: false };
        if (await liveAttached()) return { sourceAttachOffered: false, restartPending: true };
        return { sourceAttachOffered: await offeredLocal(), restartPending: false };
    }

    return Object.freeze({ describe, start, operation, healthFlags });
}
