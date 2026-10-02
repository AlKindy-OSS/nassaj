/**
 * B-1448 slice 2 — POST /api/system/update/jobs/:jobId/close-terminals.
 *
 * The REAL route stack (requireRole('owner') + handler) against the REAL
 * open-terminal counter in update-writer-lease.js (a test gate stands in for
 * flock). Closing is modelled by releasing the tracked leases, which is what the
 * two registries do; their own close paths are tested beside them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'update-close-terminals-test-secret-0123456789abcdef';
const tmpDir = await mkdtemp(path.join(tmpdir(), 'close-terminals-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { closeConnection } = await import('@/modules/database/connection.js');
const writerLease = await import('../../services/update-writer-lease.js');
const { createCloseTerminalsHandler } = await import('../update-close-terminals.js');
const { requireRole } = await import('../../middleware/auth.js');
await initializeDatabase();

type User = { id: number; role: string; username: string };
const OWNER: User = { id: 1, role: 'owner', username: 'owner' };
let currentUser: User = OWNER;

const leases: { release(): void }[] = [];
const activations: string[] = [];
const audits: { action: string; details: any }[] = [];
let closeCalls = 0;
let refusal: string | null = null;
let localMain = false;
const jobs = new Map<string, any>([
    ['job-1', { id: 'job-1', owner_id: 1, state: 'restart_queued', auto_activate: 1 }],
    ['job-idle', { id: 'job-idle', owner_id: 1, state: 'activated', auto_activate: 1 }],
]);

writerLease.setApplicationWriterGateForTests({ async acquireWriterLease() { return { release() {} }; } });

const app = express();
app.use(express.json());
app.post('/api/system/update/jobs/:jobId/close-terminals', (req, _res, next) => {
    (req as any).user = currentUser;
    next();
}, requireRole('owner'), createCloseTerminalsHandler({
    getJobForOwner: (jobId: string, ownerId: number) => {
        const job = jobs.get(jobId);
        return job && job.owner_id === ownerId ? job : null;
    },
    summarizeOpenTerminals: () => writerLease.summarizeOpenTerminals(),
    closeAllTerminals: () => {
        closeCalls += 1;
        const count = leases.length;
        for (const lease of leases.splice(0)) lease.release();
        return count;
    },
    activateNow: (jobId: string) => { activations.push(jobId); return true; },
    closeTerminalsRefusal: () => refusal,
    isLocalMain: () => localMain,
    audit: (action: string, details: unknown) => { audits.push({ action, details }); },
}));
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
    server.close();
    writerLease.setApplicationWriterGateForTests(null);
    closeConnection();
    await rm(tmpDir, { recursive: true, force: true });
});

async function post(jobId: string, body: unknown, user: User = OWNER) {
    currentUser = user;
    const res = await fetch(`${base}/api/system/update/jobs/${jobId}/close-terminals`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

async function openTerminal(kind: string, username: string) {
    leases.push(await writerLease.acquireApplicationWriterLease(kind, { holder: { username } }));
}

function reset() {
    for (const lease of leases.splice(0)) lease.release();
    activations.length = 0;
    audits.length = 0;
    closeCalls = 0;
    refusal = null;
    localMain = false;
}

test('non-owners are refused before anything is read or closed', async () => {
    reset();
    await openTerminal('standalone-pty', 'sara');
    const snapshot = writerLease.summarizeOpenTerminals().snapshot;
    for (const role of ['admin', 'user']) {
        const reply = await post('job-1', { expectedSnapshot: snapshot }, { id: 1, role, username: 'x' });
        assert.equal(reply.status, 403);
    }
    assert.equal(closeCalls, 0);
    assert.equal(writerLease.summarizeOpenTerminals().count, 1);
    assert.deepEqual(activations, []);
});

test('a changed terminal set is 409 terminals_changed with the fresh set, and nothing is closed', async () => {
    reset();
    await openTerminal('standalone-pty', 'sara');
    const seen = writerLease.summarizeOpenTerminals().snapshot;
    await openTerminal('managed-pty', 'omar'); // opened after the owner looked
    const reply = await post('job-1', { expectedSnapshot: seen });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.code, 'terminals_changed');
    assert.equal(reply.body.openTerminals.count, 2);
    assert.deepEqual(reply.body.openTerminals.usernames, ['omar', 'sara']);
    assert.equal(closeCalls, 0);
    assert.equal(writerLease.summarizeOpenTerminals().count, 2);
    assert.deepEqual(activations, []);
});

test('a confirmed snapshot closes every terminal, the count returns to 0, and activation runs', async () => {
    reset();
    await openTerminal('standalone-pty', 'sara');
    await openTerminal('managed-pty', 'owner');
    const snapshot = writerLease.summarizeOpenTerminals().snapshot;
    const reply = await post('job-1', { expectedSnapshot: snapshot });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { jobId: 'job-1', status: 'closed', closed: 2, remaining: 0, activation: 'triggered' });
    assert.equal(writerLease.summarizeOpenTerminals().count, 0);
    assert.deepEqual(activations, ['job-1']);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'update_terminals_closed');
    assert.deepEqual(audits[0].details, {
        userId: 1, metadata: { jobId: 'job-1', count: 2, usernames: ['owner', 'sara'], remaining: 0 },
    });
});

test('a double-click is harmless: the second request closes nothing and still succeeds', async () => {
    reset();
    await openTerminal('standalone-pty', 'sara');
    const snapshot = writerLease.summarizeOpenTerminals().snapshot;
    const [first, second] = [await post('job-1', { expectedSnapshot: snapshot }), await post('job-1', { expectedSnapshot: snapshot })];
    assert.equal(first.status, 200);
    assert.equal(first.body.closed, 1);
    assert.equal(second.status, 200);
    assert.equal(second.body.closed, 0);
    assert.equal(closeCalls, 1, 'the closer ran once');
    assert.deepEqual(activations, ['job-1', 'job-1']);
});

test('input and job state are validated', async () => {
    reset();
    assert.equal((await post('job-1', {})).body.code, 'terminal_snapshot_invalid');
    assert.equal((await post('job-1', { expectedSnapshot: 'not-hex' })).status, 400);
    const snapshot = writerLease.summarizeOpenTerminals().snapshot;
    assert.equal((await post('missing', { expectedSnapshot: snapshot })).status, 404);
    const idle = await post('job-idle', { expectedSnapshot: snapshot });
    assert.deepEqual([idle.status, idle.body.code], [409, 'update_not_overridable']);
    assert.deepEqual(activations, []);
});

for (const reason of ['activator_failed', 'sessions_active', 'scheduled_wait', 'not_waiting_terminals']) {
    test(`M1: ${reason} refuses with 409 update_not_overridable and closes nothing`, async () => {
        reset();
        await openTerminal('standalone-pty', 'sara');
        refusal = reason;
        const reply = await post('job-1', { expectedSnapshot: writerLease.summarizeOpenTerminals().snapshot });
        assert.deepEqual([reply.status, reply.body.code, reply.body.reason], [409, 'update_not_overridable', reason]);
        assert.equal(closeCalls, 0);
        assert.equal(writerLease.summarizeOpenTerminals().count, 1);
        assert.deepEqual(activations, []);
        assert.equal(audits.length, 0);
    });
}

test('M3: a local-main host refuses with reason local_main before reading anything', async () => {
    reset();
    await openTerminal('standalone-pty', 'sara');
    localMain = true;
    const reply = await post('job-1', { expectedSnapshot: writerLease.summarizeOpenTerminals().snapshot });
    assert.deepEqual([reply.status, reply.body.code, reply.body.reason], [409, 'update_not_overridable', 'local_main']);
    assert.equal(closeCalls, 0);
});

test('a job that is no longer queued is refused as not_waiting_terminals', async () => {
    reset();
    const reply = await post('job-idle', { expectedSnapshot: 'a'.repeat(32) });
    assert.deepEqual([reply.status, reply.body.reason], [409, 'not_waiting_terminals']);
});

test('M4: index.js wires authenticateToken -> requireRole(owner) -> limiter -> handler', () => {
    const source = readFileSync(new URL('../../index.js', import.meta.url), 'utf8');
    const mounts = source.match(/app\.post\('\/api\/system\/update\/jobs\/:jobId\/close-terminals',[^\n]*/g) ?? [];
    assert.equal(mounts.length, 1, 'exactly one mount');
    assert.match(mounts[0], /^app\.post\('\/api\/system\/update\/jobs\/:jobId\/close-terminals', authenticateToken, requireRole\('owner'\), closeTerminalsLimiter, createCloseTerminalsHandler\(\{$/);
});
