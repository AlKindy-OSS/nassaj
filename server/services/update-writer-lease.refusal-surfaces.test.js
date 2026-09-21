/**
 * update-writer-lease.refusal-surfaces.test.js — B-1253 (M-1, M-2).
 *
 * WHY THIS EXISTS. `readUpdateGateCode` deliberately COLLAPSES anything it does
 * not recognise to `update_maintenance_active`, so it can never leak an error
 * message or break a refusal path. Five surfaces called it with no prior
 * classification — the /api/terminals 409, the shell PTY acquisition, and the
 * shell/terminal/chat frame catches. Each of those catches wraps an arbitrary
 * operation, so an ordinary failure (a TypeError, an `artifact_*` code outside
 * the gate's vocabulary) came out as "Source update maintenance is active" in
 * the response AND "denied by update gate" in the log, while no update was
 * running anywhere. A fabricated root cause is worse than no cause: it is
 * credible, and it sends the operator to the update subsystem.
 *
 * The other half (M-2) is the mirror image: a REAL denial whose code the gate
 * composes at runtime (`update_reopen_${label}_unsafe`, the two generation
 * families) was classified as "not the gate" and became a generic failure with
 * nothing naming the gate at all.
 *
 * INVARIANT UNDER TEST, in both directions: the operation is REFUSED either
 * way — fail-closed is not what changes — and the reason given is TRUE.
 */

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import express from 'express';

import {
    reportWriterLeaseRefusal, setApplicationWriterGateForTests, WRITER_LEASE_UNAVAILABLE_CODE,
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

/** Capture `console.error` for the duration of `operation`, restoring it always. */
async function withCapturedErrors(operation) {
    const lines = [];
    const original = console.error;
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try { await operation(lines); } finally { console.error = original; }
}

/** Fail every admission with `rejection`, without touching the live repository. */
function gateRejecting(rejection) {
    setApplicationWriterGateForTests({ async acquireWriterLease() { throw rejection; } });
}

// A composed code the gate really raises (an activation control file that
// failed its integrity check), and a code the gate raises but never declares.
const COMPOSED_GATE_CODE = 'update_reopen_manifest_unsafe';
const UNDECLARED_CODE = 'artifact_maintenance_current_mismatch';

test('reportWriterLeaseRefusal: a literal gate code is named as the gate, once', async () => {
    await withCapturedErrors(async (lines) => {
        const refusal = reportWriterLeaseRefusal('Surface', new Error('update_lock_contended'));
        assert.deepEqual(refusal, { gateDenial: true, code: 'update_lock_contended' });
        assert.deepEqual(lines, ['[ERROR] Surface denied by update gate (update_lock_contended)']);
    });
});

test('reportWriterLeaseRefusal: a COMPOSED gate code is a denial, not an ordinary error', async () => {
    await withCapturedErrors(async (lines) => {
        const refusal = reportWriterLeaseRefusal('Surface', new Error(COMPOSED_GATE_CODE));
        assert.deepEqual(refusal, { gateDenial: true, code: COMPOSED_GATE_CODE },
            'the composed family is declared, so the real reason survives to the wire');
        assert.deepEqual(lines, [`[ERROR] Surface denied by update gate (${COMPOSED_GATE_CODE})`]);
    });
});

test('reportWriterLeaseRefusal: a TypeError is NOT attributed to the gate', async () => {
    await withCapturedErrors(async (lines) => {
        const refusal = reportWriterLeaseRefusal('Surface', new TypeError('res.status is not a function'));
        assert.equal(refusal.gateDenial, false);
        assert.equal(refusal.code, WRITER_LEASE_UNAVAILABLE_CODE,
            'the client gets a code that does NOT invite a "wait for maintenance" retry');
        assert.equal(lines.length, 1);
        assert.ok(!lines[0].includes('denied by update gate'),
            `an ordinary failure was logged as a gate denial: ${lines[0]}`);
        assert.match(lines[0], /refused \(not the update gate\)/);
    });
});

test('reportWriterLeaseRefusal: an undeclared artifact_* code is NOT attributed to the gate', async () => {
    await withCapturedErrors(async (lines) => {
        const refusal = reportWriterLeaseRefusal('Surface', new Error(UNDECLARED_CODE));
        assert.equal(refusal.gateDenial, false,
            'the gate raises it but does not declare it; announcing it as a gate denial '
            + 'publishes a code the vocabulary never vetted');
        assert.equal(refusal.code, WRITER_LEASE_UNAVAILABLE_CODE);
        assert.ok(!lines.some((line) => line.includes('denied by update gate')));
    });
});

test('reportWriterLeaseRefusal: a non-Error rejection still refuses, and leaks nothing', async () => {
    await withCapturedErrors(async () => {
        for (const rejection of [undefined, null, 'update_maintenance_active', { message: 'x' }, 42]) {
            const refusal = reportWriterLeaseRefusal('Surface', rejection);
            assert.equal(refusal.gateDenial, false, `${String(rejection)} is not a gate denial`);
            assert.equal(refusal.code, WRITER_LEASE_UNAVAILABLE_CODE);
        }
    });
});

test('reportWriterLeaseRefusal: gateAlreadyAnnounced folds the GATE line only, never a fault', async () => {
    await withCapturedErrors(async (lines) => {
        const denial = reportWriterLeaseRefusal('Surface', new Error('update_lock_contended'),
            { gateAlreadyAnnounced: true });
        assert.deepEqual(denial, { gateDenial: true, code: 'update_lock_contended' },
            'the classification is unchanged; only the duplicate log line is suppressed');
        assert.deepEqual(lines, [], 'a repeat denial on the same connection stays quiet');

        // A fault is a DISTINCT event. Folding it behind the connection's gate
        // flag would hide a real failure behind an unrelated earlier denial.
        reportWriterLeaseRefusal('Surface', new TypeError('boom'), { gateAlreadyAnnounced: true });
        assert.equal(lines.length, 1, 'an ordinary failure is always audible');
        assert.match(lines[0], /refused \(not the update gate\)/);
    });
});

// --- Call site: POST /api/terminals (server/routes/terminals.js) -------------
//
// Driven through a real express app so the route's OWN error handling decides
// the non-gate answer, exactly as it does in production. The lease is acquired
// before `createStandaloneTerminal`, so no PTY is ever spawned on either path.

/** Issue POST /api/terminals against the real router, returning {status, body}. */
async function postTerminal() {
    const { default: router } = await import('../routes/terminals.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
    app.use('/api/terminals', router);
    const server = app.listen(0);
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/terminals`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'general' }),
        });
        return { status: response.status, body: await response.json() };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('POST /api/terminals: a gate denial is a labelled 409 naming the real reason', async () => {
    gateRejecting(new Error('update_lock_contended'));
    await withCapturedErrors(async (lines) => {
        const { status, body } = await postTerminal();
        assert.equal(status, 409);
        assert.deepEqual(body, { error: 'Source update maintenance is active', code: 'update_lock_contended' });
        assert.equal(lines.filter((line) => line.includes('denied by update gate')).length, 1);
    });
});

test('POST /api/terminals: a COMPOSED gate denial is still the 409, with its own code', async () => {
    gateRejecting(new Error(COMPOSED_GATE_CODE));
    await withCapturedErrors(async () => {
        const { status, body } = await postTerminal();
        assert.equal(status, 409, 'a real gate refusal must not become a generic 500');
        assert.equal(body.code, COMPOSED_GATE_CODE);
    });
});

test('POST /api/terminals: a TypeError is refused as a 500, never as maintenance', async () => {
    gateRejecting(new TypeError('acquireWriterLease is not a function'));
    await withCapturedErrors(async (lines) => {
        const { status, body } = await postTerminal();
        // FAIL-CLOSED: still refused, no terminal created — only the reason changes.
        assert.equal(status, 500, 'an ordinary failure is a 500, not a "retry after maintenance" 409');
        assert.deepEqual(body, { error: 'Failed to create terminal', code: 'internal_error' });
        assert.ok(!lines.some((line) => line.includes('denied by update gate')),
            `an ordinary failure was logged as a gate denial: ${lines.join(' | ')}`);
        assert.ok(!JSON.stringify(body).includes('maintenance'),
            'the body must not tell the user an update is running when none is');
    });
});

test('POST /api/terminals: an undeclared artifact_* code is refused as a 500', async () => {
    gateRejecting(new Error(UNDECLARED_CODE));
    await withCapturedErrors(async (lines) => {
        const { status, body } = await postTerminal();
        assert.equal(status, 500);
        assert.equal(body.code, 'internal_error');
        assert.ok(!JSON.stringify(body).includes(UNDECLARED_CODE), 'internals never reach the wire');
        assert.ok(!lines.some((line) => line.includes('denied by update gate')));
    });
});
