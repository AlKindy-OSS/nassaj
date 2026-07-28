/**
 * SYSTEM STATS API ROUTES
 * =======================
 *
 * Lightweight host hardware telemetry for the sidebar footer widget:
 *
 *   GET /api/system/stats →
 *     {
 *       cpu:    { percent: number },                            // 0..100, 2 decimals
 *       memory: { usedBytes, totalBytes, percent }              // percent 0..100, 1 decimal
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
 * No new dependencies; node:fs + node:os only.
 */

import crypto from 'crypto';
import fs, { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { spawn } from 'child_process';

import express from 'express';

import { createRateLimiter } from '../middleware/rate-limit.js';
import { requireRole, roleSatisfies } from '../middleware/auth.js';
import { auditLogDb, pendingServerActionsDb } from '../modules/database/index.js';
import { attachSessionTitles } from '../services/live-session-titles.js';
import {
    buildPendingAction,
    toPublic,
    toPublicCatalog,
    isGlobalIdempotentAction,
} from '../services/server-actions.js';
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

const router = express.Router();

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
// Detached --exec output is captured here (not discarded) so a failed restart
// is diagnosable after the fact.
const RESTART_LOG_PATH = path.join(DATA_DIR, 'last-restart.log');

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
    auditLogDb.record('system_restart_triggered', {
        userId: req.user?.id ?? null,
        metadata: {
            result,
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

// GET /api/system/stats — live CPU + memory utilisation of the host.
router.get('/stats', statsLimiter, async (req, res) => {
    try {
        const [cpuPercent, memory] = await Promise.all([getCpuPercent(), getMemoryStats()]);
        res.json({
            cpu: { percent: round2(cpuPercent) },
            memory,
        });
    } catch (error) {
        console.error('[system] stats failed:', error.message);
        res.status(500).json({ error: 'Failed to read system stats' });
    }
});

// ── Queue maintenance (B-185 ب / B-200) ─────────────────────────────────────
//
// Two janitor passes the queue needs and had no caller for:
//   • reapStaleExecuting — returns rows abandoned in 'executing' (the process
//     died between the CAS claim and the outcome) to 'pending'. ALWAYS on: this
//     is recovery of live queue work, not deletion of history.
//   • pruneTerminal — 90-day retention for old 'failed' history. Stays behind
//     NASSAJ_PENDING_ACTIONS_RETENTION=1 and is a no-op while that flag is unset,
//     so wiring it here changes nothing on a default install.
//
// WHY IT HANGS OFF THE FIRST QUEUE READ instead of module scope: this file is
// imported by server/index.js BEFORE initializeDatabase() runs, so a top-level
// call would hit an unmigrated database. GET /pending can only be served after
// the listener is open (hence after init), and the queue UI issues one on mount
// and on every WS 'pending-actions-updated' — so this runs within moments of the
// first client. One-shot per process, idempotent, and best-effort: a failure
// here must never break the listing.
let queueMaintenanceDone = false;
export function runQueueMaintenanceOnce() {
    if (queueMaintenanceDone) return;
    queueMaintenanceDone = true;
    try {
        pendingServerActionsDb.reapStaleExecuting();
        pendingServerActionsDb.pruneTerminal();
    } catch (error) {
        console.error('[system] queue maintenance failed:', error.message);
    }
}

// GET /api/system/pending — LIST the actionable server-action queue (ADR-066,
// T-944). authenticateToken is applied to this router in server/index.js, so any
// AUTHENTICATED session may READ the queue (reading ≠ executing — consistent with
// recording being open to any authenticated session; only execute/dismiss are
// owner-gated). statsLimiter is the same lightweight read limiter used by /stats.
// toPublic never surfaces cmd/argv, so no executable detail leaks.
router.get('/pending', statsLimiter, (req, res) => {
    try {
        runQueueMaintenanceOnce();
        const rows = pendingServerActionsDb.listActionable();
        return res.json({ actions: rows.map((r) => toPublic(r, resolveAction)).filter(Boolean) });
    } catch (error) {
        console.error('[system] list pending actions failed:', error.message);
        return res.status(500).json({ status: 'error', code: 'internal', detail: 'Failed to list actions' });
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
 */
function runRawCommand(req, res, prep) {
    const { row, digest, spawn: plan } = prep;
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
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', code: 'timeout', detail: 'Command timed out' });
                }
            });
        }, plan.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();

        child.on('error', (error) => {
            finish(() => {
                auditRawExec(req, 'failure', { id: row.id, digest, command: row.command, reason: 'process_error' });
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
                if (!res.headersSent) {
                    res.status(success ? 200 : 500).json({
                        status: success ? 'success' : 'error',
                        ...(success ? {} : { code: 'exec_failed' }),
                        exitCode: code,
                        stdout: finalize(out),
                        stderr: finalize(err),
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
    const built = buildPendingAction(
        {
            actionType: body.actionType,
            sessionId: body.sessionId,
            reason: body.reason,
            requestedBy: typeof req.user?.username === 'string' ? req.user.username : null,
        },
        { isAllowed: isKnownActionType }
    );
    if (!built.ok) {
        return res.status(400).json({ status: 'error', code: 'invalid_action', detail: built.error });
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
            const queued = pendingServerActionsDb.getQueuedByActionType(built.value.actionType);
            if (queued) {
                if (built.value.reason) pendingServerActionsDb.appendReason(queued.id, built.value.reason);
                const merged = pendingServerActionsDb.getById(queued.id);
                broadcastPendingActionsUpdated(req);
                return res.status(200).json({
                    deduped: true,
                    action: merged ? toPublic(merged, resolveAction) : null,
                });
            }
        }

        const inserted = pendingServerActionsDb.insert(built.value);
        if (inserted === 0) {
            // Deduped against an already-pending request for the same key.
            const existing = pendingServerActionsDb.getPendingByDedup(
                built.value.actionType,
                built.value.sessionId
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
    try {
        // (1) Atomic claim: only an ACTIONABLE row (pending or failed — the same
        // set listActionable shows) can be executed. A 'failed' row is claimable
        // so Retry actually works (B-200); 'executing' is still excluded, which
        // is what keeps this the durable double-run guard.
        if (pendingServerActionsDb.claimForExecution(id) !== 1) {
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

        // (3) Pre-flight gate (if any).
        if (action.gateArgs) {
            const gate = await runActionGate(action);

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
                pendingServerActionsDb.resetToPending(id);
                recordActionOutcome(req, row, 'deferred', { liveCount });
                broadcastPendingActionsUpdated(req);
                return res.status(200).json({ status: 'deferred', reason: 'live-work', detail });
            }

            if (gate.code === 4) {
                // Not managed by PM2 — transient/environmental. Return to pending
                // so a retry works once PM2 manages the process again.
                pendingServerActionsDb.resetToPending(id);
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
                let detail = 'Live interactive sessions in progress; restart deferred';
                let sessionCount = null;
                let liveSessions = [];
                let sessionServerPid = null;
                try {
                    const parsed = JSON.parse(gate.stdout);
                    if (parsed && typeof parsed.sessionCount === 'number') {
                        sessionCount = parsed.sessionCount;
                        detail = `Live interactive sessions in progress (${parsed.sessionCount}); restart deferred`;
                    }
                    if (parsed && Array.isArray(parsed.liveSessions)) {
                        // B-270: enrich with the conversation titles the owner
                        // recognises; visibility-filtered, never throws.
                        liveSessions = attachSessionTitles(
                            parsed.liveSessions,
                            typeof req.user?.id === 'number' ? req.user.id : null,
                        );
                    }
                    if (parsed && (typeof parsed.sessionServerPid === 'number' || parsed.sessionServerPid === null)) {
                        sessionServerPid = parsed.sessionServerPid;
                    }
                } catch {
                    // keep the generic detail; fail-safe to a bare deferral
                }
                pendingServerActionsDb.resetToPending(id);
                recordActionOutcome(req, row, 'deferred', { reason: 'live-sessions', sessionCount });
                broadcastPendingActionsUpdated(req);
                return res.status(200).json({
                    status: 'deferred',
                    reason: 'live-sessions',
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
                    detail: 'Pre-action safety check failed',
                });
            }
        }

        // (4) Gate passed (or no gate). Execute.
        recordActionOutcome(req, row, 'triggered', { reason: row?.reason ?? null });

        if (action.detachExec) {
            // (4a) The action restarts THIS process. Delete the row FIRST
            // (synchronous + durable) so even if we die before flushing, no stale
            // row remains. Then answer, flush, and spawn detached+unref.
            pendingServerActionsDb.deleteById(id);
            // A global action satisfies every OTHER row waiting for the same
            // work, so they must go with it. Leaving them queued is precisely
            // what turned one needed restart into a sequence of them, each one
            // draining live sockets. Rows created AFTER this point survive: they
            // asked for a deploy of something newer than what is about to run.
            if (isGlobalIdempotentAction(row?.actionType ?? '')) {
                const alsoSatisfied = pendingServerActionsDb.clearSiblings(row.actionType, id);
                if (alsoSatisfied > 0) {
                    console.log(
                        `[system] safe-restart satisfied ${alsoSatisfied} other queued request(s) `
                        + 'for the same action — cleared instead of restarting again'
                    );
                }
            }
            broadcastPendingActionsUpdated(req);

            res.status(200).json({ status: 'restarting' });
            if (typeof res.flush === 'function') {
                res.flush();
            }

            // Re-enqueues the row that was optimistically deleted above, for any
            // path where it turns out no restart will happen. Idempotent-ish:
            // the insert is dedup-tolerant, so a double call cannot duplicate it.
            const reenqueueRow = (outcome, extra = {}) => {
                try {
                    if (row) {
                        pendingServerActionsDb.insert({
                            id: row.id,
                            actionType: row.actionType,
                            sessionId: row.sessionId,
                            reason: row.reason,
                            requestedBy: row.requestedBy,
                        });
                    }
                    recordActionOutcome(req, row, outcome, extra);
                    broadcastPendingActionsUpdated(req);
                } catch (recoveryError) {
                    console.error('[system] action exec recovery failed:', recoveryError.message);
                }
            };

            try {
                const logFd = fs.openSync(RESTART_LOG_PATH, 'a');
                const child = spawn(action.cmd, [...action.args], {
                    cwd: action.cwd,
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
                    if (code === 0) return; // restart under way; we are on our way out
                    if (restartFlagSafetyTimer) {
                        clearTimeout(restartFlagSafetyTimer);
                        restartFlagSafetyTimer = null;
                    }
                    restartInFlight = false;
                    console.error(`[system] detached --exec exited without restarting (code=${code}, signal=${signal}); action re-queued`);
                    reenqueueRow('deferred', { reason: 'exec_declined', exitCode: code });
                });
                child.on('error', (error) => {
                    restartInFlight = false;
                    console.error('[system] detached --exec child error:', error.message);
                    reenqueueRow('exec_failed', { detail: error.message });
                });

                // Last-resort net: if the child never reports (unref'd handle
                // lost, signal missed) and we are somehow still alive, do not
                // stay wedged forever.
                scheduleRestartFlagRelease(() => reenqueueRow('deferred', { reason: 'restart_timeout' }));
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
                reenqueueRow('exec_failed', { detail: error.message });
                return undefined;
            }
        }

        // (4b) Non-detached action (future): spawn, observe, bound by 120s.
        await runForegroundAction(req, res, action, id, row);
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
        const built = buildPendingAction({
            actionType,
            sessionId: body.sessionId,
            reason: body.reason,
            requestedBy: typeof req.user?.username === 'string' ? req.user.username : null,
        }, { isAllowed: isKnownActionType });
        if (!built.ok) {
            return res.status(400).json({ status: 'error', code: 'invalid_action', detail: built.error });
        }

        // (4) Insert (dedup-tolerant). A still-pending row for the same
        // (actionType, sessionId) is REUSED rather than duplicated, so a repeated
        // click collapses onto the existing row — identical to POST /pending.
        let targetId = built.value.id;
        try {
            const inserted = pendingServerActionsDb.insert(built.value);
            if (inserted === 0) {
                const existing = pendingServerActionsDb.getPendingByDedup(
                    built.value.actionType,
                    built.value.sessionId
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
 * bounded by FOREGROUND_ACTION_TIMEOUT_MS. exit 0 → delete the row + 200 success;
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
                    pendingServerActionsDb.deleteById(id);
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
// executing it). Floor aligned to requireRole('admin','owner') for consistency
// with the execute path (dismissing is strictly less privileged than executing).
// Idempotent: a missing/absent id is not an error (the queue converges to "gone"
// either way).
router.delete('/pending/:id', requireRole('admin', 'owner'), (req, res) => {
    const { id } = req.params;
    try {
        pendingServerActionsDb.deleteById(id);
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
