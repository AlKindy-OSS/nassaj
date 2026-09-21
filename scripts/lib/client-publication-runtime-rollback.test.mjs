import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { publishDevClient, reconcileDevClientPublication } from './client-publication-executor.mjs';
import { computeClientBuildId } from '../client-build-atomic.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { recordFullClientPublicationBaseline, captureClientPublicationBaseline, recordClientPublicationRollbackBaseline } from './client-publication-baseline.mjs';
import { readClientPublicationRuntime, readClientPublicationServing, recordClientPublicationServing } from './client-publication-runtime.mjs';
import { createClientAssetManifest, validateClientAssetManifest, clientPublicationDigest as digest } from './client-publication-artifacts.mjs';
import { installUpdateRuntimeBundle } from './update-runtime-bundle.mjs';
import { writeClientPublicationIntent, advanceClientPublicationJournal, writeClientPublicationOutcome } from './client-publication-journal.mjs';
import { computeOidTripleTargetDigest } from './oid-triple-target.mjs';
import { validateOidPairTerminal } from '../oid-control-capsule.mjs';
const H = digit => digit.repeat(64);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const processIdentity = pid => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return { pid, startTime: stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19] };
};
function generation(root, buildId, oid, directory = `${root}/dist`, generationId = buildId) {
    fs.mkdirSync(directory, { recursive: true });
    write(`${directory}/version.json`, { buildId });
    write(`${directory}/BUILD_PROVENANCE.json`, { artifact: 'client', buildId, commit: oid });
    fs.writeFileSync(`${directory}/index.html`, `<html>${buildId}</html>`);
    createClientAssetManifest(directory, { generationId, buildId, sourceOid: oid }, () => {});
    const sealed = validateClientAssetManifest(directory, {}, () => {});
    const archive = `${root}/.nassaj-local-preview/client-assets/generations/${generationId}`;
    fs.mkdirSync(path.dirname(archive), { recursive: true }); fs.cpSync(directory, archive, { recursive: true });
    return { sourceOid: oid, buildId, treeDigest: sealed.treeDigest, assetManifestDigest: sealed.manifestDigest };
}
function httpProof(root) {
    return { schema: 'nassaj-client-http-serving/v1', files: ['index.html', 'version.json'].map(name => ({ path: name, status: 200,
        sha256: digest(fs.readFileSync(`${root}/dist/${name}`)) })) };
}
function targetFixture() {
    return { schema: 'nassaj-oid-triple-target/v2', generationNames: ['nodeModules', 'server', 'client'],
        ...Object.fromEntries(['clientBuildId', 'serverBuildId', 'clientTreeSha256', 'serverTreeSha256', 'nodeModulesTreeSha256',
            'dependencyContractSha256', 'packageJsonSha256', 'packageLockSha256', 'installPolicySha256', 'controlManifestSha256'].map(key => [key, H('d')])),
        installRuntime: { nodeBinarySha256: H('d'), nodeVersion: 'v24.17.0', nodeModuleAbi: '137', napi: '10', platform: 'linux', arch: 'x64', npmVersion: '12.0.2', npmCliSha256: H('d') } };
}
async function fixture(t) {
    const root = fs.mkdtempSync(path.resolve('.test-rollback-reader-'));
    const oldProcess = spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise(resolve => oldProcess.stdout.once('data', resolve));
    t.after(async () => { oldProcess.kill(); await new Promise(resolve => oldProcess.once('exit', resolve)); execFileSync('chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true }); });
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline');
    const oid = git('rev-parse', 'HEAD'), server = `${root}/dist-server`;
    fs.mkdirSync(server); fs.writeFileSync(`${root}/entry.mjs`, 'export const fixture=true;');
    const bundle = installUpdateRuntimeBundle(root, server, { entries: ['entry.mjs'] });
    write(`${server}/OID_CONTROL_MANIFEST.json`, { oid, serverBuildId: H('a'), updateRuntimeBuildId: bundle.manifest.buildId,
        capabilities: { clientPublicationV1: 'nassaj-dev-client-publication/v1' } });
    const b0 = generation(root, H('a'), oid), originalProcess = processIdentity(oldProcess.pid);
    const fullProof = { sequence: 1, transactionNonce: H('1'), outcome: 'served', ...originalProcess, serverBuildId: H('a'), clientBuildId: H('a'), nodeModulesTreeSha256: H('e') };
    write(`${root}/.git/nassaj-oid-pair-serving-${H('1')}.json`, fullProof);
    const binding = recordFullClientPublicationBaseline(root, fullProof, { verifyClosure: () => {}, rollbackDirectories: [] });
    const parent = readClientPublicationServing(root).receiptDigest;
    fs.renameSync(`${root}/dist`, `${root}/b0`); const a2 = generation(root, H('b'), oid);
    const intent = { schema: 'nassaj-oid-client-publication/v1', kind: 'client-publication', sequence: 2, transactionNonce: H('2'), sourceOid: oid,
        policyRevision: 1, reservationId: 'a2', baseReceiptDigest: binding.baseReceiptDigest, parentServingReceiptDigest: parent,
        serverIdentity: binding.serverIdentity, dependencyIdentity: binding.dependencyIdentity, previousClientIdentity: b0, targetClientIdentity: a2,
        candidateManifestDigest: a2.treeDigest, compatibilityProofDigest: H('c'), assetManifestDigest: a2.assetManifestDigest };
    let publication = writeClientPublicationIntent(root, intent);
    publication = advanceClientPublicationJournal(root, publication, 'publishing'); publication = advanceClientPublicationJournal(root, publication, 'verifying');
    const outcome = writeClientPublicationOutcome(root, publication, { outcome: 'served', actualServerIdentity: binding.serverIdentity,
        parentServingReceiptDigest: parent, servingEvidence: httpProof(root) });
    recordClientPublicationServing(root, outcome, { expectedParentReceiptDigest: parent });
    const previous = { clientBuildId: a2.buildId, clientOid: oid, clientTreeSha256: a2.treeDigest, serverBuildId: H('a'),
        controlManifestSha256: binding.installedControlDigest, nodeModulesTreeSha256: H('e'), runtime: originalProcess };
    previous.clientPublication = captureClientPublicationBaseline(root, previous);
    const sequence = 3, nonce = H('3'), group = 'event-0000000000000003', target = targetFixture();
    const targetDigest = computeOidTripleTargetDigest({ sequence, group, sourceOid: oid, target }), current = processIdentity(process.pid);
    const receipt = { schema: 'nassaj-oid-triple-terminal/v2', generationNames: target.generationNames, transactionNonce: nonce, outcome: 'rolled_back',
        targetDigest, clientBuildId: a2.buildId, serverBuildId: H('a'), nodeModulesTreeSha256: H('e'), ...current,
        serverOid: oid, clientBuildIdServed: a2.buildId, oidNodeModulesTreeSha256: H('e'), oidPairTargetDigest: targetDigest, http: httpProof(root) };
    const receiptFile = `${root}/.git/nassaj-oid-pair-receipt-${nonce}.json`; write(receiptFile, receipt);
    const transaction = { schema: 'nassaj-oid-control-transaction/v2', sequence, group, oid, transactionNonce: nonce, bootNonce: H('4'),
        generationNames: target.generationNames, state: 'pair_rolled_back', persistence: { online: { state: 'verified', status: 'online', dumpSha256: H('5'), ...current, bootNonce: H('4') } },
        pair: { target, targetDigest, previous, databaseState: 'PRE_CANDIDATE', receipt, receiptSha256: digest(fs.readFileSync(receiptFile)) } };
    const journalFile = `${root}/.git/nassaj-oid-control-transaction-${sequence}-${nonce}.json`; write(journalFile, transaction);
    assert.equal(validateOidPairTerminal(root, transaction), true);
    const restored = recordClientPublicationRollbackBaseline(root, transaction, { validateTerminal: validateOidPairTerminal, verifyClosure: () => {} });
    return { root, binding, restored, transaction, journalFile, receiptFile, runtimeFile: `${root}/.git/nassaj-client-publication-runtime-v1.json`, a2, current };
}

test('real rollback writer → reader accepts a new PID while retaining B0 authority and A2 lineage', async t => {
    const v = await fixture(t), actual = readClientPublicationRuntime(v.root);
    assert.equal(actual.serverIdentity.pid, process.pid); assert.notEqual(actual.serverIdentity.pid, v.binding.serverIdentity.pid);
    for (const key of ['baseReceiptDigest', 'fullReceipt', 'installationId', 'dependencyIdentity', 'updateRuntimeBuildId', 'capabilities']) assert.deepEqual(actual[key], v.binding[key]);
    assert.equal(actual.capabilities.rollback, undefined);
    assert.equal(readClientPublicationServing(v.root).buildId, v.a2.buildId);
    assert.equal(actual.processReceipt.journalDigest, digest(fs.readFileSync(v.journalFile)));
});

test('corrupt process receipt, other transaction and added authority are rejected without PID fallback', async t => {
    const v = await fixture(t);
    for (const patch of [{ processReceipt: null }, { processReceipt: { ...v.restored.processReceipt, journalDigest: undefined } },
        { processReceipt: { ...v.restored.processReceipt, transactionNonce: H('6') } },
        { processReceipt: { ...v.restored.processReceipt, receiptDigest: H('6') } },
        { capabilities: { ...v.restored.capabilities, rollback: 'nassaj-dev-client-publication/v1' } }]) {
        write(v.runtimeFile, { ...v.restored, ...patch }); assert.throws(() => readClientPublicationRuntime(v.root));
    }
    write(v.runtimeFile, { ...v.restored, processReceipt: undefined });
    assert.throws(() => readClientPublicationRuntime(v.root), /full_receipt_invalid/);
});

test('UNKNOWN, snapshot mutation, journal changes and wrong HTTP previous identity remain fenced', async t => {
    const v = await fixture(t);
    const variants = [
        { ...v.transaction, pair: { ...v.transaction.pair, databaseState: 'UNKNOWN' } },
        { ...v.transaction, pair: { ...v.transaction.pair, previous: { ...v.transaction.pair.previous, clientPublication: { ...v.transaction.pair.previous.clientPublication, snapshotDigest: H('7') } } } },
    ];
    for (const transaction of variants) {
        write(v.journalFile, transaction);
        write(v.runtimeFile, { ...v.restored, processReceipt: { ...v.restored.processReceipt, journalDigest: digest(fs.readFileSync(v.journalFile)) } });
        assert.throws(() => readClientPublicationRuntime(v.root));
    }
    write(v.journalFile, v.transaction); write(v.runtimeFile, v.restored);
    fs.appendFileSync(v.journalFile, '\n'); assert.throws(() => readClientPublicationRuntime(v.root), /terminal_invalid/);
    write(v.journalFile, v.transaction);
    const receipt = { ...v.transaction.pair.receipt, http: { ...v.transaction.pair.receipt.http, files: [] } };
    write(v.receiptFile, receipt);
    const transaction = { ...v.transaction, pair: { ...v.transaction.pair, receipt, receiptSha256: digest(fs.readFileSync(v.receiptFile)) } };
    write(v.journalFile, transaction);
    write(v.runtimeFile, { ...v.restored, processReceipt: { ...v.restored.processReceipt, receiptDigest: transaction.pair.receiptSha256, journalDigest: digest(fs.readFileSync(v.journalFile)) } });
    assert.throws(() => readClientPublicationRuntime(v.root), /http_invalid/);
});

function publicationContext(v, baseline, parent, buildId, server, interrupt) {
    const observed = { afterExchange: 0 };
    const context = {
        servingOrigin: `http://127.0.0.1:${server.address().port}`,
        withEventLock: async (_root, operation) => operation(),
        revalidate: () => assert.deepEqual(readClientPublicationRuntime(v.root).serverIdentity, baseline.serverIdentity),
        beforeEffect: () => {}, readServingLineage: readClientPublicationServing,
        readActualServerIdentity: () => {
            assert.equal(readClientPublicationServing(v.root).receiptDigest, parent.receiptDigest);
            assert.equal(validateClientAssetManifest(`${v.root}/dist`, {}, () => {}).manifest.buildId, buildId);
            observed.afterExchange++;
            return readClientPublicationRuntime(v.root).serverIdentity;
        },
        recordServingLineage: (...args) => {
            if (interrupt) throw new Error('fixture_crash_before_pointer');
            return recordClientPublicationServing(...args);
        },
    };
    return { context, observed };
}

async function publicationAfterRollback(t, v, sequence, interrupt = false) {
    fs.mkdirSync(`${v.root}/src`, { recursive: true });
    fs.writeFileSync(`${v.root}/src/app.css`, `body { opacity: .${sequence}; }`);
    const git = (...args) => execFileSync('git', args, { cwd: v.root, encoding: 'utf8' }).trim();
    git('add', 'src/app.css');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', `client ${sequence}`);
    const sourceOid = git('rev-parse', 'HEAD');
    const sourceRoot = `${v.root}/.nassaj-local-preview/oid-snapshots/${sourceOid}`;
    fs.mkdirSync(`${sourceRoot}/src`, { recursive: true });
    fs.writeFileSync(`${sourceRoot}/src/app.css`, fs.readFileSync(`${v.root}/src/app.css`), { mode: 0o444 });
    fs.chmodSync(`${sourceRoot}/src`, 0o555);
    fs.chmodSync(sourceRoot, 0o555);
    t.after(() => { if (fs.existsSync(sourceRoot)) { fs.chmodSync(sourceRoot, 0o755); fs.chmodSync(`${sourceRoot}/src`, 0o755); } });
    const buildId = computeClientBuildId(sourceRoot), generationId = digest({ sourceOid, buildId });
    const candidate = `${v.root}/.nassaj-local-preview/dev-client-candidates/${sequence}-${generationId}`;
    generation(v.root, buildId, sourceOid, candidate, generationId);
    const baseline = readClientPublicationRuntime(v.root), parent = readClientPublicationServing(v.root);
    const server = createServer((request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.end(fs.readFileSync(`${v.root}/dist/${request.url === '/' ? 'index.html' : 'version.json'}`));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const { context, observed } = publicationContext(v, baseline, parent, buildId, server, interrupt);
    const options = { root: v.root, sourceRoot, event: { sequence, oid: sourceOid }, policy: { revision: 1 }, baseline,
        reservationId: `after-rollback-${sequence}`, parentServingReceiptDigest: parent.receiptDigest };
    if (interrupt) {
        await assert.rejects(publishDevClient(options, context), /fixture_crash_before_pointer/);
        const name = fs.readdirSync(`${v.root}/.git`).find(name => name.startsWith(`nassaj-oid-control-transaction-${sequence}-`));
        const file = `${v.root}/.git/${name}`;
        context.recordServingLineage = recordClientPublicationServing;
        await reconcileDevClientPublication({ root: v.root, journal: { file, value: JSON.parse(fs.readFileSync(file)) } }, context);
    } else {
        const result = await publishDevClient(options, context);
        assert.equal(result.receipt.outcome, 'served');
        assert.equal(result.receipt.servingProof.serverIdentity.pid, process.pid);
    }
    assert.equal(observed.afterExchange, 1);
    assert.equal(readClientPublicationServing(v.root).buildId, buildId);
    assert.deepEqual(readClientPublicationRuntime(v.root).serverIdentity, baseline.serverIdentity);
}

test('rollback writer → new PID reader → real exchange and HTTP proof → second publication', async t => {
    const v = await fixture(t);
    await publicationAfterRollback(t, v, 4);
    await publicationAfterRollback(t, v, 5);
});

test('rollback process remains qualified across durable outcome → pointer crash and recovery', async t => {
    const v = await fixture(t);
    await publicationAfterRollback(t, v, 4, true);
    await publicationAfterRollback(t, v, 5);
});


test('historical rollback archive tampering remains rejected after process requalification', async t => {
    const v = await fixture(t);
    const archived = `${v.root}/.nassaj-local-preview/client-assets/generations/${v.a2.buildId}/index.html`;
    fs.writeFileSync(archived, '<html>tampered</html>');
    assert.throws(() => readClientPublicationRuntime(v.root), /client_asset_manifest_changed/);
});
