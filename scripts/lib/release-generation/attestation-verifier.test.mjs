/**
 * Rejection suite for the release attestation verifier (ADR-174 §16 P1
 * acceptance 6–7). Fixtures are real public bundles from S1
 * (alkindy/decisions/ADR-174-evidence/s1/fixtures), mutated per case;
 * synthetic values only where a real bundle cannot carry them without
 * re-signing (self-hosted runner, trigger, visibility, issuer, SCT-less cert).
 * The whole file runs with an in-process network guard; one case also runs
 * the CLI under `unshare -rn` with the preload guard.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundleFromJSON } from '@sigstore/bundle';
import { X509Certificate } from '@sigstore/core';
import {
    ATTESTATION_CODES as C, ATTESTATION_LIMITS, AttestationError, REF_PATTERN, TIME_SOURCES, TRUST_POLICY_SCHEMA,
    checkIdentity, checkRootCoversCert, checkRuntime, checkStatement, checkTimeSource, expectedIdentity, extString,
    loadTrustedRoot, parseBundle, readManifestIdentity, requireManifestSubject, selectUserProvenance, sha256Hex,
    validateTrustPolicy, verifyArtifactDigests, verifyAttestationBundle, verifyRelease,
} from './attestation-verifier.mjs';
import { serializeReleaseManifest } from './release-manifest.mjs';
import { manifestFixture } from './release-manifest.test.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'attestation');
const GUARD = path.join(FIX, 'net-guard.cjs');
const VERIFIER = path.join(HERE, 'standalone-verifier.mjs');
createRequire(import.meta.url)(GUARD);

const raw = (name) => readFileSync(path.join(FIX, name));
const json = (name) => JSON.parse(raw(name).toString('utf8'));
const ROOT = json('trusted_root.json');
const GOR = raw('gor.json');
const GOR_COMMIT = '25a52e520f9c993711b93ea1111ed90c024e0528';
const GOR_RELEASE = Object.freeze({ version: '2.18.2', sourceCommit: GOR_COMMIT });
/** A real subject digest of the goreleaser bundle (Linux x86_64 SBOM asset). */
const GOR_SUBJECT = '54db8f225a2e3cdc7c7d303f8666b0c26b11be2089baed149a19f61f9c45bfcd';
const policyFor = (repository, repositoryId, ownerId, extra = {}) => ({
    schema: TRUST_POLICY_SCHEMA, issuer: 'https://token.actions.githubusercontent.com', repository, repositoryId,
    ownerId, workflowPath: '.github/workflows/release.yml', refPattern: REF_PATTERN,
    runnerEnvironment: 'github-hosted', channel: 'stable', ...extra,
});
const GOR_POLICY = Object.freeze(policyFor('goreleaser/goreleaser', 77071454, 24697112));
const MISE_POLICY = Object.freeze(policyFor('jdx/mise', '586920414', '216188'));
const MISE_RELEASE = Object.freeze({ version: '2026.9.15', sourceCommit: 'c7c8b86c1b338d5568e077f12bd3fd15e75b94fc' });

const flip = (s) => { const x = Buffer.from(s, 'base64'); x[10] ^= 1; return x.toString('base64'); };
/** Mutated copy of a real bundle as bytes. */
function mutated(mutate, source = GOR) {
    const b = JSON.parse(source.toString('utf8'));
    const out = mutate(b, b.verificationMaterial.tlogEntries?.[0]) ?? b;
    return Buffer.from(JSON.stringify(out));
}
const rootWith = (mutate) => { const r = structuredClone(ROOT); mutate(r); return r; };
// The real fixture bundles are third-party a.b.c releases: allowForeignVersion is test-only.
const verifyGor = (over = {}) => verifyAttestationBundle({
    bundleBytes: GOR, trustedRoot: ROOT, policy: GOR_POLICY, release: GOR_RELEASE, allowForeignVersion: true, ...over,
});

/** Asserts that `run` throws AttestationError with `code` (and `field` when given). */
function rejects(run, code, field) {
    assert.throws(run, (e) => {
        assert.ok(e instanceof AttestationError, `expected AttestationError, got ${e?.name}: ${e?.message}`);
        assert.equal(e.code, code, e.message);
        if (field) assert.equal(e.field, field, e.message);
        return true;
    });
}

const realCert = () => X509Certificate.parse(bundleFromJSON(JSON.parse(GOR.toString('utf8')))
    .verificationMaterial.content.certificate.rawBytes);
const utf8Der = (s, tag = 0x0c) => Buffer.from([tag, Buffer.byteLength(s), ...Buffer.from(s)]);
/** The real goreleaser certificate with some Fulcio OIDs replaced (synthetic identity cases). */
function certOverriding(oids, san) {
    const cert = realCert();
    const read = [];
    return {
        read,
        subjectAltName: san ?? cert.subjectAltName,
        extension(oid) {
            const n = Number(oid.split('.').pop());
            read.push(n);
            if (!(n in oids)) return cert.extension(oid);
            return oids[n] === null ? undefined : { value: utf8Der(...[].concat(oids[n])) };
        },
    };
}
const gorExpected = (policy = GOR_POLICY, release = GOR_RELEASE) =>
    expectedIdentity(validateTrustPolicy(policy), release);

test('positive: real goreleaser and mise bundles verify offline with full identity pin', () => {
    const gor = verifyGor();
    assert.equal(gor.timeSource, 'rekor-v1-set+proof');
    assert.equal(gor.integratedTime, '2026-09-17T03:42:17.000Z');
    assert.equal(gor.identity.repositoryId, '77071454');
    assert.equal(gor.identity.buildTrigger, 'push');
    assert.equal(gor.subjects.size, 53);
    assert.ok(gor.subjects.has(GOR_SUBJECT));
    const mise = verifyAttestationBundle({ bundleBytes: raw('mise.json'), trustedRoot: ROOT, policy: MISE_POLICY,
        release: MISE_RELEASE, allowForeignVersion: true });
    assert.equal(mise.identity.sourceRef, 'refs/tags/v2026.9.15');
    assert.equal(mise.subjects.size, 36);
});

test('identity: every §7.4 rule 2 field mismatch is refused with its field', async (t) => {
    const cases = [
        ['another workflow, same repo', { policy: { ...GOR_POLICY, workflowPath: '.github/workflows/other.yml' } }, 'library-policy'],
        ['another repo, same path (fork)', { policy: { ...GOR_POLICY, repository: 'attacker/goreleaser' } }, 'library-policy'],
        ['same name, different repository ID', { policy: { ...GOR_POLICY, repositoryId: 1 } }, 'repositoryId'],
        ['different owner ID', { policy: { ...GOR_POLICY, ownerId: '2' } }, 'ownerId'],
        ['another tag', { release: { ...GOR_RELEASE, version: '2.18.3' } }, 'library-policy'],
        ['source commit != manifest.source.commit', { release: { ...GOR_RELEASE, sourceCommit: 'a'.repeat(40) } },
            'sourceCommit'],
    ];
    for (const [name, over, field] of cases) {
        await t.test(name, () => rejects(() => verifyGor(over), C.ATTESTATION_IDENTITY_MISMATCH, field));
    }
});

test('identity: bundles of other real projects are refused under our policy', async (t) => {
    await t.test('mise bundle under the goreleaser policy', () => rejects(() => verifyGor({ bundleBytes: raw('mise.json') }),
        C.ATTESTATION_IDENTITY_MISMATCH, 'library-policy'));
    await t.test('branch ref (uv, refs/heads/main) under a uv policy', () => rejects(() => verifyAttestationBundle({
        bundleBytes: raw('uv.json'), trustedRoot: ROOT, release: { version: '0.9.0', sourceCommit: GOR_COMMIT },
        allowForeignVersion: true,
        policy: policyFor('astral-sh/uv', 699532645, 115962839) }), C.ATTESTATION_IDENTITY_MISMATCH, 'library-policy'));
});

test('identity (synthetic cert values): runner, issuer, trigger, visibility, signer, ref', async (t) => {
    const cases = [
        ['self-hosted runner', { 11: 'self-hosted' }, 'runnerEnvironment'],
        ['issuer mismatch', { 8: 'https://token.actions.githubusercontent.com/' }, 'issuer'],
        ['build trigger workflow_dispatch', { 20: 'workflow_dispatch' }, 'buildTrigger'],
        ['visibility private', { 22: 'private' }, 'visibility'],
        ['reusable workflow signer', { 9: 'https://github.com/x/y/.github/workflows/r.yml@refs/heads/main' },
            'buildSignerUri'],
        ['branch ref in 1.14', { 14: 'refs/heads/main' }, 'sourceRef'],
        ['missing 1.22', { 22: null }, 'visibility'],
        ['build config URI (1.18) from another workflow', { 18: 'https://github.com/x/y/.github/workflows/r.yml@refs/tags/v2.18.2' },
            'buildConfigUri'],
        ['missing 1.18', { 18: null }, 'buildConfigUri'],
    ];
    for (const [name, oids, field] of cases) {
        await t.test(name, () => rejects(() => checkIdentity(certOverriding(oids), gorExpected()),
            C.ATTESTATION_IDENTITY_MISMATCH, field));
    }
});

test('identity: deprecated OIDs 1.1–1.6 are never read, and non-UTF8String values are refused', () => {
    const cert = certOverriding({ 1: ['evil', 0x13], 2: ['x', 0x16] });
    checkIdentity(cert, gorExpected());
    assert.deepEqual(cert.read.filter((n) => n <= 6), []);
    rejects(() => checkIdentity(certOverriding({ 20: ['push', 0x13] }), gorExpected()), C.ATTESTATION_INVALID, '1.20');
    rejects(() => extString({ extension: () => ({ value: Buffer.from([0x0c, 9, 1]) }) }, 20), C.ATTESTATION_INVALID, '1.20');
    assert.equal(extString(certOverriding({ 20: 'push' }), 20), 'push');
});

test('wrapper SAN check refuses a SAN the library policy did not see', () => {
    rejects(() => checkIdentity(certOverriding({}, 'https://github.com/o/r/.github/workflows/release.yml@refs/tags/v2.18.2'),
        gorExpected()), C.ATTESTATION_IDENTITY_MISMATCH, 'san');
});

test('crypto: tampered signature, payload, SET, proof and times are refused', async (t) => {
    const cases = [
        ['tampered DSSE signature', (b) => { b.dsseEnvelope.signatures[0].sig = flip(b.dsseEnvelope.signatures[0].sig); }],
        ['tampered payload (extra subject)', (b) => {
            const st = JSON.parse(Buffer.from(b.dsseEnvelope.payload, 'base64'));
            st.subject.push({ name: 'evil', digest: { sha256: '0'.repeat(64) } });
            b.dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString('base64');
        }],
        ['SET altered', (b, e) => { e.inclusionPromise.signedEntryTimestamp = flip(e.inclusionPromise.signedEntryTimestamp); }],
        ['inclusion proof altered', (b, e) => { e.inclusionProof.hashes[3] = flip(e.inclusionProof.hashes[3]); }],
        ['checkpoint altered', (b, e) => { e.inclusionProof.checkpoint.envelope = e.inclusionProof.checkpoint.envelope.replace(/\n\d+\n/, '\n1\n'); }],
        ['integratedTime shifted +60 s (inside cert validity)', (b, e) => { e.integratedTime = String(Number(e.integratedTime) + 60); }],
        ['integratedTime before cert notBefore', (b, e) => { e.integratedTime = String(Number(e.integratedTime) - 3600); }],
        ['integratedTime after cert notAfter', (b, e) => { e.integratedTime = String(Number(e.integratedTime) + 86400); }],
    ];
    for (const [name, mutate] of cases) {
        await t.test(name, () => rejects(() => verifyGor({ bundleBytes: mutated(mutate) }), C.ATTESTATION_INVALID, 'library'));
    }
});

test('crypto: cert-validity and SET failures come from the matching library check', () => {
    const run = (mutate) => { try { verifyGor({ bundleBytes: mutated(mutate) }); } catch (e) { return e.libraryCode; } return 'accepted'; };
    assert.equal(run((b, e) => { e.integratedTime = String(Number(e.integratedTime) + 86400); }), 'CERTIFICATE_ERROR');
    assert.equal(run((b, e) => { e.integratedTime = String(Number(e.integratedTime) + 60); }), 'TLOG_INCLUSION_PROMISE_ERROR');
});

test('time windows: integratedTime outside pinned Fulcio CA or Rekor key validFor', async (t) => {
    const before = '2020-01-01T00:00:00Z';
    await t.test('Rekor v1 key validFor ends before integratedTime', () => rejects(() => verifyGor({
        trustedRoot: rootWith((r) => { r.tlogs.find((l) => l.baseUrl === 'https://rekor.sigstore.dev').publicKey.validFor.end = before; }),
    }), C.ATTESTATION_INVALID, 'library'));
    await t.test('Fulcio CA validFor ends before integratedTime', () => rejects(() => verifyGor({
        trustedRoot: rootWith((r) => { for (const ca of r.certificateAuthorities) ca.validFor.end = before; }),
    }), C.ATTESTATION_INVALID, 'library'));
});

test('trusted time: registry, SET/proof both required, Rekor v2 and TSA-only refused', async (t) => {
    await t.test('SET removed (proof without SET)', () => rejects(() => verifyGor({
        bundleBytes: mutated((b, e) => { delete e.inclusionPromise; }) }), C.ATTESTATION_NO_TRUSTED_TIME));
    await t.test('proof removed (SET without proof) fails the v0.3 parse guard', () => rejects(() => verifyGor({
        bundleBytes: mutated((b, e) => { delete e.inclusionProof; }) }), C.ATTESTATION_INVALID, 'bundle'));
    await t.test('checkpoint missing from proof', () => rejects(() => checkTimeSource(
        { verificationMaterial: {} }, { inclusionPromise: { signedEntryTimestamp: Buffer.from('x') }, inclusionProof: {} },
        ['rekor-v1-set+proof']), C.ATTESTATION_NO_TRUSTED_TIME));
    await t.test('extra RFC 3161 timestamp is not the v1 format', () => rejects(() => verifyGor({
        bundleBytes: mutated((b) => { b.verificationMaterial.timestampVerificationData = { rfc3161Timestamps: [{ signedTimestamp: 'AAAA' }] }; }),
    }), C.ATTESTATION_NO_TRUSTED_TIME));
    await t.test('policy names only an unimplemented source (rekor-v2+tsa)', () => rejects(() => verifyGor({
        policy: { ...GOR_POLICY, acceptedTimeSources: ['rekor-v2+tsa'] } }), C.ATTESTATION_NO_TRUSTED_TIME));
    await t.test('prototype names are not registry entries', () => rejects(() => verifyGor({
        policy: { ...GOR_POLICY, acceptedTimeSources: ['constructor', 'toString'] } }), C.ATTESTATION_NO_TRUSTED_TIME));
    await t.test('Rekor v2 kind version (dsse/0.0.2)', () => rejects(() => verifyGor({
        bundleBytes: mutated((b, e) => { e.kindVersion.version = '0.0.2'; }) }), C.ATTESTATION_INVALID, 'tlog'));
    await t.test('TSA-only GitHub release attestation (initiator github)', () => rejects(() => verifyGor({
        bundleBytes: raw('gh-release-attestation.json') }), C.ATTESTATION_INVALID, 'tlog'));
    assert.deepEqual(Object.keys(TIME_SOURCES), ['rekor-v1-set+proof']);
});

test('tlog contract: one dsse/0.0.1 entry on the pinned Rekor v1 log', async (t) => {
    const v2 = ROOT.tlogs.find((l) => l.baseUrl !== 'https://rekor.sigstore.dev').logId.keyId;
    await t.test('two tlog entries', () => rejects(() => verifyGor({
        bundleBytes: mutated((b, e) => { b.verificationMaterial.tlogEntries.push({ ...e }); }) }), C.ATTESTATION_INVALID, 'tlog'));
    await t.test('kind intoto', () => rejects(() => verifyGor({
        bundleBytes: mutated((b, e) => { e.kindVersion.kind = 'intoto'; }) }), C.ATTESTATION_INVALID, 'tlog'));
    await t.test('logId of the Rekor v2 log (present, wrong role)', () => rejects(() => verifyGor({
        bundleBytes: mutated((b, e) => { e.logId.keyId = v2; }) }), C.ATTESTATION_INVALID, 'tlog'));
});

test('stale trusted root: each §7.9 condition separately', async (t) => {
    await t.test('(a) tlog logId absent from tlogs', () => rejects(() => verifyGor({
        trustedRoot: rootWith((r) => { r.tlogs = r.tlogs.filter((l) => l.baseUrl !== 'https://rekor.sigstore.dev'); }),
    }), C.ATTESTATION_TRUST_ROOT_STALE, 'tlog-log-id'));
    await t.test('(b) certificate AKI matches no CA', () => rejects(() => verifyGor({
        trustedRoot: rootWith((r) => { r.certificateAuthorities = []; }) }), C.ATTESTATION_TRUST_ROOT_STALE, 'ca-aki'));
    await t.test('(c) no SCT log in ctlogs', () => rejects(() => verifyGor({
        trustedRoot: rootWith((r) => { r.ctlogs = []; }) }), C.ATTESTATION_TRUST_ROOT_STALE, 'ct-log-id'));
    await t.test('certificate without SCT is invalid, not stale', () => {
        const cert = realCert();
        rejects(() => checkRootCoversCert({ extAuthorityKeyID: cert.extAuthorityKeyID, extSCT: undefined }, ROOT),
            C.ATTESTATION_INVALID, 'sct');
    });
    await t.test('trusted root without its lists is missing trust material', () => rejects(() => loadTrustedRoot(
        { tlogs: 'nope' }), C.TRUST_POLICY_MISSING, 'trusted-root'));
    await t.test('trusted root with an unparseable CA certificate', () => rejects(() => verifyGor({
        trustedRoot: rootWith((r) => { r.certificateAuthorities[0].certChain.certificates[0].rawBytes = 'AAAA'; }),
    }), C.TRUST_POLICY_MISSING, 'trusted-root'));
});

test('parse guard: oversize before parse, invalid bundle, wrong content and material', async (t) => {
    await t.test('bundle over 64 KiB rejected before JSON.parse', () => rejects(() => parseBundle(
        Buffer.alloc(ATTESTATION_LIMITS.bundleBytes + 1, 0x7b)), C.METADATA_OVERSIZE));
    await t.test('manifest over 256 KiB rejected before any parse', () => rejects(() => verifyRelease({
        bundleBytes: Buffer.from('not json'), manifestBytes: Buffer.alloc(ATTESTATION_LIMITS.manifestBytes + 1, 0x7b),
        trustedRoot: ROOT, policy: GOR_POLICY }), C.METADATA_OVERSIZE));
    await t.test('real bundle padded over the cap', () => rejects(() => verifyGor({
        bundleBytes: mutated((b) => { b.pad = 'A'.repeat(70000); }) }), C.METADATA_OVERSIZE));
    await t.test('not JSON', () => rejects(() => parseBundle(Buffer.from('{')), C.ATTESTATION_INVALID, 'bundle'));
    await t.test('bundle bytes missing or a string', () => {
        rejects(() => verifyGor({ bundleBytes: undefined }), C.ATTESTATION_INVALID, 'bundle');
        rejects(() => verifyRelease({ bundleBytes: '{}', manifestBytes: Buffer.from('{}'), trustedRoot: ROOT,
            policy: GOR_POLICY }), C.ATTESTATION_INVALID);
        rejects(() => verifyRelease({ bundleBytes: GOR, manifestBytes: '{}', trustedRoot: ROOT, policy: GOR_POLICY }),
            C.MANIFEST_NOT_ATTESTED);
    });
    await t.test('invalid bundle (missing fields)', () => rejects(() => parseBundle(Buffer.from(JSON.stringify(
        { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' }))), C.ATTESTATION_INVALID, 'bundle'));
    await t.test('older media type v0.2', () => rejects(() => parseBundle(mutated((b) => {
        b.mediaType = 'application/vnd.dev.sigstore.bundle+json;version=0.2';
        b.verificationMaterial.x509CertificateChain = { certificates: [b.verificationMaterial.certificate] };
        delete b.verificationMaterial.certificate;
    })), C.ATTESTATION_INVALID, 'bundle'));
    await t.test('publicKey verification material', () => rejects(() => parseBundle(mutated((b) => {
        delete b.verificationMaterial.certificate;
        b.verificationMaterial.publicKey = { hint: 'not-a-certificate' };
    })), C.ATTESTATION_INVALID, 'bundle'));
    await t.test('messageSignature content', () => rejects(() => parseBundle(mutated((b) => {
        delete b.dsseEnvelope;
        b.messageSignature = { messageDigest: { algorithm: 'SHA2_256', digest: Buffer.alloc(32).toString('base64') }, signature: 'AA==' };
    })), C.ATTESTATION_INVALID, 'bundle'));
    await t.test('unparseable certificate bytes', () => rejects(() => verifyGor({ bundleBytes: mutated((b) => {
        b.verificationMaterial.certificate.rawBytes = Buffer.from('garbage').toString('base64');
    }) }), C.ATTESTATION_INVALID, 'certificate'));
});

test('statement: _type, predicate and workflow consistency', async (t) => {
    const pol = validateTrustPolicy(GOR_POLICY);
    const exp = gorExpected();
    const st = () => ({ _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
        subject: [{ name: 'm', digest: { sha256: GOR_SUBJECT } }, { name: 'x', digest: { sha512: 'ab' } }],
        predicate: { buildDefinition: { externalParameters: { workflow: {
            path: pol.workflowPath, ref: exp.ref, repository: `https://github.com/${pol.repository}` } } } } });
    await t.test('valid statement yields sha256 subjects only', () => assert.deepEqual([...checkStatement(st(), pol, exp).keys()],
        [GOR_SUBJECT]));
    await t.test('_type v0.1', () => rejects(() => checkStatement({ ...st(), _type: 'https://in-toto.io/Statement/v0.1' }, pol, exp),
        C.ATTESTATION_INVALID, 'statement'));
    await t.test('_type missing', () => rejects(() => checkStatement({ ...st(), _type: undefined }, pol, exp), C.ATTESTATION_INVALID));
    await t.test('release/v0.2 predicate', () => rejects(() => checkStatement({ ...st(),
        predicateType: 'https://in-toto.io/attestation/release/v0.2' }, pol, exp), C.ATTESTATION_INVALID));
    await t.test('workflow path differs', () => rejects(() => checkStatement({ ...st(), predicate: {} }, pol, exp),
        C.ATTESTATION_IDENTITY_MISMATCH, 'statement-workflow'));
    await t.test('no subjects', () => rejects(() => checkStatement({ ...st(), subject: [] }, pol, exp), C.ATTESTATION_INVALID));
    await t.test('payloadType not in-toto', () => rejects(() => verifyGor({ bundleBytes: mutated((b) => {
        b.dsseEnvelope.payloadType = 'text/plain';
    }) }), C.ATTESTATION_INVALID));
});

test('subjects: manifest mandatory and attested; artifacts match manifest and subject', async (t) => {
    const attested = verifyGor();
    const manifest = Buffer.from(JSON.stringify({ version: '2.18.2', source: { commit: GOR_COMMIT } }));
    await t.test('manifest not a subject (real bundle, all other checks pass)', () => rejects(() => verifyRelease({
        bundleBytes: GOR, manifestBytes: manifest, trustedRoot: ROOT, policy: GOR_POLICY,
        readIdentity: () => GOR_RELEASE, allowForeignVersion: true }), C.MANIFEST_NOT_ATTESTED));
    await t.test('a manifest reader is mandatory (no identity-only default)', () => assert.throws(() => verifyRelease({
        bundleBytes: GOR, manifestBytes: manifest, trustedRoot: ROOT, policy: GOR_POLICY }), /needs a manifest reader/));
    await t.test('manifest bytes missing', () => rejects(() => verifyRelease({
        bundleBytes: GOR, trustedRoot: ROOT, policy: GOR_POLICY }), C.MANIFEST_NOT_ATTESTED));
    await t.test('manifest subject present', () => {
        const fake = { subjects: new Map([[sha256Hex(manifest), 'release-manifest.json']]) };
        assert.equal(requireManifestSubject(fake, manifest), sha256Hex(manifest));
    });
    const ok = { name: 'a.tar.gz', manifestSha256: GOR_SUBJECT, actualSha256: GOR_SUBJECT };
    await t.test('archive matches manifest and subject', () => assert.equal(verifyArtifactDigests(attested, [ok]), 1));
    await t.test('archive digest != manifest', () => rejects(() => verifyArtifactDigests(attested,
        [{ ...ok, actualSha256: 'b'.repeat(64) }]), C.ARTIFACT_DIGEST_MISMATCH, 'a.tar.gz'));
    await t.test('archive == manifest but != any subject', () => rejects(() => verifyArtifactDigests(attested,
        [{ ...ok, manifestSha256: 'c'.repeat(64), actualSha256: 'c'.repeat(64) }]), C.ARTIFACT_DIGEST_MISMATCH));
    await t.test('empty artifact list', () => rejects(() => verifyArtifactDigests(attested, []), C.ARTIFACT_DIGEST_MISMATCH));
    await t.test('missing digest', () => rejects(() => verifyArtifactDigests(attested, [{ name: 'x' }]), C.ARTIFACT_DIGEST_MISMATCH));
});

test('manifest identity reader', async (t) => {
    const good = Buffer.from(JSON.stringify({ version: '2.3.0.10', source: { commit: GOR_COMMIT } }));
    await t.test('reads version and commit', () => assert.deepEqual({ ...readManifestIdentity(good) },
        { version: '2.3.0.10', sourceCommit: GOR_COMMIT }));
    await t.test('not JSON', () => rejects(() => readManifestIdentity(Buffer.from('{')), C.MANIFEST_INVALID));
    await t.test('not UTF-8', () => rejects(() => readManifestIdentity(Buffer.from([0xff, 0xfe])), C.MANIFEST_INVALID));
    await t.test('version with path characters', () => rejects(() => readManifestIdentity(Buffer.from(JSON.stringify(
        { version: '1.2.3/../x', source: { commit: GOR_COMMIT } }))), C.MANIFEST_INVALID));
    await t.test('uppercase commit', () => rejects(() => readManifestIdentity(Buffer.from(JSON.stringify(
        { version: '1.2.3.4', source: { commit: GOR_COMMIT.toUpperCase() } }))), C.MANIFEST_INVALID));
    await t.test('three-part version is not a Nassaj release', () => rejects(() => readManifestIdentity(Buffer.from(
        JSON.stringify({ version: '2.18.2', source: { commit: GOR_COMMIT } }))), C.MANIFEST_INVALID));
    await t.test('real bundle with an a.b.c release outside the test-only allowance', () => rejects(() => verifyGor(
        { allowForeignVersion: false }), C.MANIFEST_INVALID));
    await t.test('five-part version refused even with the allowance', () => rejects(() => verifyGor(
        { release: { ...GOR_RELEASE, version: '1.2.3.4.5' } }), C.MANIFEST_INVALID));
});

test('trust policy: strict schema', async (t) => {
    const cases = [
        ['not an object', null], ['array', []],
        ...['schema', 'issuer', 'repository', 'repositoryId', 'ownerId', 'workflowPath', 'refPattern',
            'runnerEnvironment', 'channel'].flatMap((k) => [
            [`missing ${k}`, { ...GOR_POLICY, [k]: undefined }], [`empty ${k}`, { ...GOR_POLICY, [k]: '' }]]),
        ['unknown key', { ...GOR_POLICY, repositoryID: 1 }],
        ['wrong schema', { ...GOR_POLICY, schema: 'nassaj-trust-policy/v2' }],
        ['other issuer', { ...GOR_POLICY, issuer: 'https://evil.example' }],
        ['self-hosted runner allowed', { ...GOR_POLICY, runnerEnvironment: 'self-hosted' }],
        ['bad channel', { ...GOR_POLICY, channel: 'beta' }],
        ['zero repository id', { ...GOR_POLICY, repositoryId: 0 }],
        ['float owner id', { ...GOR_POLICY, ownerId: 1.5 }],
        ['leading-zero id', { ...GOR_POLICY, ownerId: '0123' }],
        ['workflow outside .github/workflows', { ...GOR_POLICY, workflowPath: 'release.yml' }],
        ['other ref pattern', { ...GOR_POLICY, refPattern: 'refs/heads/*' }],
        ['empty time sources', { ...GOR_POLICY, acceptedTimeSources: [] }],
        ['non-string time source', { ...GOR_POLICY, acceptedTimeSources: [1] }],
    ];
    for (const [name, policy] of cases) {
        await t.test(name, () => rejects(() => validateTrustPolicy(policy), C.TRUST_POLICY_MISSING));
    }
    await t.test('missing policy stops verification', () => rejects(() => verifyGor({ policy: undefined }), C.TRUST_POLICY_MISSING));
    await t.test('ids normalize to decimal strings', () => assert.equal(validateTrustPolicy(GOR_POLICY).repositoryId, '77071454'));
});

test('runtime floor: Node 24 >= 24.15.0 or >= 26; 22.x, 25.x and garbage refused', async (t) => {
    for (const v of ['24.14.9', '25.0.0', '25.2.0', '22.22.2', '23.11.0', '18.20.0', 'v24.15.0', '', 'abc']) {
        await t.test(`refuses ${JSON.stringify(v)}`, () => rejects(() => checkRuntime(v), C.VERIFIER_RUNTIME_UNSUPPORTED));
    }
    for (const v of ['24.15.0', '24.18.1', '26.0.0', '27.1.0']) {
        await t.test(`accepts ${v}`, () => assert.equal(checkRuntime(v), v));
    }
    await t.test('the running Node is accepted', () => assert.equal(checkRuntime(), process.versions.node));
});

test('runtime floor stays inside the pinned @sigstore/verify engines range', () => {
    const pkg = createRequire(import.meta.url)('@sigstore/verify/package.json');
    assert.equal(pkg.version, '4.1.2');
    assert.equal(pkg.engines.node, '^22.22.2 || ^24.15.0 || >=26.0.0',
        'engines changed: re-derive checkRuntime (design §7.4 rule 0a) before bumping @sigstore/verify');
});

test('store selection keeps only user-initiated SLSA v1 provenance', () => {
    const gor = JSON.parse(GOR.toString('utf8'));
    const release = json('gh-release-attestation.json');
    const picked = selectUserProvenance([
        { initiator: 'user', bundle: gor }, { initiator: 'github', bundle: gor },
        { initiator: 'user', bundle: release }, { initiator: 'user', bundle: {} }, null,
    ]);
    assert.equal(picked.length, 1);
    assert.equal(picked[0].bundle, gor);
    assert.deepEqual(selectUserProvenance(undefined), []);
});

test('CLI under unshare -rn with the preload guard: full crypto path runs offline', (t) => {
    const probe = spawnSync('unshare', ['-rn', 'true']);
    if (probe.status !== 0) {
        t.skip('unprivileged user+net namespaces unavailable');
        return;
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), 'attest-cli-'));
    try {
        const file = (name, body) => { const f = path.join(dir, name); writeFileSync(f, body); return f; };
        // A schema-valid a.b.c.d manifest carrying the real goreleaser commit: the CLI
        // parses it strictly, then the library crypto runs offline and the tag differs.
        const base = manifestFixture({ version: '2.18.2.0' });
        const manifest = file('m.json', serializeReleaseManifest({ ...base, source: { ...base.source, commit: GOR_COMMIT } }));
        const policy = file('p.json', JSON.stringify(GOR_POLICY));
        const run = (...args) => spawnSync('unshare', ['-rn', process.execPath, '--require', GUARD, VERIFIER, ...args],
            { encoding: 'utf8' });
        const real = run(path.join(FIX, 'gor.json'), path.join(FIX, 'trusted_root.json'), policy, manifest);
        assert.match(real.stdout, /^REJECTED attestation_identity_mismatch: UNTRUSTED_SIGNER_ERROR/, real.stdout + real.stderr);
        assert.equal(real.status, 2);
        assert.doesNotMatch(real.stderr, /NET_ATTEMPT/);
        const noPolicy = run(path.join(FIX, 'gor.json'), path.join(FIX, 'trusted_root.json'), path.join(dir, 'none'), manifest);
        assert.match(noPolicy.stdout, /^REJECTED trust_policy_missing:/);
        assert.equal(run().status, 64);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('no network attempt was made by any case in this file', () => {
    assert.equal(globalThis.__netAttempts ?? 0, 0);
});
