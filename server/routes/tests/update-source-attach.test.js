/**
 * ADR-216 §6 test 10 (+ 9e) — the owner routes and the background operation.
 *
 * The REAL router and service against a real Fedora-shaped repository, the
 * real maintenance gate, and the REAL pending_server_actions table in a
 * throwaway database. A device-cookie session is simulated in front of the
 * router with the app's own `enforceCookieMutationGuard`, which authenticateToken
 * runs for every cookie mutation under /api/system.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'update-source-attach-test-secret-0123456789abcdef';
const SECRET = process.env.JWT_SECRET;
const tmpDir = await mkdtemp(path.join(tmpdir(), 'source-attach-routes-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

const { initializeDatabase } = await import('../../modules/database/init-db.js');
const { closeConnection } = await import('../../modules/database/connection.js');
const { pendingServerActionsDb, sourceUpdateJobsDb } = await import('../../modules/database/index.js');
const { buildPendingAction } = await import('../../services/server-actions.js');
const { createUpdateMaintenanceGate } = await import('../../services/update-maintenance-gate.js');
const { defaultGitCheckoutProbe } = await import('../../services/source-updater.js');
const { enforceCookieMutationGuard, mintMutationCsrfToken } = await import('../../modules/account-wallet/request-csrf.js');
const { useWalletOriginEnv } = await import('../../utils/__tests__/wallet-origin-env.js');
const {
    createServerQuiescenceReader, createSingleFlightCache, createSourceAttachRestartIssuer, createSourceAttachService,
} = await import('../../services/source-attach-operation.js');
const { SOURCE_UPDATE_ACTIVE_STATES } = await import('../../modules/database/repositories/source-update-jobs.db.js');
const { PRESTAGE_SETTINGS_KEY } = await import('../../services/update-prestage-settings.js');
const cliAttach = await import('../../../scripts/lib/doctor-release-attach.mjs');
const { createSourceAttachRouter } = await import('../update-source-attach.js');
const { createAttachGit } = await import('../../../scripts/lib/release-branch-attach.mjs');
const fixture = await import('../../../scripts/lib/release-branch-attach.test-fixture.mjs');
await initializeDatabase();

const CHILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'lib',
    'release-branch-attach.test-child.mjs');
/** A fresh build id per setup, so each test owns its restart rows. */
const newBuildId = () => crypto.randomBytes(32).toString('hex');
const OWNER = { id: 1, role: 'owner', username: 'owner' };
const MEMBER = { id: 3, role: 'user', username: 'member' };
const ATTACH_PATH = '/api/system/update/source-attach';
let currentUser = OWNER;
let current = null;

const app = express();
app.use(express.json());
app.use('/api/system', (req, res, next) => {
    req.user = currentUser;
    // A cookie session (header-flagged here): the guard authenticateToken runs.
    if (req.get('x-test-cookie') === '1') {
        req.devicePrincipal = { deviceSessionId: 'device', slotId: 'slot', generation: 1 };
        if (!enforceCookieMutationGuard(req, res, SECRET)) return undefined;
    }
    return next();
});
app.use(ATTACH_PATH, createSourceAttachRouter({ service: () => current?.service ?? null, rateLimit: { pollMax: 1000 },
    limiter: (_req, _res, next) => next(), logger: { error() {} } }));
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
const { origin, restore } = useWalletOriginEnv(port);
const base = `http://127.0.0.1:${port}${ATTACH_PATH}`;
after(async () => {
    server.close();
    restore();
    closeConnection();
    await rm(tmpDir, { recursive: true, force: true });
});

/** A Fedora-shaped node wired to a real service; `bootDetached` simulates the boot capability. */
function setup(t, { delaySeconds = 0, summarize = () => ({ count: 0 }) } = {}) {
    const root = fixture.scratch(t, 'routes');
    const remote = fixture.createRemote(root);
    const node = fixture.cloneFedora(root, remote.bare);
    const env = fixture.remoteEnv(root, remote.bare, { delaySeconds });
    const gate = createUpdateMaintenanceGate({ projectPath: node });
    const controlRoot = path.join(node, '.git', 'nassaj-source-update');
    const state = { bootDetached: true, audits: [], buildId: newBuildId() };
    const service = createSourceAttachService({
        appRoot: node, controlRoot, configuredRemoteUrl: () => fixture.GITHUB_REMOTE,
        git: createAttachGit({ appRoot: node, env }), bootBlockedDetached: () => state.bootDetached,
        probe: () => defaultGitCheckoutProbe({ appRoot: node, remote: 'origin', branch: 'main' }),
        acquireLease: (options) => gate.acquireExclusiveSourceRefLease(options),
        readQuiescence: createServerQuiescenceReader({ readGate: () => gate.readPublicStatus(),
            hasUnfinishedJobs: () => sourceUpdateJobsDb.hasUnfinished(), controlRoot }),
        queueRestart: createSourceAttachRestartIssuer({ actions: pendingServerActionsDb, buildAction: buildPendingAction,
            currentBuildId: () => state.buildId }),
        summarizeOpenTerminals: summarize, ttlMs: 0,
        audit: (action, details) => state.audits.push({ action, details }),
        logger: { info() {}, warn() {}, error() {} },
    });
    current = { service, node, remote, env, gate, state };
    t.after(() => { current = null; });
    return current;
}

async function call(method, suffix = '', { body, user = OWNER, headers = {} } = {}) {
    currentUser = user;
    const response = await fetch(`${base}${suffix}`, {
        method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
}

async function poll(operationId, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const { body } = await call('GET', `/operations/${operationId}`);
        if (body.state !== 'running') return body;
        if (Date.now() > deadline) throw new Error('operation did not finish');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

const safeRestartRows = () => pendingServerActionsDb.listActionable().filter((row) => row.actionType === 'safe-restart');

test('non-owners are refused on every route', async (t) => {
    setup(t);
    assert.equal((await call('GET', '', { user: MEMBER })).status, 403);
    assert.equal((await call('POST', '', { user: MEMBER, body: { expectedHead: 'a'.repeat(40) } })).status, 403);
    assert.equal((await call('GET', '/operations/00000000-0000-0000-0000-000000000000', { user: MEMBER })).status, 403);
});

test('a cookie-session POST without Origin, with a foreign Origin, or without the CSRF token is rejected', async (t) => {
    const ctx = setup(t);
    const { body: details } = await call('GET');
    const body = { expectedHead: details.headCommit };
    const csrf = mintMutationCsrfToken(SECRET, 'device:device:slot:1', 'POST', ATTACH_PATH).csrfToken;
    for (const headers of [{ 'x-test-cookie': '1', 'x-csrf-token': csrf }, { 'x-test-cookie': '1', Origin: 'https://evil.invalid', 'x-csrf-token': csrf },
        { 'x-test-cookie': '1', Origin: origin }]) {
        const response = await call('POST', '', { body, headers });
        assert.equal(response.status, 403, JSON.stringify(headers));
        assert.equal(response.body.code, 'csrf_or_origin_rejected');
    }
    assert.equal(fixture.tryGit(ctx.node, ['symbolic-ref', '-q', 'HEAD']).ok, false, 'nothing ran');
    const accepted = await call('POST', '', { body, headers: { 'x-test-cookie': '1', Origin: origin, 'x-csrf-token': csrf } });
    assert.equal(accepted.status, 202);
    assert.equal((await poll(accepted.body.operationId)).state, 'succeeded');
});

test('the full flow: details, 202 within 1 s on a slow fetch, 409 on a second click, success, one restart row, flags', async (t) => {
    const ctx = setup(t, { delaySeconds: 2 });
    const details = (await call('GET')).body;
    assert.equal(details.eligible, true, details.reason);
    assert.equal(details.tag, fixture.TAG);
    assert.equal(details.shallow, true);
    assert.equal(details.remoteIdentity, 'github.com/test/repo');
    assert.equal(details.restartPending, false);
    assert.deepEqual(await ctx.service.healthFlags(), { sourceAttachOffered: true, restartPending: false });

    assert.equal((await call('POST', '', { body: { expectedHead: 'a'.repeat(40) } })).body.code, 'source_changed');
    assert.equal((await call('POST', '', { body: { expectedHead: 'nothex' } })).status, 400);
    const before = safeRestartRows().length;
    const started = Date.now();
    const accepted = await call('POST', '', { body: { expectedHead: details.headCommit } });
    assert.equal(accepted.status, 202);
    assert.ok(Date.now() - started < 1000, `POST took ${Date.now() - started} ms`);
    const second = await call('POST', '', { body: { expectedHead: details.headCommit } });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'source_attach_in_progress');
    const operation = await poll(accepted.body.operationId);
    assert.equal(operation.state, 'succeeded', operation.code);
    assert.ok(operation.restartActionId);
    const rows = safeRestartRows().filter((row) => row.requestedBy === 'system-source-attach');
    assert.equal(pendingServerActionsDb.getById(operation.restartActionId).expectedServerBuildId, ctx.state.buildId);
    assert.equal(rows.filter((row) => row.expectedServerBuildId === ctx.state.buildId).length, 1);
    assert.equal(safeRestartRows().length, before + 1);
    assert.deepEqual(ctx.state.audits.map((entry) => entry.action), ['source_attach_requested', 'source_attach_succeeded']);
    assert.doesNotMatch(JSON.stringify(ctx.state.audits), /github\.com\/|file:|\/var\/tmp/, 'no URL or path in the audit');

    // After the flip, before the restart.
    const flags = await ctx.service.healthFlags();
    assert.deepEqual(flags, { sourceAttachOffered: false, restartPending: true });
    for (const value of Object.values(flags)) assert.equal(typeof value, 'boolean');
    assert.equal((await call('GET')).body.restartPending, true);
    assert.equal((await call('POST', '', { body: { expectedHead: details.headCommit } })).body.code, 'already_attached');
    // Simulated reboot: the boot capability is now ready; both settle.
    ctx.state.bootDetached = false;
    assert.deepEqual(await ctx.service.healthFlags(), { sourceAttachOffered: false, restartPending: false });
});

test('the restart issuer reuses an unbound queued row, never touches a job-bound one', async () => {
    const buildId = 'e'.repeat(64);
    const issue = createSourceAttachRestartIssuer({ actions: pendingServerActionsDb, buildAction: buildPendingAction, currentBuildId: () => buildId });
    const unbound = buildPendingAction({ actionType: 'safe-restart', reason: 'operator', requestedBy: 'owner', expectedServerBuildId: buildId }).value;
    assert.equal(pendingServerActionsDb.insert(unbound), 1);
    const reused = await issue({ operationId: 'op-1' });
    assert.deepEqual(reused, { queued: true, actionId: unbound.id, reused: true });
    assert.equal(pendingServerActionsDb.getById(unbound.id).status, 'pending', 'reused, not superseded');
    assert.deepEqual(await issue({ operationId: 'op-2' }), { queued: true, actionId: unbound.id, reused: true }, 'a double click queues nothing new');

    const jobBuild = 'd'.repeat(64);
    const bound = { ...buildPendingAction({ actionType: 'safe-restart', reason: 'update', requestedBy: 'system-update', expectedServerBuildId: jobBuild }).value,
        sourceUpdateJobId: 'job-1', sourceUpdateTransactionId: 'update-tx-1', activationIdentitySha256: 'c'.repeat(64), releaseCommit: 'b'.repeat(40) };
    assert.equal(pendingServerActionsDb.insert(bound), 1);
    const refused = await createSourceAttachRestartIssuer({ actions: pendingServerActionsDb, buildAction: buildPendingAction,
        currentBuildId: () => jobBuild })({ operationId: 'op-3' });
    assert.deepEqual(refused, { queued: false, code: 'restart_row_job_bound' });
    const untouched = pendingServerActionsDb.getById(bound.id);
    assert.equal(untouched.status, 'pending');
    assert.equal(untouched.sourceUpdateJobId, 'job-1');
    assert.deepEqual(await createSourceAttachRestartIssuer({ actions: pendingServerActionsDb, buildAction: buildPendingAction,
        currentBuildId: () => null })({}), { queued: false, code: 'server_build_id_unavailable' });
});

test('9e an open terminal (a shared writer in another process) refuses the operation within ~1 s with the terminal summary', async (t) => {
    const summary = { count: 1, attached: 1, detached: 0, usernames: ['owner'], detachedClosesAt: null, snapshot: 'x' };
    const ctx = setup(t, { summarize: () => summary });
    const child = spawn(process.execPath, [CHILD, 'writer-lease', ctx.node], { stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill('SIGTERM'));
    await new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
        child.once('exit', reject);
    });
    const details = (await call('GET')).body;
    const accepted = await call('POST', '', { body: { expectedHead: details.headCommit } });
    assert.equal(accepted.status, 202);
    const operation = await poll(accepted.body.operationId);
    assert.equal(operation.state, 'refused');
    assert.equal(operation.code, 'source_attach_writers_active');
    assert.ok(Date.parse(operation.finishedAt) - Date.parse(operation.startedAt) < 3000, 'refused within the 1 s lock wait (+ local proof)');
    assert.deepEqual(operation.openTerminals, summary);
    assert.equal(fixture.tryGit(ctx.node, ['symbolic-ref', '-q', 'HEAD']).ok, false, 'no write');
    assert.equal(fixture.tryGit(ctx.node, ['rev-parse', '--verify', '-q', 'refs/heads/main']).ok, false);
    assert.equal(ctx.state.audits.at(-1).action, 'source_attach_refused');
});

test('a poll after a process restart is answered from the receipt and the live probe', async (t) => {
    const first = setup(t);
    const details = (await call('GET')).body;
    const accepted = await call('POST', '', { body: { expectedHead: details.headCommit } });
    assert.equal((await poll(accepted.body.operationId)).state, 'succeeded');
    // A new service over the same tree (fresh in-memory state), as after a restart.
    const node = first.node;
    const controlRoot = path.join(node, '.git', 'nassaj-source-update');
    const restarted = createSourceAttachService({
        appRoot: node, controlRoot, configuredRemoteUrl: () => fixture.GITHUB_REMOTE,
        git: createAttachGit({ appRoot: node, env: first.env }), bootBlockedDetached: () => false,
        probe: () => defaultGitCheckoutProbe({ appRoot: node, remote: 'origin', branch: 'main' }),
        acquireLease: async () => { throw new Error('unused'); }, readQuiescence: async () => ({}),
        queueRestart: async () => ({ queued: false, code: 'unused' }), ttlMs: 0,
    });
    const answered = await restarted.operation(accepted.body.operationId);
    assert.equal(answered.state, 'succeeded');
    assert.ok(answered.restartActionId);
    assert.equal(await restarted.operation('00000000-0000-0000-0000-000000000000'), null);
    assert.ok(fs.existsSync(controlRoot));
});

test('M8 parity: the CLI unfinished-job states and settings key equal the server definitions', () => {
    assert.deepEqual([...cliAttach.UNFINISHED_JOB_STATES].sort(), [...SOURCE_UPDATE_ACTIVE_STATES].sort());
    assert.equal(cliAttach.PRESTAGE_SETTINGS_KEY, PRESTAGE_SETTINGS_KEY);
});

test('M7 single flight: concurrent readers share one in-flight read; clear() discards a stale result', async () => {
    let clock = 0;
    const cache = createSingleFlightCache(10_000, () => clock);
    let calls = 0;
    let release;
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const slow = () => { calls += 1; return new Promise((resolve) => { release = resolve; }); };
    const readers = Array.from({ length: 5 }, () => cache.get('k', slow));
    await tick();
    release('v1');
    assert.deepEqual(await Promise.all(readers), ['v1', 'v1', 'v1', 'v1', 'v1']);
    assert.equal(calls, 1);
    assert.equal(await cache.get('k', slow), 'v1', 'served from the cache');
    assert.equal(calls, 1);
    const inFlight = cache.get('k', slow, true);
    cache.clear();
    await tick();
    release('stale');
    assert.equal(await inFlight, 'stale', 'its own callers still get an answer');
    const fresh = cache.get('k', slow);
    await tick();
    release('v2');
    assert.equal(await fresh, 'v2', 'the stale value was not stored');
    clock = 20_000;
    const expired = cache.get('k', slow);
    await tick();
    release('v3');
    assert.equal(await expired, 'v3');
});

test('M7 a burst of /health reads on a detached node runs one probe and one inspection', async (t) => {
    const ctx = setup(t);
    let probes = 0;
    let inspections = 0;
    const node = ctx.node;
    const realGit = createAttachGit({ appRoot: node, env: ctx.env });
    const countingGit = (args, options) => {
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') inspections += 1;
        return realGit(args, options);
    };
    const service = createSourceAttachService({
        appRoot: node, controlRoot: path.join(node, '.git', 'nassaj-source-update'), configuredRemoteUrl: () => fixture.GITHUB_REMOTE,
        git: countingGit, bootBlockedDetached: () => true,
        probe: () => { probes += 1; return defaultGitCheckoutProbe({ appRoot: node, remote: 'origin', branch: 'main' }); },
        acquireLease: async () => { throw new Error('unused'); }, readQuiescence: async () => ({}),
        queueRestart: async () => ({ queued: false, code: 'unused' }), ttlMs: 10_000,
    });
    const flags = await Promise.all(Array.from({ length: 20 }, () => service.healthFlags()));
    assert.ok(flags.every((value) => value.sourceAttachOffered === true && value.restartPending === false));
    assert.equal(probes, 1);
    assert.equal(inspections, 1, 'one inspection (one git rev-parse --show-toplevel) for the whole burst');
});
