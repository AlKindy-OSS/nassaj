/**
 * T-1912 — owner "update now" override of the scheduled-message hold.
 *
 * Same technique as index.security.test.js: the route lives inline in
 * server/index.js (importing it boots the server), so the test extracts the
 * real handler source and evaluates it with injected collaborators. The bytes
 * under test are the bytes that ship.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const INDEX_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.js'), 'utf8');
const ROUTE = "app.post('/api/system/update/jobs/:jobId/skip-scheduled-wait',";

/** Returns the balanced `{ ... }` block that starts at `open`. */
function balancedBlock(source, open) {
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}' && --depth === 0) return source.slice(open, index + 1);
    }
    throw new Error('unbalanced handler block');
}

function routeLine() {
    const offset = INDEX_SOURCE.indexOf(ROUTE);
    assert.ok(offset > 0, 'override route must exist in server/index.js');
    return { offset, line: INDEX_SOURCE.slice(offset, INDEX_SOURCE.indexOf('\n', offset)) };
}

function buildHandler({ job, overrideResult = true }) {
    const { offset } = routeLine();
    const arrow = INDEX_SOURCE.indexOf('(req, res) => {', offset);
    const body = balancedBlock(INDEX_SOURCE, arrow + '(req, res) => '.length);
    const calls = { overrides: [], audit: [], lookups: [] };
    const handler = new Function('sourceUpdateJobsDb', 'updateAutoActivator', 'auditLogDb',
        `return (req, res) => ${body};`)(
        { getForOwner(id, ownerId) { calls.lookups.push([id, ownerId]); return job && job.owner_id === ownerId ? job : null; } },
        { overrideScheduled(id) { calls.overrides.push(id); return overrideResult; } },
        { record(action, details) { calls.audit.push({ action, details }); } },
    );
    return { handler, calls };
}

function run(handler, req) {
    const sent = [];
    const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { sent.push({ status: this.statusCode, payload }); return this; },
    };
    handler(req, res);
    return sent[0];
}

const queued = { id: 'job-1', owner_id: 1, state: 'restart_queued', auto_activate: 1 };

test('the override route is authenticated, owner-only and rate limited', () => {
    const { line } = routeLine();
    assert.match(line, /authenticateToken, requireRole\('owner'\), sourceUpdateOverrideLimiter,/);
});

test('the owner of a queued auto-activating job overrides only the scheduled hold, audited', () => {
    const { handler, calls } = buildHandler({ job: queued });
    const reply = run(handler, { params: { jobId: 'job-1' }, user: { id: 1 } });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.payload, { jobId: 'job-1', state: 'restart_queued', scheduledOverride: true });
    assert.deepEqual(calls.overrides, ['job-1']);
    assert.deepEqual(calls.audit, [{ action: 'update_scheduled_override', details: { userId: 1, metadata: { jobId: 'job-1' } } }]);
});

test('another owner, a missing identity, or a non-queued job is refused without an override', () => {
    const cases = [
        { job: queued, user: { id: 2 }, status: 404, code: 'update_job_not_found' },
        { job: queued, user: {}, status: 403, code: 'owner_identity_unavailable' },
        { job: { ...queued, state: 'downloading' }, user: { id: 1 }, status: 409, code: 'update_not_overridable' },
        { job: { ...queued, auto_activate: 0 }, user: { id: 1 }, status: 409, code: 'update_not_overridable' },
    ];
    for (const { job, user, status, code } of cases) {
        const { handler, calls } = buildHandler({ job });
        const reply = run(handler, { params: { jobId: 'job-1' }, user });
        assert.equal(reply.status, status, code);
        assert.equal(reply.payload.code, code);
        assert.deepEqual(calls.overrides, []);
        assert.deepEqual(calls.audit, []);
    }
});

test('an unavailable activator refuses instead of pretending to override', () => {
    const { handler, calls } = buildHandler({ job: queued, overrideResult: false });
    const reply = run(handler, { params: { jobId: 'job-1' }, user: { id: 1 } });
    assert.equal(reply.status, 409);
    assert.equal(reply.payload.code, 'update_not_overridable');
    assert.deepEqual(calls.audit, []);
});

/** Evaluates the shipped `readScheduledDueSoon` declaration with injected inputs. */
function scheduledReaderFor({ localActivationMode, scheduledUpdateWindowMs }) {
    const start = INDEX_SOURCE.indexOf('const readScheduledDueSoon =');
    assert.ok(start > 0, 'readScheduledDueSoon must be declared in server/index.js');
    const declaration = INDEX_SOURCE.slice(start, INDEX_SOURCE.indexOf(';', start) + 1);
    const windows = [];
    const reader = new Function('localActivationMode', 'scheduledUpdateWindowMs', 'scheduledMessagesService',
        `${declaration} return readScheduledDueSoon;`)(localActivationMode, scheduledUpdateWindowMs,
        { upcomingDue(windowMs) { windows.push(windowMs); return { count: 1, earliestAt: null }; } });
    return { reader, windows };
}

test('the scheduled hold reader is wired only outside local-main and with a non-zero window', () => {
    const wired = scheduledReaderFor({ localActivationMode: false, scheduledUpdateWindowMs: 600_000 });
    assert.equal(typeof wired.reader, 'function');
    wired.reader();
    assert.deepEqual(wired.windows, [600_000]);
    assert.equal(scheduledReaderFor({ localActivationMode: false, scheduledUpdateWindowMs: 0 }).reader, null);
    assert.equal(scheduledReaderFor({ localActivationMode: true, scheduledUpdateWindowMs: 600_000 }).reader, null,
        'local-main has no hold status or override surface, so it must not hold');
    assert.match(INDEX_SOURCE, /\n {4}scheduledDueSoon: readScheduledDueSoon,\n/,
        'the activator receives exactly this reader');
});

test('the job snapshot derives scheduledDueSoon from the activator status, not a reader', () => {
    assert.match(INDEX_SOURCE, /scheduledDueSoon: deriveUpdateJobScheduledDueSoon\(job, autoActivation\),/);
    assert.match(INDEX_SOURCE, /const autoActivation = updateAutoActivator\?\.statusFor\(job\.id\) \?\? null;/);
});
