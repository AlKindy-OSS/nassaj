/**
 * Strict schema for `release-manifest.json` (ADR-174 §7.3) and its parse guard
 * (§7.4 rule 0: size cap before parse). Offline and dependency-free.
 *
 * The manifest is an attestation subject, so its exact bytes matter: they must
 * be valid UTF-8, within the size cap, and in canonical form (sorted keys, no
 * whitespace, one trailing newline). Canonical form removes any second reading
 * of the same bytes (duplicate keys, alternative spellings).
 */
import { createHash } from 'node:crypto';
import { compareNassajReleaseVersions } from '../../../shared/release-version-policy.js';
import { RELEASE_MANIFEST_CODES as CODES, failRelease } from './release-manifest-codes.mjs';
import { assertShape, canonicalJson, deepFreeze, isPlainObject, shape } from './strict-shape.mjs';

export const RELEASE_MANIFEST_SCHEMA = 'nassaj-release-manifest/v1';
export const RELEASE_MANIFEST_NAME = 'release-manifest.json';
export const RELEASE_BUNDLE_NAME = 'release-attestation.sigstore.json';
/** §7.4 rule 0: manifest ≤ 256 KiB, checked before any parse. */
export const RELEASE_MANIFEST_MAX_BYTES = 256 * 1024;
export const RELEASE_CHANNELS = Object.freeze(['stable', 'canary']);
export const RELEASE_TARGETS = Object.freeze(['linux-x64-glibc', 'linux-arm64-glibc']);
export const MIGRATION_CLASSES = Object.freeze(['none', 'compatible', 'breaking']);
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';

const FUTURE_SCHEMA = /^nassaj-release-manifest\/v[1-9]\d{0,3}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const DECIMAL_ID = /^[1-9]\d{0,19}$/;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}\.ya?ml$/;
const SEGMENT = '[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*';
const RELATIVE_PATH = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`);
const GLIBC = /^2\.(0|[1-9]\d{0,2})$/;
const NODE_VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const NPM_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

const version = shape.string(VERSION, 64);
const sha256 = shape.string(HEX64, 64);
const asset = shape.object({ name: shape.string(ASSET_NAME, 128), size: shape.integer(1), sha256 });

const MANIFEST_SHAPE = shape.object({
    schema: shape.oneOf([RELEASE_MANIFEST_SCHEMA]),
    channel: shape.oneOf(RELEASE_CHANNELS),
    version,
    releaseSequence: shape.integer(1),
    minUpgradeFrom: version,
    minVerifierVersion: shape.integer(1, 1_000_000),
    minShimVersion: shape.integer(1, 1_000_000),
    source: shape.object({
        repository: shape.string(REPOSITORY, 140),
        repositoryId: shape.string(DECIMAL_ID, 20),
        commit: shape.string(COMMIT, 40),
        ref: shape.string(/^refs\/tags\/v/, 80),
        workflowPath: shape.string(WORKFLOW_PATH, 160),
        buildScript: shape.object({ path: shape.string(RELATIVE_PATH, 512), sha256 }),
    }),
    targets: shape.array(shape.object({
        target: shape.oneOf(RELEASE_TARGETS),
        glibcFloor: shape.string(GLIBC, 8),
        node: shape.object({ version: shape.string(NODE_VERSION, 16), sha256 }),
        archive: asset,
        fileManifestSha256: sha256,
    }), { min: 1, max: RELEASE_TARGETS.length, key: entry => entry.target }),
    installer: asset,
    externalPackages: shape.array(shape.object({
        name: shape.string(NPM_NAME, 214),
        version: shape.string(NPM_VERSION, 128),
        integrity: shape.string(SRI_SHA512, 95),
        tarballUrl: shape.string(null, 1024),
        installPath: shape.string(RELATIVE_PATH, 512),
        target: shape.oneOf(RELEASE_TARGETS),
    }, ['target']), { max: 64, key: entry => `${entry.name}\u0000${entry.target ?? '*'}` }),
    sigstoreTrustedRootSha256: sha256,
    revokedVersions: shape.array(version, { max: 256, key: entry => entry }),
    database: shape.object({
        migrationClass: shape.oneOf(MIGRATION_CLASSES),
        readableBy: shape.array(version, { max: 64, key: entry => entry }),
    }),
});

/**
 * Validate a manifest object: exact shape, then cross-field rules. Throws a
 * ReleaseManifestError (`manifest_invalid`, `external_package_host_refused`).
 * @param {unknown} manifest parsed JSON value
 * @returns {object} the same value
 */
export function validateReleaseManifest(manifest) {
    assertShape(MANIFEST_SHAPE, manifest, 'manifest', CODES.MANIFEST_INVALID);
    assertSourceRef(manifest);
    assertVersionRelations(manifest);
    assertAssetNamesDistinct(manifest);
    manifest.externalPackages.forEach((entry, index) => assertExternalPackage(manifest, entry, index));
    return manifest;
}

function assertSourceRef(manifest) {
    if (manifest.source.ref !== `refs/tags/v${manifest.version}`) {
        failRelease(CODES.MANIFEST_INVALID, 'manifest.source.ref must be refs/tags/v<version>');
    }
}

function assertVersionRelations(manifest) {
    if (compareNassajReleaseVersions(manifest.minUpgradeFrom, manifest.version) > 0) {
        failRelease(CODES.MANIFEST_INVALID, 'manifest.minUpgradeFrom is newer than manifest.version');
    }
    if (manifest.revokedVersions.some(entry => compareNassajReleaseVersions(entry, manifest.version) >= 0)) {
        failRelease(CODES.MANIFEST_INVALID, 'manifest.revokedVersions may only list older versions');
    }
}

function assertAssetNamesDistinct(manifest) {
    const names = [...manifest.targets.map(entry => entry.archive.name), manifest.installer.name];
    const reserved = new Set([RELEASE_MANIFEST_NAME, RELEASE_BUNDLE_NAME]);
    if (new Set(names).size !== names.length || names.some(name => reserved.has(name))) {
        failRelease(CODES.MANIFEST_INVALID, 'manifest asset names must be distinct and not reserved');
    }
}

function assertExternalPackage(manifest, entry, index) {
    const where = `manifest.externalPackages[${index}]`;
    if (entry.target !== undefined && !manifest.targets.some(target => target.target === entry.target)) {
        failRelease(CODES.MANIFEST_INVALID, `${where}.target is not a manifest target`);
    }
    if (!entry.installPath.startsWith('node_modules/')) {
        failRelease(CODES.MANIFEST_INVALID, `${where}.installPath must be under node_modules/`);
    }
    assertRegistryTarball(entry, where);
}

/** §6.2: the tarball must come from registry.npmjs.org, by the package's own path. */
function assertRegistryTarball(entry, where) {
    let url;
    try { url = new URL(entry.tarballUrl); } catch { url = null; }
    const clean = url && url.origin === NPM_REGISTRY_ORIGIN && url.protocol === 'https:'
        && !url.username && !url.password && !url.search && !url.hash
        && entry.tarballUrl.startsWith(`${NPM_REGISTRY_ORIGIN}/`);
    if (!clean) failRelease(CODES.EXTERNAL_PACKAGE_HOST_REFUSED, `${where}.tarballUrl is not on the npm registry`);
    if (!url.pathname.startsWith(`/${entry.name}/-/`) || !url.pathname.endsWith('.tgz')) {
        failRelease(CODES.MANIFEST_INVALID, `${where}.tarballUrl does not name the package tarball`);
    }
}

/**
 * Parse exact manifest bytes (§7.4 rule 0 then schema). Order: size cap,
 * UTF-8, JSON, schema generation, strict shape, canonical bytes.
 * @param {Uint8Array} bytes exact fetched bytes (the attested subject)
 * @param {{maxBytes?: number}} [options]
 * @returns {{manifest: object, sha256: string, size: number}} frozen manifest and its digest
 */
export function parseReleaseManifest(bytes, { maxBytes = RELEASE_MANIFEST_MAX_BYTES } = {}) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('manifest bytes must be a Uint8Array');
    if (bytes.byteLength > maxBytes) failRelease(CODES.METADATA_OVERSIZE, 'manifest exceeds the size cap');
    const text = decodeUtf8(bytes);
    const value = parseJson(text);
    assertKnownSchema(value);
    validateReleaseManifest(value);
    if (`${canonicalJson(value)}\n` !== text) failRelease(CODES.MANIFEST_INVALID, 'manifest bytes are not canonical');
    const digest = createHash('sha256').update(bytes).digest('hex');
    return { manifest: deepFreeze(value), sha256: digest, size: bytes.byteLength };
}

function decodeUtf8(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return failRelease(CODES.MANIFEST_INVALID, 'manifest is not valid UTF-8');
    }
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return failRelease(CODES.MANIFEST_INVALID, 'manifest is not valid JSON');
    }
}

/** A newer, well-formed schema id means this verifier is too old (§5.2 b). */
function assertKnownSchema(value) {
    const schema = isPlainObject(value) ? value.schema : undefined;
    if (schema === RELEASE_MANIFEST_SCHEMA) return;
    if (typeof schema === 'string' && FUTURE_SCHEMA.test(schema)) {
        failRelease(CODES.VERIFIER_TOO_OLD, 'manifest schema is newer than this verifier');
    }
    failRelease(CODES.MANIFEST_INVALID, 'manifest.schema is not a release manifest schema');
}

/**
 * Producer side: validate then emit the canonical bytes that
 * parseReleaseManifest accepts. The shape caps keep any valid manifest far
 * below RELEASE_MANIFEST_MAX_BYTES.
 * @param {object} manifest manifest object
 * @returns {Buffer} canonical UTF-8 bytes with one trailing newline
 */
export function serializeReleaseManifest(manifest) {
    validateReleaseManifest(manifest);
    return Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
}
