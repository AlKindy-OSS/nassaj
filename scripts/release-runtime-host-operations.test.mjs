import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { databaseSchemaDigest } from './lib/release-database-backup.mjs';
import { executeReleaseRuntimeCutover } from './lib/release-runtime-cutover.mjs';
import { __testables as hostOperationsTestables, createReleaseRuntimeHostOperations } from './lib/release-runtime-host-operations.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hash = (character) => character.repeat(64);
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function closureDigest(value) {
    const digest = createHash('sha256'); digest.update(value.schema).update('\0').update(value.graphLoader).update('\0')
        .update(value.entry).update('\0').update(value.packageLockSha256).update('\0').update(JSON.stringify(value.runtimeAbi)).update('\0')
        .update(JSON.stringify(value.nativePackageAllowlist)).update('\0');
    for (const file of value.files) digest.update(file.assetPath).update('\0').update(String(file.mode)).update('\0')
        .update(String(file.size)).update('\0').update(file.sha256).update('\0');
    for (const item of value.packages) digest.update(item.root).update('\0').update(item.name).update('\0').update(item.version).update('\0')
        .update(JSON.stringify(item.peerDependencies)).update('\0').update(JSON.stringify(item.peerDependenciesMeta)).update('\0')
        .update(item.sha256).update('\0');
    return digest.digest('hex');
}

test('cutover blocks before real host operations and preserves approval and host state', async (t) => {
    const root = mkdtempSync(path.join(TEMP, 'host-ops-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const controlRoot = path.join(root, 'control'); mkdirSync(controlRoot, { mode: 0o700 });
    const databaseFile = path.join(root, 'database.sqlite');
    execFileSync('/usr/bin/sqlite3', [databaseFile, 'CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT);']); chmodSync(databaseFile, 0o600);
    const executable = (name, source = '#!/bin/sh\nexit 0\n') => { const file = path.join(root, name);
        writeFileSync(file, source, { mode: 0o755 }); return { file, sha256: sha(readFileSync(file)) }; };
    const pm2 = executable('pm2'); const launcher = executable('launcher.mjs');
    const migrationEntry = path.join(root, 'migration-entry.js'); writeFileSync(migrationEntry, '// compiled migration\n', { mode: 0o644 });
    const entryBytes = readFileSync(migrationEntry); const entrySha256 = sha(entryBytes);
    const closureBase = { schema: 'nassaj-database-migration-closure/v2', graphLoader: 'esbuild@1.2.3',
        entry: 'migration-entry.js', packageLockSha256: hash('9'), runtimeAbi: {}, nativePackageAllowlist: [],
        files: [{ assetPath: 'migration-entry.js', mode: 0o644, size: entryBytes.length, sha256: entrySha256 }], packages: [] };
    const migrationClosure = { ...closureBase, sha256: closureDigest(closureBase), assetManifestBound: true };
    const nft = executable('nft'); const conntrack = executable('conntrack');
    const zero = executable('zero-probe'); const oldSnapshot = path.join(root, 'old-snapshot.json');
    writeFileSync(oldSnapshot, '{"apps":[]}\n', { mode: 0o600 });
    const original = Buffer.from('ORIGIN-OPEN-1234'); const fenced = Buffer.from('ORIGIN-STOP-503 ');
    assert.equal(original.length, fenced.length); const ingressFile = path.join(root, 'ingress.yml');
    writeFileSync(ingressFile, original, { mode: 0o600 }); const ingressMetadata = statSync(ingressFile);
    const ownerKeys = generateKeyPairSync('ed25519');
    const ownerApprovalPublicKeyPem = ownerKeys.publicKey.export({ type: 'spki', format: 'pem' });
    const ownerApprovalKeySha256 = sha(ownerKeys.publicKey.export({ type: 'spki', format: 'der' }));
    const expected = { nodeInstanceId: 'host-node', hostIdentitySha256: hash('a'), releaseIdentitySha256: hash('b'),
        migrationIdentitySha256: hash('c'), pm2SnapshotSha256: sha(readFileSync(oldSnapshot)), databaseContractSha256: hash('d'),
        assetSha256: hash('e'), targetSchemaDigest: databaseSchemaDigest(databaseFile), serverBuildId: hash('f'),
        clientBuildId: hash('1'), generationId: 'generation-1', ownerApprovalKeySha256 };
    const contractFile = path.join(root, 'database-contract.json');
    const contract = { schema: 'nassaj-database-release-contract/v1', releaseIdentitySha256: expected.releaseIdentitySha256,
        migrationEntrySha256: entrySha256, migrationClosureSha256: migrationClosure.sha256,
        migrationClosure, targetSchemaDigest: expected.targetSchemaDigest };
    writeFileSync(contractFile, JSON.stringify(contract), { mode: 0o444 }); expected.databaseContractSha256 = sha(readFileSync(contractFile));
    const providerSecretsKeyFile = path.join(root, 'provider-secrets.key');
    writeFileSync(providerSecretsKeyFile, Buffer.alloc(32, 0x41), { mode: 0o600 });
    const secretCapabilityFile = path.join(root, 'migration-capability.json');
    writeFileSync(secretCapabilityFile, `${JSON.stringify({ schema: 'nassaj-migration-secret-capability/v1',
        providerSecretsKeyFd: 4, purpose: 'release-database-migration', releaseIdentitySha256: expected.releaseIdentitySha256,
        migrationEntrySha256: entrySha256, databaseContractSha256: expected.databaseContractSha256,
        migrationClosureSha256: migrationClosure.sha256, databaseSha256: sha(readFileSync(databaseFile)), expiresAt: Date.now() + 3_600_000,
        nonce: 'host-capability-1234' })}\n`, { mode: 0o600 });
    const config = { schema: 'nassaj-release-runtime-host-config/v1', expected, controlRoot, databaseFile,
        preMigrationBackupFile: path.join(root, 'pre.sqlite'), finalBackupFile: path.join(root, 'final.sqlite'),
        oldProcess: { pid: 410, pgid: 410, sid: 410, startTime: '123', killTimeout: 86_400_000, treeKill: false },
        ingress: { file: ingressFile, device: ingressMetadata.dev, inode: ingressMetadata.ino, offset: 0,
            originalBase64: original.toString('base64'), fencedBase64: fenced.toString('base64'), blockedStatus: 503 },
        health: { privateUrl: 'http://127.0.0.1:3100/health', publicUrl: 'https://nassaj.invalid/health' },
        maintenance: { nonce: 'nassaj-maintenance-v1', retryAfterSeconds: 30, responderUnit: 'nassaj-maintenance.service',
            responderPort: 3311, cloudflared: { uid: 991, originPort: 3100 }, nft: { binary: nft.file, sha256: nft.sha256 },
            conntrack: { binary: conntrack.file, sha256: conntrack.sha256 } },
        zeroWorkProbe: { file: zero.file, sha256: zero.sha256, args: ['--json'], timeoutMs: 10_000 },
        migration: { node: { file: process.execPath, sha256: sha(readFileSync(process.execPath)) },
            entry: { file: migrationEntry, sha256: entrySha256 }, contractFile,
            contractSha256: expected.databaseContractSha256, runtimeRoot: root, nodeModulesRoot: root, timeoutMs: 10_000,
            providerSecretsKeyFile, secretCapabilityFile, serviceUid: process.getuid(), serviceGid: process.getgid() },
        pm2: { binary: pm2.file, binarySha256: pm2.sha256, home: root, oldName: 'nassaj-dev', targetName: 'nassaj',
            launcher: launcher.file, launcherSha256: launcher.sha256, cwd: root, interpreter: '/usr/bin/node', oldSnapshot }, };
    let processState = 'S'; let processAlive = true; let targetRunning = false; let gateActive = false; const failPrivateTarget = false;
    const commands = []; const signals = []; let migrationOptions;
    const deps = {
        verifyPinnedExecutable() {},
        verifyPinnedMigrationData() {},
        attestMaintenancePrerequisites: () => ({ uid: 991, origin: '127.0.0.1:3100' }),
        inspectLiveFacts: () => ({ ...expected, databaseIdentity: { path: databaseFile, device: 1, inode: 2 },
            rollbackSnapshotIdentity: { path: oldSnapshot, device: 1, inode: 3 },
            launcherIdentity: { path: launcher.file, device: 1, inode: 4, sha256: launcher.sha256 } }),
        installMaintenanceGate() { gateActive = true; },
        removeMaintenanceGate() { gateActive = false; },
        processIdentity() { if (!processAlive) throw new Error('gone'); return { pid: 410, pgid: 410, sid: 410, startTime: '123', state: processState }; },
        listProcessGroup() { return processAlive ? [{ pid: 410, pgid: 410, sid: 410, state: processState }] : []; },
        databaseWriters: () => 0,
        kill(pid, signal) { signals.push([pid, signal]); if (signal === 'SIGSTOP') processState = 'T'; if (signal === 'SIGKILL') processAlive = false; },
        exec(file, args, options) { commands.push([file, ...args]);
            if (file === zero.file) return JSON.stringify({ liveSessions: 0, workflows: 0, admittedTurns: 0 });
            if (file === process.execPath && args[0] === '/proc/self/fd/5') { migrationOptions = options;
                return JSON.stringify({ schema: 'nassaj-migration-only-result/v1', integrity: 'ok',
                    foreignKeyViolations: 0, targetSchemaDigest: expected.targetSchemaDigest }); }
            if (file === '/usr/bin/sqlite3') return execFileSync(file, args, { encoding: 'utf8' });
            if (file === pm2.file && args[0] === 'start' && args.includes(launcher.file)) targetRunning = true;
            if (file === pm2.file && args[0] === 'start' && args.includes(oldSnapshot)) {
                targetRunning = false; processAlive = true; processState = 'S';
            }
            return ''; },
        async fetch(url) { const publicRequest = url.startsWith('https:'); const responderRequest = url.includes(':3311/');
            const maintenanceRequest = responderRequest || (publicRequest && gateActive);
            const status = maintenanceRequest ? 503 : failPrivateTarget && targetRunning && !publicRequest ? 500 : 200;
            const body = targetRunning ? { releaseIdentitySha256: expected.releaseIdentitySha256, updateReady: true,
                updateStrategy: 'artifact-runtime-v2', serverBuildId: expected.serverBuildId, clientBuildId: expected.clientBuildId,
                generationId: expected.generationId, oldConversationResumed: true } : { health: 'ok' };
            return { status, headers: { get(name) { if (!maintenanceRequest) return null;
                return name.toLowerCase() === 'retry-after' ? '30' : name.toLowerCase() === 'x-nassaj-maintenance-nonce'
                    ? 'nassaj-maintenance-v1' : null; } }, async json() { return body; } }; },
    };
    const now = Date.now(); const approvalFile = path.join(root, 'approval.json');
    const payload = { schema: 'nassaj-owner-cutover-approval/v1', action: 'release-runtime-first-cutover',
        requestId: 'host-request-1234', ownerId: 'host-owner-1234', nodeInstanceId: expected.nodeInstanceId,
        hostIdentitySha256: expected.hostIdentitySha256, releaseIdentitySha256: expected.releaseIdentitySha256,
        migrationIdentitySha256: expected.migrationIdentitySha256, pm2SnapshotSha256: expected.pm2SnapshotSha256,
        databaseContractSha256: expected.databaseContractSha256, assetSha256: expected.assetSha256,
        expectedSha256: sha(Buffer.from(canonical(expected))), issuedAt: now - 1_000, expiresAt: now + 60_000,
        nonce: 'host-nonce-1234' };
    const signature = sign(null, Buffer.from(canonical(payload)), ownerKeys.privateKey).toString('base64url');
    writeFileSync(approvalFile, `${JSON.stringify({ ...payload, signature })}\n`, { mode: 0o600 });
    const ops = createReleaseRuntimeHostOperations(config, deps);
    const approvalBytes = readFileSync(approvalFile); const databaseBytes = readFileSync(databaseFile);
    await assert.rejects(executeReleaseRuntimeCutover({ expected, operations: ops, controlRoot, approvalFile, now,
        ownerApprovalPublicKeyPem }), /cutover_recovery_contract_unsupported/);
    assert.deepEqual(commands, []); assert.deepEqual(signals, []);
    assert.equal(migrationOptions, undefined); assert.equal(gateActive, false);
    assert.equal(targetRunning, false); assert.equal(processAlive, true); assert.equal(processState, 'S');
    assert.deepEqual(readFileSync(approvalFile), approvalBytes);
    assert.deepEqual(readFileSync(databaseFile), databaseBytes);
    assert.deepEqual(readFileSync(ingressFile), original);
    assert.deepEqual(readdirSync(controlRoot), []);

});

test('ingress cgroup attestation separates a system unit from a same-named user unit', () => {
    const { assertSystemManagedIngressCgroup } = hostOperationsTestables;
    const systemCgroup = '0::/system.slice/cloudflared.service\n';
    assert.equal(assertSystemManagedIngressCgroup(systemCgroup, 'cloudflared.service'), 'system.slice/cloudflared.service');
    const userCgroup = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/cloudflared.service\n';
    assert.throws(() => assertSystemManagedIngressCgroup(userCgroup, 'cloudflared.service'), (error) => {
        assert.equal(error.message, 'host_ingress_unit_manager_mismatch');
        assert.match(error.detail, /systemd --user/);
        return true;
    });
    assert.throws(() => assertSystemManagedIngressCgroup('0::/system.slice/other.service\n', 'cloudflared.service'),
        /host_cloudflared_identity_mismatch/);
    assert.throws(() => assertSystemManagedIngressCgroup('0::/system.slice/cloudflared.service.d\n', 'cloudflared.service'),
        /host_cloudflared_identity_mismatch/);
});

// B-816: these are process/socket and bounded-data tests; nft packet behavior is a separate kernel integration suite.
import fs from 'node:fs';
import net from 'node:net';
import { ingressManager, ingressShowArgs, readRoutingEvidence, listenerBoundary, observeOriginListener,
    buildListenerFenceRules } from './lib/release-runtime-listener-boundary.mjs';

function listenerConfig(port = 3004) {
    return { health: { privateUrl: `http://127.0.0.1:${port}/health` }, maintenance: {
        boundary: { mode: 'local-origin-listener/v1', originHost: '127.0.0.1', originPort: port },
        responderPort: 3311, cloudflared: { originHost: '127.0.0.1', originPort: port } } };
}
function currentListenerClaim() {
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    return { pid: process.pid, uid: process.getuid(), startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
}
async function listening(t, host, port = 0) {
    const server = net.createServer(socket => socket.end());
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({host, port}, resolve); });
    t.after(() => new Promise(resolve => server.close(resolve))); return server;
}
test('B816 listener binds real isolated process/socket and rejects wildcard, IPv6 and sibling listeners', async t => {
    await t.test('loopback and process ownership', async child => {
        const server = await listening(child, '127.0.0.1'), config = listenerConfig(server.address().port), claim = currentListenerClaim();
        const observed = observeOriginListener(config, claim);
        assert.equal(observed.family, 'tcp'); assert.equal(observed.address, '0100007F'); assert.match(observed.inode, /^[1-9][0-9]*$/);
        assert.throws(() => observeOriginListener(config, {...claim, startTicks: '0'}), /listener_process_mismatch/);
        assert.throws(() => observeOriginListener(config, {...claim, uid: claim.uid + 1}), /listener_process_mismatch/);
        const sibling = await listening(child, '127.0.0.2', server.address().port);
        assert.throws(() => observeOriginListener(config, claim), /listener_topology/); assert.ok(sibling.listening);
    });
    for (const host of ['0.0.0.0', '::1']) await t.test(host, async child => {
        const server = await listening(child, host);
        assert.throws(() => observeOriginListener(listenerConfig(server.address().port), currentListenerClaim()), /listener_topology/);
    });
});
test('B816 routing evidence accepts owned 0771 data directories but rejects aliases and unsafe files', t => {
    const root = fs.mkdtempSync(path.join(TEMP, 'routing-evidence-')); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
    const data = path.join(root, 'config'); fs.mkdirSync(data, {mode: 0o771}); fs.chmodSync(data, 0o771);
    const file = path.join(data, 'ingress.yml'); fs.writeFileSync(file, 'service: http://127.0.0.1:3004', {mode: 0o600});
    const result = readRoutingEvidence(file, process.getuid()); assert.equal(result.sha256, sha(fs.readFileSync(file)));
    assert.equal(result.text, 'service: http://127.0.0.1:3004');
    fs.symlinkSync(file, file + '.link'); assert.throws(() => readRoutingEvidence(file + '.link', process.getuid()), /routing_path/);
    fs.linkSync(file, file + '.hard'); assert.throws(() => readRoutingEvidence(file, process.getuid()), /routing_file/); fs.unlinkSync(file + '.hard');
    fs.chmodSync(file, 0o622); assert.throws(() => readRoutingEvidence(file, process.getuid()), /routing_file/); fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, Buffer.alloc(262145)); assert.throws(() => readRoutingEvidence(file, process.getuid()), /routing_file/);
});
test('B816 scoped manager names cannot select a different UID or silently fall back to system', () => {
    const account = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(row => row.split(':')).find(row => Number(row[2]) === process.getuid());
    const manager = {scope: 'user', user: account[0], managerUid: process.getuid(), unit: 'cloudflared.service'};
    assert.deepEqual(ingressManager(manager), manager);
    assert.deepEqual(ingressShowArgs(manager, ['MainPID']), ['--user', `--machine=${account[0]}@.host`, 'show', 'cloudflared.service', '--property=MainPID', '--value']);
    assert.throws(() => ingressManager({...manager, managerUid: process.getuid() + 1}), /manager_account_mismatch/);
    assert.throws(() => ingressManager({...manager, user: 'x;echo unsafe'}), /manager_contract/);
    assert.deepEqual(ingressShowArgs(ingressManager({scope: 'system', user: null, managerUid: 0, unit: manager.unit}), ['MainPID']),
        ['show', 'cloudflared.service', '--property=MainPID', '--value']);
});
test('B816 listener contract fixes target host/port and offers no configurable private UID bypass', () => {
    const config = listenerConfig(); assert.equal(listenerBoundary(config).originPort, 3004);
    assert.throws(() => listenerBoundary({...config, maintenance: {...config.maintenance, boundary: {...config.maintenance.boundary, bypassUid: 1000}}}), /listener_contract/);
    assert.throws(() => listenerBoundary({...config, forwardActivation: {supervisorPlan: {mutation: {targetDescriptor: {env: {HOST: '0.0.0.0', PORT: '3004'}}}}}}), /listener_target_policy/);
    config.maintenance.cloudflared.uid = 1234;
    assert.equal(buildListenerFenceRules(config).includes('1234'), false);
    assert.match(buildListenerFenceRules(config), /meta skuid != 0 fib daddr type local/);
});

test('B975 only the measured conntrack zero-flow result is idempotent, never a permission or execution failure', () => {
    const result = {status:1,stdout:'',stderr:'conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted.\n'};
    assert.equal(hostOperationsTestables.emptyConntrackDeletion(result), true);
    for (const changed of [{status:2}, {status:null}, {code:'ETIMEDOUT'}, {signal:'SIGKILL'}, {stdout:'unexpected'}, {stderr:'Operation not permitted'},
        {stderr:'conntrack v1.4.8 (conntrack-tools): Operation failed: sorry, you must be root or get CAP_NET_ADMIN capability to do this\n'},
        {stderr:result.stderr+'Permission denied\n'}, {stderr:'conntrack v1.4.8 (conntrack-tools): 1 flow entries have been deleted.\n'}]) {
        assert.equal(hostOperationsTestables.emptyConntrackDeletion({...result,...changed}), false);
    }
});

test('B975 pinned execution handles empty conntrack only at the explicit deletion boundary', () => {
    const binary = '/usr/bin/dash', digest = sha(fs.readFileSync(binary));
    const zero = ['-c', "printf '%s\\n' 'conntrack v1.4.8 (conntrack-tools): 0 flow entries have been deleted.' >&2; exit 1"];
    const options = {allowEmptyConntrackDeletion:true};
    const deps = {verifyPinnedExecutable(){}}; // Only root metadata is simulated; real retained-FD execution and digest remain.
    assert.equal(hostOperationsTestables.runPinnedExecutable(binary,digest,zero,deps,options), '');
    assert.throws(() => hostOperationsTestables.runPinnedExecutable(binary,digest,zero,deps,{}), /host_operation_command_failed/);
    assert.throws(() => hostOperationsTestables.runPinnedExecutable(binary,digest,['-c',"printf 'Operation not permitted\\n' >&2; exit 1"],deps,options), /host_operation_command_failed/);
});
