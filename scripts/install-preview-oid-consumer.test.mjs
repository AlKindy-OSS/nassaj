#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { enforcementPlan, executeEnforcementTransition, installEnforcementFiles, executeServerDomainTransition, assertTransitionStorageCapacity, verifyLoadedTransitionArtifact } from './install-preview-oid-consumer.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('enforcement reinstall atomically narrows an existing drop-in to 0600', () => {
    const home = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-enforcement-home-'));
    try {
        const directory = path.join(home, '.config', 'systemd', 'user', 'nassaj-preview-oid-consumer.service.d');
        const destination = path.join(directory, 'enforcement.conf');
        mkdirSync(directory, { recursive: true });
        writeFileSync(destination, 'stale\n');
        chmodSync(destination, 0o644);
        const installed = installEnforcementFiles(PROJECT_ROOT, enforcementPlan(PROJECT_ROOT), home);
        assert.equal(installed, destination);
        assert.equal(statSync(destination).mode & 0o777, 0o600);
    } finally { rmSync(home, { recursive: true, force: true }); }
});

test('enforcement installs first then uses one conflict transaction and verifies legacy stopped', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-enforcement-'));
    const calls = [];
    let installed = false;
    try {
        let installation;
        const result = executeEnforcementTransition({ root, approvalId: 'owner-action-123' }, {
            install: (plan) => { installed = true; installation = plan; },
            run: (args) => {
                assert.equal(installed, true);
                calls.push(args);
                if (args[0] === 'is-active' && args[1] !== 'nassaj-preview-oid-consumer.service') {
                    return { status: 3, stdout: 'inactive\n' };
                }
                return { status: 0, stdout: args[0] === 'is-active' ? 'active\n' : '' };
            },
        });
        assert.equal(result.state, 'active');
        assert.deepEqual(installation.domains, ['client']);
        assert.equal(installation.dropIn.mode, 0o600);
        assert.match(installation.dropIn.contents, /NASSAJ_PREVIEW_OID_ENFORCEMENT=1/);
        assert.match(installation.dropIn.contents, /NASSAJ_PREVIEW_OID_DOMAINS=client/);
        assert.equal(installation.legacy.includes('nassaj-server-build-watch.service'), false);
        assert.deepEqual(calls.find((args) => args[0] === 'start'), [
            'start', '--job-mode=replace-irreversibly', 'nassaj-preview-oid-consumer.service',
        ]);
        assert.equal(calls.some((args) => args.includes('--now')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enforcement accepts an already absent legacy unit', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-enforcement-'));
    try {
        const result = executeEnforcementTransition({ root, approvalId: 'owner-action-absent' }, {
            install: () => {},
            run: (args) => {
                if (args[0] === 'disable' && args[1] === 'nassaj-client-build-watch.service') {
                    return { status: 1, stderr: 'unit does not exist' };
                }
                if (args[0] === 'show') return { status: 0, stdout: 'not-found\n' };
                if (args[0] === 'is-active' && args[1] !== 'nassaj-preview-oid-consumer.service') {
                    return { status: 3, stdout: 'inactive\n' };
                }
                return { status: 0, stdout: args[0] === 'is-active' ? 'active\n' : '' };
            },
        });
        assert.equal(result.state, 'active');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

const CONSUMER = 'nassaj-preview-oid-consumer.service';

function serverFixture() {
    const parent = path.join(PROJECT_ROOT, '.artifacts');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(path.join(parent, 'consumer-transition-test-'));
    const home = path.join(root, 'fake-home');
    const unit = path.join(home, '.config/systemd/user', CONSUMER);
    const dropIn = `${unit}.d/enforcement.conf`;
    mkdirSync(path.dirname(dropIn), { recursive: true });
    mkdirSync(path.join(root, '.git'));
    mkdirSync(path.join(root, 'scripts/systemd'), { recursive: true });
    writeFileSync(unit, 'reviewed-unit\n', { mode: 0o600 });
    writeFileSync(path.join(root, 'scripts/systemd', CONSUMER), 'reviewed-unit\n');
    writeFileSync(dropIn, enforcementPlan(root).dropIn.contents, { mode: 0o600 });
    const options = { root, home, expectedOid: 'a'.repeat(40), approvalId: 'owner-review-test',
        persistentAcknowledgment: 'persistent-server-domain-including-future-events' };
    const value = { root, home, unit, dropIn, options, calls: [], failRestarts: 0,
        backup: path.join(root, '.git/nassaj-consumer-server-transition-v1.json') };
    value.injected = {
        resourcesSafe: () => true,
        assertEvent: () => ({ oid: options.expectedOid, sequence: 8, group: 'event-0000000000000008' }),
        readiness: () => ({ oid: 'b'.repeat(40), buildId: 'c'.repeat(64), controlManifestSha256: 'd'.repeat(64) }),
        capacity: () => ({ directory: path.join(home, '.local/share/nassaj-dev'), reservedBytes: 1024 }),
        lock: async (_root, action) => action(),
        withQuiescence: async (action) => action(),
        run: (args) => fakeSystemctl(value, args),
    };
    return value;
}

function fakeSystemctl(value, args) {
    value.calls.push(args);
    if (args[0] === 'restart' && value.failRestarts-- > 0) return { status: 1 };
    if (args[0] !== 'show') return { status: 0, stdout: '' };
    const contents = readFileSync(value.dropIn, 'utf8');
    const server = contents.includes('DOMAINS=client,server');
    const properties = {
        ActiveState: args[1] === CONSUMER ? 'active' : 'inactive',
        Environment: `NASSAJ_PREVIEW_OID_ENFORCEMENT=1 NASSAJ_PREVIEW_OID_DOMAINS=${server ? 'client,server' : 'client'}`,
        ProtectHome: 'read-only', ProtectSystem: 'strict', DropInPaths: value.dropIn,
        ReadWritePaths: server ? `${value.root} ${path.join(value.home, '.local/share/nassaj-dev')}` : value.root,
    };
    return { status: 0, stdout: properties[args[2].split('=')[1]] || '' };
}

function fixtureTest(name, action) {
    test(name, async () => {
        const value = serverFixture();
        try { await action(value); } finally { rmSync(value.root, { recursive: true, force: true }); }
    });
}

fixtureTest('server scope defaults to read-only with no backup or service mutation', async (f) => {
    const result = await executeServerDomainTransition(f.options, f.injected);
    assert.equal(result.state, 'dry_run');
    assert.equal(existsSync(f.backup), false);
    assert.equal(f.calls.every((args) => args[0] === 'show'), true);
    assert.equal(readFileSync(f.dropIn, 'utf8'), enforcementPlan(f.root).dropIn.contents);
});

for (const [label, change, pattern] of [
    ['full OID', (f) => { f.options.expectedOid = 'ed621508'; }, /Full expected OID/],
    ['persistent acknowledgment', (f) => { delete f.options.persistentAcknowledgment; }, /persistent/],
    ['resource ceiling', (f) => { f.injected.resourcesSafe = () => false; }, /80%/],
    ['exact event', (f) => { f.injected.assertEvent = () => { throw new Error('superseded event'); }; }, /superseded/],
    ['nonterminal/partial request', (f) => { f.injected.assertEvent = () => { throw new Error('partial owner request'); }; }, /partial/],
    ['loaded readiness', (f) => { f.injected.readiness = () => { throw new Error('readiness absent'); }; }, /readiness/],
    ['disk capacity', (f) => { f.injected.capacity = () => { throw new Error('capacity failed'); }; }, /capacity/],
    ['retained recovery evidence', (f) => { writeFileSync(f.backup, 'retain'); }, /Retained/],
    ['altered base unit', (f) => { writeFileSync(f.unit, 'unknown'); }, /differs/],
]) {
    fixtureTest(`server scope rejects ${label} before mutation`, async (f) => {
        change(f);
        await assert.rejects(executeServerDomainTransition({ ...f.options, execute: true }, f.injected), pattern);
        assert.equal(f.calls.some((args) => args[0] !== 'show'), false);
        assert.equal(readFileSync(f.dropIn, 'utf8'), enforcementPlan(f.root).dropIn.contents);
    });
}

fixtureTest('server scope refuses execution without separate approval id', async (f) => {
    await assert.rejects(executeServerDomainTransition({ ...f.options, execute: true, approvalId: '' }, f.injected), /approval/);
    assert.equal(existsSync(f.backup), false);
    assert.equal(f.calls.some((args) => args[0] !== 'show'), false);
});

fixtureTest('server scope rejects symlinked configuration without touching target', async (f) => {
    const target = path.join(f.root, 'untouched');
    writeFileSync(target, 'untouched');
    rmSync(f.dropIn);
    symlinkSync(target, f.dropIn);
    await assert.rejects(executeServerDomainTransition(f.options, f.injected), /symbolic/);
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
});

fixtureTest('server scope rechecks event under lock before durable preparation', async (f) => {
    let calls = 0;
    f.injected.assertEvent = () => ({ oid: f.options.expectedOid, sequence: ++calls });
    await assert.rejects(executeServerDomainTransition({ ...f.options, execute: true }, f.injected), /event changed/);
    assert.equal(existsSync(f.backup), false);
});

fixtureTest('server scope preserves backup before narrow configuration and never claims candidate prepared', async (f) => {
    const run = f.injected.run;
    f.injected.run = (args) => {
        if (args[0] === 'restart') {
            assert.equal(JSON.parse(readFileSync(f.backup)).state, 'prepared');
        }
        return run(args);
    };
    const result = await executeServerDomainTransition({ ...f.options, execute: true }, f.injected);
    assert.equal(result.state, 'enabled_pending_preparation');
    const evidence = JSON.parse(readFileSync(f.backup));
    assert.equal(evidence.plan.original.bytes, enforcementPlan(f.root).dropIn.contents);
    assert.equal(evidence.plan.original.sha256.length, 64);
    assert.equal(statSync(f.backup).mode & 0o777, 0o600);
    assert.equal(statSync(f.dropIn).mode & 0o777, 0o600);
    assert.match(readFileSync(f.dropIn, 'utf8'), /ReadWritePaths=.*\/\.local\/share\/nassaj-dev\n$/);
    assert.deepEqual(f.calls.filter((args) => args[0] === 'restart'), [['restart', CONSUMER]]);
});

fixtureTest('failed consumer restart restores only configuration and retains runtime evidence', async (f) => {
    f.failRestarts = 1;
    const request = path.join(f.root, '.git/owner-request-fixture');
    writeFileSync(request, 'partial request must survive');
    await assert.rejects(executeServerDomainTransition({ ...f.options, execute: true }, f.injected), /rolled_back_configuration_only/);
    assert.equal(readFileSync(f.dropIn, 'utf8'), enforcementPlan(f.root).dropIn.contents);
    assert.equal(JSON.parse(readFileSync(f.backup)).state, 'rolled_back_configuration_only');
    assert.equal(readFileSync(request, 'utf8'), 'partial request must survive');
});

fixtureTest('failed rollback preserves a durable manual recovery state', async (f) => {
    f.failRestarts = 2;
    await assert.rejects(executeServerDomainTransition({ ...f.options, execute: true }, f.injected), /manual_recovery_required/);
    assert.equal(JSON.parse(readFileSync(f.backup)).state, 'manual_recovery_required');
});

fixtureTest('concurrent operator edit is never overwritten during rollback', async (f) => {
    const run = f.injected.run;
    f.injected.run = (args) => {
        if (args[0] === 'restart') {
            writeFileSync(f.dropIn, 'operator change\n');
            return { status: 1 };
        }
        return run(args);
    };
    await assert.rejects(executeServerDomainTransition({ ...f.options, execute: true }, f.injected), /manual_recovery_required/);
    assert.equal(readFileSync(f.dropIn, 'utf8'), 'operator change\n');
});

fixtureTest('production execution refuses absent continuous quiescence before any write or restart', async (f) => {
    delete f.injected.withQuiescence;
    await assert.rejects(executeServerDomainTransition({ ...f.options, execute: true }, f.injected), /consumer_quiescence_protocol_absent/);
    assert.equal(existsSync(f.backup), false);
    assert.equal(readFileSync(f.dropIn, 'utf8'), enforcementPlan(f.root).dropIn.contents);
    assert.equal(f.calls.every((args) => args[0] === 'show'), true);
});

function storageFs(space = { bavail: 100, bsize: 1, type: 0xef53 }, dev = () => 1) {
    return { statfsSync: () => space, statSync: (directory) => ({ dev: dev(directory) }) };
}

test('shared-device requirements fail even when each allocation fits separately', () => {
    const requirements = [{ directory: 'project', bytes: 60 }, { directory: 'db', bytes: 60 }];
    assert.throws(() => assertTransitionStorageCapacity(requirements, storageFs()), /aggregate/);
    const devices = assertTransitionStorageCapacity(requirements, storageFs(undefined, (dir) => dir === 'db' ? 2 : 1));
    assert.equal(devices.length, 2);
});

for (const [label, space] of [
    ['tmpfs', { bavail: 100, bsize: 1, type: 0x01021994 }],
    ['missing bavail', { bsize: 1, type: 0xef53 }],
    ['NaN bavail', { bavail: NaN, bsize: 1, type: 0xef53 }],
    ['negative bavail', { bavail: -1, bsize: 1, type: 0xef53 }],
    ['zero bsize', { bavail: 100, bsize: 0, type: 0xef53 }],
    ['unknown type', { bavail: 100, bsize: 1 }],
    ['overflow', { bavail: Number.MAX_SAFE_INTEGER, bsize: 4096, type: 0xef53 }],
]) {
    test(`actual capacity validator rejects ${label}`, () => {
        assert.throws(() => assertTransitionStorageCapacity([{ directory: 'db', bytes: 20 }], storageFs(space)), /unknown|invalid|tmpfs/);
    });
}

test('capacity probe errors and malformed requirements fail closed', () => {
    assert.throws(() => assertTransitionStorageCapacity([{ directory: 'db', bytes: 1 }], {
        statfsSync: () => { throw new Error('probe failed'); },
    }), /probe failed/);
    assert.throws(() => assertTransitionStorageCapacity([{ directory: 'db', bytes: NaN }], storageFs()), /invalid/);
});

fixtureTest('loaded validation uses old proven artifact version while mutable source is newer', async (f) => {
    const live = path.join(f.root, 'dist-server');
    mkdirSync(live);
    writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ version: '9.0.0.0' }));
    const health = { serverLoadedOid: 'a'.repeat(40), serverLoadedBuildId: 'b'.repeat(64) };
    const provenance = { artifact: 'server', version: '1.47.0.0', dirty: false,
        commit: health.serverLoadedOid, baseCommit: health.serverLoadedOid, buildId: health.serverLoadedBuildId };
    const file = path.join(live, 'BUILD_PROVENANCE.json');
    writeFileSync(file, JSON.stringify(provenance));
    let verified = false;
    verifyLoadedTransitionArtifact(live, health, f.root, (_live, options) => {
        assert.equal(options.version, '1.47.0.0');
        assert.equal(options.expectedCommit, health.serverLoadedOid);
        verified = true;
    });
    assert.equal(verified, true);
    assert.throws(() => verifyLoadedTransitionArtifact(live, health, f.root, () => {
        writeFileSync(file, JSON.stringify({ ...provenance, version: '2.0.0.0' }));
    }), /changed during/);
    writeFileSync(file, JSON.stringify({ ...provenance, dirty: true }));
    assert.throws(() => verifyLoadedTransitionArtifact(live, health, f.root, () => {}), /does not match/);
});
