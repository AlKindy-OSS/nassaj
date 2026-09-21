/** Synthetic bootstrap completion used only by consumer integration tests; never activation authority. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { computeOidTripleTargetDigest } from '../lib/oid-triple-target.mjs';
import { bootstrapExecutableClosure, retainOidTripleExecutor } from '../preview-oid-capsule-launcher.mjs';
import { createBootstrapTicket, consumeBootstrapTicket, bootstrapJournalBinding } from '../lib/local-source-bootstrap-ticket.mjs';

const H = 'a'.repeat(64), hash = bytes => createHash('sha256').update(bytes).digest('hex');
function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    fs.writeFileSync(file, bytes, { mode: 0o600 }); return hash(bytes);
}
function executable() {
    const input = { capsule: fs.readFileSync(new URL('../oid-control-capsule.mjs', import.meta.url)), launcher: Buffer.from('fixture-launcher'), safeRestart: Buffer.from('fixture-safe'),
        externalRuntimeClosures: ['node', 'python-peer-reader', 'pm2-package'].map(kind => ({ kind, sha256: H })) };
    const manifest = { capabilities: { oidTripleAdmissionV2: true } };
    for (const key of ['capsule', 'launcher', 'safeRestart']) {
        manifest[`${key}Sha256`] = hash(input[key]); manifest[`${key}Size`] = input[key].length;
    }
    return { ...input, manifestBytes: Buffer.from(JSON.stringify(manifest)) };
}
function material(root, manifest, target, code) {
    const installation = { root, commonGit: `${root}/.git`, hostname: os.hostname(), serviceUid: process.getuid() };
    const event = { sequence: 1, group: 'event-0000000000000001', oid: manifest.releaseCommit, targetDigest: H,
        manifestSha256: write(path.join(root, 'candidate-manifest.json'), manifest) };
    event.targetDigest = computeOidTripleTargetDigest({ ...event, sourceOid: event.oid, target });
    const databasePath = path.join(root, 'appdata/app.db'); write(databasePath, 'synthetic-database-bytes');
    const stat = fs.statSync(databasePath);
    return { installation, event, approval: { ownerId: '1', receiptSha256: H },
        previous: { pid: 42, ppid: 40, startTicks: '123', clientBuildId: H, serverBuildId: H, controlManifestSha256: H,
            clientTreeSha256: H, serverTreeSha256: H, nodeModulesTreeSha256: H },
        supervisor: { pid: 40, startTicks: '122', observerSha256: H, slotSha256: H, environmentSha256: H, dumpSha256: H },
        database: { path: databasePath, dev: String(stat.dev), ino: String(stat.ino) },
        mode: { original: 'release', proposed: 'local-main', originalEnvSha256: H,
            proposalEnvSha256: write(path.join(root, '.env'), 'NASSAJ_UPDATE_MODE=local-main\n') },
        baseline: { attestationSha256: H, rehearsalSha256: H }, executor: { codeClosureSha256: code.sha256, transactionNonce: 'c'.repeat(64) } };
}
function terminalFixture(root, target, expected, reference, binding, runtime) {
    const nonce = expected.executor.transactionNonce, common = path.join(root, '.git'), actionId = '11111111-1111-1111-1111-111111111111';
    const receipt = { schema: 'nassaj-oid-triple-terminal/v2', generationNames: target.generationNames, outcome: 'activated',
        transactionNonce: nonce, targetDigest: expected.event.targetDigest, clientBuildId: H, serverBuildId: H,
        nodeModulesTreeSha256: H, pid: runtime.pid, startTime: runtime.startTime };
    const receiptSha256 = write(path.join(common, `nassaj-oid-pair-receipt-${nonce}.json`), receipt);
    const journal = { schema: 'nassaj-oid-control-transaction/v2', generationNames: target.generationNames,
        sequence: 1, group: expected.event.group, oid: expected.event.oid, transactionNonce: nonce, actionId,
        state: 'pair_served', recoveryReference: reference, bootstrap: binding, oldStoppedAt: 1, bootNonce: H,
        pair: { target, targetDigest: expected.event.targetDigest, receipt, receiptSha256, databaseState: 'TARGET_VERIFIED', activationNotClaimed: false },
        persistence: { online: { state: 'verified', status: 'online', dumpSha256: H, pid: runtime.pid, startTime: runtime.startTime, bootNonce: H } } };
    write(path.join(common, `nassaj-oid-control-transaction-1-${nonce}.json`), journal);
    const serving = { ...receipt, schema: 'nassaj-oid-triple-serving/v2', outcome: 'served', sequence: 1, actionId, servedAt: 1 };
    return { serving, servingSha256: write(path.join(common, `nassaj-oid-pair-serving-${nonce}.json`), serving) };
}

/** Build byte-bound synthetic retained/claim/terminal evidence around a real consumer bundle fixture. */
export function attachCompletedConsumerBootstrap(fixture, createQualification) {
    const root = fixture.directory;
    if (!root.includes('/.artifacts/')) throw new Error('synthetic_fixture_scope');
    fs.chmodSync(path.join(root, '.git'), 0o700);
    const target = { schema: 'nassaj-oid-triple-target/v2', generationNames: ['nodeModules', 'server', 'client'],
        installRuntime: { nodeBinarySha256: H, nodeVersion: process.version, nodeModuleAbi: process.versions.modules,
            napi: process.versions.napi, platform: process.platform, arch: process.arch, npmVersion: '11.0.0', npmCliSha256: H } };
    for (const key of ['clientBuildId', 'serverBuildId', 'clientTreeSha256', 'serverTreeSha256', 'nodeModulesTreeSha256',
        'dependencyContractSha256', 'packageJsonSha256', 'packageLockSha256', 'installPolicySha256', 'controlManifestSha256']) target[key] = H;
    const input = executable(), code = bootstrapExecutableClosure(input), expected = material(root, fixture.bundle.manifest, target, code);
    const qualification = createQualification(expected, input);
    expected.baseline = qualification.baseline;
    const ticket = createBootstrapTicket(expected), nonce = expected.executor.transactionNonce;
    const runtime = { pid: process.pid, startTime: fs.readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19], bootId: ticket.bootId };
    const record = { repoRoot: root, actionId: '11111111-1111-1111-1111-111111111111', transactionNonce: nonce,
        pair: { targetDigest: expected.event.targetDigest }, bootstrap: { ticket, qualificationReference: qualification.reference,
            previousMaterial: qualification.previousMaterial, previousControlManifestBase64: qualification.previousControlManifestBase64 } };
    const reference = retainOidTripleExecutor(root, { ...input, record }), consumed = consumeBootstrapTicket(ticket, expected, runtime);
    const binding = bootstrapJournalBinding(ticket, consumed), { serving, servingSha256 } = terminalFixture(root, target, expected, reference, binding, runtime);
    Object.assign(fixture.packet, { manifestPath: path.join(root, 'candidate-manifest.json'), appDataGuard: qualification.appDataGuard,
        bootstrapCompletion: { sequence: 1, transactionNonce: nonce, actionId: record.actionId, targetDigest: expected.event.targetDigest,
            receiptSha256: servingSha256, ...Object.fromEntries(Object.entries(binding).filter(([key]) => key !== 'schema')) } });
    return { ...fixture.fixture.completed.health, pid: runtime.pid, serverProcessStartTicks: runtime.startTime,
        serverLoadedOid: expected.event.oid, serverLoadedBuildId: H, clientBuildIdServed: H, serverTransactionNonce: nonce,
        oidPairTransactionNonce: nonce, oidPairTargetDigest: serving.targetDigest, oidNodeModulesTreeSha256: H };
}
