/**
 * Stable reason codes for the attested release-generation manifest and sequence
 * rules (ADR-174 §7.4, §14). Codes that the design names are used verbatim;
 * `manifest_invalid`, `trust_state_missing` and `trust_state_invalid` are the
 * module's own codes for cases the design leaves unnamed (malformed attested
 * manifest, missing or corrupt `control/trust-state.json`). Every one of them
 * fails closed.
 */
export const RELEASE_MANIFEST_CODES = Object.freeze({
    METADATA_OVERSIZE: 'metadata_oversize',
    MANIFEST_INVALID: 'manifest_invalid',
    MANIFEST_NOT_ATTESTED: 'manifest_not_attested',
    ARTIFACT_DIGEST_MISMATCH: 'artifact_digest_mismatch',
    EXTERNAL_PACKAGE_HOST_REFUSED: 'external_package_host_refused',
    CHANNEL_MISMATCH: 'channel_mismatch',
    RELEASE_ROLLBACK_REFUSED: 'release_rollback_refused',
    RELEASE_VERSION_NOT_NEWER: 'release_version_not_newer',
    UPGRADE_PATH_REQUIRED: 'upgrade_path_required',
    VERIFIER_TOO_OLD: 'verifier_too_old',
    SHIM_UPDATE_REQUIRED: 'shim_update_required',
    TRUST_STATE_MISSING: 'trust_state_missing',
    TRUST_STATE_INVALID: 'trust_state_invalid',
});

/** Warning codes: reported, never blocking (ADR-174 §7.4 rule 9, §14). */
export const RELEASE_MANIFEST_WARNINGS = Object.freeze({
    CURRENT_RELEASE_REVOKED: 'current_release_revoked',
});

/** Error carrying a stable `code` plus a non-secret human `detail`. */
export class ReleaseManifestError extends Error {
    /**
     * @param {string} code one of RELEASE_MANIFEST_CODES
     * @param {string} detail short diagnostic (paths and field names only, never secrets)
     */
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.name = 'ReleaseManifestError';
        this.code = code;
        this.detail = detail;
    }
}

/**
 * Throw a ReleaseManifestError.
 * @param {string} code stable reason code
 * @param {string} detail diagnostic text
 * @returns {never}
 */
export function failRelease(code, detail) {
    throw new ReleaseManifestError(code, detail);
}
