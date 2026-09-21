import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareLocalUpdate, readLocalUpdate, confirmLocalUpdate, cancelLocalUpdate, readLocalMainTarget } from './local-update-control.mjs';
import { consumeNewestPreview, enqueuePreviewEvent } from '../preview-oid-consumer.mjs';

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function fixture(t) {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'local-update-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.invalid');
    git(root, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(root, 'a'), 'a');
    git(root, 'add', 'a'); git(root, 'commit', '-qm', 'initial');
    const oid = git(root, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, '.env'), 'NASSAJ_UPDATE_MODE=local-main\n');
    return { root, oid, input: { mode: 'local-main', expectedOid: oid, ownerId: '1', idempotencyKey: 'request-1', now: 1000 } };
}
function operations(value, calls) {
    const build = domain => async () => {
        calls.push(domain);
        const buildId = (domain === 'client' ? 'a' : 'b').repeat(64);
        const dir = path.join(value.root, '.nassaj-local-preview', `${domain}-candidates`, buildId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: domain, commit: value.oid,
            baseCommit: value.oid, dirty: false, buildId }));
        fs.writeFileSync(path.join(dir, 'asset'), 'immutable');
        if (domain === 'server') fs.writeFileSync(path.join(dir, 'OID_CONTROL_MANIFEST.json'), '{}');
        return { buildId };
    };
    return { materialize: async () => value.root, buildClient: build('client'), buildServer: build('server'),
        promoteClient: () => assert.fail('promotion forbidden'), requestServerControlPlane: () => assert.fail('activation forbidden') };
}
const options = { mode: 'local-main', domains: ['client', 'server'] };

test('ordinary commits do not build; explicit preparation builds a pair once and persists consent', async t => {
    const v = fixture(t), calls = [], ops = operations(v, calls);
    enqueuePreviewEvent(v.root, { sequence: 1, oid: v.oid, domains: ['client', 'server'] });
    assert.equal((await consumeNewestPreview(v.root, ops, options)).status, 'idle');
    const initial = await prepareLocalUpdate(v.root, v.input);
    assert.equal(initial.sequence, 2);
    assert.deepEqual(await prepareLocalUpdate(v.root, v.input), initial);
    await consumeNewestPreview(v.root, ops, options);
    await consumeNewestPreview(v.root, ops, options);
    assert.deepEqual(calls, ['client', 'server']);
    const prepared = readLocalUpdate(v.root);
    assert.equal(prepared.phase, 'prepared');
    const input = { mode: 'local-main', sequence: prepared.sequence, expectedRevision: prepared.revision,
        targetDigest: prepared.targetDigest, ownerId: '1', now: 2000 };
    const confirmed = await confirmLocalUpdate(v.root, input);
    assert.equal(confirmed.consent.expiresAt, 86402000);
    assert.deepEqual(await confirmLocalUpdate(v.root, input), confirmed);
    assert.equal(confirmed.activation, null);
    assert.equal(fs.existsSync(path.join(v.root, '.git/nassaj-preview-oid-control-request-v1.json')), false);
    assert.equal(readLocalMainTarget(v.root).oid, v.oid);
    await assert.rejects(confirmLocalUpdate(v.root, { ...input, expectedRevision: 99 }), /revision_conflict/);
    await assert.rejects(prepareLocalUpdate(v.root, { ...v.input, ownerId: '2' }), /idempotency_conflict/);
});

test('cancel is fenced and prevents builds; legacy cannot consume a requested pair', async t => {
    const v = fixture(t), calls = [], ops = operations(v, calls);
    const state = await prepareLocalUpdate(v.root, v.input);
    await assert.rejects(consumeNewestPreview(v.root, ops, { mode: 'legacy', domains: ['client', 'server'] }), /mode_override/);
    assert.deepEqual(calls, []);
    await assert.rejects(cancelLocalUpdate(v.root, { mode: 'local-main', sequence: state.sequence, ownerId: '1', expectedRevision: 9 }), /revision_conflict/);
    await cancelLocalUpdate(v.root, { mode: 'local-main', sequence: state.sequence, ownerId: '1', expectedRevision: state.revision });
    await consumeNewestPreview(v.root, ops, options);
    assert.deepEqual(calls, []);
});

test('partial preparation reuses the completed client and changed bytes invalidate consent', async t => {
    const v = fixture(t), calls = [], ops = operations(v, calls);
    await prepareLocalUpdate(v.root, v.input);
    await assert.rejects(consumeNewestPreview(v.root, { ...ops, buildServer: () => { throw new Error('interrupted'); } }, options), /interrupted/);
    await consumeNewestPreview(v.root, ops, options);
    assert.deepEqual(calls, ['client', 'server']);
    const state = readLocalUpdate(v.root);
    fs.writeFileSync(path.join(v.root, '.nassaj-local-preview/client-candidates', 'a'.repeat(64), 'asset'), 'tampered');
    await assert.rejects(confirmLocalUpdate(v.root, { mode: 'local-main', sequence: state.sequence, expectedRevision: state.revision,
        targetDigest: state.targetDigest, ownerId: '1' }), /candidate_changed/);
    assert.equal(readLocalUpdate(v.root).consent, null);
});

test('main movement, invalid mode and symlink control fail closed', async t => {
    const v = fixture(t);
    await assert.rejects(prepareLocalUpdate(v.root, { ...v.input, mode: 'release' }), /mode_required/);
    await assert.rejects(prepareLocalUpdate(v.root, { ...v.input, expectedOid: 'f'.repeat(40) }), /target_changed/);
    const state = await prepareLocalUpdate(v.root, v.input);
    const file = path.join(v.root, '.git', `nassaj-preview-oid-event-control-${String(state.sequence).padStart(16, '0')}.json`);
    const moved = `${file}.saved`; fs.renameSync(file, moved); fs.symlinkSync(moved, file);
    assert.throws(() => readLocalUpdate(v.root), /ELOOP/);
});

test('expired consent needs current revision and issues a fresh bounded consent', async t => {
    const v = fixture(t);
    await prepareLocalUpdate(v.root, v.input);
    await consumeNewestPreview(v.root, operations(v, []), options);
    const state = readLocalUpdate(v.root);
    const input = { mode: 'local-main', sequence: state.sequence, expectedRevision: state.revision,
        targetDigest: state.targetDigest, ownerId: '1', now: 2000 };
    const first = await confirmLocalUpdate(v.root, input);
    await assert.rejects(confirmLocalUpdate(v.root, { ...input, now: first.consent.expiresAt }), /revision_conflict/);
    const next = await confirmLocalUpdate(v.root, { ...input, expectedRevision: first.revision, now: first.consent.expiresAt });
    assert.equal(next.consent.expiresAt, first.consent.expiresAt + 86400000);
    assert.equal(next.revision, first.revision + 1);
});

test('main movement retires a request without building and permits a new explicit target', async t => {
    const v = fixture(t), calls = [];
    await prepareLocalUpdate(v.root, v.input);
    fs.writeFileSync(path.join(v.root, 'a'), 'b'); git(v.root, 'commit', '-qam', 'next');
    await consumeNewestPreview(v.root, operations(v, calls), options);
    assert.deepEqual(calls, []);
    assert.equal(readLocalUpdate(v.root).phase, 'superseded');
    const next = await prepareLocalUpdate(v.root, { ...v.input, expectedOid: git(v.root, 'rev-parse', 'HEAD'), idempotencyKey: 'next' });
    assert.equal(next.sequence, 2);
});

test('candidate directory and file symlinks cannot satisfy candidate identities', async t => {
    const v = fixture(t), ops = operations(v, []);
    await prepareLocalUpdate(v.root, v.input);
    await consumeNewestPreview(v.root, ops, options);
    const state = readLocalUpdate(v.root);
    const dir = path.join(v.root, '.nassaj-local-preview/client-candidates', 'a'.repeat(64));
    const asset = path.join(dir, 'asset');
    fs.renameSync(asset, `${asset}.saved`); fs.symlinkSync(`${asset}.saved`, asset);
    const input = { mode: 'local-main', sequence: state.sequence, expectedRevision: state.revision,
        targetDigest: state.targetDigest, ownerId: '1' };
    await assert.rejects(confirmLocalUpdate(v.root, input), /ELOOP/);
    fs.unlinkSync(asset); fs.renameSync(`${asset}.saved`, asset);
    fs.renameSync(dir, `${dir}.saved`); fs.symlinkSync(`${dir}.saved`, dir);
    await assert.rejects(confirmLocalUpdate(v.root, input), /ENOTDIR|ELOOP/);
});

test('persistent build failure is bounded and a new owner request is possible', async t => {
    const v = fixture(t), calls = [];
    await prepareLocalUpdate(v.root, v.input);
    const ops = { ...operations(v, calls), buildClient: async () => { calls.push('failed'); throw new Error('build failure'); } };
    for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(consumeNewestPreview(v.root, ops, options), /build failure/);
    assert.equal(readLocalUpdate(v.root).phase, 'failed');
    await consumeNewestPreview(v.root, ops, options);
    assert.equal(calls.length, 3);
    assert.equal((await prepareLocalUpdate(v.root, { ...v.input, idempotencyKey: 'retry' })).phase, 'preparing');
});

test('matching disk artifacts cannot conceal a stale or unknown loaded process', t => {
    const v = fixture(t);
    for (const [directory, artifact, buildId] of [['dist', 'client', 'a'.repeat(64)], ['dist-server', 'server', 'b'.repeat(64)]]) {
        fs.mkdirSync(path.join(v.root, directory));
        fs.writeFileSync(path.join(v.root, directory, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact, commit: v.oid, buildId }));
    }
    assert.equal(readLocalMainTarget(v.root).available, true);
    assert.equal(readLocalMainTarget(v.root, { serverLoadedOid: 'f'.repeat(40) }).available, true);
    assert.equal(readLocalMainTarget(v.root, { serverLoadedOid: v.oid, serverLoadedBuildId: 'b'.repeat(64), clientBuildIdServed: 'a'.repeat(64) }).available, false);
});
