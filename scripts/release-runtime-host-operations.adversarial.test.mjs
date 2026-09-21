import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    createReleaseRuntimeHostOperations, restoreReleaseRuntimeMaintenanceGateOffline,
} from './lib/release-runtime-host-operations.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function closureDigest(value) {
    const digest = createHash('sha256'); digest.update(value.schema).update('\0').update(value.graphLoader).update('\0')
        .update(value.entry).update('\0').update(value.packageLockSha256).update('\0').update(JSON.stringify(value.runtimeAbi)).update('\0')
        .update(JSON.stringify(value.nativePackageAllowlist)).update('\0');
    for (const file of value.files) digest.update(file.assetPath).update('\0').update(String(file.mode)).update('\0')
        .update(String(file.size)).update('\0').update(file.sha256).update('\0');
    return digest.digest('hex');
}

function fixture(t) {
    const root = mkdtempSync(path.join(TEMP, 'release-runtime-host-qa-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const executable = (name) => {
        const file = path.join(root, name); writeFileSync(file, '#!/bin/sh\nexit 0\n'); chmodSync(file, 0o755); return file;
    };
    const ingressFile = path.join(root, 'ingress.map'); writeFileSync(ingressFile, 'OPEN');
    const ingress = statSync(ingressFile);
    const databaseFile = path.join(root, 'database.sqlite'); writeFileSync(databaseFile, 'database'); chmodSync(databaseFile, 0o600);
    const pm2 = executable('pm2'); const launcher = executable('launcher'); const probe = executable('zero-probe');
    const migration = executable('migration');
    const nft = executable('nft'); const conntrack = executable('conntrack');
    const closureBase = { schema: 'nassaj-database-migration-closure/v2', graphLoader: 'esbuild@1.2.3', entry: 'migration',
        packageLockSha256: '9'.repeat(64), runtimeAbi: {}, nativePackageAllowlist: [], files: [{ assetPath: 'migration',
            mode: 0o755, size: statSync(migration).size, sha256: sha(migration) }], packages: [] };
    const migrationClosure = { ...closureBase, sha256: closureDigest(closureBase), assetManifestBound: true };
    const contractFile = path.join(root, 'database-contract.json');
    writeFileSync(contractFile, JSON.stringify({ schema: 'nassaj-database-release-contract/v1', releaseIdentitySha256: 'a'.repeat(64),
        migrationEntrySha256: sha(migration), migrationClosureSha256: migrationClosure.sha256, migrationClosure,
        targetSchemaDigest: 'b'.repeat(64) }), { mode: 0o444 });
    const config = {
        schema: 'nassaj-release-runtime-host-config/v1', controlRoot: path.join(root, 'control'), databaseFile,
        preMigrationBackupFile: path.join(root, 'pre.sqlite'), finalBackupFile: path.join(root, 'final.sqlite'),
        expected: { releaseIdentitySha256: 'a'.repeat(64), targetSchemaDigest: 'b'.repeat(64), databaseContractSha256: sha(contractFile) },
        oldProcess: { pid: 4242, pgid: 4242, sid: 4242, startTime: '123', killTimeout: 86_400_000, treeKill: false },
        ingress: { file: ingressFile, device: ingress.dev, inode: ingress.ino, offset: 0,
            originalBase64: Buffer.from('OPEN').toString('base64'), fencedBase64: Buffer.from('STOP').toString('base64'),
            blockedStatus: 503 },
        health: { privateUrl: 'http://127.0.0.1/private', publicUrl: 'https://example.invalid/health' },
        maintenance: { nonce: 'nassaj-maintenance-v1', retryAfterSeconds: 30, responderUnit: 'nassaj-maintenance.service',
            responderPort: 3311, responderUrl: 'http://127.0.0.1:3311/health',
            cloudflared: { uid: 991, originPort: 3100 }, nft: { binary: nft, sha256: sha(nft) },
            conntrack: { binary: conntrack, sha256: sha(conntrack) } },
        zeroWorkProbe: { file: probe, sha256: sha(probe), args: [], timeoutMs: 10_000 },
        migration: { node: { file: process.execPath, sha256: sha(process.execPath) }, entry: { file: migration, sha256: sha(migration) },
            contractFile, contractSha256: sha(contractFile), runtimeRoot: root, nodeModulesRoot: root, timeoutMs: 10_000,
            providerSecretsKeyFile: path.join(root, 'provider-secrets.key'),
            secretCapabilityFile: path.join(root, 'migration-capability.json'), serviceUid: process.getuid(), serviceGid: process.getgid() },
        pm2: { binary: pm2, binarySha256: sha(pm2), launcher, launcherSha256: sha(launcher), home: root,
            oldName: 'nassaj-dev', targetName: 'nassaj-runtime', cwd: root, interpreter: '/usr/bin/node',
            oldSnapshot: path.join(root, 'old-pm2.json') },
    };
    return { config, root, probe };
}

function response(status, body = {}) { return { status, async json() { return body; } }; }

test('production cutover configuration refuses a migration without capability and key descriptors', (t) => {
    const { config } = fixture(t); delete config.migration.secretCapabilityFile;
    assert.throws(() => createReleaseRuntimeHostOperations(config), /host_config_invalid/);
});

function attachLiveIdentity(config, root) {
    const create = (name, bytes) => { const file = path.join(root, name); writeFileSync(file, bytes, { mode: 0o600 }); return file; };
    const nodeInstanceIdFile = create('node-instance-id', 'qa-node\n');
    const host = create('host.identity', 'host'); const release = create('release.identity', 'release');
    const migration = create('migration.identity', 'migration-entry-and-closure');
    const databaseContract = config.migration.contractFile; const asset = create('release.asset', 'asset');
    const snapshot = create('old-pm2.json', '{"apps":[]}\n');
    Object.assign(config.expected, { nodeInstanceId: 'qa-node', hostIdentitySha256: sha(host), releaseIdentitySha256: sha(release),
        migrationIdentitySha256: sha(migration), databaseContractSha256: sha(databaseContract), assetSha256: sha(asset),
        pm2SnapshotSha256: sha(snapshot) });
    config.pm2.oldSnapshot = snapshot;
    config.liveIdentity = { nodeInstanceIdFile, host, release, migration, databaseContract, asset };
    return { asset, snapshot };
}

test('inspection remains possible after SIGSTOP without probing the stopped legacy HTTP process', async (t) => {
    const { config } = fixture(t); let stopped = false;
    const operations = createReleaseRuntimeHostOperations(config, {
        inspectLiveFacts: () => ({ ...config.expected }),
        processIdentity: () => ({ pid: 4242, pgid: 4242, sid: 4242, startTime: '123' }),
        kill: () => { stopped = true; },
        fetch: async () => {
            if (stopped) throw new Error('legacy process is stopped');
            return response(200, { health: 'ok' });
        },
    });
    await operations.freezeOldWriters();
    const facts = await operations.inspect();
    assert.equal(facts.oldHealth, 'frozen');
});

test('root dispatcher refuses a digest-pinned executable owned by the service user', async (t) => {
    const { config, probe } = fixture(t);
    if (process.geteuid?.() === 0) return t.skip('requires an unprivileged QA process');
    assert.equal(statSync(probe).uid, process.geteuid());
    const operations = createReleaseRuntimeHostOperations(config, {
        exec: () => JSON.stringify({ liveSessions: 0, workflows: 0, admittedTurns: 0 }),
    });
    await assert.rejects(operations.verifyZeroWork(), /executable_(?:identity_)?invalid|owner/i);
});

test('database restore refuses to replace a pathname while any process still holds the database', async (t) => {
    const { config } = fixture(t); writeFileSync(config.preMigrationBackupFile, 'pre-migration'); chmodSync(config.preMigrationBackupFile, 0o600);
    const operations = createReleaseRuntimeHostOperations(config, { databaseWriters: () => 1 });
    await assert.rejects(operations.restoreDatabaseFromBackup(), /writer|database.*busy/i);
    assert.equal(readFileSync(config.databaseFile, 'utf8'), 'database');
});

test('blockIngress proves the public endpoint is actually fenced before zero-work inspection', async (t) => {
    const { config } = fixture(t); let publicChecks = 0;
    const operations = createReleaseRuntimeHostOperations(config, {
        attestMaintenancePrerequisites: () => ({ uid: config.maintenance.cloudflared.uid }),
        verifyPinnedExecutable() {}, exec: () => '',
        fetch: async (url) => {
            if (url === config.health.publicUrl) { publicChecks += 1; return response(200, { health: 'ok' }); }
            return { ...response(503), headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '30'
                : name.toLowerCase() === 'x-nassaj-maintenance-nonce' ? config.maintenance.nonce : null; } } };
        },
    });
    await assert.rejects(operations.blockIngress(), /ingress|status|fenc|block/i);
    assert.ok(publicChecks > 0, 'the claimed ingress block was never observed from the public endpoint');
});

test('private target verification rejects a target already exposed publicly before the rollback boundary', async (t) => {
    const { config } = fixture(t); const target = { health: 'ok', releaseIdentitySha256: config.expected.releaseIdentitySha256,
        updateReady: true, updateStrategy: 'artifact-runtime-v2' };
    const operations = createReleaseRuntimeHostOperations(config, { fetch: async () => response(200, target) });
    await assert.rejects(operations.verifyPrivateTarget(), /public|ingress|exposed|visibility/i);
});

test('inspect measures the rollback snapshot instead of echoing its configured expected digest', async (t) => {
    const { config, root } = fixture(t); attachLiveIdentity(config, root);
    writeFileSync(config.pm2.oldSnapshot, '{"tampered":true}\n'); chmodSync(config.pm2.oldSnapshot, 0o600);
    config.expected.pm2SnapshotSha256 = 'c'.repeat(64);
    const operations = createReleaseRuntimeHostOperations(config, {
        processIdentity: () => ({ pid: 4242, pgid: 4242, sid: 4242, startTime: '123' }),
        fetch: async () => response(200, { health: 'ok' }),
    });
    await assert.rejects(operations.inspect(), /snapshot|identity|digest/i);
});

test('inspect rejects tampered release bytes while signed expected JSON remains unchanged', async (t) => {
    const { config, root } = fixture(t); const identity = attachLiveIdentity(config, root);
    writeFileSync(identity.asset, 'tampered-asset', { mode: 0o600 });
    const operations = createReleaseRuntimeHostOperations(config, {
        processIdentity: () => ({ pid: 4242, pgid: 4242, sid: 4242, startTime: '123' }),
        fetch: async () => response(200, { health: 'ok' }),
    });
    await assert.rejects(operations.inspect(), /asset|identity|mismatch/i);
});

test('maintenance gate activation is one atomic nft transaction that cuts established origin flows', async (t) => {
    const { config } = fixture(t); const nftCalls = []; const conntrackCalls = []; let publicChecks = 0;
    const operations = createReleaseRuntimeHostOperations(config, {
        verifyPinnedExecutable() {},
        attestMaintenancePrerequisites: () => ({ uid: config.maintenance.cloudflared.uid }),
        exec(file, args, options) { if (file === config.maintenance.nft.binary) nftCalls.push({ args, options });
            if (file === config.maintenance.conntrack.binary) conntrackCalls.push({ args, options }); return ''; },
        fetch: async (url) => {
            if (url === config.health.publicUrl && publicChecks++ === 0) return response(200, { health: 'ok' });
            return { ...response(503), headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '30'
                : name.toLowerCase() === 'x-nassaj-maintenance-nonce' ? config.maintenance.nonce : null; } } };
        },
    });
    await operations.blockIngress();
    assert.equal(nftCalls.length, 1, 'gate creation must be one atomic nft batch');
    assert.ok(nftCalls[0].args.includes('-f'), 'nft gate must use an atomic ruleset batch');
    assert.equal(conntrackCalls.length, 1, 'existing cloudflared origin connections must be actively terminated');
    assert.deepEqual(conntrackCalls[0].args.slice(0, 3), ['-D', '-p', 'tcp']);
    assert.ok(conntrackCalls[0].args.includes(String(config.maintenance.cloudflared.originPort)));
});

test('real pinned executable runner pipes the nft batch to standard input', () => {
    const source = readFileSync(path.join(new URL('..', import.meta.url).pathname,
        'scripts/lib/release-runtime-host-operations.mjs'), 'utf8');
    assert.match(source, /execFileSync\([\s\S]*?input:\s*options\.input/,
        'nft -f - receives no rules when the real executor ignores options.input');
    assert.doesNotMatch(source, /input:\s*options\.input[\s\S]{0,240}stdio:\s*\[\s*['"]ignore['"]/,
        'stdin cannot be ignored when the nft batch is supplied through options.input');
});

test('release bundle contains the fixed maintenance responder and its systemd unit', () => {
    const project = path.join(new URL('..', import.meta.url).pathname);
    assert.doesNotThrow(() => readFileSync(path.join(project, 'scripts/nassaj-maintenance-responder.mjs')));
    assert.doesNotThrow(() => readFileSync(path.join(project, 'ops/nassaj-maintenance.service')));
    const installer = readFileSync(path.join(project, 'scripts/build-release-installer.mjs'), 'utf8');
    assert.match(installer, /nassaj-maintenance-responder\.mjs/);
    assert.match(installer, /nassaj-maintenance\.service/);
});

test('offline boot restore fails closed on an active cutover journal with missing gate state', async (t) => {
    const { config } = fixture(t); mkdirSync(config.controlRoot, { mode: 0o700 });
    writeFileSync(path.join(config.controlRoot, 'first-cutover.json'), `${JSON.stringify({
        schema: 'nassaj-release-runtime-cutover/v1', state: 'running', phase: 'target_verified',
        transactionId: 'qa-cutover-transaction', expected: config.expected,
    })}\n`, { mode: 0o600 });
    await assert.rejects(restoreReleaseRuntimeMaintenanceGateOffline(config, {
        attestOfflineMaintenancePrerequisites: () => ({ uid: config.maintenance.cloudflared.uid }),
        verifyPinnedExecutable() {}, exec: () => '', installMaintenanceGate: () => {},
        fetch: async () => ({ ...response(503, { schema: 'nassaj-maintenance/v1', state: 'maintenance',
            nonce: config.maintenance.nonce }), headers: { get(name) { return name.toLowerCase() === 'retry-after' ? '30'
                : name.toLowerCase() === 'x-nassaj-maintenance-nonce' ? config.maintenance.nonce : null; } } }),
    }), /gate_state_missing|gate.*state/i);
});

test('offline boot restore rejects inconsistent active gate state without a durable install intent', async (t) => {
    const { config } = fixture(t); mkdirSync(config.controlRoot, { mode: 0o700 });
    writeFileSync(path.join(config.controlRoot, 'host-dispatch-state.json'), `${JSON.stringify({
        schema: 'nassaj-host-dispatch-state/v1', gateActive: true, publicBoundaryReady: null,
    })}\n`, { mode: 0o600 });
    await assert.rejects(restoreReleaseRuntimeMaintenanceGateOffline(config), /gate|state|intent|inconsistent/i);
});

test('recovery unit never uses a raw PM2 restart', () => {
    const unit = readFileSync(path.join(new URL('..', import.meta.url).pathname, 'ops/nassaj-first-cutover-recovery.service'), 'utf8');
    assert.doesNotMatch(unit, /pm2\s+restart|safe-restart/i);
    assert.match(unit, /^User=root$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
});
