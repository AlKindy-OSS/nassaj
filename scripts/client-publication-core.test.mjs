import { advanceClientServingLineageRecord } from './lib/client-publication-lineage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { reconcileOidPairServingReceipt, captureOidTriplePreviousGeneration, prepareOidTriplePublicationSnapshot, releaseFullWaiterBeforeEffects, hashOidPairTree, hashOidPairDependencyTree } from './oid-control-capsule.mjs';
import { createServer } from 'node:http';
import { clientPublicationCanonical as canonical, clientPublicationDigest as digest, inspectClientPublicationTree,
    createClientAssetManifest, validateClientAssetManifest, proveClientCompatibility, isIndependentClientInput,
    readClientPublicationFile, assertClientAssetPath } from './lib/client-publication-artifacts.mjs';
import { writeClientPublicationIntent, validateClientPublicationJournal, advanceClientPublicationJournal,
    writeClientPublicationOutcome, readClientPublicationReceipt, assertClientPublicationServerIdentity } from './lib/client-publication-journal.mjs';
import { clientBuildSandboxInvocation, runIsolatedClientBuild, resolveClientBuildSandbox } from './lib/client-publication-isolation.mjs';
import { publishDevClient, probeClientPublicationHttp, reconcileDevClientPublication, assertClientPublicationCapacity, prepareClientPublicationAssets } from './lib/client-publication-executor.mjs';
import { recordFullClientPublicationBaseline, qualifyClientPublicationRollback, captureClientPublicationBaseline, recordClientPublicationRollbackBaseline } from './lib/client-publication-baseline.mjs';
import { verifyAssetClosure } from './client-build-atomic.mjs';
import { assertNoNonterminalOidTransaction } from './oid-control-journal.mjs';

const oid = n => String(n).repeat(40), hex = n => String(n).repeat(64);
const TEST_ROOT = path.resolve('.nassaj-local-preview');
fs.mkdirSync(TEST_ROOT, { recursive: true });
function fixture(t) {
    const root = fs.mkdtempSync(path.join(TEST_ROOT, 'publication-test-'));
    t.after(() => {
        const writable = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) if (item.isDirectory()) writable(path.join(directory, item.name)); fs.chmodSync(directory, 0o700); };
        writable(root); fs.rmSync(root, { recursive: true, force: true });
    });
    const result = spawnSync('/usr/bin/git', ['init', '-q', root]); assert.equal(result.status, 0);
    return root;
}
function generation(directory, source = oid(1), build = hex(1)) {
    fs.mkdirSync(path.join(directory, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: source, buildId: build, generationId: build }));
    fs.writeFileSync(path.join(directory, 'index.html'), `<script src="/assets/generations/${build}/assets/app.js"></script>`);
    fs.writeFileSync(path.join(directory, 'assets/app.js'), `console.log('${build}')`);
    fs.writeFileSync(path.join(directory, 'version.json'), JSON.stringify({ buildId: build }));
    return createClientAssetManifest(directory, { generationId: build, sourceOid: source, buildId: build }, verifyAssetClosure);
}
function clientIdentity(directory) {
    const value = validateClientAssetManifest(directory, {}, verifyAssetClosure);
    return { sourceOid: value.manifest.sourceOid, buildId: value.manifest.buildId, treeDigest: value.treeDigest, assetManifestDigest: value.manifestDigest };
}
function intent(root, override = {}) {
    generation(path.join(root, 'dist'));
    generation(path.join(root, 'candidate'), oid(2), hex(2));
    return { schema: 'nassaj-oid-client-publication/v1', kind: 'client-publication', transactionNonce: hex(3), sequence: 1,
        sourceOid: oid(2), policyRevision: 1, reservationId: 'reserved-1', baseReceiptDigest: hex(4), parentServingReceiptDigest: hex(5),
        serverIdentity: { sourceOid: oid(1), buildId: hex(1), pid: process.pid, startTime: '1', controlManifestDigest: hex(7), baseReceiptDigest: hex(4) },
        dependencyIdentity: hex(6), previousClientIdentity: clientIdentity(path.join(root, 'dist')),
        targetClientIdentity: clientIdentity(path.join(root, 'candidate')), candidateManifestDigest: hex(8), compatibilityProofDigest: hex(9),
        assetManifestDigest: clientIdentity(path.join(root, 'candidate')).assetManifestDigest, ...override };
}
function exchangeFixture(root) {
    fs.renameSync(path.join(root, 'dist'), path.join(root, 'old'));
    fs.renameSync(path.join(root, 'candidate'), path.join(root, 'dist'));
}
function proof(root) {
    return { schema: 'nassaj-client-http-serving/v1', files: ['index.html', 'version.json'].map(relative => ({ path: relative, status: 200, sha256: digest(fs.readFileSync(path.join(root, 'dist', relative))) })) };
}
function outcomeOptions(root, value, outcome = 'served') {
    return { outcome, actualServerIdentity: value.serverIdentity, parentServingReceiptDigest: value.parentServingReceiptDigest, servingEvidence: proof(root) };
}
function journalFile(root, value) { return path.join(root, '.git', `nassaj-oid-control-transaction-${value.sequence}-${value.transactionNonce}.json`); }

test('sealed manifests preserve closure and reject unsafe paths, aliases, changed bytes and missing files', t => {
    const root = fixture(t), directory = path.join(root, 'dist');
    const made = generation(directory), checked = validateClientAssetManifest(directory, { manifestDigest: made.manifestDigest }, verifyAssetClosure);
    assert.equal(checked.manifest.entries.length, 4);
    assert.throws(() => createClientAssetManifest(directory, { generationId: hex(1), sourceOid: oid(1), buildId: hex(1) }, verifyAssetClosure), /EEXIST/);
    for (const value of ['../file', 'a//b', '/absolute', 'a%2fb', 'a?b', 'a\\b', 'a\0b']) assert.throws(() => assertClientAssetPath(value));
    assert.throws(() => validateClientAssetManifest(directory, { buildId: hex(2) }, verifyAssetClosure), /identity_mismatch/);
    fs.writeFileSync(path.join(directory, 'assets/app.js'), 'changed');
    assert.throws(() => validateClientAssetManifest(directory, {}, verifyAssetClosure), /manifest_changed/);
    fs.symlinkSync('/etc/passwd', path.join(directory, 'external'));
    assert.throws(() => inspectClientPublicationTree(directory), /tree_alias/);
    fs.unlinkSync(path.join(directory, 'external'));
    fs.linkSync(path.join(directory, 'assets/app.js'), path.join(directory, 'alias'));
    assert.throws(() => inspectClientPublicationTree(directory), /tree_special/);
    assert.throws(() => readClientPublicationFile(path.join(directory, 'alias')), /file_unsafe/);
    assert.throws(() => inspectClientPublicationTree(directory, { maximumBytes: 0 }), /budget_invalid/);
});

test('directory-only output is bounded and parent fsync does not require mutable sealed assets', t => {
    const root = fixture(t), tree = path.join(root, 'tree'); fs.mkdirSync(tree);
    for (let i = 0; i < 6; i++) fs.mkdirSync(path.join(tree, String(i)));
    assert.throws(() => inspectClientPublicationTree(tree, { maximumFiles: 3 }), /capacity_exceeded/);
    assert.equal(inspectClientPublicationTree(tree).totalBytes, 0);
    fs.writeFileSync(path.join(tree, 'big'), '12345');
    assert.throws(() => inspectClientPublicationTree(tree, { maximumBytes: 3 }), /capacity_exceeded/);
    assert.throws(() => createClientAssetManifest(tree, { sourceOid: oid(1), generationId: hex(1), buildId: hex(1) }, () => {}), /incomplete/);
    assert.throws(() => createClientAssetManifest(tree, {}, () => {}), /identity_invalid/);
    assert.throws(() => createClientAssetManifest(tree, { sourceOid: oid(1), generationId: hex(1), buildId: hex(1) }), /verifier_required/);
    assert.throws(() => canonical(undefined), /noncanonical/);
    assert.equal(canonical({ b: 2, a: [1, 3] }), '{"a":[1,3],"b":2}');
});

test('compatibility compares cumulative loaded baseline and refuses unknown or prior server changes', t => {
    const options = { root: fixture(t), sourceOid: oid(2), baselineOid: oid(1), baseReceiptDigest: hex(4), dependencyIdentity: hex(5),
        installedControlDigest: hex(6), serverIdentity: { sourceOid: oid(1), buildId: hex(1), pid: 1, startTime: '123' },
        candidateManifestDigest: hex(7), assetManifestDigest: hex(8) };
    const calls = [], git = args => { calls.push(args); return args[0] === 'diff' ? 'src/app.css\0public/logo.png\0' : ''; };
    const result = proveClientCompatibility(options, { git });
    assert.equal(result.proof.baselineOid, oid(1)); assert.equal(result.proof.protectedInputs.length, 0);
    assert.deepEqual(calls[1].slice(4, 6), [oid(1), oid(2)]);
    assert.throws(() => proveClientCompatibility(options, { git: args => args[0] === 'diff' ? 'src/app.css\0server/auth.js\0' : '' }), /full_update_required/);
    assert.throws(() => proveClientCompatibility({ ...options, baseReceiptDigest: null }), /baseline_unproven/);
    assert.throws(() => proveClientCompatibility({ ...options, assetManifestDigest: null }, { git }), /output_unproven/);
    assert.throws(() => proveClientCompatibility(options), /git_failed/);
    for (const file of ['src/index.ts', 'public/sw.js', 'package-lock.json', 'src/../auth.css']) assert.equal(isIndependentClientInput(file), false);
});

test('journal validates immutable intent before terminal and allowedNonce shortcuts', t => {
    const root = fixture(t), value = intent(root), prepared = writeClientPublicationIntent(root, value);
    assert.equal(writeClientPublicationIntent(root, value).intentDigest, prepared.intentDigest);
    assert.equal(validateClientPublicationJournal(root, prepared).terminal, false);
    assert.throws(() => assertNoNonterminalOidTransaction(root), /in_progress/);
    assert.doesNotThrow(() => assertNoNonterminalOidTransaction(root, value.transactionNonce));
    const corrupted = { ...prepared, state: 'served', schema: 'unknown' };
    fs.writeFileSync(journalFile(root, value), JSON.stringify(corrupted));
    assert.throws(() => assertNoNonterminalOidTransaction(root, value.transactionNonce), /intent_invalid/);
    fs.writeFileSync(journalFile(root, value), JSON.stringify(prepared));
    assert.throws(() => advanceClientPublicationJournal(root, { ...prepared, intentDigest: hex(8) }, 'publishing'), /cas_conflict/);
    assert.throws(() => advanceClientPublicationJournal(root, prepared, 'served'), /transition_invalid/);
    assert.throws(() => assertClientPublicationServerIdentity({ ...value.serverIdentity, pid: 0 }), /identity_invalid/);
    assert.throws(() => writeClientPublicationIntent(root, { ...value, targetClientIdentity: { ...value.targetClientIdentity, assetManifestDigest: hex(8) } }), /asset_binding_mismatch/);
});

test('terminal receipts bind real manifest and HTTP evidence; corrupt existing receipt leaves journal nonterminal (B-1163)', t => {
    const root = fixture(t), value = intent(root); let journal = writeClientPublicationIntent(root, value);
    journal = advanceClientPublicationJournal(root, journal, 'publishing'); exchangeFixture(root);
    journal = advanceClientPublicationJournal(root, journal, 'verifying');
    const manifest = path.join(root, 'dist/CLIENT_ASSET_MANIFEST.json'), bytes = fs.readFileSync(manifest);
    fs.unlinkSync(manifest);
    assert.throws(() => writeClientPublicationOutcome(root, journal, outcomeOptions(root, value)), /ENOENT/);
    fs.writeFileSync(manifest, bytes);
    fs.appendFileSync(manifest, ' ');
    assert.throws(() => writeClientPublicationOutcome(root, journal, outcomeOptions(root, value)), /manifest_changed/);
    fs.writeFileSync(manifest, bytes);
    assert.throws(() => writeClientPublicationOutcome(root, journal, { ...outcomeOptions(root, value), servingEvidence: null }), /http_proof_required/);
    const file = path.join(root, '.git', `nassaj-oid-client-receipt-${value.transactionNonce}.json`);
    fs.writeFileSync(file, JSON.stringify({ intentDigest: journal.intentDigest, outcome: 'served' }), { mode: 0o600 });
    assert.throws(() => writeClientPublicationOutcome(root, journal, outcomeOptions(root, value)), /receipt_invalid/);
    assert.equal(JSON.parse(fs.readFileSync(journalFile(root, value))).state, 'verifying');
    fs.unlinkSync(file);
    const result = writeClientPublicationOutcome(root, journal, outcomeOptions(root, value));
    assert.equal(result.terminal, true); assert.equal(readClientPublicationReceipt(root, value).receiptDigest, result.receiptDigest);
    assert.doesNotThrow(() => assertNoNonterminalOidTransaction(root));
    assert.equal(writeClientPublicationOutcome(root, journal, outcomeOptions(root, value)).receiptDigest, result.receiptDigest);
    assert.throws(() => writeClientPublicationOutcome(root, journal, outcomeOptions(root, value, 'rolled_back')), /outcome_conflict/);
    fs.unlinkSync(file);
    assert.throws(() => assertNoNonterminalOidTransaction(root, value.transactionNonce), /ENOENT/);
});

test('prepared cancellation proves unchanged prior generation and needs no policy re-enable', async t => {
    const root = fixture(t), value = intent(root), journal = writeClientPublicationIntent(root, value);
    const context = { withEventLock: async (_root, fn) => fn(), revalidate: () => { throw new Error('policy disabled'); },
        beforeEffect: () => {}, readServingLineage: () => ({ receiptDigest: value.parentServingReceiptDigest }),
        readActualServerIdentity: () => value.serverIdentity, recordServingLineage: () => assert.fail('cancel must not advance lineage') };
    const result = await reconcileDevClientPublication({ root, journal }, context);
    assert.equal(result.receipt.outcome, 'cancelled');
    assert.doesNotThrow(() => assertNoNonterminalOidTransaction(root));
    assert.equal((await reconcileDevClientPublication({ root, journal: JSON.parse(fs.readFileSync(journalFile(root, value))) }, context)).receipt.outcome, 'cancelled');
});

test('HTTP serving probe rejects stale content and accepts exact uncached responses', async t => {
    const root = fixture(t); generation(path.join(root, 'dist'));
    let stale = false;
    const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.end(stale ? 'stale' : fs.readFileSync(path.join(root, 'dist', req.url === '/' ? 'index.html' : 'version.json')));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const context = { servingOrigin: `http://127.0.0.1:${server.address().port}` };
    assert.equal((await probeClientPublicationHttp(root, context)).files.length, 2);
    stale = true; await assert.rejects(probeClientPublicationHttp(root, context), /http_serving_mismatch/);
    await assert.rejects(probeClientPublicationHttp(root, { servingOrigin: 'https://example.com' }), /origin_invalid/);
});

test('actual namespace blocks host secrets, network and readonly writes; late descendants reject output', async t => {
    const root = fixture(t), source = path.join(root, 'source'), dependencies = path.join(root, 'dependencies'), output = path.join(root, 'output'), scratch = path.join(root, 'scratch');
    for (const directory of [source, dependencies, output, scratch]) fs.mkdirSync(directory);
    fs.writeFileSync(path.join(root, 'host-secret'), 'never visible');
    const options = { sourceRoot: source, dependenciesRoot: dependencies, outputRoot: output, scratchRoot: scratch, timeoutMs: 5000 };
    const program = `const fs=require('fs'); if(fs.existsSync(${JSON.stringify(path.join(root, 'host-secret'))}))process.exit(91);try{fs.writeFileSync(${JSON.stringify(path.join(source, 'bad'))},'x');process.exit(92)}catch{};if(process.env.SECRET)process.exit(93);fs.writeFileSync(${JSON.stringify(path.join(output, 'ok'))},'ok');`;
    assert.ok(resolveClientBuildSandbox().endsWith('/bwrap'));
    const valid = { ...options, commands: [{ command: '/usr/bin/node', args: ['-e', program] }] };
    const invocation = clientBuildSandboxInvocation(valid);
    assert.ok(invocation.args.includes('--unshare-all')); assert.ok(invocation.args.includes('--clearenv'));
    assert.equal((await runIsolatedClientBuild(valid)).totalBytes, 2);
    const hostServer = createServer((_req, res) => res.end('host network forbidden'));
    await new Promise(resolve => hostServer.listen(0, '127.0.0.1', resolve));
    try {
        const network = `const socket=require('net').connect(${hostServer.address().port},'127.0.0.1');socket.on('connect',()=>process.exit(94));socket.on('error',()=>process.exit(0));`;
        await runIsolatedClientBuild({ ...options, commands: [{ command: '/usr/bin/node', args: ['-e', network] }] });
    } finally { await new Promise(resolve => hostServer.close(resolve)); }
    const child = "require('child_process').spawn('/usr/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref()";
    await assert.rejects(runIsolatedClientBuild({ ...options, commands: [{ command: '/usr/bin/node', args: ['-e', child] }] }), /descendant_failure/);
    await assert.rejects(runIsolatedClientBuild({ ...options, timeoutMs: 20, commands: [{ command: '/usr/bin/node', args: ['-e', 'setInterval(()=>{},1000)'] }] }), /timeout/);
    assert.throws(() => clientBuildSandboxInvocation({ ...valid, outputRoot: source }), /mount_overlap/);
    assert.throws(() => clientBuildSandboxInvocation({ ...valid, commands: [{ command: '/usr/bin/node', args: [], env: { SECRET: 'x' } }] }), /environment_refused/);
    fs.writeFileSync(path.join(source, '.env'), 'SECRET=no');
    assert.throws(() => clientBuildSandboxInvocation(valid), /environment_file_refused/);
});

test('capacity and archival keep sealed source fixed and retain all generations', t => {
    const root = fixture(t), source = path.join(root, 'dist'); const made = generation(source);
    assert.throws(() => assertClientPublicationCapacity(root, -1), /capacity_exceeded/);
    assert.throws(() => assertClientPublicationCapacity(root, 1024 ** 3 + 1), /capacity_exceeded/);
    const archive = prepareClientPublicationAssets(root, source, { manifestDigest: made.manifestDigest });
    assert.equal(validateClientAssetManifest(source, {}, verifyAssetClosure).manifestDigest, made.manifestDigest);
    assert.equal(validateClientAssetManifest(archive, {}, verifyAssetClosure).manifestDigest, made.manifestDigest);
    assert.equal(prepareClientPublicationAssets(root, source, { manifestDigest: made.manifestDigest }), archive);
});

function fullReceiptFixture(root) {
    const startTime = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(/\s+/)[19];
    const receipt = { outcome: 'served', sequence: 1, transactionNonce: hex(3), clientBuildId: hex(1), serverBuildId: hex(1),
        pid: process.pid, startTime, nodeModulesTreeSha256: hex(4) };
    fs.mkdirSync(path.join(root, 'dist-server'));
    fs.writeFileSync(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), JSON.stringify({ oid: oid(1), serverBuildId: hex(1), updateRuntimeBuildId: hex(8), capabilities: { clientPublicationV1: 'nassaj-dev-client-publication/v1' } }));
    fs.writeFileSync(path.join(root, '.git', `nassaj-oid-pair-serving-${receipt.transactionNonce}.json`), JSON.stringify(receipt), { mode: 0o600 });
    generation(path.join(root, 'dist'));
    return receipt;
}

test('full baseline replay repairs every durable-write crash without changing historical parent (B-1169)', t => {
    for (const point of ['baseline', 'runtime', 'lineage']) {
        const root = fixture(t), receipt = fullReceiptFixture(root);
        const parent = { schema: 'nassaj-client-publication-serving/v1', baseReceiptDigest: hex(6), receiptDigest: hex(5), kind: 'client' };
        fs.writeFileSync(path.join(root, '.git/nassaj-client-publication-serving-v1.json'), JSON.stringify(parent));
        assert.throws(() => recordFullClientPublicationBaseline(root, receipt, { verifyClosure: verifyAssetClosure,
            rollbackDirectories: [path.join(root, 'dist-server')], afterWrite: phase => { if (phase === point) throw new Error('power_loss'); } }), /power_loss/);
        const binding = recordFullClientPublicationBaseline(root, receipt, { verifyClosure: verifyAssetClosure, rollbackDirectories: [path.join(root, 'dist-server')] });
        const saved = JSON.parse(fs.readFileSync(path.join(root, '.git/nassaj-client-publication-serving-v1.json')));
        assert.equal(binding.previousServingReceiptDigest, parent.receiptDigest);
        assert.equal(saved.baseReceiptDigest, binding.baseReceiptDigest);
        assert.equal(saved.kind, 'full');
        assert.equal(recordFullClientPublicationBaseline(root, receipt, { verifyClosure: verifyAssetClosure }).baseReceiptDigest, binding.baseReceiptDigest);
        assert.equal(binding.capabilities.rollback, 'nassaj-dev-client-publication/v1');
    }
    assert.equal(qualifyClientPublicationRollback([]), false);
    assert.equal(qualifyClientPublicationRollback(['/nonexistent']), false);
});

test('reconcile publishes exact target with HTTP proof, repairs receipt-before-lineage and refuses newer parent', async t => {
    const root = fixture(t), value = intent(root); let journal = writeClientPublicationIntent(root, value);
    journal = advanceClientPublicationJournal(root, journal, 'publishing'); exchangeFixture(root);
    let lineage = { receiptDigest: value.parentServingReceiptDigest };
    const server = createServer((req, res) => res.end(fs.readFileSync(path.join(root, 'dist', req.url === '/' ? 'index.html' : 'version.json'))));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const context = { servingOrigin: `http://127.0.0.1:${server.address().port}`, withEventLock: async (_root, fn) => fn(),
        revalidate: () => assert.fail('disabled policy must not block recovery'), beforeEffect: () => {},
        readServingLineage: () => lineage, readActualServerIdentity: () => value.serverIdentity,
        recordServingLineage: (_root, result) => { lineage = { receiptDigest: result.receiptDigest }; } };
    const result = await reconcileDevClientPublication({ root, journal }, context);
    assert.equal(result.receipt.outcome, 'served'); assert.equal(lineage.receiptDigest, result.receiptDigest);
    const terminal = JSON.parse(fs.readFileSync(journalFile(root, value)));
    lineage = { receiptDigest: value.parentServingReceiptDigest };
    assert.equal((await reconcileDevClientPublication({ root, journal: terminal }, context)).receiptDigest, result.receiptDigest);
    assert.equal((await reconcileDevClientPublication({ root, journal: terminal }, context)).receiptDigest, result.receiptDigest);
    lineage = { receiptDigest: hex(8) };
    await assert.rejects(reconcileDevClientPublication({ root, journal: terminal }, context), /lineage_conflict/);
});

function git(root, args) {
    const result = spawnSync('/usr/bin/git', ['-c', 'user.name=Publication test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function sourceCommit(root, css) {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/app.css'), css);
    if (!fs.existsSync(path.join(root, 'package.json'))) fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0.0"}');
    git(root, ['add', 'src/app.css', 'package.json']); git(root, ['commit', '-qm', 'fixture']);
    const sourceOid = git(root, ['rev-parse', 'HEAD']), sourceRoot = path.join(root, '.nassaj-local-preview/oid-snapshots', sourceOid);
    fs.mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
    fs.copyFileSync(path.join(root, 'package.json'), path.join(sourceRoot, 'package.json'));
    fs.copyFileSync(path.join(root, 'src/app.css'), path.join(sourceRoot, 'src/app.css'));
    for (const relative of ['package.json', 'src/app.css']) fs.chmodSync(path.join(sourceRoot, relative), 0o444);
    fs.chmodSync(path.join(sourceRoot, 'src'), 0o555); fs.chmodSync(sourceRoot, 0o555);
    return { sourceOid, sourceRoot };
}
function tinyInstalledBuildTools(root) {
    const dependencyRoot = path.join(root, 'node_modules');
    fs.mkdirSync(path.join(dependencyRoot, 'typescript/bin'), { recursive: true });
    fs.mkdirSync(path.join(dependencyRoot, 'vite/bin'), { recursive: true });
    fs.writeFileSync(path.join(dependencyRoot, 'typescript/bin/tsc'), 'process.exit(0)');
    fs.writeFileSync(path.join(dependencyRoot, 'vite/bin/vite.js'), `const fs=require('fs'),p=require('path');const d=process.env.NASSAJ_CLIENT_OUT_DIR,b=process.env.NASSAJ_BUILD_ID,g=process.env.NASSAJ_CLIENT_GENERATION_ID;fs.mkdirSync(p.join(d,'assets'),{recursive:true});fs.writeFileSync(p.join(d,'assets/app.js'),"console.log('"+b+"')");fs.writeFileSync(p.join(d,'version.json'),JSON.stringify({buildId:b}));fs.writeFileSync(p.join(d,'index.html'),'<script src="/assets/generations/'+g+'/assets/app.js"></script>');`);
}

test('installed publisher builds A1 then A2 in real namespaces, seals assets and records baseline/parent lineage', async t => {
    const root = fixture(t), baseline = sourceCommit(root, 'body { color: red }');
    generation(path.join(root, 'dist'), baseline.sourceOid, hex(1)); tinyInstalledBuildTools(root);
    const serverIdentity = { sourceOid: baseline.sourceOid, buildId: hex(1), pid: process.pid, startTime: '1', controlManifestDigest: hex(7), baseReceiptDigest: hex(4) };
    let current = { receiptDigest: hex(5) }, lastResult = null, failTarget = false, previousBuild = null, truncateBody = false;
    const server = createServer((req, res) => {
        const build = JSON.parse(fs.readFileSync(path.join(root, 'dist/BUILD_PROVENANCE.json'))).buildId;
        if (truncateBody && build !== previousBuild) {
            res.writeHead(200, { 'Content-Length': '999999' }); res.flushHeaders(); res.write('incomplete'); setTimeout(() => res.destroy(), 5); return;
        }
        res.end(failTarget && build !== previousBuild ? 'stale proxy response' : fs.readFileSync(path.join(root, 'dist', req.url === '/' ? 'index.html' : 'version.json')));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
    const context = { servingOrigin: `http://127.0.0.1:${server.address().port}`, withEventLock: async (_root, fn) => fn(), revalidate: () => {}, beforeEffect: () => {},
        readServingLineage: () => current, readActualServerIdentity: () => serverIdentity,
        recordServingLineage: (_root, result) => { current = { receiptDigest: result.receiptDigest }; lastResult = result; } };
    let first;
    for (const sequence of [1, 2, 3, 4, 5]) {
        const source = sourceCommit(root, `body { color: rgb(${sequence},0,0) }`), parent = current.receiptDigest;
        const options = { root, sourceRoot: source.sourceRoot, event: { sequence, oid: source.sourceOid }, policy: { revision: 1 }, reservationId: `reservation-${sequence}`,
            parentServingReceiptDigest: parent, baseline: { baselineOid: baseline.sourceOid, baseReceiptDigest: hex(4), dependencyIdentity: hex(6), installedControlDigest: hex(7), serverIdentity } };
        if (sequence === 3) { failTarget = true; previousBuild = clientIdentity(path.join(root, 'dist')).buildId; }
        if (sequence === 5) { failTarget = false; truncateBody = true; previousBuild = clientIdentity(path.join(root, 'dist')).buildId; }
        if (sequence === 4) {
            let checks = 0; const before = clientIdentity(path.join(root, 'dist'));
            await assert.rejects(publishDevClient(options, { ...context, revalidate: () => { if (++checks === 4) throw new Error('policy_revoked'); } }), /policy_revoked/);
            assert.deepEqual(clientIdentity(path.join(root, 'dist')), before);
            assert.doesNotThrow(() => assertNoNonterminalOidTransaction(root));
            continue;
        }
        const result = await publishDevClient(options, context);
        assert.equal(result.receipt.outcome, [3, 5].includes(sequence) ? 'rolled_back' : 'served'); assert.equal(result.intent.baseReceiptDigest, hex(4));
        assert.equal(result.intent.parentServingReceiptDigest, parent); assert.equal(lastResult.receiptDigest, result.receiptDigest);
        if (sequence === 1) first = result;
        else if (sequence === 2) assert.equal(result.intent.parentServingReceiptDigest, first.receiptDigest);
    }
    assert.equal(fs.readdirSync(path.join(root, '.nassaj-local-preview/client-assets/generations')).length, 6);
});

test('baseline rejects absent capability, inconsistent full receipt and stale loaded process', t => {
    const root = fixture(t), receipt = fullReceiptFixture(root), manifestFile = path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, capabilities: {} }));
    assert.equal(recordFullClientPublicationBaseline(root, receipt, { verifyClosure: verifyAssetClosure }), null);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(() => recordFullClientPublicationBaseline(root, { ...receipt, outcome: 'rolled_back' }, { verifyClosure: verifyAssetClosure }), /full_receipt_invalid/);
    const file = path.join(root, '.git', `nassaj-oid-pair-serving-${receipt.transactionNonce}.json`);
    const changed = { ...receipt, startTime: '1' }; fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => recordFullClientPublicationBaseline(root, changed, { verifyClosure: verifyAssetClosure }), /process_changed/);
    fs.writeFileSync(file, JSON.stringify(receipt));
    const result = recordFullClientPublicationBaseline(root, receipt, { verifyClosure: verifyAssetClosure, rollbackDirectories: [] });
    assert.equal(result.capabilities.rollback, undefined);
    const stored = path.join(root, '.git', `nassaj-client-publication-baseline-${result.baseReceiptDigest}.json`);
    const baseline = JSON.parse(fs.readFileSync(stored));
    fs.writeFileSync(stored, JSON.stringify({ ...baseline, binding: { ...baseline.binding, baseReceiptDigest: hex(9) } }));
    assert.throws(() => recordFullClientPublicationBaseline(root, receipt, { verifyClosure: verifyAssetClosure }), /replay_identity_changed/);
});

test('full capsule captures served A2 above server B0 and refuses failed B1 preparation before database effects', async t => {
    const root = fixture(t), baseOid = oid(1), clientOid = oid(2), targetOid = oid(3);
    const live = path.join(root, 'dist'), serverRoot = path.join(root, 'dist-server');
    generation(live, clientOid, hex(2)); fs.mkdirSync(serverRoot);
    fs.writeFileSync(path.join(serverRoot, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: baseOid, baseCommit: baseOid, dirty: false, buildId: hex(1) }));
    fs.writeFileSync(path.join(serverRoot, 'OID_CONTROL_MANIFEST.json'), JSON.stringify({ oid: baseOid, serverBuildId: hex(1) }));
    fs.mkdirSync(path.join(root, 'node_modules'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'node_modules/dependency'), 'fixed', { mode: 0o444 });
    const startTime = fs.readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(/\s+/)[19];
    const http = createServer((_req, res) => res.end(JSON.stringify({ serverLoadedBuildId: hex(1), clientBuildIdServed: hex(2),
        serverLoadedOid: baseOid, pid: process.pid, serverProcessStartTicks: startTime })));
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const oldHealth = process.env.NASSAJ_PREVIEW_HEALTH_URL;
    process.env.NASSAJ_PREVIEW_HEALTH_URL = `http://127.0.0.1:${http.address().port}/health`;
    t.after(async () => { if (oldHealth === undefined) delete process.env.NASSAJ_PREVIEW_HEALTH_URL; else process.env.NASSAJ_PREVIEW_HEALTH_URL = oldHealth; await new Promise(resolve => http.close(resolve)); });
    const previous = await captureOidTriplePreviousGeneration(root, { runtimeDependenciesSha256: hashOidPairDependencyTree(path.join(root, 'node_modules')) });
    assert.equal(previous.clientOid, clientOid); assert.equal(previous.runtime.oid, baseOid);
    assert.equal(previous.clientBuildId, hex(2)); assert.equal(previous.serverBuildId, hex(1));
    const targetDirectory = path.join(root, '.nassaj-local-preview/client-candidates', hex(3)); generation(targetDirectory, targetOid, hex(3));
    const target = { clientBuildId: hex(3), clientTreeSha256: hashOidPairTree(targetDirectory) };
    const databasePath = path.join(root, 'auth.db'), database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,status TEXT); INSERT INTO users VALUES(1,'owner',1,'active')"); database.close(); fs.chmodSync(databasePath, 0o600);
    const dbBefore = digest(fs.readFileSync(databasePath)), clientBefore = hashOidPairTree(live);
    const manifestFile = path.join(targetDirectory, 'CLIENT_ASSET_MANIFEST.json'), manifestBytes = fs.readFileSync(manifestFile);
    fs.chmodSync(manifestFile, 0o644); fs.appendFileSync(manifestFile, ' ');
    const identity = { transactionNonce: hex(4), actionId: 'fixture-full-update', oid: targetOid, ownerId: '1' };
    await assert.rejects(prepareOidTriplePublicationSnapshot(root, target, previous, databasePath, identity), /full_client_archive_tree_changed/);
    assert.equal(digest(fs.readFileSync(databasePath)), dbBefore); assert.equal(hashOidPairTree(live), clientBefore);
    assert.equal(fs.existsSync(path.join(root, 'nassaj-update-db-snapshots')), false);
    fs.writeFileSync(manifestFile, manifestBytes); fs.chmodSync(manifestFile, 0o444);
    const snapshot = await prepareOidTriplePublicationSnapshot(root, target, previous, databasePath, identity);
    assert.equal(snapshot.phase, 'CAPTURED'); assert.equal(digest(fs.readFileSync(databasePath)), dbBefore);
    assert.equal(hashOidPairTree(live), clientBefore); assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'BUILD_PROVENANCE.json'))).commit, clientOid);
    assert.equal(snapshot.sourceSchemaDigest, snapshot.snapshotSchemaDigest);
    const fullUpdateWaiter = { schema: 'nassaj-full-update-waiter/v1', sequence: 1, requestId: 'local-update:1', revision: 2,
        transactionNonce: identity.transactionNonce, phase: 'effects_started', effect: 'started' };
    const eventFile = path.join(root, '.git/nassaj-preview-oid-event-control-0000000000000001.json');
    fs.writeFileSync(eventFile, JSON.stringify({ localUpdate: { phase: 'failed', activation: null }, fullUpdateWaiter }), { mode: 0o600 });
    const transaction = { schema: 'nassaj-oid-control-transaction/v2', sequence: 1, transactionNonce: identity.transactionNonce,
        fullUpdateWaiter, state: 'restart_deferred_restored', pair: { databaseState: 'PRE_CANDIDATE', activationNotClaimed: true, previous } };
    const journal = path.join(root, '.git', `nassaj-oid-control-transaction-1-${identity.transactionNonce}.json`);
    fs.writeFileSync(journal, JSON.stringify({ ...transaction, oldStopIntentAt: 1 }), { mode: 0o600 });
    assert.throws(() => releaseFullWaiterBeforeEffects(root, transaction, journal), /unproven/);
    fs.writeFileSync(journal, JSON.stringify(transaction));
    assert.throws(() => releaseFullWaiterBeforeEffects(root, transaction, journal, { afterWrite: point => { if (point === 'receipt') throw new Error('receipt_crash'); } }), /receipt_crash/);
    assert.equal(JSON.parse(fs.readFileSync(eventFile)).fullUpdateWaiter.phase, 'effects_started');
    assert.throws(() => releaseFullWaiterBeforeEffects(root, transaction, journal, { afterWrite: point => { if (point === 'event') throw new Error('event_crash'); } }), /event_crash/);
    const released = releaseFullWaiterBeforeEffects(root, transaction, journal);
    assert.throws(() => releaseFullWaiterBeforeEffects(root, { ...transaction, fullUpdateWaiter: { ...fullUpdateWaiter, revision: 88 } }, journal), /cas_conflict/);
    assert.equal(released.phase, 'released'); assert.equal(released.effect, 'settled');
    assert.ok(released.receiptDigest); assert.equal(digest(fs.readFileSync(databasePath)), dbBefore);
});


test('captured full baseline binds immutable receipt, actual process and serving identity', t => {
    const root = fixture(t), receipt = fullReceiptFixture(root);
    const binding = recordFullClientPublicationBaseline(root, receipt, { verifyClosure: verifyAssetClosure });
    const previous = { serverBuildId: receipt.serverBuildId, clientBuildId: receipt.clientBuildId, clientOid: oid(1),
        controlManifestSha256: binding.installedControlDigest, nodeModulesTreeSha256: receipt.nodeModulesTreeSha256,
        runtime: { pid: receipt.pid, startTime: receipt.startTime } };
    const snapshot = captureClientPublicationBaseline(root, previous);
    const { snapshotDigest, ...plain } = snapshot; assert.equal(snapshotDigest, digest(plain));
    assert.throws(() => captureClientPublicationBaseline(root, { ...previous, clientOid: oid(9) }), /capture_changed/);
    assert.throws(() => captureClientPublicationBaseline(root, { ...previous, runtime: { ...previous.runtime, startTime: '0' } }), /capture_process_changed/);
    const transaction = { pair: { previous: { ...previous, clientPublication: snapshot }, databaseState: 'UNKNOWN' } };
    assert.throws(() => recordClientPublicationRollbackBaseline(root, transaction, { validateTerminal: () => true }), /terminal_unverified/);
    assert.throws(() => recordClientPublicationRollbackBaseline(root, { pair: { previous: { clientPublication: { ...snapshot, snapshotDigest: hex(9) } } } }, {}), /snapshot_changed/);
});

test('shared serving lineage preserves protection and advances retirement epoch with strict CAS', () => {
    const input = { receiptDigest: hex(1), generationId: hex(2), baseReceiptDigest: hex(3), assetManifestDigest: hex(4), buildId: hex(5), expectedReceiptDigest: null };
    let ledger = advanceClientServingLineageRecord({}, input);
    assert.equal(ledger.clientPublicationGenerations[hex(2)].epoch, 1);
    assert.throws(() => advanceClientServingLineageRecord(ledger, input), /lineage_conflict/);
    assert.throws(() => advanceClientServingLineageRecord({}, { ...input, buildId: 'invalid' }), /identity_invalid/);
    ledger = advanceClientServingLineageRecord(ledger, { ...input, receiptDigest: hex(6), generationId: hex(7), expectedReceiptDigest: hex(1) });
    assert.equal(ledger.clientPublicationGenerations[hex(2)].serving, false);
    ledger = advanceClientServingLineageRecord(ledger, { ...input, receiptDigest: hex(8), expectedReceiptDigest: hex(6) });
    assert.equal(ledger.clientPublicationGenerations[hex(2)].epoch, 2);
    assert.deepEqual(ledger.clientPublicationGenerations[hex(2)].protectionOwners, [hex(1), hex(8)]);
    ledger = advanceClientServingLineageRecord(ledger, { ...input, receiptDigest: hex(9), expectedReceiptDigest: hex(8) });
    assert.equal(ledger.clientPublicationGenerations[hex(2)].epoch, 2);
    assert.throws(() => advanceClientServingLineageRecord({ clientPublicationServing: { receiptDigest: hex(1), generationId: hex(9) } }, { ...input, expectedReceiptDigest: hex(1) }), /epoch_invalid/);
});

for (const point of ['baseline', 'runtime', 'lineage', 'ledger']) test(`full receipt reconciliation preserves waiter until durable ${point} replay completes`, async t => {
    const root = fixture(t), receipt = { ...fullReceiptFixture(root), targetDigest: hex(7), actionId: 'full-fixture', servedAt: Date.now() };
    const control = path.join(root, '.git');
    const write = (name, value) => fs.writeFileSync(path.join(control, name), JSON.stringify(value), { mode: 0o600 });
    write(`nassaj-oid-pair-serving-${receipt.transactionNonce}.json`, receipt);
    const terminal = { ...receipt, outcome: 'activated' };
    write(`nassaj-oid-pair-receipt-${receipt.transactionNonce}.json`, terminal);
    write(`nassaj-oid-control-transaction-1-${receipt.transactionNonce}.json`, {
        schema: 'nassaj-oid-control-transaction/v1', state: 'pair_served', sequence: 1,
        actionId: receipt.actionId, transactionNonce: receipt.transactionNonce,
        pair: { targetDigest: receipt.targetDigest, target: { clientBuildId: receipt.clientBuildId, serverBuildId: receipt.serverBuildId,
            clientTreeSha256: hashOidPairTree(path.join(root, 'dist')) }, receipt: terminal, receiptSha256: digest(Buffer.from(JSON.stringify(terminal))) } });
    const eventName = 'nassaj-preview-oid-event-control-0000000000000001.json';
    write(eventName, { localUpdate: { sequence: 1, revision: 1, phase: 'awaiting_serving', targetDigest: receipt.targetDigest,
        activation: { actionId: receipt.actionId, transactionNonce: receipt.transactionNonce } },
        fullUpdateWaiter: { sequence: 1, revision: 2, requestId: 'local-update:1', transactionNonce: receipt.transactionNonce, phase: 'effects_started' } });
    const priorMode = process.env.NODE_ENV, priorFault = process.env.NASSAJ_OID_CAPSULE_FAIL_AT;
    process.env.NODE_ENV = 'test'; process.env.NASSAJ_OID_CAPSULE_FAIL_AT = `full_baseline_after_${point}`;
    try { await assert.rejects(reconcileOidPairServingReceipt(root, receipt), /injected_failure/); }
    finally {
        if (priorMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorMode;
        if (priorFault === undefined) delete process.env.NASSAJ_OID_CAPSULE_FAIL_AT; else process.env.NASSAJ_OID_CAPSULE_FAIL_AT = priorFault;
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(control, eventName))).fullUpdateWaiter.phase, 'effects_started');
    await reconcileOidPairServingReceipt(root, receipt);
    const serving = JSON.parse(fs.readFileSync(path.join(control, 'nassaj-client-publication-serving-v1.json')));
    const binding = JSON.parse(fs.readFileSync(path.join(control, 'nassaj-client-publication-runtime-v1.json')));
    const ledger = JSON.parse(fs.readFileSync(path.join(control, 'nassaj-local-preview-ledger-v1.json')));
    assert.equal(binding.baseReceiptDigest, serving.baseReceiptDigest);
    assert.equal(ledger.clientPublicationServing.receiptDigest, serving.receiptDigest);
    const settled = JSON.parse(fs.readFileSync(path.join(control, eventName)));
    assert.equal(settled.fullUpdateWaiter.phase, 'released'); assert.equal(settled.localUpdate.phase, 'activated');
    const before = JSON.stringify(ledger); await reconcileOidPairServingReceipt(root, receipt);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(control, 'nassaj-local-preview-ledger-v1.json')))), before);
});
