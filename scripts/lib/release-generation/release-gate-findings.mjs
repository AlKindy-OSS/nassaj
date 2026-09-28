/**
 * Stable finding codes for the release license gate and the exclusion checks
 * (ADR-174 §6.2, §6.5, §16 P1 exits 8, 9, 11). A finding is data, not an
 * exception: the gate collects every finding so one run reports the whole
 * closure, then fails closed if any error-level finding exists.
 */
export const GATE_CODES = Object.freeze({
    POLICY_INVALID: 'license_policy_invalid',
    LOCKFILE_UNSUPPORTED: 'lockfile_unsupported',
    LOCKFILE_INTEGRITY_MISSING: 'lockfile_integrity_missing',
    LOCKFILE_RESOLVED_OFF_REGISTRY: 'lockfile_resolved_off_registry',
    PLATFORM_REQUIRED_MISMATCH: 'platform_required_mismatch',
    EXCLUDED_FAMILY_UNLISTED: 'excluded_family_unlisted',
    EXCLUDED_PACKAGE_REQUIRED: 'excluded_package_required',
    EXCLUDED_PACKAGE_SHIPPED: 'excluded_package_shipped',
    EXCLUDED_REFERENCE_IN_SCRIPT: 'excluded_reference_in_script',
    TREE_PACKAGE_UNEXPECTED: 'tree_package_unexpected',
    PACKAGE_NOT_INSTALLED: 'package_not_installed',
    PACKAGE_IDENTITY_MISMATCH: 'package_identity_mismatch',
    LICENSE_MISSING: 'license_missing',
    LICENSE_SEE_FILE: 'license_see_file',
    LICENSE_UNLICENSED: 'license_unlicensed',
    LICENSE_UNPARSEABLE: 'license_unparseable',
    LICENSE_DENIED: 'license_denied',
    LICENSE_NOT_ALLOWLISTED: 'license_not_allowlisted',
    LICENSE_MISMATCH: 'license_mismatch',
    LICENSE_FILE_MISSING: 'license_file_missing',
    LICENSE_TEXT_INVALID: 'license_text_invalid',
    OVERRIDE_CONFLICT: 'license_override_conflict',
    OVERRIDE_INVALID: 'license_override_invalid',
    SUPPLIED_TEXT_TAMPERED: 'license_supplied_text_tampered',
});

/** Warning codes: reported, never blocking. */
export const GATE_WARNINGS = Object.freeze({
    OVERRIDE_UNUSED: 'license_override_unused',
    EXCLUSION_ABSENT: 'exclusion_absent_from_lockfile',
});

/**
 * Build a finding record.
 * @param {string} code one of GATE_CODES / GATE_WARNINGS
 * @param {string} subject package path or file the finding is about
 * @param {string} detail short, non-secret explanation
 * @returns {{code: string, subject: string, detail: string}}
 */
export function finding(code, subject, detail) {
    return { code, subject, detail };
}

/** Deterministic order for reports: by subject, then code, then detail. */
export function sortFindings(findings) {
    return [...findings].sort((a, b) => compareText(a.subject, b.subject)
        || compareText(a.code, b.code) || compareText(a.detail, b.detail));
}

/** Code-unit string comparison, locale-independent (deterministic output). */
export function compareText(a, b) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
}
