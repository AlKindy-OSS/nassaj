import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { ReleaseManifestError } from './release-manifest-codes.mjs';
import {
    TRUST_STATE_MAX_BYTES, advanceTrustState, assertTrustState, decideReleaseCandidate, installedTrustState,
    readTrustState, seedTrustState, writeTrustState,
} from './release-sequence.mjs';
import { canonicalJson } from './strict-shape.mjs';
import { manifestFixture } from './release-manifest.test.fixture.mjs';

const code = expected => error => error instanceof ReleaseManifestError && error.code === expected;
const AT = '2026-09-28T10:00:00.000Z';
const release = (version, releaseSequence, extra = {}) => {
    const base = manifestFixture({ version, releaseSequence, minUpgradeFrom: '2.0.0.0', revokedVersions: [], ...extra });
    base.database = { migrationClass: 'none', readableBy: [] };
    return base;
};
const installedAt = (version, sequence, floor = 5) =>
    advanceTrustState(seedTrustState({ minReleaseSequence: floor }), release(version, sequence), { attestedAt: AT });
const decide = (trustState, manifest, extra = {}) =>
    decideReleaseCandidate({ trustState, channel: 'stable', manifest, verifierVersion: 1, shimVersion: 1, ...extra });
const scratch = () => fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP ?? os.tmpdir(), 'trust-state-'));
const reseal = (state, edit) => {
    const body = { ...structuredClone(state), ...edit };
    delete body.integrity;
    return body;
};

test('seed state carries the installer floor and nothing installed (F4)', () => {
    const state = seedTrustState({ minReleaseSequence: 7 });
    assert.equal(state.installedVersion, null);
    assert.equal(state.installedSequence, 0);
    assert.equal(state.minReleaseSequence, 7);
    assert.ok(Object.isFrozen(state));
});

test('trust state validation fails closed', () => {
    const state = installedAt('2.4.0.1', 10);
    assert.throws(() => assertTrustState({ ...state, integrity: '0'.repeat(64) }), code('trust_state_invalid'));
    assert.throws(() => assertTrustState({ ...state, extra: 1 }), code('trust_state_invalid'));
    assert.throws(() => assertTrustState({ ...state, installedSequence: 0 }), code('trust_state_invalid'));
    assert.throws(() => assertTrustState({ ...state, installedSequence: 3 }), code('trust_state_invalid'));
    assert.throws(() => assertTrustState({ ...state, lastVerifiedAt: '2026-13-45T99:00:00.000Z' }),
        code('trust_state_invalid'));
    assert.throws(() => assertTrustState(reseal(state, {})), code('trust_state_invalid'));
    assert.throws(() => seedTrustState({ minReleaseSequence: 0 }), code('trust_state_invalid'));
});

test('fresh install: floor enforced, anything at or above it accepted', () => {
    const seed = seedTrustState({ minReleaseSequence: 10 });
    assert.deepEqual(decide(seed, release('2.4.0.1', 10)), { verdict: 'accept', code: null, warnings: [] });
    assert.equal(decide(seed, release('2.4.0.0', 9)).code, 'release_rollback_refused');
    assert.equal(decide(seed, release('2.4.0.1', 10, { minUpgradeFrom: '2.4.0.1' })).verdict, 'accept');
});

test('lower sequence with a valid attestation is a rollback (rule 6)', () => {
    const state = installedAt('2.4.0.5', 20);
    assert.equal(decide(state, release('2.4.0.9', 19)).code, 'release_rollback_refused');
    assert.equal(decide(state, release('2.4.0.4', 6)).code, 'release_rollback_refused');
});

test('equal sequence: same version is a no-op, a different version is refused', () => {
    const state = installedAt('2.4.0.5', 20);
    assert.deepEqual(decide(state, release('2.4.0.5', 20)), { verdict: 'noop', code: null, warnings: [] });
    assert.equal(decide(state, release('2.4.0.6', 20)).code, 'release_rollback_refused');
});

test('higher sequence but version not newer is refused', () => {
    const state = installedAt('2.4.0.5', 20);
    assert.equal(decide(state, release('2.4.0.5', 21)).code, 'release_version_not_newer');
    assert.equal(decide(state, release('2.4.0.4', 21)).code, 'release_version_not_newer');
});

test('channel mismatch is refused before freshness (rule 5)', () => {
    const state = installedAt('2.4.0.5', 20);
    const result = decide(state, release('2.4.0.6', 21, { channel: 'canary' }));
    assert.deepEqual(result, { verdict: 'reject', code: 'channel_mismatch', warnings: [] });
    assert.equal(decide(state, release('2.4.0.6', 21, { channel: 'canary' }), { channel: 'canary' }).verdict, 'accept');
});

test('upgrade path, verifier and shim floors (rules 7, 8)', () => {
    const state = installedAt('2.4.0.5', 20);
    const path7 = decide(state, release('2.4.0.9', 30, { minUpgradeFrom: '2.4.0.7' }));
    assert.deepEqual(path7, { verdict: 'reject', code: 'upgrade_path_required', warnings: [], requiredVersion: '2.4.0.7' });
    assert.equal(decide(state, release('2.4.0.9', 30, { minUpgradeFrom: '2.4.0.5' })).verdict, 'accept');
    assert.equal(decide(state, release('2.4.0.9', 30, { minVerifierVersion: 2 })).code, 'verifier_too_old');
    assert.equal(decide(state, release('2.4.0.9', 30, { minShimVersion: 2 })).code, 'shim_update_required');
    assert.equal(decide(state, release('2.4.0.9', 30, { minShimVersion: 2 }), { shimVersion: 2 }).verdict, 'accept');
});

test('a newer manifest revoking the installed version warns (rule 9)', () => {
    const state = installedAt('2.4.0.5', 20);
    const revoking = release('2.4.0.9', 30, { revokedVersions: ['2.4.0.5'] });
    assert.deepEqual(decide(state, revoking).warnings, ['current_release_revoked']);
    const blocked = decide(state, release('2.4.0.9', 30, { revokedVersions: ['2.4.0.5'], minShimVersion: 9 }));
    assert.deepEqual(blocked.warnings, ['current_release_revoked']);
    const older = release('2.4.0.4', 19, { revokedVersions: ['2.4.0.3'] });
    assert.deepEqual(decide(state, older).warnings, []);
});

test('decide refuses malformed inputs', () => {
    const state = installedAt('2.4.0.5', 20);
    const good = release('2.4.0.9', 30);
    assert.throws(() => decide(state, good, { channel: 'beta' }), TypeError);
    assert.throws(() => decide(state, good, { verifierVersion: 0 }), TypeError);
    assert.throws(() => decide(state, good, { shimVersion: '1' }), TypeError);
    assert.throws(() => decide(state, { ...good, extra: 1 }), code('manifest_invalid'));
    assert.throws(() => decide({ ...state, installedSequence: 99 }, good), code('trust_state_invalid'));
});

test('advance records the new release and refuses anything not strictly newer', () => {
    const state = installedAt('2.4.0.5', 20);
    const next = advanceTrustState(state, release('2.4.0.6', 21), { attestedAt: AT });
    assert.equal(next.installedVersion, '2.4.0.6');
    assert.equal(next.installedSequence, 21);
    assert.equal(next.minReleaseSequence, 5);
    assert.equal(advanceTrustState(state, release('2.4.0.5', 20), { attestedAt: AT }), state, 're-apply is a no-op');
    assert.throws(() => advanceTrustState(state, release('2.4.0.6', 20), { attestedAt: AT }), code('release_rollback_refused'));
    assert.throws(() => advanceTrustState(state, release('2.4.0.5', 19), { attestedAt: AT }), code('release_rollback_refused'));
    assert.throws(() => advanceTrustState(state, release('2.4.0.4', 21), { attestedAt: AT }), code('release_version_not_newer'));
    assert.throws(() => advanceTrustState(state, release('2.4.0.6', 21), { attestedAt: 'yesterday' }),
        code('trust_state_invalid'));
});

test('installedTrustState seals a node on a given release; floor defaults to its sequence', () => {
    const state = installedTrustState({ installedVersion: '2.4.0.5', installedSequence: 20 });
    assert.equal(state.minReleaseSequence, 20);
    assert.deepEqual(state, assertTrustState(structuredClone(state)));
    assert.equal(decide(state, release('2.4.0.6', 21)).verdict, 'accept');
    assert.equal(decide(state, release('2.4.0.5', 20)).verdict, 'noop');
    assert.throws(() => installedTrustState({ installedVersion: '2.4.0.5', installedSequence: 20, minReleaseSequence: 30 }),
        code('trust_state_invalid'));
});

test('persistence: seed, advance, idempotent retry, owner-only mode, no temp left', () => {
    const dir = scratch();
    const file = path.join(dir, 'trust-state.json');
    const seed = seedTrustState({ minReleaseSequence: 5 });
    writeTrustState(file, seed);
    assert.deepEqual(readTrustState(file), seed);
    const next = advanceTrustState(seed, release('2.4.0.1', 10), { attestedAt: AT });
    writeTrustState(file, next);
    writeTrustState(file, next);
    assert.deepEqual(readTrustState(file), next);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['trust-state.json']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('persistence refuses regressions against the state on disk', () => {
    const dir = scratch();
    const file = path.join(dir, 'trust-state.json');
    writeTrustState(file, installedAt('2.4.0.5', 20));
    assert.throws(() => writeTrustState(file, installedAt('2.4.0.4', 19)), code('release_rollback_refused'));
    assert.throws(() => writeTrustState(file, seedTrustState({ minReleaseSequence: 5 })), code('release_rollback_refused'));
    assert.throws(() => writeTrustState(file, installedAt('2.4.0.6', 21, 4)), code('release_rollback_refused'));
    assert.throws(() => writeTrustState(file, installedAt('2.4.0.1', 21)), code('release_version_not_newer'));
    assert.equal(readTrustState(file).installedSequence, 20);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('corrupt, missing or unsafe trust state fails closed', () => {
    const dir = scratch();
    const file = path.join(dir, 'trust-state.json');
    assert.throws(() => readTrustState(file), code('trust_state_missing'));
    const state = installedAt('2.4.0.5', 20);
    const cases = [
        '{"schema":',
        `${JSON.stringify(state, null, 2)}\n`,
        canonicalJson(state),
        `${canonicalJson({ ...state, installedSequence: 21 })}\n`,
        ' '.repeat(TRUST_STATE_MAX_BYTES + 1),
    ];
    for (const text of cases) {
        fs.writeFileSync(file, text);
        assert.throws(() => readTrustState(file), code('trust_state_invalid'));
        assert.throws(() => writeTrustState(file, installedAt('2.4.0.6', 21)), code('trust_state_invalid'));
    }
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
    assert.throws(() => readTrustState(file), code('trust_state_invalid'));
    fs.rmSync(file);
    fs.writeFileSync(path.join(dir, 'real.json'), `${canonicalJson(state)}\n`);
    fs.symlinkSync(path.join(dir, 'real.json'), file);
    assert.throws(() => readTrustState(file), code('trust_state_invalid'));
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.throws(() => readTrustState(file), code('trust_state_invalid'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('unexpected read errors propagate unchanged', () => {
    const failure = Object.assign(new Error('io'), { code: 'EIO' });
    const opened = mock.method(fs, 'openSync', () => { throw failure; });
    try {
        assert.throws(() => readTrustState('/nonexistent/trust-state.json'), error => error === failure);
    } finally {
        opened.mock.restore();
    }
});

test('a failed rename removes the temporary file and keeps the old state', () => {
    const dir = scratch();
    const file = path.join(dir, 'trust-state.json');
    const seed = seedTrustState({ minReleaseSequence: 5 });
    writeTrustState(file, seed);
    const renamed = mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('rename'), { code: 'EXDEV' }); });
    try {
        assert.throws(() => writeTrustState(file, installedAt('2.4.0.1', 10)), /rename/);
    } finally {
        renamed.mock.restore();
    }
    assert.deepEqual(fs.readdirSync(dir), ['trust-state.json']);
    assert.deepEqual(readTrustState(file), seed);
    fs.rmSync(dir, { recursive: true, force: true });
});
