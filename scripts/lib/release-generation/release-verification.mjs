/**
 * Full node-side verification of one release generation (ADR-174 §7.4
 * rules 0–10, §5.2 b), composed once so the node (Phase 2), the installer,
 * the standalone CLI and the release pipeline all run the same order:
 *
 *   0    size caps before any parse (attestation-verifier verifyRelease);
 *   0'   strict manifest schema; a newer schema or a higher
 *        `minVerifierVersion` than VERIFIER_VERSION → `verifier_too_old`
 *        (§5.2 b: refuse cleanly before reading a format we may misparse);
 *   0a–3 runtime, bundle, tlog/time, library crypto, identity, statement;
 *   4    manifest bytes are a subject, then (when given) every downloaded
 *        asset equals its manifest entry and is a subject;
 *   5–10 channel, freshness/rollback, upgrade path, verifier/shim versions,
 *        revocation warning, installer floor (release-sequence decide).
 *
 * Offline and bundled into the standalone verifier with its dependencies.
 */
import { ATTESTATION_CODES, verifyArtifactDigests, verifyRelease } from './attestation-verifier.mjs';
import { RELEASE_MANIFEST_CODES, ReleaseManifestError, failRelease } from './release-manifest-codes.mjs';
import { parseReleaseManifest } from './release-manifest.mjs';
import { decideReleaseCandidate, seedTrustState } from './release-sequence.mjs';

/**
 * Version of this verifier. Raise it with any change a previous verifier
 * could misread; producers then set manifest.minVerifierVersion (§5.2).
 */
export const VERIFIER_VERSION = 1;

/** Every stable code verification may produce (design §14). */
export const VERIFICATION_CODES = Object.freeze(new Set([
    ...Object.values(ATTESTATION_CODES), ...Object.values(RELEASE_MANIFEST_CODES),
]));

/**
 * Strict manifest reader for verifyRelease: full schema (§7.3) plus the
 * verifier-version gate (§5.2 b).
 * @param {Uint8Array} bytes exact manifest bytes
 * @param {{verifierVersion?: number}} [options]
 * @returns {Readonly<{version: string, sourceCommit: string, manifest: object}>}
 */
export function readReleaseManifest(bytes, { verifierVersion = VERIFIER_VERSION } = {}) {
    const { manifest } = parseReleaseManifest(bytes);
    if (manifest.minVerifierVersion > verifierVersion) {
        failRelease(RELEASE_MANIFEST_CODES.VERIFIER_TOO_OLD,
            `manifest needs verifier ${manifest.minVerifierVersion}, this is ${verifierVersion}`);
    }
    return Object.freeze({ version: manifest.version, sourceCommit: manifest.source.commit, manifest });
}

/** Asset name → manifest sha256 for every archive and the installer. */
export function manifestAssets(manifest) {
    const entries = [...manifest.targets.map(target => target.archive), manifest.installer];
    return new Map(entries.map(entry => [entry.name, entry.sha256]));
}

/**
 * §7.4 rule 4 (second half) against the manifest itself: each downloaded
 * asset must be named in the manifest, match its digest and be a subject.
 * @param {{subjects: ReadonlyMap<string, string>}} verified result of verifyRelease
 * @param {object} manifest parsed manifest
 * @param {Array<{name: string, actualSha256: string}>} artifacts
 * @param {{complete?: boolean}} [options] complete: every manifest asset must be present
 * @returns {number} assets verified
 */
export function verifyManifestArtifacts(verified, manifest, artifacts, { complete = false } = {}) {
    const assets = manifestAssets(manifest);
    if (!Array.isArray(artifacts)) failRelease(RELEASE_MANIFEST_CODES.ARTIFACT_DIGEST_MISMATCH, 'artifacts must be a list');
    const named = artifacts.map(artifact => {
        const name = String(artifact?.name);
        if (!assets.has(name)) failRelease(RELEASE_MANIFEST_CODES.ARTIFACT_DIGEST_MISMATCH, `${name} is not in the manifest`);
        return { name, manifestSha256: assets.get(name), actualSha256: artifact.actualSha256 };
    });
    if (complete) {
        const seen = new Set(named.map(artifact => artifact.name));
        const missing = [...assets.keys()].filter(name => !seen.has(name));
        if (missing.length) failRelease(RELEASE_MANIFEST_CODES.ARTIFACT_DIGEST_MISMATCH, `missing ${missing.join(', ')}`);
    }
    return verifyArtifactDigests(verified, named);
}

/**
 * Verify one candidate and decide it against the node's trust state, in the
 * §7.4 order. A valid attestation never overrides a refusing decision.
 * Archives are usually downloaded only after an `accept`; call
 * verifyManifestArtifacts then, or pass `artifacts` when they are at hand.
 * @param {object} input
 * @param {Uint8Array} input.bundleBytes Sigstore bundle asset
 * @param {Uint8Array} input.manifestBytes exact manifest bytes
 * @param {object} input.trustedRoot Sigstore root pinned in the RUNNING generation
 * @param {object} input.policy identity anchor (config/trust/policy.json)
 * @param {object} [input.trustState] node trust state; omitted = nothing installed, floor 1
 * @param {number} [input.shimVersion] installed shim; omitted = shim not evaluated (pipeline)
 * @param {Array<{name: string, actualSha256: string}>|((manifest: object) => Array<object>)} [input.artifacts]
 *   assets to bind (rule 4), or a function of the verified manifest that lists them
 * @param {boolean} [input.completeArtifacts] require every manifest asset in `artifacts`
 * @param {number} [input.verifierVersion] defaults to VERIFIER_VERSION
 * @param {{verify?: typeof verifyRelease}} [deps] test seam for the attestation step
 * @returns {Readonly<{verified: object, manifest: object, artifacts: number,
 *   decision: {verdict: 'accept'|'noop'|'reject', code: string|null, warnings: string[]}}>}
 */
export function verifyAndDecide(input, { verify = verifyRelease } = {}) {
    const verifierVersion = input.verifierVersion ?? VERIFIER_VERSION;
    const verified = verify({
        bundleBytes: input.bundleBytes, manifestBytes: input.manifestBytes, trustedRoot: input.trustedRoot,
        policy: input.policy, readIdentity: bytes => readReleaseManifest(bytes, { verifierVersion }),
    });
    const { manifest } = verified.release;
    const list = typeof input.artifacts === 'function' ? input.artifacts(manifest) : input.artifacts;
    const artifacts = list === undefined ? 0
        : verifyManifestArtifacts(verified, manifest, list, { complete: input.completeArtifacts === true });
    const decision = decideReleaseCandidate({
        trustState: input.trustState ?? seedTrustState({ minReleaseSequence: 1 }),
        channel: input.policy.channel, manifest, verifierVersion,
        shimVersion: input.shimVersion ?? manifest.minShimVersion,
    });
    return Object.freeze({ verified, manifest, artifacts, decision });
}

/**
 * The stable code for any verification failure; anything unrecognised is
 * `attestation_invalid` so no raw library error reaches a caller.
 * @param {unknown} error
 * @returns {string}
 */
export function rejectionCode(error) {
    const code = error?.code;
    const known = typeof code === 'string' && VERIFICATION_CODES.has(code);
    return known ? code : ATTESTATION_CODES.ATTESTATION_INVALID;
}

/** True for errors this module family throws deliberately (safe detail text). */
export function isVerificationError(error) {
    return error instanceof ReleaseManifestError || error?.name === 'AttestationError';
}
