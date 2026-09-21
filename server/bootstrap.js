#!/usr/bin/env node
/** Claim a durable update handoff before any server module can admit writes. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { establishStartupAdmission, admitSecurityStartup } from './bootstrap-startup-context.js';

const OWNERSHIP_SYMBOL = Symbol.for('nassaj.sourceUpdate.bootstrapOwnership.v1');
const MAINTENANCE_POLL_MS = 5_000;

/** One structured line on stderr: bootstrap runs before any application logger exists. */
function logBootstrap(event, fields = {}) {
    process.stderr.write(`${JSON.stringify({ component: 'bootstrap', event, ...fields })}\n`);
}

/** Recovery is attempted, never trusted to succeed: a throw is a closed gate, not an exit. */
async function attemptRecovery(gate) {
    try {
        return await gate.recoverOrDeclareManual({ ownershipContext: null });
    } catch (error) {
        logBootstrap('recovery_failed', { code: String(error?.message || 'unknown').slice(0, 200) });
        return null;
    }
}

/**
 * Serve 503 on every route while the maintenance gate stays closed, and on
 * /health the public degraded reason (never the exit path, م-9), so an outside
 * probe learns WHY. This replaced exiting with `update_bootstrap_recovery_required`,
 * which pm2 turned into a crash-loop with nothing listening (qa-critic C1).
 */
export async function serveMaintenance({ readPublicStatus, port = process.env.SERVER_PORT || 3001,
    host = process.env.HOST || '0.0.0.0' }) {
    const { resolveDegraded } = await import('./services/health-degraded.js');
    const server = http.createServer((req, res) => {
        const health = (req.url || '').split('?')[0] === '/health';
        const { degradedReason, degradedPhase } = resolveDegraded(readPublicStatus);
        const body = health
            ? { status: 'maintenance', degraded: true, degradedReason, degradedPhase }
            : { error: 'maintenance', degradedReason };
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '30' });
        res.end(JSON.stringify(body));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(port), host, () => { server.off('error', reject); resolve(); });
    });
    return {
        address: () => server.address(),
        close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    };
}

/**
 * Hold the process in maintenance until the gate opens — by a later automatic
 * recovery (the owner died meanwhile) or by `doctor --reopen-gate` — then return
 * so the caller imports the application in this same process. MANUAL is never
 * re-recovered here: re-running it only bumps the journal.
 */
async function holdInMaintenance(gate, options) {
    const pollMs = options.maintenancePollMs ?? MAINTENANCE_POLL_MS;
    const handle = await (options.serveMaintenance || serveMaintenance)({ readPublicStatus: () => gate.readPublicStatus() });
    logBootstrap('maintenance_serving', { pollMs });
    try {
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            let current;
            try { current = gate.readPublicStatus(); } catch { continue; }
            if (!current.gateClosed && !gate.hasPendingOidAdmissionIntent?.()) return;
            if (current.state !== 'MANUAL' && (await attemptRecovery(gate))?.state === 'OPEN') return;
        }
    } finally {
        await handle.close();
        logBootstrap('maintenance_released');
    }
}

function applicationRoot(moduleFile = fileURLToPath(import.meta.url)) {
    const moduleDirectory = path.dirname(moduleFile);
    return path.basename(path.dirname(moduleDirectory)) === 'dist-server'
        ? path.dirname(path.dirname(moduleDirectory))
        : path.dirname(moduleDirectory);
}

/** Validate the fixed, non-secret handoff descriptor written before restart. */
export function readBootstrapHandoff(gate) {
    const file = path.join(gate.paths.controlRoot, 'bootstrap-handoff.json');
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error('update_bootstrap_handoff_unsafe');
    }
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.schema !== 'nassaj-source-update-bootstrap/v1'
        || !/^[A-Za-z0-9_-]{16,128}$/.test(value.transactionId || '')
        || !/^[A-Za-z0-9_-]{16,128}$/.test(value.epoch || '')
        || path.resolve(value.tokenFilePath || '') !== gate.paths.token) {
        throw new Error('update_bootstrap_handoff_invalid');
    }
    return value;
}

/** Load only environment configuration, without importing application/database modules. */
export function loadBootstrapConfiguration(projectPath, env = process.env) {
    let content;
    try { content = fs.readFileSync(path.join(projectPath, '.env'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [key, ...values] = trimmed.split('=');
        if (key && values.length && !env[key]) env[key] = values.join('=').trim();
    }
}

/** Dynamic ordering is intentional: gate claim completes before index imports. */
export async function bootstrapServer(options = {}) {
    const projectPath = path.resolve(options.projectPath || applicationRoot());
    const startup = await establishStartupAdmission();
    if (startup) {
        // Import the application's exact environment loader once before its first database inspector.
        // The later application import shares this ESM instance and cannot reread a changed .env.
        await import('./load-env.js');
        // The connection performs actual-handle identity and existing-security inspections before app imports.
        const { getConnection } = await import('./modules/database/connection.js');
        getConnection();
        await admitSecurityStartup();
        // eslint-disable-next-line import-x/no-unresolved
        return import('./application.js');
    }
    loadBootstrapConfiguration(projectPath);
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const hasReleaseApplication = fs.existsSync(path.join(moduleDirectory, 'application.js'));
    const applicationPath = path.join(moduleDirectory, hasReleaseApplication ? 'application.js' : 'index.js');
    const gateModule = options.gateModule || await import('./services/update-maintenance-gate.js');
    const gate = gateModule.createUpdateMaintenanceGate({ projectPath });
    gate.assertArtifactStartup?.();
    if (gate.hasPendingOidAdmissionIntent?.()) {
        const recovered = await attemptRecovery(gate);
        if (recovered?.state !== 'OPEN') await holdInMaintenance(gate, options);
    }
    const status = gate.readPublicStatus();
    let claim = null;
    let pairStartup = null;
    if (status.kind === 'oid-pair' && status.gateClosed) {
        try { pairStartup = gate.inspectOidBootstrapAdmission(applicationPath); }
        catch (error) {
            logBootstrap('oid_pair_grant_refused', { code: String(error.code || error.message).slice(0, 200) });
            await holdInMaintenance(gate, options);
        }
        if (!pairStartup) await holdInMaintenance(gate, options);
        globalThis[Symbol.for('nassaj.oidPair.bootstrapAdmission.v1')] = pairStartup;
    }
    // A MANUAL handoff was already refused once; claiming it again on every pm2
    // restart would only rethrow, so it takes the maintenance path instead.
    let handoff = null;
    if (status.gateClosed && status.phase === 'RESTARTING_HANDOFF' && status.state !== 'MANUAL') {
        // B-1125: a journal can reach RESTARTING_HANDOFF without its descriptor
        // (a crash or write error between the two). Reading it outside recovery
        // exited with ENOENT on every pm2 restart; an unreadable descriptor is
        // now a recovery case — past the handoff that means MANUAL and 503.
        try { handoff = readBootstrapHandoff(gate); } catch (error) {
            logBootstrap('handoff_unreadable', { code: String(error?.code || error?.message || 'unknown').slice(0, 200) });
        }
    }
    if (handoff) {
        claim = await gate.claimBootstrapOwnership({
            transactionId: handoff.transactionId,
            epoch: handoff.epoch,
            tokenFilePath: handoff.tokenFilePath,
            applicationPath,
        });
        globalThis[OWNERSHIP_SYMBOL] = Object.freeze({
            transactionId: handoff.transactionId, artifact: claim.artifact || null,
            ownershipContext: claim.ownershipContext,
            complete: (patch) => claim.complete(patch),
            release: () => claim.release(),
        });
    } else if (status.gateClosed && !pairStartup) {
        const recovery = await attemptRecovery(gate);
        if (recovery?.state !== 'OPEN') await holdInMaintenance(gate, options);
    }
    try {
        // Release candidates retain the compiled application as application.js
        // and install this bootstrap at index.js too, so existing host PM2
        // configs automatically gain the pre-import gate without being edited.
        const loadServer = options.loadServer || (() => hasReleaseApplication
            // Generated by installReleaseBootstrapEntry; absent in the source tree.
            // eslint-disable-next-line import-x/no-unresolved
            ? import('./application.js')
            : import('./index.js'));
        return await loadServer();
    } catch (error) {
        claim?.release();
        delete globalThis[OWNERSHIP_SYMBOL];
        delete globalThis[Symbol.for('nassaj.oidPair.bootstrapAdmission.v1')];
        throw error;
    }
}

/** Recognize direct execution or PM2's actual CommonJS fork container, never an environment flag alone. */
export function isBootstrapProcessEntrypoint(moduleFile = fileURLToPath(import.meta.url)) {
    if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) return true;
    try {
        if (!process.env.pm_exec_path || !process.argv[1] || !process.mainModule?.filename) return false;
        if (fs.realpathSync(process.env.pm_exec_path) !== fs.realpathSync(moduleFile)) return false;
        const container = fs.realpathSync(process.argv[1]);
        if (fs.realpathSync(process.mainModule.filename) !== container
            || path.basename(container) !== 'ProcessContainerFork.js'
            || path.basename(path.dirname(container)) !== 'lib') return false;
        const packageFile = path.join(path.dirname(path.dirname(container)), 'package.json');
        const metadata = fs.lstatSync(packageFile);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) return false;
        return JSON.parse(fs.readFileSync(packageFile, 'utf8')).name === 'pm2';
    } catch { return false; }
}

if (isBootstrapProcessEntrypoint()) {
    bootstrapServer().catch((error) => {
        console.error(`[BOOTSTRAP] ${error.message}`);
        process.exitCode = 1;
    });
}
