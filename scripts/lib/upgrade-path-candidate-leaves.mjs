// upgrade-path-candidate-leaves.mjs — the "candidate leaves" gate leg (ADR-204 S0, §3.12 leg 1).
//
// The in-process legs of upgrade-path-gate.mjs call the candidate's update
// modules directly. This leg instead installs the candidate as the committed,
// running generation of a sandbox node (upgrade-path-leaves-node.mjs) and drives
// one update to the synthetic next release through the SAME path the owner's
// update button uses, with nothing called directly:
//
//   GET  /health                         the candidate serves, from pm2
//   POST /api/auth/login                 the owner the app's own first-run created
//   GET  /api/system/release/latest      server-side discovery (what the button shows)
//   POST /api/system/update/jobs         {activateWhenIdle, deferUntilIdle, consent}:
//                                        owner role check, ADR-190 deferral, consent
//   (server)  worker → source updater → fetch over the transport shim → the next
//             release's own builders → activation-action write → restart queue
//   (server)  auto-activator: the REAL idle detector (governed sessions, open
//             terminals, scheduled messages) → executeActionRow → reader →
//             safe-restart.sh gate → in-process activation → safe-restart.sh
//             --exec → pm2 restart of the sandbox app
//   (N+1)     boot-time action read, candidate validation, job `activated`
//   GET  /api/system/update/jobs/:id     polled until a terminal state
//   GET  /health                         serves the next version, commit, new pid
//
// The node has no live session, terminal or scheduled message, so the real
// detector must find it idle; a detector that never does is reported as
// `candidate_leaves_node_busy`, never as a pass. Every outcome but `activated`
// followed by the next release serving from a new pm2 process fails the leg.

import { randomUUID } from 'node:crypto';
import { statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { freePort, throwawayOwner } from './release-generation/generation-boot-smoke.mjs';
import {
    LeavesError, assertRestartLogSandboxed, assertSandboxRestartEnvironment, installLeavesSignalGuard, leavesEnvironment, leavesLayout, pm2App, pm2LogTail, prepareLeavesNode,
    recoveryCommand, resolveExecutable, sandboxPort, startNode, stopLeavesHost, writeLeavesShims,
} from './upgrade-path-leaves-node.mjs';

export const LEAVES_LEG = 'candidate-leaves';

/**
 * Bounds of one run (ms). Measured on the 8-core release host: install build
 * ~80 s, button press to `activated` ~115 s (the next release's build ~85 s,
 * restart_queued to activated ~30 s, one 30 s auto-activator tick at most).
 * idleWaitMs and activationMs cover five ticks; totalMs caps a hung build.
 */
export const LEAVES_LIMITS = Object.freeze({
    bootMs: 3 * 60 * 1000, totalMs: 20 * 60 * 1000, idleWaitMs: 150 * 1000,
    activationMs: 180 * 1000, pollMs: 1000,
});
const BODY_LIMIT = 256 * 1024;
/** Two node_modules copies, two builds and the update's own staging fit in about 3 GB. */
export const LEAVES_MIN_FREE_BYTES = 5 * 1024 ** 3;
const FAILED_JOB_STATES = new Set(['failed', 'rolled_back', 'manual_recovery_required', 'cancelled', 'superseded', 'expired']);
const WAITING_ACTIVATION = new Set(['waiting_sessions', 'waiting_terminals', 'waiting_scheduled']);
const ACTIVATION_STATES = new Set(['restart_queued', 'activating', 'runtime_verifying', 'rollback_pending']);

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal JSON HTTP client against the sandbox node (bounded size and time). */
export function httpClient(base, fetchImpl = fetch) {
    const request = async (route, { method = 'GET', token, body, headers = {} } = {}) => {
        const response = await fetchImpl(`${base}${route}`, {
            method, redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        if (text.length > BODY_LIMIT) throw new LeavesError('candidate_leaves_response_oversize', route);
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: response.status, json };
    };
    return { request };
}

/** Poll /health until `accept(health)` holds or the deadline passes. */
export async function waitForHealth({ http, accept, deadlineMs, sleep = realSleep, now = Date.now }) {
    const started = now();
    let last = null;
    while (now() - started < deadlineMs) {
        try {
            const reply = await http.request('/health');
            last = reply.json;
            if (reply.status === 200 && last && accept(last)) return last;
        } catch { /* not listening yet */ }
        await sleep(500);
    }
    return null;
}

/** Log in as the throwaway owner and return a bearer token. */
async function login(http, owner) {
    const reply = await http.request('/api/auth/login', { method: 'POST', body: owner });
    if (reply.status !== 200 || typeof reply.json?.token !== 'string') {
        throw new LeavesError('candidate_leaves_login_failed', `HTTP ${reply.status}`);
    }
    return reply.json.token;
}

/** Discover the target exactly as the button does; it must be the synthetic next release. */
async function discoverTarget(http, token, next) {
    const reply = await http.request('/api/system/release/latest', { token });
    const version = reply.json?.version;
    if (reply.status !== 200 || version !== next.version) {
        throw new LeavesError('candidate_leaves_discovery_mismatch',
            `HTTP ${reply.status} code=${reply.json?.code ?? 'none'} version=${version ?? 'none'}`);
    }
    return version;
}

/** Press the button: the request the update modal's consent panel sends. */
async function startButtonUpdate(http, token, version) {
    const reply = await http.request('/api/system/update/jobs', { method: 'POST', token,
        headers: { 'idempotency-key': randomUUID() },
        body: { expectedVersion: version, activateWhenIdle: true, deferUntilIdle: true, consent: { version } } });
    if (reply.status !== 202 || typeof reply.json?.jobId !== 'string') {
        throw new LeavesError(reply.json?.code ? `candidate_leaves_${reply.json.code}`.slice(0, 64)
            : 'candidate_leaves_update_refused', `HTTP ${reply.status}`);
    }
    return reply.json.jobId;
}

const fail = (code, detail, extra = {}) => ({ ok: false, code, detail: detail ? String(detail).slice(0, 600) : null, ...extra });

/** One timeline entry: what changed, and when (s since the button press). */
function describe(job) {
    const activation = job.autoActivation;
    return [job.state, job.errorCode, activation?.state, activation?.code].filter(Boolean).join(':');
}

/** Classify one job snapshot; null while it is still progressing. */
function classifyJob(job, clock, limits) {
    if (job.state === 'activated') return { ok: true };
    if (FAILED_JOB_STATES.has(job.state)) {
        return fail(job.errorCode || `candidate_leaves_job_${job.state}`, `${job.failedPhase ?? ''} ${job.message ?? ''}`.trim());
    }
    const activation = job.autoActivation;
    if (activation?.terminal === true || activation?.state === 'expired') {
        return fail(activation.code || 'candidate_leaves_activation_refused', activation.reason ?? activation.state);
    }
    const busy = job.state === 'awaiting_sessions' || WAITING_ACTIVATION.has(activation?.state);
    clock.busySince = busy ? (clock.busySince ?? clock.now) : null;
    if (busy && clock.now - clock.busySince > limits.idleWaitMs) {
        return fail('candidate_leaves_node_busy', `${job.state} ${activation?.state ?? ''}:${activation?.code ?? ''}`);
    }
    clock.activationSince = ACTIVATION_STATES.has(job.state) && !busy ? (clock.activationSince ?? clock.now) : null;
    if (clock.activationSince !== null && clock.now - clock.activationSince > limits.activationMs) {
        return fail('candidate_leaves_activation_stalled', describe(job));
    }
    return null;
}

/**
 * Follow the job until it settles. `observe()` returns `{ job }` or
 * `{ unreachable: true }` (the node restarting). Pure apart from the injected
 * clock, so the classification is testable without a server.
 * @returns {Promise<{ok:boolean, code?:string, detail?:string|null, timeline:object[]}>}
 */
export async function followUpdateJob({ observe, limits = LEAVES_LIMITS, sleep = realSleep, now = Date.now }) {
    const started = now();
    const clock = { now: started, busySince: null, activationSince: null, unreachableSince: null };
    const timeline = [];
    let last = null;
    for (;;) {
        const snapshot = await observe();
        clock.now = now();
        const at = Math.round((clock.now - started) / 1000);
        let verdict = null;
        if (snapshot?.job) {
            clock.unreachableSince = null;
            const line = describe(snapshot.job);
            if (line !== last) { timeline.push({ at, state: line }); last = line; }
            verdict = classifyJob(snapshot.job, clock, limits);
        } else {
            if (last !== 'unreachable') { timeline.push({ at, state: 'unreachable' }); last = 'unreachable'; }
            clock.unreachableSince ??= clock.now;
            if (clock.now - clock.unreachableSince > limits.bootMs) verdict = fail('candidate_leaves_boot_failed', 'node unreachable');
        }
        if (!verdict && clock.now - started > limits.totalMs) verdict = fail('candidate_leaves_timeout', last);
        if (verdict) return { ...verdict, timeline };
        await sleep(limits.pollMs);
    }
}

/** The observer of one job: re-login once on 401 (the token outlives the restart by design). */
function jobObserver(http, jobId, session) {
    return async () => {
        try {
            let reply = await http.request(`/api/system/update/jobs/${encodeURIComponent(jobId)}`, { token: session.token });
            if (reply.status === 401) {
                session.token = await login(http, session.owner);
                reply = await http.request(`/api/system/update/jobs/${encodeURIComponent(jobId)}`, { token: session.token });
            }
            return reply.status === 200 && reply.json?.state ? { job: reply.json } : { unreachable: true };
        } catch {
            return { unreachable: true };
        }
    };
}

/**
 * The command board's view of the safe-restart rows (GET /api/system/pending),
 * as `status:reasonCode` words: names WHY an activation stalled or failed.
 */
async function commandBoardEvidence(http, session) {
    try {
        const reply = await http.request('/api/system/pending', { token: session.token });
        if (reply.status !== 200) return `board HTTP ${reply.status}`;
        const words = [
            ...(reply.json?.actions ?? []).map((row) => `${row.status}:${row.reasonCode ?? ''}`),
            ...(reply.json?.history ?? []).slice(0, 3).map((row) => `${row.outcome}:${row.reasonCode ?? ''}`),
        ].filter((word, index) => index < 6);
        return words.length ? `board ${words.join(' ')}` : 'board empty';
    } catch {
        return 'board unreachable';
    }
}

/** After `activated`: the next release must serve, from a new process pm2 restarted. */
export function verifyLeft({ health, app, next, fromPid }) {
    const problems = [];
    if (health?.status !== 'ok') problems.push(`status=${health?.status}`);
    if (health?.sourceVersion !== next.version) problems.push(`sourceVersion=${health?.sourceVersion}`);
    if ('runtimeVersion' in (health ?? {}) && health.runtimeVersion !== next.version) {
        problems.push(`runtimeVersion=${health.runtimeVersion}`);
    }
    if (health?.serverLoadedOid !== next.commit) problems.push(`serverLoadedOid=${health?.serverLoadedOid}`);
    if (!Number.isInteger(health?.pid) || health.pid === fromPid) problems.push('pid unchanged');
    if (app?.status !== 'online' || app.pid !== health?.pid || !(app.restarts >= 1)) {
        problems.push(`pm2=${app?.status}/${app?.pid}/${app?.restarts}`);
    }
    return problems;
}

/** Boot the installed candidate and confirm it serves its own identity. */
async function bootCandidate({ layout, env, ecosystem, http, ctx }) {
    startNode(layout, env, ecosystem);
    const health = await waitForHealth({ http, deadlineMs: LEAVES_LIMITS.bootMs,
        accept: (body) => body.status === 'ok' && body.sourceVersion === ctx.candidateVersion });
    if (!health) throw new LeavesError('candidate_leaves_candidate_boot_failed', 'no healthy /health from the candidate');
    if ('serverLoadedOid' in health && health.serverLoadedOid !== ctx.candidateCommit) {
        throw new LeavesError('candidate_leaves_candidate_identity_mismatch', `serverLoadedOid=${health.serverLoadedOid}`);
    }
    return health;
}

/** Drive the button path and verify the node left the candidate. */
async function driveUpdate({ http, owner, ctx, layout, env, processName, fromPid, timings }) {
    const session = { owner, token: await login(http, owner) };
    const version = await discoverTarget(http, session.token, ctx.next);
    const pressed = Date.now();
    const jobId = await startButtonUpdate(http, session.token, version);
    const followed = await followUpdateJob({ observe: jobObserver(http, jobId, session),
        limits: ctx.leavesLimits ?? LEAVES_LIMITS });
    timings.updateMs = Date.now() - pressed;
    if (!followed.ok) {
        const evidence = await commandBoardEvidence(http, session);
        return { ...followed, jobId, detail: [followed.detail, evidence].filter(Boolean).join('; ') };
    }
    const health = await waitForHealth({ http, deadlineMs: 30_000,
        accept: (body) => body.status === 'ok' && body.sourceVersion === ctx.next.version });
    const app = pm2App(layout, env, processName);
    const problems = verifyLeft({ health, app, next: ctx.next, fromPid });
    if (problems.length) return fail('candidate_leaves_not_serving_next', problems.join('; '), { jobId, timeline: followed.timeline });
    return { ok: true, jobId, timeline: followed.timeline, toPid: health.pid, pm2Restarts: app.restarts };
}

/** Refuse to start when the sandbox file system cannot hold the leg (fails, never skips). */
export function assertLeavesDiskSpace(directory, minimum = LEAVES_MIN_FREE_BYTES, statfs = statfsSync) {
    const stat = statfs(directory);
    const free = Number(stat.bavail) * Number(stat.bsize);
    if (free < minimum) {
        throw new LeavesError('candidate_leaves_insufficient_disk',
            `${Math.floor(free / 1024 ** 2)} MiB free, ${Math.floor(minimum / 1024 ** 2)} MiB required`);
    }
}

/** Resolve the real npm and pm2 the shims delegate to; a host without pm2 cannot run the leg. */
function hostTools(sandbox) {
    const npmPath = resolveExecutable('npm', { sandbox });
    const pm2Path = resolveExecutable('pm2', { sandbox });
    if (!npmPath) throw new LeavesError('candidate_leaves_npm_unavailable');
    if (!pm2Path) throw new LeavesError('candidate_leaves_pm2_unavailable');
    return { npmPath, pm2Path };
}

/**
 * Run the leg. `ctx`: sandbox, bare, cloneNode, candidateRoot, candidateCommit,
 * candidateVersion, next {version, commit}, releaseSource; optional
 * leavesLimits and pickPort. Never throws: every failure is a leg result.
 * @returns {Promise<object>} {ok, code?, detail?, timeline?, timings, ...}
 */
export async function runCandidateLeavesLeg(ctx) {
    const started = Date.now();
    const timings = {};
    let layout = null;
    let env = null;
    let uninstallGuard = null;
    let result;
    try {
        assertLeavesDiskSpace(ctx.sandbox);
        layout = leavesLayout(ctx.sandbox);
        uninstallGuard = installLeavesSignalGuard(layout, () => env);
        process.stderr.write(`[candidate-leaves] if this gate is killed, stop its sandbox with: ${recoveryCommand(layout)}\n`);
        writeLeavesShims(layout, { candidateRoot: ctx.candidateRoot, ...hostTools(ctx.sandbox) });
        const port = await sandboxPort(ctx.pickPort || freePort);
        const owner = throwawayOwner();
        const prepared = prepareLeavesNode(layout, { ...ctx, port });
        timings.prepareMs = Date.now() - started;
        env = leavesEnvironment(layout, { owner, port });
        const http = httpClient(`http://127.0.0.1:${port}`);
        const health = await bootCandidate({ layout, env, ecosystem: prepared.ecosystem, http, ctx });
        assertSandboxRestartEnvironment(health.pid, port);
        result = { ...await driveUpdate({ http, owner, ctx, layout, env,
            processName: prepared.processName, fromPid: health.pid, timings }), fromPid: health.pid };
        if (result.ok) assertRestartLogSandboxed(layout);
    } catch (error) {
        result = fail(error instanceof LeavesError ? error.code : 'candidate_leaves_error',
            error instanceof LeavesError ? error.detail : error?.message);
    }
    if (layout) {
        writeFileSync(path.join(layout.logs, 'pm2-tail.log'), pm2LogTail(layout, 20_000), { mode: 0o600 });
        const { survivors } = stopLeavesHost(layout, env);
        if (survivors.length && result.ok) {
            result = fail('candidate_leaves_cleanup_failed', `${survivors.length} sandbox process(es) survived`);
        } else if (survivors.length) {
            result = { ...result, cleanupSurvivors: survivors.length };
        }
    }
    uninstallGuard?.();
    timings.totalMs = Date.now() - started;
    return { ...result, from: ctx.candidateVersion, to: ctx.next?.version, timings };
}
