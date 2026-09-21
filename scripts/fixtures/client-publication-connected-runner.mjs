/** Connected publication test: real publishers/readers/capsule helpers, tiny tool and serving-process fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installUpdateRuntimeBundle, verifyUpdateRuntimeBundle } from '../lib/update-runtime-bundle.mjs';
import { recordFullClientPublicationBaseline } from '../lib/client-publication-baseline.mjs';
import { readClientPublicationRuntime, readClientPublicationServing, recordClientPublicationServing } from '../lib/client-publication-runtime.mjs';
import { createClientAssetManifest, validateClientAssetManifest, clientPublicationDigest as digest } from '../lib/client-publication-artifacts.mjs';
import { publishDevClient } from '../lib/client-publication-executor.mjs';
import { reserveClientPublication, transitionClientPublication, transitionClientPublicationUnlocked } from '../lib/client-publication-control.mjs';
import { assertClientPublicationPolicy } from '../lib/client-publication-policy.mjs';
import { withPreviewEventMutationLock } from '../preview-oid-consumer.mjs';
import { verifyAssetClosure } from '../client-build-atomic.mjs';
import { captureOidTriplePreviousGeneration, prepareOidTriplePublicationSnapshot, hashOidPairTree,
    hashOidPairDependencyTree, prepareOidTripleDependencyExchange, oidTripleDependencySlot, inspectOidTripleGenerationPlan } from '../oid-control-capsule.mjs';
import { hashDependencyTreeV2 } from '../lib/dependency-tree-identity-v2.mjs';

const [root, project, hostNetwork] = process.argv.slice(2);
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), hostNetwork);
const H = n => String(n).repeat(64);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const git = (...args) => execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
const serverRoot = path.join(root, 'dist-server');
const policyFile = path.join(root, '.git/nassaj-client-publication-policy-v1.json');
let loadedOid, loadedBuild, failedHttpBuild = null;
const requests = [];
const startTime = fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(/\s+/)[19];

function source(css) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/app.css'), css);
    if (!fs.existsSync(path.join(root, 'package.json'))) write(path.join(root, 'package.json'), { version: '1.0.0.0' });
    git('add', 'src/app.css', 'package.json'); git('commit', '-qm', css);
    const oid = git('rev-parse', 'HEAD'), directory = path.join(root, '.nassaj-local-preview/oid-snapshots', oid);
    fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
    for (const name of ['package.json', 'src/app.css']) {
        fs.writeFileSync(path.join(directory, name), fs.readFileSync(path.join(root, name)), { mode: 0o444 });
    }
    fs.chmodSync(path.join(directory, 'src'), 0o555); fs.chmodSync(directory, 0o555);
    return { oid, directory };
}

function tinyTools(directory, version = 'old') {
    fs.mkdirSync(path.join(directory, 'typescript/bin'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(directory, 'vite/bin'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'typescript/bin/tsc'), 'process.exit(0)', { mode: 0o444 });
    fs.writeFileSync(path.join(directory, 'fixture-version'), version, { mode: 0o444 });
    // Keep the real installed loadEnv API for consumer imports; only the build CLI is a tiny fixture.
    const viteEntry = pathToFileURL(createRequire(import.meta.url).resolve('vite')).href;
    fs.writeFileSync(path.join(directory, 'vite/package.json'), JSON.stringify({ exports: './index.mjs' }), { mode: 0o444 });
    fs.writeFileSync(path.join(directory, 'vite/index.mjs'), `export { loadEnv } from ${JSON.stringify(viteEntry)};`, { mode: 0o444 });
    fs.writeFileSync(path.join(directory, 'vite/bin/vite.js'), `const fs=require('fs'),p=require('path'),d=process.env.NASSAJ_CLIENT_OUT_DIR,b=process.env.NASSAJ_BUILD_ID,g=process.env.NASSAJ_CLIENT_GENERATION_ID;fs.mkdirSync(p.join(d,'assets'),{recursive:true});fs.writeFileSync(p.join(d,'assets/app.js'),"console.log('"+b+"')");fs.writeFileSync(p.join(d,'version.json'),JSON.stringify({buildId:b}));fs.writeFileSync(p.join(d,'index.html'),'<script src="/assets/generations/'+g+'/assets/app.js"></script>');`, { mode: 0o444 });
    for (const name of ['typescript/bin', 'typescript', 'vite/bin', 'vite']) fs.chmodSync(path.join(directory, name), 0o555);
    fs.chmodSync(directory, 0o700);
}

function generation(directory, oid, buildId) {
    fs.mkdirSync(path.join(directory, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.html'), `<script src="/assets/generations/${buildId}/assets/app.js"></script>`);
    fs.writeFileSync(path.join(directory, 'assets/app.js'), `console.log('${buildId}')`);
    write(path.join(directory, 'version.json'), { buildId });
    write(path.join(directory, 'BUILD_PROVENANCE.json'), { artifact: 'client', commit: oid, baseCommit: oid, dirty: false, buildId, generationId: buildId });
    createClientAssetManifest(directory, { sourceOid: oid, buildId, generationId: buildId }, verifyAssetClosure);
}

function serverGeneration(directory, oid, buildId, bundle) {
    write(path.join(directory, 'BUILD_PROVENANCE.json'), { artifact: 'server', commit: oid, baseCommit: oid, dirty: false, buildId });
    write(path.join(directory, 'OID_CONTROL_MANIFEST.json'), { oid, serverBuildId: buildId, updateRuntimeBuildId: bundle.manifest.buildId,
        capabilities: { clientPublicationV1: 'nassaj-dev-client-publication/v1' } });
}

async function fullBaseline(oid, buildId, sequence) {
    loadedOid = oid; loadedBuild = buildId;
    const receipt = { sequence, transactionNonce: H(sequence), outcome: 'served', pid: process.pid, startTime,
        serverBuildId: buildId, clientBuildId: buildId, nodeModulesTreeSha256: hashDependencyTreeV2(path.join(root, 'node_modules')).sha256 };
    write(path.join(root, '.git', `nassaj-oid-pair-serving-${receipt.transactionNonce}.json`), receipt);
    return withPreviewEventMutationLock(root, () => recordFullClientPublicationBaseline(root, receipt, {
        verifyClosure: verifyAssetClosure, rollbackDirectories: [serverRoot] }));
}

async function publish(binding, revision, sequence, failHttp = false, faultBeforeLineage = false) {
    write(policyFile, { ...binding, schema: 'nassaj-client-publication-policy/v1', mode: 'dev-client-auto', revision: 1 });
    const event = { sequence, oid: revision.oid, domains: ['client'] };
    let reservation = await reserveClientPublication(root, event, binding);
    const parent = readClientPublicationServing(root).receiptDigest;
    const context = { servingOrigin: 'http://127.0.0.1:3004', withEventLock: withPreviewEventMutationLock,
        readServingLineage: readClientPublicationServing,
        recordServingLineage: (...args) => {
            if (faultBeforeLineage) throw new Error('fixture_crash_after_durable_outcome');
            return recordClientPublicationServing(...args);
        },
        readActualServerIdentity: () => readClientPublicationRuntime(root).serverIdentity,
        revalidate: () => {
            assertClientPublicationPolicy(root, readClientPublicationRuntime(root), 1);
            assert.equal(git('rev-parse', 'HEAD'), revision.oid);
        }, beforeEffect: journal => {
            reservation = transitionClientPublicationUnlocked(root, reservation, { phase: 'publishing', effect: 'started' });
            if (failHttp) failedHttpBuild = journal.targetClientIdentity.buildId;
        } };
    const result = await publishDevClient({ root, sourceRoot: revision.directory, event, policy: { revision: 1 },
        reservationId: reservation.reservationId, parentServingReceiptDigest: parent, baseline: binding }, context);
    await transitionClientPublication(root, reservation, { phase: result.receipt.outcome, effect: 'settled', receiptDigest: result.receiptDigest });
    return result;
}

async function restartConsumer() {
    const child = spawn(process.execPath, [path.join(project, 'scripts/client-publication-consumer-launcher.mjs')], {
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NASSAJ_UPDATE_MODE: 'release',
            NASSAJ_PREVIEW_OID_ENFORCEMENT: '1', NASSAJ_PREVIEW_OID_DOMAINS: 'client' } });
    let stderr = '';
    child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 8000);
    try {
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
        assert.equal(code, 1, stderr); assert.match(stderr, /node_update_button_required/);
    } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
        }
    }
}

function exchange(live, candidate) {
    const result = spawnSync('/usr/bin/mv', ['--exchange', '--no-copy', '-T', live, candidate], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
}

async function prepareFull(a2, b1) {
    const previous = await captureOidTriplePreviousGeneration(root, { runtimeDependenciesSha256: hashOidPairDependencyTree(path.join(root, 'node_modules')) });
    assert.equal(previous.clientOid, a2.intent.sourceOid); assert.equal(previous.runtime.oid, loadedOid);
    const client = path.join(root, '.nassaj-local-preview/client-candidates', H(5)); generation(client, b1.oid, H(5));
    const server = path.join(root, '.nassaj-local-preview/server-candidates', H(5)); fs.mkdirSync(server, { recursive: true });
    serverGeneration(server, b1.oid, H(5), installUpdateRuntimeBundle(project, server));
    const deps = path.join(root, 'tiny-new-dependencies'); tinyTools(deps, 'new');
    const depHash = hashDependencyTreeV2(deps).sha256, depCandidate = path.join(root, '.nassaj-local-preview/dependency-candidates', depHash);
    const previewRoot = path.join(root, '.nassaj-local-preview');
    const dependencyCandidates = path.dirname(depCandidate);
    fs.mkdirSync(dependencyCandidates, { recursive: true, mode: 0o700 });
    // The triple-copy guard deliberately refuses group-writable source ancestors.
    // Pin fixture-only parents so this remains true when the suite runs under umask 0002.
    fs.chmodSync(previewRoot, 0o700); fs.chmodSync(dependencyCandidates, 0o700);
    fs.renameSync(deps, depCandidate);
    const target = { schema: 'nassaj-oid-triple-target/v2', generationNames: ['nodeModules', 'server', 'client'],
        installRuntime: { ...previous.installRuntime, npmVersion: '12.0.2', npmCliSha256: H(8) }, clientBuildId: H(5), serverBuildId: H(5),
        clientTreeSha256: hashOidPairTree(client), serverTreeSha256: hashOidPairTree(server), nodeModulesTreeSha256: depHash };
    for (const key of ['dependencyContractSha256', 'packageJsonSha256', 'packageLockSha256', 'installPolicySha256', 'controlManifestSha256']) target[key] = H(8);
    const dbPath = path.join(root, 'fixture.sqlite'), database = new DatabaseSync(dbPath);
    database.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,status TEXT); INSERT INTO users VALUES(1,'owner',1,'active')");
    database.close(); fs.chmodSync(dbPath, 0o600);
    const dbBefore = digest(fs.readFileSync(dbPath)), servingBefore = readClientPublicationServing(root);
    const manifestFile = path.join(client, 'CLIENT_ASSET_MANIFEST.json'), manifest = fs.readFileSync(manifestFile);
    const manifestMode = fs.statSync(manifestFile).mode & 0o777;
    fs.chmodSync(manifestFile, 0o600);
    fs.appendFileSync(manifestFile, ' ');
    const identity = { transactionNonce: H(5), actionId: 'connected-full', oid: b1.oid, ownerId: '1' };
    await assert.rejects(prepareOidTriplePublicationSnapshot(root, target, previous, dbPath, identity), /full_client_archive_tree_changed/);
    assert.equal(digest(fs.readFileSync(dbPath)), dbBefore); assert.deepEqual(readClientPublicationServing(root), servingBefore);
    assert.equal(hashOidPairTree(path.join(root, 'dist')), previous.clientTreeSha256);
    assert.equal(fs.existsSync(path.join(root, 'nassaj-update-db-snapshots')), false);
    fs.writeFileSync(manifestFile, manifest); fs.chmodSync(manifestFile, manifestMode);
    const snapshot = await prepareOidTriplePublicationSnapshot(root, target, previous, dbPath, identity);
    assert.equal(snapshot.phase, 'CAPTURED'); assert.equal(digest(fs.readFileSync(dbPath)), dbBefore);
    assert.equal(hashOidPairTree(path.join(root, 'dist')), previous.clientTreeSha256);
    const captured = new DatabaseSync(snapshot.snapshotFile, { readOnly: true });
    try { assert.equal(captured.prepare('SELECT role FROM users WHERE id=?').get(1).role, 'owner'); }
    finally { captured.close(); }
    let transaction = { schema: 'nassaj-oid-control-transaction/v2', generationNames: target.generationNames, transactionNonce: H(5),
        pair: { target, previous, targetDigest: H(8), databaseState: 'PRE_CANDIDATE' } };
    transaction = prepareOidTripleDependencyExchange(root, path.join(root, 'full-generation-plan.json'), transaction);
    return { transaction, locations: { nodeModules: [path.join(root, 'node_modules'), oidTripleDependencySlot(root, transaction)],
        server: [serverRoot, server], client: [path.join(root, 'dist'), client] }, dbPath, dbBefore, previous };
}

function exerciseFullGenerationCuts(full) {
    const { transaction, locations } = full;
    for (const [index, name] of transaction.generationNames.entries()) {
        assert.equal(inspectOidTripleGenerationPlan(root, transaction, 'forward').state, 'verified');
        exchange(...locations[name]);
        const rollback = inspectOidTripleGenerationPlan(root, transaction, 'rollback');
        assert.equal(rollback.state, 'verified');
        assert.equal(rollback.steps.find(step => step.name === name).operation, 'exchange');
        for (const step of rollback.steps) if (step.operation === 'exchange') exchange(...locations[step.name]);
        for (const [part, [live]] of Object.entries(locations)) {
            const actual = part === 'nodeModules' ? hashDependencyTreeV2(live).sha256 : hashOidPairTree(live);
            assert.equal(actual, transaction.pair.previous[`${part}TreeSha256`]);
        }
        for (const part of transaction.generationNames.slice(0, index + 1)) exchange(...locations[part]);
    }
    const unknown = { ...transaction, pair: { ...transaction.pair, databaseState: 'UNKNOWN' } };
    const before = Object.fromEntries(Object.entries(locations).map(([name, [live]]) => [name,
        name === 'nodeModules' ? hashDependencyTreeV2(live).sha256 : hashOidPairTree(live)]));
    assert.equal(inspectOidTripleGenerationPlan(root, unknown, 'rollback').reason, 'database_downgrade_forbidden');
    assert.ok(inspectOidTripleGenerationPlan(root, unknown, 'forward').steps.every(step => step.operation === 'attest'));
    for (const [name, [live]] of Object.entries(locations)) assert.equal(before[name], name === 'nodeModules' ? hashDependencyTreeV2(live).sha256 : hashOidPairTree(live));
    // Separate known-PRE_CANDIDATE branch, not a downgrade of the UNKNOWN branch.
    for (const step of inspectOidTripleGenerationPlan(root, transaction, 'rollback').steps) if (step.operation === 'exchange') exchange(...locations[step.name]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'dist/BUILD_PROVENANCE.json'))).commit, full.previous.clientOid);
    for (const step of inspectOidTripleGenerationPlan(root, transaction, 'forward').steps) if (step.operation === 'exchange') exchange(...locations[step.name]);
    assert.equal(digest(fs.readFileSync(full.dbPath)), full.dbBefore);
}

const http = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/health') {
        response.end(JSON.stringify({ serverLoadedBuildId: loadedBuild, clientBuildIdServed: JSON.parse(fs.readFileSync(path.join(root, 'dist/version.json'))).buildId,
            serverLoadedOid: loadedOid, pid: process.pid, serverProcessStartTicks: startTime })); return;
    }
    const served = JSON.parse(fs.readFileSync(path.join(root, 'dist/version.json'))).buildId;
    response.setHeader('Cache-Control', 'no-store');
    response.end(served === failedHttpBuild ? 'stale fixture proxy' : fs.readFileSync(path.join(root, 'dist', request.url === '/' ? 'index.html' : 'version.json')));
});
try {
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(3004, '127.0.0.1', resolve); });
    process.env.NASSAJ_PREVIEW_HEALTH_URL = 'http://127.0.0.1:3004/health';
    const baseline = source('body { color: red }'); tinyTools(path.join(root, 'node_modules'));
    generation(path.join(root, 'dist'), baseline.oid, H(1));
    serverGeneration(serverRoot, baseline.oid, H(1), verifyUpdateRuntimeBundle(serverRoot));
    const b0 = await fullBaseline(baseline.oid, H(1), 1);
    const a1 = await publish(b0, source('body { color: blue }'), 3);
    const a2 = await publish(b0, source('body { color: green }'), 4);
    assert.equal(a2.intent.parentServingReceiptDigest, a1.receiptDigest);
    const a2Serving = readClientPublicationServing(root), b1Source = source('body { color: purple }');
    const full = await prepareFull(a2, b1Source); exerciseFullGenerationCuts(full);
    const b1 = await fullBaseline(b1Source.oid, H(5), 5);
    assert.equal(b1.previousServingReceiptDigest, a2Serving.receiptDigest);
    assert.equal(JSON.parse(fs.readFileSync(path.join(full.locations.client[1], 'BUILD_PROVENANCE.json'))).commit, a2.intent.sourceOid);
    const b1Serving = readClientPublicationServing(root);
    const c1 = await publish(b1, source('body { color: orange }'), 7);
    assert.equal(c1.intent.parentServingReceiptDigest, b1Serving.receiptDigest); assert.equal(c1.intent.baseReceiptDigest, b1.baseReceiptDigest);
    const c2 = await publish(b1, source('body { color: black }'), 8, true);
    assert.equal(c2.receipt.outcome, 'rolled_back');
    assert.equal(readClientPublicationServing(root).sourceOid, c1.intent.sourceOid);
    const rejectedGeneration = validateClientAssetManifest(path.join(root, '.nassaj-local-preview/client-assets/generations',
        digest({ sourceOid: c2.intent.sourceOid, buildId: c2.intent.targetClientIdentity.buildId })), {}, verifyAssetClosure);
    assert.equal(rejectedGeneration.manifest.buildId, c2.intent.targetClientIdentity.buildId);
    assert.equal(digest(fs.readFileSync(full.dbPath)), full.dbBefore);
    const recoverySource = source('body { color: silver }');
    git('update-ref', 'refs/nassaj/previews/v1/events/0000000000000009/client', recoverySource.oid);
    await assert.rejects(publish(b1, recoverySource, 9, false, true), /fixture_crash_after_durable_outcome/);
    assert.equal(readClientPublicationServing(root).sourceOid, c1.intent.sourceOid);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'dist/BUILD_PROVENANCE.json'))).commit, recoverySource.oid);
    const journalFile = fs.readdirSync(path.join(root, '.git')).find(name => name.startsWith('nassaj-oid-control-transaction-9-'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.git', journalFile))).state, 'served');
    fs.unlinkSync(policyFile);
    const requestsBeforeRecovery = requests.length;
    await restartConsumer();
    assert.equal(readClientPublicationServing(root).sourceOid, recoverySource.oid);
    assert.equal(requests.length, requestsBeforeRecovery, 'durable terminal outcome repairs lineage without exchanging or probing again');
    const recovered = readClientPublicationServing(root);
    await restartConsumer(); assert.deepEqual(readClientPublicationServing(root), recovered);
    process.stdout.write(JSON.stringify({ journey: ['B0', 'A1', 'A2', 'B1', 'C1', 'C2-rolled-back'],
        sourceOids: [baseline.oid, a1.intent.sourceOid, a2.intent.sourceOid, b1Source.oid, c1.intent.sourceOid],
        previousClientOid: full.previous.clientOid, preparedDatabase: true, unknownDowngradeRefused: true, durableOutcomeRestartRecovered: true,
        network: fs.readlinkSync('/proc/self/ns/net'), requests }));
} finally {
    http.closeAllConnections(); await new Promise(resolve => http.close(resolve));
}
