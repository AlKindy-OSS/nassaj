import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import express from 'express';

import {
    acquireApplicationWriterLease, applicationWriterLeaseMiddleware, installLocalUpdateRouteLeases,
    runLocalUpdateBackground, setApplicationWriterGateForTests, withLocalUpdateWriterLease,
} from './update-writer-lease.js';

const previous = { mode: process.env.NASSAJ_UPDATE_MODE, environment: process.env.NODE_ENV };
process.env.NODE_ENV = 'test';
process.env.NASSAJ_UPDATE_MODE = 'local-main';
after(() => {
    setApplicationWriterGateForTests(null);
    for (const [key, value] of [['NASSAJ_UPDATE_MODE', previous.mode], ['NODE_ENV', previous.environment]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
});

/** Model admission without touching the live repository or using timing-dependent sleeps. */
function gate() {
    const state = { acquired: 0, released: 0, closed: false, code: 'update_maintenance_active' };
    setApplicationWriterGateForTests({ async acquireWriterLease() {
        if (state.closed) throw new Error(state.code);
        state.acquired += 1;
        return { release() { state.released += 1; } };
    } });
    return state;
}

/** Capture `console.error` for the duration of `operation`, restoring it always. */
async function withCapturedErrors(operation) {
    const lines = [];
    const original = console.error;
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try { await operation(lines); } finally { console.error = original; }
}

test('nested dispatch retains an admitted lease even after DRAINING, then releases it once', async () => {
    const state = gate();
    let child;
    await withLocalUpdateWriterLease('request', async () => {
        state.closed = true;
        child = await acquireApplicationWriterLease('provider-turn');
        await withLocalUpdateWriterLease('nested-operation', async () => {});
    });
    assert.equal(state.acquired, 1);
    assert.equal(state.released, 0, 'the provider still owns its retained writer');
    child.release(); child.release();
    assert.equal(state.released, 1);
    await assert.rejects(withLocalUpdateWriterLease('new-request', async () => {}), /update_maintenance_active/);
});

test('a blocked background tick performs neither its effect nor failure telemetry', async () => {
    const state = gate(); state.closed = true;
    let effects = 0;
    assert.equal(await runLocalUpdateBackground('tick', () => { effects += 1; }), null);
    assert.equal(effects, 0);
});

test('middleware shares its lease with nested routes and keeps a detached admitted writer alive', async () => {
    const state = gate();
    const response = new EventEmitter();
    let nested;
    let finish;
    const ready = new Promise(resolve => { finish = resolve; });
    await applicationWriterLeaseMiddleware('http')({}, response, async () => {
        nested = await acquireApplicationWriterLease('route');
        finish();
    });
    await ready;
    response.emit('finish'); response.emit('close');
    assert.equal(state.acquired, 1);
    assert.equal(state.released, 0);
    nested.release();
    assert.equal(state.released, 1);
});

test('operation errors release the lease and are not silently swallowed', async () => {
    const state = gate();
    await assert.rejects(runLocalUpdateBackground('tick', () => { throw new Error('database_failure'); }), /database_failure/);
    assert.equal(state.released, 1);
});

/** Run a real HTTP stack while keeping database/filesystem effects in the test fixture. */
async function withHttp(app, operation) {
    installLocalUpdateRouteLeases(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try { await operation(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('a disconnected HTTP client cannot release a suspended nested route writer', async () => {
    const state = gate();
    const app = express();
    app.use(applicationWriterLeaseMiddleware('http'));
    let resume, admitted, completed;
    const paused = new Promise(resolve => { resume = resolve; });
    const entered = new Promise(resolve => { admitted = resolve; });
    const done = new Promise(resolve => { completed = resolve; });
    const router = express.Router();
    let effects = 0;
    router.post('/write', async (_req, res) => {
        admitted(); await paused;
        assert.ok(state.acquired > state.released, 'exclusive updater must still wait');
        effects++; res.end(); completed();
    });
    app.use('/nested', router);
    await withHttp(app, async base => {
        const request = http.request(`${base}/nested/write`, { method: 'POST' });
        request.on('error', () => {}); request.end();
        await entered;
        state.closed = true;
        request.destroy();
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(state.acquired > state.released);
        assert.equal(effects, 0);
        resume(); await done;
    });
    assert.equal(state.acquired, state.released);
    assert.equal(effects, 1);
});

test('route leases preserve nested next, next route, rejection and error-handler behavior', async () => {
    const state = gate(); const app = express();
    const router = express.Router();
    router.get('/ok', (_req, _res, next) => next('route'), () => { throw new Error('wrong_route'); });
    router.get('/ok', (_req, _res, next) => next(), async (_req, res) => { await Promise.resolve(); res.json({ ok: true }); });
    router.get('/bad', async () => { throw new Error('expected'); });
    app.use('/nested', router);
    app.use(async (error, _req, res, _next) => { await Promise.resolve(); res.status(422).json({ code: error.message }); });
    await withHttp(app, async base => {
        assert.deepEqual(await (await fetch(`${base}/nested/ok`)).json(), { ok: true });
        const error = await fetch(`${base}/nested/bad`);
        assert.equal(error.status, 422); assert.deepEqual(await error.json(), { code: 'expected' });
    });
    assert.equal(state.acquired, state.released);
});

test('the exact local confirm endpoint does not acquire the writer its capsule must drain', async () => {
    const state = gate(); state.closed = true;
    const app = express(); const router = express.Router();
    router.post('/update/local/:sequence/confirm', (_req, res) => res.json({ confirmed: true }));
    app.use('/api/system', router);
    await withHttp(app, async base => {
        const result = await fetch(`${base}/api/system/update/local/1/confirm`, { method: 'POST' });
        assert.equal(result.status, 200);
        assert.equal(state.acquired, 0);
    });
});


test('health-only bootstrap remains reachable before Express initializes req.path while admission is exclusive', async () => {
    const state = gate(); state.closed = true;
    const app = express();
    let privateReady = false;
    app.get('/health', (_req, res) => res.status(privateReady ? 200 : 503).json({ privateReady, normalAdmissionReady: false }));
    await withHttp(app, async base => {
        assert.equal((await fetch(`${base}/health?probe=1`)).status, 503);
        privateReady = true;
        const response = await fetch(`${base}/health`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { privateReady: true, normalAdmissionReady: false });
        assert.equal(state.acquired, 0);
    });
});

test('N rejected HTTP requests fold into ONE log line per window, not two per request', async () => {
    const state = gate();
    const app = express();
    app.get('/poll', (_req, res) => res.json({ ok: true }));
    app.use((error, _req, res, _next) => res.status(500).json({ code: error?.message || 'unknown' }));
    const lines = [];
    const original = console.error;
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
        await withHttp(app, async base => {
            assert.equal((await fetch(`${base}/poll`)).status, 200, 'the open gate still serves');
            state.closed = true;
            lines.length = 0;
            // A maintenance window with several dashboards polling: every one of
            // these is refused by the gate.
            for (let index = 0; index < 20; index += 1) {
                await fetch(`${base}/poll`).catch(() => {});
            }
        });
        // Before the throttle this was >= 2 lines PER request (the handler layer
        // logged, then next(error) reached the wrapped error handler which took
        // its own lease, was denied, and logged again).
        assert.equal(lines.length, 1, `20 refused requests produced ${lines.length} lines: ${lines.join(' | ')}`);
        assert.match(lines[0], /^\[ERROR\] HTTP handler denied by update gate \(update_maintenance_active\)$/);
    } finally {
        console.error = original;
    }
});

test('the throttled line reports what it folded, and a later window logs again', async () => {
    const state = gate();
    state.closed = true;
    const lines = [];
    const original = console.error;
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
        const response = () => ({ status() { return this; }, json() { return this; },
            once() {}, headersSent: false });
        const middleware = applicationWriterLeaseMiddleware('http');
        for (let index = 0; index < 5; index += 1) await middleware({}, response(), () => {});
        assert.equal(lines.length, 1, 'five denials, one line');

        // A NEW window (modelled by the fixture reset, which clears the window
        // state) logs again and carries no stale suppression count.
        const next = gate();
        next.closed = true;
        await middleware({}, response(), () => {});
        assert.equal(lines.length, 2, 'the next window is announced');
        assert.match(lines[1], /HTTP writer lease \(kind http\) denied by update gate/);
    } finally {
        console.error = original;
    }
});

test('an ordinary route failure is never attributed to the update gate, nor marked by it', async () => {
    const state = gate();
    const app = express();
    let seen;
    app.get('/boom', async () => { await Promise.resolve(); throw new Error('database_failure'); });
    app.use((error, _req, res, _next) => { seen = error; res.status(500).json({ code: error?.message }); });
    await withCapturedErrors(async (lines) => {
        await withHttp(app, async (base) => {
            const response = await fetch(`${base}/boom`);
            assert.equal(response.status, 500);
            assert.deepEqual(await response.json(), { code: 'database_failure' });
        });
        assert.deepEqual(lines, [], `an application error logged a gate denial: ${lines.join(' | ')}`);
    });
    // Reaches the error layer AS ITSELF: same message, and carrying none of the
    // wrapper's own bookkeeping (the "already announced" stamp is the only
    // symbol this module ever sets on a rejection).
    assert.equal(seen?.message, 'database_failure');
    assert.deepEqual(Object.getOwnPropertySymbols(seen), [],
        'the wrapper stamped an unrelated error, which suppresses its real logging downstream');
    assert.equal(state.acquired, state.released);
});

test('an application failure does not consume the window a real denial needs', async () => {
    const state = gate();
    const app = express();
    app.get('/boom', () => { throw new Error('database_failure'); });
    app.get('/poll', (_req, res) => res.json({ ok: true }));
    app.use((error, _req, res, _next) => res.status(500).json({ code: error?.message }));
    await withCapturedErrors(async (lines) => {
        await withHttp(app, async (base) => {
            assert.equal((await fetch(`${base}/boom`)).status, 500);
            assert.deepEqual(lines, [], 'the application error must not open a throttle window');
            state.closed = true;
            await fetch(`${base}/poll`).catch(() => {});
        });
        assert.equal(lines.length, 1, `the real denial was swallowed by a burnt window: ${lines.join(' | ')}`);
        assert.match(lines[0], /^\[ERROR\] HTTP handler denied by update gate \(update_maintenance_active\)$/);
    });
});

test('an error handler that throws reaches the next error layer instead of a fabricated 503', async () => {
    const state = gate();
    const app = express();
    app.get('/boom', () => { throw new Error('first'); });
    app.use(async (_error, _req, _res, _next) => { await Promise.resolve(); throw new Error('second'); });
    app.use((error, _req, res, _next) => res.status(422).json({ code: error?.message }));
    await withCapturedErrors(async (lines) => {
        await withHttp(app, async (base) => {
            const response = await fetch(`${base}/boom`);
            assert.equal(response.status, 422, 'a throwing error handler was answered with the gate 503');
            assert.deepEqual(await response.json(), { code: 'second' });
        });
        assert.deepEqual(lines, [], `an error-handler failure logged a gate denial: ${lines.join(' | ')}`);
    });
    assert.equal(state.acquired, state.released);
});

test('a background tick defers a contended lock but surfaces a control-plane fault', async () => {
    const state = gate();
    state.closed = true;
    // What a REAL concurrent update raises. The private list this replaced
    // waited on `update_lock_timeout` — never raised — and threw here instead.
    state.code = 'update_lock_contended';
    let effects = 0;
    assert.equal(await runLocalUpdateBackground('tick', () => { effects += 1; }), null);
    assert.equal(effects, 0);

    // A fault never heals by waiting; swallowing it makes the tick silently dead.
    for (const fault of ['update_journal_invalid', 'update_ownership_token_unsafe',
        'update_lock_unavailable', 'update_writer_kind_invalid']) {
        state.code = fault;
        await assert.rejects(runLocalUpdateBackground('tick', () => { effects += 1; }),
            (error) => error.message === fault, `${fault} must reach the caller unchanged`);
    }
    assert.equal(effects, 0);
});

test('a non-gate acquisition failure is refused as itself, not as update maintenance', async () => {
    const state = gate();
    state.closed = true;
    // Not a member of UPDATE_GATE_REASON_CODES: the gate never declares it, so
    // reporting it as maintenance invents a cause in both the log and the body.
    state.code = 'artifact_maintenance_current_mismatch';
    await withCapturedErrors(async (lines) => {
        const sent = [];
        const response = { status(code) { sent.push(code); return this; }, json(body) { sent.push(body); return this; },
            once() {}, headersSent: false };
        let forwarded = 'not-called';
        await applicationWriterLeaseMiddleware('http')({}, response, (error) => { forwarded = error; });
        assert.equal(forwarded?.message, 'artifact_maintenance_current_mismatch',
            'the real failure must reach the error handler');
        assert.deepEqual(sent, [], 'a non-gate failure must not be answered with the maintenance 409');
        assert.deepEqual(Object.getOwnPropertySymbols(forwarded), [],
            'the middleware stamped an unrelated error, suppressing its real logging downstream');
        assert.deepEqual(lines, [], `a non-gate failure logged a gate denial: ${lines.join(' | ')}`);

        // The genuine refusal is unchanged: 409, the gate code, one line.
        state.code = 'update_lock_contended';
        const denied = [];
        const deniedResponse = { status(code) { denied.push(code); return this; }, json(body) { denied.push(body); return this; },
            once() {}, headersSent: false };
        let alsoForwarded = false;
        await applicationWriterLeaseMiddleware('http')({}, deniedResponse, () => { alsoForwarded = true; });
        assert.equal(alsoForwarded, false, 'a gate denial is answered here, not forwarded');
        assert.deepEqual(denied, [409, { success: false, code: 'update_lock_contended',
            error: 'Source update maintenance is active' }]);
        assert.equal(lines.length, 1, `expected one denial line, got: ${lines.join(' | ')}`);
        assert.match(lines[0], /^\[ERROR\] HTTP writer lease \(kind http\) denied by update gate \(update_lock_contended\)$/);
    });
});
