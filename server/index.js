#!/usr/bin/env node
// Load environment variables before other imports execute
import './load-env.js';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { spawn } from 'child_process';

import express from 'express';
import cors from 'cors';
import mime from 'mime-types';
import Database from 'better-sqlite3';

import { AppError, WORKSPACES_ROOT, getOpenCodeDatabasePath, validateWorkspacePath } from '@/shared/utils.js';
import { closeSessionsWatcher, initializeSessionsWatcher, setSessionLivenessProbes, startCostLedgerScheduler, stopCostLedgerScheduler } from '@/modules/providers/index.js';
import { createWebSocketServer } from '@/modules/websocket/index.js';
import { createShutdownDrain, resolveDrainTimeoutMs } from '@/services/shutdown-drain.service.js';
import { listenWithGuard, resolveBindWindowMs } from '@/services/listen-with-guard.service.js';

import { getConnectableHost } from '../shared/networkHosts.js';

import { findAppRoot, getModuleDir } from './utils/runtime-paths.js';
import { clientIp } from './utils/client-ip.js';
import { sanitizeAttachmentName, resolveCollisionFreeDest } from './utils/attachment-helpers.js';
import { resolveReadPathInProject, isResolvedPathInsideRootReal } from './utils/path-guard.js';
import { sanitizeSvg } from './services/svg-sanitizer.js';
import {
    queryClaudeSDK,
    spawnClaudeSideQuery,
    abortClaudeSDKSession,
    isClaudeSDKSessionActive,
    getActiveClaudeSDKSessions,
    getDrainBlockingClaudeSessions,
    ghostDetachEnabled,
    resolveToolApproval,
    getPendingApprovalsForSession,
    cancelAllPendingApprovals,
    reconnectSessionWriter,
    isSessionPrimarySocketAlive,
    attachClaudeSDKSession,
    resolveContextWindow,
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
import sessionManager from './sessionManager.js';
import {
    stripAnsiSequences,
    normalizeDetectedUrl,
    extractUrlsFromText,
    shouldAutoOpenUrlFromOutput,
} from './utils/url-detection.js';
import gitRoutes from './routes/git.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import cursorRoutes from './routes/cursor.js';
import projectBoardRoutes from './routes/project-board.js';
import commandsRoutes from './routes/commands.js';
import settingsRoutes, { getBrandingHandler } from './routes/settings.js';
import agentRoutes from './routes/agent.js';
import projectModuleRoutes from './modules/projects/projects.routes.js';
import projectStatsRoutes from './modules/projects/project-stats.routes.js';
import { runnerRoutes, setRunnerControlGuard } from './modules/runner/index.js';
import userRoutes from './routes/user.js';
import geminiRoutes from './routes/gemini.js';
import pluginsRoutes from './routes/plugins.js';
import githubRoutes from './routes/github.js';
import systemRoutes from './routes/system.js';
import terminalsRoutes from './routes/terminals.js';
import {
    attachStandaloneTerminalSocket,
    writeStandaloneTerminalInput,
    resizeStandaloneTerminal,
    detachStandaloneTerminalSocket,
} from './services/standalone-terminals/standalone-terminal-registry.js';
import providerRoutes from './modules/providers/provider.routes.js';
import participantsRoutes from './modules/providers/participants.routes.js';
import workflowSupervisorLaunchRoutes from './modules/workflow-supervisor/launch.route.js';
import { ensureBackgroundTasksWatcher } from './modules/workflow-supervisor/background-tasks-watcher.service.js';
import { startEnabledPluginServers, stopAllPlugins, getPluginPort } from './utils/plugin-process-manager.js';
import { initializeDatabase, closeConnection, projectsDb, sessionsDb, appConfigDb, pendingServerActionsDb } from './modules/database/index.js';
import { isProjectVisible, coerceUserId } from './modules/projects/index.js';
import { configureWebPush } from './services/vapid-keys.js';
import { getBrandingTitle } from './services/branding-config.js';
import { ensureOwnerBootstrapped } from './services/bootstrap-owner.service.js';
import { enforcePlatformIsolationGuard } from './services/platform-isolation-guard.service.js';
import { enforceDockerSockBootGuard } from './services/isolation/docker-sock-boot-guard.js';
import { resolveSecurityPosture } from './services/isolation/security-posture.js';
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
const installMode = fs.existsSync(path.join(APP_ROOT, '.git')) ? 'git' : 'npm';
// T-928: mtime of the client bundle entry captured ONCE at process startup.
// `build:client` rewrites dist/index.html on disk while the server process
// keeps running. Comparing this frozen baseline to the current mtime on each
// /health probe detects "new frontend on disk, old backend still running"
// without any semver comparison (nassaj-dev keeps package.json version static
// between client-only builds). A 2-second tolerance absorbs filesystem clock
// jitter. Returns null when the file is absent (tsx dev mode without a prior
// build) so the caller knows not to flag a false positive.
const CLIENT_BUNDLE_PATH = path.join(APP_ROOT, 'dist', 'index.html');
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

const app = express();
const server = http.createServer(app);

// Single WebSocket server that handles chat, shell, and plugin proxy paths.
const wss = createWebSocketServer(server, {
    verifyClient: {
        isPlatform: IS_PLATFORM,
        authenticateWebSocket,
        // Cross-boundary collaborators injected from the composition root so the
        // websocket module never imports middleware/utils across the boundary
        // (eslint-plugin-boundaries). T-182 auth_rejected auditing on the WS path.
        jwtSecret: JWT_SECRET,
        recordRejection: recordAuthRejection,
        clientIp,
    },
    chat: {
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
    },
    shell: {
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
    getPluginPort,
});

// Make WebSocket server available to routes
app.locals.wss = wss;

// B-103 (ADR-053, T-821): background-task badge watcher. FLAG-GATED — a no-op
// when WORKFLOW_SUPERVISOR is OFF, so this is byte-identical to before until the
// flag is set. Mirrors the runner-watcher pattern: the app watches the (separate)
// supervisor's on-disk state and fans a `background-tasks-updated` signal to WS
// clients. Fail-safe: never throws into boot.
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
app.use(express.json({
    limit: '50mb',
    type: (req) => {
        // Skip multipart/form-data requests (for file uploads like images)
        const contentType = req.headers['content-type'] || '';
        if (contentType.includes('multipart/form-data')) {
            return false;
        }
        return contentType.includes('json');
    }
}));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
app.get('/health', async (req, res) => {
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
    // ADR-066 / T-944: expose ONLY a boolean on the PUBLIC, unauthenticated
    // /health (counts/booleans only — never ids, reasons, or sessionIds, per the
    // /health contract above). hasPendingActions is true when the server-action
    // queue has any actionable row (pending or failed). The sanitized details are
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
    res.json({
        status: 'ok',
        service: 'nassaj-server',
        timestamp: new Date().toISOString(),
        installMode,
        activeSessions,
        restartRequired,
        clientReloadRequired,
        clientBundleMtimeAtStartup,
        clientBundleMtimeNow,
        hasPendingActions,
    });
});

// Optional API key validation (if configured)
app.use('/api', validateApiKey);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Admin routes (protected; owner/admin enforced inside the router)
app.use('/api/admin', authenticateToken, adminRoutes);

// Projects API Routes (protected)
app.use('/api/projects', authenticateToken, projectModuleRoutes);

// Project cost & stats (protected) — /:projectId/cost, /:projectId/stats and the
// owner/admin ledger rebuild. Same prefix, mounted AFTER the lifecycle router:
// none of these paths exist there, so Express falls through to this one. Kept a
// separate router because it reads a different subsystem (the cost ledger) and
// answers the flat `{ success, cost|stats }` envelope of the cost surface.
app.use('/api/projects', authenticateToken, projectStatsRoutes);

// Session participant/agent tracking (protected)
app.use('/api/sessions', authenticateToken, participantsRoutes);

// Git API Routes (protected)
app.use('/api/git', authenticateToken, gitRoutes);

// Cursor API Routes (protected)
app.use('/api/cursor', authenticateToken, cursorRoutes);

// Project Board API Routes (protected) — live view of docs/project-state.json
app.use('/api/project-board', authenticateToken, projectBoardRoutes);

// Runner Bridge API Routes (protected) — read runner state, write control files
// (ADR-RUNNER-BRIDGE-001). The board overlay's only contact surface with the runner.
// GET is open to any authenticated user (read-only status); the five control verbs
// (start/stop/pause/resume/approve) launch self-driving `claude -p` sessions that
// burn Anthropic quota and mutate the repo, so they require owner/admin — injected
// here to keep the module router free of a direct middleware import.
setRunnerControlGuard(requireRole('owner', 'admin'));
app.use('/api/runner', authenticateToken, runnerRoutes);

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

// Plugins API Routes (protected)
app.use('/api/plugins', authenticateToken, pluginsRoutes);

// GitHub API Routes (protected) — repository listing for the project wizard.
app.use('/api/github', authenticateToken, githubRoutes);

// System stats (protected) — live CPU/RAM for the sidebar footer widget.
app.use('/api/system', authenticateToken, systemRoutes);

// Standalone terminals (protected) — T-938 (ADR-063). REST is create/metadata
// ONLY; the live PTY stream attaches exclusively over WS /terminal. Per-user
// ownership is enforced inside the registry (foreign ⇒ 404, never 403).
// Admin surface: terminals are gated to owner/admin (ADR-063 amend) — the WS
// /terminal path enforces the SAME role gate at init (4403), never client-only.
app.use('/api/terminals', authenticateToken, requireRole('owner', 'admin'), terminalsRoutes);

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
});

// Unified provider MCP routes (protected). The owner/admin gate on skill writes
// (B-26) is enforced in-handler inside provider.routes.ts, immune to Express's
// case-insensitive path matching.
app.use('/api/providers', authenticateToken, providerRoutes);

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
app.get('/manifest.json', async (req, res) => {
    try {
        const raw = await fsPromises.readFile(path.join(APP_ROOT, 'public', 'manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        const brandingTitle = getBrandingTitle();
        if (brandingTitle) {
            manifest.name = brandingTitle;
            manifest.short_name = brandingTitle;
        }
        res.setHeader('Cache-Control', 'no-cache');
        res.type('application/manifest+json').send(JSON.stringify(manifest));
    } catch (error) {
        console.error('Error serving manifest.json:', error);
        res.status(500).json({ error: 'Failed to serve manifest' });
    }
});

// Serve public files (like api-docs.html)
app.use(express.static(path.join(APP_ROOT, 'public')));

// Static files served after API routes
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
app.post('/api/system/update', authenticateToken, requireRole('owner', 'admin'), async (req, res) => {
    try {
        // Get the project root directory (parent of server directory)
        const projectRoot = APP_ROOT;

        console.log('Starting system update from directory:', projectRoot);

        // Platform deployments use their own update workflow from the project root.
        const updateCommand = IS_PLATFORM
        // In platform, husky and dev dependencies are not needed
            ? 'npm run update:platform'
            : installMode === 'git'
                ? 'git checkout main && git pull && npm install'
                : 'npm install -g @cloudcli-ai/cloudcli@latest';

        const updateCwd = IS_PLATFORM || installMode === 'git'
            ? projectRoot
            : os.homedir();

        const child = spawn('sh', ['-c', updateCommand], {
            cwd: updateCwd,
            env: process.env
        });

        let output = '';
        let errorOutput = '';

        child.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            console.log('Update output:', text);
        });

        child.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            console.error('Update error:', text);
        });

        // A failed spawn emits BOTH 'error' and then 'close' (with code null), so
        // two independent listeners each answering the request threw
        // ERR_HTTP_HEADERS_SENT from inside an event listener — outside this
        // try/catch and, with no process-level handler, fatal to the whole server
        // (every live session dies with it). Single-settle + headersSent, the
        // same shape as the finish() helper in routes/system.js.
        let settled = false;
        const finish = (respond) => {
            if (settled) return;
            settled = true;
            if (!res.headersSent) {
                respond();
            }
        };

        child.on('close', (code) => {
            finish(() => {
                if (code === 0) {
                    res.json({
                        success: true,
                        output: output || 'Update completed successfully',
                        message: 'Update completed. Please restart the server to apply changes.'
                    });
                } else {
                    res.status(500).json({
                        success: false,
                        error: 'Update command failed',
                        output: output,
                        errorOutput: errorOutput
                    });
                }
            });
        });

        child.on('error', (error) => {
            console.error('Update process error:', error);
            finish(() => {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            });
        });

    } catch (error) {
        console.error('System update error:', error);
        // Same reason as the listeners above: never write a second response.
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
});

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

app.post('/api/create-folder', authenticateToken, async (req, res) => {
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
app.put('/api/projects/:projectId/file', authenticateToken, async (req, res) => {
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
        await fsPromises.writeFile(resolved, content, 'utf8');

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
app.post('/api/projects/:projectId/files/create', authenticateToken, async (req, res) => {
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
app.put('/api/projects/:projectId/files/rename', authenticateToken, async (req, res) => {
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
app.delete('/api/projects/:projectId/files', authenticateToken, async (req, res) => {
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
    uploadMiddleware.array('files', MAX_FILE_UPLOAD_COUNT)(req, res, async (err) => {
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
    });
};

app.post('/api/projects/:projectId/files/upload', authenticateToken, uploadFilesHandler);

// Image upload endpoint. Accepts the DB-assigned `projectId` (not a folder name)
// but the current implementation doesn't need to touch the project directory,
// so we just leave the param rename for consistency with the rest of the API.
app.post('/api/projects/:projectId/upload-images', authenticateToken, async (req, res) => {
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
        upload.array('images', 15)(req, res, async (err) => {
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
        });
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

app.post('/api/projects/:projectId/upload-attachments', authenticateToken, async (req, res) => {
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

        upload.array('files', MAX_ATTACHMENT_COUNT)(req, res, async (err) => {
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
            const codexHome = (codexUserId !== null && isProviderIsolated('codex'))
                ? userConfigDir(codexUserId, '.codex')
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
            const lines = fileContent.trim().split('\n');
            let inputTokens = 0;
            let outputTokens = 0;
            let totalTokens = 0;
            let contextWindow = 200000; // Default for Codex/OpenAI

            // Find the latest token_count event with info (scan from end)
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const entry = JSON.parse(lines[i]);

                    // Codex stores token info in event_msg with type: "token_count"
                    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload?.info) {
                        const tokenInfo = entry.payload.info;
                        if (tokenInfo.total_token_usage) {
                            inputTokens = tokenInfo.total_token_usage.input_tokens || 0;
                            outputTokens = tokenInfo.total_token_usage.output_tokens || 0;
                            totalTokens = tokenInfo.total_token_usage.total_tokens || inputTokens + outputTokens;
                        }
                        if (tokenInfo.model_context_window) {
                            contextWindow = tokenInfo.model_context_window;
                        }
                        break; // Stop after finding the latest token count
                    }
                } catch (parseError) {
                    // Skip lines that can't be parsed
                    continue;
                }
            }

            return res.json({
                used: totalTokens,
                total: contextWindow,
                inputTokens,
                outputTokens,
                breakdown: {
                    input: inputTokens,
                    output: outputTokens
                }
            });
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

        // Construct the JSONL file path
        // Claude stores session files in ~/.claude/projects/[encoded-project-path]/[session-id].jsonl
        // The encoding replaces any non-alphanumeric character (except -) with -
        const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDir = path.join(homeDir, '.claude', 'projects', encodedPath);

        const jsonlPath = path.join(projectDir, `${safeSessionId}.jsonl`);

        // Constrain to projectDir
        const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return res.status(400).json({ error: 'Invalid path' });
        }

        // Read and parse the JSONL file
        let fileContent;
        try {
            fileContent = await fsPromises.readFile(jsonlPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') {
                return res.status(404).json({ error: 'Session file not found', path: jsonlPath });
            }
            throw error; // Re-throw other errors to be caught by outer try-catch
        }
        const lines = fileContent.trim().split('\n');

        // Full input must include cached tokens: Anthropic's `input_tokens`
        // excludes `cache_read_input_tokens` and `cache_creation_input_tokens`,
        // so with prompt caching enabled (the default) counting input_tokens
        // alone underreports real context usage badly.
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheRead = 0;
        let cacheCreation = 0;
        let modelName = null;

        // Find the latest assistant message with usage data (scan from end)
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const entry = JSON.parse(lines[i]);

                // Only count assistant messages which have usage data
                if (entry.type === 'assistant' && entry.message?.usage) {
                    const usage = entry.message.usage;

                    // Use token counts from latest assistant message only
                    const rawInput = usage.input_tokens || 0;
                    cacheRead = usage.cache_read_input_tokens || 0;
                    cacheCreation = usage.cache_creation_input_tokens || 0;
                    inputTokens = rawInput + cacheRead + cacheCreation;
                    outputTokens = usage.output_tokens || 0;
                    if (typeof entry.message.model === 'string') {
                        modelName = entry.message.model;
                    }

                    break; // Stop after finding the latest assistant message
                }
            } catch (parseError) {
                // Skip lines that can't be parsed
                continue;
            }
        }

        // Real model context window (env override > model inference > default).
        const contextWindow = resolveContextWindow(modelName);
        const totalUsed = inputTokens + outputTokens;

        res.json({
            used: totalUsed,
            total: contextWindow,
            inputTokens,
            outputTokens,
            breakdown: {
                input: inputTokens,
                output: outputTokens,
                cacheRead,
                cacheCreation
            }
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

// Initialize database and start server
async function startServer() {
    try {
        // Initialize authentication database
        await initializeDatabase();

        // T-896 / B-170 docker-socket gate, long before the listener opens: if
        // this process can reach /var/run/docker.sock via its numeric gids,
        // docker escape to host root is one provider turn away and every
        // isolation layer below is moot.
        //
        // T-1085: the gate now runs AFTER initializeDatabase (nothing is served
        // yet, no provider can spawn) because its ACTION depends on the
        // deployment posture, and the posture needs the account count. Shared
        // host → unchanged hard refusal with the degroup remediation (the catch
        // below exits 1, still no disable flag). Single-user host → the same
        // finding is logged and recorded for the UI, and boot continues: the
        // only human who can drive an agent here already owns the login shell.
        const posture = resolveSecurityPosture();
        enforceDockerSockBootGuard({ shared: posture.shared, postureReason: posture.reason });

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
                console.log(`  ${c.bright('CloudCLI Server - Ready')}`);
                console.log(c.dim('═'.repeat(63)));
                console.log('');
                console.log(`${c.info('[INFO]')} Server URL:  ${c.bright('http://' + DISPLAY_HOST + ':' + SERVER_PORT)}`);
                console.log(`${c.info('[INFO]')} Installed at: ${c.dim(appInstallPath)}`);
                console.log(`${c.tip('[TIP]')}  Run "cloudcli status" for full configuration details`);
                console.log('');

                // Start watching the projects folder for changes
                initializeSessionsWatcher().catch(err => {
                    console.error('[Sessions] Error initializing watcher:', err.message);
                });

                // Start server-side plugin processes for enabled plugins
                startEnabledPluginServers().catch(err => {
                    console.error('[Plugins] Error during startup:', err.message);
                });

                // Persisted project-cost ledger (T-1060): providers prune their
                // own transcripts after ~30 days, so spend that was never
                // ingested before the prune has no source left to recover from.
                // The periodic pass is what makes "the total survives conversation
                // deletion" true; without it the ledger is only as current as the
                // last manual scan. Incremental via watermarks, so it is cheap.
                startCostLedgerScheduler();
            },
        });

        stopCostLedgerScheduler();
        await closeSessionsWatcher();

        // B-N-DRAIN (ADR-021 / ADR-022) + B-23: a stop signal triggers a TIMED
        // DRAIN instead of an immediate process.exit(0), and — critically —
        // releases the HTTP/WS listener at once so the PM2 replacement
        // instance can bind the port while in-flight provider runs finish.
        // Full semantics documented in shutdown-drain.service.ts.
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
            }),
            stopAllPlugins,
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
        console.error('[ERROR] Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
