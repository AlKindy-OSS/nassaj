/**
 * Full node path (ADR-174 §7.4, §5.2 b): strict schema, verifier version,
 * artifact binding and the decision, in order, plus the standalone CLI
 * contract. The attestation step is exercised for real up to the point a
 * synthetic manifest can reach (attestation_invalid on a non-bundle); the
 * decision half uses the `verify` seam with a fake attested subject set.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REF_PATTERN, TRUST_POLICY_SCHEMA } from './attestation-verifier.mjs';
import { canonicalJson } from './strict-shape.mjs';
import { serializeReleaseManifest } from './release-manifest.mjs';
import { digest, manifestFixture } from './release-manifest.test.fixture.mjs';
import { installedTrustState } from './release-sequence.mjs';
import {
    VERIFIER_VERSION, manifestAssets, readReleaseManifest, rejectionCode, verifyAndDecide, verifyManifestArtifacts,
} from './release-verification.mjs';
import { parseVerifierArguments, runVerifierCli } from './standalone-verifier.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const ROOT = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'attestation', 'trusted_root.json')));
const POLICY = Object.freeze({ schema: TRUST_POLICY_SCHEMA, issuer: 'https://token.actions.githubusercontent.com',
    repository: 'Example-OSS/nassaj', repositoryId: '123456789', ownerId: '42',
    workflowPath: '.github/workflows/release-generation.yml', refPattern: REF_PATTERN,
    runnerEnvironment: 'github-hosted', channel: 'stable' });

const bytesOf = (overrides = {}) => serializeReleaseManifest(manifestFixture(overrides));
/** Canonical bytes of a manifest the v1 schema cannot validate (a future schema). */
const futureBytes = (schema = 'nassaj-release-manifest/v2') =>
    Buffer.from(`${canonicalJson({ ...manifestFixture(), schema, newField: 1 })}\n`);

/** Fake attestation step: parses with the caller's reader, attests `subjects`. */
const fakeVerify = subjects => ({ manifestBytes, readIdentity }) => ({
    release: readIdentity(manifestBytes), integratedTime: '2026-09-28T00:00:00.000Z', logIndex: '1',
    subjects: new Map([sha256(manifestBytes), ...subjects].map(value => [value, 'n'])),
});
const decideWith = (input, subjects = []) => verifyAndDecide({ bundleBytes: Buffer.from('{}'), trustedRoot: ROOT,
    policy: POLICY, ...input }, { verify: fakeVerify(subjects) });
const code = expected => error => rejectionCode(error) === expected;

test('readReleaseManifest: strict schema plus the verifier-version gate', () => {
    const read = readReleaseManifest(bytesOf());
    assert.deepEqual([read.version, read.sourceCommit], ['2.4.0.1', 'a'.repeat(40)]);
    assert.equal(read.manifest.minVerifierVersion, 1);
    assert.equal(VERIFIER_VERSION, 1);
    assert.throws(() => readReleaseManifest(bytesOf({ minVerifierVersion: 2 })), code('verifier_too_old'));
    assert.equal(readReleaseManifest(bytesOf({ minVerifierVersion: 2 }), { verifierVersion: 2 }).version, '2.4.0.1');
    assert.throws(() => readReleaseManifest(futureBytes()), code('verifier_too_old'));
    assert.throws(() => readReleaseManifest(Buffer.from('{"version":"2.4.0.1"}')), code('manifest_invalid'));
    assert.throws(() => readReleaseManifest(Buffer.from(`${bytesOf().toString().trim()} \n`)), code('manifest_invalid'));
});

test('verifyAndDecide order: policy and caps first, then schema/version, then crypto', () => {
    const run = over => verifyAndDecide({ bundleBytes: Buffer.from('{}'), manifestBytes: bytesOf(), trustedRoot: ROOT,
        policy: POLICY, ...over });
    assert.throws(() => run({ policy: undefined, manifestBytes: futureBytes() }), code('trust_policy_missing'));
    assert.throws(() => run({ manifestBytes: Buffer.alloc(256 * 1024 + 1, 0x20) }), code('metadata_oversize'));
    assert.throws(() => run({ manifestBytes: futureBytes() }), code('verifier_too_old'));
    assert.throws(() => run({ manifestBytes: bytesOf({ minVerifierVersion: 7 }) }), code('verifier_too_old'));
    assert.throws(() => run({ manifestBytes: bytesOf({ extra: 1 }) }), code('manifest_invalid'));
    assert.throws(() => run({}), code('attestation_invalid'), 'a valid v1 manifest reaches the real bundle check');
});

test('verifyAndDecide: accepted candidate with every asset bound to manifest and subject', () => {
    const manifestBytes = bytesOf();
    const assets = [...manifestAssets(manifestFixture())].map(([name, sha]) => ({ name, actualSha256: sha }));
    const result = decideWith({ manifestBytes, artifacts: assets, completeArtifacts: true }, [digest('d'), digest('f')]);
    assert.equal(result.decision.verdict, 'accept');
    assert.equal(result.artifacts, 2);
    assert.equal(result.manifest.version, '2.4.0.1');
    const lazy = decideWith({ manifestBytes, artifacts: manifest => [{ name: manifest.installer.name,
        actualSha256: manifest.installer.sha256 }] }, [digest('f')]);
    assert.equal(lazy.artifacts, 1);
    assert.equal(decideWith({ manifestBytes }).artifacts, 0, 'no assets at hand: rule 4 half two is deferred');
});

test('verifyAndDecide: artifact and decision refusals keep their codes', () => {
    const manifestBytes = bytesOf();
    const installer = { name: 'nassaj-install.mjs', actualSha256: digest('f') };
    assert.throws(() => decideWith({ manifestBytes, artifacts: [installer] }), code('artifact_digest_mismatch'));
    assert.throws(() => decideWith({ manifestBytes, artifacts: [installer], completeArtifacts: true }, [digest('f')]),
        /missing nassaj-2\.4\.0\.1-linux-x64-glibc\.tar\.zst/);
    assert.throws(() => decideWith({ manifestBytes, artifacts: [{ name: 'other.bin', actualSha256: digest('f') }] },
        [digest('f')]), code('artifact_digest_mismatch'));
    assert.throws(() => decideWith({ manifestBytes, artifacts: {} }), code('artifact_digest_mismatch'));
    const canary = decideWith({ manifestBytes: bytesOf({ channel: 'canary' }) });
    assert.deepEqual([canary.decision.verdict, canary.decision.code], ['reject', 'channel_mismatch']);
    const newer = installedTrustState({ installedVersion: '2.4.0.2', installedSequence: 11 });
    assert.equal(decideWith({ manifestBytes, trustState: newer }).decision.code, 'release_rollback_refused');
    const same = installedTrustState({ installedVersion: '2.4.0.1', installedSequence: 10 });
    assert.equal(decideWith({ manifestBytes, trustState: same }).decision.verdict, 'noop');
    assert.equal(decideWith({ manifestBytes: bytesOf({ minShimVersion: 3 }), shimVersion: 2 }).decision.code,
        'shim_update_required');
    assert.equal(decideWith({ manifestBytes: bytesOf({ minShimVersion: 3 }) }).decision.verdict, 'accept',
        'shim not evaluated when no installed shim is given');
});

test('verifyManifestArtifacts and rejectionCode', () => {
    const manifest = manifestFixture();
    const verified = { subjects: new Map([[digest('f'), 'i']]) };
    assert.equal(verifyManifestArtifacts(verified, manifest, [{ name: 'nassaj-install.mjs', actualSha256: digest('f') }]), 1);
    assert.throws(() => verifyManifestArtifacts(verified, manifest, [{ name: 'nassaj-install.mjs', actualSha256: digest('e') }]),
        code('artifact_digest_mismatch'));
    assert.equal(rejectionCode(new Error('raw library text')), 'attestation_invalid');
    assert.equal(rejectionCode({ code: 'ENOENT' }), 'attestation_invalid');
    assert.equal(rejectionCode(null), 'attestation_invalid');
});

// ------------------------------------------------------------------ CLI

function cliFiles(t, manifestBytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-verifier-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const put = (name, body) => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };
    return { dir, put, files: [put('bundle.json', '{}'), put('root.json', JSON.stringify(ROOT)),
        put('policy.json', JSON.stringify(POLICY)), put('manifest.json', manifestBytes)] };
}

function capture() {
    const out = { stdout: '', stderr: '' };
    return { out, io: { stdout: { write: text => { out.stdout += text; } }, stderr: { write: text => { out.stderr += text; } } } };
}

test('CLI arguments: four files, optional artifacts and installed state', () => {
    assert.deepEqual(parseVerifierArguments(['a', 'b', 'c', 'd']), { files: ['a', 'b', 'c', 'd'] });
    assert.deepEqual(parseVerifierArguments(['a', 'b', 'c', 'd', '--artifacts', 'x', '--installed', '2.4.0.1@10',
        '--shim-version', '2']), { files: ['a', 'b', 'c', 'd'], artifacts: 'x',
        installed: { version: '2.4.0.1', sequence: 10 }, shimVersion: 2 });
    const bad = [[], ['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c', 'd', '--nope', 'x'],
        ['a', 'b', 'c', 'd', '--installed', '2.4.0.1@10'], ['a', 'b', 'c', 'd', '--installed', '2.4@1', '--shim-version', '1'],
        ['a', 'b', 'c', 'd', '--shim-version', '0'], ['a', 'b', 'c', 'd', '--artifacts'],
        ['a', 'b', 'c', 'd', '--artifacts', 'x', '--artifacts', 'y']];
    for (const argv of bad) assert.throws(() => parseVerifierArguments(argv), Error, JSON.stringify(argv));
});

test('CLI: usage, unreadable inputs and schema refusals', t => {
    const usage = capture();
    assert.equal(runVerifierCli(['x'], usage.io), 64);
    assert.match(usage.out.stderr, /^four input files are required\nusage:/);
    const { files, dir } = cliFiles(t, futureBytes());
    const future = capture();
    assert.equal(runVerifierCli(files, future.io), 2);
    assert.match(future.out.stdout, /^REJECTED verifier_too_old: manifest schema is newer than this verifier\n$/);
    const missing = capture();
    assert.equal(runVerifierCli([files[0], files[1], path.join(dir, 'none'), files[3]], missing.io), 2);
    assert.match(missing.out.stdout, /^REJECTED trust_policy_missing: cannot read none: ENOENT/);
    const real = capture();
    fs.writeFileSync(files[3], bytesOf());
    assert.equal(runVerifierCli(files, real.io), 2);
    assert.match(real.out.stdout, /^REJECTED attestation_invalid: /);
});

test('CLI: accept, noop and decision refusal with artifacts read from a directory', t => {
    const archive = Buffer.from('archive');
    const installer = Buffer.from('installer');
    const base = manifestFixture();
    const manifestBytes = bytesOf({ targets: [{ ...base.targets[0], archive: { ...base.targets[0].archive, sha256: sha256(archive) } }],
        installer: { ...base.installer, sha256: sha256(installer) } });
    const { files, put, dir } = cliFiles(t, manifestBytes);
    put(base.targets[0].archive.name, archive);
    put('nassaj-install.mjs', installer);
    const deps = { verify: fakeVerify([sha256(archive), sha256(installer)]) };
    const accept = capture();
    assert.equal(runVerifierCli([...files, '--artifacts', dir, '--installed', '2.4.0.0@9', '--shim-version', '1'],
        accept.io, deps), 0, accept.out.stdout);
    const line = JSON.parse(accept.out.stdout);
    assert.deepEqual([line.ok, line.version, line.artifacts, line.verifierVersion], [true, '2.4.0.1', 2, 1]);
    const noop = capture();
    assert.equal(runVerifierCli([...files, '--installed', '2.4.0.1@10', '--shim-version', '1'], noop.io, deps), 3);
    assert.match(noop.out.stdout, /^NOOP 2\.4\.0\.1/);
    const rollback = capture();
    assert.equal(runVerifierCli([...files, '--installed', '2.4.0.5@20', '--shim-version', '1'], rollback.io, deps), 2);
    assert.match(rollback.out.stdout, /^REJECTED release_rollback_refused:/);
    fs.writeFileSync(path.join(dir, 'nassaj-install.mjs'), 'tampered');
    const tampered = capture();
    assert.equal(runVerifierCli([...files, '--artifacts', dir], tampered.io, deps), 2);
    assert.match(tampered.out.stdout, /^REJECTED artifact_digest_mismatch: nassaj-install\.mjs/);
    fs.rmSync(path.join(dir, 'nassaj-install.mjs'));
    const absent = capture();
    assert.equal(runVerifierCli([...files, '--artifacts', dir], absent.io, deps), 2);
    assert.match(absent.out.stdout, /^REJECTED artifact_digest_mismatch:/);
});
