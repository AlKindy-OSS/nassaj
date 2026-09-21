/**
 * SYSTEM STATS API ROUTES
 * =======================
 *
 * Lightweight host hardware telemetry for the sidebar footer widget:
 *
 *   GET /api/system/stats →
 *     {
 *       cpu:    { percent: number },                            // 0..100, 2 decimals
 *       memory: { usedBytes, totalBytes, percent },             // percent 0..100, 1 decimal
 *       storage:{ usedBytes, totalBytes, percent } | null       // filesystem holding the app
 *     }
 *
 * CPU measurement — /proc/stat delta (chosen over os.loadavg):
 *   loadavg is a 1-minute exponential average of the run-queue length and
 *   lags badly behind actual utilisation; /proc/stat jiffy counters diffed
 *   over a real time window give the true busy ratio. We keep the previous
 *   aggregate sample in module state, so each request after the first is a
 *   single cheap read (delta vs. the last sample). The very first request
 *   takes a 250 ms two-point sample for an immediately accurate value.
 *   Samples closer together than MIN_SAMPLE_MS reuse the last computed
 *   percent to avoid noisy micro-deltas. On non-Linux hosts (no /proc) we
 *   fall back to loadavg normalised by core count.
 *
 * Memory — /proc/meminfo MemAvailable (kernel's own estimate of reclaimable
 *   memory, includes cache/buffers) rather than os.freemem(), which reports
 *   strictly-free pages and wildly overstates usage on a Linux box with a
 *   warm page cache. Fallback: os.totalmem()/os.freemem().
 *
 * Storage — statfs(process.cwd()), so the figure describes the filesystem
 *   that actually holds the running application (including deployments where
 *   it is a separate mount). A read failure yields null instead of failing the
 *   otherwise-useful CPU/memory response.
 *
 * No new dependencies; node:fs + node:os only.
 */

import crypto from 'crypto';
import fs, { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { spawn } from 'child_process';

import express from 'express';

import { assertLegacyTransitionAllowed } from '../bootstrap-startup-context.js';
import { readOidPairServingReceipt, reconcileOidPairServingReceipt, validateOidPairTerminal } from '../../scripts/oid-control-capsule.mjs';
import { computeOidTripleTargetDigest } from '../../scripts/lib/oid-triple-target.mjs';
import { hasCurrentUpdateConsent } from '../services/update-auto-activator.js';
import { withLocalUpdateWriterLease } from '../services/update-writer-lease.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { requireRole, roleSatisfies } from '../middleware/auth.js';
import { appConfigDb, auditLogDb, pendingServerActionsDb, projectsDb, sourceUpdateJobsDb, RESTART_DEFERRAL_REASON_CODES } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import { describeFences, liftFence } from '../modules/execution-permissions/permission-fence.js';
import { getSystemResources, readSwapHolders } from '../modules/providers/services/session-resources.service.js';
import { attachSessionTitles } from '../services/live-session-titles.js';
import { createReleaseDiscovery, releaseErrorPayload } from '../services/release-discovery.js';
import { createGitTagReleaseDiscovery } from '../services/git-tag-release-discovery.js';
import { resolveUpdateHostCapability } from '../services/source-updater.js';
import {
    buildPendingAction,
    toPublic,
    toPublicCatalog,
    isGlobalIdempotentAction,
    needsKillConfirmation,
    APP_ROOT,
} from '../services/server-actions.js';
import {
    inspectServerActivationCandidate,
    inspectServerCandidate,
    inspectLegacyRestartDisposition,
    readActivationTransaction,
    serverActivatingDirectory,
    serverCandidateDirectory,
    transitionActivationTransaction,
    getLocalUpdateStatus,
    requestLocalUpdatePreparation,
    requestLocalUpdateCancellation,
    requestLocalUpdateConfirmation,
    inspectLocalUpdateAction,
    resolveHostUpdateMode,
    getLocalUpdatePolicyStatus,
    requestLocalUpdatePolicyChange,
} from '../services/local-preview-server-control.js';
import {
    canRoleRunAction,
    canRoleRunRawExec,
    effectiveModeForRole,
    enforceRawExecEnvironmentGuard,
    rawExecEnvironmentBlockers,
    getCommandBoardConfig,
    toPublicCommandBoardConfig,
    setCommandBoardConfig,
} from '../services/command-board-config.js';
import {
    insertRawCommand,
    listRawCommands,
    prepareRawExecution,
    deleteRawCommand,
    recordRawExecution,
    listRawHistory,
    deleteRawHistoryEntry,
    redactSecretsForAudit,
    MAX_RAW_QUEUE,
    MAX_RAW_OUTPUT_BYTES,
} from '../services/command-board-raw.js';
import {
    resolveAction,
    isKnownActionType,
    toPublicCustomCatalog,
    listCustomCommandsForOwner,
    createCustomCommand,
    updateCustomCommand,
    deleteCustomCommand,
} from '../services/command-board-custom.js';
import { clientIp } from '../utils/client-ip.js';
import { getBootSecurityWarnings } from '../services/isolation/boot-security-status.js';
import { setOperatorPolicyKey } from '../services/isolation/claude-managed-settings.js';
import { createUpdateMaintenanceGate, readUpdateMaintenanceRecoveryEvidence } from '../services/update-maintenance-gate.js';
import { resolveDegraded } from '../services/health-degraded.js';
import { readRuntimeIdentity } from '../services/runtime-identity.js';
import { hashTree } from '../../scripts/lib/source-update-tree-identity.mjs';
import {
    applySourceManifest,
    exchangeGenerations,
    inspectGitRuntimeRecovery,
    planSourceManifest,
    rollbackGenerations,
    rollbackSourceManifest,
    validateCandidate,
    verifyRuntimeIdentities,
} from '../../scripts/lib/source-update-activation.mjs';
import { requireReleaseLayout } from '../../scripts/lib/update-release-layout-adapter.mjs';
import { reconcileActivatedHostCapability, restoreHostCapability } from '../../scripts/lib/update-runtime-capability.mjs';
import {
    activateReleaseGeneration,
    readReleaseActivationAction,
    rollbackReleaseGeneration,
} from '../../scripts/lib/update-release-layout-activation.mjs';
import {
    captureDatabaseSnapshot,
} from '../../scripts/lib/source-update-database-snapshot.mjs';
import { resolveDatabaseFilePath } from '../modules/database/database-path.js';

const router = express.Router();

const localUpdateLimiter = createRateLimiter({ windowMs: 60_000, max: 20, message: 'Too many update requests' });

/** Return bounded public failures without leaking Git output, paths or command arguments. */
function localUpdateFailure(res, error) {
    const code = /^local_update_[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'local_update_unavailable';
    const status = code.includes('invalid') || code.includes('required') ? 400 : code === 'local_update_unavailable' ? 503 : 409;
    // The refusal used to be silent server-side. Log the bounded code only —
    // never error.message, which may carry Git output, paths or arguments.
    // A 400 is a caller mistake, not a server fault, so it stays at WARN.
    const line = `Local update request rejected: ${code} (status ${status})`;
    if (status === 400) console.warn(`[WARN] ${line}`); else console.error(`[ERROR] ${line}`);
    return res.status(status).json({ success: false, code });
}

router.get('/update/local', requireRole('owner'), localUpdateLimiter, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(getLocalUpdateStatus()); }
    catch (error) { return localUpdateFailure(res, error); }
});

router.get('/update/local/policy', requireRole('owner'), localUpdateLimiter, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return res.json(getLocalUpdatePolicyStatus()); }
    catch (error) { return localUpdateFailure(res, error); }
});

router.put('/update/local/policy', requireRole('owner'), localUpdateLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!Number.isSafeInteger(req.user?.id) || req.user.id < 1) return res.status(403).json({ code: 'owner_identity_unavailable' });
    const { mode, expectedRevision } = req.body || {};
    if (!['disabled', 'dev-full-auto'].includes(mode) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || !/^[\x21-\x7e]{16,200}$/.test(req.get('Idempotency-Key') || '')) {
        return res.status(400).json({ code: 'local_update_policy_invalid_request' });
    }
    try {
        const policy = await withLocalUpdateWriterLease('local-update-policy', () => requestLocalUpdatePolicyChange({
            ownerId: req.user.id, mode, expectedRevision, idempotencyKey: req.get('Idempotency-Key'),
        }));
        auditLogDb.record('local_update_policy_changed', { userId: req.user.id, metadata: policy });
        return res.json(policy);
    } catch (error) { return localUpdateFailure(res, error); }
});

router.post('/update/local/prepare', requireRole('owner'), localUpdateLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!Number.isSafeInteger(req.user?.id) || req.user.id < 1) return res.status(403).json({ code: 'owner_identity_unavailable' });
    if (!/^[a-f0-9]{40}$/.test(req.body?.expectedOid || '')
        || !/^[\x21-\x7e]{16,200}$/.test(req.get('Idempotency-Key') || '')) return res.status(400).json({ code: 'local_update_invalid_request' });
    try {
        const gate = createUpdateMaintenanceGate({ projectPath: APP_ROOT }).readPublicStatus();
        if (gate.gateClosed || gate.degraded) {
            console.error('[ERROR] Local update prepare rejected: local_update_maintenance_active');
            return res.status(409).json({ code: 'local_update_maintenance_active' });
        }
        const update = await requestLocalUpdatePreparation({ ownerId: req.user.id,
            expectedOid: req.body.expectedOid, idempotencyKey: req.get('Idempotency-Key') });
        auditLogDb.record('local_update_prepared_requested', { userId: req.user.id, metadata: { sequence: update.sequence, oid: update.oid } });
        return res.status(202).json({ update, activationReady: false, blockedReasonCode: 'pair_activation_unavailable' });
    } catch (error) { return localUpdateFailure(res, error); }
});

router.post('/update/local/:sequence/cancel', requireRole('owner'), localUpdateLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const sequence = Number(req.params.sequence), expectedRevision = req.body?.expectedRevision;
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        return res.status(400).json({ code: 'local_update_invalid_request' });
    }
    try {
        const update = await requestLocalUpdateCancellation({ ownerId: req.user.id, sequence, expectedRevision });
        auditLogDb.record('local_update_cancelled', { userId: req.user.id, metadata: { sequence } });
        return res.json({ update });
    } catch (error) { return localUpdateFailure(res, error); }
});

/** The update dialog is the sole ordinary local activation entry; the existing loop drains sessions. */
router.post('/update/local/:sequence/confirm', requireRole('owner'), localUpdateLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const sequence = Number(req.params.sequence), { expectedRevision, targetDigest } = req.body || {};
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
        || !/^[a-f0-9]{64}$/.test(targetDigest || '') || !Number.isSafeInteger(req.user?.id) || req.user.id < 1) {
        return res.status(400).json({ code: 'local_update_invalid_request' });
    }
    try {
        const state = await withLocalUpdateWriterLease('local-update-consent', async () => {
            const confirmed = await requestLocalUpdateConfirmation({ ownerId: req.user.id, sequence, expectedRevision, targetDigest });
            pendingServerActionsDb.enqueueGenerationBoundGlobal({ id: crypto.randomUUID(), actionType: 'safe-restart',
                reason: `local-update:${confirmed.sequence}`, requestedBy: `local-update:${req.user.id}`,
                expectedServerBuildId: confirmed.target.serverBuildId, activationIdentitySha256: confirmed.targetDigest,
                releaseCommit: confirmed.oid });
            auditLogDb.record('local_update_confirmed', { userId: req.user.id, metadata: { sequence, targetDigest } });
            return confirmed;
        });
        return res.status(202).json({ success: true, sequence: state.sequence, phase: state.phase });
    } catch (error) {
        if (error?.code === 'pair_activation_unavailable') return res.status(409).json({ code: 'pair_activation_unavailable', activationReady: false });
        return localUpdateFailure(res, error);
    }
});
router.post('/update/jobs/:jobId/confirm', requireRole('owner'), localUpdateLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { expectedVersion, targetDigest } = req.body || {};
    if (resolveHostUpdateMode() !== 'release') return res.status(409).json({ code: 'local_update_required' });
    if (typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(targetDigest || '')) return res.status(400).json({ code: 'update_consent_invalid' });
    if (!sourceUpdateJobsDb.renewActivationConsent(req.params.jobId, req.user.id, expectedVersion, targetDigest)) {
        return res.status(409).json({ code: 'update_consent_target_changed' });
    }
    auditLogDb.record('update_activation_reconfirmed', { userId: req.user.id, metadata: { jobId: req.params.jobId, targetDigest } });
    return res.status(202).json({ success: true, state: 'restart_queued' });
});

let releaseDiscovery = null;
let inspectActionServerCandidate = inspectServerActivationCandidate;

function inspectButtonBoundServerCandidate(buildId, requestId = null) {
    const candidate = inspectActionServerCandidate(buildId);
    if (['oid', 'oid-pair'].includes(candidate?.activationKind)) {
        return { allowed: false, code: 'node_update_button_required', activationKind: candidate.activationKind };
    }
    return inspectLegacyRestartDisposition(buildId, requestId);
}

let hostCapabilitySnapshot = null;
function getReleaseDiscovery() {
    // The banner mirrors the host's actual update strategy (ADR-141, T-1569): a
    // git-checkout-v2 host discovers from git tags via its own credentials (so a
    // private release source resolves), while an artifact host keeps the
    // asset-required GitHub API discovery.
    if (!releaseDiscovery) {
        if (!hostCapabilitySnapshot) hostCapabilitySnapshot = resolveUpdateHostCapability({ appRoot: APP_ROOT });
        releaseDiscovery = hostCapabilitySnapshot.jobStrategy === 'git-checkout-v2'
            ? createGitTagReleaseDiscovery({ appRoot: APP_ROOT })
            : createReleaseDiscovery();
    }
    return releaseDiscovery;
}

/** Test seam for the router contract; production startup never calls it. */
export function setReleaseDiscoveryForTests(discovery) {
    releaseDiscovery = discovery;
}

/** Test seam for route-level OID/legacy dispatch; production never replaces it. */
export function setServerCandidateInspectorForTests(inspector) {
    inspectActionServerCandidate = inspector || inspectServerActivationCandidate;
}

let planSourceActivation = planSourceManifest;
/** Test seam for the pre-gate source plan (H1); production never replaces it. */
export function setSourcePlannerForTests(planner) {
    planSourceActivation = planner || planSourceManifest;
}

// ── Server-action queue wiring (ADR-066, T-944) ─────────────────────────────
// The executable argv for every action is resolved from the in-code allowlist
// (server/services/server-actions.js) — never from a request or the DB. Only
// diagnostic/log paths are derived here.
//
// Data directory that holds the live sqlite db. Derived from DATABASE_PATH when
// set, else the well-known nassaj-dev data dir.
const DATA_DIR = process.env.DATABASE_PATH
    ? path.dirname(process.env.DATABASE_PATH)
    : path.join(os.homedir(), '.local', 'share', 'nassaj-dev');
// The live SQLite database and where the pre-update snapshot is staged. The
// path is resolved through the same shared helper load-env.js uses, so the
// snapshot always targets the real database — not a stale server/database/auth.db
// guess. The snapshot must share the database device (VACUUM INTO is
// same-filesystem) and stay off tmpfs, so it lives beside the database, not
// under .git (ADR-141, T-1552).
const LIVE_DATABASE_PATH = resolveDatabaseFilePath();
const DATABASE_SNAPSHOT_ROOT = path.join(path.dirname(LIVE_DATABASE_PATH), 'nassaj-update-db-snapshots');
// Detached --exec output is captured here (not discarded) so a failed restart
// is diagnosable after the fact.
const RESTART_LOG_PATH = path.join(DATA_DIR, 'last-restart.log');
const SOURCE_UPDATE_ACTION_SCHEMA = 'nassaj-source-update-activation/v1';
const SOURCE_UPDATE_TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SOURCE_UPDATE_SHA40 = /^[a-f0-9]{40}$/;
const SOURCE_UPDATE_SHA256 = /^[a-f0-9]{64}$/;
const UPDATE_CONTROL_ROOT = typeof process.env.NASSAJ_UPDATE_CONTROL_ROOT === 'string'
    && process.env.NASSAJ_UPDATE_CONTROL_ROOT
    ? path.resolve(process.env.NASSAJ_UPDATE_CONTROL_ROOT)
    : null;
const UPDATE_CAPABILITY_FILE = typeof process.env.NASSAJ_UPDATE_CAPABILITY_FILE === 'string'
    && process.env.NASSAJ_UPDATE_CAPABILITY_FILE
    ? path.resolve(process.env.NASSAJ_UPDATE_CAPABILITY_FILE)
    : UPDATE_CONTROL_ROOT ? path.join(UPDATE_CONTROL_ROOT, 'UPDATE_RUNTIME_CAPABILITY.json') : null;

function readCanonicalSourceUpdateAction(file, candidateRoot, expectedServerBuildId) {
    const canonicalFile = path.join(candidateRoot, 'activation-action.json');
    if (path.resolve(file) !== canonicalFile) throw new Error('source_update_action_not_canonical');
    const candidateMetadata = fs.lstatSync(candidateRoot);
    if (!candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink()
        || fs.realpathSync(candidateRoot) !== candidateRoot) {
        throw new Error('source_update_candidate_unsafe');
    }
    const metadata = fs.lstatSync(canonicalFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600
        || metadata.size > 16 * 1024
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error('source_update_action_unsafe');
    }
    const action = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
    const keys = Object.keys(action || {}).sort().join(',');
    const expectedKeys = [
        'expectedServerBuildId', 'manifestPath', 'manifestSha256', 'originalHead',
        'schema', 'targetCommit', 'transactionId', 'version',
    ].sort().join(',');
    const expectedManifest = path.join(candidateRoot, 'candidate-manifest.json');
    if (action?.expectedServerBuildId !== expectedServerBuildId) return null;
    if (keys !== expectedKeys || action?.schema !== SOURCE_UPDATE_ACTION_SCHEMA
        || !SOURCE_UPDATE_TX.test(action.transactionId || '')
        || action.transactionId !== path.basename(candidateRoot)
        || !SOURCE_UPDATE_SHA40.test(action.originalHead || '')
        || !SOURCE_UPDATE_SHA40.test(action.targetCommit || '')
        || typeof action.version !== 'string'
        || path.resolve(action.manifestPath || '') !== expectedManifest
        || !SOURCE_UPDATE_SHA256.test(action.manifestSha256 || '')) {
        throw new Error('source_update_action_invalid');
    }
    return Object.freeze({ ...action, candidateRoot, manifestPath: expectedManifest });
}

/** Refuse a local-recovery activation if its prepared server process has since changed. */
export function assertLocalSourceActivationProcessBinding(action, injected = {}) {
    const bytes = fs.readFileSync(action.manifestPath), manifest = JSON.parse(bytes);
    const binding = manifest.operationBinding;
    if (!binding) return null;
    const root = fs.realpathSync(path.resolve(binding.root || ''));
    const runtime = binding.previousRuntime;
    const pid = injected.pid ?? process.pid;
    const statText = (injected.readProcessStat || ((value) => fs.readFileSync(`/proc/${value}/stat`, 'utf8')))(pid);
    const startTicks = statText.slice(statText.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    const cwd = injected.processCwd ?? fs.realpathSync(`/proc/${pid}/cwd`);
    const uid = injected.processUid ?? fs.statSync(`/proc/${pid}`).uid;
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== action.manifestSha256
        || binding.schema !== 'nassaj-local-source-recovery-operation/v1'
        || binding.nodeIdentity !== os.hostname() || uid !== process.getuid()
        || binding.transactionId !== action.transactionId || manifest.txId !== action.transactionId
        || path.dirname(action.candidateRoot) !== path.join(root, '.git/nassaj-source-update/candidates')
        || runtime?.pid !== pid || runtime.startTicks !== startTicks || cwd !== root) {
        throw new Error('local_recovery_activation_process_changed');
    }
    const controlBytes = fs.readFileSync(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'));
    const server = JSON.parse(fs.readFileSync(path.join(root, 'dist-server/BUILD_PROVENANCE.json'), 'utf8'));
    const client = JSON.parse(fs.readFileSync(path.join(root, 'dist/BUILD_PROVENANCE.json'), 'utf8'));
    if (crypto.createHash('sha256').update(controlBytes).digest('hex') !== runtime.controlManifestSha256
        || server.commit !== runtime.oid || server.buildId !== runtime.serverBuildId
        || client.buildId !== runtime.clientBuildId
        || Object.entries({ client: 'dist', server: 'dist-server', nodeModules: 'node_modules' })
            .some(([name, directory]) => JSON.stringify(hashTree(path.join(root, directory))) !== JSON.stringify(runtime.actualTrees?.[name]))) {
        throw new Error('local_recovery_activation_runtime_changed');
    }
    return Object.freeze({ pid, startTicks, root });
}

/** Resolve a build-bound source update only through its canonical mode-0600 action. */
export function findSourceUpdateActivation(row, projectRoot = APP_ROOT) {
    const expectedServerBuildId = row?.expectedServerBuildId;
    if (!SOURCE_UPDATE_SHA256.test(expectedServerBuildId || '')) return null;
    // v2 source updates are never discovered by scanning attacker-influenced
    // directories. The pending action must carry the complete DB-bound identity.
    if (!row?.sourceUpdateJobId || !SOURCE_UPDATE_TX.test(row?.sourceUpdateTransactionId || '')
        || !SOURCE_UPDATE_SHA256.test(row?.activationIdentitySha256 || '')
        || !SOURCE_UPDATE_SHA40.test(row?.releaseCommit || '')) return null;
    const job = sourceUpdateJobsDb.getByTransactionId(row.sourceUpdateTransactionId);
    if (!job || job.id !== row.sourceUpdateJobId
        || job.transaction_id !== row.sourceUpdateTransactionId
        || job.expected_server_build_id !== expectedServerBuildId
        || job.activation_identity_sha256 !== row.activationIdentitySha256
        || job.release_commit !== row.releaseCommit) return null;
    if (job.strategy === 'release-layout-v2') {
        try {
            if (!UPDATE_CONTROL_ROOT || !UPDATE_CAPABILITY_FILE) return null;
            const releaseLayout = requireReleaseLayout({
                deployRoot: process.env.NASSAJ_DEPLOY_ROOT,
                projectRoot,
                artifactRoot: path.join(projectRoot, 'dist-server'),
                controlRoot: UPDATE_CONTROL_ROOT,
                capabilityFile: UPDATE_CAPABILITY_FILE,
                nodeInstanceId: process.env.NASSAJ_NODE_INSTANCE_ID,
            });
            const action = readReleaseActivationAction({ layout: releaseLayout, jobId: job.id });
            if (action.generationId !== row.sourceUpdateTransactionId
                || action.activationIdentitySha256 !== row.activationIdentitySha256
                || action.serverBuildId !== expectedServerBuildId
                || action.commit !== row.releaseCommit) return null;
            return { action, releaseLayout, strategy: 'release-layout-v2' };
        } catch { return null; }
    }
    const maintenance = createUpdateMaintenanceGate({ projectPath: projectRoot });
    const candidatesRoot = path.join(maintenance.paths.controlRoot, 'candidates');
    const candidateRoot = path.join(candidatesRoot, row.sourceUpdateTransactionId);
    const actionFile = path.join(candidateRoot, 'activation-action.json');
    if (!fs.existsSync(actionFile)) return null;
    const raw = fs.readFileSync(actionFile);
    if (crypto.createHash('sha256').update(raw.toString('utf8').trim()).digest('hex') !== row.activationIdentitySha256) return null;
    const action = readCanonicalSourceUpdateAction(actionFile, candidateRoot, expectedServerBuildId);
    return action && action.targetCommit === row.releaseCommit ? { action, maintenance } : null;
}

/**
 * Close the update gate, CAS-apply source, atomically promote all runtime
 * generations, and write the bootstrap handoff consumed by the replacement.
 */
export async function executeSourceUpdateActivation(row, resolved) {
    assertLegacyTransitionAllowed();
    if (resolved === undefined) resolved = findSourceUpdateActivation(row);
    if (!resolved) throw new Error('source_update_action_missing');
    const { action, maintenance } = resolved;
    const activationJobIdentity = {
        jobId: row.sourceUpdateJobId,
        transactionId: row.sourceUpdateTransactionId,
        activationIdentitySha256: row.activationIdentitySha256,
    };
    if (resolved.strategy !== 'release-layout-v2') assertLocalSourceActivationProcessBinding(action);
    // Activation transitions (rollback_pending/rolled_back/manual_recovery_required)
    // go through transitionActivation, which writes no error_code — so an
    // activation failure would surface a null cause in the job snapshot
    // (qa-critic [critical-2], T-1750). Record the reason + the phase the job
    // was in when it failed as a hash-chained receipt (appendActivationReceipt
    // pattern); the GET snapshot derives failedPhase/errorCode from it.
    let activationJobPhase = null;
    // ADR-156 ت-3 / qa-critic M3: every activation receipt names who acted. A
    // rollback is the updater repairing itself (automatic); a recovery receipt
    // here marks a state only a person can clear (human); a refusal before the
    // gate closed repaired nothing and is neither (null).
    const recordActivationFailure = (code, kind = 'rollback', intervention = kind === 'recovery' ? 'human' : 'automatic') => {
        if (!activationJobPhase) return;
        try {
            sourceUpdateJobsDb.appendActivationReceipt(
                activationJobIdentity, activationJobPhase, kind,
                { code: String(code || 'source_update_activation_failed'), failedPhase: activationJobPhase, intervention },
            );
        } catch { /* best-effort: the snapshot still falls back to the last receipt phase */ }
    };
    const activationErrorCode = (error) =>
        (typeof error?.code === 'string' && error.code) ? error.code
            : (typeof error?.message === 'string' && error.message ? error.message : 'source_update_activation_failed');
    let artifactUpdate = null;
    if (resolved.strategy === 'release-layout-v2') {
        const projectPath = resolved.releaseLayout.current.path;
        const prior = JSON.parse(fs.readFileSync(path.join(projectPath,'RELEASE_ASSET_MANIFEST.json'),'utf8'));
        artifactUpdate = await createUpdateMaintenanceGate({projectPath}).beginUpdate({
            transactionId:action.generationId,originalHead:prior.commit,targetCommit:action.commit,expectedVersion:action.version,
            artifact:{jobId:action.jobId,activationIdentitySha256:action.activationIdentitySha256,nodeInstanceId:process.env.NASSAJ_NODE_INSTANCE_ID},
        });
    }
    if (!sourceUpdateJobsDb.transitionActivation(activationJobIdentity, ['restart_queued'], 'activating')) {
        artifactUpdate?.completeRollback();
        throw new Error('source_update_activation_job_not_claimable');
    }
    activationJobPhase = 'activating';
    if (resolved.strategy === 'release-layout-v2') {
        const checkpoint = async (phase, kind, facts = {}) => {
            sourceUpdateJobsDb.appendActivationReceipt(activationJobIdentity, phase, kind, facts);
        };
        const assertFence = async () => {
            const current = sourceUpdateJobsDb.getByTransactionId(row.sourceUpdateTransactionId);
            if (!current || current.id !== row.sourceUpdateJobId
                || current.activation_identity_sha256 !== row.activationIdentitySha256
                || !['activating', 'runtime_verifying', 'rollback_pending'].includes(current.state)) {
                throw new Error('source_update_activation_job_fenced');
            }
        };
        const context = { assertFence, checkpoint };
        let capabilityResult;
        let artifactHandedOff = false;
        try {
            artifactUpdate.captureArtifactSnapshot();
            artifactUpdate.transition(['PREPARED'],'ARTIFACT_ACTIVATING');
            await activateReleaseGeneration({ layout: resolved.releaseLayout, action, context });
            const activatedProjectRoot = path.join(resolved.releaseLayout.releasesRoot, action.generationId);
            capabilityResult = reconcileActivatedHostCapability({
                deployRoot: resolved.releaseLayout.deployRoot,
                artifactRoot: path.join(activatedProjectRoot, 'dist-server'),
                projectRoot: activatedProjectRoot,
                controlRoot: resolved.releaseLayout.controlRoot,
                capabilityFile: UPDATE_CAPABILITY_FILE,
                nodeInstanceId: process.env.NASSAJ_NODE_INSTANCE_ID,
                action,
            });
            if (!sourceUpdateJobsDb.transitionActivation(activationJobIdentity, ['activating'], 'runtime_verifying')) {
                throw new Error('source_update_activation_job_fenced');
            }
            activationJobPhase = 'runtime_verifying';
            artifactUpdate.transition(['ARTIFACT_ACTIVATING'],'ARTIFACT_SWITCHED');
            const handoff = artifactUpdate.prepareBootstrapHandoff(['ARTIFACT_SWITCHED']);
            artifactHandedOff = true;
            const rollback = async (reason = 'runtime_verification_failed') => {
                if (artifactHandedOff) {
                    recordActivationFailure('artifact_post_handoff_outcome_unknown', 'recovery');
                    artifactUpdate.declareManual('artifact_post_handoff_outcome_unknown');
                    throw new Error('artifact_post_handoff_recovery_required');
                }
                recordActivationFailure(reason, 'rollback');
                sourceUpdateJobsDb.transitionActivation(
                    activationJobIdentity, ['activating', 'runtime_verifying'], 'rollback_pending',
                );
                await rollbackReleaseGeneration({ layout: resolved.releaseLayout, action, context });
                restoreHostCapability({
                    capabilityFile: UPDATE_CAPABILITY_FILE,
                    rollbackSnapshot: capabilityResult.rollbackSnapshot,
                    action,
                });
                if (!sourceUpdateJobsDb.transitionActivation(activationJobIdentity, ['rollback_pending'], 'rolled_back')) {
                    throw new Error('source_update_rollback_job_fenced');
                }
                artifactUpdate.completeRollback();
                return true;
            };
            return Object.freeze({ action, update:artifactUpdate, handoff, rollback, releaseLayout: resolved.releaseLayout });
        } catch (error) {
            try {
                recordActivationFailure(activationErrorCode(error), 'rollback');
                sourceUpdateJobsDb.transitionActivation(
                    activationJobIdentity, ['activating', 'runtime_verifying'], 'rollback_pending',
                );
                await rollbackReleaseGeneration({ layout: resolved.releaseLayout, action, context });
                if (typeof capabilityResult !== 'undefined') {
                    restoreHostCapability({
                        capabilityFile: UPDATE_CAPABILITY_FILE,
                        rollbackSnapshot: capabilityResult.rollbackSnapshot,
                        action,
                    });
                }
                if (!sourceUpdateJobsDb.transitionActivation(activationJobIdentity, ['rollback_pending'], 'rolled_back')) {
                    throw new Error('source_update_rollback_job_fenced');
                }
                artifactUpdate.completeRollback();
            } catch (rollbackError) {
                recordActivationFailure('artifact_activation_recovery_failed', 'recovery');
                artifactUpdate.declareManual('artifact_activation_recovery_failed');
                console.error('[system] release-layout rollback failed:', rollbackError.message);
                sourceUpdateJobsDb.transitionActivation(activationJobIdentity, [
                    'activating', 'runtime_verifying', 'rollback_pending',
                ], 'manual_recovery_required');
            }
            throw error;
        }
    }
    const projectRoot = maintenance.paths.root;
    const identity = {
        transactionId: action.transactionId,
        originalHead: action.originalHead,
        targetCommit: action.targetCommit,
        expectedVersion: action.version,
        manifestSha256: action.manifestSha256,
    };
    let update = null;
    let validation = null;
    let phase = 'PREPARED';
    let sourceApplied = false;
    let generationsExchanged = false;
    const transition = (next) => {
        update.transition([phase], next);
        phase = next;
    };
    const rollback = (reason = 'runtime_verification_failed') => {
        if (phase === 'RESTARTING_HANDOFF') {
            recordActivationFailure('update_database_state_unknown', 'recovery');
            // B-1127: past the handoff only a person can decide (ADR-143), so the
            // job ends manual HERE, not in rollback_pending until the next boot.
            sourceUpdateJobsDb.transitionActivation(activationJobIdentity,
                ['activating', 'runtime_verifying', 'rollback_pending'], 'manual_recovery_required');
            update.declareManual('update_database_state_unknown');
            throw new Error('update_database_state_unknown');
        }
        recordActivationFailure(reason, 'rollback');
        sourceUpdateJobsDb.transitionActivation(activationJobIdentity, ['activating', 'runtime_verifying'], 'rollback_pending');
        update.transition([phase], 'ROLLBACK_PREPARED');
        phase = 'ROLLBACK_PREPARED';
        let rollbackError = null;
        if (generationsExchanged && validation) {
            try { rollbackGenerations(validation); } catch (error) { rollbackError = error; }
        }
        transition('ROLLBACK_SOURCE_APPLYING');
        if (sourceApplied) {
            try {
                rollbackSourceManifest({
                    projectRoot,
                    originalHead: action.originalHead,
                    targetCommit: action.targetCommit,
                });
            } catch (error) { rollbackError ||= error; }
        }
        transition('ROLLBACK_SOURCE_APPLIED');
        // Before handoff, preserve all live user writes; never replace SQLite.
        if (rollbackError) {
            // H1: never leave the gate closed under this still-living owner — that
            // held the site at 503 until a restart. Take the ب.5 exit in-process:
            // reopen on the previous generation (degraded, with its exit path, when
            // the source stayed at target) or MANUAL with no owner recorded.
            const outcome = update.reopenOrDeclareManual(rollbackError);
            const clean = outcome.state === 'OPEN' && !outcome.degraded;
            recordActivationFailure(outcome.degraded ? 'update_source_state_degraded'
                : (outcome.reason || activationErrorCode(rollbackError)), 'recovery', clean ? 'automatic' : 'human');
            sourceUpdateJobsDb.transitionActivation(activationJobIdentity, ['rollback_pending'],
                clean ? 'rolled_back' : 'manual_recovery_required');
            if (clean) return true;
            throw rollbackError;
        }
        update.completeRollback({ rollbackReason: 'activation_failed' });
        sourceUpdateJobsDb.transitionActivation(activationJobIdentity, ['rollback_pending'], 'rolled_back');
        return true;
    };
    try {
        // H1: the write-free plan prepare ran, re-run on the tree as it is NOW,
        // before the gate closes. A conflict found here costs a failed job, not
        // a closed gate with a half-applied source tree.
        planSourceActivation({ projectRoot, originalHead: action.originalHead, targetCommit: action.targetCommit });
        update = await maintenance.beginUpdate(identity);
        validation = validateCandidate({
            projectRoot,
            candidateRoot: action.candidateRoot,
            transactionId: action.transactionId,
            releaseCommit: action.targetCommit,
            version: action.version,
            manifestPath: action.manifestPath,
            manifestSha256: action.manifestSha256,
        });
        transition('SOURCE_APPLYING');
        // Only a write that actually began needs a source rollback. A refusal
        // by the plan inside apply leaves the tree untouched, and rolling THAT
        // back would fail its own CAS and strand the gate (H1).
        applySourceManifest({
            projectRoot,
            originalHead: action.originalHead,
            targetCommit: action.targetCommit,
            beforeWrite: () => { sourceApplied = true; },
        });
        transition('SOURCE_APPLIED');
        transition('INSTALLING');
        // Verified pre-update database snapshot before the generations are
        // exchanged (ADR-141, T-1552): a VACUUM INTO copy on the database device
        // (never tmpfs), with the live schema digest recorded as the rollback
        // boundary. A missing database fails closed and requires operator review.
        captureDatabaseSnapshot({
            databasePath: LIVE_DATABASE_PATH,
            snapshotRoot: DATABASE_SNAPSHOT_ROOT,
            transactionId: action.transactionId,
            targetCommit: action.targetCommit,
        });
        generationsExchanged = true;
        // Promote the client bundle in the same atomic transaction (ADR-141,
        // T-1551): the candidate builds and attests clientBuildId, and
        // verifyRuntimeIdentities checks the live client tree, so omitting it
        // left the served UI on the old version and the receipt state at
        // server_exchanged instead of exchanged.
        exchangeGenerations(validation, { names: ['nodeModules', 'server', 'client'] });
        verifyRuntimeIdentities(validation);
        transition('VERIFIED');
        transition('ACTIVATION_QUEUED');
        if (!sourceUpdateJobsDb.transitionActivation(activationJobIdentity, ['activating'], 'runtime_verifying')) {
            throw new Error('source_update_activation_job_fenced');
        }
        activationJobPhase = 'runtime_verifying';
        let handoff;
        try {
            handoff = update.prepareBootstrapHandoff(['ACTIVATION_QUEUED']);
        } finally {
            // B-1126: the gate moves to RESTARTING_HANDOFF BEFORE it writes the
            // descriptor. If that write fails, rollback() must ask from where the
            // journal really is, or the gate refuses it (update_phase_invalid).
            phase = update.phase;
        }
        return Object.freeze({ action, update, validation, handoff, rollback });
    } catch (error) {
        if (!update) {
            // Pre-gate failure (qa-critic C2): beginUpdate refused — degraded
            // source state, a closed gate, a contended lock — so the gate never
            // closed for this transaction and nothing was written. The job ends
            // `failed` with the reason instead of sitting in `activating` forever.
            recordActivationFailure(activationErrorCode(error), 'rollback', null);
            sourceUpdateJobsDb.transitionActivation(activationJobIdentity, ['activating'], 'failed');
            throw error;
        }
        try { rollback(activationErrorCode(error)); } catch (rollbackError) {
            console.error('[system] source-update rollback failed:', rollbackError.message);
            // rollback() settles the gate and the job once it reaches its exit;
            // this CAS only catches a rollback that threw before getting there.
            if (sourceUpdateJobsDb.transitionActivation(activationJobIdentity, [
                'activating', 'runtime_verifying', 'rollback_pending',
            ], 'manual_recovery_required')) recordActivationFailure(activationErrorCode(rollbackError), 'recovery');
            // B-1126: releasing the leases alone left the journal UPDATING and
            // closed under this living owner. MANUAL with no owner instead; a
            // journal that already reached its exit refuses this by its own CAS.
            try { update.declareManual(activationErrorCode(rollbackError)); } catch { /* already settled */ }
            update.release();
        }
        throw error;
    }
}
/** The terminal state and receipt code for one stranded job, or null to leave it. */
function strandedActivationOutcome(job, gate) {
    const owned = typeof job.transaction_id === 'string' && gate.transactionId === job.transaction_id;
    if (gate.gateClosed) {
        // A closed gate still owns its transaction; only MANUAL is final.
        return owned && gate.state === 'MANUAL'
            ? { next: 'manual_recovery_required', code: 'source_update_manual_recovery_required' } : null;
    }
    if (owned && gate.degraded) return { next: 'manual_recovery_required', code: 'update_source_state_degraded' };
    if (owned && gate.phase === 'ACTIVE_VERIFIED') return null;
    return { next: job.state === 'rollback_pending' ? 'rolled_back' : 'failed', code: 'source_update_activation_interrupted' };
}

/** Resolve proof-only Git recovery without letting unreadable control state settle a job. */
function strandedRuntimeOutcome(job, { gate, runtime, projectRoot, controlRoot, jobs }) {
    const unresolved = { next: null, code: 'source_update_runtime_evidence_unresolved' };
    if (!runtime) return unresolved;
    try {
        return inspectGitRuntimeRecovery({ projectRoot,
            controlRoot: controlRoot || createUpdateMaintenanceGate({ projectPath: projectRoot }).paths.controlRoot,
            job, journal: gate, runtime, receipts: jobs.listReceipts?.(job.id) || [] });
    } catch { return unresolved; }
}

/**
 * Boot-time settlement of git-checkout jobs a crash left in `activating` or
 * `rollback_pending` (qa-critic C2). It runs once, after bootstrap settled the
 * gate and before any request can start an activation, so the gate record is
 * the authority: an open gate means that activation is not in effect. Every
 * settlement carries a receipt; nothing here touches the gate or the tree.
 */
export function reconcileStrandedActivationJobs({
    jobs = sourceUpdateJobsDb,
    readGate = () => createUpdateMaintenanceGate({ projectPath: APP_ROOT }).readRecoveryEvidence(),
    runtime = null,
    projectRoot = APP_ROOT,
    controlRoot = null,
} = {}) {
    const stranded = jobs.listStrandedActivations().filter((job) => job.strategy !== 'release-layout-v2');
    if (!stranded.length) return [];
    let gate;
    try { gate = readGate(); } catch (error) {
        return stranded.map((job) => ({ jobId: job.id, state: job.state, settled: false, error: 'maintenance_state_unavailable' }));
    }
    return stranded.map((job) => {
        const outcome = job.state === 'runtime_verifying' && !gate.gateClosed
            ? strandedRuntimeOutcome(job, { gate, runtime, projectRoot, controlRoot, jobs })
            : strandedActivationOutcome(job, gate);
        if (outcome && !outcome.next) return { jobId: job.id, state: job.state, settled: false, code: outcome.code };
        if (!outcome) return { jobId: job.id, state: job.state, settled: false };
        const identity = {
            jobId: job.id, transactionId: job.transaction_id, activationIdentitySha256: job.activation_identity_sha256,
        };
        try {
            jobs.appendActivationReceipt(identity, job.state, 'recovery', {
                code: outcome.code, failedPhase: job.state, gateState: gate.state, gatePhase: gate.phase ?? null,
                intervention: outcome.next === 'manual_recovery_required' ? 'human' : 'automatic',
                ...(outcome.runtimeIdentities ? { runtimeIdentities: outcome.runtimeIdentities } : {}),
            });
            const settled = jobs.transitionActivation(identity, [job.state], outcome.next);
            return { jobId: job.id, state: settled ? outcome.next : job.state, settled, code: outcome.code };
        } catch (error) {
            return { jobId: job.id, state: job.state, settled: false, error: String(error?.message || error).slice(0, 200) };
        }
    });
}

async function waitForActivationState(expectedServerBuildId, state, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const transaction = readActivationTransaction();
            if (transaction?.expectedServerBuildId === expectedServerBuildId
                && transaction.state === state) return true;
        } catch { return false; }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
}

const waitForActivationGuard = (expectedServerBuildId, timeoutMs = 5_000) =>
    waitForActivationState(expectedServerBuildId, 'guard_ready', timeoutMs);

function startActivationGuard(expectedServerBuildId, installed = false) {
    const candidateRoot = serverCandidateDirectory(APP_ROOT, expectedServerBuildId);
    const activatingRoot = serverActivatingDirectory(APP_ROOT, expectedServerBuildId);
    const artifactRoot = installed
        ? path.join(APP_ROOT, 'dist-server')
        : fs.existsSync(candidateRoot) ? candidateRoot : activatingRoot;
    const guard = path.join(artifactRoot, 'scripts', 'local-preview-server-activation.mjs');
    const child = spawn(process.execPath, [guard, '--guard'], {
        cwd: APP_ROOT,
        detached: true,
        stdio: 'ignore',
    });
    child.on('error', () => {}); // waitForActivationGuard reports the fail-closed outcome
    child.unref();
}

// Crash-resume: the transaction is the durable authority. A replacement server
// restarts the fixed guard for any non-terminal apply/rollback state; flock
// guarantees that a surviving predecessor guard and this one cannot both act.
setImmediate(() => {
    try {
        const transaction = readActivationTransaction();
        if (transaction && ['install_authorized', 'candidate_installed', 'restart_spawned', 'awaiting_readiness', 'rolling_back',
            'rollback_restart_pending', 'rollback_deferred'].includes(transaction.state)) {
            startActivationGuard(
                transaction.expectedServerBuildId,
                transaction.state !== 'install_authorized',
            );
        }
    } catch (error) {
        console.error('[system] activation transaction resume blocked:', error.message);
    }
});

// Hard cap on a read-only pre-flight gate. The gate shells out to
// safe-restart.sh, which walks /proc and reads pm2 jlist — normally < 2s. A hung
// gate (a wedged pm2 daemon, an unresponsive /proc walk) used to hang the HTTP
// request FOREVER: no timeout existed, so `restartInFlight` stayed set and the
// CAS-claimed row never returned to 'pending' — a dead action row plus a wedged
// endpoint until a manual restart (B-198). 30s is ~15x the normal runtime.
const ACTION_GATE_TIMEOUT_MS = 30_000;

/**
 * Runs an action's read-only pre-flight GATE with a FIXED argv (no shell, no
 * caller input) and waits for it. Resolves with { code, stdout }. The gate never
 * mutates anything, it only reports whether the action is safe to run. For
 * safe-restart the exit codes are: 0=safe, 3=live work (defer), 6=live
 * interactive sessions (defer), 2=read/config error, 4=not in PM2.
 *
 * A timeout resolves as code 2 (read/config error) — the SAME fail-closed
 * outcome the spawn-failure path already used, so a hung gate can never be
 * mistaken for "safe to proceed". The gate process is killed by process GROUP
 * (detached:true) so a stuck child of the gate script cannot survive it.
 */
function runActionGate(action) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(action.cmd, [...action.gateArgs], {
                cwd: action.cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true,
            });
        } catch {
            resolve({ code: 2, stdout: '' });
            return;
        }
        let stdout = '';
        let settled = false;
        const finish = (outcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
        };
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        // Drain stderr so the pipe buffer can't fill and stall the child.
        child.stderr.on('data', () => {});
        const timer = setTimeout(() => {
            killProcessTree(child);
            console.error('[system] action gate timed out; treating as gate error');
            finish({ code: 2, stdout: '' });
        }, ACTION_GATE_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        child.on('error', () => finish({ code: 2, stdout: '' }));
        child.on('close', (code) => finish({ code: code ?? 2, stdout }));
    });
}

/**
 * Parses safe-restart.sh --json gate stdout into the session fields the client
 * needs. Never throws; a malformed or absent payload yields nulls/empties so a
 * bad parse fail-safes to a bare deferral. Shared by the code-6 deferral and the
 * force-restart two-step confirm (T-1677) so the parsing lives in ONE place.
 * NOTE: `liveSessions` is the RAW gate array — callers apply attachSessionTitles
 * (which needs req.user) themselves; nothing here is ever used to build a command.
 * @param {string} stdout
 * @returns {{ sessionCount: number|null, liveSessions: Array,
 *             sessionServerPid: number|null, liveCount: number|null }}
 */
function parseGateSessions(stdout) {
    const out = { sessionCount: null, liveSessions: [], sessionServerPid: null, liveCount: null };
    try {
        const parsed = JSON.parse(stdout);
        if (parsed && typeof parsed.sessionCount === 'number') out.sessionCount = parsed.sessionCount;
        if (parsed && Array.isArray(parsed.liveSessions)) out.liveSessions = parsed.liveSessions;
        if (parsed && (typeof parsed.sessionServerPid === 'number' || parsed.sessionServerPid === null)) {
            out.sessionServerPid = parsed.sessionServerPid;
        }
        if (parsed && typeof parsed.liveCount === 'number') out.liveCount = parsed.liveCount;
    } catch {
        // keep defaults — a bad payload fail-safes to a bare deferral
    }
    return out;
}

/**
 * SIGKILLs a spawned child and every process it started, by killing its process
 * GROUP. Only correct for children spawned with `detached: true` (which makes
 * the child a group leader whose pgid === its pid); for those, `kill(-pid)`
 * reaches grandchildren that a plain `child.kill()` would leave running —
 * `nohup x &` / `sleep 9999 &` inside a raw command are exactly that case.
 *
 * Falls back to a direct child.kill() if the group kill fails (e.g. ESRCH
 * because the child already exited, or a platform without process groups), and
 * never throws: it is called from timeout handlers where throwing would skip the
 * HTTP response. Exported for tests.
 * @returns {boolean} true when a kill signal was delivered to the group.
 */
export function killProcessTree(child) {
    const pid = child?.pid;
    if (typeof pid === 'number' && pid > 0) {
        try {
            process.kill(-pid, 'SIGKILL');
            return true;
        } catch {
            // Group gone / not a group leader → fall through to the direct kill.
        }
    }
    try {
        child?.kill?.('SIGKILL');
    } catch {
        // already gone
    }
    return false;
}

/** Fan a 'pending-actions-updated' signal out to every connected WS client. */
function broadcastPendingActionsUpdated(req) {
    const wss = req.app?.locals?.wss;
    if (!wss) {
        return;
    }
    const message = JSON.stringify({
        type: 'pending-actions-updated',
        timestamp: new Date().toISOString(),
    });
    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // WebSocket.OPEN
            try {
                client.send(message);
            } catch (error) {
                console.error('Error sending pending-actions update:', error.message);
            }
        }
    });
}

// In-flight guard: a single boolean is enough to reject a second concurrent
// execute while one is being processed (gate → exec). Released in a real
// `finally` (executeActionRow) so a failed attempt never wedges the endpoint.
// The per-IP rate limit + the DB CAS claim are the durable protection; this just
// blunts overlapping owner clicks.
let restartInFlight = false;

// Longest we keep `restartInFlight` set after launching a detached --exec that
// is EXPECTED to end this process. If the process is still alive after this, the
// restart did not happen (safe-restart re-checks for live sessions after the
// gate and can still defer with exit 3/6), so holding the flag would 409 every
// later attempt — including the very restart the owner needs. B-199.
const DETACHED_EXEC_FLAG_TTL_MS = 60_000;

/** Handle of the pending safety timer, so a later run can clear/replace it. */
let restartFlagSafetyTimer = null;

/**
 * Releases `restartInFlight` after DETACHED_EXEC_FLAG_TTL_MS unless this process
 * has already been replaced by the restart. `.unref()` so a pending timer never
 * keeps the event loop (or a test runner) alive.
 */
function scheduleRestartFlagRelease(onRelease) {
    if (restartFlagSafetyTimer) clearTimeout(restartFlagSafetyTimer);
    restartFlagSafetyTimer = setTimeout(() => {
        restartFlagSafetyTimer = null;
        if (!restartInFlight) return;
        restartInFlight = false;
        console.error('[system] restart did not occur within the safety window; in-flight guard released');
        if (typeof onRelease === 'function') {
            try { onRelease(); } catch { /* recovery is best-effort */ }
        }
    }, DETACHED_EXEC_FLAG_TTL_MS);
    if (typeof restartFlagSafetyTimer.unref === 'function') restartFlagSafetyTimer.unref();
}

/**
 * Audit EVERY execution outcome (triggered | deferred | gate_failed |
 * not_in_pm2 | failed), not just the successful path, so an attempted action is
 * always traceable — who, when, which action, and the result. Reuses the
 * existing 'system_restart_triggered' audit action with a `result` discriminator
 * plus the actionType/id in metadata.
 */
function recordActionOutcome(req, row, result, extra = {}) {
    req.serverActionTraceId ||= row?.id || crypto.randomUUID();
    auditLogDb.record('system_restart_triggered', {
        userId: req.user?.id ?? null,
        metadata: {
            result, traceId: req.serverActionTraceId,
            actionType: row?.actionType ?? null,
            id: row?.id ?? null,
            sessionId: row?.sessionId ?? null,
            ...extra,
        },
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
    });
}

// Per-IP rate limit for the polled read endpoint (B-76). The widget polls every
// 5s per active instance (~12 req/min, up to ~24 with both footer + collapsed
// mounted), so 120 req/min/IP sits ~5-10x above legitimate use — ample headroom
// for several tabs behind one NAT/tunnel IP — while still blunting a runaway
// loop or a deliberate hammer. Reads are cheap, so this is a guard-rail, not a
// tight quota; the message stays generic (no internals leaked).
const statsLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 120,
    message: 'Too many requests, please slow down',
});

// Tight per-IP limit for the destructive restart trigger. A legitimate owner
// clicks this a handful of times at most; 5/min leaves room for a retry or two
// while hard-capping a hammered or scripted abuse of the endpoint.
const restartLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 5,
    message: 'Too many restart requests, please slow down',
});

// Per-IP limit for RECORDING a pending action. Any authenticated session may
// enqueue (recording is not executing), so this blunts a client that spams the
// queue; 10/min/IP is far above legitimate use (a coordinator records one action
// per intent) while still capping abuse. Dedup at the DB layer already collapses
// exact repeats, so this is a coarse guard-rail.
const pendingCreateLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    message: 'Too many requests, please slow down',
});

// Two CPU samples closer than this reuse the previously computed percent.
const MIN_SAMPLE_MS = 500;
// Two-point sampling window used only for the very first request.
const FIRST_SAMPLE_MS = 250;

// Module-level previous sample: { idle, total, at, percent }
let lastCpuSample = null;

/**
 * Parse the aggregate "cpu " line of /proc/stat into jiffy counters.
 * Returns { idle, total } where idle includes iowait.
 */
export function parseCpuLine(procStatText) {
    const line = procStatText.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) {
        return null;
    }
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 4 || fields.some(Number.isNaN)) {
        return null;
    }
    // user nice system idle iowait irq softirq steal [guest guest_nice]
    const idle = fields[3] + (fields[4] || 0);
    const total = fields.reduce((sum, v) => sum + v, 0);
    return { idle, total };
}

/**
 * Parse /proc/meminfo for MemTotal / MemAvailable (values are in kB).
 * Returns { totalBytes, availableBytes } or null when fields are missing.
 */
export function parseMeminfo(meminfoText) {
    const grab = (key) => {
        const match = meminfoText.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
        return match ? Number(match[1]) * 1024 : null;
    };
    const totalBytes = grab('MemTotal');
    const availableBytes = grab('MemAvailable');
    if (totalBytes === null || availableBytes === null) {
        return null;
    }
    return { totalBytes, availableBytes };
}

/**
 * Convert node:fs statfs counters to the public storage contract.
 * `bavail` is the space this (normally non-root) process can actually write;
 * reserved blocks therefore count as used/unavailable in all three fields.
 */
export function storageStatsFromStatfs(stat) {
    const toSafeInteger = (value) => {
        if (typeof value === 'bigint') {
            if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
            return Number(value);
        }
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    };
    const blockSize = toSafeInteger(stat?.bsize);
    const blocks = toSafeInteger(stat?.blocks);
    const availableBlocks = toSafeInteger(stat?.bavail);
    if (blockSize === null || blocks === null || availableBlocks === null
        || blockSize === 0 || blocks === 0 || availableBlocks > blocks) {
        return null;
    }
    const totalBytes = blockSize * blocks;
    const availableBytes = blockSize * availableBlocks;
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) {
        return null;
    }
    const usedBytes = totalBytes - availableBytes;
    return {
        usedBytes,
        totalBytes,
        percent: round1((usedBytes / totalBytes) * 100),
    };
}

let statfsReader = (target) => fsPromises.statfs(target);

/** Test seam: production uses node:fs directly; null restores that default. */
export function setStatfsReaderForTests(reader) {
    statfsReader = reader || ((target) => fsPromises.statfs(target));
}

/** Busy percent from two jiffy samples; clamped to [0, 100]. */
export function cpuPercentFromSamples(prev, cur) {
    const dTotal = cur.total - prev.total;
    const dIdle = cur.idle - prev.idle;
    if (dTotal <= 0) {
        return null;
    }
    const percent = ((dTotal - dIdle) / dTotal) * 100;
    return Math.min(100, Math.max(0, percent));
}

/** Round to 1 decimal place (memory percent contract). Exported for testing. */
export const round1 = (n) => Math.round(n * 10) / 10;
/** Round to 2 decimal places (CPU percent contract, b4956ea). Exported for testing. */
export const round2 = (n) => Math.round(n * 100) / 100;

async function readCpuSample() {
    const text = await fsPromises.readFile('/proc/stat', 'utf8');
    return parseCpuLine(text);
}

async function getCpuPercent() {
    try {
        const now = Date.now();
        const cur = await readCpuSample();
        if (!cur) {
            throw new Error('unparseable /proc/stat');
        }

        if (!lastCpuSample) {
            // First request: take a short two-point sample for an accurate value.
            await new Promise((resolve) => setTimeout(resolve, FIRST_SAMPLE_MS));
            const next = await readCpuSample();
            const percent = (next && cpuPercentFromSamples(cur, next)) ?? 0;
            lastCpuSample = { ...(next || cur), at: Date.now(), percent };
            return percent;
        }

        if (now - lastCpuSample.at < MIN_SAMPLE_MS) {
            return lastCpuSample.percent;
        }

        const percent = cpuPercentFromSamples(lastCpuSample, cur) ?? lastCpuSample.percent;
        lastCpuSample = { ...cur, at: now, percent };
        return percent;
    } catch {
        // Non-Linux fallback: 1-minute loadavg normalised by core count.
        const cores = os.cpus().length || 1;
        return Math.min(100, Math.max(0, (os.loadavg()[0] / cores) * 100));
    }
}

async function getMemoryStats() {
    try {
        const text = await fsPromises.readFile('/proc/meminfo', 'utf8');
        const parsed = parseMeminfo(text);
        if (parsed) {
            const usedBytes = parsed.totalBytes - parsed.availableBytes;
            return {
                usedBytes,
                totalBytes: parsed.totalBytes,
                percent: round1((usedBytes / parsed.totalBytes) * 100),
            };
        }
    } catch {
        // fall through to the os fallback
    }
    const totalBytes = os.totalmem();
    const usedBytes = totalBytes - os.freemem();
    return {
        usedBytes,
        totalBytes,
        percent: round1((usedBytes / totalBytes) * 100),
    };
}

async function getStorageStats() {
    try {
        const stat = await statfsReader(process.cwd());
        return storageStatsFromStatfs(stat);
    } catch {
        return null;
    }
}

// GET /api/system/release/latest — authenticated, server-side discovery from
// the governed OSS repository. No repository credential or raw upstream
// payload crosses this boundary.
router.get('/release/latest', statsLimiter, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Authorization');
    try {
        const result = await getReleaseDiscovery()();
        const { htmlUrl: _repositoryUrl, ...release } = result.release;
        return res.json({ success: true, ...release });
    } catch (error) {
        const response = releaseErrorPayload(error);
        return res.status(response.status).json(response.body);
    }
});

// GET /api/system/stats — live CPU, memory, and app-filesystem utilisation.
router.get('/stats', statsLimiter, async (req, res) => {
    try {
        const [cpuPercent, memory, storage] = await Promise.all([
            getCpuPercent(),
            getMemoryStats(),
            getStorageStats(),
        ]);
        // ‏swap وأنظمة الملفات التي تعيش في الذاكرة: ما لم يكن يُقاس، فسقط
        // الجهاز 31 يوليو 2026 و/tmp يحمل 3.3GB منذ 45 ساعة بلا أن يظهر في أي
        // شاشة. الحقلان اختياريان في العقد — عميل أقدم يتجاهلهما.
        const host = getSystemResources();
        res.json({
            cpu: { percent: round2(cpuPercent) },
            memory,
            storage,
            swap: host.available
                ? { usedMb: host.swapUsedMb, totalMb: host.swapTotalMb }
                : null,
            tmpfs: host.available ? host.tmpfs : [],
            pressure: host.available ? host.pressure : null,
        });
    } catch (error) {
        console.error('[system] stats failed:', error.message);
        res.status(500).json({ error: 'Failed to read system stats' });
    }
});

// ── مَن يحمل الـswap؟ (T-1204) ───────────────────────────────────────────────
//
// جردٌ تشخيصي **قراءة محضة**: لا يقتل عملية ولا يرسل إشارة ولا يعيد تشغيل شيئاً.
//
// OWNER-ONLY, ‏لا admin: هذا جردُ عمليات المضيف لا إعدادُ تطبيق. يكشف بنيةً
// خارج نسّاج تماماً (خدمات أخرى على نفس الصندوق، مجلدات عملٍ غير مسجَّلة)، وهي
// خريطةُ سطحِ هجومٍ لا تخصّ إدارة التطبيق.
//
// ‏limiter مستقلّ عمداً: ‏`statsLimiter` دلوٌ **مشترك** بين `/stats`
// و`/tmpfs-policy` و`/pending`، فلوحةٌ عالقة في حلقة إعادة محاولة كانت ستستهلكه
// وتُطفئ الشريط الذي يُنذر بالضغط في اللحظة التي يُنذر فيها بالضبط.
const swapHoldersLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 20,
    message: 'Too many requests, please slow down',
});

/**
 * نسبة العملية إلى مشروع **من قاعدة البيانات لا من اسم المجلد**: أكثر من نصف
 * مجلدات `/home/example/Project` ليست مشاريع مسجَّلة، فاشتقاق الاسم من المسار
 * يخترع نسبةً ويسرّب تنظيم القرص معاً. غير المطابق يعود `null`، والمسار نفسه لا
 * يغادر الخادم أبداً.
 *
 * المطابقة على المسار نفسه أو على أعمق مشروعٍ يحتويه (عمليةٌ تعمل في مجلد
 * فرعي داخل المشروع تُنسب إليه) مع حدّ فاصل `/` كي لا يبتلع `/a/proj` مسارَ
 * `/a/project-x`.
 */
function buildProjectResolver() {
    let rows = [];
    try {
        rows = projectsDb.getProjectPaths();
    } catch (error) {
        console.error('[system] project lookup for swap holders failed:', error.message);
        return () => null;
    }
    const entries = rows
        .map((row) => ({
            path: String(row.project_path || ''),
            name: (typeof row.custom_project_name === 'string' && row.custom_project_name.trim())
                ? row.custom_project_name.trim()
                : path.basename(String(row.project_path || '')),
        }))
        .filter((entry) => entry.path.length > 0)
        // الأطول أولاً: أعمق مشروع يحتوي المسار يفوز.
        .sort((a, b) => b.path.length - a.path.length);
    return (cwdPath) => {
        if (typeof cwdPath !== 'string' || !cwdPath) return null;
        for (const entry of entries) {
            if (cwdPath === entry.path || cwdPath.startsWith(`${entry.path}/`)) return entry.name;
        }
        return null;
    };
}

// GET /api/system/swap-holders — مَن يحمل الـswap الآن (owner فقط).
// بوابة الدور **قبل** المحدِّد: الدلو لكل IP، فلو سبقه المحدِّدُ لاستطاع غيرُ
// المالك أن يستهلك رصيد المالك ويردّه 429 من لوحته هو.
router.get('/swap-holders', requireRole('owner'), swapHoldersLimiter, (req, res) => {
    try {
        const snapshot = readSwapHolders({ limit: 8 });
        if (!snapshot.available) {
            // ‏200 بحمولة `{available:false}` وحدها: تعذُّر القراءة حالةٌ معروفة
            // تُعرض للمستخدم، لا عطلُ خادم.
            return res.json({ available: false });
        }
        const resolveProject = buildProjectResolver();
        const host = getSystemResources();
        return res.json({
            available: true,
            measuredAt: snapshot.measuredAt,
            swapUsedMb: snapshot.swapUsedMb,
            swapCachedMb: snapshot.swapCachedMb,
            // إعادةُ بناءٍ صريحة لكل صفّ: `cwdPath` يُستهلَك هنا ولا يُمرَّر —
            // نسخُ الكائن كما هو مع حذف حقلٍ يعيد تسريبه أوّلَ ما يُضاف حقل جديد.
            holders: snapshot.holders.map((h) => ({
                pid: h.pid,
                name: h.name,
                kind: h.kind,
                project: resolveProject(h.cwdPath),
                swapMb: h.swapMb,
                swapSource: h.swapSource,
                ageHours: h.ageHours,
            })),
            system: snapshot.system,
            unattributedMb: snapshot.unattributedMb,
            // ‏`/tmp` أكبر حاملٍ مرجَّح وغيرُ المنسوب أغلبه منه — عرضُ الجرد بلا
            // tmpfs يترك القارئ يبحث عن فاعلٍ بين العمليات وهو ليس فيها.
            tmpfs: host.available ? host.tmpfs : [],
        });
    } catch (error) {
        console.error('[system] swap holders read failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to read swap holders' });
    }
});

// ── سقف المسارات التي تعيش في الذاكرة (T-1138) ──────────────────────────────
//
// ‏`/tmp` و`/dev/shm` أنظمةُ ملفات في RAM. بلا `size=` يكون سقفها **نصف
// الذاكرة**، فيستطيع أمرٌ واحد أن يبتلع نصف الجهاز ولا يُستردّ إلا بحذفٍ أو
// إعادة إقلاع — وهو ما سبق أن حجز 2.7GB خمساً وأربعين ساعة.
//
// **حدٌّ صريح:** ‏`mount -o remount` يحتاج root، والخادم يعمل بحساب `nassaj`
// بلا sudo بلا كلمة سرّ (مقيس). فهذا المسار **لا يطبّق شيئاً**: يقرأ الواقع،
// ويحفظ المرغوب، ويُنتج الأمر الجاهز ليُنفّذه المالك. ادّعاءُ التطبيق هنا
// كذبةٌ على المستخدم، والفارق بين «الواقع» و«المرغوب» يُعرض صراحةً.
const TMPFS_POLICY_KEY = 'tmpfs_cap_mb';
const TMPFS_WATCHED = ['/tmp', '/dev/shm'];

function readTmpfsMountOptions() {
    const out = [];
    let raw = '';
    try {
        raw = fs.readFileSync('/proc/mounts', 'utf8');
    } catch {
        return out;
    }
    for (const line of raw.split('\n')) {
        const parts = line.split(/\s+/);
        if (parts[2] !== 'tmpfs' || !TMPFS_WATCHED.includes(parts[1])) continue;
        const sizeOpt = (parts[3] || '').split(',').find(o => o.startsWith('size='));
        let capMb = null;
        if (sizeOpt) {
            const m = sizeOpt.slice(5).match(/^(\d+)([kKmMgG]?)$/);
            if (m) {
                const n = Number(m[1]);
                const unit = m[2].toLowerCase();
                capMb = unit === 'g' ? n * 1024 : unit === 'm' ? n : unit === 'k' ? n / 1024 : n / 1048576;
            }
        }
        let usedMb = null;
        let totalMb = null;
        try {
            const st = fs.statfsSync(parts[1]);
            totalMb = Math.round((Number(st.blocks) * Number(st.bsize)) / 1048576);
            usedMb = Math.round(((Number(st.blocks) - Number(st.bfree)) * Number(st.bsize)) / 1048576);
        } catch {
            /* نقطة وصل اختفت */
        }
        out.push({
            mount: parts[1],
            hasExplicitCap: capMb !== null,
            capMb: capMb === null ? null : Math.round(capMb),
            totalMb,
            usedMb,
        });
    }
    return out;
}

const buildRemountCommand = capMb =>
    TMPFS_WATCHED.map(m => `sudo mount -o remount,size=${capMb}M ${m}`).join(' && ');

// GET /api/system/tmpfs-policy — الواقع والمرغوب والأمر الجاهز.
router.get('/tmpfs-policy', statsLimiter, (req, res) => {
    try {
        const stored = appConfigDb.get(TMPFS_POLICY_KEY);
        const desiredMb = stored === null ? null : Number(stored);
        res.json({
            mounts: readTmpfsMountOptions(),
            desiredMb: Number.isFinite(desiredMb) ? desiredMb : null,
            command: Number.isFinite(desiredMb) && desiredMb > 0 ? buildRemountCommand(desiredMb) : null,
            // الدوام عبر إعادة الإقلاع يحتاج سطر fstab — نقوله ولا نكتبه.
            fstabHint:
                Number.isFinite(desiredMb) && desiredMb > 0
                    ? `tmpfs /tmp tmpfs rw,nosuid,nodev,size=${desiredMb}M 0 0`
                    : null,
            appliesItself: false,
        });
    } catch (error) {
        console.error('[system] tmpfs-policy read failed:', error.message);
        res.status(500).json({ error: 'Failed to read tmpfs policy' });
    }
});

// PUT /api/system/tmpfs-policy — يحفظ المرغوب فقط (المالك/المشرف).
// ‏`requireRole` مطابقة صريحة لا هرمية: 'admin' وحدها كانت تحجب المالك بـ403.
router.put('/tmpfs-policy', requireRole('owner', 'admin'), (req, res) => {
    const raw = req.body?.desiredMb;
    if (raw === null) {
        appConfigDb.set(TMPFS_POLICY_KEY, '');
        return res.json({ desiredMb: null, command: null, appliesItself: false });
    }
    const desiredMb = Number(raw);
    // ‏128MB أدنى معقول (أقلّ منه يكسر أدوات البناء)، و8GB سقف الحماقة.
    if (!Number.isInteger(desiredMb) || desiredMb < 128 || desiredMb > 8192) {
        return res.status(400).json({ error: 'desiredMb must be an integer between 128 and 8192' });
    }
    try {
        appConfigDb.set(TMPFS_POLICY_KEY, String(desiredMb));
        auditLogDb.record('tmpfs_policy_set', { metadata: { desiredMb } });
    } catch (error) {
        console.error('[system] tmpfs-policy write failed:', error.message);
        return res.status(500).json({ error: 'Failed to store tmpfs policy' });
    }
    res.json({
        desiredMb,
        command: buildRemountCommand(desiredMb),
        fstabHint: `tmpfs /tmp tmpfs rw,nosuid,nodev,size=${desiredMb}M 0 0`,
        appliesItself: false,
    });
});

// ── سياسة التخزين: عمر المحادثة وحدود صورها (ADR-100 / T-1242) ─────────────
//
// ثلاث قيم يملكها المالك في مكان واحد، لأنها في ذهنه سؤال واحد: «كم أحتفظ،
// وبأي حجم؟».
//
//   retention_days   — عمر المحادثة قبل حذفها. يُطبَّق عبر `cleanupPeriodDays`
//                      في طبقة الحاكمية، أي بآلية Claude Code نفسها التي تحذف
//                      نصوصها وتترك watcher نسّاج يزيل صفوفها. لا نبني كانساً
//                      موازياً لما يكنسه المحرّك بنفسه.
//   image_max_mb     — سقف حجم الصورة الواحدة.
//   image_max_count  — سقف عدد الصور في الرسالة.
//
// القياس الذي فرض هذا (2026-08-04): `cleanupPeriodDays` **لم يكن مضبوطاً في أي
// طبقة**، فالسائد هو افتراض Claude (30 يوماً) لا الستّون التي كان المالك يظنّها
// سارية — صفر نصّ جلسة أقدم من 30 يوماً على القرص. القيمة صارت مقروءة ومكتوبة
// من هنا كي لا يبقى الاحتفاظ اعتقاداً بلا مصدر.
const STORAGE_POLICY_KEYS = {
    retentionDays: 'session_retention_days',
    imageMaxMb: 'chat_image_max_mb',
    imageMaxCount: 'chat_image_max_count',
};

/** الحدود: الأدنى يمنع الحماقة، والأعلى يمنع الوعد الذي لا يُوفى. */
const STORAGE_POLICY_BOUNDS = {
    retentionDays: { min: 7, max: 365, fallback: 30 },
    imageMaxMb: { min: 1, max: 25, fallback: 5 },
    imageMaxCount: { min: 1, max: 50, fallback: 15 },
};

function readStoragePolicy() {
    const out = {};
    for (const [field, key] of Object.entries(STORAGE_POLICY_KEYS)) {
        const stored = Number(appConfigDb.get(key));
        const bounds = STORAGE_POLICY_BOUNDS[field];
        out[field] = Number.isInteger(stored) && stored >= bounds.min && stored <= bounds.max
            ? stored
            : bounds.fallback;
        out[`${field}IsDefault`] = !(Number.isInteger(stored) && stored >= bounds.min && stored <= bounds.max);
    }
    return out;
}

// GET /api/system/storage-policy — القيم السارية + الواقع المقيس على القرص.
router.get('/storage-policy', statsLimiter, (req, res) => {
    try {
        res.json({ ...readStoragePolicy(), bounds: STORAGE_POLICY_BOUNDS });
    } catch (error) {
        console.error('[system] storage-policy read failed:', error.message);
        res.status(500).json({ error: 'Failed to read storage policy' });
    }
});

// PUT /api/system/storage-policy — المالك/المشرف. مطابقة صريحة لا هرمية.
router.put('/storage-policy', requireRole('owner', 'admin'), (req, res) => {
    const updates = {};
    for (const field of Object.keys(STORAGE_POLICY_KEYS)) {
        if (req.body?.[field] === undefined) continue;
        const value = Number(req.body[field]);
        const bounds = STORAGE_POLICY_BOUNDS[field];
        if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
            return res.status(400).json({
                error: `${field} must be an integer between ${bounds.min} and ${bounds.max}`,
            });
        }
        updates[field] = value;
    }
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No storage policy field supplied' });
    }

    try {
        for (const [field, value] of Object.entries(updates)) {
            appConfigDb.set(STORAGE_POLICY_KEYS[field], String(value));
        }
        // عمر المحادثة يُنفَّذ بمحرّك Claude نفسه لا بكانسٍ موازٍ: تُكتب القيمة
        // في إعدادات المشغّل فتنتقل إلى الطبقة المُدارة، ويحذف المحرّك نصوصه
        // بنفسه، ويزيل watcher نسّاج صفوفها عند اختفاء الملف.
        if (updates.retentionDays !== undefined) {
            const applied = setOperatorPolicyKey('cleanupPeriodDays', updates.retentionDays);
            if (!applied) {
                return res.status(500).json({ error: 'Failed to apply retention to the engine policy' });
            }
        }
        // تغيير عمر المحادثة فعلٌ يُتلف بيانات لاحقاً — يُسجَّل دائماً.
        auditLogDb.record('storage_policy_set', { metadata: updates });
    } catch (error) {
        console.error('[system] storage-policy write failed:', error.message);
        return res.status(500).json({ error: 'Failed to store storage policy' });
    }

    res.json({ ...readStoragePolicy(), bounds: STORAGE_POLICY_BOUNDS });
});

// ── Permission fences (T-1770 / B-953) ──────────────────────────────────────
// رفع حجب الصلاحيات قرار مالك: المالك وحده، بسبب مكتوب وإقرار صريح بأن الأثر
// الخارجي مجهول. النواة نفسها التي تستعملها scripts/permission-fence.mjs، فالنية
// تُسجَّل قبل الحذف. لا force من الواجهة: الإيجار المفتوح يُرفض هنا دائماً.
const fenceLiftLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    message: 'Too many requests, please slow down',
});

/** Maps a core refusal to a stable client code; anything unrecognised stays generic. */
function fenceLiftErrorCode(message) {
    if (/open leases or claims/.test(message)) return 'open_leases';
    if (/^no fence/.test(message)) return 'fence_not_found';
    if (/invalid (fence selector|lift arguments)|must be a positive integer/.test(message)) return 'invalid_request';
    return 'lift_failed';
}

// GET /api/system/permission-fences — المالك. بيانات تعريف فقط، بلا حمولات.
router.get('/permission-fences', statsLimiter, requireRole('owner'), (req, res) => {
    try {
        res.json(describeFences(getConnection()));
    } catch (error) {
        console.error('[system] permission-fences read failed:', error.message);
        res.status(500).json({ error: 'Failed to read permission fences' });
    }
});

// POST /api/system/permission-fences/lift — المالك. محدِّد دقيق + سبب + إقرار.
router.post('/permission-fences/lift', fenceLiftLimiter, requireRole('owner'), (req, res) => {
    const { generation, scopeKind, scopeKey, reason, acknowledgeExternalEffects } = req.body ?? {};
    if (acknowledgeExternalEffects !== true) {
        return res.status(400).json({
            error: 'Explicit acknowledgement of unknown external effects is required',
            code: 'acknowledgement_required',
        });
    }
    const selector = scopeKind !== undefined || scopeKey !== undefined
        ? { scopeKind, scopeKey }
        : { generation: Number(generation) };
    const actor = `nassaj-user:${req.user?.id ?? 'unknown'}:${req.user?.username ?? 'unknown'}`;
    try {
        const result = liftFence(getConnection(), { ...selector, reason, force: false, forceExternal: true, actor });
        auditLogDb.record('permission_fence_lifted', {
            userId: req.user?.id ?? null,
            metadata: { operationId: result.operationId, ...selector, completionAuditRecorded: result.completionAuditRecorded },
        });
        res.json(result);
    } catch (error) {
        const code = fenceLiftErrorCode(error.message);
        const status = code === 'invalid_request' ? 400 : code === 'lift_failed' ? 500 : 409;
        if (status === 500) console.error('[system] permission-fence lift failed:', error.message);
        res.status(status).json({ error: error.message, code });
    }
});

// ── Queue maintenance (B-185 ب / B-200) ─────────────────────────────────────
//
// Two janitor passes the queue needs:
//   • reapStaleExecuting — settles rows abandoned in 'executing' (the process
//     died between the CAS claim and the outcome) as failed/execution_unresolved
//     history. It no longer returns them to 'pending': an orphan proves the
//     outcome is unknown, never that the work is still owed, and only real
//     pending work may light the badge (T-1684).
//   • pruneHistory — the one-hour retention the history tab promises. Deletes
//     settled rows (succeeded/failed/superseded) an hour after they settled.
//     Not flag-gated: it IS the contract, not optional cleanup.
//
// WHY IT HANGS OFF QUEUE READS instead of module scope: this file is
// imported by server/index.js BEFORE initializeDatabase() runs, so a top-level
// call would hit an unmigrated database. GET /pending can only be served after
// the listener is open (hence after init), and the queue UI issues one on mount
// and on every WS 'pending-actions-updated'. Receipt reconciliation runs on each
// read; generic janitors run at most once per bounded interval. Everything is
// idempotent and best-effort: a failure here must never break the listing.
// Re-run the stale-execution janitor on a bounded cadence. A one-shot pass at
// the first GET can see a freshly abandoned row before its 30-minute safety
// horizon, then leave it invisible forever for the lifetime of this process.
const QUEUE_MAINTENANCE_INTERVAL_MS = 60_000;
let lastQueueMaintenanceAt = Number.NEGATIVE_INFINITY;
let queueMaintenanceClock = () => performance.now();
let oidReceiptReaderForTests = null;
export function setOidReceiptReaderForTests(reader) {
    oidReceiptReaderForTests = typeof reader === 'function' ? reader : null;
}
/** Test seam for the bounded janitor cadence; production never replaces it. */
export function setQueueMaintenanceClockForTests(clock) {
    queueMaintenanceClock = typeof clock === 'function' ? clock : () => performance.now();
    lastQueueMaintenanceAt = Number.NEGATIVE_INFINITY;
}
/** Read each receipt independently: a torn unrelated file cannot hide valid evidence. */
export function readOidTransactionReceipts(gitDirectory = path.join(APP_ROOT, '.git')) {
    let names;
    try { names = fs.readdirSync(gitDirectory); } catch { return []; }
    return names.filter((name) => name.startsWith('nassaj-oid-control-transaction-') && name.endsWith('.json'))
        .flatMap((name) => {
            try {
                const file = path.join(gitDirectory, name);
                const metadata = fs.lstatSync(file);
                if (!metadata.isFile() || metadata.isSymbolicLink()) return [];
                const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
                return receipt && typeof receipt === 'object' ? [receipt] : [];
            } catch { return []; }
        });
}

function oidReceiptIndex() {
    const receipts = oidReceiptReaderForTests ? oidReceiptReaderForTests() : readOidTransactionReceipts();
    const index = new Map();
    for (const receipt of receipts) {
        if (!receipt || typeof receipt.actionId !== 'string' || typeof receipt.transactionNonce !== 'string') continue;
        let attempts = index.get(receipt.actionId);
        if (!attempts) { attempts = new Map(); index.set(receipt.actionId, attempts); }
        const entries = attempts.get(receipt.transactionNonce) || [];
        entries.push(receipt);
        attempts.set(receipt.transactionNonce, entries);
    }
    return index;
}

const OID_RECEIPT_STATE_PRECEDENCE = new Map([
    ['restart_deferred_restored', 0],
    ['pair_served', 1],
    ['pair_rolled_back', 2],
    ['loaded', 1],
    ['served', 1],
    ['rolled_back', 2],
    ['manual_recovery_required', 3],
]);

function preferOidActionReceipt(current, candidate) {
    if (!current) return candidate;
    const currentTerminal = current.state !== 'restart_deferred_restored';
    const candidateTerminal = candidate.state !== 'restart_deferred_restored';
    // A completed transaction is an irreversible fence for its queue action.
    // A stale deferred receipt must never resurrect that action, even if its
    // filename happens to be returned later by readdirSync.
    if (currentTerminal !== candidateTerminal) return candidateTerminal ? candidate : current;
    const currentSequence = Number.isSafeInteger(current.sequence) ? current.sequence : -1;
    const candidateSequence = Number.isSafeInteger(candidate.sequence) ? candidate.sequence : -1;
    if (currentSequence !== candidateSequence) return candidateSequence > currentSequence ? candidate : current;
    // Conflicting receipts for one sequence are corruption-like. Resolve them
    // deterministically toward the safest terminal outcome, never by disk order.
    return OID_RECEIPT_STATE_PRECEDENCE.get(candidate.state)
        > OID_RECEIPT_STATE_PRECEDENCE.get(current.state) ? candidate : current;
}

/** Pair success additionally requires the durable application-serving proof, not just an open gate. */
function pairActionReceiptVerified(row, receipt) {
    if (!['pair_served', 'pair_rolled_back'].includes(receipt.state)) return true;
    if (row.reason !== `local-update:${receipt.sequence}` || row.activationIdentitySha256 !== receipt.pair?.targetDigest
        || row.releaseCommit !== receipt.oid || !validateOidPairTerminal(APP_ROOT, receipt)) return false;
    if (receipt.state === 'pair_rolled_back') return true;
    try {
        readOidPairServingReceipt(APP_ROOT, { sequence: receipt.sequence, transactionNonce: row.executionAttemptNonce,
            targetDigest: row.activationIdentitySha256, actionId: row.id, buildId: row.expectedServerBuildId });
        return true;
    } catch { return false; }
}

/** Admit only typed triple outcomes bound to the exact consent and action. */
function oidActionReceiptSchemaVerified(row, receipt) {
    if (receipt.schema === 'nassaj-oid-control-transaction/v1') return true;
    if (receipt.schema !== 'nassaj-oid-control-transaction/v2') return false;
    try {
        const digest = computeOidTripleTargetDigest({ sequence: receipt.sequence, group: receipt.group,
            sourceOid: receipt.oid, target: receipt.pair?.target });
        if (row.actionType !== 'safe-restart' || row.reason !== `local-update:${receipt.sequence}`
            || row.releaseCommit !== receipt.oid || row.activationIdentitySha256 !== digest
            || receipt.pair.targetDigest !== digest || receipt.targetDigest !== digest
            || receipt.pair.target.serverBuildId !== row.expectedServerBuildId
            || JSON.stringify(receipt.generationNames) !== '["nodeModules","server","client"]') return false;
        if (['pair_served', 'pair_rolled_back'].includes(receipt.state)) {
            return receipt.pair.databaseState === (receipt.state === 'pair_served' ? 'TARGET_VERIFIED' : 'PRE_CANDIDATE');
        }
        if (receipt.state === 'manual_recovery_required') {
            return ['PRE_CANDIDATE', 'UNKNOWN', 'TARGET_VERIFIED'].includes(receipt.pair.databaseState)
                && receipt.error === 'oid_triple_recovery_requires_retained_executor';
        }
        if (receipt.state !== 'restart_deferred_restored' || receipt.error !== 'oid_triple_not_started'
            || receipt.pair.databaseState !== 'PRE_CANDIDATE' || receipt.oldStoppedAt || receipt.bootDirection
            || receipt.bootNonce || receipt.persistence?.online) return false;
        const gate = readUpdateMaintenanceRecoveryEvidence({ projectPath: APP_ROOT });
        try {
            fs.lstatSync(path.join(gate.controlRoot, `oid-child-${receipt.transactionNonce}.json`));
            return false;
        } catch (error) { if (error.code !== 'ENOENT') return false; }
        return gate.state === 'OPEN' && gate.gateClosed === false && !gate.oidAdmissionIntentPending;
    } catch { return false; }
}

/** Select evidence for this attempt before considering terminal state precedence. */
function exactOidActionReceipt(row, index = oidReceiptIndex()) {
    if (!row?.executionAttemptNonce || row.status !== 'executing') return null;
    if ((index.get(row.id)?.get(row.executionAttemptNonce) || []).some(receipt => receipt.schema === 'nassaj-oid-control-transaction/v2')) {
        const evidence = currentOidActionEvidence(row, index);
        return evidence.conflict ? null : evidence.receipt;
    }
    return (index.get(row.id)?.get(row.executionAttemptNonce) || []).filter((receipt) =>
        oidActionReceiptSchemaVerified(row, receipt)
        && receipt.actionId === row.id && receipt.buildId === row.expectedServerBuildId
        && receipt.transactionNonce === row.executionAttemptNonce
        && Number.isSafeInteger(receipt.sequence) && receipt.sequence > 0
        && OID_RECEIPT_STATE_PRECEDENCE.has(receipt.state)
        && pairActionReceiptVerified(row, receipt)
        && (!['served', 'loaded'].includes(receipt.state)
            || (/^[a-f0-9]{40}$/.test(receipt.oid || '')
                && /^[a-f0-9]{64}$/.test(receipt.bootNonce || '')
                && Number.isSafeInteger(receipt.newPid) && receipt.newPid > 0
                && /^[0-9]+$/.test(receipt.newStartTicks || ''))))
        .reduce((current, receipt) => preferOidActionReceipt(current, receipt), null);
}

/** Read-only evidence selection also admits settled rows; the execution predicate above stays unchanged. */
function currentOidActionEvidence(row, index) {
    if (row.actionType !== 'safe-restart' || !/^[a-f0-9]{64}$/.test(row.executionAttemptNonce || '')
        || !/^[a-f0-9]{64}$/.test(row.expectedServerBuildId || '')) return { receipt: null, conflict: false };
    const attempts = index.get(row.id)?.get(row.executionAttemptNonce) || [];
    if (attempts.some(receipt => receipt.schema === 'nassaj-oid-control-transaction/v2')
        && attempts.some(receipt => receipt.schema !== 'nassaj-oid-control-transaction/v2')) return { receipt: null, conflict: true };
    const receipts = attempts.filter((receipt) => oidActionReceiptSchemaVerified(row, receipt)
        && receipt.actionId === row.id && receipt.transactionNonce === row.executionAttemptNonce
        && receipt.buildId === row.expectedServerBuildId && Number.isSafeInteger(receipt.sequence) && receipt.sequence > 0
        && OID_RECEIPT_STATE_PRECEDENCE.has(receipt.state)
        && pairActionReceiptVerified(row, receipt)
        && (!['loaded', 'served'].includes(receipt.state)
            || (/^[a-f0-9]{40}$/.test(receipt.oid || '') && /^[a-f0-9]{64}$/.test(receipt.bootNonce || '')
                && Number.isSafeInteger(receipt.newPid) && receipt.newPid > 0 && /^[0-9]+$/.test(receipt.newStartTicks || ''))));
    if (receipts.length !== attempts.length) return { receipt: null, conflict: attempts.length > 0 };
    const terminal = receipts.filter((receipt) => receipt.state !== 'restart_deferred_restored');
    const verdicts = new Set(terminal.map((receipt) => ['loaded', 'served'].includes(receipt.state) ? 'loaded' : receipt.state));
    const identities = new Set(terminal.filter((receipt) => ['loaded', 'served'].includes(receipt.state))
        .map((receipt) => JSON.stringify([receipt.oid, receipt.bootNonce, receipt.newPid, receipt.newStartTicks])));
    if (verdicts.size > 1 || identities.size > 1) return { receipt: null, conflict: true };
    return { receipt: receipts.reduce((current, receipt) => preferOidActionReceipt(current, receipt), null), conflict: false };
}

/** Describe the current action, never infer that this browser's interrupted POST executed it. */
function currentActionReadOutcome(row, evidence) {
    const unknown = (reasonCode) => ({ status: 'unknown', reasonCode, retryable: false });
    if (row.actionType === 'safe-restart' && row.status === 'pending' && !row.executionAttemptNonce) {
        // B-1057 / ADR-156 WI-1. A deferred row used to be recognised HERE by
        // still carrying its attempt nonce, which sent it down the receipt path
        // and surfaced the precise reason ("live sessions", "live work"). Now
        // that moveToPending clears the nonce so boot can settle the row, the
        // nonce can no longer carry that meaning — the reason lives in `error`,
        // and reading it is what keeps "postponed because sessions are live"
        // from collapsing into a bare "queued" the owner cannot act on.
        const deferral = RESTART_DEFERRAL_REASON_CODES.includes(row.error);
        return { status: 'pending', reasonCode: deferral ? row.error : 'action_pending', retryable: true };
    }
    if (evidence.conflict) return unknown('receipt_conflict');
    if (row.status === 'superseded' && !['oid_loaded', 'oid_rolled_back'].includes(row.error)) {
        return { status: 'failure', reasonCode: 'superseded', retryable: false };
    }
    if (!evidence.receipt) return unknown('execution_unresolved');
    const outcome = oidReceiptOutcome(evidence.receipt);
    const settledMatches = row.status === outcome.status && row.error === outcome.reasonCode;
    if (row.status !== 'executing' && !settledMatches) return unknown('receipt_conflict');
    return { status: outcome.reasonCode === 'oid_loaded' ? 'success' : outcome.retryable ? 'pending' : 'failure',
        reasonCode: outcome.reasonCode, retryable: outcome.retryable };
}

function oidReceiptOutcome(receipt) {
    // T-1684: a 'loaded'/'served' receipt is the ONLY proof this server actually
    // came back on the requested build, so it is the one thing that may settle a
    // safe-restart as 'succeeded'. Everything short of it stays superseded/
    // failed — an unproven restart must never read as a success in history.
    if (['loaded', 'served', 'pair_served'].includes(receipt.state)) return { status: 'succeeded', reasonCode: 'oid_loaded', retryable: false };
    if (['rolled_back', 'pair_rolled_back'].includes(receipt.state)) return { status: 'superseded', reasonCode: 'oid_rolled_back', retryable: false };
    if (receipt.state === 'manual_recovery_required') {
        return { status: 'failed', reasonCode: 'oid_manual_recovery_required', retryable: false };
    }
    return { status: 'pending', retryable: true,
        reasonCode: receipt.gate === 3 ? 'live_work' : receipt.gate === 6 ? 'live_sessions' : 'oid_control_deferred' };
}

/** Observe an already-settled exact attempt without repeating its side effect. */
function settledOidOutcome(row, outcome) {
    const finalRow = pendingServerActionsDb.getById(row.id);
    if (finalRow?.executionAttemptNonce !== row.executionAttemptNonce
        || finalRow?.expectedServerBuildId !== row.expectedServerBuildId) return null;
    if (finalRow.status === outcome.status && finalRow.error === outcome.reasonCode) return outcome;
    if (outcome.status === 'pending' && finalRow.status === 'superseded'
        && finalRow.error?.startsWith('superseded_by:')) {
        return { status: 'superseded', reasonCode: 'superseded', retryable: false };
    }
    return null;
}

function settleOidReceipt(row, receipt) {
    const outcome = oidReceiptOutcome(receipt);
    pendingServerActionsDb.settleExecution(row.id, row.executionAttemptNonce,
        row.expectedServerBuildId, outcome.status, outcome.reasonCode);
    return settledOidOutcome(row, outcome);
}

function reconcileOidActionReceipts() {
    // One directory read per pass, then action/attempt lookup instead of rescans.
    const index = oidReceiptIndex();
    for (const actionId of index.keys()) {
        if (!/^[a-f0-9-]{36}$/.test(actionId || '')) continue;
        const row = pendingServerActionsDb.getById(actionId);
        const receipt = exactOidActionReceipt(row, index);
        if (receipt) {
            settleOidReceipt(row, receipt);
            if (receipt.state === 'pair_served') void withLocalUpdateWriterLease('local-update-serving-recovery',
                () => reconcileOidPairServingReceipt(APP_ROOT, { sequence: receipt.sequence, transactionNonce: receipt.transactionNonce,
                    targetDigest: row.activationIdentitySha256, actionId: row.id, buildId: row.expectedServerBuildId })).catch(() => {});
        }
    }
}

export function runQueueMaintenance() {
    // Receipts may become terminal minutes after the first GET, so reconcile on
    // every queue read. Generic janitors are rate-limited, not one-shot: rows
    // that cross the stale horizon after boot must still become retryable.
    reconcileOidActionReceipts();
    const now = queueMaintenanceClock();
    if (!Number.isFinite(now)) return;
    const elapsed = now - lastQueueMaintenanceAt;
    // Production uses a monotonic clock. A backwards test/host clock is still
    // treated as a new cadence boundary so maintenance cannot be suppressed
    // until wall time catches up with a stale future baseline.
    if (elapsed >= 0 && elapsed < QUEUE_MAINTENANCE_INTERVAL_MS) return;
    // Advance before the work so a database error cannot create a hot retry
    // loop on every GET. The next bounded pass retries safely.
    lastQueueMaintenanceAt = now;
    try {
        pendingServerActionsDb.reapStaleExecuting();
        pendingServerActionsDb.pruneHistory();
    } catch (error) {
        console.error('[system] queue maintenance failed:', error.message);
    }
}

// ── Queue + history projections (T-1684) ────────────────────────────────────
//
// The command board has two lists and ONE source of truth per row:
//   • actions — the queue: 'pending' plus a genuinely in-flight 'executing' row.
//     Only this list may light the yellow badge (/health counts 'pending').
//   • history — settled rows (succeeded/failed/superseded) plus, for a caller
//     holding the raw tier, finished RAW executions. Read-only, kept one hour.
// Neither projection ever surfaces cmd/argv for an allowlisted action; a raw
// entry shows the command the owner themself typed, secret-redacted, and there
// is no route that re-runs it.

/** Symbolic reason codes only ([a-z][a-z0-9_]{0,79}); anything else is dropped. */
const symbolicReasonCode = (error) => (/^[a-z][a-z0-9_]{0,79}$/.test(error || '') ? error : null);

/** Retention mirror of pendingServerActionsDb.pruneHistory — drives `expiresAt`. */
const HISTORY_RETENTION_MS = 60 * 60 * 1000;

/** A failed row stays retryable unless its reason says a retry cannot help. */
const isRetryableFailure = (row) => row.error !== 'oid_manual_recovery_required'
    && !(row.actionType === 'safe-restart'
        && ['unknown_candidate', 'sensitive_candidate'].includes(row.error));

/**
 * Superseded reasons that mean the requested work ALREADY HAPPENED in another
 * run of the same request — supersedeSiblings (a global action that just ran),
 * the dedup collapse onto an equivalent pending row, and the generation fence
 * that points at the newer row which carried the request (`superseded_by:<id>`).
 * They are successes for the owner, not the "cannot tell" bucket:
 * `superseded_by_newer_server_candidate` is deliberately NOT here — that request
 * was fenced because a DIFFERENT build arrived, and it never ran.
 */
const SATISFIED_BY_OTHER_EXECUTION = new Set([
    'satisfied_by_same_generation_execution',
    'satisfied_by_equivalent_pending_action',
]);

/** The one symbolic code the UI resolves to `pendingActions.satisfiedByOther`. */
const SATISFIED_BY_OTHER_REASON = 'satisfied_by_other_execution';

const isSatisfiedByOtherExecution = (error) => SATISFIED_BY_OTHER_EXECUTION.has(error)
    || String(error ?? '').startsWith('superseded_by:');

/**
 * Verdict for a SETTLED action row: success only with proof, failure only when
 * something actually went wrong, unknown for everything the server cannot tell
 * apart (an abandoned execution, a request replaced before it ran).
 */
function historyVerdict(row) {
    if (row.status === 'succeeded') return { outcome: 'success', retryable: false };
    if (row.status === 'failed') {
        // An abandoned execution: the outcome is unknown, and the UI offers no
        // retry for it (re-running work that may already have happened is the
        // worse error), so the contract says so instead of implying otherwise.
        if (row.error === 'execution_unresolved') return { outcome: 'unknown', retryable: false };
        return { outcome: 'failure', retryable: isRetryableFailure(row) };
    }
    // superseded: satisfied by another run, never executed, or rolled back.
    if (row.error === 'oid_rolled_back') return { outcome: 'failure', retryable: false };
    if (row.error === 'oid_loaded') return { outcome: 'success', retryable: false }; // pre-T-1684 row
    if (isSatisfiedByOtherExecution(row.error)) {
        return { outcome: 'success', retryable: false, reasonCode: SATISFIED_BY_OTHER_REASON };
    }
    return { outcome: 'unknown', retryable: false };
}

/** Projects a settled action row into the shared history item contract. */
function toHistoryItem(row) {
    const action = toPublic(row, resolveAction);
    if (!action) return null;
    const settledAt = row.settledAt ?? row.executedAt ?? row.requestedAt;
    const settledMs = Date.parse(settledAt);
    const verdict = historyVerdict(row);
    return {
        id: row.id,
        kind: 'action',
        actionType: row.actionType,
        label: action.label,
        commandPreview: action.commandPreview ?? null,
        outcome: verdict.outcome,
        // A verdict-supplied code wins: it collapses several stored reasons
        // (`superseded_by:<id>` is not even symbolic) onto one named message.
        reasonCode: verdict.reasonCode ?? symbolicReasonCode(row.error),
        retryable: verdict.retryable,
        executedAt: Number.isFinite(settledMs) ? new Date(settledMs).toISOString() : settledAt,
        expiresAt: Number.isFinite(settledMs)
            ? new Date(settledMs + HISTORY_RETENTION_MS).toISOString() : null,
        requestedAt: row.requestedAt,
        sessionId: row.sessionId ?? null,
    };
}

/** Longest raw-command label a history row shows before the ellipsis. */
const RAW_LABEL_MAX_LEN = 80;

/** First line of an already-redacted raw command, bounded, as a display label. */
function rawCommandLabel(command) {
    const firstLine = String(command ?? '').split('\n')[0].trim();
    return firstLine.length > RAW_LABEL_MAX_LEN
        ? `${firstLine.slice(0, RAW_LABEL_MAX_LEN - 1)}\u2026` : firstLine;
}

/** Projects a stored raw execution record into the same history item contract. */
const toRawHistoryItem = (entry) => ({
    id: entry.id,
    kind: 'raw',
    // A raw execution has no allowlist entry and so no i18n label key: its name
    // is the command the owner typed. First line only, already secret-redacted
    // by recordRawExecution, bounded so a long one-liner cannot stretch the row.
    label: rawCommandLabel(entry.command),
    commandPreview: entry.command,
    outcome: entry.outcome,
    reasonCode: entry.reasonCode ?? null,
    // A raw command is never re-run from history (ADR-070: execution requires a
    // queued row bound to a digest the human just reviewed).
    retryable: false,
    executedAt: entry.executedAt,
    expiresAt: new Date(Date.parse(entry.executedAt) + HISTORY_RETENTION_MS).toISOString(),
    requestedAt: entry.requestedAt ?? null,
    exitCode: entry.exitCode ?? null,
    stdoutTail: entry.stdoutTail ?? '',
    stderrTail: entry.stderrTail ?? '',
});

/**
 * True when this caller may see raw-exec content. Same gate as the queue rows in
 * GET /command-board-raw — the tier grant AND an unblocked environment — so raw
 * history cannot leak to a caller who is not allowed to read the raw queue.
 */
function callerMayReadRaw(req) {
    if (!req.user?.role) return false;
    try {
        return rawExecEnvironmentBlockers().length === 0
            && canRoleRunRawExec(req.user.role, getCommandBoardConfig());
    } catch (error) {
        console.error('[system] raw tier check failed:', error.message);
        return false; // fail-closed
    }
}

// GET /api/system/pending — LIST the server-action QUEUE and the recent HISTORY
// (ADR-066, T-944; history added in T-1684). authenticateToken is applied to
// this router in server/index.js, so any AUTHENTICATED session may READ them
// (reading ≠ executing — consistent with recording being open to any
// authenticated session; only execute/dismiss are owner-gated). statsLimiter is
// the same lightweight read limiter used by /stats. toPublic never surfaces
// cmd/argv, so no executable detail leaks; raw history is included ONLY for a
// caller who passes the raw tier and is omitted entirely otherwise.
router.get('/pending', statsLimiter, (req, res) => {
    try {
        runQueueMaintenance();
        const limit = Number(req.query.limit ?? 100);
        const offset = Number(req.query.offset ?? 0);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
            || !Number.isSafeInteger(offset) || offset < 0) {
            return res.status(400).json({ status: 'error', code: 'invalid_pagination' });
        }
        const rows = pendingServerActionsDb.listVisible(limit, offset);
        const actions = rows.map((row) => {
            const action = toPublic(row, resolveAction);
            return action ? { ...action, traceId: row.id, reasonCode: row.status === 'executing'
                ? 'execution_unresolved' : symbolicReasonCode(row.error),
                retryable: row.status === 'pending' && isRetryableFailure(row) } : null;
        }).filter(Boolean);
        const history = [
            ...pendingServerActionsDb.listHistory(limit).map(toHistoryItem).filter(Boolean),
            ...(callerMayReadRaw(req) ? listRawHistory().map(toRawHistoryItem) : []),
        ].sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt));
        return res.json({ actions, history });
    } catch (error) {
        console.error('[system] list pending actions failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to list actions' });
    }
});

// Router authentication is mounted in server/index.js. This observation never runs queue maintenance or execution.
router.get('/pending/:id/outcome', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
    statsLimiter, requireRole('owner'), (req, res) => {
        const actionId = req.params.id;
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(actionId || '')) {
            return res.status(400).json({ status: 'error', code: 'invalid_action_id' });
        }
        const unknown = (reasonCode) => res.json({ actionId,
            currentActionOutcome: { status: 'unknown', reasonCode, retryable: false } });
        try {
            const row = pendingServerActionsDb.getById(actionId);
            if (!row) return unknown('action_missing');
            const evidence = currentOidActionEvidence(row, oidReceiptIndex());
            const finalRow = pendingServerActionsDb.getById(actionId);
            const identityFields = ['id', 'actionType', 'executionAttemptNonce', 'expectedServerBuildId', 'status', 'error', 'executedAt'];
            if (!finalRow || identityFields.some((field) => finalRow[field] !== row[field])) return unknown('action_changed');
            return res.json({ actionId, currentActionOutcome: currentActionReadOutcome(finalRow, evidence) });
        } catch {
            return res.status(500).json({ status: 'error', code: 'internal' });
        }
    });

// GET /api/system/security-posture — boot-time security findings that DEGRADED
// to a warning instead of refusing to boot (T-1085; today only the docker-socket
// guard on a single-user host). OWNER/ADMIN only and deliberately NOT part of
// the public /health payload: "this server can reach the Docker socket" is a
// map of the host's attack surface, useful to an attacker probing an exposed
// instance. Empty array = nothing degraded on this boot.
/**
 * ADR-156 WI-6 / review م-9 — the AUTHENTICATED half of the runtime identity.
 *
 * /health stays public and publishes only `runtimeVersion`, `degraded` and
 * `degradedReason`: enough for an external monitor to see that a node is sick,
 * and no more disclosive than the `sourceVersion` it has always carried. The
 * exact source commit and the maintenance gate's internal phase belong here,
 * behind `/api/system`'s authenticateToken, because they name the source
 * revision and the update machinery's internal state.
 *
 * Read-only and total: it never transitions the gate, and an unreadable journal
 * reports degraded rather than healthy, exactly as /health does.
 */
router.get('/runtime-identity', statsLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const maintenance = resolveDegraded(
        () => createUpdateMaintenanceGate({ projectPath: APP_ROOT }).readPublicStatus(),
    );
    return res.json({ success: true, ...readRuntimeIdentity(APP_ROOT), ...maintenance });
});

router.get('/security-posture', statsLimiter, requireRole('owner', 'admin'), (req, res) => {
    try {
        return res.json({ warnings: getBootSecurityWarnings() });
    } catch (error) {
        console.error('[system] security posture read failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to read posture' });
    }
});

// GET /api/system/actions — the CATALOG of allowlisted actions for the inline
// run button (ADR-066, T-947). authenticateToken is applied to this router in
// server/index.js, so any AUTHENTICATED session may READ the catalog (reading ≠
// executing — the same policy as GET /pending). Both projections are PURE and
// symbolic: { actionType, label, commandPreview, minRole (+ custom for custom
// commands) } only — they NEVER surface cmd/args/gateArgs, so no executable
// detail leaks. Custom commands (T-948 Phase 2) are merged in AFTER the frozen
// static list; a custom key can never shadow a static one (enforced at
// definition). statsLimiter is the same lightweight read limiter.
router.get('/actions', statsLimiter, (req, res) => {
    try {
        return res.json({ actions: [...toPublicCatalog(), ...toPublicCustomCatalog()] });
    } catch (error) {
        console.error('[system] list action catalog failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to list actions' });
    }
});

// GET/PUT /api/system/command-board-config — OWNER-ONLY management of the
// command board (T-948/ADR-067, Phase 1): per-role mode (none/safe) and which
// safe-list actions are enabled. GET also returns the action catalog so the
// settings page can render toggles. No executable detail is exposed.
router.get('/command-board-config', requireRole('owner'), (req, res) => {
    try {
        // B-197: drop a stored raw-exec `true` that an environment blocker has
        // already neutralised, so the settings page never renders a toggle whose
        // stored value disagrees with the effective one. The returned config
        // carries `rawExecBlockedReasons` for the UI warning.
        enforceRawExecEnvironmentGuard();
        return res.json({ config: toPublicCommandBoardConfig(), actions: toPublicCatalog() });
    } catch (error) {
        console.error('[system] read command-board config failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to read config' });
    }
});

router.put('/command-board-config', requireRole('owner'), (req, res) => {
    try {
        const result = setCommandBoardConfig(req.body);
        if (!result.ok) {
            // B-197: a refused raw-exec raise is a POLICY refusal, not a malformed
            // body — answer 403 with the blocker codes so the UI can explain WHY
            // rather than showing a generic validation error.
            if (String(result.error).startsWith('raw_exec_blocked')) {
                auditLogDb.record('command_board_config_updated', {
                    userId: req.user?.id ?? null,
                    metadata: { result: 'reject', reason: result.error },
                    ipAddress: clientIp(req),
                    userAgent: req.headers['user-agent'] ?? null,
                });
                return res.status(403).json({
                    status: 'error',
                    code: 'raw_exec_blocked',
                    blockers: result.blockers ?? rawExecEnvironmentBlockers(),
                    detail: 'Raw execution cannot be enabled in this environment',
                });
            }
            return res.status(400).json({ status: 'error', code: result.error });
        }
        auditLogDb.record('command_board_config_updated', {
            userId: req.user?.id ?? null,
            metadata: { config: result.config },
            ipAddress: clientIp(req),
            userAgent: req.headers['user-agent'] ?? null,
        });
        return res.json({ config: result.config });
    } catch (error) {
        console.error('[system] update command-board config failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to update config' });
    }
});

// ── Owner-defined custom commands (T-948 / ADR-067 Phase 2) ─────────────────
// CRUD for owner-defined command-board commands. OWNER-ONLY (defining a runnable
// host command is strictly more privileged than running an allowlisted one).
//
// SECURITY: the definition is validated in command-board-custom.js against a
// FROZEN executable allowlist (only `npm run <existing, non-denylisted script>`),
// an interpreter denylist, strict argv-token rules (zero interpolation from any
// request field), and hard caps. A rejected definition returns 400 with a
// symbolic code and writes nothing. Every mutation is audited with the acting
// user. Execution reuses the SAME executeActionRow/spawn path + both gates
// (roleSatisfies AND canRoleRunAction) as the static allowlist.
function auditCustomMutation(req, op, extra = {}) {
    auditLogDb.record('command_board_custom_updated', {
        userId: req.user?.id ?? null,
        metadata: { op, ...extra },
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
    });
}

// GET — owner management view: full definitions incl. cmd/args + validity.
router.get('/command-board-custom', requireRole('owner'), (req, res) => {
    try {
        return res.json({ commands: listCustomCommandsForOwner(), maxCommands: 20 });
    } catch (error) {
        console.error('[system] list custom commands failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to list commands' });
    }
});

// POST — create a custom command.
router.post('/command-board-custom', requireRole('owner'), (req, res) => {
    try {
        const result = createCustomCommand(req.body);
        if (!result.ok) {
            return res.status(400).json({ status: 'error', code: result.error });
        }
        auditCustomMutation(req, 'create', {
            key: result.value.key,
            cmd: result.value.cmd,
            args: result.value.args,
            minRole: result.value.minRole,
        });
        return res.status(201).json({ command: result.value });
    } catch (error) {
        console.error('[system] create custom command failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to create command' });
    }
});

// PUT — update an existing custom command (key immutable).
router.put('/command-board-custom/:key', requireRole('owner'), (req, res) => {
    try {
        const result = updateCustomCommand(req.params.key, req.body);
        if (!result.ok) {
            const status = result.error === 'not_found' ? 404 : 400;
            return res.status(status).json({ status: 'error', code: result.error });
        }
        auditCustomMutation(req, 'update', {
            key: result.value.key,
            cmd: result.value.cmd,
            args: result.value.args,
            minRole: result.value.minRole,
        });
        return res.json({ command: result.value });
    } catch (error) {
        console.error('[system] update custom command failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to update command' });
    }
});

// DELETE — remove a custom command. Idempotent.
router.delete('/command-board-custom/:key', requireRole('owner'), (req, res) => {
    try {
        const result = deleteCustomCommand(req.params.key);
        auditCustomMutation(req, 'delete', { key: req.params.key, removed: result.removed });
        return res.json({ status: 'deleted', key: req.params.key, removed: result.removed });
    } catch (error) {
        console.error('[system] delete custom command failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to delete command' });
    }
});

// ── Raw-exec: "تنفيذ أي أمر" (T-948 Phase 3 / ADR-070) ──────────────────────
//
// ⚖️ DOCUMENTED VETO OVERRIDE (owner decision 2026-07-25, ADR-070). See the
// module header of server/services/command-board-raw.js for the threat model.
// The route floor is TIER-BASED, not owner-only (ADR-072 amended 2026-07-26 on
// the owner's explicit instruction). Any role the permission matrix grants the
// 'raw' tier passes `requireRawExecTier`; a hardcoded owner floor here would
// silently override the matrix — the hidden-second-condition class of bug that
// trapped the owner in B-199. The brakes that remain are global, never per-row:
// the armed master switch and the environment blockers (IS_PLATFORM/B-186),
// both of which lower EVERY role at once.
// IMPACT, explicitly accepted by the owner: a granted role can run any command
// on the host as the service user — full host control, not app-scoped rights.
//
// WHERE THE GATE ACTUALLY RUNS (traced, not asserted):
//   • pre-flight — `rawExecConfigGate` at the top of every raw route: flag +
//     role mode, with distinct refusal codes for a clearer message.
//   • execution — `prepareRawExecution` calls `canRoleRunRawExec` itself and
//     re-runs the control-char scan, the self-destruction denylist and the
//     digest binding; nothing reaches spawn without passing it.
//   • before spawn — `auditRawExecStrict` writes AND verifies the 'exec_start'
//     record; an unverifiable audit refuses the execution (503).
//
// Rate limits: inserting a raw row is cheap but should not be spammable; running
// one is destructive → the same tight 5/min as the restart trigger.
const rawExecInsertLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    message: 'Too many requests, please slow down',
});
const rawExecRunLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 5,
    message: 'Too many requests, please slow down',
});

// Single in-flight guard: one raw exec at a time (a raw command may itself be a
// heavy/long op). Released in a real `finally` (see the execute route) so a
// failed attempt never wedges it.
let rawExecInFlight = false;

/**
 * Audit for a raw-exec attempt (insert/reject/success/failure). The FULL command
 * + digest + actor + reason/exit go to audit_log (an owner-only, internal sink)
 * — NEVER to console/pm2 logs which may be shared.
 *
 * HONEST DESCRIPTION OF THE SINK: audit_log is append-only by USAGE (nothing in
 * this codebase updates or deletes rows; retention pruning is separate), but the
 * WRITE IS BEST-EFFORT: auditLogDb.record swallows every error and only logs to
 * console. A full disk or a locked DB therefore drops the row silently. For the
 * one place where that is unacceptable — the record that a raw command is about
 * to run — use auditRawExecStrict below, which verifies the row landed.
 */
function auditRawExec(req, result, extra = {}) {
    // B-197 (branch ٣): the command is the owner's own free-form shell, so it may
    // carry an INLINE credential. audit_log is owner-only but long-lived and
    // exported/backed-up, so the labelled credential VALUES are masked here
    // before the row is written. Redaction touches the AUDIT COPY only — the
    // stored/executed bytes and the digest are untouched (WYSIWYG is preserved).
    // See redactSecretsForAudit for its honest, name-directed limits.
    const metadata = { result, ...extra };
    if ('command' in metadata) {
        metadata.command = redactSecretsForAudit(metadata.command);
    }
    auditLogDb.record('command_board_raw_exec', {
        userId: req.user?.id ?? null,
        metadata,
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
    });
}

/**
 * STRICT audit: writes the row and then PROVES it is readable, throwing if not.
 * Used for the pre-spawn 'exec_start' record so that an unauditable execution is
 * REFUSED rather than run silently (ADR-068 discipline: no unlogged raw exec).
 *
 * Verification method: a random nonce is embedded in the metadata and looked up
 * in the most recent rows. auditLogDb.record cannot report failure (it swallows
 * errors and returns void) and this module must not modify audit-log.ts, so a
 * read-back is the only way to distinguish "written" from "silently dropped".
 *
 * LIMIT, stated plainly: the read-back scans the newest AUDIT_READBACK_LIMIT
 * rows. Raw execs are serialized by rawExecInFlight and rate-limited to 5/min,
 * so a concurrent flood of other audit events large enough to push the row out
 * of that window would produce a FALSE failure — i.e. it errs toward refusing to
 * execute, never toward executing unlogged.
 * @throws {Error} when the row cannot be confirmed.
 */
const AUDIT_READBACK_LIMIT = 50;
function auditRawExecStrict(req, result, extra = {}) {
    const auditNonce = crypto.randomUUID();
    auditRawExec(req, result, { ...extra, auditNonce });
    let landed = false;
    try {
        landed = auditLogDb
            .recent(AUDIT_READBACK_LIMIT)
            .some((r) => r.action === 'command_board_raw_exec'
                && typeof r.metadata === 'string'
                && r.metadata.includes(auditNonce));
    } catch (error) {
        throw new Error(`audit_unverifiable: ${error.message}`);
    }
    if (!landed) {
        throw new Error('audit_write_failed');
    }
}

/**
 * Route floor for the raw-exec endpoints.
 *
 * ADR-072 AMENDED 2026-07-26 (owner decision: «سيبني اعطي الصلاحيات براحتي، لا
 * تقيدني»): raw is assignable to ANY role, so a hardcoded requireRole('owner')
 * floor here would silently override the permission matrix — the exact class of
 * hidden second condition that trapped the owner in B-199. Authorisation now
 * derives from the SAME single decision function the handlers use
 * (canRoleRunRawExec = granted tier 'raw' AND the armed ceiling), so what the
 * matrix shows is what the route enforces.
 *
 * Still closed: unauthenticated callers (req.user is set by the auth middleware
 * that runs before this router), a disarmed master switch, and any environment
 * blocker (IS_PLATFORM/B-186) — those lower EVERY role at once.
 */
function requireRawExecTier(req, res, next) {
    if (!req.user?.role) {
        return res.status(401).json({ status: 'error', code: 'unauthenticated', detail: 'Authentication required' });
    }
    // Mirror `rawExecConfigGate`'s ORDER and its DISTINCT codes. Collapsing these
    // into one generic refusal would tell an owner whose master switch is off that
    // "your role lacks the tier" — a misleading dead end. Environment first (it
    // overrides everything), then the switch, then the per-role grant.
    const blockers = rawExecEnvironmentBlockers();
    if (blockers.length > 0) {
        auditRawExec(req, 'reject', { reason: 'raw_exec_blocked', blockers });
        return res.status(403).json({
            status: 'error',
            code: 'raw_exec_blocked',
            blockers,
            detail: 'Raw command execution is disabled in this environment',
        });
    }
    const config = getCommandBoardConfig();
    if (config.rawExecEnabled !== true) {
        auditRawExec(req, 'reject', { reason: 'raw_exec_disabled' });
        return res.status(403).json({
            status: 'error',
            code: 'raw_exec_disabled',
            detail: 'Raw command execution is disabled',
        });
    }
    if (!canRoleRunRawExec(req.user.role, config)) {
        auditRawExec(req, 'reject', { reason: 'config_denied' });
        return res.status(403).json({
            status: 'error',
            code: 'config_denied',
            detail: 'Raw execution is not enabled for your role',
        });
    }
    return next();
}

/**
 * The two-part config gate for raw exec (flag + role mode), returning the config
 * on success or sending a 403 with a DISTINCT symbolic code and auditing the
 * refusal. fail-closed. `commandForAudit` is included when available so a refused
 * attempt is still fully traceable.
 *   raw_exec_disabled — the rawExecEnabled ceiling flag is unarmed.
 *   config_denied     — the requester's capability does not reach the 'raw' tier
 *                       (ADR-072: the role must be explicitly assigned tier 'raw';
 *                       a migrated 'general'/'custom' owner is NOT implicitly raw).
 * (insufficient_role is handled earlier by the requireRole('owner') route floor.)
 */
function rawExecConfigGate(req, res, commandForAudit = null) {
    // B-197: environment blocker FIRST, with its own code. getCommandBoardConfig
    // already forces rawExecEnabled=false while a blocker holds, so this is
    // defence in depth for the message only — but the distinction matters: the
    // owner must learn the flag is refused BY THE ENVIRONMENT (platform mode
    // makes every visitor "the owner", B-186) rather than merely switched off.
    const blockers = rawExecEnvironmentBlockers();
    if (blockers.length > 0) {
        auditRawExec(req, 'reject', { reason: 'raw_exec_blocked', blockers, command: commandForAudit });
        res.status(403).json({
            status: 'error',
            code: 'raw_exec_blocked',
            blockers,
            detail: 'Raw command execution is disabled in this environment',
        });
        return null;
    }
    const config = getCommandBoardConfig();
    if (config.rawExecEnabled !== true) {
        auditRawExec(req, 'reject', { reason: 'raw_exec_disabled', command: commandForAudit });
        res.status(403).json({
            status: 'error',
            code: 'raw_exec_disabled',
            detail: 'Raw command execution is disabled',
        });
        return null;
    }
    // ADR-072: the single decision function. Flag armed (checked above) makes the
    // ceiling 'raw'; this passes only if the role's granted tier is also 'raw'.
    if (!canRoleRunRawExec(req.user?.role, config)) {
        auditRawExec(req, 'reject', { reason: 'config_denied', command: commandForAudit });
        res.status(403).json({
            status: 'error',
            code: 'config_denied',
            detail: 'Raw execution is not enabled for your role',
        });
        return null;
    }
    return config;
}

// GET /api/system/command-board-raw — CALLER-SCOPED read view: always reports the
// caller's own capability (tier + armed flag + environment blockers); the shared
// queue rows are returned ONLY to a caller who actually holds the 'raw' tier.
//
// Deliberately NOT behind requireRawExecTier — that gate would break two things:
//   1. Arming itself. The settings page renders the master switch from THIS
//      payload, and the gate refuses while the switch is off ⇒ the owner could
//      never see (or explain) the disarmed state they need to change. A read that
//      is only permitted once you already have the permission is a dead end.
//   2. Non-owner discovery. Since raw became assignable to any role (ADR-072
//      amended 2026-07-26), an admin granted the tier must be able to learn that
//      — otherwise the client hides a button the server would happily accept.
// Nothing sensitive leaks: capability fields describe only the caller's own
// standing, and the command texts stay behind the tier check below.
router.get('/command-board-raw', (req, res) => {
    if (!req.user?.role) {
        return res.status(401).json({ status: 'error', code: 'unauthenticated', detail: 'Authentication required' });
    }
    try {
        // B-197: persist the drop of a neutralised flag, and hand the UI the
        // blocker codes so the review page can explain the refusal.
        enforceRawExecEnvironmentGuard();
        const config = getCommandBoardConfig();
        const blockers = rawExecEnvironmentBlockers();
        // The queue is SHARED between every tier holder, so each row carries
        // requestedBy and audit records the real actor for the insert and the
        // execute separately (they can differ).
        const mayReadQueue = blockers.length === 0 && canRoleRunRawExec(req.user.role, config);
        return res.json({
            rawExecEnabled: config.rawExecEnabled === true,
            rawExecBlockedReasons: blockers,
            mode: effectiveModeForRole(req.user.role, config),
            maxCommands: MAX_RAW_QUEUE,
            commands: mayReadQueue ? listRawCommands() : [],
        });
    } catch (error) {
        console.error('[system] list raw commands failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to list commands' });
    }
});

// POST /api/system/command-board-raw — enqueue a raw command for later, explicit,
// digest-bound execution. Gate: owner floor + flag armed + tier 'raw'. Validates
// Trojan-Source/control chars + the self-destruction denylist + length + cap at
// INSERT. Never auto-runs.
//
// Returns the row plus the digest the SERVER computed over the stored bytes. The
// review dialog re-computes sha256 over the text it actually rendered and refuses
// to enable Execute unless the two match; what it then sends is its OWN hash, so
// the value on the wire is evidence about the bytes a human read — not a server
// value echoed back (which would prove nothing about the render).
router.post('/command-board-raw', rawExecInsertLimiter, requireRawExecTier, (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const commandForAudit = typeof body.command === 'string' ? body.command : null;
        if (!rawExecConfigGate(req, res, commandForAudit)) return undefined;

        const result = insertRawCommand({
            command: body.command,
            requestedBy: typeof req.user?.username === 'string' ? req.user.username : null,
        });
        if (!result.ok) {
            auditRawExec(req, 'reject', {
                reason: result.error,
                position: result.position ?? null,
                rule: result.rule ?? null,
                command: commandForAudit,
            });
            return res.status(400).json({
                status: 'error',
                code: result.error,
                ...(result.position !== undefined ? { position: result.position } : {}),
            });
        }
        auditRawExec(req, 'insert', {
            id: result.value.id,
            digest: result.value.digest,
            command: result.value.command,
        });
        broadcastPendingActionsUpdated(req);
        return res.status(201).json({ command: result.value });
    } catch (error) {
        console.error('[system] insert raw command failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to insert command' });
    }
});

// DELETE /api/system/command-board-raw/:id — dismiss a queued raw command without
// running it. Idempotent. Restricted to roles granted the 'raw' tier.
router.delete('/command-board-raw/:id', requireRawExecTier, (req, res) => {
    try {
        const { removed } = deleteRawCommand(req.params.id);
        auditRawExec(req, 'dismiss', { id: req.params.id, removed });
        broadcastPendingActionsUpdated(req);
        return res.json({ status: 'dismissed', id: req.params.id, removed });
    } catch (error) {
        console.error('[system] dismiss raw command failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to dismiss command' });
    }
});

// DELETE /api/system/command-board-raw/history/:id — remove ONE raw execution
// record before its hour is up. Same 'raw' tier as every other raw route: a
// record shows the command text, so who may read it may also drop it.
// Idempotent. It cannot collide with DELETE '/command-board-raw/:id' above:
// that pattern matches exactly two path segments, this one three.
router.delete('/command-board-raw/history/:id', requireRawExecTier, (req, res) => {
    try {
        const { removed } = deleteRawHistoryEntry(req.params.id);
        auditRawExec(req, 'history_dismiss', { id: req.params.id, removed });
        broadcastPendingActionsUpdated(req);
        return res.json({ status: 'dismissed', id: req.params.id, removed });
    } catch (error) {
        console.error('[system] dismiss raw history failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to dismiss record' });
    }
});

// POST /api/system/command-board-raw/:id/execute — run a queued raw command.
// Body: { confirmationDigest }. Gate (defence in depth): owner floor + flag up +
// tier 'raw' + Trojan-Source rescan + digest binding. The row is CLAIMED
// (deleted) before spawn so a concurrent/duplicate execute cannot double-run it.
// Executed as `bash -c <verbatim command>` (shell:false, cwd=APP_ROOT, secret-free
// env, 120s cap). Output is captured (capped) and returned to the owner.
router.post('/command-board-raw/:id/execute', rawExecRunLimiter, requireRawExecTier, async (req, res) => {
    if (!rawExecConfigGate(req, res)) return undefined;
    if (rawExecInFlight) {
        return res.status(409).json({ status: 'error', code: 'action_in_flight', detail: 'A raw command is already running' });
    }
    rawExecInFlight = true;
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        // The role is passed so prepareRawExecution can re-run the config gate
        // (canRoleRunRawExec) itself — defence in depth that lives with the
        // function every execute must call, not only here in the route.
        const prep = prepareRawExecution(req.params.id, body.confirmationDigest, req.user?.role);
        if (!prep.ok) {
            auditRawExec(req, 'reject', {
                reason: prep.error,
                id: req.params.id,
                position: prep.position ?? null,
                rule: prep.rule ?? null,
            });
            const status = prep.error === 'not_found'
                ? 404
                : (prep.error === 'config_denied' ? 403 : 400);
            return res.status(status).json({
                status: 'error',
                code: prep.error,
                ...(prep.position !== undefined ? { position: prep.position } : {}),
            });
        }

        // STRICT pre-spawn audit: the record that this exact command is about to
        // run must be DURABLE BEFORE the command runs. If it cannot be written
        // and verified, the execution is refused and the row is left in the queue
        // (nothing was claimed yet) — no unlogged raw exec, ever.
        try {
            auditRawExecStrict(req, 'exec_start', {
                id: prep.row.id,
                digest: prep.digest,
                command: prep.row.command,
            });
        } catch (auditError) {
            console.error('[system] raw exec refused: audit not durable:', auditError.message);
            return res.status(503).json({
                status: 'error',
                code: 'audit_unavailable',
                detail: 'Execution refused: the audit record could not be written',
            });
        }

        // Claim: delete the row BEFORE spawning so it can't be run twice.
        deleteRawCommand(req.params.id);
        broadcastPendingActionsUpdated(req);

        await runRawCommand(req, res, prep);
        return undefined;
    } catch (error) {
        console.error('[system] raw exec failed:', error.message);
        if (!res.headersSent) {
            return res.status(500).json({ status: 'error', code: 'internal', detail: 'Raw command failed' });
        }
        return undefined;
    } finally {
        // Released HERE, unconditionally: every early return, every thrown
        // error, and the happy path all pass through this. (The previous code
        // claimed a `finally` in a comment while assigning the flag on each
        // path separately — one missed branch wedged the endpoint until a
        // process restart.)
        rawExecInFlight = false;
    }
});

/**
 * Spawns and observes a raw command (fixed argv `bash -c <cmd>`, shell:false),
 * bounded by its timeout, capturing stdout/stderr up to MAX_RAW_OUTPUT_BYTES per
 * stream. Audits the outcome (with the full command + digest + exit) and replies
 * with the captured output. A single-response guard covers the close/error/
 * timeout race. NEVER logs the command to console (audit_log is the only sink).
 *
 * T-1684: every terminal path ALSO writes one history record, because the row
 * was deleted from the queue before the spawn and the HTTP response was, until
 * now, the only place the outcome existed — close the tab and it was gone.
 */
function runRawCommand(req, res, prep) {
    const { row, digest, spawn: plan } = prep;
    /** One history record per finished execution; failures here never break the reply. */
    const remember = (outcome, extra = {}) => {
        try {
            recordRawExecution({
                id: row.id,
                command: row.command,
                requestedBy: row.requestedBy ?? null,
                requestedAt: row.requestedAt ?? null,
                executedBy: typeof req.user?.username === 'string' ? req.user.username : null,
                outcome,
                ...extra,
            });
            broadcastPendingActionsUpdated(req);
        } catch (error) {
            console.error('[system] raw history record failed:', error.message);
        }
    };
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(plan.cmd, [...plan.args], {
                cwd: plan.cwd,
                env: plan.env,
                // Own process group (see buildRawSpawn): required so the timeout
                // below can SIGKILL the whole tree, not just the bash leader.
                detached: plan.detached === true,
            });
        } catch (error) {
            auditRawExec(req, 'failure', { id: row.id, digest, command: row.command, reason: 'spawn_failed' });
            remember('failure', { reasonCode: 'spawn_failed' });
            if (!res.headersSent) {
                res.status(500).json({ status: 'error', code: 'exec_failed', detail: 'Failed to launch command' });
            }
            resolve();
            return;
        }

        // Per-stream capture with a BYTE-accurate cap.
        //
        // The cap is named MAX_RAW_OUTPUT_*BYTES* and must behave that way: the
        // previous version compared String.length (UTF-16 code units) and so let
        // ~2x the limit through for Arabic/CJK output (and up to 4x for
        // astral-plane text), while `chunk.toString('utf8')` per chunk split
        // multi-byte sequences across chunk boundaries into U+FFFD. Counting
        // Buffer bytes fixes the cap; a StringDecoder holds the partial trailing
        // sequence between chunks so no character is ever mangled.
        const makeSink = () => ({ parts: [], bytes: 0, decoder: new StringDecoder('utf8'), truncated: false });
        const out = makeSink();
        const err = makeSink();
        const capture = (chunk, sink) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
            if (sink.bytes >= MAX_RAW_OUTPUT_BYTES) { sink.truncated = true; return; }
            const room = MAX_RAW_OUTPUT_BYTES - sink.bytes;
            const slice = buf.length > room ? buf.subarray(0, room) : buf;
            if (buf.length > room) sink.truncated = true;
            sink.bytes += slice.length;
            sink.parts.push(sink.decoder.write(slice));
        };
        // Flush any bytes the decoder held back (an incomplete sequence at the
        // truncation point renders as U+FFFD rather than vanishing).
        const finalize = (sink) => sink.parts.join('') + sink.decoder.end();
        if (child.stdout) child.stdout.on('data', (c) => capture(c, out));
        if (child.stderr) child.stderr.on('data', (c) => capture(c, err));

        let settled = false;
        const finish = (fn) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
            resolve();
        };

        const timer = setTimeout(() => {
            finish(() => {
                // Kill the process GROUP, not just bash: a raw command is free to
                // background work (`nohup x &`, `sleep 9999 &`) and those children
                // survive a kill aimed at the leader alone — running unbounded and
                // unaudited long after the "120s cap" supposedly ended.
                const groupKilled = killProcessTree(child);
                auditRawExec(req, 'failure', {
                    id: row.id,
                    digest,
                    command: row.command,
                    reason: 'timeout',
                    groupKilled,
                });
                // The command was killed mid-flight: what it managed to do before
                // the cap is genuinely unknown, so it is not recorded as a failure.
                remember('unknown', {
                    reasonCode: 'timeout', stdout: finalize(out), stderr: finalize(err),
                });
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', code: 'timeout', detail: 'Command timed out' });
                }
            });
        }, plan.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();

        child.on('error', (error) => {
            finish(() => {
                auditRawExec(req, 'failure', { id: row.id, digest, command: row.command, reason: 'process_error' });
                remember('failure', {
                    reasonCode: 'process_error', stdout: finalize(out), stderr: finalize(err),
                });
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', code: 'exec_failed', detail: 'Command failed to run' });
                }
            });
        });

        child.on('close', (code) => {
            finish(() => {
                const success = code === 0;
                auditRawExec(req, success ? 'success' : 'failure', {
                    id: row.id,
                    digest,
                    command: row.command,
                    exitCode: code,
                });
                // finalize() drains the decoder, so each stream is finalized ONCE
                // and the same text is stored and returned.
                const stdout = finalize(out);
                const stderr = finalize(err);
                // A null exit code means the process was signalled, not that it
                // reported anything: exit 0 is the ONLY evidence of success.
                remember(code === 0 ? 'success' : Number.isSafeInteger(code) ? 'failure' : 'unknown', {
                    exitCode: code, stdout, stderr,
                });
                if (!res.headersSent) {
                    res.status(success ? 200 : 500).json({
                        status: success ? 'success' : 'error',
                        ...(success ? {} : { code: 'exec_failed' }),
                        exitCode: code,
                        stdout,
                        stderr,
                        truncated: out.truncated || err.truncated,
                    });
                }
            });
        });
    });
}

// POST /api/system/pending — RECORD a pending server action (ADR-066, T-944).
//
// Any AUTHENTICATED session may enqueue (recording ≠ executing). The body is
// { actionType, sessionId?, reason? }; buildPendingAction validates it against
// the in-code allowlist (an unknown actionType or unsafe sessionId → 400). The
// insert is idempotent via the partial-unique dedup index: a repeat request for
// the same (actionType, sessionId) while one is still pending returns the
// existing action with { deduped: true } (200) rather than creating a duplicate.
router.post('/pending', pendingCreateLimiter, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (isGlobalIdempotentAction(body.actionType) && !body.expectedServerBuildId) {
        return res.status(400).json({
            status: 'error', code: 'expected_server_build_id_required',
            detail: 'Local-preview restart must be bound to the visible server candidate',
        });
    }
    const built = buildPendingAction(
        {
            actionType: body.actionType,
            sessionId: body.sessionId,
            reason: body.reason,
            expectedServerBuildId: body.expectedServerBuildId,
            requestedBy: typeof req.user?.username === 'string' ? req.user.username : null,
        },
        { isAllowed: isKnownActionType }
    );
    if (!built.ok) {
        return res.status(400).json({ status: 'error', code: 'invalid_action', detail: built.error });
    }

    if (built.value.expectedServerBuildId) {
        const sourceUpdate = findSourceUpdateActivation(built.value);
        const candidate = sourceUpdate ? null : inspectButtonBoundServerCandidate(built.value.expectedServerBuildId, built.value.id);
        if (candidate && !candidate.allowed) {
            const stale = candidate.code === 'superseded';
            return res.status(stale ? 409 : 422).json({
                status: 'error', code: candidate.code, traceId: req.serverActionTraceId,
                detail: stale ? 'The selected server candidate was superseded' : 'Server candidate is blocked by the fail-closed classifier',
            });
        }
    }

    try {
        // A GLOBAL action (one run satisfies every asker, e.g. safe-restart)
        // collapses onto the row that is already queued, whichever session asked
        // for it. The index dedupes on (action_type, session_id), which is right
        // for a conversation-scoped action and wrong here: three conversations
        // each asking for a deploy left three rows, and pressing them in sequence
        // performed three real restarts — every one cutting live sockets. The new
        // reason is appended so no asker's context is lost.
        if (isGlobalIdempotentAction(built.value.actionType)) {
            const enqueued = pendingServerActionsDb.enqueueGenerationBoundGlobal(built.value);
            if (enqueued.inserted) {
                auditLogDb.record('server_action_requested', {
                    userId: req.user?.id ?? null,
                    metadata: {
                        actionType: built.value.actionType,
                        id: built.value.id,
                        sessionId: built.value.sessionId,
                        superseded: enqueued.superseded,
                    },
                    ipAddress: clientIp(req),
                    userAgent: req.headers['user-agent'] ?? null,
                });
            }
            broadcastPendingActionsUpdated(req);
            return res.status(enqueued.inserted ? 201 : 200).json({
                deduped: !enqueued.inserted,
                action: toPublic(enqueued.row, resolveAction),
            });
        }

        const inserted = pendingServerActionsDb.insert(built.value);
        if (inserted === 0) {
            // Deduped against an already-pending request for the same key.
            const existing = pendingServerActionsDb.getPendingByDedup(
                built.value.actionType,
                built.value.sessionId,
                built.value.expectedServerBuildId,
            );
            return res.status(200).json({ deduped: true, action: existing ? toPublic(existing, resolveAction) : null });
        }

        const row = pendingServerActionsDb.getById(built.value.id);
        auditLogDb.record('server_action_requested', {
            userId: req.user?.id ?? null,
            metadata: {
                actionType: built.value.actionType,
                id: built.value.id,
                sessionId: built.value.sessionId,
            },
            ipAddress: clientIp(req),
            userAgent: req.headers['user-agent'] ?? null,
        });
        broadcastPendingActionsUpdated(req);
        return res.status(201).json({ action: toPublic(row, resolveAction) });
    } catch (error) {
        console.error('[system] record pending action failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to record action' });
    }
});

/**
 * SHARED EXECUTION CORE (ADR-066, T-947). The single, literal execution path for
 * an already-persisted queue row, invoked by BOTH POST /pending/:id/execute and
 * POST /actions/:actionType/run so there is exactly one implementation of the
 * CAS claim → per-action authorization → pre-flight gate → detached/foreground
 * spawn sequence (with its audit + WS broadcast + in-flight guard). Extracting it
 * guarantees the two entry points cannot drift in security or idempotency
 * behaviour.
 *
 * The in-flight guard, the CAS double-run guard, and every audit/broadcast are
 * OWNED here, so both routes get them identically. Callers must have passed the
 * coarse route floor (requireRole) already; this function additionally enforces
 * the PER-ACTION minRole (a broad floor lets admin reach an admin-scoped action
 * while still blocking admin from an owner-only one).
 *
 * SECURITY (internet-exposed via Cloudflare tunnel — zero RCE tolerance):
 *   The command executed is resolved from the in-code allowlist by the stored
 *   actionType (getAction) and spawned as a FIXED argv array with shell:false.
 *   NO request body field, query param, header, env value, or DB field is EVER
 *   interpolated into the command, its argv, or its environment.
 *
 * FLOW:
 *   1.  CAS-claim the row ({pending|failed} → executing, B-200). changes !== 1 →
 *       409 (already running / gone). This is the durable double-run guard: an
 *       'executing' row is never claimable, so two racing executes cannot both
 *       proceed. A 'failed' row IS claimable — that is what makes the Retry
 *       button real instead of a permanent 409.
 *   2.  Resolve actionType against the allowlist. null → markFailed + 400.
 *   2.5 Per-action authorization: roleSatisfies(req.user.role, action.minRole).
 *       Fail → resetToPending (the action is valid, this user just can't run it)
 *       + audit + 403. This is the primary enforcement for /pending/:id/execute
 *       (where the coarse floor is admin,owner); /run also pre-checks it.
 *   3.  If the action has a GATE: run the read-only gate and wait.
 *        exit 3 → reset to pending, 200 { status:'deferred' } (respect drain).
 *        exit 4 → reset to pending, 503 (not managed by PM2 — transient).
 *        exit ≠ 0 → markFailed, 500 { code:'gate_failed' }.
 *        exit 0 → audit 'triggered' and proceed.
 *   4a. detachExec action → DELETE the row synchronously (durable before the
 *       process may die), ANSWER the client { status:'restarting' }, flush, THEN
 *       spawn --exec detached+unref (it restarts THIS process). Runs under owner
 *       auth (not a Claude session) so the client restart guard does not fire.
 *   4b. non-detach action (future) → spawn, wait for close (120s cap):
 *       exit 0 → delete + 200 { status:'success' }; else markFailed + 500.
 */
async function executeActionRow(req, res, { id }) {
    if (restartInFlight) {
        return res.status(409).json({
            status: 'error',
            code: 'action_in_flight',
            detail: 'An action is already in progress',
        });
    }
    restartInFlight = true;
    // Set ONLY by the detachExec path, which intentionally keeps the guard held
    // because this process is expected to be replaced by the restart. Every
    // other exit — success, refusal, thrown error — releases it in `finally`.
    let heldForRestart = false;
    let sourceActivationContext = null;
    try {
        const beforeClaim = pendingServerActionsDb.getById(id);
        if (resolveHostUpdateMode() === 'local-main' && beforeClaim?.actionType === 'safe-restart'
            && req.updateActivationTrigger !== 'local-update-activate') {
            return res.status(409).json({ code: 'local_update_button_required', status: 'error' });
        }
        if (beforeClaim?.sourceUpdateJobId) {
            const consentJob = sourceUpdateJobsDb.getById(beforeClaim.sourceUpdateJobId);
            if (req.updateActivationTrigger !== 'update-auto-activate' || !hasCurrentUpdateConsent(sourceUpdateJobsDb, consentJob)
                || consentJob.owner_id !== req.user?.id) return res.status(409).json({ status: 'error', code: 'update_button_confirmation_required' });
        }
        if (beforeClaim?.status === 'superseded') {
            recordActionOutcome(req, beforeClaim, 'gate_failed', { reason: 'superseded' });
            return res.status(409).json({
                status: 'error', code: 'superseded',
                detail: 'The selected server candidate was superseded',
            });
        }
        // (1) Atomic claim: only an ACTIONABLE row (pending or failed — the same
        // set listActionable shows) can be executed. A 'failed' row is claimable
        // so Retry actually works (B-200); 'executing' is still excluded, which
        // is what keeps this the durable double-run guard.
        if (pendingServerActionsDb.claimForExecution(id) !== 1) {
            recordActionOutcome(req, beforeClaim ?? { id }, 'gate_failed', { reason: 'not_claimable' });
            return res.status(409).json({
                status: 'error',
                code: 'not_claimable',
                detail: 'Action is already running or no longer exists',
            });
        }

        const row = pendingServerActionsDb.getById(id);

        // (2) Resolve the action definition (static allowlist OR a valid custom
        // command — T-948 Phase 2). Unknown → fail the row. resolveAction is the
        // single source of the executable argv; no request/DB field is ever
        // interpolated into a command.
        const action = row ? resolveAction(row.actionType) : null;
        if (!action) {
            pendingServerActionsDb.markFailed(id, 'unknown_action');
            recordActionOutcome(req, row, 'gate_failed', { reason: 'unknown_action' });
            broadcastPendingActionsUpdated(req);
            return res.status(400).json({ status: 'error', code: 'unknown_action', detail: 'Action type not permitted' });
        }

        // (2.5) Per-action authorization: the coarse route floor is not enough —
        // an owner-only action must reject an admin even though admin cleared the
        // floor. Reset to pending (the action stays valid for a higher role) and
        // audit the refusal.
        if (!roleSatisfies(req.user?.role, action.minRole)) {
            pendingServerActionsDb.resetToPending(id);
            recordActionOutcome(req, row, 'insufficient_role', { minRole: action.minRole });
            broadcastPendingActionsUpdated(req);
            return res.status(403).json({
                status: 'error',
                code: 'insufficient_role',
                detail: 'Insufficient permissions for this action',
            });
        }

        // (2.6) Command-board config gate (T-948/ADR-067): the owner may disable
        // an action, or restrict which roles run the safe list, from settings.
        // fail-closed — a missing/corrupt config defaults to owner-only.
        if (!canRoleRunAction(req.user?.role, row.actionType)) {
            pendingServerActionsDb.resetToPending(id);
            recordActionOutcome(req, row, 'insufficient_role', { reason: 'config_denied' });
            broadcastPendingActionsUpdated(req);
            return res.status(403).json({
                status: 'error',
                code: 'action_disabled',
                detail: 'Action is disabled or not permitted for your role',
            });
        }

        // Defence in depth for rows created before generation binding existed:
        // no legacy/unbound safe-restart may reach a gate or executable path.
        if (isGlobalIdempotentAction(row.actionType) && !row.expectedServerBuildId) {
            pendingServerActionsDb.markSuperseded(id, 'expected_server_build_id_required');
            recordActionOutcome(req, row, 'gate_failed', { reason: 'expected_server_build_id_required' });
            broadcastPendingActionsUpdated(req);
            return res.status(400).json({
                status: 'error', code: 'expected_server_build_id_required',
                detail: 'Safe restart must be bound to an exact server candidate',
            });
        }

        // Generation-bound restarts are revalidated after the durable claim.
        // Missing manifests and unknown/sensitive changes block fail-closed.
        const sourceUpdate = row.expectedServerBuildId
            ? findSourceUpdateActivation(row)
            : null;
        let serverCandidate = null;
        let localPair = null;
        if (resolveHostUpdateMode() === 'local-main' && row.actionType === 'safe-restart') {
            try {
                localPair = inspectLocalUpdateAction(row);
                if (String(req.user.id) !== (localPair.authority?.ownerId ?? localPair.consent?.ownerId)) throw new Error('local_update_owner_mismatch');
                serverCandidate = { allowed: true, activationKind: 'oid-pair' };
            } catch {
                pendingServerActionsDb.markFailed(id, 'local_update_action_invalid');
                return res.status(409).json({ status: 'error', code: 'local_update_action_invalid' });
            }
        }
        if (row.expectedServerBuildId && !sourceUpdate && !localPair) {
            serverCandidate = inspectButtonBoundServerCandidate(row.expectedServerBuildId, row.id);
            if (!serverCandidate.allowed) {
                if (serverCandidate.code === 'superseded') {
                    pendingServerActionsDb.markSuperseded(id);
                } else {
                    pendingServerActionsDb.markFailed(id, serverCandidate.code);
                }
                recordActionOutcome(req, row, 'gate_failed', { reason: serverCandidate.code });
                broadcastPendingActionsUpdated(req);
                return res.status(serverCandidate.code === 'superseded' ? 409 : 422).json({
                    status: 'error', code: serverCandidate.code, traceId: req.serverActionTraceId,
                    detail: serverCandidate.code === 'superseded'
                        ? 'The selected server candidate was superseded'
                        : 'Server candidate is blocked by the fail-closed classifier',
                });
            }
        }

        const oidPreview = ['oid', 'oid-pair'].includes(serverCandidate?.activationKind);
        if (serverCandidate?.activationKind === 'legacy-resume'
            && !['prepared', 'guard_ready'].includes(serverCandidate.transaction.state)) {
            startActivationGuard(row.expectedServerBuildId, serverCandidate.transaction.state !== 'install_authorized');
            return res.status(202).json({ status: 'restarting', detail: 'Existing activation recovery continues' });
        }
        const executionAction = oidPreview ? {
            ...action,
            // The OID control authority is the launcher embedded in the exact
            // server generation already loaded from dist-server. Neither the
            // mutable root wrapper nor its gate participates in this path; the
            // immutable capsule performs both gates while holding the event lock.
            cmd: process.execPath,
            args: [path.join(APP_ROOT, 'dist-server', 'scripts', 'preview-oid-capsule-launcher.mjs')],
            gateArgs: null,
            cwd: APP_ROOT,
        } : sourceUpdate ? {
            ...action,
            gateArgs: [path.join(APP_ROOT, 'dist-server', 'scripts', 'safe-restart.sh'), '--json'],
            args: [path.join('dist-server', 'scripts', 'safe-restart.sh'), '--exec'],
        } : serverCandidate?.activationKind === 'maintenance' ? {
            ...action,
            gateArgs: [path.join(APP_ROOT, 'dist-server/scripts/safe-restart.sh'), '--json'],
            args: [path.join('dist-server/scripts/safe-restart.sh'), '--exec'],
        } : row.expectedServerBuildId && !oidPreview ? {
            ...action,
            gateArgs: [path.join(
                serverCandidateDirectory(APP_ROOT, row.expectedServerBuildId),
                'scripts', 'safe-restart.sh',
            ), '--json'],
            args: [path.join('dist-server', 'scripts', 'safe-restart.sh'), '--exec'],
        } : action;

        // (2.7) Two-step confirmation contract (ADR-066, T-1677). An action with
        // requiresConfirmation:true (force-restart) must NEVER run while live chat
        // sessions exist until the owner explicitly confirms the count to be
        // killed. We run a READ-ONLY session-detection gate (safe-restart.sh
        // --json) and, if live work/sessions are found, return `confirm_required`
        // WITHOUT executing. The client re-submits with { confirmKillSessions:true,
        // confirmedSessionCount:N }; only then do we set killSessions and proceed.
        // The confirm gate uses the action's own gateArgs, falling back to the
        // MUTABLE-ROOT detector when the execution path carries no gate (the OID
        // capsule path sets gateArgs=null) — session counting must work in every
        // state to ask the owner "kill N sessions?". This runs INSTEAD of the (3)
        // gate below for such actions (which is why (3) is skipped for them).
        let killSessions = false;
        if (action.requiresConfirmation === true) {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const confirmKill = body.confirmKillSessions === true;
            const confirmedCount = Number.isInteger(body.confirmedSessionCount)
                && body.confirmedSessionCount >= 0 ? body.confirmedSessionCount : null;
            const confirmGate = {
                ...executionAction,
                gateArgs: executionAction.gateArgs
                    || [path.join(APP_ROOT, 'scripts', 'safe-restart.sh'), '--json'],
            };
            const gate = await runActionGate(confirmGate);

            if (gate.code === 4) {
                pendingServerActionsDb.resetToPending(id, 'proc_not_in_pm2');
                recordActionOutcome(req, row, 'not_in_pm2');
                broadcastPendingActionsUpdated(req);
                return res.status(503).json({
                    status: 'error', code: 'proc_not_in_pm2',
                    detail: 'Service is not managed by the process manager',
                });
            }
            if (gate.code === 3 || gate.code === 6) {
                const s = parseGateSessions(gate.stdout);
                const reasonCode = gate.code === 6 ? 'live_sessions' : 'live_work';
                const currentCount = gate.code === 6
                    ? (typeof s.sessionCount === 'number' ? s.sessionCount : 0)
                    : (typeof s.liveCount === 'number' ? s.liveCount : 0);
                const liveSessions = attachSessionTitles(
                    s.liveSessions, typeof req.user?.id === 'number' ? req.user.id : null,
                );
                // Ask again when NOT confirmed, no count supplied, or the live set
                // GREW past what the owner authorised (stale-confirmation guard).
                if (needsKillConfirmation({ confirmKill, confirmedCount, currentCount })) {
                    pendingServerActionsDb.resetToPending(id, reasonCode);
                    recordActionOutcome(req, row, 'confirm_required', {
                        reasonCode, sessionCount: s.sessionCount, confirmedSessionCount: confirmedCount,
                    });
                    broadcastPendingActionsUpdated(req);
                    return res.status(200).json({
                        status: 'confirm_required',
                        reasonCode,
                        sessionCount: s.sessionCount,
                        liveSessions,
                        liveCount: s.liveCount,
                        sessionServerPid: s.sessionServerPid,
                        detail: reasonCode === 'live_sessions'
                            ? `Confirm killing ${currentCount} live session(s) before restart`
                            : `Confirm overriding ${currentCount} live workflow(s) before restart`,
                    });
                }
                // Confirmed AND the live set did not grow beyond N → force-kill.
                killSessions = true;
                recordActionOutcome(req, row, 'triggered', {
                    forced: true, killSessions: true, sessionCount: s.sessionCount,
                });
            } else if (gate.code !== 0) {
                pendingServerActionsDb.markFailed(id, `gate_failed:${gate.code}`);
                recordActionOutcome(req, row, 'gate_failed', { exitCode: gate.code });
                broadcastPendingActionsUpdated(req);
                return res.status(500).json({
                    status: 'error', code: 'gate_failed',
                    detail: `Pre-action safety check failed (exit ${gate.code})`,
                    exitCode: gate.code,
                });
            }
            // gate.code === 0 → no live work/sessions → no confirmation needed.
        }

        // (3) Pre-flight gate (if any). Skipped for requiresConfirmation actions:
        // they already ran their own (2.7) gate, and re-running it here would
        // re-detect the very sessions the owner just confirmed and defer them.
        if (!action.requiresConfirmation && executionAction.gateArgs) {
            const gate = await runActionGate(executionAction);

            if (gate.code === 3) {
                let detail = 'Live work in progress; action deferred';
                let liveCount = null;
                try {
                    const parsed = JSON.parse(gate.stdout);
                    if (parsed && typeof parsed.liveCount === 'number') {
                        liveCount = parsed.liveCount;
                        detail = `Live work in progress (${parsed.liveCount}); action deferred`;
                    }
                } catch {
                    // keep the generic detail
                }
                pendingServerActionsDb.resetToPending(id, 'live_work');
                recordActionOutcome(req, row, 'deferred', { reason: 'live_work', liveCount });
                broadcastPendingActionsUpdated(req);
                return res.status(200).json({ status: 'deferred', reason: 'live-work', reasonCode: 'live_work', retryable: true, detail });
            }

            if (gate.code === 4) {
                // Not managed by PM2 — transient/environmental. Return to pending
                // so a retry works once PM2 manages the process again.
                pendingServerActionsDb.resetToPending(id, 'proc_not_in_pm2');
                recordActionOutcome(req, row, 'not_in_pm2');
                broadcastPendingActionsUpdated(req);
                return res.status(503).json({
                    status: 'error',
                    code: 'proc_not_in_pm2',
                    detail: 'Service is not managed by the process manager',
                });
            }

            if (gate.code === 6) {
                // safe-restart deferred because live INTERACTIVE chat sessions are
                // OS children/grandchildren of the server (T-880). This is the SAME
                // outcome CLASS as code 3 (live-work): a SAFE deferral — nothing was
                // restarted, the row stays valid and retryable — so it shares the
                // 200 { status:'deferred' } contract the client already consumes for
                // code 3 (chosen over 409 for exactly that parity; B-193). The
                // blocking sessions are parsed from the --json gate stdout so the
                // client can show WHO is blocking (never used to build a command).
                const s = parseGateSessions(gate.stdout);
                const sessionCount = s.sessionCount;
                // B-270: enrich with the conversation titles the owner recognises;
                // visibility-filtered, never throws.
                const liveSessions = attachSessionTitles(
                    s.liveSessions,
                    typeof req.user?.id === 'number' ? req.user.id : null,
                );
                const sessionServerPid = s.sessionServerPid;
                const detail = typeof sessionCount === 'number'
                    ? `Live interactive sessions in progress (${sessionCount}); restart deferred`
                    : 'Live interactive sessions in progress; restart deferred';
                pendingServerActionsDb.resetToPending(id, 'live_sessions');
                recordActionOutcome(req, row, 'deferred', { reason: 'live-sessions', sessionCount });
                broadcastPendingActionsUpdated(req);
                return res.status(200).json({
                    status: 'deferred',
                    reason: 'live-sessions', reasonCode: 'live_sessions', retryable: true,
                    detail,
                    sessionCount,
                    liveSessions,
                    sessionServerPid,
                });
            }

            if (gate.code !== 0) {
                pendingServerActionsDb.markFailed(id, `gate_failed:${gate.code}`);
                recordActionOutcome(req, row, 'gate_failed', { exitCode: gate.code });
                broadcastPendingActionsUpdated(req);
                return res.status(500).json({
                    status: 'error',
                    code: 'gate_failed',
                    // B-302: carry the exit code. A gate that fails for an
                    // ENVIRONMENTAL reason (2 = read/config error, e.g. an
                    // unresolvable transcript root) used to reach the operator as
                    // a bare "unexpected error", indistinguishable from a real
                    // safety refusal — four retries and a wrong diagnosis later,
                    // the number was the only thing that identified it. It is an
                    // integer, not a command or a path: nothing executable leaks.
                    detail: `Pre-action safety check failed (exit ${gate.code})`,
                    exitCode: gate.code,
                });
            }
        }

        // (4) Gate passed (or no gate). Execute.
        if (sourceUpdate) {
            try {
                sourceActivationContext = await executeSourceUpdateActivation(row, sourceUpdate);
            } catch (error) {
                pendingServerActionsDb.markFailed(id, 'source_update_activation_failed');
                recordActionOutcome(req, row, 'failed', { reason: 'source_update_activation_failed' });
                broadcastPendingActionsUpdated(req);
                return res.status(500).json({
                    status: 'error', code: 'source_update_activation_failed',
                    detail: 'The governed source update could not be activated',
                });
            }
        } else if (row.expectedServerBuildId && !oidPreview && serverCandidate?.activationKind === 'maintenance') {
            if (inspectLegacyRestartDisposition(row.expectedServerBuildId, row.id).activationKind !== 'maintenance') {
                pendingServerActionsDb.markFailed(id, 'node_update_button_required');
                return res.status(409).json({ status: 'error', code: 'node_update_button_required' });
            }
        } else if (row.expectedServerBuildId && !oidPreview) {
            const disposition = inspectLegacyRestartDisposition(row.expectedServerBuildId, row.id);
            if (disposition.activationKind !== 'legacy-resume') {
                pendingServerActionsDb.markFailed(id, 'node_update_button_required');
                return res.status(409).json({ status: 'error', code: 'node_update_button_required' });
            }
            const candidate = inspectServerCandidate(row.expectedServerBuildId);
            if (!candidate.allowed) {
                pendingServerActionsDb.markSuperseded(id, candidate.code);
                recordActionOutcome(req, row, 'gate_failed', { reason: candidate.code });
                broadcastPendingActionsUpdated(req);
                return res.status(409).json({
                    status: 'error', code: 'superseded',
                    detail: 'The selected server candidate changed during the safety check',
                });
            }
            // The already-authorized matching transaction is retained; no new legacy transaction is created.
            startActivationGuard(row.expectedServerBuildId);
            if (!await waitForActivationGuard(row.expectedServerBuildId)) {
                transitionActivationTransaction(row.expectedServerBuildId, ['prepared', 'guard_ready'], {
                    state: 'deferred', error: 'activation_guard_unavailable',
                });
                pendingServerActionsDb.resetToPending(id);
                broadcastPendingActionsUpdated(req);
                return res.status(503).json({
                    status: 'error', code: 'activation_guard_unavailable',
                    detail: 'Server activation guard did not acquire the build lock',
                });
            }
            // The guard now owns the shared build lock. Re-read under that lock
            // before authorizing the fixed restart so A can never silently apply B.
            const lockedCandidate = inspectServerCandidate(row.expectedServerBuildId);
            if (!lockedCandidate.allowed) {
                transitionActivationTransaction(row.expectedServerBuildId, ['guard_ready'], {
                    state: 'superseded', error: 'candidate_changed_before_restart',
                });
                pendingServerActionsDb.markSuperseded(id);
                recordActionOutcome(req, row, 'gate_failed', { reason: 'candidate_changed_before_restart' });
                broadcastPendingActionsUpdated(req);
                return res.status(409).json({ status: 'error', code: 'superseded' });
            }
        }
        recordActionOutcome(req, row, 'triggered', { reason: row?.reason ?? null });

        if (executionAction.detachExec) {
            if (oidPreview) {
                // The loaded launcher remains alive until the immutable
                // supervisor reaches a terminal journal. Observe that exit so a
                // safe deferral is reported as deferred (and retryable), not as
                // the optimistic "restarting" used by legacy fire-and-forget.
                return await new Promise((resolve) => {
                    let child;
                    let settled = false;
                    const finish = (callback) => {
                        if (settled) return;
                        settled = true;
                        callback();
                        resolve(undefined);
                    };
                    try {
                        const logFd = fs.openSync(RESTART_LOG_PATH, 'a');
                        child = spawn(executionAction.cmd, [...executionAction.args], {
                            cwd: executionAction.cwd,
                            env: { ...process.env, NASSAJ_OID_ACTION_ID: id,
                                ...(localPair ? { NASSAJ_OID_PAIR_SEQUENCE: String(localPair.sequence),
                                    NASSAJ_OID_PAIR_TARGET_DIGEST: localPair.targetDigest,
                                    NASSAJ_OID_PAIR_OWNER_ID: String(req.user.id),
                                    NASSAJ_OID_PAIR_DATABASE_PATH: LIVE_DATABASE_PATH } : {}),
                                NASSAJ_OID_ATTEMPT_NONCE: row.executionAttemptNonce,
                                NASSAJ_OID_EXPECTED_BUILD_ID: row.expectedServerBuildId,
                                // force-restart (T-1677): env-var kill signal that
                                // reaches safe-restart.sh through the OID capsule
                                // (which decides its own argv) unchanged.
                                ...(killSessions ? { NASSAJ_RESTART_KILL_SESSIONS: '1' } : {}) },
                            detached: true,
                            stdio: ['ignore', logFd, logFd],
                        });
                        child.unref();
                        fs.closeSync(logFd);
                    } catch (error) {
                        pendingServerActionsDb.settleExecution(id, row.executionAttemptNonce,
                            row.expectedServerBuildId, 'pending', 'oid_launch_failed');
                        recordActionOutcome(req, row, 'failed', { reason: 'oid_launch_failed' });
                        return finish(() => res.status(500).json({
                            status: 'error', code: 'exec_failed', reasonCode: 'oid_launch_failed', retryable: true,
                        }));
                    }
                    child.once('error', () => finish(() => {
                        pendingServerActionsDb.settleExecution(id, row.executionAttemptNonce,
                            row.expectedServerBuildId, 'pending', 'oid_launch_failed');
                        recordActionOutcome(req, row, 'failed', { reason: 'oid_launch_failed' });
                        broadcastPendingActionsUpdated(req);
                        res.status(500).json({ status: 'error', code: 'exec_failed', retryable: true });
                    }));
                    child.once('exit', () => finish(() => {
                        // An exit code is transport evidence, never an activation
                        // receipt. A resumed older transaction cannot satisfy this click.
                        const receipt = exactOidActionReceipt(row);
                        const outcome = receipt ? settleOidReceipt(row, receipt) : null;
                        if (!outcome) {
                            recordActionOutcome(req, row, 'failed', { reason: 'execution_unresolved' });
                            broadcastPendingActionsUpdated(req);
                            res.status(503).json({ status: 'error', code: 'execution_unresolved',
                                reasonCode: 'execution_unresolved', retryable: false });
                            return;
                        }
                        recordActionOutcome(req, row, outcome.retryable ? 'deferred' : 'completed',
                            { reason: outcome.reasonCode });
                        broadcastPendingActionsUpdated(req);
                        const status = outcome.reasonCode === 'oid_loaded' ? 'success'
                            : outcome.retryable ? 'deferred' : 'error';
                        res.status(outcome.reasonCode === 'superseded' ? 409 : status === 'error' ? 500 : 200).json({ status,
                            code: outcome.reasonCode, reason: outcome.reasonCode,
                            reasonCode: outcome.reasonCode, retryable: outcome.retryable });
                    }));
                    return undefined;
                });
            }
            if (serverCandidate?.activationKind === 'legacy-resume') {
                const authorized = transitionActivationTransaction(
                    row.expectedServerBuildId,
                    ['guard_ready'],
                    { state: 'install_authorized' },
                );
                if (!authorized || !await waitForActivationState(row.expectedServerBuildId, 'candidate_installed')) {
                    pendingServerActionsDb.resetToPending(id);
                    return res.status(503).json({ status: 'error', code: 'candidate_install_failed' });
                }
                const launched = transitionActivationTransaction(
                    row.expectedServerBuildId,
                    ['candidate_installed'],
                    { state: 'restart_spawned' },
                );
                if (!launched) {
                    pendingServerActionsDb.markSuperseded(id, 'activation_transaction_changed');
                    return res.status(409).json({ status: 'error', code: 'superseded' });
                }
            }
            // (4a) The action restarts THIS process. SETTLE the row FIRST
            // (synchronous + durable) so even if we die before flushing, no row
            // is left claiming to be running. Then answer, flush, spawn
            // detached+unref.
            //
            // WHY 'execution_unresolved' AND NOT 'succeeded' (T-1684). This is
            // the legacy restart path: it has no activation receipt, so at this
            // instant the ONLY proven fact is that a restart was launched — not
            // that the server came back, and not on which build. Recording a
            // success here would make the history tab lie every time
            // safe-restart.sh deferred or the boot failed. The row therefore
            // settles as an UNKNOWN outcome (rendered as such, still retryable),
            // and if the child reports back that no restart happened,
            // reenqueueRow puts it back on the queue. The OID path, which does
            // have receipts, settles to 'succeeded' through settleExecution.
            if (sourceActivationContext) pendingServerActionsDb.resetToPending(id);
            else if (!oidPreview) pendingServerActionsDb.markFailed(id, 'execution_unresolved');
            // A global action satisfies every OTHER row waiting for the same
            // work, so they must go with it. Leaving them queued is precisely
            // what turned one needed restart into a sequence of them, each one
            // draining live sockets. Rows created AFTER this point survive: they
            // asked for a deploy of something newer than what is about to run.
            // They are SETTLED as history rather than deleted (T-1684) so the
            // owner can still see that their request was satisfied.
            if (!sourceActivationContext && !oidPreview && isGlobalIdempotentAction(row?.actionType ?? '')) {
                const alsoSatisfied = pendingServerActionsDb.supersedeSiblings(
                    row.actionType,
                    id,
                    row.expectedServerBuildId,
                );
                if (alsoSatisfied > 0) {
                    console.log(
                        `[system] safe-restart satisfied ${alsoSatisfied} other queued request(s) `
                        + 'for the same action — settled as history instead of restarting again'
                    );
                }
            }
            broadcastPendingActionsUpdated(req);

            res.status(200).json({ status: 'restarting' });
            if (typeof res.flush === 'function') {
                res.flush();
            }

            // Re-enqueues the row settled above, for any path where it turns out
            // no restart will happen. Since T-1684 that row still EXISTS (as
            // unresolved history), so requeueSettled moves it back to 'pending'
            // rather than the old delete-then-insert; the insert branch stays for
            // a row a concurrent prune/dismiss removed. Idempotent-ish: the
            // insert is dedup-tolerant, so a double call cannot duplicate it.
            const reenqueueRow = async (outcome, extra = {}) => {
                try {
                    if (sourceActivationContext) {
                        await sourceActivationContext.rollback(String(extra.reason || outcome || 'runtime_verification_failed'));
                        sourceActivationContext = null;
                    } else if (serverCandidate?.activationKind === 'legacy-resume') {
                        transitionActivationTransaction(
                            row.expectedServerBuildId,
                            ['restart_spawned', 'awaiting_readiness'],
                            { state: 'rolling_back', error: String(extra.reason || outcome).slice(0, 200) },
                        );
                    }
                    // A source update action is bound to an immutable job/action
                    // identity. After rollback it is terminal and must never be
                    // recreated as a generic restart missing that identity.
                    if (row && !sourceUpdate) {
                        if (pendingServerActionsDb.getById(row.id)) {
                            pendingServerActionsDb.requeueSettled(row.id);
                        } else {
                            pendingServerActionsDb.insert({
                                id: row.id,
                                actionType: row.actionType,
                                sessionId: row.sessionId,
                                reason: row.reason,
                                requestedBy: row.requestedBy,
                                expectedServerBuildId: row.expectedServerBuildId,
                            });
                        }
                    }
                    recordActionOutcome(req, row, outcome, extra);
                    broadcastPendingActionsUpdated(req);
                } catch (recoveryError) {
                    console.error('[system] action exec recovery failed:', recoveryError.message);
                    if (sourceUpdate && row?.sourceUpdateJobId) {
                        const identity = {
                            jobId: row.sourceUpdateJobId,
                            transactionId: row.sourceUpdateTransactionId,
                            activationIdentitySha256: row.activationIdentitySha256,
                        };
                        sourceUpdateJobsDb.transitionActivation(identity, [
                            'activating', 'runtime_verifying', 'rollback_pending',
                        ], 'manual_recovery_required');
                        pendingServerActionsDb.markFailed(row.id, 'source_update_manual_recovery_required');
                    }
                }
            };

            try {
                const logFd = fs.openSync(RESTART_LOG_PATH, 'a');
                const child = spawn(executionAction.cmd, [...executionAction.args], {
                    cwd: executionAction.cwd,
                    // force-restart (T-1677): NASSAJ_RESTART_KILL_SESSIONS reaches
                    // safe-restart.sh through the legacy (preview-oid-owner-action)
                    // path via the inherited environment.
                    env: oidPreview
                        ? { ...process.env, NASSAJ_OID_ACTION_ID: id, ...(killSessions ? { NASSAJ_RESTART_KILL_SESSIONS: '1' } : {}) }
                        : (killSessions ? { ...process.env, NASSAJ_RESTART_KILL_SESSIONS: '1' } : process.env),
                    detached: true,
                    stdio: ['ignore', logFd, logFd],
                });
                child.unref();
                fs.closeSync(logFd);
                // Spawn launched. Hold the in-flight guard: this process is
                // EXPECTED to be replaced by the restart, so releasing it in
                // `finally` would be wrong.
                heldForRestart = true;

                // …but "expected" is not "guaranteed". safe-restart.sh re-checks
                // for live workflows/sessions AFTER the pre-flight gate and can
                // still refuse (exit 3 = live workflow, 6 = live interactive
                // session, 2/4/5 = error). In that case we are still alive with
                // the row deleted and the guard held ⇒ every later execute 409s
                // and the only cure is the manual restart that was just refused
                // (B-199). A non-zero exit reaching us PROVES no restart happened
                // (had it happened, this process would be gone), so recover:
                // put the row back and release the guard.
                child.on('exit', (code, signal) => {
                    if (code === 0) {
                        // OID launcher remains alive across the handshake and
                        // exits zero only after a terminal loaded/rolled_back
                        // journal. A supervisor death exits non-zero and the
                        // existing claimed row is reset for an explicit resume.
                        if (oidPreview) {
                            pendingServerActionsDb.markSuperseded(id, 'oid_control_terminal');
                            if (isGlobalIdempotentAction(row?.actionType ?? '')) {
                                pendingServerActionsDb.supersedeSiblings(
                                    row.actionType, id, row.expectedServerBuildId,
                                );
                            }
                            broadcastPendingActionsUpdated(req);
                        }
                        return; // restart under way; we are on our way out
                    }
                    if (serverCandidate?.activationKind === 'legacy-resume') {
                        transitionActivationTransaction(
                            row.expectedServerBuildId,
                            ['restart_spawned', 'awaiting_readiness'],
                            { state: 'rolling_back', error: `safe_restart_not_started:${code}` },
                        );
                    }
                    if (restartFlagSafetyTimer) {
                        clearTimeout(restartFlagSafetyTimer);
                        restartFlagSafetyTimer = null;
                    }
                    restartInFlight = false;
                    console.error(`[system] detached --exec exited without restarting (code=${code}, signal=${signal}); action re-queued`);
                    void reenqueueRow('deferred', { reason: 'exec_declined', exitCode: code });
                });
                child.on('error', (error) => {
                    if (serverCandidate?.activationKind === 'legacy-resume') {
                        transitionActivationTransaction(
                            row.expectedServerBuildId,
                            ['restart_spawned', 'awaiting_readiness'],
                            { state: 'rolling_back', error: 'safe_restart_spawn_failed' },
                        );
                    }
                    restartInFlight = false;
                    console.error('[system] detached --exec child error:', error.message);
                    void reenqueueRow('exec_failed', { detail: error.message });
                });

                // Last-resort net: if the child never reports (unref'd handle
                // lost, signal missed) and we are somehow still alive, do not
                // stay wedged forever.
                scheduleRestartFlagRelease(() => { void reenqueueRow('deferred', { reason: 'restart_timeout' }); });
                return undefined;
            } catch (error) {
                // Spawn FAILED → no restart will happen, so recover fully or the
                // queue loses the row and the endpoint wedges. The row was
                // deleted above; the 'restarting' reply was already sent and
                // can't be recalled. So: (1) re-enqueue the row (status='pending',
                // dedup-tolerant) so it reappears on the board for retry; (2)
                // release the in-flight guard — no restart consumed it, else every
                // future execute would 409 until a real restart; (3) audit the
                // failure; (4) broadcast so the UI re-fetches and shows it again.
                // /health polling then sees restartRequired unchanged + the action
                // back (hasPendingActions=true), so the client recovers.
                console.error('[system] action exec spawn failed:', error.message);
                await reenqueueRow('exec_failed', { detail: error.message });
                return undefined;
            }
        }

        // (4b) Non-detached action (future): spawn, observe, bound by 120s.
        await runForegroundAction(req, res, executionAction, id, row);
        return undefined;
    } catch (error) {
        console.error('[system] execute action failed:', error.message);
        if (!res.headersSent) {
            return res.status(500).json({ status: 'error', code: 'internal', detail: 'Action failed' });
        }
        return undefined;
    } finally {
        // Released HERE for every path except the detached restart, which holds
        // it deliberately (and is itself bounded by the child 'exit' handler and
        // the safety timer above). Previously each branch assigned the flag by
        // hand while a comment claimed a `finally` that did not exist — a single
        // missed branch (or any throw) left the endpoint 409ing until a restart.
        if (!heldForRestart) restartInFlight = false;
    }
}

/**
 * Execute a queued action row as a named user, without an HTTP request (T-1751:
 * the owner consented to activation when starting the update). Every gate of the
 * button path runs unchanged — claim, role, config, candidate, safe-restart gate;
 * this only supplies the request shape executeActionRow reads and captures the
 * reply it would have sent.
 *
 * @param {{ id: number, user: { id: number, role: string }, wss?: object|null, trigger: string }} input
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function executeActionRowAs({ id, user, wss = null, trigger }) {
    const reply = { status: 200, body: null };
    const req = {
        user, body: {}, updateActivationTrigger: trigger, app: { locals: { wss } },
        headers: { 'user-agent': `nassaj-${trigger}` }, socket: {},
    };
    const res = {
        headersSent: false,
        status(code) { reply.status = code; return this; },
        json(body) { reply.body = body; this.headersSent = true; return this; },
        flush() {},
    };
    await executeActionRow(req, res, { id });
    return reply;
}

// POST /api/system/pending/:id/execute — execute a QUEUED action by row id.
//
// Floor is requireRole('user','admin','owner') — every authenticated role clears
// the coarse floor; the REAL authorization is the two per-action gates inside
// executeActionRow: roleSatisfies(role, action.minRole) AND canRoleRunAction(role,
// actionType) (config-driven, fail-closed). A 'user' therefore reaches the core
// but, with the default user mode 'none' and safe-restart's minRole 'owner', is
// still rejected (row reset to pending). All CAS/gate/spawn/audit/WS behaviour
// lives in the shared executeActionRow.
router.post(
    '/pending/:id/execute',
    restartLimiter,
    requireRole('user', 'admin', 'owner'),
    (req, res) => executeActionRow(req, res, { id: req.params.id })
);

// POST /api/system/actions/:actionType/run — record-then-run in one call, driving
// the inline run button in the chat (ADR-066, T-947). Body: { sessionId?, reason? }.
//
// Coarse floor: requireRole('admin','owner') — this MUST be ≥ the widest minRole in
// the allowlist so no allowlisted action is unreachable by its intended role. The
// per-action minRole is then enforced (a) here (before creating a row) and (b)
// again inside executeActionRow (defence in depth). The response is the SAME
// ExecuteOutcome as /pending/:id/execute (restarting|deferred|success|error…).
router.post(
    '/actions/:actionType/run',
    restartLimiter,
    requireRole('admin', 'owner'),
    async (req, res) => {
        const { actionType } = req.params;

        // (1) Resolve against the unified allowlist (static action OR a currently-
        // valid custom command — T-948 Phase 2). Unknown → reject (never run).
        const action = resolveAction(actionType);
        if (!action) {
            return res.status(400).json({ status: 'error', code: 'unknown_action', detail: 'Action type not permitted' });
        }

        // (2) Per-action authorization BEFORE creating any row (no side effect on a
        // refused request). executeActionRow re-checks BOTH gates as defence in
        // depth. Gate (a): the per-action minRole hierarchy.
        if (!roleSatisfies(req.user?.role, action.minRole)) {
            recordActionOutcome(req, { actionType, id: null, sessionId: null }, 'insufficient_role', {
                minRole: action.minRole,
            });
            return res.status(403).json({
                status: 'error',
                code: 'insufficient_role',
                detail: 'Insufficient permissions for this action',
            });
        }

        // (2b) Gate (b): the command-board config (B-192). The owner may disable an
        // action, or gate which roles run the safe/custom lists, from settings.
        // fail-closed — a missing/corrupt config defaults to owner-only. This MUST
        // run BEFORE any row is inserted so a config-denied request has zero side
        // effect (no queue row, no audit-of-a-triggered-action).
        if (!canRoleRunAction(req.user?.role, actionType)) {
            recordActionOutcome(req, { actionType, id: null, sessionId: null }, 'insufficient_role', {
                reason: 'config_denied',
            });
            return res.status(403).json({
                status: 'error',
                code: 'action_disabled',
                detail: 'Action is disabled or not permitted for your role',
            });
        }

        // (3) Build + validate the pending row from the (static OR custom) key +
        // optional body fields (buildPendingAction re-validates actionType/sessionId
        // against the same unified allowlist used above).
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        if (isGlobalIdempotentAction(actionType) && !body.expectedServerBuildId) {
            return res.status(400).json({
                status: 'error', code: 'expected_server_build_id_required',
                detail: 'Local-preview restart must be bound to the visible server candidate',
            });
        }
        const built = buildPendingAction({
            actionType,
            sessionId: body.sessionId,
            reason: body.reason,
            expectedServerBuildId: body.expectedServerBuildId,
            requestedBy: typeof req.user?.username === 'string' ? req.user.username : null,
        }, { isAllowed: isKnownActionType });
        if (!built.ok) {
            return res.status(400).json({ status: 'error', code: 'invalid_action', detail: built.error });
        }

        if (built.value.expectedServerBuildId) {
            const sourceUpdate = findSourceUpdateActivation(built.value);
            const candidate = sourceUpdate ? null : inspectButtonBoundServerCandidate(built.value.expectedServerBuildId, built.value.id);
            if (candidate && !candidate.allowed) {
                const stale = candidate.code === 'superseded';
                recordActionOutcome(req, built.value, 'gate_failed', { reason: candidate.code });
                return res.status(stale ? 409 : 422).json({
                    status: 'error', code: candidate.code, traceId: req.serverActionTraceId,
                    detail: stale ? 'The selected server candidate was superseded' : 'Server candidate is blocked by the fail-closed classifier',
                });
            }
        }

        // (4) Insert (dedup-tolerant). A still-pending row for the same
        // (actionType, sessionId) is REUSED rather than duplicated, so a repeated
        // click collapses onto the existing row — identical to POST /pending.
        let targetId = built.value.id;
        try {
            const generationEnqueue = isGlobalIdempotentAction(built.value.actionType)
                ? pendingServerActionsDb.enqueueGenerationBoundGlobal(built.value)
                : null;
            const inserted = generationEnqueue ? (generationEnqueue.inserted ? 1 : 0)
                : pendingServerActionsDb.insert(built.value);
            if (generationEnqueue) targetId = generationEnqueue.row.id;
            if (inserted === 0) {
                const existing = generationEnqueue?.row ?? pendingServerActionsDb.getPendingByDedup(
                    built.value.actionType,
                    built.value.sessionId,
                    built.value.expectedServerBuildId,
                );
                if (!existing) {
                    // Raced: the pending row was claimed/removed between insert and
                    // lookup. Nothing to execute; surface as not-claimable (transient).
                    return res.status(409).json({
                        status: 'error',
                        code: 'not_claimable',
                        detail: 'Action is not pending or does not exist',
                    });
                }
                targetId = existing.id;
            } else {
                // A genuinely new row — record the request for the audit trail, on
                // parity with POST /pending (executeActionRow records the outcome).
                auditLogDb.record('server_action_requested', {
                    userId: req.user?.id ?? null,
                    metadata: {
                        actionType: built.value.actionType,
                        id: built.value.id,
                        sessionId: built.value.sessionId,
                        superseded: generationEnqueue?.superseded ?? 0,
                    },
                    ipAddress: clientIp(req),
                    userAgent: req.headers['user-agent'] ?? null,
                });
            }
        } catch (error) {
            console.error('[system] run action insert failed:', error.message);
            return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to record action' });
        }

        // (5) Execute the resulting row through the SAME core as /pending/:id/execute.
        return executeActionRow(req, res, { id: targetId });
    }
);

// Hard cap on a foreground (non-detached) action before we stop observing it.
const FOREGROUND_ACTION_TIMEOUT_MS = 120_000;

/**
 * Runs a non-detached allowlisted action to completion (fixed argv, shell:false),
 * bounded by FOREGROUND_ACTION_TIMEOUT_MS. exit 0 → settle 'succeeded' + 200;
 * anything else (or a timeout / spawn error) → markFailed + 500. A single-
 * response guard covers the close/error/timeout race. Reserved for future
 * (non-restart) actions; safe-restart uses the detached path above.
 */
function runForegroundAction(req, res, action, id, row) {
    return new Promise((resolve) => {
        let child;
        try {
            // CRITICAL (T-948): a custom command (detachExec:false) runs HERE. It
            // must NOT inherit the server's full process.env (JWT_SECRET,
            // DATABASE_PATH, provider keys). action.env — the curated, secret-free
            // passthrough built by getCustomAction (cleanSpawnEnv) — is honoured
            // when present. Static actions (safe-restart) set no env and keep the
            // full inherited environment on purpose via the detached path above;
            // they never reach this foreground spawn.
            child = spawn(action.cmd, [...action.args], {
                cwd: action.cwd,
                ...(action.env ? { env: action.env } : {}),
            });
        } catch (error) {
            pendingServerActionsDb.markFailed(id, `spawn_failed:${error.message}`);
            recordActionOutcome(req, row, 'failed', { reason: 'spawn_failed' });
            broadcastPendingActionsUpdated(req);
            if (!res.headersSent) {
                res.status(500).json({ status: 'error', code: 'exec_failed', detail: 'Failed to launch action' });
            }
            resolve();
            return;
        }

        let settled = false;
        const finish = (fn) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
            resolve();
        };

        // Drain stdio so buffers can't stall the child; content is not surfaced.
        if (child.stdout) child.stdout.on('data', () => {});
        if (child.stderr) child.stderr.on('data', () => {});

        const timer = setTimeout(() => {
            finish(() => {
                pendingServerActionsDb.markFailed(id, 'timeout');
                recordActionOutcome(req, row, 'failed', { reason: 'timeout' });
                broadcastPendingActionsUpdated(req);
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', code: 'timeout', detail: 'Action timed out' });
                }
            });
        }, FOREGROUND_ACTION_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();

        child.on('error', (error) => {
            finish(() => {
                pendingServerActionsDb.markFailed(id, `error:${error.message}`);
                recordActionOutcome(req, row, 'failed', { reason: 'process_error' });
                broadcastPendingActionsUpdated(req);
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', code: 'exec_failed', detail: 'Action failed to run' });
                }
            });
        });

        child.on('close', (code) => {
            finish(() => {
                if (code === 0) {
                    // exit 0 IS the evidence, so this is the one path that may
                    // record a success outright (T-1684 — it used to delete the
                    // row, leaving no trace that the command had ever run).
                    pendingServerActionsDb.markSucceeded(id, 'exit_0');
                    recordActionOutcome(req, row, 'completed', { exitCode: code });
                    broadcastPendingActionsUpdated(req);
                    if (!res.headersSent) {
                        res.status(200).json({ status: 'success' });
                    }
                } else {
                    pendingServerActionsDb.markFailed(id, `exit:${code}`);
                    recordActionOutcome(req, row, 'failed', { exitCode: code });
                    broadcastPendingActionsUpdated(req);
                    if (!res.headersSent) {
                        res.status(500).json({ status: 'error', code: 'exec_failed', detail: `Action exited with code ${code}` });
                    }
                }
            });
        });
    });
}

// DELETE /api/system/pending/:id — manual dismissal of a queued action (without
// executing it) OR removal of a settled HISTORY row before its hour is up
// (T-1684): dismissById deletes any row that is not mid-execution, so both are
// the same operation on the same id. Floor aligned to requireRole('admin',
// 'owner') for consistency with the execute path (dismissing is strictly less
// privileged than executing). Idempotent: a missing/absent id is not an error
// (the board converges to "gone" either way).
router.delete('/pending/:id', requireRole('admin', 'owner'), (req, res) => {
    const { id } = req.params;
    try {
        const dismissed = pendingServerActionsDb.dismissById(id);
        if (!dismissed && pendingServerActionsDb.getById(id)?.status === 'executing') {
            recordActionOutcome(req, { id }, 'gate_failed', { reason: 'execution_unresolved' });
            return res.status(409).json({ status: 'error', code: 'execution_unresolved', retryable: false });
        }
        auditLogDb.record('server_action_dismiss', {
            userId: req.user?.id ?? null,
            metadata: { id },
            ipAddress: clientIp(req),
            userAgent: req.headers['user-agent'] ?? null,
        });
        broadcastPendingActionsUpdated(req);
        return res.json({ status: 'dismissed', id });
    } catch (error) {
        console.error('[system] dismiss pending action failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to dismiss action' });
    }
});

export default router;
