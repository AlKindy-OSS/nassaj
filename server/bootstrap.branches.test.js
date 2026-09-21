/**
 * T-1728 coverage: the bootstrap branches the control-flow tests left dark —
 * .env parsing, every handoff-descriptor refusal, entrypoint recognition, the
 * claimed-ownership closures, a failing application after a claim, and the
 * maintenance loop surviving an unreadable journal. Every path is real code;
 * only the gate is a double, because a real gate on this checkout would reach
 * the live repository's control root through its common git directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    bootstrapServer, isBootstrapProcessEntrypoint, loadBootstrapConfiguration, readBootstrapHandoff, serveMaintenance,
} from './bootstrap.js';

const OWNERSHIP_SYMBOL = Symbol.for('nassaj.sourceUpdate.bootstrapOwnership.v1');
const TRANSACTION = `update-${'a'.repeat(24)}`;
const EPOCH = 'b'.repeat(24);

function scratch(t) {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-bootstrap-branches-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

/** A control root holding a token and (optionally) a handoff descriptor. */
function controlRoot(t, descriptor = {}, { mode = 0o600, write = true } = {}) {
    const root = scratch(t);
    const token = path.join(root, 'token');
    fs.writeFileSync(token, 'token', { mode: 0o600 });
    const file = path.join(root, 'bootstrap-handoff.json');
    if (write) {
        fs.writeFileSync(file, JSON.stringify({
            schema: 'nassaj-source-update-bootstrap/v1', transactionId: TRANSACTION, epoch: EPOCH, tokenFilePath: token, ...descriptor,
        }), { mode });
        fs.chmodSync(file, mode);
    }
    return { controlRoot: root, token, file };
}

test('.env parsing skips comments, blanks and bare keys, keeps "=" in values, never overrides', (t) => {
    const root = scratch(t);
    fs.writeFileSync(path.join(root, '.env'), '# comment\n\nFIRST=1\nJOINED=a=b\nBARE\nKEPT=from-file\n');
    const env = { KEPT: 'from-process' };
    loadBootstrapConfiguration(root, env);
    assert.deepEqual(env, { KEPT: 'from-process', FIRST: '1', JOINED: 'a=b' });
    const empty = {};
    loadBootstrapConfiguration(scratch(t), empty);
    assert.deepEqual(empty, {}, 'no .env is not an error');
    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, '');
    assert.throws(() => loadBootstrapConfiguration(file, {}), /ENOTDIR/, 'only ENOENT is tolerated');
});

test('the handoff descriptor is refused unless it is exactly the one the gate wrote', (t) => {
    const valid = controlRoot(t);
    const gate = (fixture) => ({ paths: { controlRoot: fixture.controlRoot, token: fixture.token } });
    assert.equal(readBootstrapHandoff(gate(valid)).transactionId, TRANSACTION);
    assert.throws(() => readBootstrapHandoff(gate(controlRoot(t, {}, { write: false }))), /ENOENT/);
    assert.throws(() => readBootstrapHandoff(gate(controlRoot(t, {}, { mode: 0o640 }))), /update_bootstrap_handoff_unsafe/);
    for (const broken of [{ schema: 'other/v1' }, { transactionId: 'short' }, { epoch: 'bad epoch!' }, { tokenFilePath: '/elsewhere/token' }]) {
        assert.throws(() => readBootstrapHandoff(gate(controlRoot(t, broken))), /update_bootstrap_handoff_invalid/, JSON.stringify(broken));
    }
    const linked = controlRoot(t, {}, { write: false });
    fs.symlinkSync(valid.file, linked.file);
    assert.throws(() => readBootstrapHandoff(gate(linked)), /update_bootstrap_handoff_unsafe/);
});

test('entrypoint recognition needs the real script path or the real PM2 container', (t) => {
    const argv = process.argv[1];
    const exec = process.env.pm_exec_path;
    t.after(() => {
        process.argv[1] = argv;
        if (exec === undefined) delete process.env.pm_exec_path; else process.env.pm_exec_path = exec;
    });
    const bootstrapFile = fileURLToPath(new URL('./bootstrap.js', import.meta.url));
    process.argv[1] = bootstrapFile;
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), true);
    process.argv[1] = '/nonexistent/other.js';
    delete process.env.pm_exec_path;
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false, 'no PM2 environment');
    process.env.pm_exec_path = bootstrapFile;
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false, 'an ES module has no CommonJS main: not the PM2 container');
    process.env.pm_exec_path = '/nonexistent/pm2-target.js';
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false);
});

/** A claimable handoff gate double that records what bootstrap does with the claim. */
function claimingGate(t, calls) {
    const fixture = controlRoot(t);
    return {
        paths: { controlRoot: fixture.controlRoot, token: fixture.token },
        assertArtifactStartup: () => calls.push('assertArtifactStartup'),
        readPublicStatus: () => ({ state: 'UPDATING', gateClosed: true, phase: 'RESTARTING_HANDOFF' }),
        claimBootstrapOwnership: async (request) => {
            calls.push(['claim', request.transactionId]);
            return {
                ownershipContext: { transactionId: request.transactionId }, artifact: null,
                complete: (patch) => { calls.push(['complete', patch]); return 'completed'; },
                release: () => calls.push('release'),
            };
        },
    };
}

test('a claimed handoff publishes ownership whose complete and release reach the claim', async (t) => {
    const calls = [];
    const gate = claimingGate(t, calls);
    t.after(() => { delete globalThis[OWNERSHIP_SYMBOL]; });
    await bootstrapServer({ projectPath: scratch(t), gateModule: { createUpdateMaintenanceGate: () => gate }, loadServer: async () => ({}) });
    const ownership = globalThis[OWNERSHIP_SYMBOL];
    assert.equal(ownership.transactionId, TRANSACTION);
    assert.equal(ownership.artifact, null);
    assert.equal(ownership.complete({ proof: 1 }), 'completed');
    ownership.release();
    assert.deepEqual(calls, ['assertArtifactStartup', ['claim', TRANSACTION], ['complete', { proof: 1 }], 'release']);
});

test('an application that fails after a claim releases the claim and withdraws ownership', async (t) => {
    const calls = [];
    const gate = claimingGate(t, calls);
    await assert.rejects(bootstrapServer({
        projectPath: scratch(t), gateModule: { createUpdateMaintenanceGate: () => gate },
        loadServer: async () => { throw new Error('application_failed'); },
    }), /application_failed/);
    assert.equal(calls.at(-1), 'release');
    assert.equal(globalThis[OWNERSHIP_SYMBOL], undefined);
});

test('an unreadable descriptor goes to recovery instead of throwing (B-1125)', async (t) => {
    const events = [];
    const fixture = controlRoot(t, {}, { write: false });
    const gate = {
        paths: { controlRoot: fixture.controlRoot, token: fixture.token },
        readPublicStatus: () => ({ state: 'UPDATING', gateClosed: true, phase: 'RESTARTING_HANDOFF' }),
        claimBootstrapOwnership: async () => { events.push('claim'); },
        recoverOrDeclareManual: async () => { events.push('recover'); return { state: 'OPEN' }; },
    };
    await bootstrapServer({ projectPath: scratch(t), gateModule: { createUpdateMaintenanceGate: () => gate },
        loadServer: async () => { events.push('load'); } });
    assert.deepEqual(events, ['recover', 'load'], 'never a claim without a descriptor');
});

test('the maintenance loop survives an unreadable journal and opens on a later automatic recovery', async (t) => {
    const events = [];
    let polls = 0;
    const gate = {
        readPublicStatus: () => {
            polls += 1;
            if (polls === 1) return { state: 'UPDATING', gateClosed: true, phase: 'SOURCE_APPLIED' };
            if (polls === 2) throw new Error('update_journal_unavailable');
            return { state: 'UPDATING', gateClosed: true, phase: 'SOURCE_APPLIED' };
        },
        recoverOrDeclareManual: async () => {
            events.push('recover');
            return events.length >= 2 ? { state: 'OPEN' } : { state: 'UPDATING', ownerAlive: true };
        },
    };
    await bootstrapServer({
        projectPath: scratch(t), maintenancePollMs: 1, gateModule: { createUpdateMaintenanceGate: () => gate },
        serveMaintenance: async () => { events.push('serve'); return { close: async () => { events.push('close'); } }; },
        loadServer: async () => { events.push('load'); },
    });
    assert.deepEqual(events, ['recover', 'serve', 'recover', 'close', 'load']);
    assert.ok(polls >= 3, 'the throwing read was skipped, not fatal');
});

/** Borrow process.argv[1], pm_exec_path and process.mainModule for one test, then restore them. */
function borrowProcessIdentity(t) {
    const argv = process.argv[1];
    const exec = process.env.pm_exec_path;
    const mainModule = Object.getOwnPropertyDescriptor(process, 'mainModule');
    t.after(() => {
        process.argv[1] = argv;
        if (exec === undefined) delete process.env.pm_exec_path; else process.env.pm_exec_path = exec;
        if (mainModule) Object.defineProperty(process, 'mainModule', mainModule); else delete process.mainModule;
    });
    return (filename) => Object.defineProperty(process, 'mainModule', { value: { filename }, configurable: true, writable: true });
}

test('the PM2 fork container is recognised only by its exact layout and package identity', (t) => {
    const setMainModule = borrowProcessIdentity(t);
    const root = scratch(t);
    const lib = path.join(root, 'pm2', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    const container = path.join(lib, 'ProcessContainerFork.js');
    fs.writeFileSync(container, '');
    const packageFile = path.join(root, 'pm2', 'package.json');
    const bootstrapFile = fileURLToPath(new URL('./bootstrap.js', import.meta.url));
    process.argv[1] = container;
    process.env.pm_exec_path = bootstrapFile;
    setMainModule(container);
    fs.writeFileSync(packageFile, '{"name":"pm2"}');
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), true, 'the real container layout');
    fs.writeFileSync(packageFile, '{"name":"not-pm2"}');
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false, 'a lookalike package');
    fs.writeFileSync(packageFile, '{ not json');
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false, 'an unreadable package');
    fs.writeFileSync(packageFile, JSON.stringify({ name: 'pm2', padding: 'x'.repeat(70 * 1024) }));
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false, 'an oversized package');
    fs.rmSync(packageFile);
    const elsewhere = path.join(root, 'elsewhere.json');
    fs.writeFileSync(elsewhere, '{"name":"pm2"}');
    fs.symlinkSync(elsewhere, packageFile);
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false, 'a symlinked package');
    setMainModule(bootstrapFile);
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false, 'main module is not the container');
    const renamed = path.join(lib, 'Other.js');
    fs.writeFileSync(renamed, '');
    process.argv[1] = renamed;
    setMainModule(renamed);
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false, 'not named ProcessContainerFork.js');
    process.argv[1] = undefined;
    assert.equal(isBootstrapProcessEntrypoint(bootstrapFile), false, 'no script argument at all');
});

test('maintenance defaults: the real server on SERVER_PORT/HOST and the default poll interval', async (t) => {
    const saved = { port: process.env.SERVER_PORT, host: process.env.HOST };
    t.after(() => {
        for (const [key, value] of [['SERVER_PORT', saved.port], ['HOST', saved.host]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    process.env.SERVER_PORT = '0';
    process.env.HOST = '127.0.0.1';
    let reads = 0;
    const gate = {
        // Closed at boot and on nothing else: the first default-interval poll opens it.
        readPublicStatus: () => { reads += 1; return reads === 1 ? { state: 'MANUAL', gateClosed: true, phase: 'SOURCE_APPLIED' } : { state: 'OPEN', gateClosed: false }; },
        // A non-Error throw still becomes a logged, closed gate.
        recoverOrDeclareManual: async () => { throw null; },
    };
    const started = Date.now();
    let loaded = false;
    await bootstrapServer({ projectPath: scratch(t), gateModule: { createUpdateMaintenanceGate: () => gate },
        loadServer: async () => { loaded = true; } });
    assert.equal(loaded, true);
    assert.ok(Date.now() - started >= 4_500, 'the default interval is the documented five seconds');
});

test('the real maintenance server ignores a query string on /health', async (t) => {
    const handle = await serveMaintenance({ port: 0, host: '127.0.0.1', readPublicStatus: () => { throw new Error('unreadable'); } });
    t.after(() => handle.close());
    const response = await fetch(`http://127.0.0.1:${handle.address().port}/health?probe=1`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
        status: 'maintenance', degraded: true, degradedReason: 'maintenance_state_unavailable', degradedPhase: null,
    });
});

test('an unsafe descriptor is logged by message, and an artifact claim is published as such', async (t) => {
    const unsafe = controlRoot(t, {}, { mode: 0o640 });
    const events = [];
    await bootstrapServer({ projectPath: scratch(t), loadServer: async () => { events.push('load'); },
        gateModule: { createUpdateMaintenanceGate: () => ({
            paths: { controlRoot: unsafe.controlRoot, token: unsafe.token },
            readPublicStatus: () => ({ state: 'UPDATING', gateClosed: true, phase: 'RESTARTING_HANDOFF' }),
            recoverOrDeclareManual: async () => { events.push('recover'); return { state: 'OPEN' }; },
        }) } });
    assert.deepEqual(events, ['recover', 'load']);

    const calls = [];
    const gate = claimingGate(t, calls);
    const claim = gate.claimBootstrapOwnership;
    gate.claimBootstrapOwnership = async (request) => ({ ...(await claim(request)), artifact: { jobId: 'job-1' } });
    t.after(() => { delete globalThis[OWNERSHIP_SYMBOL]; });
    await bootstrapServer({ projectPath: scratch(t), gateModule: { createUpdateMaintenanceGate: () => gate }, loadServer: async () => ({}) });
    assert.deepEqual(globalThis[OWNERSHIP_SYMBOL].artifact, { jobId: 'job-1' });
});

test('without a project path bootstrap resolves the application root from its own location', async () => {
    let projectPath = null;
    await bootstrapServer({
        gateModule: { createUpdateMaintenanceGate: (options) => { projectPath = options.projectPath; return { readPublicStatus: () => ({ gateClosed: false }) }; } },
        loadServer: async () => ({}),
    });
    assert.equal(projectPath, path.resolve(fileURLToPath(new URL('..', import.meta.url))));
});
