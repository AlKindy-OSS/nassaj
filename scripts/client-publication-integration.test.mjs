import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { installUpdateRuntimeBundle } from './lib/update-runtime-bundle.mjs';
import { recordFullClientPublicationBaseline } from './lib/client-publication-baseline.mjs';
import { readClientPublicationRuntime, readClientPublicationServing, recordClientPublicationServing } from './lib/client-publication-runtime.mjs';
import { createClientAssetManifest, validateClientAssetManifest, clientPublicationDigest as digest } from './lib/client-publication-artifacts.mjs';
import { writeClientPublicationIntent, advanceClientPublicationJournal, writeClientPublicationOutcome } from './lib/client-publication-journal.mjs';
import { reserveClientPublication, transitionClientPublication, readClientPublication } from './lib/client-publication-control.mjs';
import { prepareLocalUpdate, recordLocalPreparationFailure, cancelLocalUpdate } from './lib/local-update-control.mjs';
import { retainClientPublicationConsumerBundle, verifyClientPublicationConsumerBundle, verifyRetainedClientPublicationConsumerBundle } from './client-publication-consumer-launcher.mjs';
import { verifyAssetClosure } from './client-build-atomic.mjs';
import { resolveClientBuildSandbox } from './lib/client-publication-isolation.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H = n => String(n).repeat(64);
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const git = (root, ...args) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();

function removeFixture(directory) {
    if (!fs.existsSync(directory)) return;
    const writable = current => {
        if (!fs.lstatSync(current).isDirectory()) return;
        fs.chmodSync(current, 0o700);
        for (const name of fs.readdirSync(current)) writable(path.join(current, name));
    };
    writable(directory); fs.rmSync(directory, { recursive: true, force: true });
}

function sourceRevision(v, name) {
    git(v.root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', name);
    v.oid = git(v.root, 'rev-parse', 'HEAD');
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(PROJECT, '.test-publication-integration-'));
    t.after(() => removeFixture(root));
    git(root, 'init', '-q', '-b', 'main');
    // Full-update installation creates the parent of the admission/activity lock files.
    fs.mkdirSync(path.join(root, '.git/nassaj-source-update'), { mode: 0o700 });
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'baseline');
    const oid = git(root, 'rev-parse', 'HEAD'), server = path.join(root, 'dist-server');
    fs.mkdirSync(server);
    const bundle = installUpdateRuntimeBundle(PROJECT, server);
    return { root, oid, server, bundle };
}

function generation(directory, oid, buildId) {
    fs.mkdirSync(path.join(directory, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.html'), `<script src="/assets/generations/${buildId}/assets/app.js"></script>`);
    fs.writeFileSync(path.join(directory, 'assets/app.js'), `console.log('${buildId}')`);
    write(path.join(directory, 'version.json'), { buildId });
    write(path.join(directory, 'BUILD_PROVENANCE.json'), { artifact: 'client', commit: oid, buildId, generationId: buildId });
    createClientAssetManifest(directory, { sourceOid: oid, buildId, generationId: buildId }, verifyAssetClosure);
    const sealed = validateClientAssetManifest(directory, {}, verifyAssetClosure);
    return { sourceOid: oid, buildId, assetManifestDigest: sealed.manifestDigest, treeDigest: sealed.treeDigest };
}

function fullBaseline(v, n) {
    const buildId = H(n), nonce = H(n + 1);
    write(path.join(v.server, 'OID_CONTROL_MANIFEST.json'), { oid: v.oid, serverBuildId: buildId,
        updateRuntimeBuildId: v.bundle.manifest.buildId, capabilities: { clientPublicationV1: 'nassaj-dev-client-publication/v1' } });
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const receipt = { sequence: n, transactionNonce: nonce, outcome: 'served', pid: process.pid,
        startTime: stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19], serverBuildId: buildId, clientBuildId: buildId, nodeModulesTreeSha256: H(9) };
    write(path.join(v.root, '.git', `nassaj-oid-pair-serving-${nonce}.json`), receipt);
    return recordFullClientPublicationBaseline(v.root, receipt, { verifyClosure: verifyAssetClosure, rollbackDirectories: [v.server] });
}

function publicationIntent(v, binding, previous, target, sequence, reservationId = `reservation-${sequence}`) {
    return { schema: 'nassaj-oid-client-publication/v1', kind: 'client-publication', sequence, transactionNonce: H(sequence),
        sourceOid: target.sourceOid, policyRevision: 1, reservationId, baseReceiptDigest: binding.baseReceiptDigest,
        parentServingReceiptDigest: readClientPublicationServing(v.root).receiptDigest, serverIdentity: binding.serverIdentity,
        dependencyIdentity: binding.dependencyIdentity, previousClientIdentity: previous, targetClientIdentity: target,
        candidateManifestDigest: target.treeDigest, compatibilityProofDigest: H(9), assetManifestDigest: target.assetManifestDigest };
}

function serveClient(v, binding, previous, n) {
    sourceRevision(v, `client-${n}`);
    const directory = path.join(v.root, `candidate-${n}`), target = generation(directory, v.oid, H(n));
    const intent = publicationIntent(v, binding, previous, target, n);
    let journal = writeClientPublicationIntent(v.root, intent);
    journal = advanceClientPublicationJournal(v.root, journal, 'publishing');
    fs.renameSync(path.join(v.root, 'dist'), path.join(v.root, `previous-${n}`));
    fs.renameSync(directory, path.join(v.root, 'dist'));
    journal = advanceClientPublicationJournal(v.root, journal, 'verifying');
    // HTTP is an explicit fixture boundary here; real HTTP/publisher coverage is in core tests.
    const servingEvidence = { schema: 'nassaj-client-http-serving/v1', files: ['index.html', 'version.json'].map(name => ({
        path: name, status: 200, sha256: digest(fs.readFileSync(path.join(v.root, 'dist', name))) })) };
    const outcome = writeClientPublicationOutcome(v.root, journal, { outcome: 'served', actualServerIdentity: binding.serverIdentity,
        parentServingReceiptDigest: intent.parentServingReceiptDigest, servingEvidence });
    recordClientPublicationServing(v.root, outcome, { expectedParentReceiptDigest: intent.parentServingReceiptDigest });
    return { target, outcome, serving: readClientPublicationServing(v.root) };
}

test('real full writer and serving readers preserve B0/A1/A2/B1/C1 and failed button preparation', async t => {
    const v = fixture(t), initial = generation(path.join(v.root, 'dist'), v.oid, H(1));
    const b0 = fullBaseline(v, 1);
    assert.deepEqual(readClientPublicationRuntime(v.root), b0);
    const a1 = serveClient(v, b0, initial, 3), a2 = serveClient(v, b0, a1.target, 4);
    assert.equal(a2.outcome.intent.parentServingReceiptDigest, a1.serving.receiptDigest);
    assert.notEqual(a2.target.sourceOid, a1.target.sourceOid);
    assert.equal(a2.outcome.intent.serverIdentity.sourceOid, b0.baselineOid);
    assert.equal(readClientPublicationRuntime(v.root).baseReceiptDigest, b0.baseReceiptDigest);
    const before = fs.readFileSync(path.join(v.root, 'dist/index.html'));
    const button = await prepareLocalUpdate(v.root, { mode: 'local-main', expectedOid: v.oid, ownerId: '1', idempotencyKey: 'failed-full-prep' });
    await recordLocalPreparationFailure(v.root, button.sequence, { code: 'candidate_build_failed' });
    assert.deepEqual(readClientPublicationServing(v.root), a2.serving);
    assert.deepEqual(fs.readFileSync(path.join(v.root, 'dist/index.html')), before);
    fs.renameSync(path.join(v.root, 'dist'), path.join(v.root, 'full-previous-A2'));
    sourceRevision(v, 'full-B1');
    const b1Identity = generation(path.join(v.root, 'dist'), v.oid, H(5)), b1 = fullBaseline(v, 5);
    assert.equal(b1.previousServingReceiptDigest, a2.serving.receiptDigest);
    assert.equal(validateClientAssetManifest(path.join(v.root, 'full-previous-A2'), {}, verifyAssetClosure).manifest.buildId, H(4));
    assert.deepEqual(readClientPublicationRuntime(v.root), b1);
    const b1Serving = readClientPublicationServing(v.root), c1 = serveClient(v, b1, b1Identity, 7);
    assert.equal(c1.serving.baseReceiptDigest, b1.baseReceiptDigest);
    assert.equal(c1.outcome.intent.parentServingReceiptDigest, b1Serving.receiptDigest);
    assert.throws(() => recordClientPublicationServing(v.root, a1.outcome, { expectedParentReceiptDigest: a1.outcome.intent.parentServingReceiptDigest }), /lineage_conflict/);
});

test('verified production launcher refuses altered installed bytes and retains its boot closure across live swaps', t => {
    const v = fixture(t); generation(path.join(v.root, 'dist'), v.oid, H(1)); fullBaseline(v, 1);
    const retained = retainClientPublicationConsumerBundle(v.root);
    const installed = path.join(v.server, 'UPDATE_RUNTIME_BUNDLE/scripts/preview-oid-consumer.mjs');
    fs.appendFileSync(installed, '\nthrow new Error("untrusted candidate");\n');
    assert.throws(() => verifyClientPublicationConsumerBundle(v.root), /closure_changed/);
    assert.equal(verifyRetainedClientPublicationConsumerBundle(retained.runtimeRoot, retained.buildId).buildId, retained.buildId);
    fs.renameSync(v.server, `${v.server}-old`); fs.mkdirSync(v.server);
    assert.equal(verifyRetainedClientPublicationConsumerBundle(retained.runtimeRoot, retained.buildId).buildId, retained.buildId);
});

test('launcher detects installed file replacement between verification and capture', t => {
    const v = fixture(t); generation(path.join(v.root, 'dist'), v.oid, H(1)); fullBaseline(v, 1);
    assert.throws(() => retainClientPublicationConsumerBundle(v.root, { afterVerify() {
        fs.appendFileSync(path.join(v.server, 'UPDATE_RUNTIME_BUNDLE/scripts/preview-oid-consumer.mjs'), '\n// changed\n');
    } }), /capture_changed/);
});

test('restarting launcher rejects corruption of its previously retained consumer before executing it', t => {
    const v = fixture(t); generation(path.join(v.root, 'dist'), v.oid, H(1)); fullBaseline(v, 1);
    const retained = retainClientPublicationConsumerBundle(v.root);
    const marker = path.join(v.root, 'untrusted-executed');
    fs.writeFileSync(retained.entry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)}, 'bad');`);
    const run = spawnSync(process.execPath, [path.join(PROJECT, 'scripts/client-publication-consumer-launcher.mjs')], {
        cwd: v.root, encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /closure_changed/);
    assert.equal(fs.existsSync(marker), false);
});

test('previously retained production consumer rejects a newer loaded full-baseline bundle before reservation', t => {
    const v = fixture(t); generation(path.join(v.root, 'dist'), v.oid, H(1)); fullBaseline(v, 1);
    const retained = retainClientPublicationConsumerBundle(v.root);
    fs.renameSync(v.server, `${v.server}-old`);
    const source = path.join(`${v.server}-old`, 'UPDATE_RUNTIME_BUNDLE');
    fs.appendFileSync(path.join(source, 'scripts/preview-oid-consumer.mjs'), '\n// next installed full generation\n');
    fs.mkdirSync(v.server); v.bundle = installUpdateRuntimeBundle(source, v.server);
    fs.renameSync(path.join(v.root, 'dist'), path.join(v.root, 'old-client'));
    sourceRevision(v, 'new-full'); generation(path.join(v.root, 'dist'), v.oid, H(5));
    const binding = fullBaseline(v, 5);
    assert.notEqual(binding.updateRuntimeBuildId, retained.buildId);
    write(path.join(v.root, '.git/nassaj-client-publication-policy-v1.json'), {
        ...binding, schema: 'nassaj-client-publication-policy/v1', mode: 'dev-client-auto', revision: 1 });
    git(v.root, 'update-ref', 'refs/nassaj/previews/v1/events/0000000000000003/client', v.oid);
    const result = spawnSync(process.execPath, [retained.entry, '--repo', v.root], {
        cwd: v.root, encoding: 'utf8', timeout: 5000,
        env: { ...process.env, NASSAJ_UPDATE_MODE: 'release', NASSAJ_PREVIEW_OID_ENFORCEMENT: '1', NASSAJ_PREVIEW_OID_DOMAINS: 'client' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /client_publication_installed_consumer_changed/);
    assert.equal(readClientPublication(v.root, 3), null);
    assert.equal(readClientPublicationServing(v.root).buildId, H(5));
});

test('production launcher and restarted consumer settle prepared crash with policy off', async t => {
    const v = fixture(t), previous = generation(path.join(v.root, 'dist'), v.oid, H(1)), binding = fullBaseline(v, 1);
    const policyFile = path.join(v.root, '.git/nassaj-client-publication-policy-v1.json');
    write(policyFile, { ...binding, schema: 'nassaj-client-publication-policy/v1', mode: 'dev-client-auto', revision: 1 });
    const event = { sequence: 3, oid: v.oid, domains: ['client'] };
    git(v.root, 'update-ref', 'refs/nassaj/previews/v1/events/0000000000000003/client', v.oid);
    const reservation = await reserveClientPublication(v.root, event, binding);
    const target = generation(path.join(v.root, 'candidate'), v.oid, H(3));
    const intent = publicationIntent(v, binding, previous, target, 3, reservation.reservationId);
    writeClientPublicationIntent(v.root, intent);
    await transitionClientPublication(v.root, reservation, { phase: 'recovery_required', effect: 'unknown' });
    fs.unlinkSync(policyFile);
    const run = () => spawnSync(process.execPath, [path.join(PROJECT, 'scripts/client-publication-consumer-launcher.mjs')], {
        cwd: v.root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NASSAJ_UPDATE_MODE: 'release', NASSAJ_PREVIEW_OID_ENFORCEMENT: '1', NASSAJ_PREVIEW_OID_DOMAINS: 'client' } });
    const result = run();
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(readClientPublication(v.root, 3).phase, 'cancelled', result.stderr);
    assert.match(result.stderr, /node_update_button_required/);
    assert.equal(readClientPublicationServing(v.root).sourceOid, v.oid);
    assert.equal(validateClientAssetManifest(path.join(v.root, 'dist'), {}, verifyAssetClosure).manifest.buildId, H(1));
    const retry = run();
    assert.match(retry.stderr, /node_update_button_required/);
    assert.equal(readClientPublication(v.root, 3).phase, 'cancelled');
});

test('production consumer obeys durable button priority; concurrent reservations and stale CAS cannot steal its event', async t => {
    const v = fixture(t); generation(path.join(v.root, 'dist'), v.oid, H(1)); const binding = fullBaseline(v, 1);
    write(path.join(v.root, '.git/nassaj-client-publication-policy-v1.json'), {
        ...binding, schema: 'nassaj-client-publication-policy/v1', mode: 'dev-client-auto', revision: 1 });
    const button = await prepareLocalUpdate(v.root, { mode: 'local-main', expectedOid: v.oid, ownerId: '1', idempotencyKey: 'priority' });
    const buttonFile = path.join(v.root, '.git', `nassaj-preview-oid-event-control-${String(button.sequence).padStart(16, '0')}.json`);
    const original = fs.readFileSync(buttonFile);
    git(v.root, 'update-ref', 'refs/nassaj/previews/v1/events/0000000000000003/client', v.oid);
    const run = spawnSync(process.execPath, [path.join(PROJECT, 'scripts/client-publication-consumer-launcher.mjs')], {
        cwd: v.root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NASSAJ_UPDATE_MODE: 'release', NASSAJ_PREVIEW_OID_ENFORCEMENT: '1', NASSAJ_PREVIEW_OID_DOMAINS: 'client' } });
    assert.match(run.stderr, /node_update_button_required/);
    assert.deepEqual(fs.readFileSync(buttonFile), original);
    assert.equal(readClientPublication(v.root, 3), null);
    await recordLocalPreparationFailure(v.root, button.sequence, { code: 'resource_ceiling' });
    await assert.rejects(cancelLocalUpdate(v.root, { mode: 'local-main', ownerId: '1', sequence: button.sequence, expectedRevision: button.revision }), /revision_conflict/);
    await assert.rejects(reserveClientPublication(v.root, { sequence: 3, oid: v.oid }, binding), /full_update_waiting/);
    await cancelLocalUpdate(v.root, { mode: 'local-main', ownerId: '1', sequence: button.sequence, expectedRevision: button.revision + 1 });
    await assert.rejects(reserveClientPublication(v.root, { sequence: button.sequence, oid: v.oid }, binding), /button_event_owned/);
    const racers = await Promise.allSettled([3, 4].map(sequence => reserveClientPublication(v.root, { sequence, oid: v.oid }, binding)));
    assert.equal(racers.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(racers.find(result => result.status === 'rejected').reason.message, /reservation_busy/);
    const winner = racers.find(result => result.status === 'fulfilled').value;
    const changed = await transitionClientPublication(v.root, winner, { phase: 'building' });
    await assert.rejects(transitionClientPublication(v.root, winner, { phase: 'cancelled' }), /revision_conflict/);
    assert.deepEqual(readClientPublication(v.root, winner.sequence), changed);
});

test('consumer restart after exchanged layout uses real isolated HTTP and settles with policy off', async t => {
    const v = fixture(t), previous = generation(path.join(v.root, 'dist'), v.oid, H(1)), binding = fullBaseline(v, 1);
    sourceRevision(v, 'client-after-exchange');
    const policyFile = path.join(v.root, '.git/nassaj-client-publication-policy-v1.json');
    write(policyFile, { ...binding, schema: 'nassaj-client-publication-policy/v1', mode: 'dev-client-auto', revision: 1 });
    const event = { sequence: 3, oid: v.oid, domains: ['client'] };
    git(v.root, 'update-ref', 'refs/nassaj/previews/v1/events/0000000000000003/client', v.oid);
    let reservation = await reserveClientPublication(v.root, event, binding);
    const target = generation(path.join(v.root, 'candidate'), v.oid, H(3));
    const intent = publicationIntent(v, binding, previous, target, 3, reservation.reservationId);
    let journal = writeClientPublicationIntent(v.root, intent);
    journal = advanceClientPublicationJournal(v.root, journal, 'publishing');
    reservation = await transitionClientPublication(v.root, reservation, { phase: 'publishing', effect: 'started' });
    // Materialize the durable crash cut after exchange, before verification/outcome; do not call recovery directly.
    fs.renameSync(path.join(v.root, 'dist'), path.join(v.root, 'previous-client'));
    fs.renameSync(path.join(v.root, 'candidate'), path.join(v.root, 'dist'));
    fs.unlinkSync(policyFile);
    const hostNetwork = fs.readlinkSync('/proc/self/ns/net');
    const result = spawnSync(resolveClientBuildSandbox(), ['--unshare-user', '--unshare-net', '--die-with-parent',
        '--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/home', '--ro-bind', PROJECT, PROJECT,
        '--bind', v.root, v.root, '--', process.execPath,
        path.join(PROJECT, 'scripts/fixtures/client-publication-network-runner.mjs'), v.root,
        path.join(PROJECT, 'scripts/client-publication-consumer-launcher.mjs'), hostNetwork], {
        cwd: v.root, encoding: 'utf8', timeout: 12000,
        env: { ...process.env, NASSAJ_UPDATE_MODE: 'release', NASSAJ_PREVIEW_OID_ENFORCEMENT: '1', NASSAJ_PREVIEW_OID_DOMAINS: 'client' } });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.notEqual(observed.network, hostNetwork);
    assert.deepEqual(observed.requests, ['/', '/version.json'], observed.stderr);
    assert.equal(observed.code, 1, observed.stderr);
    assert.match(observed.stderr, /node_update_button_required/);
    assert.equal(readClientPublication(v.root, event.sequence).phase, 'served', observed.stderr);
    const serving = readClientPublicationServing(v.root);
    assert.equal(serving.sourceOid, target.sourceOid);
    assert.equal(serving.baseReceiptDigest, binding.baseReceiptDigest);
    assert.equal(readClientPublicationRuntime(v.root).serverIdentity.sourceOid, previous.sourceOid);
    assert.equal(validateClientAssetManifest(path.join(v.root, 'previous-client'), {}, verifyAssetClosure).manifest.buildId, H(1));
});

test('production consumer refuses changed main, revoked policy and late full waiter before any publication effect', async t => {
    for (const race of ['main', 'policy', 'full-waiter']) {
        const v = fixture(t); generation(path.join(v.root, 'dist'), v.oid, H(1)); const binding = fullBaseline(v, 1);
        const policyFile = path.join(v.root, '.git/nassaj-client-publication-policy-v1.json');
        write(policyFile, { ...binding, schema: 'nassaj-client-publication-policy/v1', mode: 'dev-client-auto', revision: 1 });
        const event = { sequence: 3, oid: v.oid, domains: ['client'] };
        git(v.root, 'update-ref', 'refs/nassaj/previews/v1/events/0000000000000003/client', v.oid);
        await reserveClientPublication(v.root, event, binding);
        const before = readClientPublicationServing(v.root);
        if (race === 'main') sourceRevision(v, 'changed-after-reservation');
        if (race === 'policy') fs.unlinkSync(policyFile);
        if (race === 'full-waiter') await prepareLocalUpdate(v.root, {
            mode: 'local-main', expectedOid: v.oid, ownerId: '1', idempotencyKey: 'late-priority' });
        const result = spawnSync(process.execPath, [path.join(PROJECT, 'scripts/client-publication-consumer-launcher.mjs')], {
            cwd: v.root, encoding: 'utf8', timeout: 5000,
            env: { ...process.env, NASSAJ_UPDATE_MODE: 'release', NASSAJ_PREVIEW_OID_ENFORCEMENT: '1', NASSAJ_PREVIEW_OID_DOMAINS: 'client' } });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /client_publication_(main_changed|policy_disabled|full_update_waiting)/);
        assert.equal(readClientPublication(v.root, event.sequence).phase, 'superseded', result.stderr);
        assert.equal(readClientPublication(v.root, event.sequence).effect, 'none');
        assert.deepEqual(readClientPublicationServing(v.root), before);
        assert.equal(fs.readdirSync(path.join(v.root, '.git')).some(name => name.startsWith('nassaj-oid-control-transaction-')), false);
    }
});

test('connected real publisher and capsule helpers carry B0/A1/A2/B1/C1 with SQLite preparation and rollback', t => {
    const v = fixture(t), hostNetwork = fs.readlinkSync('/proc/self/ns/net');
    const result = spawnSync(resolveClientBuildSandbox(), ['--unshare-user', '--unshare-net', '--die-with-parent',
        '--ro-bind', '/', '/', '--bind', '/proc', '/proc', '--dev', '/dev', '--tmpfs', '/home', '--ro-bind', PROJECT, PROJECT,
        '--bind', v.root, v.root, '--', process.execPath,
        path.join(PROJECT, 'scripts/fixtures/client-publication-connected-runner.mjs'), v.root, PROJECT, hostNetwork], {
        cwd: v.root, encoding: 'utf8', timeout: 45000,
        env: { ...process.env, TMPDIR: v.root, NASSAJ_UPDATE_MODE: 'release' } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.notEqual(report.network, hostNetwork);
    assert.deepEqual(report.journey, ['B0', 'A1', 'A2', 'B1', 'C1', 'C2-rolled-back']);
    assert.equal(new Set(report.sourceOids).size, 5);
    assert.equal(report.previousClientOid, report.sourceOids[2]);
    assert.equal(report.preparedDatabase, true); assert.equal(report.unknownDowngradeRefused, true);
    assert.equal(report.durableOutcomeRestartRecovered, true);
    assert.ok(report.requests.includes('/health')); assert.ok(report.requests.includes('/version.json'));
});
