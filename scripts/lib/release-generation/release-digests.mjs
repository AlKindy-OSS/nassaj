/**
 * Canonical sha256 helpers binding fetched bytes to the manifest and to the
 * attestation subjects (ADR-174 §7.4 rule 4). The node uses no asset that is
 * not in both the manifest and the subject list, with equal digests.
 *
 * Digests are lowercase 64-hex everywhere; any other spelling is refused
 * rather than normalised, so one digest has one representation.
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { RELEASE_MANIFEST_CODES as CODES, failRelease } from './release-manifest-codes.mjs';
import { RELEASE_MANIFEST_NAME } from './release-manifest.mjs';
import { isPlainObject } from './strict-shape.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const READ_CHUNK = 1024 * 1024;

/**
 * Lowercase hex sha256 of bytes.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Normalise in-toto subjects `[{ name, digest: { sha256 } }]` into a name →
 * digest map. A malformed list, a non-canonical digest or one name bound to
 * two digests is refused (`manifest_not_attested`): the attestation must say
 * one thing per asset.
 * @param {unknown} subjects statement subjects from the verified attestation
 * @returns {Map<string, string>}
 */
export function subjectDigestMap(subjects) {
    if (!Array.isArray(subjects) || subjects.length === 0) {
        failRelease(CODES.MANIFEST_NOT_ATTESTED, 'attestation has no subjects');
    }
    const map = new Map();
    for (const subject of subjects) {
        const digest = isPlainObject(subject) && isPlainObject(subject.digest) ? subject.digest.sha256 : undefined;
        if (typeof subject?.name !== 'string' || typeof digest !== 'string' || !HEX64.test(digest)) {
            failRelease(CODES.MANIFEST_NOT_ATTESTED, 'attestation subject is malformed');
        }
        if (map.has(subject.name) && map.get(subject.name) !== digest) {
            failRelease(CODES.MANIFEST_NOT_ATTESTED, 'attestation binds one name to two digests');
        }
        map.set(subject.name, digest);
    }
    return map;
}

/**
 * Rule 4 (first half): the sha256 of the exact fetched manifest bytes must be
 * the `release-manifest.json` subject.
 * @param {string} manifestSha256 digest returned by parseReleaseManifest
 * @param {unknown} subjects statement subjects
 */
export function assertManifestAttested(manifestSha256, subjects) {
    const attested = subjectDigestMap(subjects).get(RELEASE_MANIFEST_NAME);
    if (!HEX64.test(manifestSha256 ?? '') || attested !== manifestSha256) {
        failRelease(CODES.MANIFEST_NOT_ATTESTED, 'manifest digest is not an attestation subject');
    }
}

/**
 * The manifest entry (`{ name, size, sha256 }`) for a release asset: a target
 * archive or the installer. Unknown names → `artifact_digest_mismatch`.
 * @param {object} manifest validated manifest
 * @param {string} name asset file name
 * @returns {{name: string, size: number, sha256: string}}
 */
export function manifestAssetEntry(manifest, name) {
    const entries = [...manifest.targets.map(entry => entry.archive), manifest.installer];
    const entry = entries.find(candidate => candidate.name === name);
    if (!entry) failRelease(CODES.ARTIFACT_DIGEST_MISMATCH, 'asset is not listed in the manifest');
    return entry;
}

/**
 * Rule 4 (second half): observed size and digest == manifest entry == subject.
 * @param {object} input
 * @param {object} input.manifest validated manifest
 * @param {unknown} input.subjects statement subjects
 * @param {string} input.name asset file name
 * @param {{size: number, sha256: string}} input.observed measured bytes
 * @returns {{name: string, size: number, sha256: string}} the matched entry
 */
export function assertAssetDigest({ manifest, subjects, name, observed }) {
    const entry = manifestAssetEntry(manifest, name);
    const subjectDigest = subjectDigestMap(subjects).get(name);
    if (subjectDigest !== entry.sha256) {
        failRelease(CODES.ARTIFACT_DIGEST_MISMATCH, 'manifest digest is not the attested subject digest');
    }
    if (observed?.size !== entry.size || observed?.sha256 !== entry.sha256) {
        failRelease(CODES.ARTIFACT_DIGEST_MISMATCH, 'downloaded asset does not match the manifest');
    }
    return entry;
}

/**
 * Stream-hash a regular file without following a final symlink, stopping as
 * soon as it exceeds `maxBytes` (then `artifact_digest_mismatch`).
 * @param {string} file absolute path
 * @param {{maxBytes?: number}} [options]
 * @returns {{size: number, sha256: string}}
 */
export function hashFile(file, { maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
    const fd = openAssetNoFollow(file);
    try {
        if (!fs.fstatSync(fd).isFile()) failRelease(CODES.ARTIFACT_DIGEST_MISMATCH, 'asset is not a regular file');
        return hashDescriptor(fd, maxBytes);
    } finally {
        fs.closeSync(fd);
    }
}

function openAssetNoFollow(file) {
    try {
        return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
        if (error?.code === 'ELOOP') failRelease(CODES.ARTIFACT_DIGEST_MISMATCH, 'asset is a symlink');
        throw error;
    }
}

function hashDescriptor(fd, maxBytes) {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    let size = 0;
    for (let read = fs.readSync(fd, buffer); read > 0; read = fs.readSync(fd, buffer)) {
        size += read;
        if (size > maxBytes) failRelease(CODES.ARTIFACT_DIGEST_MISMATCH, 'asset is larger than the manifest size');
        hash.update(buffer.subarray(0, read));
    }
    return { size, sha256: hash.digest('hex') };
}

/**
 * Hash a downloaded asset file and bind it to manifest and subjects.
 * @param {object} input
 * @param {object} input.manifest validated manifest
 * @param {unknown} input.subjects statement subjects
 * @param {string} input.name asset file name
 * @param {string} input.file absolute path of the downloaded file
 * @returns {{name: string, size: number, sha256: string}} the matched entry
 */
export function verifyAssetFile({ manifest, subjects, name, file }) {
    const entry = manifestAssetEntry(manifest, name);
    const observed = hashFile(file, { maxBytes: entry.size });
    return assertAssetDigest({ manifest, subjects, name, observed });
}
