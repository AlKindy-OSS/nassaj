#!/usr/bin/env node

// Load environment variables before other imports execute
import './load-env.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import { spawn as spawnChildProcess } from 'child_process';
import os from 'os';
import http from 'http';
import crypto from 'node:crypto';

import express from 'express';
import cors from 'cors';
import mime from 'mime-types';
import Database from 'better-sqlite3';

import { AppError, WORKSPACES_ROOT, getOpenCodeDatabasePath, validateWorkspacePath } from '@/shared/utils.js';
import { closeSessionsWatcher, forkSessionAtMessage, forkSessionFromSideQuery, initializeSessionsWatcher, isSessionAccessibleByUser, setEngineSwitchLivenessProbe, setSessionLivenessProbes, startCostLedgerScheduler, stopCostLedgerScheduler } from '@/modules/providers/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';
import { dispatchProviderCommand, isSessionWritableByUser } from '@/modules/websocket/services/chat-websocket.service.js';
import { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import { createScheduledMessagesRouter, createScheduledMessagesService } from '@/modules/scheduled-messages/index.js';
import {
    closeUniversalConversationShadowRuntime,
    createUniversalConversationShadowCoreResolver,
    universalConversationShadowHook,
} from '@/modules/conversations/index.js';
import { createShutdownDrain, resolveDrainTimeoutMs } from '@/services/shutdown-drain.service.js';
import { listenWithGuard, resolveBindWindowMs } from '@/services/listen-with-guard.service.js';
import { createServerBackgroundLifecycle } from '@/services/server-background-lifecycle.service.js';
import { createSourceVersionHealthMiddleware } from '@/services/source-version.service.js';
import { runConnectorCredentialRetentionAtStartup } from '@/modules/connectors/connector-user-grant.production.js';
import {
    authorizeRuntimeProviderExecution,
    isPermissionReconciliationFatal, reconcileRuntimePermissionExecutions,
} from '@/modules/execution-permissions/runtime-gateway.js';

import { getConnectableHost } from '../shared/networkHosts.js';
import { exchangeGenerations, validateCandidate, verifyRuntimeIdentities } from '../scripts/lib/source-update-activation.mjs';
import { createUpdateRuntimeOrchestrator } from '../scripts/lib/update-runtime-orchestrator.mjs';
import { bootstrapLegacy144HostCapability } from '../scripts/lib/update-runtime-capability.mjs';
import { readReleaseActivationAction } from '../scripts/lib/update-release-layout-activation.mjs';
import { isNassajReleaseVersion } from '../shared/release-version-policy.js';
import { recordOidPairApplicationServing } from '../scripts/oid-control-capsule.mjs';
import { prepareClientPublicationAssets } from '../scripts/lib/client-publication-archive.mjs';
import { verifyAssetClosure } from '../scripts/lib/client-publication-artifacts.mjs';
import { settleReleaseUpdateWaiter } from '../scripts/lib/client-publication-control.mjs';

import {
    installGlobalBodyParsers,
    isPayloadTooLargeError,
} from './middleware/global-body-limits.js';
import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';
import { clientIp } from './utils/client-ip.js';
import { sanitizeAttachmentName, resolveCollisionFreeDest } from './utils/attachment-helpers.js';
import { resolveReadPathInProject, isResolvedPathInsideRootReal } from './utils/path-guard.js';
import { sanitizeSvg } from './services/svg-sanitizer.js';
import { createChatImagesRouter } from './routes/chat-images.js';
import { createDocumentSharesRouter } from './routes/document-shares.js';
import { createDocumentSharesStore } from './modules/database/document-shares.js';
import { createDocumentShareVerifier } from './services/document-share-auth.js';
import { isShareableDocument, saveSharedDocumentAtomically } from './services/document-share-files.js';
import { createAssistantImagesRouter, deriveAllowedRoots, defaultScratchpadBase } from './routes/assistant-images.js';
import {
    queryClaudeSDK,
    spawnClaudeSideQuery,
    abortClaudeSDKSession,
    isClaudeSDKSessionActive,
    isSessionEngineSwitchBlocked,
    getActiveClaudeSDKSessions,
    getDrainBlockingClaudeSessions,
    ghostDetachEnabled,
    resolveToolApproval,
    getPendingApprovalsForSession,
    cancelAllPendingApprovals,
    reconnectSessionWriter,
    isSessionPrimarySocketAlive,
    attachClaudeSDKSession,
} from './claude-sdk.js';
import {
    spawnCursor,
    abortCursorSession,
    isCursorSessionActive,
    getActiveCursorSessions,
} from './cursor-cli.js';
import {
    queryCodex,
    abortCodexSession,
    isCodexSessionActive,
    getActiveCodexSessions,
} from './openai-codex.js';
import { spawnCodexSideQuery } from './services/codex-app-server.js';
import {
    spawnGemini,
    abortGeminiSession,
    isGeminiSessionActive,
    getActiveGeminiSessions,
} from './gemini-cli.js';
import {
    spawnAntigravity,
    abortAntigravitySession,
    isAntigravitySessionActive,
    getActiveAntigravitySessions,
    attachAntigravitySession,
} from './agy-cli.js';
import {
    spawnOpenCode,
    abortOpenCodeSession,
    isOpenCodeSessionActive,
    getActiveOpenCodeSessions,
} from './opencode-cli.js';
import {
    spawnHermes,
    abortHermesSession,
    isHermesSessionActive,
    getActiveHermesSessions,
} from './hermes-cli.js';
import {
    spawnKimi,
    abortKimiSession,
    isKimiSessionActive,
    getActiveKimiSessions,
} from './kimi-cli.js';
// KM-3 (ADR-062): the NATIVE governed Kimi agent launcher (distinct from spawnKimi,
// the toolless chat path). Injected as the OPTIONAL `spawnKimiAgent` chat dependency
// so a kimi `mode==='agent'` WS turn routes to the governed native CLI; its absence
// would leave that path inert (chat behavior unchanged).
import { spawnKimiAgent } from './kimi-agent-cli.js';
import {
    spawnDeepSeek,
    abortDeepSeekSession,
    isDeepSeekSessionActive,
    getActiveDeepSeekSessions,
} from './deepseek-cli.js';
import {
    spawnGlm,
    abortGlmSession,
    isGlmSessionActive,
    getActiveGlmSessions,
} from './glm-cli.js';
import {
    spawnQwen,
    abortQwenSession,
    isQwenSessionActive,
    getActiveQwenSessions,
} from './qwen-cli.js';
import sessionManager from './sessionManager.js';
import {
    stripAnsiSequences,
    normalizeDetectedUrl,
    extractUrlsFromText,
    shouldAutoOpenUrlFromOutput,
} from './utils/url-detection.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import credentialGrantsRoutes from './routes/credential-grants.js';
import cursorRoutes from './routes/cursor.js';
import projectBoardRoutes from './routes/project-board.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes, { getBrandingHandler } from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import projectStatsRoutes from './modules/projects/project-stats.routes.js';
import { connectorsOAuthCallbackRoutes, connectorsRoutes } from './modules/connectors/index.js';
import { voiceRoutes } from './modules/voice/index.js';
import userRoutes from './routes/user.js';
import geminiRoutes from './routes/gemini.js';
import githubRoutes from './routes/github.js';
import systemRoutes, { executeActionRowAs, findSourceUpdateActivation, reconcileStrandedActivationJobs } from './routes/system.js';
import { createUpdateAutoActivator } from './services/update-auto-activator.js';
import { createUpdateJobLog } from './services/update-job-log.js';
import terminalsRoutes from './routes/terminals.js';
import {
    attachStandaloneTerminalSocket,
    writeStandaloneTerminalInput,
    resizeStandaloneTerminal,
    detachStandaloneTerminalSocket,
} from './services/standalone-terminals/standalone-terminal-registry.js';
import providerRoutes from './modules/providers/provider.routes.js';
import governancePreferencesRoutes from './modules/providers/governance-preferences.routes.js';
import participantsRoutes from './modules/providers/participants.routes.js';
import {
    latestClaudeCacheTtlMinutes,
    latestClaudeTokenUsage,
    claudeContextSnapshot,
    readClaudeTranscriptForSession,
} from './modules/providers/list/claude/claude-token-usage.js';
import { extractCodexTokenBudget } from './modules/providers/list/codex/codex-token-budget.js';
import workflowSupervisorLaunchRoutes from './modules/workflow-supervisor/launch.route.js';
import { ensureBackgroundTasksWatcher } from './modules/workflow-supervisor/background-tasks-watcher.service.js';
import {
    hostedTurnSupervisor, HOSTED_TURN_SUPERVISOR_OWNER_ID,
} from './modules/turn-supervisor/hosted-turn-supervisor.service.js';
import {
    cliTurnSupervisor, CLI_TURN_SUPERVISOR_OWNER_ID,
} from './modules/turn-supervisor/cli-turn-supervisor.service.js';
import { createTurnSupervisorLifecycle } from './modules/turn-supervisor/lifecycle.js';
import { initializeDatabase, closeConnection, getConnection, projectsDb, sessionsDb, participantsDb, appConfigDb, pendingServerActionsDb, sessionOutcomesDb, sourceUpdateJobsDb, hashSourceUpdateIdempotencyKey, sourceUpdateRequestFingerprint, scheduledMessagesDb, userDb, auditLogDb } from './modules/database/index.js';
import { onSessionOutcomeChange } from './modules/websocket/services/session-outcome.service.js';
import { broadcastSessionOutcome } from './modules/websocket/services/presence.service.js';
import { isProjectVisible, coerceUserId } from './modules/projects/index.js';
import { configureWebPush } from './services/vapid-keys.js';
import { createSourceUpdater, evaluateUpdateStorage, resolveUpdateHostCapability, sourceUpdateErrorPayload } from './services/source-updater.js';
import { createSourceUpdateWorker, durableReceiptFile } from './services/source-update-worker.js';
import { createUpdateDeferralScheduler } from './services/update-deferral-scheduler.js';
import { deriveUpdateJobFailure, deriveUpdateJobDeferral } from './services/update-job-snapshot.js';
import { mountNodeOverlay } from './services/node-overlay-static.js';
import { mountPublicContent } from './services/public-content-static.js';
import { resolvePublicPageContentRoot } from './services/public-page-agent-guidance.js';
import { loadNodeEnvAllowlist } from './lib/node-env-allowlist.js';
import { notifyUserIfEnabled, createNotificationEvent } from './services/notification-orchestrator.js';
import { createReleaseDiscovery } from './services/release-discovery.js';
import { createGitTagReleaseDiscovery } from './services/git-tag-release-discovery.js';
import { createUpdatePreflight, preflightResponse } from './services/update-preflight.js';
import { resolveReleaseSource } from './services/release-source-config.js';
import { buildPendingAction } from './services/server-actions.js';
import { resolveDegraded } from './services/health-degraded.js';
import { readRuntimeIdentity } from './services/runtime-identity.js';
import { assertLegacyTransitionAllowed, requireStartupAdmission, confirmStartupServing } from './bootstrap-startup-context.js';
import { createUpdateMaintenanceGate } from './services/update-maintenance-gate.js';
import { acquireApplicationWriterLease, applicationWriterLeaseMiddleware, installLocalUpdateRouteLeases, withLocalUpdateWriterLease } from './services/update-writer-lease.js';
import { createClientPublicationStaticMiddleware, createClientManifestHandler } from './services/client-publication-static.js';
import { resolveHostUpdateMode, setLocalUpdateRuntimeIdentity, localUpdateActivationJobs, ensureLocalUpdateAction,
    getLocalUpdatePolicyCapability } from './services/local-preview-server-control.js';
import { getBrandingTitle } from './services/branding-config.js';
import {
    getServerRuntimeAttestation,
    reconcileOidControlJournalAtStartup,
} from './services/preview-runtime-attestation.js';
import { ensureOwnerBootstrapped } from './services/bootstrap-owner.service.js';
import { enforcePlatformIsolationGuard } from './services/platform-isolation-guard.service.js';
import { enforceDockerSockBootGuard } from './services/isolation/docker-sock-boot-guard.js';
import { resolveSecurityPosture } from './services/isolation/security-posture.js';
import { credentialPrincipalId } from './services/isolation/credential-principal.js';
import { userConfigDir } from './services/isolation/provision-user-dirs.js';
import { isProviderIsolated } from './services/provider-sharing.js';
import { validateApiKey, authenticateToken, authenticateWebSocket, requireRole, JWT_SECRET } from './middleware/auth.js';
import { recordAuthRejection } from './middleware/auth-rejection-audit.js';
import { IS_PLATFORM } from './constants/config.js';
import { c } from './utils/colors.js';


const __dirname = getModuleDir(import.meta.url);
// The server source runs from /server, while the compiled output runs from /dist-server/server.
// Resolving the app root once keeps every repo-level lookup below aligned across both layouts.
const APP_ROOT = findAppRoot(__dirname);
// ADR-156 §3.4 step 1 (owner decision 8): load the code-defined, non-secret
// allowlist (TMPDIR only) from config/node.env BEFORE any spawn, filling only
// keys the live environment left unset. This is what makes safe-restart alone
// enough to carry TMPDIR=/var/tmp on a node whose saved pm2 env lacked it.
loadNodeEnvAllowlist({ configPath: path.join(APP_ROOT, 'config', 'node.env') });
const PROCESS_STARTED_AT = new Date().toISOString();
const SERVER_RUNTIME_ATTESTATION = getServerRuntimeAttestation();
reconcileOidControlJournalAtStartup(APP_ROOT, SERVER_RUNTIME_ATTESTATION);
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
const UPDATE_CONTROL_ROOT = typeof process.env.NASSAJ_UPDATE_CONTROL_ROOT === 'string'
    && process.env.NASSAJ_UPDATE_CONTROL_ROOT
    ? path.resolve(process.env.NASSAJ_UPDATE_CONTROL_ROOT)
    : null;
const UPDATE_CAPABILITY_FILE = typeof process.env.NASSAJ_UPDATE_CAPABILITY_FILE === 'string'
    && process.env.NASSAJ_UPDATE_CAPABILITY_FILE
    ? path.resolve(process.env.NASSAJ_UPDATE_CAPABILITY_FILE)
    : UPDATE_CONTROL_ROOT ? path.join(UPDATE_CONTROL_ROOT, 'UPDATE_RUNTIME_CAPABILITY.json') : null;
if (process.env.NASSAJ_ENABLE_LEGACY_144_BRIDGE === '1' && UPDATE_CONTROL_ROOT
    && UPDATE_CAPABILITY_FILE && !fs.existsSync(UPDATE_CAPABILITY_FILE)
    && process.env.NASSAJ_DEPLOY_ROOT && process.env.NASSAJ_NODE_INSTANCE_ID) {
    try {
        bootstrapLegacy144HostCapability({
            authorization: 'legacy-1.44-to-artifact-runtime-v2',
            deployRoot: process.env.NASSAJ_DEPLOY_ROOT,
            artifactRoot: path.join(APP_ROOT, 'dist-server'), projectRoot: APP_ROOT,
            controlRoot: UPDATE_CONTROL_ROOT, capabilityFile: UPDATE_CAPABILITY_FILE,
            nodeInstanceId: process.env.NASSAJ_NODE_INSTANCE_ID,
        });
    } catch (error) {
        // A missing/invalid/previously-used bridge stays fail-closed. Never
        // mutate or recreate an existing marker during ordinary startup.
        console.error('[update] legacy 1.44 capability bridge refused:', error.message);
    }
}
let updateHostCapability = resolveUpdateHostCapability({ appRoot: APP_ROOT });
// A malformed NASSAJ_RELEASE_SOURCE must not crash the boot in a restart loop
// (ADR-141, ت3): disable the update capability with a readable blocker instead
// of letting the updater/discovery constructors throw at import.
let releaseSourceInvalid = false;
try {
    // The installer's TOFU pin is read here and nowhere else (ADR-156 هـ.3): the
    // same place the capability is decided, before the updater and discovery are
    // constructed, so no half-cycle ever runs with two release-source identities.
    resolveReleaseSource(process.env, { lockPath: path.join(APP_ROOT, 'config', 'release-source.lock.json') });
} catch (error) {
    releaseSourceInvalid = true;
    const blockedReasonCode = /^release_source_lock_(?:mismatch|invalid)$/.test(error.message)
        ? error.message : 'invalid_release_source';
    updateHostCapability = Object.freeze({
        ready: false, protocol: null, runtimeStrategy: 'unsupported', jobStrategy: null,
        blockedReasonCode,
    });
    console.error(blockedReasonCode === 'release_source_lock_mismatch'
        ? `[update] NASSAJ_RELEASE_SOURCE (${error.configuredIdentity}) contradicts the installed pin `
            + `(${error.pinnedIdentity}); update capability disabled. Settle which repository owns this node's `
            + 'releases, then run the governed safe restart.'
        : '[update] NASSAJ_RELEASE_SOURCE is invalid; update capability disabled. '
            + `Set it to a credential-free GitHub repository URL, then run the governed safe restart: ${error.message}`);
}
const sourceVersionHealthMiddleware = createSourceVersionHealthMiddleware(path.join(APP_ROOT, 'package.json'));
const PREVIEW_LEDGER_PATH = path.join(APP_ROOT, '.git', 'nassaj-local-preview-ledger-v1.json');
const readBuildIdFile = (file, field = 'buildId') => {
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'))?.[field];
        return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
    } catch {
        return null;
    }
};
const readPreviewLedger = () => {
    try {
        const value = JSON.parse(fs.readFileSync(PREVIEW_LEDGER_PATH, 'utf8'));
        return value?.schemaVersion === 1 ? value : null;
    } catch {
        return null;
    }
};
const countGovernedActiveSessions = () => [
    getActiveClaudeSDKSessions,
    getActiveCursorSessions,
    getActiveCodexSessions,
    getActiveGeminiSessions,
    getActiveAntigravitySessions,
    getActiveOpenCodeSessions,
    getActiveHermesSessions,
    getActiveKimiSessions,
    getActiveDeepSeekSessions,
    getActiveGlmSessions,
    getActiveQwenSessions,
].reduce((total, getSessions) => total + getSessions().length, 0);
// B-1056 (ADR-156 WI-2). A queued restart row carries the owner's consent for
// ONE specific package: its job, transaction, activation identity and release
// commit. When a NEW update job reaches the same build fingerprint and finds a
// row from a DIFFERENT job, rebinding that row would launder consent, so it is
// never rebound. It may only be settled as 'superseded' — and only once its own
// job can no longer act on it: a job in one of these states is over and will
// never restart anything. 'activated' is deliberately absent; that job's restart
// is still legitimately owed.
//
// ت-2 — the UNBOUND row stays a refusal. A row on this fingerprint that names
// no job, or names a job no longer in the database, is NOT treated as
// abandoned: nothing proves who consented to it or whether its execution is
// still coming, and superseding it on a guess is the same consent laundering
// by another route. Those rows need an operator, so the refusal stands and is
// recorded under its own code rather than disappearing into the boolean the
// updater sees.
//
// getQueuedByActionType returns pending AND failed rows, so more than one may
// sit on the same fingerprint; the loop is bounded so a repository bug can
// never spin here.
const SAME_GENERATION_SUPERSEDE_PASSES = 8;
const SUPERSEDABLE_UPDATE_JOB_STATES = new Set([
    // 'cancelled' (T-1730 W6/W8, ADR-156 §3.3): an owner-cancelled deferral is a
    // clean terminal state whose bound restart row, if any, may be superseded.
    'failed', 'rolled_back', 'superseded', 'manual_recovery_required', 'cancelled',
]);
/** null when the row may be superseded; otherwise the distinct refusal code. */
const restartRowConflictCode = (row) => {
    if (!row?.sourceUpdateJobId) return 'restart_row_unbound';
    const job = sourceUpdateJobsDb.getById(row.sourceUpdateJobId);
    if (!job) return 'restart_row_unbound';
    return SUPERSEDABLE_UPDATE_JOB_STATES.has(job.state) ? null : 'restart_row_bound_to_live_job';
};
const isRestartRowAbandoned = (row) => restartRowConflictCode(row) === null;
const queueSourceUpdateRestart = async ({ expectedServerBuildId, reason, transactionId, sourceUpdateJobId, activationIdentitySha256, releaseCommit }) => {
        const built = buildPendingAction({
            actionType: 'safe-restart', reason, requestedBy: 'system-update', expectedServerBuildId,
        });
        if (!built.ok) return false;
        // The updater's contract here is a bare boolean, so every refusal would
        // otherwise reach the owner as one opaque `restart_queue_failed`. The
        // distinct code is recorded instead of lost (ت-2).
        const refuse = (code, conflictingActionId = null) => {
            auditLogDb.record('server_action_queue_refused', {
                metadata: { code, expectedServerBuildId, sourceUpdateJobId, conflictingActionId },
            });
            return false;
        };
        pendingServerActionsDb.supersedeOtherGenerations('safe-restart', expectedServerBuildId);
        const boundToThisJob = (row) => row.sourceUpdateJobId === sourceUpdateJobId
            && row.sourceUpdateTransactionId === transactionId
            && row.activationIdentitySha256 === activationIdentitySha256
            && row.releaseCommit === releaseCommit;
        // Bounded: each pass settles one row, so the queue cannot grow under us.
        for (let pass = 0; pass < SAME_GENERATION_SUPERSEDE_PASSES; pass += 1) {
            const existing = pendingServerActionsDb.getQueuedByActionType('safe-restart', expectedServerBuildId);
            if (!existing) break;
            if (boundToThisJob(existing)) return true;
            const conflict = restartRowConflictCode(existing);
            if (conflict) return refuse(conflict, existing.id);
            // CAS-guarded (ت-1): a claim may have turned the row 'executing'
            // since it was read, and settling it then would erase a live
            // attempt. A lost race is a refusal, never an overwrite.
            if (pendingServerActionsDb.supersedeQueued(
                existing.id, `superseded_by_job:${sourceUpdateJobId}`,
            ) !== 1) return refuse('restart_row_supersede_lost_race', existing.id);
        }
        const remaining = pendingServerActionsDb.getQueuedByActionType('safe-restart', expectedServerBuildId);
        if (remaining) return refuse('restart_row_queue_not_drained', remaining.id);
        const sourceBound = {
            ...built.value,
            sourceUpdateJobId,
            sourceUpdateTransactionId: transactionId,
            activationIdentitySha256,
            releaseCommit,
        };
        if (pendingServerActionsDb.insert(sourceBound) === 1) return true;
        // Deduped against a row inserted concurrently. Only a row with this
        // job's full identity may be adopted; anything else is another job's
        // consent and is refused rather than reused.
        const raced = pendingServerActionsDb.getQueuedByActionType('safe-restart', expectedServerBuildId);
        if (raced && boundToThisJob(raced)) return true;
        return refuse('restart_row_raced_identity_mismatch', raced?.id ?? null);
};
const updateNassajSource = releaseSourceInvalid ? null : createSourceUpdater({
    appRoot: APP_ROOT,
    activeSessionCount: countGovernedActiveSessions,
    queueRestartAction: queueSourceUpdateRestart,
    removeRestartAction: async ({ expectedServerBuildId }) => {
        const queued = pendingServerActionsDb.getQueuedByActionType('safe-restart', expectedServerBuildId);
        if (queued) pendingServerActionsDb.markSuperseded(queued.id, 'source_changed_after_staging');
        return true;
    },
});
// git-checkout-v2 discovers a release from git tags via the node's own git
// credentials (so a private source works), not the credential-free GitHub API
// which cannot read a private repository; the artifact path keeps the
// asset-required API discovery (ADR-141, T-1569). A disabled capability (invalid
// release source) leaves discovery unbuilt.
const updateReleaseDiscovery = releaseSourceInvalid ? null
    : updateHostCapability.jobStrategy === 'git-checkout-v2'
    ? createGitTagReleaseDiscovery({ appRoot: APP_ROOT })
    : createReleaseDiscovery();
const UPDATE_JOB_RECEIPT_ROOT = path.join(
    UPDATE_CONTROL_ROOT || path.join(APP_ROOT, '.git', 'nassaj-source-update'),
    'job-receipts',
);
// T-1768: the live terminal log of each job, beside its receipts, so it
// survives the restart that activates the release.
const updateJobLog = createUpdateJobLog({
    root: path.join(path.dirname(UPDATE_JOB_RECEIPT_ROOT), 'job-logs'), appRoot: APP_ROOT,
});
const updateLayoutOptions = {
        deployRoot: process.env.NASSAJ_DEPLOY_ROOT,
        projectRoot: APP_ROOT,
        artifactRoot: path.join(APP_ROOT, 'dist-server'),
        controlRoot: UPDATE_CONTROL_ROOT,
        capabilityFile: UPDATE_CAPABILITY_FILE,
        nodeInstanceId: process.env.NASSAJ_NODE_INSTANCE_ID,
};
// The release-layout orchestrator is artifact-runtime-v2 only. A git-checkout-v2
// host is ready without it, so gate on the job strategy, not on `ready` — else
// inspectCapability() below would fail and demote the git capability (ADR-141).
let updateRuntimeOrchestrator = updateHostCapability.jobStrategy === 'release-layout-v2' ? createUpdateRuntimeOrchestrator({
    layoutOptions: updateLayoutOptions,
    listRuntimeReferences: () => sourceUpdateJobsDb.listRuntimeReferences(),
}) : null;
if (updateRuntimeOrchestrator) {
    try {
        updateRuntimeOrchestrator.inspectCapability();
    } catch (error) {
        updateHostCapability = Object.freeze({
            ready: false, protocol: null, runtimeStrategy: 'unsupported', jobStrategy: null,
            blockedReasonCode: typeof error?.code === 'string' ? error.code : 'release_layout_not_ready',
        });
        updateRuntimeOrchestrator = null;
    }
}
const sourceUpdateWorker = releaseSourceInvalid || process.env.NASSAJ_UPDATE_MODE === 'local-main' ? null : createSourceUpdateWorker({
    resolveRelease: updateReleaseDiscovery,
    jobLog: updateJobLog,
    // ADR-156 ت-3: the gate owns the downtime window, so the receipt reads the
    // measurement from it rather than guessing at one.
    readGateMetrics: () => {
        try { return createUpdateMaintenanceGate({ projectPath: APP_ROOT }).readPublicStatus()?.metrics ?? null; }
        catch { return null; }
    },
    runUpdate: async (job, release, context) => {
        if (job.strategy === 'git-checkout-v2') {
            return updateNassajSource(job.expected_version, { jobId: job.id, ...context });
        }
        if (job.strategy !== 'release-layout-v2' || !updateRuntimeOrchestrator) {
            throw Object.assign(new Error('release_layout_unavailable'), { code: 'release_layout_unavailable' });
        }
        const artifactWriter = await createUpdateMaintenanceGate({projectPath:APP_ROOT}).acquireWriterLease({kind:'artifact-seal'});
        try {
        const layout = updateRuntimeOrchestrator.inspectCapability();
        const generationId = `release-${release.releaseId}-${release.commit.slice(0, 12)}`;
        if (job.state === 'candidate_sealed') {
            const action = readReleaseActivationAction({ layout, jobId: job.id });
            if (action.generationId !== generationId || action.commit !== release.commit) {
                throw Object.assign(new Error('sealed_release_identity_mismatch'), { code: 'sealed_release_identity_mismatch' });
            }
            context.beforeQueue({
                transaction_id: generationId, release_commit: action.commit,
                archive_sha256: action.archiveSha256, source_tree_sha256: action.sourceTreeSha256,
                expected_server_build_id: action.serverBuildId,
                expected_client_build_id: action.clientBuildId,
                activation_identity_sha256: action.activationIdentitySha256,
            });
            context.assertFence();
            const queued = await queueSourceUpdateRestart({
                expectedServerBuildId: action.serverBuildId,
                reason: `Activate governed Nassaj release ${release.version}`,
                transactionId: generationId, sourceUpdateJobId: job.id,
                activationIdentitySha256: action.activationIdentitySha256,
                releaseCommit: action.commit,
            });
            context.assertFence();
            if (!queued) throw Object.assign(new Error('restart_queue_failed'), { code: 'restart_queue_failed' });
            return {
                transactionId: generationId, commit: action.commit,
                archiveSha256: action.archiveSha256, sourceTreeSha256: action.sourceTreeSha256,
                expectedServerBuildId: action.serverBuildId, expectedClientBuildId: action.clientBuildId,
                activationIdentitySha256: action.activationIdentitySha256,
            };
        }
        const source = resolveReleaseSource(process.env);
        const expected = {
            repo: `${source.owner}/${source.repo}`, releaseId: release.releaseId,
            tag: release.tagName, version: release.version, commit: release.commit,
            name: release.assetName, assetSize: release.assetSize,
            assetSha256: release.assetSha256, generationId, jobId: job.id,
        };
        const upstream = {
            id: release.releaseId, tag_name: release.tagName,
            assets: [{ id: release.assetId, name: release.assetName, state: 'uploaded', size: release.assetSize }],
        };
        const extracted = await updateRuntimeOrchestrator.downloadAndExtractExactAsset({
            release: upstream, expected,
            destination: path.join(layout.releasesRoot, generationId), context,
        });
        const sealed = await updateRuntimeOrchestrator.sealGeneration({
            staging: extracted.staging, identity: extracted.identity, context,
        });
        const facts = {
            transaction_id: generationId, release_commit: release.commit,
            archive_sha256: extracted.identity.archiveSha256,
            source_tree_sha256: extracted.identity.sourceTreeSha256,
            expected_server_build_id: extracted.identity.serverBuildId,
            expected_client_build_id: extracted.identity.clientBuildId,
            activation_identity_sha256: sealed.action.activationIdentitySha256,
        };
        context.beforeQueue(facts);
        context.assertFence();
        const queued = await queueSourceUpdateRestart({
            expectedServerBuildId: extracted.identity.serverBuildId,
            reason: `Activate governed Nassaj release ${release.version}`,
            transactionId: generationId, sourceUpdateJobId: job.id,
            activationIdentitySha256: sealed.action.activationIdentitySha256,
            releaseCommit: release.commit,
        });
        context.assertFence();
        if (!queued) throw Object.assign(new Error('restart_queue_failed'), { code: 'restart_queue_failed' });
        return {
            transactionId: generationId, commit: release.commit,
            archiveSha256: extracted.identity.archiveSha256,
            sourceTreeSha256: extracted.identity.sourceTreeSha256,
            expectedServerBuildId: extracted.identity.serverBuildId,
            expectedClientBuildId: extracted.identity.clientBuildId,
            activationIdentitySha256: sealed.action.activationIdentitySha256,
        };
        } finally { artifactWriter.release(); }
    },
    receiptRoot: UPDATE_JOB_RECEIPT_ROOT,
    beforeWorkerClaim: updateRuntimeOrchestrator
        ? (context) => updateRuntimeOrchestrator.beforeWorkerClaim(context)
        : () => undefined,
    afterTerminal: updateRuntimeOrchestrator
        ? (context) => updateRuntimeOrchestrator.afterTerminal(context)
        : () => undefined,
});

// ── T-1730 W8: declared session-deferral wiring (ADR-156 §3.3) ───────────────
// The maximum an owner-deferred update may wait for idle: 24 h by default, in
// the range [1, 72]; an out-of-range or unparseable value falls back to 24 h.
// The deadline stored on the row is absolute, so it survives a restart.
const DEFER_MAX_HOURS = (() => {
    const raw = Number(process.env.NASSAJ_UPDATE_DEFER_MAX_HOURS);
    return Number.isFinite(raw) && raw >= 1 && raw <= 72 ? raw : 24;
})();
const DEFER_MAX_MS = DEFER_MAX_HOURS * 60 * 60 * 1000;

// The command-board safe-restart gate as a read-only session counter (ADR-156
// §3.3, M2). It shells out to `bash safe-restart.sh --json`, which walks /proc
// for the server's descendants (PTY shells, orphan CLIs the in-process counter
// never sees) and returns { sessionCount }. Exit codes: 0=safe, 3=live work,
// 6=live sessions, 4=not in PM2, 2=read/config error. Any non-zero exit or bad
// parse FAIL-CLOSES to a blocking count so "both counters zero" can never be
// satisfied on missing data. It is only consulted when the in-process counter
// already reads zero, so the /proc walk is bounded.
const SAFE_RESTART_GATE_SCRIPT = [
    path.join(APP_ROOT, 'dist-server', 'scripts', 'safe-restart.sh'),
    path.join(APP_ROOT, 'scripts', 'safe-restart.sh'),
].find((candidate) => { try { return fs.existsSync(candidate); } catch { return false; } })
    || path.join(APP_ROOT, 'scripts', 'safe-restart.sh');
const GATE_READ_TIMEOUT_MS = 30_000;
const readGateSessionCount = () => new Promise((resolve) => {
    let child;
    try {
        child = spawnChildProcess('bash', [SAFE_RESTART_GATE_SCRIPT, '--json'],
            { cwd: APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch {
        resolve({ count: 1, reason: 'gate_unavailable' });
        return;
    }
    let stdout = '';
    let settled = false;
    const finish = (outcome) => { if (settled) return; settled = true; clearTimeout(timer); resolve(outcome); };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {}); // drain so the pipe cannot stall the child
    const timer = setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
        finish({ count: 1, reason: 'gate_timeout' });
    }, GATE_READ_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', () => finish({ count: 1, reason: 'gate_unavailable' }));
    child.on('close', (code) => {
        let sessionCount = null;
        try {
            const parsed = JSON.parse(stdout);
            if (Number.isSafeInteger(parsed?.sessionCount)) sessionCount = parsed.sessionCount;
        } catch { /* malformed payload fail-closes below */ }
        if (code === 0) return finish({ count: 0, reason: null });
        const count = Number.isSafeInteger(sessionCount) && sessionCount > 0 ? sessionCount : 1;
        const reason = code === 6 ? 'live_sessions'
            : code === 3 ? 'live_work'
            : code === 4 ? 'not_in_pm2'
            : 'gate_error';
        finish({ count, reason });
    });
});

// Adapter from the scheduler's single-object audit call onto auditLogDb.record's
// (action, { userId, metadata }) shape. Carries only job identity, never PII.
const deferralAudit = {
    record: ({ action, resource, resourceId, userId, ...rest }) =>
        auditLogDb.record(action, { userId: userId ?? undefined, metadata: { resource, resourceId, ...rest } }),
};

const updateDeferralScheduler = releaseSourceInvalid || process.env.NASSAJ_UPDATE_MODE === 'local-main' ? null : createUpdateDeferralScheduler({
    jobs: sourceUpdateJobsDb,
    countGovernedActiveSessions,
    readGateSessionCount,
    // Capability loss is worker-independent: a parked job on a node that can no
    // longer update fails with a named code instead of blocking every future
    // update forever (M7).
    isReleaseSourceInvalid: () => !updateHostCapability.ready || !updateHostCapability.jobStrategy,
    wakeWorker: () => { try { void sourceUpdateWorker?.processOne?.()?.catch?.(() => {}); } catch { /* best-effort kick */ } },
    // The single owner push when a deferred job reaches restart_queued (M3): the
    // command-board confirmation stays human; this only tells the owner it is
    // ready, over the existing web-push channel.
    notifyOwner: ({ userId, jobId }) => notifyUserIfEnabled({
        userId,
        event: createNotificationEvent({
            provider: 'system', kind: 'update', code: 'update_awaiting_confirmation',
            severity: 'info', requiresUserAction: true,
            meta: { message: 'A deferred update is staged and awaiting your confirmation.' },
            dedupeKey: `update:awaiting_confirmation:${jobId}`,
        }),
    }),
    auditLog: deferralAudit,
});

// T-928: mtime of the client bundle entry captured ONCE at process startup.
// `build:client` rewrites dist/index.html on disk while the server process
// keeps running. Comparing this frozen baseline to the current mtime on each
// /health probe detects "new frontend on disk, old backend still running"
// without any semver comparison (nassaj-dev keeps package.json version static
// between client-only builds). A 2-second tolerance absorbs filesystem clock
// jitter. Returns null when the file is absent (tsx dev mode without a prior
// build) so the caller knows not to flag a false positive.
const CLIENT_BUNDLE_PATH = path.join(APP_ROOT, 'dist', 'index.html');
const CLIENT_BUILD_ID_PATH = path.join(APP_ROOT, 'dist', 'version.json');
const CLIENT_BUILD_ID_AT_STARTUP = readBuildIdFile(CLIENT_BUILD_ID_PATH);
const CLIENT_BUNDLE_MTIME_AT_STARTUP = (() => {
    try {
        return fs.statSync(CLIENT_BUNDLE_PATH).mtimeMs;
    } catch {
        return null; // no dist/ yet (e.g. tsx dev without a prior build)
    }
})();
// The SERVER build — the only artefact a restart actually reloads. `dist/` is
// served from disk, so a client build is live the moment it lands and needs a
// browser reload at most. `dist-server/` is loaded into THIS process's memory at
// boot, so a newer one on disk is genuinely not running yet.
//
// Why this distinction exists (measured 2026-07-27): restartRequired was keyed on
// the CLIENT bundle, so every `build:client` lit the "restart required" banner,
// whose Execute button (B-193) performs a full drain+restart — cutting live
// sockets and orphaning in-flight approvals to deploy something that was already
// live. Seven restarts in one hour, five of them traced to that button. A prompt
// must ask for the action that fixes the condition it reports.
const SERVER_BUILD_PATH = path.join(APP_ROOT, 'dist-server', 'server', 'index.js');
const SERVER_PROVENANCE_PATH = path.join(APP_ROOT, 'dist-server', 'BUILD_PROVENANCE.json');
const SERVER_BUILD_ID_LOADED_AT_STARTUP = __dirname === path.join(APP_ROOT, 'dist-server', 'server')
    ? readBuildIdFile(SERVER_PROVENANCE_PATH)
    : null;
/**
 * ADR-156 WI-6 (T-1718). The human identity of the build this process actually
 * LOADED. Frozen at startup — a running process never changes the bytes it
 * loaded — and shared with the authenticated /api/system/runtime-identity route
 * so the public and private answers can never disagree.
 */
const SERVER_RUNTIME_IDENTITY = readRuntimeIdentity(APP_ROOT);
setLocalUpdateRuntimeIdentity({ serverLoadedOid: SERVER_RUNTIME_IDENTITY.runtimeCommit,
    serverLoadedBuildId: SERVER_BUILD_ID_LOADED_AT_STARTUP, clientBuildIdServed: CLIENT_BUILD_ID_AT_STARTUP }, () => readBuildIdFile(CLIENT_BUILD_ID_PATH));
const OID_PAIR_BOOTSTRAP = globalThis[Symbol.for('nassaj.oidPair.bootstrapAdmission.v1')] || null;
const SERVER_BUILD_MTIME_AT_STARTUP = (() => {
    try {
        return fs.statSync(SERVER_BUILD_PATH).mtimeMs;
    } catch {
        return null; // running from source (tsx dev) — nothing to compare
    }
})();
const MAX_FILE_UPLOAD_SIZE_MB = 200;
const MAX_FILE_UPLOAD_SIZE_BYTES = MAX_FILE_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_FILE_UPLOAD_COUNT = 20;
// Per-file cap for agent attachment uploads (POST /upload-attachments). Distinct
// from MAX_FILE_UPLOAD_SIZE_BYTES so the attachment surface can be tuned without
// affecting the file-manager upload path.
const MAX_ATTACHMENT_SIZE_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 20;

// Content types a browser renders as an ACTIVE document (can execute embedded
// script/markup) when navigated to directly. When the raw-bytes endpoint serves
// one of these, it forces a download disposition so a direct navigation can
// never execute stored script — the SVG/HTML stored-XSS vector (B-158 / T-844).
// Raster images/video/audio/pdf are intentionally absent: they render inline and
// carry no script, and the media preview fetches them via XHR+blob regardless.
const RENDERABLE_XSS_TYPES = new Set([
    'image/svg+xml',
    'text/html',
    'application/xhtml+xml',
    'application/xml',
    'text/xml',
]);

console.log('SERVER_PORT from env:', process.env.SERVER_PORT);

// ---------------------------------------------------------------------------
// Last-resort process error handlers.
//
// The server had NONE. Any throw inside an event listener (a child-process
// 'close'/'error' callback, a stream handler, a timer) bypasses every route
// try/catch and, unhandled, kills the process — taking every live provider
// session with it. These two handlers exist to make such a failure DIAGNOSABLE,
// not to paper over it. Registered before anything else can throw.
//
// Deliberate asymmetry (documented so it is not "fixed" into fail-open later):
//
//  * uncaughtException — LOG then EXIT. The exception escaped every recovery
//    point, so the process state is unknown and possibly corrupt; continuing
//    would be fail-open. This is also Node's own default behaviour, so the
//    outcome is unchanged (PM2 restarts us) — what we add is a full structured
//    record of WHY, plus a best-effort DB close so the WAL is checkpointed
//    instead of left behind by an abrupt death.
//
//  * unhandledRejection — LOG ONLY. A rejected promise is almost always one
//    failed request path, not corrupt global state, and since Node 15 the
//    default is to crash the whole server for it. Downgrading that to a loud
//    log is the deliberate trade: one broken request instead of every session
//    on the box. It is NOT swallowed — the reason and stack are recorded.
// ---------------------------------------------------------------------------
let fatalHandlerRan = false;
process.on('uncaughtException', (error, origin) => {
    // Guard against recursion if the logging/close path itself throws.
    if (fatalHandlerRan) {
        process.exit(1);
    }
    fatalHandlerRan = true;
    try {
        // writeSync, NOT console.error: PM2 attaches stderr as a PIPE, and
        // writes to a pipe are asynchronous — process.exit() below would
        // truncate the very record we are here to produce. fd 2 written
        // synchronously always lands in the log first.
        fs.writeSync(2, `[FATAL] uncaughtException (origin=${origin}) — exiting\n`
            + `        name: ${error?.name}\n`
            + `        code: ${error?.code}\n`
            + `        message: ${error?.message}\n`
            + `        stack: ${error?.stack}\n`);
    } catch { /* logging must never mask the original failure */ }
    try {
        closeUniversalConversationShadowRuntime();
        // Flush/checkpoint SQLite rather than dying with an open WAL.
        closeConnection();
    } catch { /* best effort only */ }
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : null;
    console.error('[ERROR] unhandledRejection — request path failed, process kept alive', {
        name: error?.name,
        code: error?.code,
        message: error ? error.message : String(reason),
        stack: error?.stack,
    });
});

let privateSecurityReady = false;
let normalAdmissionReady = false;
const app = express();
app.locals.authorizeProviderExecution = authorizeRuntimeProviderExecution;
const requestMaintenanceGate = createUpdateMaintenanceGate({ projectPath: APP_ROOT });
app.use((req, res, next) => {
    const admission = requireStartupAdmission();
    const localHealthReady = privateSecurityReady && (Boolean(OID_PAIR_BOOTSTRAP) || normalAdmissionReady);
    if (process.env.NASSAJ_UPDATE_MODE === 'local-main'
        && (req.path === '/health' ? !localHealthReady : !normalAdmissionReady)) {
        return res.status(503).json({ code: 'startup_admission_pending' });
    }
    if (admission && (req.path === '/health' ? !privateSecurityReady : (admission.phase !== 'serving' || !normalAdmissionReady))) {
        return res.status(503).json({ code: 'startup_admission_pending' });
    }
    if (req.path === '/health') return next();
    try {
        const status = requestMaintenanceGate.readPublicStatus();
        if (!status.gateClosed) {
            // Confirmation owns no request lease: its detached executor obtains EX
            // only after identity/owner validation, never while awaiting this response.
            const localConfirmation = req.method === 'POST' && /^\/api\/system\/update\/local\/[1-9][0-9]*\/confirm$/.test(req.path);
            if (process.env.NASSAJ_UPDATE_MODE === 'local-main' && !localConfirmation) {
                return applicationWriterLeaseMiddleware('http-request')(req, res, next);
            }
            return next();
        }
        return res.status(503).json({ error: 'Source update maintenance in progress', code: 'source_update_maintenance' });
    } catch {
        return res.status(503).json({ error: 'Source update maintenance state unavailable', code: 'source_update_maintenance_unavailable' });
    }
});
const server = http.createServer(app);

// B-239: 502 متقطّع من cloudflared ("EOF" / "connection reset by peer" على
// 127.0.0.1:3004 بينما العملية حيّة). السبب: عدم تطابق مهلة الإبقاء. يحتفظ
// cloudflared بحوض اتصالات أصل خاملة (keepAliveConnections: 10) لمدة
// keepAliveTimeout: 90s ويعيد استخدامها، بينما افتراضي Node هو 5s فقط. فإن
// كتب cloudflared طلباً في اتصال أغلقه Node للتوّ رأى EOF وأعاد 502 للمتصفح.
// القاعدة: مهلة الأصل يجب أن تتجاوز مهلة الوسيط، وheadersTimeout يتجاوزها.
server.keepAliveTimeout = 95_000;
server.headersTimeout = 100_000;

const universalConversationShadowCoreResolver = createUniversalConversationShadowCoreResolver({
    coercePrincipalId: coerceUserId,
    getSession: (sessionId) => {
        const session = sessionsDb.getSessionById(sessionId);
        return session && {
            sessionId: session.session_id,
            provider: session.provider,
            projectPath: session.project_path,
        };
    },
    getProjectByPath: (projectPath) => {
        const project = projectsDb.getProjectPath(projectPath);
        return project && { projectId: project.project_id };
    },
    isSessionParticipant: (sessionId, principalId) =>
        participantsDb.isParticipant(sessionId, principalId),
    isProjectWritable: (projectId, principalId) =>
        projectsDb.isProjectWritableByUser(projectId, principalId),
    onLookupFailure: (phase, error) => {
        console.warn(`[universal-conversation-shadow] ${phase} lookup failed closed`, {
            code: error?.code ?? error?.name ?? 'UNKNOWN',
        });
    },
});

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
let chatDependencies;
const wss = createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        canAcceptApplications: () => normalAdmissionReady && !requestMaintenanceGate.readPublicStatus().gateClosed,
        authenticateWebSocket,
        // Cross-boundary collaborators injected from the composition root so the
        // websocket module never imports middleware/utils across the boundary
        // (eslint-plugin-boundaries). T-182 auth_rejected auditing on the WS path.
        jwtSecret: JWT_SECRET,
        recordRejection: recordAuthRejection,
        clientIp,
    },
    chat: (chatDependencies = {
        acquireWriterLease: (kind) => acquireApplicationWriterLease(kind, { waitMs: 100 }),
        authorizeProviderExecution: authorizeRuntimeProviderExecution,
        universalConversationShadow: universalConversationShadowHook,
        authorizeUniversalConversationShadow: universalConversationShadowCoreResolver.authorize,
        attestUniversalConversationLegacySession: universalConversationShadowCoreResolver.attest,
        queryClaudeSDK,
        spawnCursor,
        queryCodex,
        spawnGemini,
        spawnAntigravity,
        spawnOpenCode,
        spawnHermes,
        spawnKimi,
        spawnKimiAgent,
        spawnDeepSeek,
        spawnGlm,
        spawnQwen,
        hostedTurnSupervisor,
        cliTurnSupervisor,
        // Authoritative provider lookup for resumed sessions. Routing must follow
        // the provider persisted in the DB, not the client-chosen message type,
        // so an antigravity session is never resumed through the Claude SDK.
        getSessionProvider: (sessionId) => {
            if (!sessionId) {
                return null;
            }
            try {
                const row = sessionsDb.getSessionById(sessionId);
                return row?.provider ?? null;
            } catch (error) {
                console.error('[ERROR] getSessionProvider lookup failed:', error?.message || error);
                return null;
            }
        },
        // T-881: read-only /btw side query (SDK fork of the live session).
        spawnClaudeSideQuery,
        spawnCodexSideQuery,
        // T-1090: promote a finished /btw exchange into a real session by
        // branching the transcript on disk (no model call, no quota).
        forkSessionFromSideQuery,
        // Branch a normal conversation from a selected persisted assistant reply.
        forkSessionAtMessage,
        abortClaudeSDKSession,
        abortCursorSession,
        abortCodexSession,
        abortGeminiSession,
        abortAntigravitySession,
        abortOpenCodeSession,
        abortHermesSession,
        abortKimiSession,
        abortDeepSeekSession,
        abortGlmSession,
        abortQwenSession,
        resolveToolApproval,
        isClaudeSDKSessionActive,
        isCursorSessionActive,
        isCodexSessionActive,
        isGeminiSessionActive,
        isAntigravitySessionActive,
        isOpenCodeSessionActive,
        isHermesSessionActive,
        isKimiSessionActive,
        isDeepSeekSessionActive,
        isGlmSessionActive,
        isQwenSessionActive,
        reconnectSessionWriter,
        isPrimarySocketAlive: isSessionPrimarySocketAlive,
        attachAntigravitySession,
        attachClaudeSDKSession,
        getPendingApprovalsForSession,
        getActiveClaudeSDKSessions,
        getActiveCursorSessions,
        getActiveCodexSessions,
        getActiveGeminiSessions,
        getActiveAntigravitySessions,
        getActiveOpenCodeSessions,
        getActiveHermesSessions,
        getActiveKimiSessions,
        getActiveDeepSeekSessions,
        getActiveGlmSessions,
        getActiveQwenSessions,
    }),
    shell: {
        acquireWriterLease: (kind) => acquireApplicationWriterLease(kind, { waitMs: 100 }),
        getSessionById: (sessionId) => sessionManager.getSession(sessionId),
        stripAnsiSequences,
        normalizeDetectedUrl,
        extractUrlsFromText,
        shouldAutoOpenUrlFromOutput,
    },
    // T-938 (ADR-063): standalone-terminal registry bound at the composition
    // root so the websocket module never imports across the module boundary.
    terminal: {
        attachSocket: attachStandaloneTerminalSocket,
        writeInput: writeStandaloneTerminalInput,
        resizeTerminal: resizeStandaloneTerminal,
        detachSocket: detachStandaloneTerminalSocket,
    },
});

const scheduledMessagesService = createScheduledMessagesService({
    repository: scheduledMessagesDb,
    getActiveUser: (userId) => userDb.getUserById(userId),
    sessionExists: (sessionId) => Boolean(sessionsDb.getSessionById(sessionId)),
    canWriteSession: (sessionId, userId) => isSessionWritableByUser(sessionId, userId),
    audit: (action, metadata, userId) => auditLogDb.record(action, { userId, metadata }),
    dispatch: async (message, user) => {
        let terminal = null;
        // A real writer preserves the normal mirror fan-out and durable outcome
        // side effects; its primary sink is intentionally inert because this
        // server-owned turn has no originating browser socket.
        const writer = new WebSocketWriter({ readyState: 1, send() {} }, message.userId);
        writer.setSessionId(message.sessionId);
        const forward = writer.send.bind(writer);
        writer.send = (payload) => {
            if (payload && typeof payload === 'object'
                && (payload.kind === 'complete' || payload.kind === 'error')) {
                terminal = payload;
            }
            forward(payload);
        };
        const session = sessionsDb.getSessionById(message.sessionId);
        if (!session?.project_path || !session.provider) {
            return { success: false, retryable: false, errorCode: 'session_unavailable' };
        }
        const principal = {
            ...user,
            authenticationKind: 'internal_service',
            authenticationCredentialId: `scheduled-message:${message.id}`,
            authorizationGeneration: user.authorization_generation,
        };
        await dispatchProviderCommand(
            `${session.provider}-command`,
            {
                command: message.content,
                sessionId: message.sessionId,
                options: {
                    ...message.options,
                    sessionId: message.sessionId,
                    cwd: session.project_path,
                    clientMsgId: `scheduled:${message.id}`,
                },
            },
            writer,
            chatDependencies,
            message.userId,
            principal,
        );
        if (!terminal) {
            return { success: false, retryable: true, errorCode: 'missing_terminal_verdict' };
        }
        if (terminal.success === true
            || (terminal.success === undefined && terminal.exitCode === 0)) {
            return { success: true, retryable: false };
        }
        return {
            success: false,
            retryable: terminal.notStarted === true || terminal.sameClientMsgIdRetryable === true,
            errorCode: typeof terminal.code === 'string' ? terminal.code : 'provider_failed',
        };
    },
});

// Make WebSocket server available to routes
app.locals.wss = wss;

// B-103 (ADR-053, T-821): background-task badge watcher. FLAG-GATED — a no-op
// when WORKFLOW_SUPERVISOR is OFF, so this is byte-identical to before until the
// flag is set. The app watches the (separate) supervisor's on-disk state and fans
// a `background-tasks-updated` signal to WS clients, mirroring project-board's
// watch+broadcast. Fail-safe: never throws into boot.
try {
    ensureBackgroundTasksWatcher(wss);
} catch (backgroundTasksWatcherError) {
    console.error('background-tasks watcher init failed:', backgroundTasksWatcherError);
}

// CORS — restrict to known production and development origins.
// Set ALLOWED_ORIGINS (comma-separated) in .env to add further origins without
// code changes.  Falls back to a safe default list when the variable is absent.
// This middleware must remain before all route mounts.
//
// DEPLOYMENT ORIGINS ARE CONFIGURATION, NOT CODE: the built-in defaults below are
// localhost only. Every public origin this instance is served on (a tunnel or
// reverse-proxy hostname) belongs in ALLOWED_ORIGINS in .env — deployment-specific
// hostnames must never be hardcoded here.
//
// REVIEWED AND DELIBERATELY LEFT AS-IS (2026-07-25 security pass). Two items
// were flagged — the `!origin` allowance and the localhost entries surviving in
// production — and both were kept, because tightening them buys ~nothing here
// while risking the live tunnels (which have already caused multi-hour outages
// when the request path changed):
//
//  1. Authentication is Bearer-token only. There is no cookie anywhere in
//     server/ and `credentials: true` is NOT set on this middleware, so a
//     browser never attaches ambient credentials to a cross-origin request.
//     CORS is therefore not what stands between an attacker page and this API;
//     the Authorization header is, and a foreign origin cannot forge it.
//  2. `!origin` covers every non-browser caller: curl, the /health probe that
//     scripts/safe-restart.sh polls, and server-to-server calls. Rejecting them
//     would break the restart gate, and it protects nothing: an attacker who
//     can omit the Origin header is not using a victim's browser.
//  3. The localhost entries are only reachable by code already running on this
//     host (which has far better options), and direct http://localhost:3004 use
//     by the operator is same-origin — it needs no CORS grant at all.
//
// If this is ever revisited, the safe order is: drop the localhost entries
// behind NODE_ENV first, verify both tunnels, and only then reconsider (1).
const _corsDefaultOrigins = [
  'http://localhost:3004',
  'http://localhost:3001',
  'http://localhost:5173',
];
const _corsAllowedOrigins = process.env.ALLOWED_ORIGINS
  ? [...new Set([
      ..._corsDefaultOrigins,
      ...process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    ])]
  : _corsDefaultOrigins;

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser tool calls (e.g. curl, server-to-server) that send no Origin.
    if (!origin) return callback(null, true);
    if (Array.isArray(_corsAllowedOrigins) && _corsAllowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Disallowed origin: deny CORS *gracefully* — never throw here.
    // Passing an Error to this callback forwards it to the global error handler,
    // turning EVERY request that carries an `Origin` header into a 500 — including
    // the app loading its own same-origin assets (browsers send `Origin` on
    // `<script crossorigin>` / `<link crossorigin>` fetches), which bricks boot and
    // produces an infinite reload loop. The spec-correct behavior is to simply omit
    // the `Access-Control-Allow-Origin` header and let the request proceed: the
    // browser enforces the cross-origin read policy itself, while same-origin
    // requests (which never need the header) keep working.
    return callback(null, false);
  },
  exposedHeaders: ['X-Refreshed-Token'],
}));
installGlobalBodyParsers(app);

// ---------------------------------------------------------------------------
// Baseline security response headers.
//
// The app previously shipped NO global security headers: neither the API, nor
// express.static, nor the SPA shell carried nosniff / anti-framing / HSTS.
// Written by hand on purpose — helmet would be a new dependency, and this wave
// is not allowed to touch package.json.
//
// Registered here, before every route mount AND before both express.static
// mounts, so one middleware covers the API, the static assets and the SPA
// fallback alike. Per-route headers set later (e.g. the locked-down CSP on
// /branding/:name) still win, because they are set on the same response object
// afterwards; the Report-Only header below uses a DIFFERENT header name, so it
// never collides with them.
// ---------------------------------------------------------------------------

// Report-Only FIRST, deliberately: a blocking CSP on a live production tunnel
// is exactly the kind of change that bricks the UI, and the app legitimately
// uses blob: URLs (plugin modules are imported as blobs, media preview builds
// blob URLs) plus ws:/wss: for chat. Report-Only never blocks anything — it
// only surfaces violations in the browser console — so this can be tuned
// against real traffic and promoted to an enforcing `Content-Security-Policy`
// header in a later, separately verified change.
const CSP_REPORT_ONLY_POLICY = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    // Vite output plus the blob: module imports the plugin loader relies on.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    // The chat/shell websocket shares the origin but needs the ws(s) scheme.
    "connect-src 'self' ws: wss: blob:",
    "form-action 'self'",
].join('; ');

app.use((req, res, next) => {
    // Never let a stored file be re-sniffed into an active type.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Nothing in this product is meant to be framed by anyone (the only
    // in-app iframes render blob:/srcdoc content, which this does not affect).
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // HSTS only when the request genuinely arrived over TLS. The Cloudflare
    // tunnel terminates TLS and forwards plain http to 127.0.0.1:3004 with
    // X-Forwarded-Proto: https, so trust that header — but never emit HSTS on a
    // plain-http localhost request, which would pin the browser to https for
    // localhost and lock the operator out of direct :3004 access.
    // No includeSubDomains / preload: those would reach hosts this process does
    // not own and are not reversible on the timescale of a mistake.
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (req.secure || forwardedProto === 'https') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }

    res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY_POLICY);
    next();
});

// Public health check endpoint (no authentication required).
// `service: 'nassaj-server'` is a stable fingerprint the B-41 listen guard
// probes after a bind window expires: a port held by one of OUR instances
// (a draining/ghost predecessor) reports this marker, so the starting instance
// gives up cleanly (PM2 reschedules). A port held by something FOREIGN does not
// report it, so the guard surfaces a crash (errored) instead of dying silently.
app.get('/health', sourceVersionHealthMiddleware, async (req, res) => {
    const startupAdmission = requireStartupAdmission();
    if (startupAdmission) res.set('Cache-Control', 'no-store');
    // OC-08: expose per-provider LIVE session COUNTS (integers only — never ids
    // or content, so this stays safe on the public, unauthenticated /health) so
    // an external pre-restart gate (scripts/safe-restart.sh) can name which
    // provider still has running sessions before it defers a restart. Best-effort:
    // any getter throwing degrades that provider to 0 rather than failing /health.
    const safeCount = (getter) => {
        try {
            const value = getter();
            return Array.isArray(value) ? value.length : 0;
        } catch {
            return 0;
        }
    };
    const activeSessions = {
        claude: safeCount(getActiveClaudeSDKSessions),
        cursor: safeCount(getActiveCursorSessions),
        codex: safeCount(getActiveCodexSessions),
        gemini: safeCount(getActiveGeminiSessions),
        antigravity: safeCount(getActiveAntigravitySessions),
        opencode: safeCount(getActiveOpenCodeSessions),
        hermes: safeCount(getActiveHermesSessions),
        kimi: safeCount(getActiveKimiSessions),
        deepseek: safeCount(getActiveDeepSeekSessions),
        glm: safeCount(getActiveGlmSessions),
        qwen: safeCount(getActiveQwenSessions),
    };
    // T-928: detect build-after-startup skew (mtime approach). Re-stat on each
    // probe — a cheap single syscall each. A delta above 2 s (filesystem clock
    // jitter tolerance) means the artefact was rebuilt after this process booted.
    // Never leaks filesystem paths; only booleans and raw epoch-ms are returned.
    //
    // The two skews call for DIFFERENT actions and are reported separately:
    //   • restartRequired  ← dist-server/  — this process is running older code;
    //                        a restart is the only thing that loads the new one.
    //   • clientReloadRequired ← dist/ — already live off disk; the browser just
    //                        needs a reload. Restarting the server changes nothing
    //                        about it, yet that is exactly what the banner used to
    //                        trigger (see SERVER_BUILD_PATH above).
    let restartRequired = false;
    let clientReloadRequired = false;
    let clientBundleMtimeAtStartup = null;
    let clientBundleMtimeNow = null;
    const previewLedger = readPreviewLedger();
    const clientBuildIdServed = readBuildIdFile(CLIENT_BUILD_ID_PATH);
    const serverBuildIdOnDisk = readBuildIdFile(SERVER_PROVENANCE_PATH);
    // Client bytes are served from disk, so that artefact is runtime truth.
    // Server bytes are different: dist-server may be promoted while this
    // process still runs the build attested at startup (B-821).
    const clientLedgerStale = Boolean(clientBuildIdServed
        && previewLedger?.clientPromotedBuildId !== clientBuildIdServed);
    if (CLIENT_BUNDLE_MTIME_AT_STARTUP !== null) {
        try {
            clientBundleMtimeNow = fs.statSync(CLIENT_BUNDLE_PATH).mtimeMs;
            clientBundleMtimeAtStartup = CLIENT_BUNDLE_MTIME_AT_STARTUP;
            clientReloadRequired = clientBundleMtimeNow > CLIENT_BUNDLE_MTIME_AT_STARTUP + 2000;
        } catch {
            // bundle disappeared after startup — treat as no skew
        }
    }
    if (SERVER_BUILD_MTIME_AT_STARTUP !== null) {
        try {
            const serverBuildMtimeNow = fs.statSync(SERVER_BUILD_PATH).mtimeMs;
            restartRequired = serverBuildMtimeNow > SERVER_BUILD_MTIME_AT_STARTUP + 2000;
        } catch {
            // build tree missing mid-probe (prebuild:server rm -rf window) — no skew
        }
    }
    // Build identity is authoritative; mtime fields above remain temporarily
    // for older clients but no longer decide whether an action is required.
    clientReloadRequired = Boolean(
        CLIENT_BUILD_ID_AT_STARTUP && clientBuildIdServed
        && CLIENT_BUILD_ID_AT_STARTUP !== clientBuildIdServed
    );
    const serverCandidateBuildId = /^[a-f0-9]{64}$/.test(previewLedger?.serverCandidateBuildId || '')
        ? previewLedger.serverCandidateBuildId : null;
    // A candidate is retained as audit evidence after activation.  It is not a
    // request to restart: only the bytes currently promoted to dist-server can
    // be loaded by a replacement process.  Treating a retained candidate as
    // current caused a permanent false banner after a successful rollback or
    // when the loaded build had already been promoted (B-1334).
    restartRequired = Boolean(
        SERVER_BUILD_ID_LOADED_AT_STARTUP
        && serverBuildIdOnDisk
        && serverBuildIdOnDisk !== SERVER_BUILD_ID_LOADED_AT_STARTUP
    );
    // ADR-066 / T-944: expose ONLY a boolean for pending work on the PUBLIC,
    // unauthenticated /health — never action ids, reasons, or sessionIds.
    // Content-only build hashes below are operational readiness identities, not
    // queue/user identifiers. hasPendingActions is true when the server-action
    // queue has a row still WAITING for the owner (status 'pending'). T-1684:
    // a failed/settled row is history, not a waiting command, so it no longer
    // keeps this true — the yellow badge means "new commands are queued", and
    // nothing the server settles on its own may re-raise it. The details are
    // served by the AUTHENTICATED routes under /api/system/pending so they never
    // leak to an unauthenticated caller. Distinct from `restartRequired` (mtime
    // skew), which is left untouched. Best-effort: a DB error degrades to false
    // rather than failing /health.
    let hasPendingActions = false;
    try {
        hasPendingActions = pendingServerActionsDb.countActionable() > 0;
    } catch {
        hasPendingActions = false;
    }
    // Surface the pre-flight storage blocker in the banner so the owner sees a
    // readable remedy before pressing Update (ADR-141, T-1553 م1). Only relevant
    // when the host would otherwise be update-ready.
    const updateStorage = !IS_PLATFORM && updateHostCapability.ready
        ? evaluateUpdateStorage({ appRoot: APP_ROOT, env: process.env })
        : { ok: true };
    const updateOffered = !IS_PLATFORM && updateHostCapability.ready === true && updateStorage.ok;
    // ADR-156 decision 7 / WI-6. /health is the ONE route the maintenance-gate
    // middleware lets through, so it is the only place an external probe can
    // learn that this node is not serving normally. On 2026-09-11 the site was
    // 503 for an unmeasured period with nothing outside the box saying why.
    const maintenance = resolveDegraded(() => requestMaintenanceGate.readPublicStatus());
    res.json({
        status: 'ok',
        startupPhase: startupAdmission?.phase ?? 'legacy',
        privateSecurityReady: startupAdmission ? privateSecurityReady : true,
        normalAdmissionReady: startupAdmission || process.env.NASSAJ_UPDATE_MODE === 'local-main' ? normalAdmissionReady : true,
        ...(OID_PAIR_BOOTSTRAP ? { oidPairTargetDigest: OID_PAIR_BOOTSTRAP.targetDigest,
            oidPairTransactionNonce: OID_PAIR_BOOTSTRAP.transactionNonce,
            ...(OID_PAIR_BOOTSTRAP.nodeModulesTreeSha256 ? { oidNodeModulesTreeSha256: OID_PAIR_BOOTSTRAP.nodeModulesTreeSha256 } : {}) } : {}),
        ...(startupAdmission ? {
            claimId: startupAdmission.claimId,
            releaseIdentitySha256: startupAdmission.releaseIdentitySha256,
            serverBuildId: SERVER_BUILD_ID_LOADED_AT_STARTUP,
            clientBuildId: clientBuildIdServed,
            generationId: startupAdmission.generationId,
            generationEpoch: startupAdmission.generationEpoch,
            startTicks: startupAdmission.process.startTicks,
            bootId: startupAdmission.process.bootId,
        } : {}),
        service: 'nassaj-server',
        timestamp: new Date().toISOString(),
        installMode,
        updateMode: resolveHostUpdateMode(),
        sourceVersion: res.locals.sourceVersion,
        // The identity of the RUNNING build, so "which version is this?" is
        // answered by the loaded artefact and not by a working-tree file that
        // `git checkout` has already moved (B-1055).
        //
        // م-9 — /health is PUBLIC and unauthenticated, so this route publishes
        // only what an external monitor needs to see a sick node: the release
        // version (no more disclosive than `sourceVersion`, which this route
        // has always published, and required by the client's own comparison)
        // plus the degraded boolean and its reason code. The exact commit and
        // the maintenance gate's internal phase identify the source revision
        // and the update machinery's internal state; a stranger has no business
        // reading either, so they moved behind authentication at
        // GET /api/system/runtime-identity.
        runtimeVersion: SERVER_RUNTIME_IDENTITY.runtimeVersion,
        degraded: maintenance.degraded,
        degradedReason: maintenance.degradedReason,
        activeSessions,
        restartRequired,
        clientReloadRequired,
        clientBundleMtimeAtStartup,
        clientBundleMtimeNow,
        clientSourceBuildId: clientLedgerStale ? null : previewLedger?.clientSourceBuildId ?? null,
        clientPromotedBuildId: clientBuildIdServed ?? previewLedger?.clientPromotedBuildId ?? null,
        clientBuildIdServed,
        clientBuildIdAtServerStartup: CLIENT_BUILD_ID_AT_STARTUP,
        serverSourceBuildId: previewLedger?.serverSourceBuildId ?? null,
        serverCandidateBuildId,
        serverPromotedBuildId: serverBuildIdOnDisk ?? previewLedger?.serverPromotedBuildId ?? null,
        serverBuildIdOnDisk,
        // Stable activation-runner contract. Keep the longer legacy spelling
        // below during the client migration window.
        serverLoadedBuildId: SERVER_BUILD_ID_LOADED_AT_STARTUP,
        serverLoadedOid: SERVER_RUNTIME_ATTESTATION.oid,
        serverOidControlProtocol: SERVER_RUNTIME_ATTESTATION.controlProtocol ?? null,
        serverOidLauncherAbi: SERVER_RUNTIME_ATTESTATION.launcherAbi ?? null,
        serverTransactionNonce: SERVER_RUNTIME_ATTESTATION.transactionNonce,
        serverBootNonce: SERVER_RUNTIME_ATTESTATION.bootNonce,
        serverProcessStartTicks: SERVER_RUNTIME_ATTESTATION.processStartTicks,
        pid: startupAdmission?.process.pid ?? SERVER_RUNTIME_ATTESTATION.pid ?? process.pid,
        serverBuildIdLoadedAtStartup: SERVER_BUILD_ID_LOADED_AT_STARTUP,
        serverPreviewActivationV2: true,
        // Public capability bit only: the local client watcher refuses to
        // publish against an older process that cannot serve atomic generations.
        clientAtomicPublisherReady: true,
        localUpdatePolicyCapability: getLocalUpdatePolicyCapability(),
        // The client treats an absent value as false, which prevents a newer
        // sidebar from offering destructive bulk actions to an older server.
        bulkLifecycleActions: true,
        capabilities: {
            lightHistory: {
                supported: true,
                codeReady: true,
                enabled: process.env.NASSAJ_LIGHT_HISTORY_ENABLED === '1',
                schema: 1,
            },
        },
        // Public contract consumed by the update modal. Internal numeric schema
        // versions are deliberately not exposed as protocol names; the strategy
        // distinguishes the git path from the artifact path (ADR-141, ت5).
        updaterProtocol: updateOffered ? 'async-v2' : null,
        updaterStrategy: updateOffered
            ? (updateHostCapability.jobStrategy === 'git-checkout-v2' ? 'git-checkout-v2' : 'atomic-release')
            : null,
        updateReady: updateOffered,
        blockedReasonCode: IS_PLATFORM
            ? 'platform_update_unsupported'
            : !updateHostCapability.ready ? (updateHostCapability.blockedReasonCode || 'release_layout_required')
                : updateStorage.ok ? null : updateStorage.code,
        blockedReasonMessage: !IS_PLATFORM && updateHostCapability.ready && !updateStorage.ok
            ? updateStorage.message : undefined,
        hasPendingActions,
    });
});

// Shares have their own explicit JWT/capability gate, including on platform installs.
const documentSharesRouter = createDocumentSharesRouter({
    getStore: () => createDocumentSharesStore(getConnection()),
    verifyUser: createDocumentShareVerifier(userDb, JWT_SECRET),
    isMember: (root, id) => projectsDb.isProjectPathOwnedOrMemberedBy(root, id),
    publicOrigin: process.env.NASSAJ_PUBLIC_ORIGIN,
    writer: applicationWriterLeaseMiddleware('document-share-write'),
    audit: (action, userId, shareId) => auditLogDb.record(action, { userId, metadata: { shareId } }),
});
app.use('/api', (req, res, next) => {
    if (/^\/(?:document-shares(?:\/|$)|projects\/[^/]+\/document-shares(?:\/|$))/.test(req.path)) {
        return documentSharesRouter(req, res, next);
    }
    next();
});
app.use('/share', (_req, res, next) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive' });
    next();
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Admin routes (protected; owner/admin enforced inside the router)
app.use('/api/admin', authenticateToken, adminRoutes);

// User-to-user credential grants (T-1675) — self-scoped, any authenticated member.
app.use('/api/credential-grants', authenticateToken, credentialGrantsRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Project cost & stats (protected) — /:projectId/cost, /:projectId/stats and the
// owner/admin ledger rebuild. Same prefix, mounted AFTER the lifecycle router:
// none of these paths exist there, so Express falls through to this one. Kept a
// separate router because it reads a different subsystem (the cost ledger) and
// answers the flat `{ success, cost|stats }` envelope of the cost surface.
app.use('/api/projects', authenticateToken, projectStatsRoutes);

// External platform connectors (ADR-098). Reads are open to any authenticated
// member because a connector is nassaj-wide by design and the payload carries no
// key; writes are gated to owner/admin inside the router.
app.use('/api/connectors', authenticateToken, connectorsRoutes);

// The OAuth return leg, deliberately OUTSIDE /api and without authenticateToken:
// it is a redirect from the platform, so it carries neither a bearer token nor
// the API key that /api demands. Its authorisation is the unguessable `state`
// nassaj minted when the member started the link (connector-oauth-flow).
app.use('/connectors/oauth', connectorsOAuthCallbackRoutes);

// Accurate voice transcription (ADR-103). Every route requires authentication;
// the feature flag, the owner-only settings write and the key-scope gate all
// live inside the router. GET .../settings answers even when the feature is off
// so the client can say WHY accurate mode is unavailable — the 404 gate covers
// the transcription call and the key writes only.
app.use('/api/voice', authenticateToken, voiceRoutes);

// Session participant/agent tracking (protected)
app.use('/api/sessions', authenticateToken, participantsRoutes);

// Durable send-later queue. Every mutation and due-time dispatch is scoped to
// the authenticated user and rechecks current session write access.
app.use('/api/scheduled-messages', authenticateToken, createScheduledMessagesRouter(scheduledMessagesService));

// Git API Routes (protected)
app.use('/api/git', authenticateToken, (req, res, next) => {
    if (req.method === 'GET') return next();
    return applicationWriterLeaseMiddleware('git-write')(req, res, next);
}, gitRoutes);

// Cursor API Routes (protected)
app.use('/api/cursor', authenticateToken, cursorRoutes);

// Project Board API Routes (protected) — live view of docs/project-state.json
app.use('/api/project-board', authenticateToken, projectBoardRoutes);

// Workflow-supervisor explicit launch (protected) — B-103 async-task launcher
// (ADR-053 §ب-1). HARD NO-OP when WORKFLOW_SUPERVISOR is off: every verb returns
// 404 and touches nothing. Writes a DurableTask intent only; the standalone
// supervisor owns the privileged launch. userId is taken from the JWT, never the
// body; a non-owner is denied (403) with zero intent written.
app.use('/api/workflow-supervisor', authenticateToken, workflowSupervisorLaunchRoutes);

// Commands API Routes (protected)
app.use('/api/commands', authenticateToken, commandsRoutes);

// Public branding read (custom title + logo URL — non-sensitive). Registered
// BEFORE the authenticated /api/settings mount so the pre-auth screens
// (login/setup/splash) can fetch the custom identity without a token. Only GET
// is captured here; branding writes still go through the protected router below
// (owner-only).
app.get('/api/settings/branding', getBrandingHandler);

// Settings API Routes (protected)
app.use('/api/settings', authenticateToken, settingsRoutes);

// User API Routes (protected)
app.use('/api/user', authenticateToken, userRoutes);

// Gemini API Routes (protected)
app.use('/api/gemini', authenticateToken, geminiRoutes);

// GitHub API Routes (protected) — repository listing for the project wizard.
app.use('/api/github', authenticateToken, githubRoutes);

// System stats (protected) — live CPU/RAM for the sidebar footer widget.
app.use('/api/system', authenticateToken, (req, res, next) => {
    const isCommandExecution = req.method === 'POST' && (
        /^\/command-board-raw\/[^/]+\/execute$/.test(req.path)
        || /^\/(?:pending|actions)\/[^/]+\/(?:execute|run)$/.test(req.path)
    );
    if (!isCommandExecution) return next();
    const actionId = req.path.split('/').filter(Boolean).at(-2);
    const row = actionId ? pendingServerActionsDb.getById(actionId) : null;
    if (row?.expectedServerBuildId && findSourceUpdateActivation(row)) {
        return next();
    }
    return applicationWriterLeaseMiddleware('command-exec')(req, res, next);
}, systemRoutes);

// Standalone terminals (protected) — T-938 (ADR-063). REST is create/metadata
// ONLY; the live PTY stream attaches exclusively over WS /terminal. Per-user
// ownership is enforced inside the registry (foreign ⇒ 404, never 403).
// Admin surface: terminals are gated to owner/admin (ADR-063 amend) — the WS
// /terminal path enforces the SAME role gate at init (4403), never client-only.
app.use('/api/terminals', authenticateToken, requireRole('owner', 'admin'), terminalsRoutes);

// حدّ معدّل لقياس موارد المحادثة: القراءة من /proc متزامنة على حلقة الأحداث،
// فمسارٌ بلا حدّ يصير سلاحاً على الخادم نفسه. الكاش في الخدمة يمتصّ التكرار،
// وهذا دفاعٌ ثانٍ. السقف واسع عمداً: الاستطلاع الطبيعي ~15 طلباً/دقيقة/تبويب.
app.use(
    '/api/providers/resources',
    createRateLimiter({ windowMs: 60_000, max: 120, message: 'Too many requests, please slow down' }),
);

// Antigravity rate limiting — in-memory bucket per IP.
// Applied before the auth middleware so abusive callers can't burn auth cycles.
// Limits: 60 req/min/IP on /api/providers/antigravity/*
const antigravityRateMap = new Map();
const ANTIGRAVITY_RATE_LIMIT = 60;
const ANTIGRAVITY_WINDOW_MS = 60_000;

app.use('/api/providers/antigravity', (req, res, next) => {
    // Unified IP source (T-182/ADR-040): real client behind the tunnel.
    const ip = clientIp(req) || 'unknown';
    const now = Date.now();
    const entry = antigravityRateMap.get(ip);

    if (!entry || now > entry.resetAt) {
        antigravityRateMap.set(ip, { count: 1, resetAt: now + ANTIGRAVITY_WINDOW_MS });
        return next();
    }

    if (entry.count >= ANTIGRAVITY_RATE_LIMIT) {
        return res.status(429).json({
            error: 'Too many requests',
            retryAfter: Math.ceil((entry.resetAt - now) / 1000),
        });
    }

    entry.count++;
    next();
});

// ج1: wire the provider liveness probes into the read-only session-activity
// carrier (GET /api/providers/sessions/:sessionId/activity). These are the SAME
// function references handed to the websocket dependency object above, so the
// REST answer and the `session-status` frame can never disagree — the endpoint
// mirrors an existing state and introduces no store of its own. Not injected =
// fail-closed (`isProcessing:false`), never a throw.
setSessionLivenessProbes({
    claude: isClaudeSDKSessionActive,
    cursor: isCursorSessionActive,
    codex: isCodexSessionActive,
    gemini: isGeminiSessionActive,
    antigravity: isAntigravitySessionActive,
    opencode: isOpenCodeSessionActive,
    hermes: isHermesSessionActive,
    kimi: isKimiSessionActive,
    deepseek: isDeepSeekSessionActive,
    glm: isGlmSessionActive,
    qwen: isQwenSessionActive,
});

// ADR-099/T-1237: the engine re-stamp route needs the SAME live registry this
// file already owns, and cannot import claude-sdk from inside a module. Injected
// here for the same reason the probes above are. Not injected = switching is
// refused (fail-closed), never silently allowed on a running turn.
setEngineSwitchLivenessProbe(isSessionEngineSwitchBlocked);

// Unified provider MCP routes (protected). The owner/admin gate on skill writes
// (B-26) is enforced in-handler inside provider.routes.ts, immune to Express's
// case-insensitive path matching.
app.use('/api/providers', authenticateToken, providerRoutes);

// Per-engine governance switch (owner decision 2026-08-08). Reads are open to
// every authenticated member and carry `canManage`; the owner/admin gate on
// lifting governance is enforced IN-HANDLER (immune to Express's
// case-insensitive path matching), exactly like the provider skill writes above.
app.use('/api/governance', authenticateToken, governancePreferencesRoutes);
// T-1315 (شرط معلَّق من مراجعة سابقة): كانت `modules/references/` وحدةً ثانية
// لا تحوي إلا سطرَي إعادة تصدير إلى `modules/reference-materials/` — أحدهما
// (‏.service) بلا مستورِد أصلاً أي كودٌ ميّت. حُذفت الوحدة، والمسار العام
// `/api/references` باقٍ كما هو (عقد الـAPI لم يتغيّر).
app.use('/api/references', authenticateToken, (await import('./modules/reference-materials/index.js')).default);

// Agent API Routes (uses API key authentication)
app.use('/api/agent', agentRoutes);

// User avatars (public, read-only). Files live at
// ~/.nassaj-users/<userId>/avatar.<ext> and are exposed at /avatars/<userId>.<ext>.
// The :userId segment must be all-digits and :ext one of the allowed image
// extensions; the served path is rebuilt from those validated parts only, so no
// portion of the request URL is interpolated into a filesystem path (no traversal).
const AVATARS_ROOT = path.join(os.homedir(), '.nassaj-users');
const AVATAR_EXT_TO_MIME = {
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
};
app.get('/avatars/:userId.:ext', (req, res) => {
    const { userId, ext } = req.params;
    if (!/^\d+$/.test(userId) || !Object.prototype.hasOwnProperty.call(AVATAR_EXT_TO_MIME, ext)) {
        return res.status(404).end();
    }
    const filePath = path.join(AVATARS_ROOT, userId, `avatar.${ext}`);
    res.type(AVATAR_EXT_TO_MIME[ext]);
    res.setHeader('Cache-Control', 'private, no-cache');
    // Defense in depth: forbid MIME sniffing so a stored file can never be
    // re-interpreted as HTML/script by the browser regardless of its bytes.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(filePath, (err) => {
        if (err && !res.headersSent) {
            res.status(404).end();
        }
    });
});

// Per-project logos (T-1403). Files live at
// ~/.nassaj-users/.project-logos/<projectId>.<ext> and are exposed at
// /project-logos/<projectId>.<ext>. The :projectId segment must match the
// project-id shape (36 chars of hex/dash — the UUID minted by the projects
// repository) and :ext one of the allowed image extensions; the served path is
// rebuilt from those validated parts only, so no portion of the request URL is
// interpolated into a filesystem path (no traversal).
// SVG is supported because the upload path sanitizes it server-side (DOMPurify)
// before writing; this route additionally serves everything under a strict CSP +
// nosniff, so no active content can execute even on direct navigation.
const PROJECT_LOGOS_ROOT = path.join(os.homedir(), '.nassaj-users', '.project-logos');
const PROJECT_LOGO_EXT_TO_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    svg: 'image/svg+xml',
};
app.get('/project-logos/:projectId.:ext', (req, res) => {
    const { projectId, ext } = req.params;
    if (
        !/^[0-9a-fA-F-]{36}$/.test(projectId) ||
        !Object.prototype.hasOwnProperty.call(PROJECT_LOGO_EXT_TO_MIME, ext)
    ) {
        return res.status(404).end();
    }
    const filePath = path.join(PROJECT_LOGOS_ROOT, `${projectId}.${ext}`);
    res.type(PROJECT_LOGO_EXT_TO_MIME[ext]);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:"
    );
    // Every upload mints a fresh `?v=` token, so a replaced logo is always a new
    // URL. A short cache with revalidation keeps the sidebar snappy without ever
    // pinning a stale image.
    res.setHeader('Cache-Control', 'private, max-age=60, must-revalidate');
    res.sendFile(filePath, (err) => {
        if (err && !res.headersSent) {
            res.status(404).end();
        }
    });
});

// App-wide custom branding logo. Stored under ~/.nassaj-users/.branding/logo.<ext>
// (a runtime directory that survives deployments — never inside dist/, which the
// build overwrites). Served at /branding/logo.<ext>. The :ext segment must be one
// of the allowed image extensions; the served path is rebuilt from that validated
// part only, so no portion of the request URL is interpolated into a filesystem
// path (no traversal). The on-disk filename is always logo.<ext> derived from the
// uploaded file's MIME type, never from any client-supplied name.
// SVG is supported: the upload path sanitizes it server-side (DOMPurify) before
// writing, and this route additionally serves it under a strict CSP + nosniff
// (defense in depth) so no active content can execute even on direct navigation.
const BRANDING_ROOT = path.join(os.homedir(), '.nassaj-users', '.branding');
const BRANDING_LOGO_PATH_KEY = 'branding.logo_path';
const BRANDING_LOGO_DARK_PATH_KEY = 'branding.logo_dark_path';
const BRANDING_EXT_TO_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    svg: 'image/svg+xml',
};
// :name is constrained to the two known basenames, so (with :ext validated
// below) no part of the URL reaches the filesystem path un-whitelisted.
app.get('/branding/:name(logo|logo_dark).:ext', (req, res) => {
    const { name, ext } = req.params;
    if (!Object.prototype.hasOwnProperty.call(BRANDING_EXT_TO_MIME, ext)) {
        return res.status(404).end();
    }
    // Only serve the extension that is currently recorded as the active logo in
    // app_config. This means a stale/orphaned file left under a different
    // extension (e.g. after a failed cleanup) is never served, even if it exists
    // on disk.
    const activeExt = appConfigDb.get(
        name === 'logo_dark' ? BRANDING_LOGO_DARK_PATH_KEY : BRANDING_LOGO_PATH_KEY
    );
    if (!activeExt || activeExt !== ext) {
        return res.status(404).end();
    }
    const filePath = path.join(BRANDING_ROOT, `${name}.${ext}`);
    res.type(BRANDING_EXT_TO_MIME[ext]);
    // Defense in depth: forbid MIME sniffing so the file can never be
    // re-interpreted as HTML/script by the browser regardless of its bytes.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Hardening for direct navigation to the asset — most important for SVG,
    // which a browser renders as a document. A locked-down CSP forbids any
    // script/object/external fetch, so even a sanitizer bypass cannot execute
    // code when the logo is opened directly. Applied to every logo extension.
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:"
    );
    // The logo is public-facing chrome shown to every authenticated user. Each
    // upload changes the URL (getBrandingLogoUrl appends a ?v=<version> token),
    // so a replaced logo is always a fresh URL and never hits a cached copy.
    // We still keep a short cache for snappiness, but require revalidation once
    // it goes stale (defense in depth: even a URL without ?v re-checks within a
    // minute instead of serving a possibly-stale entry from cache).
    res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    res.sendFile(filePath, (err) => {
        if (err && !res.headersSent) {
            res.status(404).end();
        }
    });
});

// Dynamic PWA manifest: serve public/manifest.json with its name fields
// overridden by the custom branding title (when one is set), so the installed
// PWA label follows the configured branding. Registered BEFORE the static
// mounts below so this route wins over the file on disk. Served with no-cache
// (the service worker fetches the manifest network-first) so a title change is
// picked up on the next load without a new build.
app.get('/manifest.json', createClientManifestHandler(APP_ROOT, getBrandingTitle));

// Static files served from the atomically promoted client generation after API
// routes. public/ is intentionally not mounted separately: Vite copies it into
// the staged generation, so every public asset changes in the same exchange as
// index.html. The dynamic /manifest.json route above remains authoritative.
// Browsers that loaded one of the three retained generations may request a lazy
// chunk after a newer generation is promoted. Serve current assets first, then
// search retained generations on a miss; this bounds disk growth without
// breaking those already-open tabs.
const immutableAssetHeaders = (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
app.use('/assets/generations', createClientPublicationStaticMiddleware(APP_ROOT));
app.use('/assets', express.static(path.join(APP_ROOT, 'dist', 'assets'), { setHeaders: immutableAssetHeaders }));
app.use('/assets', (req, res, next) => {
    let retained;
    try {
        retained = fs.readdirSync(APP_ROOT)
            .filter((name) => name.startsWith('dist.atomic.predeploy-previous-'))
            .sort()
            .reverse()
            .slice(0, 3);
    } catch {
        return next();
    }
    const serve = (index) => {
        if (index >= retained.length) return next();
        const root = path.join(APP_ROOT, retained[index], 'assets');
        return express.static(root, { setHeaders: immutableAssetHeaders })(req, res, () => serve(index + 1));
    };
    return serve(0);
});
// ADR-156 §3.1 (E1): the sealed node static overlay is mounted BEFORE
// express.static(dist) and after every /api route, so a node-owned static site
// (e.g. a node operator's /hub) is served from config/overlay/ without a tracked-path
// write. It serves only files in the owner-sealed manifest, opened O_NOFOLLOW
// with a per-request digest check, under an enforced strict CSP; a corrupt
// manifest disables the overlay and logs node_overlay_invalid without crashing.
// A corrupt manifest is surfaced to the operator by the preflight (W4), which
// re-reads config/overlay/ on demand; here we only log so boot never stalls.
mountNodeOverlay(app, {
    configDir: path.join(APP_ROOT, 'config'),
    onInvalid: (reason, detail) => console.warn(`[node-overlay] ${reason}`, detail?.field ?? ''),
});

// T-1798/T-1799/T-1800: operator-published pages are read from the EXTERNAL
// content root (app-data, never `dist/`), mounted before express.static(dist)
// so a publication keeps its public URL without adding a byte to the client
// asset inventory and without being erased by a generation swap. Delivery is
// sandboxed without `allow-same-origin`, so page script cannot reach this
// origin's session storage. Absent/unusable root => simply off.
mountPublicContent(app, {
    // T-1804: نفس الاستدعاء الذي يُبنى به الأمرُ المحقون في مطالبة الوكيل.
    // مصدرُ حلٍّ واحد لا اثنان: الوكيلُ ينشر حيث يقرأ الخادم، وإلا «نجح» النشرُ
    // وأرجع 404 (بيئةُ الطفل تحمل HOME/XDG_DATA_HOME مُبدَّلين).
    dataRoot: resolvePublicPageContentRoot({ appRoot: APP_ROOT }),
    logger: { info: (message, detail) => console.log(message, detail?.root ?? '') },
});

// Add cache control: HTML files should not be cached, but assets can be cached
app.use(express.static(path.join(APP_ROOT, 'dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            // Prevent HTML caching to avoid service worker issues after builds
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
            // Cache static assets for 1 year (they have hashed names)
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// API Routes (protected)
// /api/config endpoint removed - no longer needed
// Frontend now uses window.location for WebSocket URLs

// System update endpoint (B-36: privileged — spawns npm/git on the host, so it
// is restricted to admin-level roles, same gate as /api/admin).
const sourceUpdateCreateLimiter = createRateLimiter({ windowMs: 60_000, max: 5, message: 'Too many update requests, please slow down' });
const SOURCE_UPDATE_IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// T-1751 (ADR-159, owner decision 2026-09-12): starting an update with
// `activateWhenIdle` + matching consent is the owner's consent to its safe
// restart. The activator
// runs the job's own queued row through the command board's executor once the
// node is idle; it never kills a session and gives up to the button after 24 h.
const localActivationMode = resolveHostUpdateMode() === 'local-main';
const updateAutoActivator = releaseSourceInvalid && !localActivationMode ? null : createUpdateAutoActivator({
    beforeTick: localActivationMode ? async () => {
        const evidence = requestMaintenanceGate.readRecoveryEvidence();
        if (evidence.oidAdmissionIntentPending || (evidence.gateClosed && evidence.identity?.kind === 'oid-pair')) {
            await requestMaintenanceGate.recoverOrDeclareManual({ waitMs: 1000 });
        }
        return !requestMaintenanceGate.readPublicStatus().gateClosed;
    } : undefined,
    jobs: localActivationMode ? localUpdateActivationJobs() : sourceUpdateJobsDb,
    prepareJob: localActivationMode ? job => withLocalUpdateWriterLease('local-update-queue',
        () => ensureLocalUpdateAction(job.id, row => pendingServerActionsDb.enqueueGenerationBoundGlobal(row))) : undefined,
    listQueuedRestarts: () => pendingServerActionsDb.listActionable().filter((row) => row.actionType === 'safe-restart')
        .map(row => localActivationMode ? { ...row, sourceUpdateJobId: row.reason } : row),
    countSessions: countGovernedActiveSessions,
    executeAsOwner: ({ id, user }) => executeActionRowAs({ id, user, wss: app.locals.wss, trigger: localActivationMode ? 'local-update-activate' : 'update-auto-activate' }),
    getUser: (id) => userDb.getUserById(id),
    audit: (action, metadata) => auditLogDb.record(action, { metadata }),
    jobLog: updateJobLog,
});

app.post('/api/system/update/jobs', authenticateToken, requireRole('owner'), sourceUpdateCreateLimiter, async (req, res) => {
    try {
        if (process.env.NASSAJ_UPDATE_MODE === 'local-main') {
            return res.status(409).json({ success: false, code: 'local_update_required' });
        }
        if (process.env.NASSAJ_UPDATE_MODE && process.env.NASSAJ_UPDATE_MODE !== 'release') {
            return res.status(503).json({ success: false, code: 'local_update_mode_invalid' });
        }
        if (IS_PLATFORM) {
            return res.status(409).json({ success: false, code: 'platform_update_managed', error: 'Platform releases use the managed deployment workflow.' });
        }
        if (!updateHostCapability.ready || !updateHostCapability.jobStrategy) {
            return res.status(503).json({ success: false, code: 'update_capability_unavailable', error: 'The verified v2 update capability is unavailable.' });
        }
        const expectedVersion = req.body?.expectedVersion;
        const idempotencyKey = req.get('Idempotency-Key');
        if (!isNassajReleaseVersion(expectedVersion)) {
            return res.status(400).json({ success: false, code: 'invalid_release_version' });
        }
        if (!SOURCE_UPDATE_IDEMPOTENCY_KEY.test(idempotencyKey || '')) {
            return res.status(400).json({ success: false, code: 'invalid_idempotency_key' });
        }
        const ownerId = req.user?.id;
        if (!Number.isSafeInteger(ownerId)) return res.status(403).json({ success: false, code: 'owner_identity_unavailable' });
        const strategy = updateHostCapability.jobStrategy;
        const deferUntilIdle = req.body?.deferUntilIdle === true;
        // T-1751 hardened (owner decision 2026-09-12, ADR-159): activateWhenIdle
        // is the owner's consent to a safe restart. auto_activate is set ONLY when
        // the client echoes consent for the exact version it displayed AND that
        // version matches this job's resolved target (expectedVersion). A mismatch
        // is refused (409 update_consent_mismatch); a missing consent leaves
        // auto_activate off, so the command board's yellow-box confirmation
        // remains the activation path. The consent is recorded in the audit log.
        const activateWhenIdle = req.body?.activateWhenIdle === true;
        let autoActivate = false;
        if (activateWhenIdle) {
            const consentVersion = typeof req.body?.consent?.version === 'string' ? req.body.consent.version : null;
            if (consentVersion) {
                if (consentVersion !== expectedVersion) {
                    return res.status(409).json({ success: false, code: 'update_consent_mismatch' });
                }
                autoActivate = true;
            }
        }
        const jobInput = {
            id: crypto.randomUUID(), ownerId, expectedVersion, strategy, autoActivate,
            idempotencyKeyHash: hashSourceUpdateIdempotencyKey(idempotencyKey),
            requestFingerprint: sourceUpdateRequestFingerprint(ownerId, expectedVersion, strategy, autoActivate, deferUntilIdle),
        };
        let created;
        if (deferUntilIdle) {
            // ADR-156 §3.3 (M4): with live sessions the job parks in
            // awaiting_sessions; idle now, it enters accepted directly, and either
            // way carries defer_until_idle=1 so a later worker `active_sessions`
            // refusal can rearm within the same absolute deadline.
            const sessions = countGovernedActiveSessions();
            const initialState = sessions > 0 ? 'awaiting_sessions' : 'accepted';
            created = sourceUpdateJobsDb.createDeferred(
                { ...jobInput, deferralDeadlineAt: Date.now() + DEFER_MAX_MS }, initialState,
            );
            if (!created.reused) {
                auditLogDb.record('update_deferral_created', { userId: ownerId, metadata: { jobId: created.job.id, initialState } });
            }
        } else {
            created = sourceUpdateJobsDb.createOrReuse(jobInput);
        }
        if (created.mismatch) {
            const ownedJob = created.activeConflict && created.job
                ? sourceUpdateJobsDb.getForOwner(created.job.id, ownerId) : null;
            return res.status(409).json({
                success: false, code: created.activeConflict ? 'update_in_progress' : 'idempotency_mismatch',
                ...(ownedJob ? {
                    jobId: ownedJob.id, state: ownedJob.state, targetVersion: ownedJob.expected_version,
                    statusUrl: `/api/system/update/jobs/${encodeURIComponent(ownedJob.id)}`,
                } : {}),
            });
        }
        // Record the consent ONLY after a successful, non-reused creation: never on
        // a rejection (consent mismatch / idempotency conflict return above), and
        // not again when an idempotent request reuses an existing job (qa-critic).
        if (autoActivate && !created.reused) {
            auditLogDb.record('update_consent_recorded', { userId: ownerId, metadata: { version: expectedVersion, jobId: created.job.id } });
        }
        return res.status(202).json({
            jobId: created.job.id,
            state: created.job.state,
            statusUrl: `/api/system/update/jobs/${created.job.id}`,
            reused: created.reused,
            retryAfterMs: 1000,
        });
    } catch (error) {
        const response = sourceUpdateErrorPayload(error);
        return res.status(response.status).json(response.body);
    }
});

// Is this update job still running? Stated positively and independently, NOT
// derived by negating "is this row abandoned": that predicate answers false for
// a row whose job row is GONE, and negating it would then call a deleted job
// live — the orphan the stale-row check exists to find (ADR-156 ح-3).
const isSourceUpdateJobLive = (jobId) => {
    if (typeof jobId !== 'string' || jobId.length === 0) return false;
    const job = sourceUpdateJobsDb.getById(jobId);
    if (!job) return false;
    return !SUPERSEDABLE_UPDATE_JOB_STATES.has(job.state);
};

// Read-only update pre-flight (ADR-156 أ.5, WI-7/T-1719). Diagnoses the ten
// failures that are predictable BEFORE any write, each with a single bilingual
// reason and a single action. It never writes: the repairs it names are
// performed by the update job under the writer lease, never by this GET.
const updatePreflight = createUpdatePreflight({
    appRoot: APP_ROOT,
    activeSessionCount: countGovernedActiveSessions,
    listQueuedSafeRestarts: () => pendingServerActionsDb.listActionable().filter((row) => row.actionType === 'safe-restart'),
    isSourceUpdateJobLive,
});

// Its own limiter, not the POST instance: sharing one bucket would let a burst
// of read-only diagnoses consume the allowance the owner needs to actually
// start an update (ADR-156 م-3). It spawns `git ls-remote` and touches the
// network, so it is rate limited on its own terms; single-flight inside the
// service keeps a burst of clicks to one probe.
const updatePreflightLimiter = createRateLimiter({ windowMs: 60_000, max: 5, message: 'Too many preflight requests, please slow down' });

app.get('/api/system/update/preflight', authenticateToken, requireRole('owner'), updatePreflightLimiter, async (_req, res) => {
    try {
        if (IS_PLATFORM) {
            return res.status(409).json({ success: false, code: 'platform_update_managed', error: 'Platform releases use the managed deployment workflow.' });
        }
        if (!updateHostCapability.ready || !updateHostCapability.jobStrategy) {
            return res.status(503).json({ success: false, code: 'update_capability_unavailable', error: 'The verified v2 update capability is unavailable.' });
        }
        return res.json(preflightResponse(await updatePreflight()));
    } catch (error) {
        console.error('[update-preflight] diagnosis failed:', error?.message || 'unknown error');
        return res.status(500).json({ success: false, code: 'update_preflight_unavailable' });
    }
});

// Discovery is owner-scoped and read-only, just like the individual job snapshot.
app.get('/api/system/update/jobs/active', authenticateToken, requireRole('owner'), (req, res) => {
    const ownerId = req.user?.id;
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) {
        return res.status(403).json({ success: false, code: 'owner_identity_unavailable' });
    }
    const job = sourceUpdateJobsDb.getActiveForOwner(ownerId);
    res.set('Cache-Control', 'no-store');
    return res.json({ job: job ? {
        jobId: job.id, state: job.state, targetVersion: job.expected_version,
        statusUrl: `/api/system/update/jobs/${encodeURIComponent(job.id)}`,
    } : null });
});

app.get('/api/system/update/jobs/:jobId', authenticateToken, requireRole('owner'), (req, res) => {
    const ownerId = req.user?.id;
    const job = Number.isSafeInteger(ownerId) ? sourceUpdateJobsDb.getForOwner(req.params.jobId, ownerId) : null;
    if (!job) return res.status(404).json({ success: false, code: 'update_job_not_found' });
    const failure = deriveUpdateJobFailure(job, sourceUpdateJobsDb);
    return res.json({
        jobId: job.id, state: job.state, expectedVersion: job.expected_version,
        strategy: job.strategy, progressSeq: job.progress_seq,
        // Flat failure contract (T-1750): the client reads these directly. The
        // nested `error` object is kept unchanged for backward compatibility.
        targetVersion: job.expected_version,
        failedPhase: failure.failedPhase,
        errorCode: failure.errorCode,
        message: failure.message,
        // T-1804: WHICH files drifted, structurally. The message is sanitized
        // (paths folded to basenames), so naming them there misled the operator.
        manifestDrift: failure.manifestDrift,
        error: job.error_code ? { code: job.error_code, message: job.error_message } : null,
        createdAt: job.created_at, updatedAt: job.updated_at, completedAt: job.completed_at,
        activationTargetDigest: job.activation_identity_sha256 ?? null,
        autoActivate: job.auto_activate === 1,
        autoActivation: updateAutoActivator?.statusFor(job.id) ?? null,
        // ADR-156 §3.3 (M15): only present while the job is parked in
        // awaiting_sessions. sessionCount and gateReason are live at request time.
        deferral: deriveUpdateJobDeferral(job, {
            sessionCount: (() => { try { return countGovernedActiveSessions(); } catch { return null; } })(),
            gateReason: updateDeferralScheduler?.getLastGateReason() ?? null,
        }),
    });
});

// ADR-156 §3.3: cancel an owner-deferred update. Owner-only, rate limited, and
// accepted ONLY while the job is parked in awaiting_sessions — cancelDeferred is
// scoped to (jobId, ownerId, state='awaiting_sessions'), so any other state,
// another owner, or a missing job returns 409 update_not_cancellable.
const sourceUpdateCancelLimiter = createRateLimiter({ windowMs: 60_000, max: 10, message: 'Too many cancel requests, please slow down' });
app.post('/api/system/update/jobs/:jobId/cancel', authenticateToken, requireRole('owner'), sourceUpdateCancelLimiter, (req, res) => {
    const ownerId = req.user?.id;
    if (!Number.isSafeInteger(ownerId)) return res.status(403).json({ success: false, code: 'owner_identity_unavailable' });
    const cancelled = sourceUpdateJobsDb.cancelDeferred(req.params.jobId, ownerId);
    if (!cancelled) return res.status(409).json({ success: false, code: 'update_not_cancellable' });
    auditLogDb.record('update_deferral_cancelled', { userId: ownerId, metadata: { jobId: req.params.jobId } });
    return res.json({ jobId: req.params.jobId, state: 'cancelled' });
});

// T-1768: the job's live terminal log, read from a byte offset so the modal
// polls only what is new. Owner-only and already sanitized at write time.
const updateJobLogLimiter = createRateLimiter({ windowMs: 60_000, max: 240, message: 'Too many log requests, please slow down' });
app.get('/api/system/update/jobs/:jobId/log', authenticateToken, requireRole('owner'), updateJobLogLimiter, (req, res) => {
    const ownerId = req.user?.id;
    const job = Number.isSafeInteger(ownerId) ? sourceUpdateJobsDb.getForOwner(req.params.jobId, ownerId) : null;
    if (!job) return res.status(404).json({ success: false, code: 'update_job_not_found' });
    const requested = Number.parseInt(String(req.query.offset ?? '0'), 10);
    const chunk = updateJobLog.read(job.id, Number.isSafeInteger(requested) ? requested : 0);
    res.set('Cache-Control', 'no-store');
    return res.json({ ...chunk, state: job.state });
});

// Removed synchronous v1 endpoint: never alias it to the async job contract.
app.post('/api/system/update', authenticateToken, requireRole('owner'), (_req, res) => res.status(410).json({
    success: false,
    code: 'update_protocol_upgrade_required',
    statusUrl: '/api/system/update/jobs',
}));

const expandWorkspacePath = (inputPath) => {
    if (!inputPath) return inputPath;
    if (inputPath === '~') {
        return WORKSPACES_ROOT;
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
        return path.join(WORKSPACES_ROOT, inputPath.slice(2));
    }
    return inputPath;
};

// Browse filesystem endpoint for project suggestions - uses existing getFileTree
app.get('/api/browse-filesystem', authenticateToken, async (req, res) => {
    try {
        const { path: dirPath } = req.query;

        console.log('[API] Browse filesystem request for path:', dirPath);
        console.log('[API] WORKSPACES_ROOT is:', WORKSPACES_ROOT);
        // Default to home directory if no path provided
        const defaultRoot = WORKSPACES_ROOT;
        let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

        // Resolve and normalize the path
        targetPath = path.resolve(targetPath);

        // Security check - ensure path is within allowed workspace root
        const validation = await validateWorkspacePath(targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolvedPath = validation.resolvedPath || targetPath;

        // Security check - ensure path is accessible
        try {
            await fs.promises.access(resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);

            if (!stats.isDirectory()) {
                return res.status(400).json({ error: 'Path is not a directory' });
            }
        } catch (err) {
            return res.status(404).json({ error: 'Directory not accessible' });
        }

        // Use existing getFileTree function with shallow depth (only direct children)
        const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

        // Filter only directories and format for suggestions
        const directories = fileTree
            .filter(item => item.type === 'directory')
            .map(item => ({
                path: item.path,
                name: item.name,
                type: 'directory'
            }))
            .sort((a, b) => {
                const aHidden = a.name.startsWith('.');
                const bHidden = b.name.startsWith('.');
                if (aHidden && !bHidden) return 1;
                if (!aHidden && bHidden) return -1;
                return a.name.localeCompare(b.name);
            });

        // Add common directories if browsing home directory
        const suggestions = [];
        let resolvedWorkspaceRoot = defaultRoot;
        try {
            resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
        } catch (error) {
            // Use default root as-is if realpath fails
        }
        if (resolvedPath === resolvedWorkspaceRoot) {
            const commonDirs = ['Desktop', 'Documents', 'Projects', 'Development', 'Dev', 'Code', 'workspace'];
            const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
            const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

            suggestions.push(...existingCommon, ...otherDirs);
        } else {
            suggestions.push(...directories);
        }

        res.json({
            path: resolvedPath,
            suggestions: suggestions
        });

    } catch (error) {
        console.error('Error browsing filesystem:', error);
        res.status(500).json({ error: 'Failed to browse filesystem' });
    }
});

app.post('/api/create-folder', authenticateToken,
    applicationWriterLeaseMiddleware('file-create'), async (req, res) => {
    try {
        const { path: folderPath } = req.body;
        if (!folderPath) {
            return res.status(400).json({ error: 'Path is required' });
        }
        const expandedPath = expandWorkspacePath(folderPath);
        const resolvedInput = path.resolve(expandedPath);
        const validation = await validateWorkspacePath(resolvedInput);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const targetPath = validation.resolvedPath || resolvedInput;
        const parentDir = path.dirname(targetPath);
        try {
            await fs.promises.access(parentDir);
        } catch (err) {
            return res.status(404).json({ error: 'Parent directory does not exist' });
        }
        try {
            await fs.promises.access(targetPath);
            return res.status(409).json({ error: 'Folder already exists' });
        } catch (err) {
            // Folder doesn't exist, which is what we want
        }
        try {
            await fs.promises.mkdir(targetPath, { recursive: false });
            res.json({ success: true, path: targetPath });
        } catch (mkdirError) {
            if (mkdirError.code === 'EEXIST') {
                return res.status(409).json({ error: 'Folder already exists' });
            }
            throw mkdirError;
        }
    } catch (error) {
        console.error('Error creating folder:', error);
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Read file content endpoint
app.get('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // B-PRIV guard: 404 (not 403) when the project is not visible to this
        // user, so a private project's existence is never disclosed.
        if (!isProjectVisible(projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Resolve the absolute project root via the DB-backed helper; the
        // caller passes the DB-assigned `projectId`, not a folder name.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Resolve + canonicalize (follows symlinks) via the shared read guard so
        // a symlink inside the tree pointing outside it cannot leak an arbitrary
        // file (B-159). Open only the verified real path.
        const guard = await resolveReadPathInProject(projectRoot, filePath);
        if (!guard.valid) {
            if (guard.code === 'ENOENT') {
                return res.status(404).json({ error: 'File not found' });
            }
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Defense in depth: this route returns JSON (never raw renderable bytes),
        // but forbid MIME sniffing anyway so the response can never be coerced
        // into an active document.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const content = await fsPromises.readFile(guard.realResolved, 'utf8');
        res.json({ content, path: guard.resolved });
    } catch (error) {
        console.error('Error reading file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Serve raw file bytes for previews and downloads.
app.get('/api/projects/:projectId/files/content', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: filePath } = req.query;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        // B-PRIV guard: 404 (not 403) when the project is not visible to the user.
        if (!isProjectVisible(projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Resolve + canonicalize (follows symlinks) via the shared read guard.
        // path.resolve + startsWith alone is lexical and would let a symlink
        // inside the tree pointing outside it stream an arbitrary file (B-159).
        // The realpath check runs BEFORE the file is opened; we then stream only
        // the verified real path. A missing file/component surfaces as ENOENT.
        const guard = await resolveReadPathInProject(projectRoot, filePath);
        if (!guard.valid) {
            if (guard.code === 'ENOENT') {
                return res.status(404).json({ error: 'File not found' });
            }
            return res.status(403).json({ error: 'Path must be under project root' });
        }

        // Content type from the requested name's extension.
        const mimeType = mime.lookup(guard.resolved) || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);

        // B-158 hardening for direct navigation to the raw bytes:
        //  - nosniff on every response so a stored file can never be re-sniffed
        //    into an active type regardless of its bytes.
        //  - For types a browser renders as an active document (SVG/HTML/XML),
        //    force a download disposition so an embedded <script> cannot execute
        //    on direct navigation (stored XSS). Inline media preview is unaffected:
        //    ImageViewer / CodeEditorMediaPreview fetch via XHR and build a blob
        //    URL, and Content-Disposition never influences an <img>/fetch load.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (RENDERABLE_XSS_TYPES.has(String(mimeType).toLowerCase())) {
            res.setHeader('Content-Disposition', 'attachment');
        }

        // Stream the verified real path (not the lexical one) to avoid a
        // symlink swap between the check and the open.
        const fileStream = fs.createReadStream(guard.realResolved);
        fileStream.pipe(res);

        fileStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Error reading file' });
            }
        });

    } catch (error) {
        console.error('Error serving binary file:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Save file content endpoint
app.put('/api/projects/:projectId/file', authenticateToken,
    applicationWriterLeaseMiddleware('file-save'), async (req, res) => {
    try {
        const { projectId } = req.params;
        const { filePath, content } = req.body;


        // Security: ensure the requested path is inside the project root
        if (!filePath) {
            return res.status(400).json({ error: 'Invalid file path' });
        }

        if (content === undefined) {
            return res.status(400).json({ error: 'Content is required' });
        }

        // B-138 write guard: reject when the caller may not WRITE here (creator /
        // member / participant — NOT mere public visibility). 404 (not 403) keeps
        // the B-PRIV non-disclosure guarantee for private projects.
        if (!projectsDb.isProjectWritableByUser(projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Projects are now addressed by DB `projectId`, resolved to their path here.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Route through the SHARED guard, exactly like every sibling mutate
        // endpoint (create / rename / delete / upload). This block used to
        // re-implement the boundary locally as `resolved.startsWith(root)`,
        // which is purely LEXICAL: it never canonicalized, so a symlink planted
        // inside the tree (a cloned repo can ship one) let this write land on an
        // arbitrary path on disk. B-159 closed that on the READ endpoints only;
        // this was the last write still on the old check.
        const validation = validatePathInProject(projectRoot, filePath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }
        const resolved = validation.resolved;

        // Write the new content (the guard-approved path, never a raw client one)
        const relativeDocumentPath = path.relative(projectRoot, resolved);
        if (isShareableDocument(relativeDocumentPath)) {
            await saveSharedDocumentAtomically(projectRoot, relativeDocumentPath, content);
        } else {
            await fsPromises.writeFile(resolved, content, 'utf8');
        }

        res.json({
            success: true,
            path: resolved,
            message: 'File saved successfully'
        });
    } catch (error) {
        console.error('Error saving file:', error);
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

app.get('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
    try {

        // Using fsPromises from import

        // B-PRIV guard: 404 (not 403) when the project is not visible to the user.
        if (!isProjectVisible(req.params.projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Resolve the project's absolute path through the DB (projectId is the
        // primary key of the `projects` table after the identifier migration).
        const actualPath = await projectsDb.getProjectPathById(req.params.projectId);
        if (!actualPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Check if path exists
        try {
            await fsPromises.access(actualPath);
        } catch (e) {
            return res.status(404).json({ error: `Project path not found: ${actualPath}` });
        }

        const files = await getFileTree(actualPath, 10, 0, true);
        res.json(files);
    } catch (error) {
        console.error('[ERROR] File tree error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

/**
 * Private staging directory for every upload that lands in temp before being
 * copied into a project tree.
 *
 * All three upload paths used to drop their files straight into `os.tmpdir()`
 * (world-traversable, and with names an attacker can guess or pre-create as a
 * symlink). `fs.mkdtemp` gives an unpredictable name created with 0700, so the
 * staging area cannot be pre-seeded or read by another account — the pattern
 * already used for codex image staging in openai-codex.js.
 *
 * Created lazily ONCE per process and memoised as a promise, so concurrent
 * uploads share one directory instead of racing to create it. A creation
 * failure is not cached: the next upload retries.
 *
 * @returns {Promise<string>} absolute path of the 0700 staging directory
 */
let uploadStagingDirPromise = null;
function getUploadStagingDir() {
    if (!uploadStagingDirPromise) {
        uploadStagingDirPromise = fsPromises
            .mkdtemp(path.join(os.tmpdir(), 'nassaj-uploads-'))
            .catch((error) => {
                uploadStagingDirPromise = null; // don't cache the failure
                throw error;
            });
    }
    return uploadStagingDirPromise;
}

/**
 * multer `destination` callback backed by the private staging dir above.
 * @param {import('express').Request} _req
 * @param {Express.Multer.File} _file
 * @param {(error: Error | null, destination?: string) => void} cb
 */
function stageUploadDestination(_req, _file, cb) {
    getUploadStagingDir().then((dir) => cb(null, dir), (error) => cb(error));
}

/**
 * Builds a multer instance for endpoints that receive uploads into the private
 * staging dir before the route copies them into the project tree. Centralises the
 * dynamic multer import, the temp diskStorage (collision-proof unique name with
 * NO path components — folder-upload originalnames may contain separators), and
 * the size/count limits.
 *
 * NOTE: deliberately NOT wired into the legacy `uploadFilesHandler` or the
 * `upload-images` endpoint — their filename/destination/limit semantics differ
 * and changing them is out of scope. New attachment endpoint only.
 *
 * @param {Object} opts
 * @param {Function} opts.fileFilter - multer fileFilter(req, file, cb)
 * @param {number} opts.maxSizeBytes - per-file byte cap (limits.fileSize)
 * @param {number} opts.maxCount - max file count (limits.files)
 * @returns {Promise<import('multer').Multer>}
 */
async function buildTempUploadMulter({ fileFilter, maxSizeBytes, maxCount }) {
    const multer = (await import('multer')).default;
    return multer({
        storage: multer.diskStorage({
            destination: stageUploadDestination,
            filename: (req, file, cb) => {
                // Unique temp name only; the original (possibly unsafe) name is
                // preserved on file.originalname and sanitised by the route.
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        fileFilter,
        limits: {
            fileSize: maxSizeBytes,
            files: maxCount
        }
    });
}

/**
 * Validate that a path is within the project root
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
function validatePathInProject(projectRoot, targetPath) {
    const resolved = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(projectRoot, targetPath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot)) {
        return { valid: false, error: 'Path must be under project root' };
    }
    // B-159: the check above is purely lexical. Canonicalize the deepest existing
    // ancestor (the target may not exist yet on write/rename) and reject if it
    // escapes the project root — a symlink planted inside the tree (e.g. shipped
    // in a cloned repo) pointing outside would otherwise let a write/delete land
    // on an arbitrary path.
    if (!isResolvedPathInsideRootReal(projectRoot, resolved)) {
        return { valid: false, error: 'Path must be under project root' };
    }
    return { valid: true, resolved };
}

/**
 * Validate filename - check for invalid characters
 * @param {string} name - The filename to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilename(name) {
    if (!name || !name.trim()) {
        return { valid: false, error: 'Filename cannot be empty' };
    }
    // Check for invalid characters (Windows + Unix)
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(name)) {
        return { valid: false, error: 'Filename contains invalid characters' };
    }
    // Check for reserved names (Windows)
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reserved.test(name)) {
        return { valid: false, error: 'Filename is a reserved name' };
    }
    // Check for dots only
    if (/^\.+$/.test(name)) {
        return { valid: false, error: 'Filename cannot be only dots' };
    }
    return { valid: true };
}

/**
 * Validate a CLIENT-SUPPLIED relative path for an upload destination.
 *
 * The upload endpoint takes the destination name from the request body
 * (`relativePaths[i]`, which folder uploads use to recreate the directory
 * layout) — NOT from the stored file — and previously joined it onto the target
 * directory with no sanitisation whatsoever. Everything the client sends is
 * therefore hostile input on a write path.
 *
 * The rules reuse `validateFilename` per segment, so a name accepted here is
 * exactly a name the create/rename endpoints would accept: control characters,
 * shell/Windows-hostile characters and reserved names are refused, while
 * ordinary non-ASCII names (Arabic filenames are the norm in this product)
 * pass through untouched. On top of that, `..` and absolute paths are refused
 * outright rather than normalised away, so a traversal attempt is a visible
 * rejection instead of a silently rewritten path.
 *
 * This does NOT replace the project-root boundary check — the caller still runs
 * validatePathInProject on the joined result. It removes the classes of name
 * that should never reach the filesystem in the first place.
 *
 * @param {unknown} relPath - Raw value from the request body.
 * @returns {{ valid: true, safePath: string } | { valid: false, error: string }}
 */
function validateUploadRelativePath(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
        return { valid: false, error: 'Invalid upload file name' };
    }
    if (relPath.includes('\0')) {
        return { valid: false, error: 'Invalid upload file name' };
    }
    // Absolute paths (POSIX or Windows drive/UNC) are never a valid *relative*
    // destination inside a project.
    if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || /^[\\/]/.test(relPath)) {
        return { valid: false, error: 'Upload file name must be relative' };
    }

    const segments = relPath.split(/[\\/]+/).filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0) {
        return { valid: false, error: 'Invalid upload file name' };
    }
    for (const segment of segments) {
        if (segment === '..') {
            return { valid: false, error: 'Upload file name must not traverse directories' };
        }
        const segmentCheck = validateFilename(segment);
        if (!segmentCheck.valid) {
            return { valid: false, error: segmentCheck.error };
        }
    }
    return { valid: true, safePath: segments.join(path.sep) };
}

// POST /api/projects/:projectId/files/create - Create new file or directory
app.post('/api/projects/:projectId/files/create', authenticateToken,
    applicationWriterLeaseMiddleware('file-create'), async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: parentPath, type, name } = req.body;

        // Validate input
        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        if (!['file', 'directory'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "file" or "directory"' });
        }

        const nameValidation = validateFilename(name);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // B-138 write guard: reject when the caller may not WRITE here (creator /
        // member / participant — NOT mere public visibility). 404 (not 403) keeps
        // the B-PRIV non-disclosure guarantee for private projects.
        if (!projectsDb.isProjectWritableByUser(projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Build and validate target path
        const targetDir = parentPath || '';
        const targetPath = targetDir ? path.join(targetDir, name) : name;
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if already exists
        try {
            await fsPromises.access(resolvedPath);
            return res.status(409).json({ error: `${type === 'file' ? 'File' : 'Directory'} already exists` });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Create file or directory
        if (type === 'directory') {
            await fsPromises.mkdir(resolvedPath, { recursive: false });
        } else {
            // Ensure parent directory exists
            const parentDir = path.dirname(resolvedPath);
            try {
                await fsPromises.access(parentDir);
            } catch {
                await fsPromises.mkdir(parentDir, { recursive: true });
            }
            await fsPromises.writeFile(resolvedPath, '', 'utf8');
        }

        res.json({
            success: true,
            path: resolvedPath,
            name,
            type,
            message: `${type === 'file' ? 'File' : 'Directory'} created successfully`
        });
    } catch (error) {
        console.error('Error creating file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'Parent directory not found' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// PUT /api/projects/:projectId/files/rename - Rename file or directory
app.put('/api/projects/:projectId/files/rename', authenticateToken,
    applicationWriterLeaseMiddleware('file-rename'), async (req, res) => {
    try {
        const { projectId } = req.params;
        const { oldPath, newName } = req.body;

        // Validate input
        if (!oldPath || !newName) {
            return res.status(400).json({ error: 'oldPath and newName are required' });
        }

        const nameValidation = validateFilename(newName);
        if (!nameValidation.valid) {
            return res.status(400).json({ error: nameValidation.error });
        }

        // B-138 write guard: reject when the caller may not WRITE here (creator /
        // member / participant — NOT mere public visibility). 404 (not 403) keeps
        // the B-PRIV non-disclosure guarantee for private projects.
        if (!projectsDb.isProjectWritableByUser(projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate old path
        const oldValidation = validatePathInProject(projectRoot, oldPath);
        if (!oldValidation.valid) {
            return res.status(403).json({ error: oldValidation.error });
        }

        const resolvedOldPath = oldValidation.resolved;

        // Check if old path exists
        try {
            await fsPromises.access(resolvedOldPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Build and validate new path
        const parentDir = path.dirname(resolvedOldPath);
        const resolvedNewPath = path.join(parentDir, newName);
        const newValidation = validatePathInProject(projectRoot, resolvedNewPath);
        if (!newValidation.valid) {
            return res.status(403).json({ error: newValidation.error });
        }

        // Check if new path already exists
        try {
            await fsPromises.access(resolvedNewPath);
            return res.status(409).json({ error: 'A file or directory with this name already exists' });
        } catch {
            // Doesn't exist, which is what we want
        }

        // Rename
        await fsPromises.rename(resolvedOldPath, resolvedNewPath);

        res.json({
            success: true,
            oldPath: resolvedOldPath,
            newPath: resolvedNewPath,
            newName,
            message: 'Renamed successfully'
        });
    } catch (error) {
        console.error('Error renaming file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'EXDEV') {
            res.status(400).json({ error: 'Cannot move across different filesystems' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// DELETE /api/projects/:projectId/files - Delete file or directory
app.delete('/api/projects/:projectId/files', authenticateToken,
    applicationWriterLeaseMiddleware('file-delete'), async (req, res) => {
    try {
        const { projectId } = req.params;
        const { path: targetPath, type } = req.body;

        // Validate input
        if (!targetPath) {
            return res.status(400).json({ error: 'Path is required' });
        }

        // B-138 write guard: DELETE is a mutation, so it needs WRITE authorization
        // (creator / member / participant — NOT mere public visibility). Without
        // this a non-member could delete files in another user's public project.
        // 404 (not 403) keeps the B-PRIV non-disclosure guarantee for private ones.
        if (!projectsDb.isProjectWritableByUser(projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Resolve the project directory through the DB using the new projectId.
        const projectRoot = await projectsDb.getProjectPathById(projectId);
        if (!projectRoot) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Validate path
        const validation = validatePathInProject(projectRoot, targetPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const resolvedPath = validation.resolved;

        // Check if path exists and get stats
        let stats;
        try {
            stats = await fsPromises.stat(resolvedPath);
        } catch {
            return res.status(404).json({ error: 'File or directory not found' });
        }

        // Prevent deleting the project root itself
        if (resolvedPath === path.resolve(projectRoot)) {
            return res.status(403).json({ error: 'Cannot delete project root directory' });
        }

        // Delete based on type
        if (stats.isDirectory()) {
            await fsPromises.rm(resolvedPath, { recursive: true, force: true });
        } else {
            await fsPromises.unlink(resolvedPath);
        }

        res.json({
            success: true,
            path: resolvedPath,
            type: stats.isDirectory() ? 'directory' : 'file',
            message: 'Deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting file/directory:', error);
        if (error.code === 'EACCES') {
            res.status(403).json({ error: 'Permission denied' });
        } else if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'File or directory not found' });
        } else if (error.code === 'ENOTEMPTY') {
            res.status(400).json({ error: 'Directory is not empty' });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// POST /api/projects/:projectId/files/upload - Upload files
// Dynamic import of multer for file uploads
const uploadFilesHandler = async (req, res) => {
    // Dynamic import of multer
    const multer = (await import('multer')).default;

    const uploadMiddleware = multer({
        storage: multer.diskStorage({
            // Private 0700 staging dir instead of the shared, guessable os.tmpdir().
            destination: stageUploadDestination,
            filename: (req, file, cb) => {
                // Use a unique temp name, but preserve original name in file.originalname
                // Note: file.originalname may contain path separators for folder uploads
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                // For temp file, just use a safe unique name without the path
                cb(null, `upload-${uniqueSuffix}`);
            }
        }),
        // This endpoint had NO fileFilter at all: 20 files x 200MB of anything,
        // named by the client. A general file manager cannot meaningfully
        // allowlist CONTENT types (uploading arbitrary source files is the
        // feature), so the filter gates the one thing that is never legitimate:
        // a hostile NAME. Rejecting the whole request — rather than skipping the
        // offending file — is deliberate: the route pairs req.files[i] with
        // relativePaths[i] positionally, so dropping one file mid-batch would
        // silently shift every later name onto the wrong bytes.
        fileFilter: (req, file, cb) => {
            const nameCheck = validateUploadRelativePath(file.originalname);
            if (!nameCheck.valid) {
                const nameError = new Error(nameCheck.error);
                nameError.code = 'INVALID_UPLOAD_NAME';
                return cb(nameError);
            }
            return cb(null, true);
        },
        limits: {
            fileSize: MAX_FILE_UPLOAD_SIZE_BYTES,
            files: MAX_FILE_UPLOAD_COUNT
        }
    });

    // Use multer middleware
    return new Promise((resolve, reject) => { uploadMiddleware.array('files', MAX_FILE_UPLOAD_COUNT)(req, res, (err) => { void (async () => {
        if (err) {
            console.error('Multer error:', err);
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_UPLOAD_SIZE_MB}MB.` });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ error: `Too many files. Maximum is ${MAX_FILE_UPLOAD_COUNT} files.` });
            }
            if (err.code === 'INVALID_UPLOAD_NAME') {
                // Client-side problem (or an attack), not a server fault.
                return res.status(400).json({ error: err.message });
            }
            return res.status(500).json({ error: err.message });
        }

        try {
            const { projectId } = req.params;
            const { targetPath, relativePaths, requestedFileCount: requestedFileCountRaw } = req.body;

            // B-138 write guard: uploads MUTATE the project tree, so require WRITE
            // authorization (creator / member / participant — NOT mere public
            // visibility). Temp uploads land in os.tmpdir(), so rejecting here
            // (before any write into the project) fully protects the project. 404
            // (not 403) keeps the B-PRIV non-disclosure guarantee for private ones.
            if (!projectsDb.isProjectWritableByUser(projectId, coerceUserId(req.user?.id))) {
                return res.status(404).json({ error: 'Project not found' });
            }

            // Parse relative paths if provided (for folder uploads)
            let filePaths = [];
            if (relativePaths) {
                try {
                    filePaths = JSON.parse(relativePaths);
                } catch (e) {
                    console.log('[DEBUG] Failed to parse relativePaths:', relativePaths);
                }
            }

            console.log('[DEBUG] File upload request:', {
                projectId,
                targetPath: JSON.stringify(targetPath),
                targetPathType: typeof targetPath,
                filesCount: req.files?.length,
                relativePaths: filePaths
            });

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files provided' });
            }

            const parsedRequestedFileCount = Number.parseInt(requestedFileCountRaw, 10);
            const requestedFileCount = Number.isFinite(parsedRequestedFileCount) && parsedRequestedFileCount > 0
                ? parsedRequestedFileCount
                : req.files.length;

            // Resolve the project directory through the DB using the new projectId.
            const projectRoot = await projectsDb.getProjectPathById(projectId);
            if (!projectRoot) {
                return res.status(404).json({ error: 'Project not found' });
            }

            console.log('[DEBUG] Project root:', projectRoot);

            // Validate and resolve target path
            // If targetPath is empty or '.', use project root directly
            const targetDir = targetPath || '';
            let resolvedTargetDir;

            console.log('[DEBUG] Target dir:', JSON.stringify(targetDir));

            if (!targetDir || targetDir === '.' || targetDir === './') {
                // Empty path means upload to project root
                resolvedTargetDir = path.resolve(projectRoot);
                console.log('[DEBUG] Using project root as target:', resolvedTargetDir);
            } else {
                const validation = validatePathInProject(projectRoot, targetDir);
                if (!validation.valid) {
                    console.log('[DEBUG] Path validation failed:', validation.error);
                    return res.status(403).json({ error: validation.error });
                }
                resolvedTargetDir = validation.resolved;
                console.log('[DEBUG] Resolved target dir:', resolvedTargetDir);
            }

            // Ensure target directory exists
            try {
                await fsPromises.access(resolvedTargetDir);
            } catch {
                await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
            }

            // Move uploaded files from temp to target directory
            const uploadedFiles = [];
            console.log('[DEBUG] Processing files:', req.files.map(f => ({ originalname: f.originalname, path: f.path })));
            for (let i = 0; i < req.files.length; i++) {
                const file = req.files[i];
                // Use relative path if provided (for folder uploads), otherwise use originalname.
                // BOTH are client-controlled — relativePaths is a plain body field that
                // multer's fileFilter never inspects — so the name is validated here
                // before it is ever joined onto a real directory.
                const requestedName = (filePaths && filePaths[i]) ? filePaths[i] : file.originalname;
                const nameValidation = validateUploadRelativePath(requestedName);
                if (!nameValidation.valid) {
                    console.warn('[UPLOAD] rejected destination name:', nameValidation.error);
                    await fsPromises.unlink(file.path).catch(() => {});
                    continue;
                }
                const fileName = nameValidation.safePath;
                const destPath = path.join(resolvedTargetDir, fileName);

                // Validate destination path (project-root boundary, symlink-aware)
                const destValidation = validatePathInProject(projectRoot, destPath);
                if (!destValidation.valid) {
                    console.log('[DEBUG] Destination validation failed for:', destPath);
                    // Clean up temp file
                    await fsPromises.unlink(file.path).catch(() => {});
                    continue;
                }

                // Ensure parent directory exists (for nested files from folder upload)
                const parentDir = path.dirname(destPath);
                try {
                    await fsPromises.access(parentDir);
                } catch {
                    await fsPromises.mkdir(parentDir, { recursive: true });
                }

                // Move file (copy + unlink to handle cross-device scenarios).
                // Copy to the GUARD-APPROVED path, never to the raw joined one.
                const approvedDestPath = destValidation.resolved;
                await fsPromises.copyFile(file.path, approvedDestPath);
                await fsPromises.unlink(file.path);

                uploadedFiles.push({
                    name: fileName,
                    path: approvedDestPath,
                    size: file.size,
                    mimeType: file.mimetype
                });
            }

            res.json({
                success: true,
                files: uploadedFiles,
                uploadedCount: uploadedFiles.length,
                requestedFileCount,
                targetPath: resolvedTargetDir,
                message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`
            });
        } catch (error) {
            console.error('Error uploading files:', error);
            // Clean up any remaining temp files
            if (req.files) {
                for (const file of req.files) {
                    await fsPromises.unlink(file.path).catch(() => {});
                }
            }
            if (error.code === 'EACCES') {
                res.status(403).json({ error: 'Permission denied' });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    })().then(resolve, reject); }); });
};

app.post('/api/projects/:projectId/files/upload', authenticateToken,
    applicationWriterLeaseMiddleware('file-upload'), uploadFilesHandler);

// B-430 — stored chat attachments. Handler + access model live in the router.
app.use('/api/chat-images', createChatImagesRouter({ authenticateToken }));

// ADR-157 — assistant-referenced inline images. Roots are derived SERVER-SIDE
// from the session (project root + session scratchpad only; NEVER /home/operator)
// after a read-ownership check, so the client can never widen the allow-list.
const assistantImagesScratchpadBase = defaultScratchpadBase();
app.use('/api/assistant-images', createAssistantImagesRouter({
    authenticateToken,
    resolveAllowedRoots: (sessionId, rawUserId) => {
        const userId = coerceUserId(rawUserId);
        const session = sessionsDb.getSessionById(sessionId);
        if (!session || !session.project_path) {
            return null;
        }
        if (!isSessionAccessibleByUser(sessionId, session.project_path, userId, 'read')) {
            return null;
        }
        return deriveAllowedRoots({
            projectRoot: session.project_path,
            sessionId,
            scratchpadBase: assistantImagesScratchpadBase,
        });
    },
}));

// Image upload endpoint. Accepts the DB-assigned `projectId` (not a folder name)
// but the current implementation doesn't need to touch the project directory,
// so we just leave the param rename for consistency with the rest of the API.
app.post('/api/projects/:projectId/upload-images', authenticateToken,
    applicationWriterLeaseMiddleware('image-upload'), async (req, res) => {
    try {
        // B-PRIV guard: 404 (not 403) when the project is not visible to the user.
        if (!isProjectVisible(req.params.projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const multer = (await import('multer')).default;
        const path = (await import('path')).default;
        const fs = (await import('fs')).promises;
        const os = (await import('os')).default;

        // Configure multer for image uploads
        const storage = multer.diskStorage({
            destination: async (req, file, cb) => {
                try {
                    // Was os.tmpdir()/claude-ui-uploads/<userId> — a fully
                    // predictable path any local process could pre-create (or
                    // pre-fill with symlinks) before the first upload. The
                    // per-user split is kept, but under the unguessable 0700
                    // staging root, and the subdir itself is created 0700.
                    const stagingRoot = await getUploadStagingDir();
                    const uploadDir = path.join(stagingRoot, String(req.user.id));
                    await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });
                    cb(null, uploadDir);
                } catch (error) {
                    cb(error);
                }
            },
            filename: (req, file, cb) => {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
                cb(null, uniqueSuffix + '-' + sanitizedName);
            }
        });

        const fileFilter = (req, file, cb) => {
            const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
            if (allowedMimes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
            }
        };

        const upload = multer({
            storage,
            fileFilter,
            limits: {
                fileSize: 5 * 1024 * 1024, // 5MB
                files: 15
            }
        });

        // Handle multipart form data
        return new Promise((resolve, reject) => { upload.array('images', 15)(req, res, (err) => { void (async () => {
            if (err) {
                return res.status(400).json({ error: err.message });
            }

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No image files provided' });
            }

            try {
                // Process uploaded images
                const processedImages = await Promise.all(
                    req.files.map(async (file) => {
                        // Read file and convert to base64
                        const buffer = await fs.readFile(file.path);
                        const mimeType = file.mimetype;

                        // Clean up temp file immediately
                        await fs.unlink(file.path);

                        // B-158: never emit an unsanitized SVG. An SVG can carry
                        // <script>/on* handlers that run when the data: URL is
                        // opened as a document, so strip active content server-side
                        // (the same DOMPurify SVG profile the branding path uses)
                        // and reject anything that isn't a real SVG once cleaned.
                        let outBuffer = buffer;
                        const isSvg = mimeType === 'image/svg+xml'
                            || path.extname(file.originalname || '').toLowerCase() === '.svg';
                        if (isSvg) {
                            const sanitized = sanitizeSvg(buffer.toString('utf8'));
                            if (!sanitized) {
                                const svgErr = new Error('Invalid SVG file');
                                svgErr.code = 'INVALID_SVG';
                                throw svgErr;
                            }
                            outBuffer = Buffer.from(sanitized, 'utf8');
                        }

                        return {
                            name: file.originalname,
                            data: `data:${mimeType};base64,${outBuffer.toString('base64')}`,
                            size: outBuffer.length,
                            mimeType: mimeType
                        };
                    })
                );

                res.json({ images: processedImages });
            } catch (error) {
                console.error('Error processing images:', error);
                // Clean up any remaining files
                await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => { })));
                if (error && error.code === 'INVALID_SVG') {
                    return res.status(400).json({ error: 'Invalid SVG file' });
                }
                res.status(500).json({ error: 'Failed to process images' });
            }
        })().then(resolve, reject); }); });
    } catch (error) {
        console.error('Error in image upload endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Agent attachment upload. Accepts the DB-assigned `projectId` and lands the
// uploaded files inside the project's own .nassaj-uploads/inbox so the agent can
// reference them by a project-relative path. Distinct from the file-manager
// upload (`files/upload`, arbitrary target dir) and from image upload (base64,
// no disk landing in the project).
//
// Safe-list: an extension whose declared mimetype is in the allow-set for that
// extension. Browsers vary on text-ish types, so those extensions also accept
// the common generic mimetypes (text/plain, application/octet-stream, '').
const ATTACHMENT_ALLOWED = {
    pdf:  ['application/pdf'],
    xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
    xls:  ['application/vnd.ms-excel', 'application/octet-stream'],
    csv:  ['text/csv', 'application/csv', 'text/plain', 'application/octet-stream', ''],
    tsv:  ['text/tab-separated-values', 'text/plain', 'application/octet-stream', ''],
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'],
    pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/octet-stream'],
    txt:  ['text/plain', 'application/octet-stream', ''],
    md:   ['text/markdown', 'text/x-markdown', 'text/plain', 'application/octet-stream', ''],
    json: ['application/json', 'text/json', 'text/plain', 'application/octet-stream', ''],
    png:  ['image/png'],
    jpg:  ['image/jpeg'],
    jpeg: ['image/jpeg'],
    gif:  ['image/gif'],
    webp: ['image/webp'],
    svg:  ['image/svg+xml', 'text/plain', ''],
    zip:  ['application/zip', 'application/x-zip-compressed', 'application/octet-stream']
};

app.post('/api/projects/:projectId/upload-attachments', authenticateToken,
    applicationWriterLeaseMiddleware('attachment-upload'), async (req, res) => {
    try {
        // B-138 write guard: attachment uploads land inside the project tree
        // (.nassaj-uploads/inbox), so require WRITE authorization (creator /
        // member / participant — NOT mere public visibility). 404 (not 403) keeps
        // the B-PRIV non-disclosure guarantee for private projects.
        if (!projectsDb.isProjectWritableByUser(req.params.projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const fileFilter = (req, file, cb) => {
            const ext = path.extname(file.originalname || '').slice(1).toLowerCase();
            const allowedMimes = ATTACHMENT_ALLOWED[ext];
            if (!allowedMimes) {
                return cb(new Error(`File type .${ext || '(none)'} is not allowed.`));
            }
            const mime = (file.mimetype || '').toLowerCase();
            if (!allowedMimes.includes(mime)) {
                return cb(new Error(`File type .${ext} with content type ${file.mimetype || '(none)'} is not allowed.`));
            }
            cb(null, true);
        };

        const upload = await buildTempUploadMulter({
            fileFilter,
            maxSizeBytes: MAX_ATTACHMENT_SIZE_BYTES,
            maxCount: MAX_ATTACHMENT_COUNT
        });

        await new Promise((resolve, reject) => {
        upload.array('files', MAX_ATTACHMENT_COUNT)(req, res, (err) => {
          void (async () => {
            if (err) {
                // multer surfaces fileFilter errors, LIMIT_FILE_SIZE, LIMIT_FILE_COUNT, etc.
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({ error: `File too large. Maximum size is ${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)}MB per file.` });
                }
                if (err.code === 'LIMIT_FILE_COUNT') {
                    return res.status(400).json({ error: `Too many files. Maximum is ${MAX_ATTACHMENT_COUNT} files.` });
                }
                return res.status(400).json({ error: err.message });
            }

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: 'No files provided' });
            }

            // Helper: remove every temp file multer wrote (used on any early exit).
            const cleanupTemps = async () => {
                await Promise.all(req.files.map(f => fsPromises.unlink(f.path).catch(() => {})));
            };

            try {
                const projectRoot = await projectsDb.getProjectPathById(req.params.projectId);
                if (!projectRoot) {
                    await cleanupTemps();
                    return res.status(404).json({ error: 'Project not found' });
                }

                // Create the inbox we own, then realpath-guard it against the
                // project root (defends against a symlinked .nassaj-uploads that
                // would otherwise escape the tree).
                const inboxDir = path.join(projectRoot, '.nassaj-uploads', 'inbox');
                await fsPromises.mkdir(inboxDir, { recursive: true });

                const realRoot = await fsPromises.realpath(projectRoot);
                const realInbox = await fsPromises.realpath(inboxDir);
                if (!realInbox.startsWith(realRoot + path.sep)) {
                    await cleanupTemps();
                    return res.status(400).json({ error: 'Invalid upload destination' });
                }

                const savedFiles = [];
                for (const file of req.files) {
                    // Sanitise via exported pure helper (tested in isolation).
                    const name = sanitizeAttachmentName(file.originalname);
                    // Reject all-dots results ('.', '..', '...') which are not real
                    // filenames and could resolve to the inbox/parent directory.
                    if (/^\.+$/.test(name)) {
                        await cleanupTemps();
                        return res.status(400).json({ error: `Invalid file name: ${file.originalname}` });
                    }

                    // Resolve a collision-free destination via exported pure helper.
                    const { destPath } = resolveCollisionFreeDest(
                        inboxDir,
                        name,
                        (p) => { try { fs.accessSync(p); return true; } catch { return false; } }
                    );

                    // Belt-and-suspenders: confirm the final dest is under the
                    // project root (alongside the realpath inbox guard above).
                    const destValidation = validatePathInProject(projectRoot, destPath);
                    if (!destValidation.valid) {
                        await cleanupTemps();
                        return res.status(400).json({ error: destValidation.error });
                    }

                    // B-158: SVG attachments are sanitized server-side before they
                    // land in the project tree — an SVG can carry <script>/on*
                    // handlers that would execute if the stored file is later opened
                    // as a document. Everything else is copied verbatim. Reuse the
                    // branding path's DOMPurify SVG profile; reject an SVG that is
                    // not valid once cleaned.
                    const isSvg = path.extname(destPath).toLowerCase() === '.svg';
                    let writtenSize = file.size;
                    if (isSvg) {
                        const sanitized = sanitizeSvg(await fsPromises.readFile(file.path, 'utf8'));
                        if (!sanitized) {
                            await cleanupTemps();
                            return res.status(400).json({ error: `Invalid SVG file: ${file.originalname}` });
                        }
                        await fsPromises.writeFile(destPath, sanitized, 'utf8');
                        writtenSize = Buffer.byteLength(sanitized, 'utf8');
                    } else {
                        await fsPromises.copyFile(file.path, destPath);
                    }
                    await fsPromises.unlink(file.path);

                    savedFiles.push({
                        name: path.basename(destPath),
                        path: destPath,
                        relPath: path.relative(projectRoot, destPath),
                        size: writtenSize,
                        mimeType: file.mimetype
                    });
                }

                res.json({ success: true, files: savedFiles });
            } catch (error) {
                console.error('Error saving attachments:', error);
                await cleanupTemps();
                if (error.code === 'EACCES') {
                    return res.status(403).json({ error: 'Permission denied' });
                }
                res.status(500).json({ error: 'Failed to save attachments' });
            }
          })().then(resolve, reject);
        });
        });
    } catch (error) {
        console.error('Error in attachment upload endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get token usage for a specific session. `projectId` is the DB primary key;
// the Claude branch below resolves it to an absolute path via the DB.
app.get('/api/projects/:projectId/sessions/:sessionId/token-usage', authenticateToken, async (req, res) => {
    try {
        const { projectId, sessionId } = req.params;
        const { provider = 'claude' } = req.query;
        const homeDir = os.homedir();

        // B-PRIV guard: 404 (not 403) when the project is not visible to the user,
        // so a private project's token usage is never disclosed to a non-member.
        if (!isProjectVisible(projectId, coerceUserId(req.user?.id))) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Allow only safe characters in sessionId
        const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '');
        if (!safeSessionId || safeSessionId !== String(sessionId)) {
            return res.status(400).json({ error: 'Invalid sessionId' });
        }

        // Handle Cursor sessions - they use SQLite and don't have token usage info
        if (provider === 'cursor') {
            return res.json({
                used: 0,
                total: 0,
                inputTokens: 0,
                outputTokens: 0,
                breakdown: { input: 0, output: 0 },
                unsupported: true,
                message: 'Token usage tracking not available for Cursor sessions'
            });
        }

        if (provider === 'gemini') {
            const session = sessionsDb.getSessionById(safeSessionId);
            const sessionFilePath = session?.jsonl_path;
            if (!sessionFilePath) {
                return res.json({
                    used: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    breakdown: { input: 0, output: 0 },
                    unsupported: true,
                    message: 'Token usage tracking not available for this Gemini session'
                });
            }

            let fileContent;
            try {
                fileContent = await fsPromises.readFile(sessionFilePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
                }
                throw error;
            }

            const lines = fileContent.trim().split('\n');
            let inputTokens = 0;
            let outputTokens = 0;
            let totalTokens = 0;

            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);
                    if (!entry.tokens || typeof entry.tokens !== 'object') {
                        continue;
                    }

                    inputTokens = Number(entry.tokens.input || 0);
                    outputTokens = Number(entry.tokens.output || 0);
                    totalTokens = Number(entry.tokens.total || inputTokens + outputTokens || 0);
                    break;
                } catch {
                    continue;
                }
            }

            return res.json({
                used: totalTokens,
                inputTokens,
                outputTokens,
                breakdown: {
                    input: inputTokens,
                    output: outputTokens
                }
            });
        }

        if (provider === 'opencode') {
            const dbPath = getOpenCodeDatabasePath();
            if (!fs.existsSync(dbPath)) {
                return res.status(404).json({ error: 'OpenCode database not found' });
            }

            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try {
                const columns = db.prepare('PRAGMA table_info(session)').all();
                const columnNames = new Set(columns.map((column) => column.name));
                const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
                if (!requiredColumns.every((column) => columnNames.has(column))) {
                    return res.json({
                        used: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        breakdown: { input: 0, output: 0 },
                        unsupported: true,
                        message: 'Token usage tracking is not available in this OpenCode database schema'
                    });
                }

                const row = db.prepare(`
                    SELECT
                        tokens_input AS inputTokens,
                        tokens_output AS outputTokens,
                        tokens_reasoning AS reasoningTokens,
                        tokens_cache_read AS cacheReadTokens,
                        tokens_cache_write AS cacheWriteTokens
                    FROM session
                    WHERE id = ?
                `).get(safeSessionId);

                if (!row) {
                    return res.status(404).json({ error: 'OpenCode session not found', sessionId: safeSessionId });
                }

                const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
                const outputTokens = Number(row.outputTokens || 0);
                const totalUsed = Number(row.inputTokens || 0)
                    + outputTokens
                    + Number(row.reasoningTokens || 0)
                    + Number(row.cacheReadTokens || 0)
                    + Number(row.cacheWriteTokens || 0);

                return res.json({
                    used: totalUsed,
                    inputTokens,
                    outputTokens,
                    breakdown: {
                        input: inputTokens,
                        output: outputTokens
                    }
                });
            } finally {
                db.close();
            }
        }

        // Handle Codex sessions
        if (provider === 'codex') {
            // B-136: the codex SPAWN writes sessions under a per-user CODEX_HOME
            // (resolveProviderEnv → userConfigDir(userId,'.codex')) whenever codex
            // is isolated for an authenticated user, so this read/resume path must
            // look in the SAME tree — otherwise it never finds the caller's own
            // codex sessions. When codex is admin-marked 'shared' (or the caller is
            // anonymous) the spawn inherits the operator env, so fall back to the
            // shared ~/.codex exactly as before. Mirrors the spawn gate precisely.
            const codexUserId = coerceUserId(req.user?.id);
            // T-1675: under a credential grant the sessions live in the OWNER's tree.
            const codexHome = (codexUserId !== null && isProviderIsolated('codex'))
                ? userConfigDir(credentialPrincipalId(codexUserId, 'codex'), '.codex')
                : path.join(homeDir, '.codex');
            const codexSessionsDir = path.join(codexHome, 'sessions');

            // Find the session file by searching for the session ID
            const findSessionFile = async (dir) => {
                try {
                    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            const found = await findSessionFile(fullPath);
                            if (found) return found;
                        } else if (entry.name.includes(safeSessionId) && entry.name.endsWith('.jsonl')) {
                            return fullPath;
                        }
                    }
                } catch (error) {
                    // Skip directories we can't read
                }
                return null;
            };

            const sessionFilePath = await findSessionFile(codexSessionsDir);

            if (!sessionFilePath) {
                return res.status(404).json({ error: 'Codex session file not found', sessionId: safeSessionId });
            }

            // Read and parse the Codex JSONL file
            let fileContent;
            try {
                fileContent = await fsPromises.readFile(sessionFilePath, 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Session file not found', path: sessionFilePath });
                }
                throw error;
            }
            let budget = null;
            let modelId = null;
            for (const line of fileContent.split('\n')) {
                let entry;
                try { entry = JSON.parse(line); } catch { continue; }
                if (entry.type === 'turn_context') {
                    if (modelId !== (entry.payload?.model ?? null)) budget = null;
                    modelId = entry.payload?.model ?? null;
                }
                if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
                    budget = extractCodexTokenBudget(entry, modelId, safeSessionId, 'history');
                }
                if (entry.type === 'compacted' || entry.payload?.type === 'context_compacted') {
                    budget = null;
                }
            }
            return res.json(budget ?? { used: null, total: null, contextSnapshot: null, cacheSnapshot: null });
        }

        // Handle Claude sessions (default)
        // Resolve the project path through the DB using the caller-supplied
        // `projectId`. Legacy code here called extractProjectDirectory with a
        // folder-encoded project name; the migration centralizes that lookup
        // in the projects table.
        const projectPath = await projectsDb.getProjectPathById(projectId);
        if (!projectPath) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // B-823: the transcript belongs to the SESSION, not to a path re-derived
        // from the project. A session launched in a nassaj session overlay writes
        // under an overlay-encoded directory while its row still names the repo
        // project, so the derived path named a file that never existed and this
        // route answered 404 for every overlay session. `jsonl_path` is what every
        // other Claude reader uses; resolveClaudeTranscriptPath containment-checks
        // it because that column is DB-written.
        const session = sessionsDb.getSessionById(safeSessionId);
        // The session must belong to the project whose visibility was checked
        // above — otherwise a visible projectId paired with a foreign sessionId
        // would read another project's usage. `sessions.project_path` is a foreign
        // key onto `projects.project_path` (ON UPDATE CASCADE), so this equality
        // is exact by construction and needs no normalization.
        if (!session || session.project_path !== projectPath) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const fileContent = await readClaudeTranscriptForSession(
            session,
            projectPath,
            coerceUserId(req.user?.id)
        );
        if (fileContent === null) {
            // `reason` lets the client tell a failed lookup from a genuine zero;
            // the old response echoed the fabricated path back, which is what made
            // this look like a client-side bug for so long.
            return res.status(404).json({ error: 'Session file not found', reason: 'transcript_unavailable' });
        }
        const { inputTokens, outputTokens, modelName, breakdown, cacheSnapshot } = latestClaudeTokenUsage(fileContent, safeSessionId);

        // A restored transcript exposes request input, not a fresh native context measurement.
        const contextSnapshot = claudeContextSnapshot(null, { sessionId: safeSessionId, modelId: modelName }, modelName ? inputTokens : null);
        contextSnapshot.observedAt = null; // Restoring a transcript is not a fresh runtime observation.

        res.json({
            used: null,
            total: null,
            contextSnapshot,
            cacheSnapshot,
            inputTokens,
            outputTokens,
            breakdown,
            cacheTtlMinutes: latestClaudeCacheTtlMinutes(fileContent)
        });
    } catch (error) {
        console.error('Error reading session token usage:', error);
        res.status(500).json({ error: 'Failed to read session token usage' });
    }
});

// Serve React app for all other routes (excluding static files)
app.get('*', (req, res) => {
    // Skip requests for static assets (files with extensions)
    if (path.extname(req.path)) {
        return res.status(404).send('Not found');
    }

    // Only serve index.html for HTML routes, not for static assets
    // Static assets should already be handled by express.static middleware above
    const indexPath = path.join(APP_ROOT, 'dist', 'index.html');

    // Check if dist/index.html exists (production build available)
    if (fs.existsSync(indexPath)) {
        // Set no-cache headers for HTML to prevent service worker issues
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.sendFile(indexPath);
    } else {
        // In development, redirect to Vite dev server only if dist doesn't exist
        const redirectHost = getConnectableHost(req.hostname);
        res.redirect(`${req.protocol}://${redirectHost}:${VITE_PORT}`);
    }
});

// global error middleware must be last
app.use((err, req, res, next) => {
  if (isPayloadTooLargeError(err)) {
    return res.status(413).json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
    });
  }
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  console.error(err);

  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
});

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
    const r = perm & 4 ? 'r' : '-';
    const w = perm & 2 ? 'w' : '-';
    const x = perm & 1 ? 'x' : '-';
    return r + w + x;
}

// Directories that are almost never interesting for a project tree but can
// contain tens of thousands of files. Skipping them before recursion keeps
// traversal time bounded on large monorepos and high-latency filesystems
// (NFS / SMB).
const IGNORED_DIRS = new Set([
    // JS / TS toolchains
    'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
    // VCS
    '.git', '.svn', '.hg',
    // Python
    '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
    // Rust / Go / Java / Ruby
    'target', 'vendor',
    // Build output / IDE
    '.gradle', '.idea', 'coverage', '.nyc_output'
]);

const DEFAULT_FS_CONCURRENCY = 64;
const parsedFsConcurrency = Number.parseInt(process.env.FS_CONCURRENCY || '', 10);
const FS_CONCURRENCY = Number.isFinite(parsedFsConcurrency) && parsedFsConcurrency > 0
    ? parsedFsConcurrency
    : DEFAULT_FS_CONCURRENCY;
let activeFsOperations = 0;
const pendingFsOperations = [];

async function acquire() {
    if (activeFsOperations < FS_CONCURRENCY) {
        activeFsOperations += 1;
        return;
    }

    await new Promise((resolve) => {
        pendingFsOperations.push(resolve);
    });
}

function release() {
    const next = pendingFsOperations.shift();
    if (next) {
        next();
        return;
    }

    activeFsOperations = Math.max(0, activeFsOperations - 1);
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
    // Using fsPromises from import
    let entries;
    try {
        await acquire();
        try {
            entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
        } finally {
            release();
        }
    } catch (error) {
        // Only log non-permission errors to avoid spam
        if (error.code !== 'EACCES' && error.code !== 'EPERM') {
            console.error('Error reading directory:', error);
        }
        return [];
    }

    const filteredEntries = entries.filter((entry) => !(entry.isDirectory() && IGNORED_DIRS.has(entry.name)));

    // Process every entry in parallel. On high-latency filesystems (NFS/SMB)
    // serial stat() was the real bottleneck — issuing them concurrently lets
    // the kernel pipeline the round-trips and the recursive calls overlap too.
    const items = await Promise.all(filteredEntries.map(async (entry) => {
        const itemPath = path.join(dirPath, entry.name);
        const item = {
            name: entry.name,
            path: itemPath,
            type: entry.isDirectory() ? 'directory' : 'file'
        };

        // Get file stats for additional metadata
        try {
            await acquire();
            try {
              const stats = await fsPromises.lstat(itemPath);
              item.size = stats.size;
              item.modified = stats.mtime.toISOString();

              // Mark symlinks so UI can distinguish them
              if (stats.isSymbolicLink()) {
                item.isSymlink = true;
              }

              // Convert permissions to rwx format
              const mode = stats.mode;
              const ownerPerm = (mode >> 6) & 7;
              const groupPerm = (mode >> 3) & 7;
              const otherPerm = mode & 7;
              item.permissions =
                ((mode >> 6) & 7).toString() +
                ((mode >> 3) & 7).toString() +
                (mode & 7).toString();
              item.permissionsRwx =
                permToRwx(ownerPerm) +
                permToRwx(groupPerm) +
                permToRwx(otherPerm);
            } finally {
                release();
            }
        } catch (statError) {
            // If stat fails, provide default values
            item.size = 0;
            item.modified = null;
            item.permissions = '000';
            item.permissionsRwx = '---------';
        }

        if (entry.isDirectory() && currentDepth < maxDepth) {
            // Recurse. Let readdir's own EACCES bubble up through the catch in
            // the recursive call rather than doing a separate access() probe
            // (which doubled the round-trip count on SMB without adding info).
            // The recursive call starts with a bounded readdir; holding a permit
            // for the whole subtree can deadlock when sibling directories are
            // waiting on their own children.
            item.children = await getFileTree(itemPath, maxDepth, currentDepth + 1, showHidden);
        }

        return item;
    }));

    return items.sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
    });
}

/**
 * B-24 — exit code reserved for "this DRAINED instance is an ORPHAN".
 *
 * PM2 7.0.1 `God.handleExit` (lib/God.js:404) has NO pid guard: the `exit`
 * listener is attached to the child object, but the restart decision is taken
 * on `clusters_db[pm_id]` — the CURRENT occupant of the slot. So when our
 * predecessor exits LATE (it drained for minutes/hours while PM2, having lost
 * track of it under `treekill:false`, already spawned a replacement that is
 * `online`), PM2 reads a slot whose status is `online`, concludes "the app
 * crashed", and schedules `God.executeApp` — a GHOST respawn beside the healthy
 * replacement. The ghost cannot bind port 3004, and although the B-41 listen
 * guard stops it from crash-looping on EADDRINUSE, it exits 0 → `handleExit`
 * runs again on an `online` slot → another ghost, forever (exp_backoff caps at
 * 15s, and `unstable_restarts` never trips because each ghost outlives
 * `min_uptime`).
 *
 * We cannot patch PM2. What we CAN do is make that late exit look INTENTIONAL:
 * `stop_exit_codes` (God.js:414) is the one input to `handleExit` that suppresses
 * the respawn regardless of slot status. So a drained instance that detects it
 * is no longer the process PM2 tracks exits with this code, which the ecosystem
 * files list in `stop_exit_codes` — no ghost is spawned.
 *
 * 75 = EX_TEMPFAIL (sysexits.h): never produced by Node itself, so it cannot
 * collide with a genuine crash code. KEEP IN SYNC with `stop_exit_codes` in
 * ecosystem*.config.cjs (enforced by server/index.drain-ghost-respawn.test.js).
 */
const DRAIN_ORPHAN_EXIT_CODE = 75;

/**
 * Decides the process exit code at the END of a drain (B-24 ghost-respawn
 * mitigation). Fail-safe by construction: it returns the historical code (0)
 * for every case except the one it can positively prove.
 *
 * The proof uses PM2's own pid file (`pm_pid_path`, exported into our env by
 * PM2 and rewritten with the new pid whenever PM2 spawns into our slot):
 *   - file holds OUR pid       → we are still the tracked instance; PM2 stopping
 *                                us (or restarting us) is legitimate → 0, i.e.
 *                                byte-for-byte the previous behaviour, so a
 *                                plain `kill -INT <pid>` still self-heals.
 *   - file holds ANOTHER LIVE pid → a replacement owns our slot; our exit event
 *                                would trigger the ghost respawn → sentinel.
 *   - missing / unreadable / not a pid / stale (dead) pid / no pm_pid_path in
 *     env (not under PM2) → cannot prove anything → 0.
 *
 * All collaborators are injectable so the behaviour can be tested without a
 * live PM2 daemon.
 */
function resolveDrainExitCode(deps) {
    const {
        requestedCode = 0,
        pidPath = process.env.pm_pid_path,
        ownPid = process.pid,
        readPidFile = (p) => fs.readFileSync(p, 'utf8'),
        isProcessAlive = (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            } catch (error) {
                // EPERM = the pid exists but belongs to another user.
                return error?.code === 'EPERM';
            }
        },
        logger = console,
    } = deps || {};

    // A non-zero code is a real failure signal — never mask it as "intentional
    // stop", or PM2 would stop restarting a genuinely crashing server.
    if (requestedCode !== 0) return requestedCode;
    if (!pidPath) return 0;

    let trackedPid;
    try {
        trackedPid = parseInt(String(readPidFile(pidPath)).trim(), 10);
    } catch {
        // PM2 unlinks the pid file when IT is the one stopping us, so a missing
        // file means "supervised stop in progress" — keep the old code.
        return 0;
    }

    if (!Number.isInteger(trackedPid) || trackedPid <= 0) return 0;
    if (trackedPid === ownPid) return 0;
    if (!isProcessAlive(trackedPid)) return 0;

    logger.warn(
        `[DRAIN] this instance (pid ${ownPid}) is an ORPHAN: the supervisor slot ` +
        `now belongs to pid ${trackedPid}. Exiting with ${DRAIN_ORPHAN_EXIT_CODE} ` +
        '(stop_exit_codes) so PM2 does not respawn a ghost beside the live instance (B-24).',
    );
    return DRAIN_ORPHAN_EXIT_CODE;
}

const SERVER_PORT = process.env.SERVER_PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';
const DISPLAY_HOST = getConnectableHost(HOST);
const VITE_PORT = process.env.VITE_PORT || 5173;
const SOURCE_UPDATE_OWNERSHIP = Symbol.for('nassaj.sourceUpdate.bootstrapOwnership.v1');

async function completeBootstrappedSourceUpdate() {
    const ownership = globalThis[SOURCE_UPDATE_OWNERSHIP];
    if (!ownership || ownership.artifact) return;
    assertLegacyTransitionAllowed();
    const gate = createUpdateMaintenanceGate({ projectPath: APP_ROOT });
    const candidateRoot = path.join(gate.paths.controlRoot, 'candidates', ownership.transactionId);
    const actionFile = path.join(candidateRoot, 'activation-action.json');
    const metadata = fs.lstatSync(actionFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
        throw new Error('source_update_activation_action_unsafe');
    }
    const action = JSON.parse(fs.readFileSync(actionFile, 'utf8'));
    if (action?.schema !== 'nassaj-source-update-activation/v1'
        || action.transactionId !== ownership.transactionId
        || action.manifestPath !== path.join(candidateRoot, 'candidate-manifest.json')) {
        throw new Error('source_update_activation_action_invalid');
    }
    const validation = validateCandidate({
        projectRoot: APP_ROOT, candidateRoot, transactionId: action.transactionId,
        releaseCommit: action.targetCommit, version: action.version,
        manifestPath: action.manifestPath, manifestSha256: action.manifestSha256,
    });
    if (fs.existsSync(path.join(validation.candidates.client, 'CLIENT_ASSET_MANIFEST.json'))) {
        if (fs.existsSync(path.join(APP_ROOT, 'dist/CLIENT_ASSET_MANIFEST.json'))) prepareClientPublicationAssets(APP_ROOT, path.join(APP_ROOT, 'dist'), {}, verifyAssetClosure, { reserveBytes: 2 * 1024 ** 3 });
        prepareClientPublicationAssets(APP_ROOT, validation.candidates.client, {}, verifyAssetClosure, { reserveBytes: 2 * 1024 ** 3 });
    }
    exchangeGenerations(validation, { names: ['client'] });
    const identities = verifyRuntimeIdentities(validation);
    const completedJob = sourceUpdateJobsDb.getByTransactionId(action.transactionId);
    if (!completedJob) throw new Error('source_update_runtime_job_identity_mismatch');
    const activationIdentity = {
        jobId: completedJob.id,
        transactionId: action.transactionId,
        activationIdentitySha256: completedJob.activation_identity_sha256,
    };
    const completion = sourceUpdateJobsDb.appendActivationReceipt(
        activationIdentity, 'runtime_verifying', 'done', { runtimeIdentities: identities },
    );
    const publicationCompletionReceipt = durableReceiptFile(UPDATE_JOB_RECEIPT_ROOT, {
        schemaVersion: 2, jobId: completedJob.id, sequence: completion.sequence,
        workerFence: completion.workerFence, phase: 'runtime_verifying', kind: 'done',
        factsJson: completion.factsJson, factsSha256: completion.factsSha256,
    });
    // Open the gate only after the completion proof is durable. If the process
    // dies after this call but before the DB CAS, startup recovery below closes
    // the narrow split using exact loaded client/server identities.
    ownership.complete({ runtimeIdentities: identities });
    await settleReleaseUpdateWaiter(APP_ROOT, { jobId: completedJob.id, transactionId: action.transactionId, receiptFile: publicationCompletionReceipt });
    if (!sourceUpdateJobsDb.transitionActivation(activationIdentity, ['runtime_verifying'], 'activated')) {
        throw new Error('source_update_runtime_job_identity_mismatch');
    }
    pendingServerActionsDb.clearSatisfiedBefore(
        'safe-restart', new Date().toISOString(), action.expectedServerBuildId,
    );
    delete globalThis[SOURCE_UPDATE_OWNERSHIP];
}

function verifyReleaseLayoutRuntimeRecovery(job) {
    if (job?.strategy !== 'release-layout-v2' || !UPDATE_CONTROL_ROOT
        || typeof process.env.NASSAJ_DEPLOY_ROOT !== 'string' || !process.env.NASSAJ_DEPLOY_ROOT) return null;
    try {
        const deployRoot = fs.realpathSync(process.env.NASSAJ_DEPLOY_ROOT);
        const currentLink = path.join(deployRoot, 'current');
        const currentRoot = fs.realpathSync(currentLink);
        const appRootReal = fs.realpathSync(APP_ROOT);
        if (!fs.lstatSync(currentLink).isSymbolicLink() || currentRoot !== appRootReal
            || path.dirname(currentRoot) !== fs.realpathSync(path.join(deployRoot, 'releases'))) return null;
        const generationId = path.basename(appRootReal);
        if (generationId !== job.transaction_id) return null;
        const layout = { controlRoot: UPDATE_CONTROL_ROOT };
        const action = readReleaseActivationAction({ layout, jobId: job.id });
        const record = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'runtime-generation.json'), 'utf8'));
        const same = action.generationId === generationId
            && action.activationIdentitySha256 === job.activation_identity_sha256
            && action.version === job.expected_version
            && action.commit === job.release_commit
            && String(action.releaseId) === String(job.release_id)
            && action.tag === job.release_tag
            && String(action.assetId) === String(job.release_asset_id)
            && action.assetName === job.release_asset_name
            && action.assetSize === job.release_asset_size
            && action.assetSha256 === job.release_asset_sha256
            && action.archiveSha256 === job.archive_sha256
            && action.sourceTreeSha256 === job.source_tree_sha256
            && action.serverBuildId === job.expected_server_build_id
            && action.clientBuildId === job.expected_client_build_id
            && action.serverBuildId === SERVER_BUILD_ID_LOADED_AT_STARTUP
            && action.clientBuildId === readBuildIdFile(CLIENT_BUILD_ID_PATH)
            && record?.state === 'sealed'
            && record.activationIdentitySha256 === action.activationIdentitySha256
            && record.identity?.generationId === generationId
            && record.identity?.commit === action.commit
            && record.identity?.sourceTreeSha256 === action.sourceTreeSha256
            && record.identity?.bundleBuildId === action.bundleBuildId
            && record.identity?.bundleManifestSha256 === action.bundleManifestSha256;
        return same ? action : null;
    } catch { return null; }
}

// Initialize database and start server
async function startServer() {
    let startupBackground = null;
    try {
        // T-896 / B-170 docker-socket gate — FIRST, before the DB and long
        // before the listener opens: if this process can reach
        // /var/run/docker.sock via its numeric gids, docker escape to host root
        // is one provider turn away and every isolation layer below is moot.
        //
        // T-1085: the DETECTION always runs; the posture decides the ACTION.
        // Untrusted-user instance (NASSAJ_SECURITY_POSTURE=strict, or platform
        // mode where auth is disabled) → unchanged hard refusal with the
        // degroup remediation (the catch below exits 1). Default trusted
        // posture → the finding is logged loudly and recorded for the UI, and
        // boot continues: everyone with an account here can already reach the
        // socket from their own shell. The posture reads env only, so this
        // stays ahead of the database exactly as it was before.
        const posture = resolveSecurityPosture();
        enforceDockerSockBootGuard({ shared: posture.shared, postureReason: posture.reason });

        const forwardStartup = requireStartupAdmission();
        if (forwardStartup && forwardStartup.phase !== 'security_startup_authorized') {
            throw new Error('root_security_startup_admission_required');
        }
        // Initialize authentication database
        await initializeDatabase();
        const permissionReconciliation = reconcileRuntimePermissionExecutions();
        if (permissionReconciliation.notStarted) {
            console.warn('[permission-execution] startup reconciliation completed', permissionReconciliation);
        }
        if (permissionReconciliation.blocked) {
            // `blocked` counts permission_generation_blocks, a DURABLE fence with no
            // clearing path anywhere in the codebase. Treating it as a boot failure
            // means the first RECONCILED_EFFECT_UNKNOWN ever recorded — an expected
            // event whenever a session process dies still holding a lease — bricks
            // every subsequent boot forever (B-795). The fence itself is already
            // enforced where it belongs: authorize() and the claimable-lease query
            // both refuse a blocked generation, so such a generation admits no
            // execution whether or not this server is listening. Surface it loudly
            // instead. `unknown` and `stillActive` stay fatal below: those are live
            // observations from THIS boot and clear on the next one.
            console.error('[permission-execution] generation fence active — launches on a '
                + 'blocked generation will be refused', permissionReconciliation);
        }
        // T-1593: a local effect whose child is proven dead is recorded, never fatal.
        // An external unknown is fatal once: its row is now terminal and its scope is
        // fenced, so the immediate retry boots clean with only that scope refused.
        if (permissionReconciliation.unknownLocal) {
            console.warn('[permission-execution] local effects reconciled unknown after owner death',
                permissionReconciliation);
        }
        if (isPermissionReconciliationFatal(permissionReconciliation)) {
            throw new Error(
                `PERMISSION_RECONCILIATION_BLOCKED:${JSON.stringify(permissionReconciliation)}`
            );
        }
        if (!forwardStartup && !OID_PAIR_BOOTSTRAP) runConnectorCredentialRetentionAtStartup();

        // Crash seam: predecessor durably proved runtime verification and
        // opened the gate, then died before the terminal DB CAS.
        for (const job of sourceUpdateJobsDb.listRuntimeVerifying()) {
            assertLegacyTransitionAllowed();
            const action = verifyReleaseLayoutRuntimeRecovery(job);
            if (!action) continue;
            const artifactOwnership = globalThis[SOURCE_UPDATE_OWNERSHIP];
            if (!artifactOwnership?.artifact || artifactOwnership.transactionId !== action.generationId
                || artifactOwnership.artifact.jobId !== job.id) throw new Error('artifact_runtime_ownership_missing');
            const identity = {
                jobId: job.id, transactionId: job.transaction_id,
                activationIdentitySha256: job.activation_identity_sha256,
            };
            const recovered = sourceUpdateJobsDb.appendActivationReceipt(identity, 'runtime_verifying', 'recovery', {
                serverBuildId: SERVER_BUILD_ID_LOADED_AT_STARTUP,
                clientBuildId: job.expected_client_build_id,
                generationId: action.generationId,
                releaseCommit: action.commit,
                sourceTreeSha256: action.sourceTreeSha256,
                activationIdentitySha256: action.activationIdentitySha256,
            });
            durableReceiptFile(UPDATE_JOB_RECEIPT_ROOT, {
                schemaVersion: 2, jobId: job.id, sequence: recovered.sequence,
                workerFence: recovered.workerFence, phase: 'runtime_verifying', kind: 'recovery',
                factsJson: recovered.factsJson, factsSha256: recovered.factsSha256,
            });
            if (!sourceUpdateJobsDb.transitionActivation(identity, ['runtime_verifying'], 'activated')) {
                throw new Error('source_update_runtime_recovery_cas_failed');
            }
            artifactOwnership.complete({ artifactCompletion: {jobId:job.id,generationId:action.generationId,
                activationIdentitySha256:action.activationIdentitySha256,serverBuildId:SERVER_BUILD_ID_LOADED_AT_STARTUP,
                clientBuildId:job.expected_client_build_id,commit:action.commit,receiptSequence:recovered.sequence} });
            delete globalThis[SOURCE_UPDATE_OWNERSHIP];
        }
        // qa-critic C2: a crash between claiming the restart action and the
        // handoff strands a job in activating/rollback_pending. Settle it against
        // the gate record bootstrap already reconciled, before any request runs.
        const strandedActivations = reconcileStrandedActivationJobs({ runtime: {
            serverBuildId: SERVER_BUILD_ID_LOADED_AT_STARTUP,
            clientBuildId: readBuildIdFile(CLIENT_BUILD_ID_PATH),
            commit: SERVER_RUNTIME_IDENTITY.runtimeCommit,
        } });
        if (strandedActivations.length) console.warn('[source-update] stranded activation jobs reconciled', strandedActivations);
        if (globalThis[SOURCE_UPDATE_OWNERSHIP]?.artifact) throw new Error('artifact_runtime_job_not_verified');
        if (requestMaintenanceGate.paths.artifact) {
            const generation=JSON.parse(fs.readFileSync(path.join(APP_ROOT,'runtime-generation.json'),'utf8'));
            if(generation.sealKind!=='initial-bootstrap-v1') {
                const job=sourceUpdateJobsDb.getByTransactionId(generation.identity.generationId);
                if(job?.state!=='activated' || !verifyReleaseLayoutRuntimeRecovery(job)) throw new Error('artifact_completed_job_mismatch');
            }
        }
        if (!forwardStartup && !OID_PAIR_BOOTSTRAP) {
        // B-692: a restart request older than this process is already satisfied.
        // Reconcile it at boot so a predecessor crash between replacement and
        // queue cleanup cannot leave Command Board permanently actionable while
        // restartRequired is false.
        try {
            if (globalThis[SOURCE_UPDATE_OWNERSHIP]) throw new Error('source_update_bootstrap_pending');
            const cleared = pendingServerActionsDb.clearSatisfiedBefore(
                'safe-restart',
                PROCESS_STARTED_AT,
                SERVER_BUILD_ID_LOADED_AT_STARTUP,
            );
            if (cleared > 0) {
                console.log(`[BOOT] cleared ${cleared} safe-restart action(s) satisfied by this process start`);
            }
        } catch (error) {
            if (error.message === 'source_update_bootstrap_pending') {
                // The source-update row is terminal only after runtime identity
                // verification; completeBootstrappedSourceUpdate clears it.
            } else {
            console.error('[BOOT] failed to reconcile satisfied server actions:', error.message);
            }
        }

        // B-577: سؤالٌ معلَّق لا يعمّر أطول من عمليته. صفُّ `question` ينجو من
        // إعادة التشغيل وطلبُ الإذن نفسه لا ينجو، فتبقى شارةٌ زرقاء تنتظر سؤالاً
        // لم يعد موجوداً ولا يُطفئها إلا فتحُ المحادثة.
        try {
            const cleared = sessionOutcomesDb.clearStaleQuestionOutcomes();
            if (cleared > 0) {
                console.log(`[BOOT] cleared ${cleared} stale 'question' session outcome(s)`);
            }
        } catch (error) {
            console.error('[BOOT] failed to clear stale question outcomes:', error.message);
        }

        }

        // B-577: دلتا حالة المحادثة — الكاتب الخادميّ يُخطر، وpresence يبثّ
        // مُصفّاةً بالرؤية. الوصل هنا كي لا تستورد طبقةُ الكتابة طبقةَ البثّ.
        onSessionOutcomeChange((sessionId) => {
            try {
                broadcastSessionOutcome(sessionId);
            } catch (error) {
                console.error('[session-outcome] broadcast failed:', error.message);
            }
        });

        // B-5 fail-closed guard: in platform mode every WS session resolves to
        // the first active user, so an isolated Claude provider + >1 active user
        // would silently share one subscription (ToS violation). Throws here to
        // abort boot (the catch below exits 1) before any listener is opened.
        enforcePlatformIsolationGuard();

        // Bootstrap the initial owner on first run (no-op once an owner exists).
        if (!IS_PLATFORM) {
            await ensureOwnerBootstrapped();
        }

        // Configure Web Push (VAPID keys)
        configureWebPush();

        // Check if running in production mode (dist folder exists)
        const distIndexPath = path.join(APP_ROOT, 'dist', 'index.html');
        const isProduction = fs.existsSync(distIndexPath);

        // Log Claude implementation mode
        console.log(`${c.info('[INFO]')} Using Claude Agents SDK for Claude integration`);
        console.log('');

        if (isProduction) {
            console.log(`${c.info('[INFO]')} To run in production mode, go to http://${DISPLAY_HOST}:${SERVER_PORT}`);            
        }

        console.log(`${c.info('[INFO]')} To run in development mode with hot-module replacement, go to http://${DISPLAY_HOST}:${VITE_PORT}`);
   
        // B-41 (self-hosting trap): bind through the single-listener guard
        // instead of a naked server.listen(). If a draining/ghost predecessor
        // still holds port 3004, the guard retries briefly then exits cleanly
        // (0) rather than crash-looping on EADDRINUSE. See
        // listen-with-guard.service.ts for the full rationale and the T-95
        // diagnosis.
        const turnSupervisorLifecycle = createTurnSupervisorLifecycle({
            db: getConnection(),
            ownerIds: [
                HOSTED_TURN_SUPERVISOR_OWNER_ID,
                CLI_TURN_SUPERVISOR_OWNER_ID,
            ],
            supervisors: [hostedTurnSupervisor, cliTurnSupervisor],
        });
        const backgroundLifecycle = createServerBackgroundLifecycle({
            prepareTurnSupervisor: () => turnSupervisorLifecycle.prepare(),
            startTurnSupervisorWatchdogs: () => turnSupervisorLifecycle.start(),
            stopTurnSupervisorWatchdogs: () => turnSupervisorLifecycle.stop(),
            initializeSessionsWatcher,
            closeSessionsWatcher,
            startCostLedgerScheduler,
            stopCostLedgerScheduler,
            startScheduledMessages: () => scheduledMessagesService.start(),
            stopScheduledMessages: () => scheduledMessagesService.stop(),
        });
        startupBackground = backgroundLifecycle;
        await backgroundLifecycle.prepare();
        privateSecurityReady = true;

        // Bootstrap owns EX/EX and admission remains closed until the exact
        // candidate runtime is verified and its client is promoted. Failure
        // aborts startup through the outer catch; no listener or background
        // writer is admitted on an unverified generation.
        if (!OID_PAIR_BOOTSTRAP) await completeBootstrappedSourceUpdate();
        if (!forwardStartup && !OID_PAIR_BOOTSTRAP) sourceUpdateWorker?.start();
        if (!forwardStartup && !OID_PAIR_BOOTSTRAP && !localActivationMode) updateAutoActivator?.start();
        // ADR-156 §3.3: reconcile parked deferrals (expire those that timed out
        // while down, reset the idle debounce for the rest) then run the loop.
        if (!forwardStartup && !OID_PAIR_BOOTSTRAP) {
            updateDeferralScheduler?.reconcileOnStartup();
            updateDeferralScheduler?.start();
        }

        installLocalUpdateRouteLeases(app);
        await listenWithGuard({
            server,
            port: SERVER_PORT,
            host: HOST,
            exit: (code) => process.exit(code),
            // Operators can widen the overlap window if drain handoff is slow.
            bindWindowMs: resolveBindWindowMs(process.env.LISTEN_BIND_WINDOW_MS),
            onListening: () => {
                const appInstallPath = APP_ROOT;

                console.log('');
                console.log(c.dim('═'.repeat(63)));
                console.log(`  ${c.bright('Nassaj Server - Ready')}`);
                console.log(c.dim('═'.repeat(63)));
                console.log('');
                console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
                console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
                console.log(`${c.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
                console.log('');


            },
        });

        if (forwardStartup) await confirmStartupServing();
        if (OID_PAIR_BOOTSTRAP) await OID_PAIR_BOOTSTRAP.waitForOpen({ timeoutMs: 180_000 });
        if (process.env.NASSAJ_UPDATE_MODE === 'local-main') {
            const { startReconcileScheduler } = await import('./modules/database/project-reconcile.service.js');
            startReconcileScheduler();
        }
        if (OID_PAIR_BOOTSTRAP) runConnectorCredentialRetentionAtStartup();
        await backgroundLifecycle.start();
        normalAdmissionReady = true;
        if (localActivationMode && !OID_PAIR_BOOTSTRAP) updateAutoActivator?.start();
        if (OID_PAIR_BOOTSTRAP) {
            if (!OID_PAIR_BOOTSTRAP.rollback) await recordOidPairApplicationServing(APP_ROOT, OID_PAIR_BOOTSTRAP, {
                normalAdmissionReady, pid: process.pid, serverProcessStartTicks: SERVER_RUNTIME_ATTESTATION.processStartTicks,
                serverTransactionNonce: SERVER_RUNTIME_ATTESTATION.transactionNonce,
                oidPairTransactionNonce: OID_PAIR_BOOTSTRAP.transactionNonce,
                oidPairTargetDigest: OID_PAIR_BOOTSTRAP.targetDigest,
                ...(OID_PAIR_BOOTSTRAP.nodeModulesTreeSha256 ? { oidNodeModulesTreeSha256: OID_PAIR_BOOTSTRAP.nodeModulesTreeSha256 } : {}),
                serverLoadedBuildId: SERVER_BUILD_ID_LOADED_AT_STARTUP,
                clientBuildIdServed: readBuildIdFile(CLIENT_BUILD_ID_PATH),
            });
            updateAutoActivator?.start();
        }
        // B-N-DRAIN (ADR-021 / ADR-022) + B-319/ADR-084: a stop signal triggers
        // a TIMED DRAIN instead of an immediate process.exit(0), and the server
        // KEEPS SERVING throughout — the listener is released only in the
        // instant before exit. (Until B-319 it was released on the first
        // signal, on the false assumption that a PM2 successor was about to
        // bind it; fork mode starts the successor only after we exit, so that
        // opened a listener-less window for the whole drain.) Full semantics
        // and the measured evidence are in shutdown-drain.service.ts.
        const drainThenShutdown = createShutdownDrain({
            server,
            wss,
            countActiveSessionsByProvider: () => ({
                // ADR-042 (B-80c): behind CLAUDE_GHOST_DETACH the drain stops
                // counting detached ghost sessions (lost every listener past the
                // grace period — still running + writing jsonl, just not blocking
                // restart). Flag OFF ⇒ byte-for-byte the previous behaviour
                // (every active session counts). Only the drain count changes;
                // getActiveClaudeSDKSessions() stays the display/WS-DIAG source.
                claude: (ghostDetachEnabled()
                    ? getDrainBlockingClaudeSessions()
                    : getActiveClaudeSDKSessions()).length,
                cursor: getActiveCursorSessions().length,
                codex: getActiveCodexSessions().length,
                gemini: getActiveGeminiSessions().length,
                antigravity: getActiveAntigravitySessions().length,
                opencode: getActiveOpenCodeSessions().length,
                hermes: getActiveHermesSessions().length,
                // B-143: count the hosted-vendor runs too, so a restart DRAINS
                // (waits for) in-flight kimi/deepseek/glm sessions instead of
                // killing them. Same shape as the CLI providers above.
                kimi: getActiveKimiSessions().length,
                deepseek: getActiveDeepSeekSessions().length,
                glm: getActiveGlmSessions().length,
                qwen: getActiveQwenSessions().length,
            }),
            finalCleanup: async () => {
                await backgroundLifecycle.stop();
            },
            // Resolve every waiting approval BEFORE the sockets close, so a
            // restart mid-turn cannot surface as "the user doesn't want to
            // proceed" for a tool the user never refused.
            cancelPendingApprovals: cancelAllPendingApprovals,
            // Close SQLite as the very last act before the process dies. The
            // drain calls this injected `exit` on EVERY termination path (clean
            // finish, drain timeout, and the second-signal escape hatch), so
            // hanging the DB close here covers all of them without touching the
            // drain service. Nothing had ever called closeConnection(): the
            // process exited with the WAL still open, so SQLite was left to
            // recover on next boot instead of checkpointing on the way out.
            // Best-effort by design — a failing close must never prevent exit.
            exit: (code) => {
                try {
                    closeUniversalConversationShadowRuntime();
                    closeConnection();
                } catch (dbCloseError) {
                    console.error('[DRAIN] failed to close the database cleanly:', dbCloseError?.message ?? dbCloseError);
                }
                // B-24: an ORPHANED drained instance (PM2's slot already taken
                // by a live replacement) must exit with the sentinel code so
                // God.handleExit treats the late exit as an intentional stop
                // instead of respawning a ghost. Every other case keeps 0.
                process.exit(resolveDrainExitCode({ requestedCode: code }));
            },
            drainTimeoutMs: resolveDrainTimeoutMs(process.env.DRAIN_TIMEOUT_MS),
        });

        process.on('SIGTERM', () => void drainThenShutdown('SIGTERM'));
        process.on('SIGINT', () => void drainThenShutdown('SIGINT'));
    } catch (error) {
        normalAdmissionReady = false; privateSecurityReady = false;
        server.close(); server.closeAllConnections?.(); wss.close();
        try { await startupBackground?.stop(); } catch { /* process exit remains mandatory */ }
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
