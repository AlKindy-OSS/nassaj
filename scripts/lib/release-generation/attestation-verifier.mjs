/**
 * Offline verifier for GitHub artifact attestations of release generations
 * (ADR-174 design rev 4.2, §7.4 rules 0–4, §7.9 stale-root detection).
 *
 * Inputs are bytes and JSON already on the node: the Sigstore bundle asset,
 * the manifest bytes, the Sigstore trusted root pinned in the RUNNING
 * generation and the identity policy anchor. It never touches the network.
 * Every failure throws AttestationError with a stable `code` (§14); nothing
 * from the libraries is surfaced raw.
 *
 * Self-contained on purpose (only node: builtins and the pinned @sigstore
 * packages), so it can be bundled into one file for the installer. The CLI
 * and the full node path (schema, verifier version, decision) live in
 * standalone-verifier.mjs and release-verification.mjs.
 */
import { createHash } from 'node:crypto';
import { bundleFromJSON, BUNDLE_V03_MEDIA_TYPE } from '@sigstore/bundle';
import { ASN1Obj, X509Certificate } from '@sigstore/core';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { Verifier, toSignedEntity, toTrustMaterial } from '@sigstore/verify';

/** Stable reason codes produced by this module (design §14). */
export const ATTESTATION_CODES = Object.freeze({
    VERIFIER_RUNTIME_UNSUPPORTED: 'verifier_runtime_unsupported',
    TRUST_POLICY_MISSING: 'trust_policy_missing',
    METADATA_OVERSIZE: 'metadata_oversize',
    MANIFEST_INVALID: 'manifest_invalid',
    ATTESTATION_INVALID: 'attestation_invalid',
    ATTESTATION_NO_TRUSTED_TIME: 'attestation_no_trusted_time',
    ATTESTATION_TRUST_ROOT_STALE: 'attestation_trust_root_stale',
    ATTESTATION_IDENTITY_MISMATCH: 'attestation_identity_mismatch',
    MANIFEST_NOT_ATTESTED: 'manifest_not_attested',
    ARTIFACT_DIGEST_MISMATCH: 'artifact_digest_mismatch',
});
const C = ATTESTATION_CODES;

/** §7.4 rule 0 caps, checked before any parse. */
export const ATTESTATION_LIMITS = Object.freeze({ manifestBytes: 256 * 1024, bundleBytes: 64 * 1024 });

export const TRUST_POLICY_SCHEMA = 'nassaj-trust-policy/v1';
export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
/** The only ref template accepted in a policy: the tag is `v` + manifest.version. */
export const REF_PATTERN = 'refs/tags/v<a.b.c.d>';
export const REKOR_V1_URL = 'https://rekor.sigstore.dev';
export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
/** Fixed identity values (§7.4 rule 2); not policy fields, so no policy can relax them. */
export const REQUIRED_BUILD_TRIGGER = 'push';
export const REQUIRED_VISIBILITY = 'public';
export const REQUIRED_RUNNER = 'github-hosted';

const ASN1_UTF8STRING = 0x0c;
const FULCIO_OID = (n) => `1.3.6.1.4.1.57264.1.${n}`;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** Nassaj release versions are a.b.c.d (policy refPattern `refs/tags/v<a.b.c.d>`). */
const VERSION = /^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){3}$/;
/** Three-part versions of the third-party real bundles used as test fixtures only. */
const FOREIGN_VERSION = /^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){2,3}$/;
const DECIMAL_ID = /^[1-9]\d{0,19}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\.ya?ml$/;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** Error with a stable reason `code`, a short non-secret `detail` and an optional identity `field`. */
export class AttestationError extends Error {
    /**
     * @param {string} code one of ATTESTATION_CODES
     * @param {string} detail diagnostic text
     * @param {string} [field] identity field or check that failed
     */
    constructor(code, detail, field) {
        super(`${code}: ${detail}`);
        this.name = 'AttestationError';
        this.code = code;
        this.detail = detail;
        if (field) this.field = field;
    }
}

function fail(code, detail, field) {
    throw new AttestationError(code, detail, field);
}

/**
 * §7.4 rule 0a: refuse runtimes outside the shipped @sigstore/verify range
 * (Node 24 >= 24.15.0, or >= 26; 25.x and 22.x are refused).
 * @param {string} [version] Node version, defaults to the running one
 * @returns {string} the accepted version
 */
export function checkRuntime(version = process.versions.node) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
    const major = m ? Number(m[1]) : NaN;
    const minor = m ? Number(m[2]) : NaN;
    if ((major === 24 && minor >= 15) || major >= 26) return version;
    return fail(C.VERIFIER_RUNTIME_UNSUPPORTED, `node ${version}; need >= 24.15.0 on 24.x, or >= 26`);
}

/**
 * Accepted trusted-time sources, keyed by name (§7.4 rule 1). Each entry owns
 * its detection; a policy name absent here is never accepted. The bridge
 * release adds 'rekor-v2+tsa' with its own real fixture.
 */
export const TIME_SOURCES = Object.freeze({
    'rekor-v1-set+proof': Object.freeze({
        /** Both a SET and an inclusion proof with checkpoint, and no RFC 3161 timestamp. */
        matches(bundle, entry) {
            const tsa = bundle.verificationMaterial.timestampVerificationData?.rfc3161Timestamps || [];
            return Boolean(entry.inclusionPromise?.signedEntryTimestamp?.length)
                && Boolean(entry.inclusionProof?.checkpoint?.envelope)
                && tsa.length === 0;
        },
    }),
});

const POLICY_KEYS = ['schema', 'issuer', 'repository', 'repositoryId', 'ownerId', 'workflowPath',
    'refPattern', 'runnerEnvironment', 'channel'];
const POLICY_OPTIONAL = ['acceptedTimeSources'];
const POLICY_RULES = {
    schema: (v) => v === TRUST_POLICY_SCHEMA,
    issuer: (v) => v === GITHUB_OIDC_ISSUER,
    repository: (v) => typeof v === 'string' && REPOSITORY.test(v),
    repositoryId: (v) => DECIMAL_ID.test(normalizeId(v)),
    ownerId: (v) => DECIMAL_ID.test(normalizeId(v)),
    workflowPath: (v) => typeof v === 'string' && WORKFLOW_PATH.test(v),
    refPattern: (v) => v === REF_PATTERN,
    runnerEnvironment: (v) => v === REQUIRED_RUNNER,
    channel: (v) => v === 'stable' || v === 'canary',
    acceptedTimeSources: (v) => Array.isArray(v) && v.length > 0 && v.length <= 8
        && v.every((n) => typeof n === 'string' && n.length > 0 && n.length <= 64),
};

function normalizeId(value) {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
    return typeof value === 'string' ? value : '';
}

/**
 * Strictly validates the identity policy anchor (§7.1). Missing, empty,
 * unknown or malformed fields → trust_policy_missing.
 * @param {unknown} policy parsed config/trust/policy.json
 * @returns {Readonly<object>} normalized policy (ids as decimal strings)
 */
export function validateTrustPolicy(policy) {
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
        fail(C.TRUST_POLICY_MISSING, 'policy is not an object');
    }
    for (const key of Object.keys(policy)) {
        if (!POLICY_KEYS.includes(key) && !POLICY_OPTIONAL.includes(key)) fail(C.TRUST_POLICY_MISSING, `unknown key ${key}`);
    }
    for (const key of POLICY_KEYS) {
        if (policy[key] === undefined || policy[key] === '') fail(C.TRUST_POLICY_MISSING, `missing ${key}`);
    }
    for (const key of [...POLICY_KEYS, ...POLICY_OPTIONAL]) {
        if (policy[key] !== undefined && !POLICY_RULES[key](policy[key])) fail(C.TRUST_POLICY_MISSING, `invalid ${key}`);
    }
    return Object.freeze({
        ...policy,
        repositoryId: normalizeId(policy.repositoryId),
        ownerId: normalizeId(policy.ownerId),
        acceptedTimeSources: Object.freeze([...(policy.acceptedTimeSources || ['rekor-v1-set+proof'])]),
    });
}

/**
 * §7.4 rule 0: both caps before any parse.
 * @param {{manifestBytes?: Uint8Array, bundleBytes?: Uint8Array}} sizes
 */
export function checkSizeCaps({ manifestBytes, bundleBytes }) {
    const typeCodes = { manifest: C.MANIFEST_NOT_ATTESTED, bundle: C.ATTESTATION_INVALID };
    for (const [name, bytes] of [['manifest', manifestBytes], ['bundle', bundleBytes]]) {
        if (bytes === undefined) continue;
        if (!(bytes instanceof Uint8Array)) fail(typeCodes[name], `${name} bytes must be a Uint8Array`);
        const cap = ATTESTATION_LIMITS[`${name}Bytes`];
        if (bytes.byteLength > cap) fail(C.METADATA_OVERSIZE, `${name} ${bytes.byteLength} B > ${cap} B`);
    }
}

/**
 * §7.4 rules 0 and 0b: size cap, JSON + bundleFromJSON guard, v0.3 media type,
 * DSSE content and certificate material. Any failure → attestation_invalid.
 * @param {Uint8Array} bytes bundle asset bytes
 * @returns {object} parsed @sigstore/bundle Bundle
 */
export function parseBundle(bytes) {
    if (!(bytes instanceof Uint8Array)) fail(C.ATTESTATION_INVALID, 'bundle bytes are required', 'bundle');
    checkSizeCaps({ bundleBytes: bytes });
    let bundle;
    try {
        bundle = bundleFromJSON(JSON.parse(Buffer.from(bytes).toString('utf8')));
    } catch (e) {
        fail(C.ATTESTATION_INVALID, `bundle parse: ${e.message}`, 'bundle');
    }
    if (bundle.mediaType !== BUNDLE_V03_MEDIA_TYPE) fail(C.ATTESTATION_INVALID, `mediaType ${bundle.mediaType}`, 'bundle');
    if (bundle.content?.$case !== 'dsseEnvelope') fail(C.ATTESTATION_INVALID, `content ${bundle.content?.$case}`, 'bundle');
    const vm = bundle.verificationMaterial?.content?.$case;
    if (vm !== 'certificate') fail(C.ATTESTATION_INVALID, `verification material ${vm}, need certificate`, 'bundle');
    return bundle;
}

/**
 * Loads the pinned trusted root; an unreadable root is missing trust material.
 * @param {object} rootJson parsed trusted_root.json
 * @returns {{json: object, material: object}}
 */
export function loadTrustedRoot(rootJson) {
    const lists = ['tlogs', 'ctlogs', 'certificateAuthorities'];
    if (!rootJson || typeof rootJson !== 'object' || !lists.every((k) => Array.isArray(rootJson[k]))) {
        fail(C.TRUST_POLICY_MISSING, 'trusted root lacks tlogs/ctlogs/certificateAuthorities', 'trusted-root');
    }
    try {
        return { json: rootJson, material: toTrustMaterial(TrustedRoot.fromJSON(rootJson)) };
    } catch (e) {
        return fail(C.TRUST_POLICY_MISSING, `trusted root unreadable: ${e.message}`, 'trusted-root');
    }
}

/**
 * Wrapper tlog contract (§7.4 rule 1): exactly one dsse/0.0.1 entry on the
 * pinned Rekor v1 log. logId absent from the root → stale; present on another log → invalid.
 * @returns {object} the single tlog entry (source of integratedTime, logIndex, SET)
 */
export function checkTlogContract(bundle, rootJson) {
    const entries = bundle.verificationMaterial.tlogEntries || [];
    if (entries.length !== 1) fail(C.ATTESTATION_INVALID, `tlogEntries.length ${entries.length} != 1`, 'tlog');
    const [entry] = entries;
    const kv = entry.kindVersion || {};
    if (kv.kind !== 'dsse' || kv.version !== '0.0.1') fail(C.ATTESTATION_INVALID, `tlog kind ${kv.kind}/${kv.version}`, 'tlog');
    const logId = b64(entry.logId?.keyId || []);
    const log = (rootJson.tlogs || []).find((t) => t.logId?.keyId === logId);
    if (!log) fail(C.ATTESTATION_TRUST_ROOT_STALE, `tlog logId ${logId} absent from pinned root`, 'tlog-log-id');
    if (log.baseUrl !== REKOR_V1_URL) fail(C.ATTESTATION_INVALID, `tlog ${log.baseUrl} is not ${REKOR_V1_URL}`, 'tlog');
    return entry;
}

/**
 * Returns the first accepted time-source name the bundle satisfies; names the
 * registry does not implement are skipped (§7.4 rule 1).
 * @throws attestation_no_trusted_time
 */
export function checkTimeSource(bundle, entry, accepted) {
    for (const name of accepted) {
        if (Object.hasOwn(TIME_SOURCES, name) && TIME_SOURCES[name].matches(bundle, entry)) return name;
    }
    return fail(C.ATTESTATION_NO_TRUSTED_TIME, `no accepted trusted time source (accepted: ${accepted.join(',')})`);
}

function caSubjectKeyIds(rootJson) {
    const ids = new Set();
    for (const ca of rootJson.certificateAuthorities || []) {
        for (const raw of ca.certChain?.certificates || []) {
            const ski = X509Certificate.parse(Buffer.from(raw.rawBytes, 'base64')).extSubjectKeyID?.keyIdentifier;
            if (ski) ids.add(b64(ski));
        }
    }
    return ids;
}

/**
 * §7.9 stale-root conditions (b) and (c): the leaf AKI must match a CA SKI in
 * the root, and at least one embedded SCT must come from a ctlog in the root.
 * A certificate with no SCT is invalid, not stale.
 */
export function checkRootCoversCert(cert, rootJson) {
    const aki = cert.extAuthorityKeyID?.keyIdentifier;
    if (!aki || !caSubjectKeyIds(rootJson).has(b64(aki))) {
        fail(C.ATTESTATION_TRUST_ROOT_STALE, 'certificate issuer AKI matches no CA in the pinned root', 'ca-aki');
    }
    const scts = cert.extSCT?.signedCertificateTimestamps || [];
    if (scts.length === 0) fail(C.ATTESTATION_INVALID, 'certificate carries no SCT', 'sct');
    const ctIds = new Set((rootJson.ctlogs || []).map((l) => l.logId?.keyId));
    if (!scts.some((s) => ctIds.has(b64(s.logID)))) {
        fail(C.ATTESTATION_TRUST_ROOT_STALE, 'no SCT logId in the pinned ctlogs', 'ct-log-id');
    }
}

/**
 * Reads Fulcio extension 1.<n>; the value must be a DER UTF8String (tag 0x0C).
 * @returns {string|undefined} undefined when the extension is absent
 */
export function extString(cert, n) {
    const ext = cert.extension(FULCIO_OID(n));
    if (!ext) return undefined;
    let obj;
    try {
        obj = ASN1Obj.parseBuffer(ext.value);
    } catch (e) {
        fail(C.ATTESTATION_INVALID, `OID 1.${n} is not DER: ${e.message}`, `1.${n}`);
    }
    if (!obj.tag.isUniversal() || obj.tag.number !== ASN1_UTF8STRING) {
        fail(C.ATTESTATION_INVALID, `OID 1.${n} is not a UTF8String (tag ${obj.tag.number})`, `1.${n}`);
    }
    return obj.value.toString('utf8');
}

/**
 * Validates the manifest-derived identity inputs used to build the expected SAN.
 * @param {{version: string, sourceCommit: string}} release
 * @param {{allowForeignVersion?: boolean}} [options] `allowForeignVersion` also
 *   accepts a.b.c; it exists only so tests can verify real third-party bundles
 *   (goreleaser, mise). No production caller (CLI, verifyAndDecide) sets it.
 */
export function validateReleaseIdentity(release, { allowForeignVersion = false } = {}) {
    const pattern = allowForeignVersion ? FOREIGN_VERSION : VERSION;
    if (typeof release?.version !== 'string' || !pattern.test(release.version)) {
        fail(C.MANIFEST_INVALID, 'manifest.version is not an a.b.c.d release version');
    }
    if (typeof release.sourceCommit !== 'string' || !COMMIT.test(release.sourceCommit)) {
        fail(C.MANIFEST_INVALID, 'manifest.source.commit is not a lowercase 40-hex commit');
    }
    return Object.freeze({ version: release.version, sourceCommit: release.sourceCommit });
}

/**
 * Builds the exact certificate identity expected for this policy and release (§7.4 rule 2).
 * @returns {Readonly<{san: string, ref: string, oids: ReadonlyArray<[string, number, string]>}>}
 */
export function expectedIdentity(policy, release) {
    const ref = `refs/tags/v${release.version}`;
    const san = `https://github.com/${policy.repository}/${policy.workflowPath}@${ref}`;
    const oids = [
        ['issuer', 8, policy.issuer], ['buildSignerUri', 9, san], ['runnerEnvironment', 11, REQUIRED_RUNNER],
        ['sourceCommit', 13, release.sourceCommit], ['sourceRef', 14, ref], ['repositoryId', 15, policy.repositoryId],
        ['ownerId', 17, policy.ownerId], ['buildConfigUri', 18, san], ['buildTrigger', 20, REQUIRED_BUILD_TRIGGER],
        ['visibility', 22, REQUIRED_VISIBILITY],
    ];
    return Object.freeze({ san, ref, oids: Object.freeze(oids) });
}

/**
 * Compares SAN and every pinned Fulcio OID exactly; deprecated OIDs 1.1–1.6 are never read.
 * @returns {Readonly<object>} the verified identity values keyed by field name
 */
export function checkIdentity(cert, expected) {
    if (cert.subjectAltName !== expected.san) {
        fail(C.ATTESTATION_IDENTITY_MISMATCH, `SAN ${cert.subjectAltName} != ${expected.san}`, 'san');
    }
    const got = { san: cert.subjectAltName };
    for (const [field, n, want] of expected.oids) {
        const value = extString(cert, n);
        if (value !== want) {
            fail(C.ATTESTATION_IDENTITY_MISMATCH, `OID 1.${n} ${JSON.stringify(value)} != ${JSON.stringify(want)}`, field);
        }
        got[field] = value;
    }
    return Object.freeze(got);
}

function libraryVerify(bundle, material, expected) {
    const verifier = new Verifier(material, { tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1 });
    try {
        verifier.verify(toSignedEntity(bundle), {
            subjectAlternativeName: expected.san,
            extensions: { issuer: GITHUB_OIDC_ISSUER },
        });
    } catch (e) {
        const identity = e.code === 'UNTRUSTED_SIGNER_ERROR';
        const err = new AttestationError(identity ? C.ATTESTATION_IDENTITY_MISMATCH : C.ATTESTATION_INVALID,
            `${e.code || e.name}: ${e.message}`, identity ? 'library-policy' : 'library');
        err.libraryCode = e.code || e.name;
        throw err;
    }
}

function readStatement(bundle) {
    const env = bundle.content.dsseEnvelope;
    if (env.payloadType !== IN_TOTO_PAYLOAD_TYPE) fail(C.ATTESTATION_INVALID, `payloadType ${env.payloadType}`, 'statement');
    try {
        return JSON.parse(Buffer.from(env.payload).toString('utf8'));
    } catch (e) {
        return fail(C.ATTESTATION_INVALID, `statement parse: ${e.message}`, 'statement');
    }
}

/**
 * §7.4 rule 3: statement `_type`, SLSA v1 predicate and workflow consistency
 * with the certificate. Returns the attested sha256 subjects.
 * @returns {ReadonlyMap<string, string>} sha256 hex → subject name
 */
export function checkStatement(st, policy, expected) {
    if (st?._type !== STATEMENT_TYPE) fail(C.ATTESTATION_INVALID, `statement _type ${st?._type}`, 'statement');
    if (st.predicateType !== SLSA_PROVENANCE_V1) fail(C.ATTESTATION_INVALID, `predicateType ${st.predicateType}`, 'statement');
    const wf = st.predicate?.buildDefinition?.externalParameters?.workflow || {};
    const consistent = wf.path === policy.workflowPath && wf.ref === expected.ref
        && wf.repository === `https://github.com/${policy.repository}`;
    if (!consistent) fail(C.ATTESTATION_IDENTITY_MISMATCH, `statement workflow ${JSON.stringify(wf)}`, 'statement-workflow');
    if (!Array.isArray(st.subject) || st.subject.length === 0) fail(C.ATTESTATION_INVALID, 'statement has no subjects', 'statement');
    const subjects = new Map();
    for (const s of st.subject) {
        const digest = s?.digest?.sha256;
        if (typeof digest === 'string' && HEX64.test(digest)) subjects.set(digest, String(s.name ?? ''));
    }
    return subjects;
}

function certificateOf(bundle) {
    try {
        return X509Certificate.parse(bundle.verificationMaterial.content.certificate.rawBytes);
    } catch (e) {
        return fail(C.ATTESTATION_INVALID, `certificate parse: ${e.message}`, 'certificate');
    }
}

/**
 * Checks that need the root but no identity: tlog contract, time source, stale-root (§7.9).
 * @returns {{entry: object, timeSource: string, cert: object}}
 */
export function checkBundleAgainstRoot(bundle, rootJson, acceptedTimeSources) {
    const entry = checkTlogContract(bundle, rootJson);
    const timeSource = checkTimeSource(bundle, entry, acceptedTimeSources);
    const cert = certificateOf(bundle);
    checkRootCoversCert(cert, rootJson);
    return { entry, timeSource, cert };
}

/**
 * Rules 0a–3 for one bundle, offline: runtime, policy, caps/parse, contract,
 * stale root, library crypto (chain, DSSE, SET + proof, time windows), identity, statement.
 * @param {{bundleBytes: Uint8Array, trustedRoot: object, policy: object,
 *          release: {version: string, sourceCommit: string}, allowForeignVersion?: boolean}} input
 * @returns {Readonly<object>} verified facts incl. integratedTime, logIndex and subjects
 */
export function verifyAttestationBundle({ bundleBytes, trustedRoot, policy, release, allowForeignVersion = false }) {
    checkRuntime();
    const pol = validateTrustPolicy(policy);
    const rel = validateReleaseIdentity(release, { allowForeignVersion });
    const bundle = parseBundle(bundleBytes);
    const root = loadTrustedRoot(trustedRoot);
    const { entry, timeSource, cert } = checkBundleAgainstRoot(bundle, root.json, pol.acceptedTimeSources);
    const expected = expectedIdentity(pol, rel);
    libraryVerify(bundle, root.material, expected);
    const identity = checkIdentity(cert, expected);
    const subjects = checkStatement(readStatement(bundle), pol, expected);
    return Object.freeze({
        timeSource,
        integratedTime: new Date(Number(entry.integratedTime) * 1000).toISOString(),
        logIndex: String(entry.logIndex),
        identity,
        subjects,
    });
}

/**
 * Identity-only reader (version and source.commit). Not a schema check: node
 * and pipeline callers use release-verification.mjs readReleaseManifest.
 * @param {Uint8Array} bytes manifest bytes
 */
export function readManifestIdentity(bytes) {
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        fail(C.MANIFEST_INVALID, 'manifest is not UTF-8 JSON');
    }
    return validateReleaseIdentity({ version: value?.version, sourceCommit: value?.source?.commit });
}

/** sha256 hex of bytes. */
export function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * §7.4 rule 4 (first half): the exact manifest bytes must be an attested subject.
 * @returns {string} manifest sha256
 */
export function requireManifestSubject(attested, manifestBytes) {
    const digest = sha256Hex(manifestBytes);
    if (!attested.subjects.has(digest)) fail(C.MANIFEST_NOT_ATTESTED, `manifest sha256 ${digest} is not a subject`);
    return digest;
}

/**
 * Metadata verification: caps before any parse, the caller's manifest reader,
 * rules 1–3, then the manifest is a mandatory subject. Archives are checked
 * later with verifyArtifactDigests. The reader is required so no caller can
 * silently fall back to an identity-only read (release-verification.mjs
 * passes the strict schema parser).
 * @param {{bundleBytes: Uint8Array, manifestBytes: Uint8Array, trustedRoot: object, policy: object,
 *          readIdentity: (bytes: Uint8Array) => {version: string, sourceCommit: string},
 *          allowForeignVersion?: boolean}} input
 */
export function verifyRelease({ bundleBytes, manifestBytes, trustedRoot, policy, readIdentity,
    allowForeignVersion = false }) {
    checkRuntime();
    if (!(manifestBytes instanceof Uint8Array)) fail(C.MANIFEST_NOT_ATTESTED, 'manifest bytes are required');
    checkSizeCaps({ manifestBytes, bundleBytes });
    validateTrustPolicy(policy);
    if (typeof readIdentity !== 'function') throw new TypeError('verifyRelease needs a manifest reader');
    const release = readIdentity(manifestBytes);
    const attested = verifyAttestationBundle({ bundleBytes, trustedRoot, policy, release, allowForeignVersion });
    const manifestSha256 = requireManifestSubject(attested, manifestBytes);
    return Object.freeze({ ...attested, manifestSha256, release });
}

/**
 * §7.4 rule 4 (second half): each archive/installer sha256 must equal its
 * manifest entry AND be an attested subject. An empty list is refused.
 * @param {{subjects: ReadonlyMap<string, string>}} attested result of verifyRelease
 * @param {Array<{name: string, manifestSha256: string, actualSha256: string}>} artifacts
 */
export function verifyArtifactDigests(attested, artifacts) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) fail(C.ARTIFACT_DIGEST_MISMATCH, 'no artifacts to verify');
    for (const a of artifacts) {
        const name = String(a?.name);
        if (!HEX64.test(a?.actualSha256 ?? '') || a.actualSha256 !== a.manifestSha256) {
            fail(C.ARTIFACT_DIGEST_MISMATCH, `${name} sha256 differs from the manifest`, name);
        }
        if (!attested.subjects.has(a.actualSha256)) fail(C.ARTIFACT_DIGEST_MISMATCH, `${name} sha256 is not a subject`, name);
    }
    return artifacts.length;
}

/**
 * Attestation-store consumers (pipeline and human tools, §7.2) select only
 * user-initiated SLSA v1 attestations; GitHub's release attestation is dropped.
 * @param {Array<{initiator?: string, bundle?: object}>} entries store API items
 */
export function selectUserProvenance(entries) {
    return (entries || []).filter((e) => e?.initiator === 'user' && predicateTypeOf(e.bundle) === SLSA_PROVENANCE_V1);
}

function predicateTypeOf(bundleJson) {
    try {
        return JSON.parse(Buffer.from(bundleJson.dsseEnvelope.payload, 'base64').toString('utf8')).predicateType;
    } catch {
        return undefined;
    }
}
