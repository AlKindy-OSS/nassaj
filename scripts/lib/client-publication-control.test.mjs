import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readClientPublicationPolicy, CLIENT_PUBLICATION_POLICY } from './client-publication-policy.mjs';
import { reserveClientPublication, transitionClientPublication, readClientPublicationBlockers, reserveFullUpdateWaiter } from './client-publication-control.mjs';
import { prepareLocalUpdate, cancelLocalUpdate, recordLocalPreparationFailure } from './local-update-control.mjs';
import { readArchivedClientAsset } from '../../server/services/client-publication-static.js';
import { applyClientServingLineage } from '../local-preview-ledger.mjs';
import { createHash } from 'node:crypto';
const hash = v => createHash('sha256').update(v).digest('hex');
const H = 'a'.repeat(64);
function fixture(t) {
    const root = fs.mkdtempSync(path.resolve('.test-publication-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-qm', 'baseline');
    const oid = git('rev-parse', 'HEAD');
    const binding = { installationId: 'test', canonicalProjectRoot: root, canonicalGitCommonDir: `${root}/.git`,
        serviceIdentity: 'test', serviceUid: process.getuid(), capabilities: Object.fromEntries(['executor', 'state', 'static', 'rollback'].map(k => [k, 'nassaj-dev-client-publication/v1'])),
        baseReceiptDigest: H, serverIdentity: { sourceOid: oid, buildId: H, pid: process.pid, startTime: '123' } };
    const policy = { schema: 'nassaj-client-publication-policy/v1', mode: 'dev-client-auto', revision: 1, ...binding };
    const file = `${root}/.git/${CLIENT_PUBLICATION_POLICY}`;
    const enable = () => fs.writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
    return { root, oid, binding, policy, file, enable, event: { sequence: 1, oid, domains: ['client'] } };
}
test('policy absent off, malformed/foreign/writable/symlink and nonpositive PID refused', t => {
    const v = fixture(t);
    assert.equal(readClientPublicationPolicy(v.root).mode, 'button-only');
    v.enable(); assert.equal(readClientPublicationPolicy(v.root, v.binding).mode, 'dev-client-auto');
    assert.throws(() => readClientPublicationPolicy(v.root, { ...v.binding, installationId: 'other' }), /installation_mismatch/);
    for (const pid of [0, -1]) assert.throws(() => readClientPublicationPolicy(v.root, { ...v.binding, serverIdentity: { ...v.binding.serverIdentity, pid } }), /baseline_unproven/);
    fs.chmodSync(v.file, 0o666); assert.throws(() => readClientPublicationPolicy(v.root, v.binding), /control_file|permissions/);
    fs.chmodSync(v.file, 0o600); fs.writeFileSync(v.file, '{}'); assert.throws(() => readClientPublicationPolicy(v.root, v.binding), /policy_invalid/);
    fs.unlinkSync(v.file); fs.symlinkSync('absent', v.file); assert.throws(() => readClientPublicationPolicy(v.root, v.binding));
});
test('event CAS and unknown effects never release; independent events cannot steal reservation', async t => {
    const v = fixture(t); v.enable();
    const first = await reserveClientPublication(v.root, v.event, v.binding);
    assert.deepEqual(await reserveClientPublication(v.root, v.event, v.binding), first);
    await assert.rejects(reserveClientPublication(v.root, { ...v.event, sequence: 2 }, v.binding), /reservation_busy/);
    const next = await transitionClientPublication(v.root, first, { phase: 'recovery_required', effect: 'unknown' });
    await assert.rejects(transitionClientPublication(v.root, first, { phase: 'building' }), /revision_conflict/);
    await assert.rejects(transitionClientPublication(v.root, next, { phase: 'cancelled' }), /recovery_required/);
    assert.equal(readClientPublicationBlockers(v.root).publications.length, 1);
});
test('durable full waiter wins and cancellation releases only the matching pre-effect request', async t => {
    const v = fixture(t); v.enable();
    const local = await prepareLocalUpdate(v.root, { mode: 'local-main', expectedOid: v.oid, ownerId: '1', idempotencyKey: 'button' });
    for (let i = 0; i < 4; i++) await recordLocalPreparationFailure(v.root, local.sequence, { code: 'resource_ceiling' });
    assert.equal(readClientPublicationBlockers(v.root).fullUpdates.length, 1);
    await assert.rejects(reserveClientPublication(v.root, { ...v.event, sequence: 2 }, v.binding), /full_update_waiting/);
    await cancelLocalUpdate(v.root, { mode: 'local-main', ownerId: '1', sequence: local.sequence, expectedRevision: 5 });
    assert.equal(readClientPublicationBlockers(v.root).fullUpdates.length, 0);
    const dev = await reserveClientPublication(v.root, { ...v.event, sequence: 2 }, v.binding);
    await transitionClientPublication(v.root, dev, { phase: 'build_failed', effect: 'none' });
    assert.equal(readClientPublicationBlockers(v.root).publications.length, 0);
});
test('release waiter is persistent and idempotent before any outer lock', async t => {
    const v = fixture(t);
    const input = { requestId: 'release:one', ownerId: '1', sourceOid: v.oid };
    const first = await reserveFullUpdateWaiter(v.root, input);
    assert.deepEqual(await reserveFullUpdateWaiter(v.root, input), first);
    assert.equal(readClientPublicationBlockers(v.root).fullUpdates[0].requestId, 'release:one');
});
test('generation archive serves sealed bytes after another generation activates and rejects aliases/tampering', t => {
    const v = fixture(t), relative = 'assets/lazy.js', bytes = Buffer.from('lazy');
    const dir = path.join(v.root, '.nassaj-local-preview/client-assets/generations', H);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), bytes);
    const manifest = { schema: 'nassaj-client-assets/v1', generationId: H, sourceOid: v.oid, buildId: H,
        entries: [{ path: relative, sha256: hash(bytes), size: bytes.length }] };
    fs.writeFileSync(path.join(dir, 'CLIENT_ASSET_MANIFEST.json'), JSON.stringify(manifest));
    assert.deepEqual(readArchivedClientAsset(v.root, H, relative).bytes, bytes);
    assert.throws(() => readArchivedClientAsset(v.root, H, '../secret'));
    fs.writeFileSync(path.join(dir, relative), 'evil'); assert.throws(() => readArchivedClientAsset(v.root, H, relative), /identity_invalid/);
    fs.unlinkSync(path.join(dir, relative)); fs.symlinkSync('/etc/passwd', path.join(dir, relative)); assert.throws(() => readArchivedClientAsset(v.root, H, relative));
});
test('retire/reactivate/retire renews epoch and preserves every protected generation without GC', t => {
    const v = fixture(t), a = H, b = 'b'.repeat(64);
    const write = (id, expected, receipt) => applyClientServingLineage(v.root, { generationId: id, expectedReceiptDigest: expected,
        receiptDigest: receipt, baseReceiptDigest: H, assetManifestDigest: H, buildId: H });
    write(a, null, a); write(b, a, b); write(a, b, 'c'.repeat(64)); write(b, 'c'.repeat(64), 'd'.repeat(64));
    const ledger = JSON.parse(fs.readFileSync(`${v.root}/.git/nassaj-local-preview-ledger-v1.json`));
    assert.equal(ledger.clientPublicationGenerations[a].epoch, 2);
    assert.equal(ledger.clientPublicationGenerations[a].serving, false);
    assert.equal(ledger.clientPublicationGenerations[b].serving, true);
    assert.equal(ledger.clientPublicationGenerations[a].protectionOwners.length, 2);
    assert.throws(() => write(a, null, a), /lineage_conflict/);
});

test('real full-baseline producer is accepted by readers, with stale process and changed pointers refused', async t => {
    const { readClientPublicationRuntime, readClientPublicationServing } = await import('./client-publication-runtime.mjs');
    const { installUpdateRuntimeBundle } = await import('./update-runtime-bundle.mjs');
    const { recordFullClientPublicationBaseline } = await import('./client-publication-baseline.mjs');
    const { createClientAssetManifest } = await import('./client-publication-artifacts.mjs');
    const v = fixture(t), nonce = 'e'.repeat(64), server = `${v.root}/dist-server`;
    fs.mkdirSync(server); fs.mkdirSync(`${v.root}/dist`);
    fs.writeFileSync(`${v.root}/entry.mjs`, 'export const fixture = true;');
    const bundle = installUpdateRuntimeBundle(v.root, server, { entries: ['entry.mjs'] });
    const control = JSON.stringify({ oid: v.oid, serverBuildId: H, updateRuntimeBuildId: bundle.manifest.buildId,
        capabilities: { clientPublicationV1: 'nassaj-dev-client-publication/v1' } });
    fs.writeFileSync(`${server}/OID_CONTROL_MANIFEST.json`, control);
    fs.writeFileSync(`${v.root}/dist/index.html`, '<html></html>');
    fs.writeFileSync(`${v.root}/dist/version.json`, JSON.stringify({ buildId: H }));
    fs.writeFileSync(`${v.root}/dist/BUILD_PROVENANCE.json`, JSON.stringify({ artifact: 'client', buildId: H, commit: v.oid }));
    createClientAssetManifest(`${v.root}/dist`, { generationId: H, sourceOid: v.oid, buildId: H }, () => {});
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
    const proof = { sequence: 1, transactionNonce: nonce, outcome: 'served', pid: process.pid, startTime,
        serverBuildId: H, clientBuildId: H, nodeModulesTreeSha256: H };
    fs.writeFileSync(`${v.root}/.git/nassaj-oid-pair-serving-${nonce}.json`, JSON.stringify(proof), { mode: 0o600 });
    const binding = recordFullClientPublicationBaseline(v.root, proof, { verifyClosure: () => {}, rollbackDirectories: [server] });
    assert.deepEqual(readClientPublicationRuntime(v.root), binding);
    const servingFile = `${v.root}/.git/nassaj-client-publication-serving-v1.json`, serving = readClientPublicationServing(v.root);
    assert.equal(serving.buildId, H);
    fs.writeFileSync(servingFile, JSON.stringify({ ...serving, sourceOid: '1'.repeat(40) }));
    assert.throws(() => readClientPublicationServing(v.root), /pointer_changed/);
    fs.writeFileSync(servingFile, JSON.stringify(serving));
    const runtime = `${v.root}/.git/nassaj-client-publication-runtime-v1.json`;
    fs.writeFileSync(runtime, JSON.stringify({ ...binding, serverIdentity: { ...binding.serverIdentity, startTime: '0' } }));
    assert.throws(() => readClientPublicationRuntime(v.root), /process_changed/);
    fs.writeFileSync(runtime, JSON.stringify(binding)); fs.writeFileSync(`${server}/OID_CONTROL_MANIFEST.json`, '{}');
    assert.throws(() => readClientPublicationRuntime(v.root), /control_changed/);
});

test('static middleware uses generation URL and returns bounded no-store errors without SPA fallback', async t => {
    const { createClientPublicationStaticMiddleware } = await import('../../server/services/client-publication-static.js');
    const v = fixture(t), middleware = createClientPublicationStaticMiddleware(v.root);
    for (const [method, url, expected] of [['POST', '/x', 405], ['GET', '/%2fetc/passwd', 404], ['GET', '/bad/a.js', 404]]) {
        const response = { code: 200, headers: {}, status(code) { this.code = code; return this; },
            setHeader(key, value) { this.headers[key] = value; }, end() { this.ended = true; } };
        middleware({ method, url }, response);
        assert.equal(response.code, expected); assert.equal(response.ended, true);
    }
});

test('terminal publication receipt cannot be forged by supplying a correctly shaped hash', async t => {
    const v = fixture(t); v.enable();
    const state = await reserveClientPublication(v.root, v.event, v.binding);
    await assert.rejects(transitionClientPublication(v.root, state, { phase: 'served', effect: 'settled', receiptDigest: H }), /receipt_required/);
    assert.equal(readClientPublicationBlockers(v.root).publications.length, 1);
});

test('dynamic manifest keeps branding fields and pins icon URLs to verified generation bytes', async t => {
    const { readServedClientManifest } = await import('../../server/services/client-publication-static.js');
    const v = fixture(t), manifest = { name: 'Original', short_name: 'Original', icons: [{ src: '/logo.png?v=20260616#icon' }] };
    const raw = JSON.stringify(manifest), logo = Buffer.from('png'), generationId = H;
    const entries = [{ path: 'manifest.json', sha256: hash(raw), size: Buffer.byteLength(raw) }, { path: 'logo.png', sha256: hash(logo), size: logo.length }];
    const assets = JSON.stringify({ schema: 'nassaj-client-assets/v1', generationId, sourceOid: v.oid, buildId: H, entries });
    const archive = `${v.root}/.nassaj-local-preview/client-assets/generations/${generationId}`;
    for (const dir of [`${v.root}/dist`, archive]) {
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(`${dir}/manifest.json`, raw);
        fs.writeFileSync(`${dir}/logo.png`, logo); fs.writeFileSync(`${dir}/CLIENT_ASSET_MANIFEST.json`, assets);
    }
    const served = readServedClientManifest(v.root);
    assert.equal(served.name, 'Original');
    assert.equal(served.icons[0].src, `/assets/generations/${generationId}/logo.png?v=20260616#icon`);
    fs.writeFileSync(`${v.root}/dist/manifest.json`, '{}');
    assert.throws(() => readServedClientManifest(v.root), /generation_invalid/);
});

test('release completion requires checksum, matching durable receipt and reopened verified gate', async t => {
    const { settleReleaseUpdateWaiter } = await import('./client-publication-control.mjs');
    const { clientPublicationDigest } = await import('./client-publication-artifacts.mjs');
    const v = fixture(t), jobId = 'release1', transactionId = 'update-test';
    await reserveFullUpdateWaiter(v.root, { requestId: `release-update:${jobId}`, ownerId: '1', sourceOid: v.oid });
    const directory = `${v.root}/.git/nassaj-source-update`; fs.mkdirSync(`${directory}/job-receipts`, { recursive: true });
    const factsJson = JSON.stringify({ runtimeIdentities: { client: H, server: H } });
    const receiptFile = `${directory}/job-receipts/${jobId}.00000001.json`;
    fs.writeFileSync(receiptFile, JSON.stringify({ schemaVersion: 2, jobId, phase: 'runtime_verifying', kind: 'done', factsJson, factsSha256: hash(factsJson) }), { mode: 0o600 });
    const maintenance = { schema: 'nassaj-source-update-maintenance/v1', transactionId, state: 'OPEN', phase: 'ACTIVE_VERIFIED', identity: { targetCommit: v.oid }, runtimeIdentities: { client: H, server: H } };
    fs.writeFileSync(`${directory}/journal.json`, JSON.stringify({ ...maintenance, checksum: 'bad' }), { mode: 0o600 });
    await assert.rejects(settleReleaseUpdateWaiter(v.root, { jobId, transactionId, receiptFile }), /maintenance_invalid/);
    fs.writeFileSync(`${directory}/journal.json`, JSON.stringify({ ...maintenance, checksum: clientPublicationDigest(maintenance) }));
    const result = await settleReleaseUpdateWaiter(v.root, { jobId, transactionId, receiptFile });
    assert.equal(result.phase, 'released'); assert.equal(result.effect, 'settled');
    assert.equal(readClientPublicationBlockers(v.root).fullUpdates.length, 0);
});

test('serving receipt advances ledger and durable lineage with CAS and supports retry', async t => {
    const { createClientAssetManifest, validateClientAssetManifest } = await import('./client-publication-artifacts.mjs');
    const { writeClientPublicationIntent, advanceClientPublicationJournal, writeClientPublicationOutcome } = await import('./client-publication-journal.mjs');
    const { recordClientPublicationServing, readClientPublicationServing } = await import('./client-publication-runtime.mjs');
    const v = fixture(t), dir = `${v.root}/dist`, nonce = 'f'.repeat(64);
    fs.mkdirSync(dir);
    fs.writeFileSync(`${dir}/index.html`, '<html></html>');
    fs.writeFileSync(`${dir}/version.json`, JSON.stringify({ buildId: H }));
    fs.writeFileSync(`${dir}/BUILD_PROVENANCE.json`, JSON.stringify({ artifact: 'client', commit: v.oid, buildId: H }));
    createClientAssetManifest(dir, { generationId: H, sourceOid: v.oid, buildId: H }, () => {});
    const sealed = validateClientAssetManifest(dir, {}, () => {});
    const identity = { sourceOid: v.oid, buildId: H, treeDigest: sealed.treeDigest, assetManifestDigest: sealed.manifestDigest };
    const baseline = JSON.stringify({ schema: 'nassaj-client-publication-baseline/v1', binding: { baseReceiptDigest: H, baselineOid: v.oid, fullReceipt: { transactionNonce: nonce }, clientIdentity: { ...identity, generationId: H } }, lineage: { schema: 'nassaj-client-publication-serving/v1', baseReceiptDigest: H, kind: 'full', sourceOid: v.oid, buildId: H, assetManifestDigest: sealed.manifestDigest, generationId: H } }), parent = hash(baseline);
    fs.writeFileSync(`${v.root}/.git/nassaj-oid-pair-serving-${nonce}.json`, JSON.stringify({ clientBuildId: H }), { mode: 0o600 });
    fs.writeFileSync(`${v.root}/.git/nassaj-client-publication-baseline-${H}.json`, baseline, { mode: 0o600 });
    fs.writeFileSync(`${v.root}/.git/nassaj-client-publication-serving-v1.json`, JSON.stringify({ schema: 'nassaj-client-publication-serving/v1', baseReceiptDigest: H, receiptDigest: parent, kind: 'full', sourceOid: v.oid, buildId: H, assetManifestDigest: sealed.manifestDigest, generationId: H }), { mode: 0o600 });
    const serverIdentity = { sourceOid: v.oid, buildId: H, pid: process.pid, startTime: '123', controlManifestDigest: H, baseReceiptDigest: H };
    const intent = { schema: 'nassaj-oid-client-publication/v1', kind: 'client-publication', transactionNonce: nonce,
        sequence: 1, sourceOid: v.oid, policyRevision: 1, reservationId: 'test', baseReceiptDigest: H,
        parentServingReceiptDigest: parent, serverIdentity, dependencyIdentity: H, previousClientIdentity: identity,
        targetClientIdentity: identity, candidateManifestDigest: identity.treeDigest, compatibilityProofDigest: H, assetManifestDigest: sealed.manifestDigest };
    let journal = writeClientPublicationIntent(v.root, intent);
    journal = advanceClientPublicationJournal(v.root, journal, 'publishing');
    journal = advanceClientPublicationJournal(v.root, journal, 'verifying');
    const evidence = { schema: 'nassaj-client-http-serving/v1', files: ['index.html', 'version.json'].map(name => ({ path: name, status: 200, sha256: hash(fs.readFileSync(`${dir}/${name}`)) })) };
    const outcome = writeClientPublicationOutcome(v.root, journal, { outcome: 'served', actualServerIdentity: serverIdentity, parentServingReceiptDigest: parent, servingEvidence: evidence });
    const result = recordClientPublicationServing(v.root, outcome, { expectedParentReceiptDigest: parent });
    assert.equal(result.receiptDigest, outcome.receiptDigest);
    assert.deepEqual(recordClientPublicationServing(v.root, outcome, { expectedParentReceiptDigest: parent }), result);
    assert.equal(readClientPublicationServing(v.root).receiptDigest, outcome.receiptDigest);
});

test('real public manifest endpoint preserves branding, all query icon URLs and no-cache', async t => {
    const { createClientManifestHandler } = await import('../../server/services/client-publication-static.js');
    const v = fixture(t), raw = fs.readFileSync('public/manifest.json'), original = JSON.parse(raw);
    const files = new Map([['manifest.json', raw]]);
    for (const icon of original.icons) {
        const relative = icon.src.split(/[?#]/)[0].slice(1);
        files.set(relative, fs.readFileSync(path.join('public', relative)));
    }
    const entries = [...files].map(([name, bytes]) => ({ path: name, size: bytes.length, sha256: hash(bytes) }));
    const manifest = { schema: 'nassaj-client-assets/v1', generationId: H, sourceOid: v.oid, buildId: H, entries };
    for (const directory of [`${v.root}/dist`, `${v.root}/.nassaj-local-preview/client-assets/generations/${H}`]) {
        for (const [name, bytes] of files) { fs.mkdirSync(path.dirname(`${directory}/${name}`), { recursive: true }); fs.writeFileSync(`${directory}/${name}`, bytes); }
        fs.writeFileSync(`${directory}/CLIENT_ASSET_MANIFEST.json`, JSON.stringify(manifest));
    }
    let title = 'هوية أولى';
    const handler = createClientManifestHandler(v.root, () => title);
    const request = () => {
        const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, type(v) { this.mime = v; return this; }, send(v) { this.body = JSON.parse(v); return this; } };
        handler({}, response); return response;
    };
    const first = request();
    assert.equal(first.headers['Cache-Control'], 'no-cache'); assert.equal(first.body.name, title);
    assert.equal(first.body.icons.length, 16);
    for (const icon of first.body.icons) assert.match(icon.src, /^\/assets\/generations\/[a-f0-9]{64}\/icons\/[^?]+\?v=20260616$/);
    title = 'هوية ثانية'; assert.equal(request().body.name, title);
});

test('CLI restart with revoked policy keeps the recovery path reachable and fails on missing loaded proof', async t => {
    const { spawnSync } = await import('node:child_process');
    const v = fixture(t); v.enable();
    const state = await reserveClientPublication(v.root, v.event, v.binding);
    await transitionClientPublication(v.root, state, { phase: 'recovery_required', effect: 'unknown' });
    fs.unlinkSync(v.file);
    const result = spawnSync(process.execPath, [path.resolve('scripts/preview-oid-consumer.mjs'), '--repo', v.root], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, NASSAJ_PREVIEW_OID_ENFORCEMENT: '1', NASSAJ_PREVIEW_OID_DOMAINS: 'client', NASSAJ_UPDATE_MODE: 'release' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /client_publication_loaded_baseline_unproven/);
    assert.doesNotMatch(result.stderr, /node_update_button_required/);
    assert.equal(readClientPublicationBlockers(v.root).publications[0].effect, 'unknown');
});

test('local button allocates beyond a released release waiter without overwriting its evidence', async t => {
    const { failReleaseUpdateWaiter } = await import('./client-publication-control.mjs');
    const v = fixture(t);
    const waiter = await reserveFullUpdateWaiter(v.root, { requestId: 'release:old', ownerId: '1', sourceOid: v.oid });
    await failReleaseUpdateWaiter(v.root, waiter);
    const local = await prepareLocalUpdate(v.root, { mode: 'local-main', expectedOid: v.oid, ownerId: '1', idempotencyKey: 'next' });
    assert.equal(local.sequence, waiter.sequence + 1);
});
