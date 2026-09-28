/**
 * Release freshness and anti-rollback rules (ADR-174 §7.4 rules 5–10, §7.6,
 * §7.7 F4) and the node's monotonic trust state `control/trust-state.json`.
 *
 * The trust state is service-owned and protects only against a *remote*
 * rollback (R4): the service account can rewrite it. Integrity here means
 * corruption detection, and every unreadable state fails closed.
 *
 * Callers must hold the update writer lease around read → decide → write;
 * this module does not lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { compareNassajReleaseVersions } from '../../../shared/release-version-policy.js';
import {
    RELEASE_MANIFEST_CODES as CODES, RELEASE_MANIFEST_WARNINGS as WARNINGS, failRelease, ReleaseManifestError,
} from './release-manifest-codes.mjs';
import { RELEASE_CHANNELS, validateReleaseManifest } from './release-manifest.mjs';
import { assertShape, canonicalJson, deepFreeze, shape } from './strict-shape.mjs';

export const TRUST_STATE_SCHEMA = 'nassaj-release-trust-state/v1';
export const TRUST_STATE_MAX_BYTES = 4096;

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const TRUST_STATE_SHAPE = shape.object({
    schema: shape.oneOf([TRUST_STATE_SCHEMA]),
    installedVersion: shape.nullable(shape.string(VERSION, 64)),
    installedSequence: shape.integer(0),
    minReleaseSequence: shape.integer(1),
    lastVerifiedAt: shape.nullable(shape.string(ISO_UTC, 24)),
    integrity: shape.string(/^[0-9a-f]{64}$/, 64),
});

/** sha256 of the canonical state without its `integrity` field. */
function stateIntegrity(state) {
    const { integrity: _ignored, ...body } = state;
    return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function sealState(body) {
    const state = { schema: TRUST_STATE_SCHEMA, ...body };
    return assertTrustState({ ...state, integrity: stateIntegrity(state) });
}

/**
 * Strictly validate a trust state (shape, invariants, integrity). Fails closed
 * with `trust_state_invalid`.
 * @param {unknown} state candidate state
 * @returns {object} the frozen state
 */
export function assertTrustState(state) {
    assertShape(TRUST_STATE_SHAPE, state, 'trustState', CODES.TRUST_STATE_INVALID);
    const installed = state.installedVersion !== null;
    if (installed !== (state.installedSequence > 0)) {
        failRelease(CODES.TRUST_STATE_INVALID, 'installedVersion and installedSequence disagree');
    }
    if (installed && state.installedSequence < state.minReleaseSequence) {
        failRelease(CODES.TRUST_STATE_INVALID, 'installedSequence is below the installer floor');
    }
    if (state.lastVerifiedAt !== null && Number.isNaN(Date.parse(state.lastVerifiedAt))) {
        failRelease(CODES.TRUST_STATE_INVALID, 'lastVerifiedAt is not a valid time');
    }
    if (state.integrity !== stateIntegrity(state)) failRelease(CODES.TRUST_STATE_INVALID, 'integrity mismatch');
    return deepFreeze(state);
}

/**
 * Installer seed (§7.7 F4): nothing installed yet, floor = the installer's own
 * release sequence.
 * @param {{minReleaseSequence: number}} options
 * @returns {object} sealed trust state
 */
export function seedTrustState({ minReleaseSequence }) {
    return sealState({ installedVersion: null, installedSequence: 0, minReleaseSequence, lastVerifiedAt: null });
}

/**
 * A sealed state for a node that runs `installedVersion` (pipeline fleet
 * simulation and tests; a real node reads its own control/trust-state.json).
 * @param {{installedVersion: string, installedSequence: number, minReleaseSequence?: number,
 *   lastVerifiedAt?: string|null}} input floor defaults to the installed sequence
 * @returns {object} sealed trust state
 */
export function installedTrustState({ installedVersion, installedSequence, minReleaseSequence = installedSequence,
    lastVerifiedAt = null }) {
    return sealState({ installedVersion, installedSequence, minReleaseSequence, lastVerifiedAt });
}

/**
 * Decide a verified candidate manifest against the node's trust state
 * (§7.4 rules 5–10, applied after attestation, statement and subject checks).
 * A valid attestation never overrides a refusal here.
 * @param {object} input
 * @param {object} input.trustState persisted trust state
 * @param {string} input.channel channel pinned in the trust anchor (policy.json)
 * @param {object} input.manifest validated candidate manifest
 * @param {number} input.verifierVersion running verifier's version (§5.2 b)
 * @param {number} input.shimVersion installed shim version (§5.2 c)
 * @returns {{verdict: 'accept'|'noop'|'reject', code: string|null, warnings: string[], requiredVersion?: string}}
 */
export function decideReleaseCandidate({ trustState, channel, manifest, verifierVersion, shimVersion }) {
    assertTrustState(trustState);
    validateReleaseManifest(manifest);
    if (!RELEASE_CHANNELS.includes(channel)) throw new TypeError('channel must be a release channel');
    assertPositiveInteger(verifierVersion, 'verifierVersion');
    assertPositiveInteger(shimVersion, 'shimVersion');
    if (manifest.channel !== channel) return verdict('reject', CODES.CHANNEL_MISMATCH, []);
    const warnings = revocationWarnings(trustState, manifest);
    const freshness = freshnessCode(trustState, manifest);
    if (freshness) return { ...verdict(freshness.verdict, freshness.code, warnings), ...freshness.extra };
    if (manifest.minVerifierVersion > verifierVersion) return verdict('reject', CODES.VERIFIER_TOO_OLD, warnings);
    if (manifest.minShimVersion > shimVersion) return verdict('reject', CODES.SHIM_UPDATE_REQUIRED, warnings);
    return verdict('accept', null, warnings);
}

function verdict(kind, code, warnings) {
    return { verdict: kind, code, warnings };
}

function assertPositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
}

/** Rules 6, 7, 10. Returns null when the candidate is strictly newer and reachable. */
function freshnessCode(state, manifest) {
    const reject = code => ({ verdict: 'reject', code });
    if (manifest.releaseSequence < state.minReleaseSequence) return reject(CODES.RELEASE_ROLLBACK_REFUSED);
    if (state.installedVersion === null) return null;
    const versionOrder = compareNassajReleaseVersions(manifest.version, state.installedVersion);
    if (manifest.releaseSequence === state.installedSequence && versionOrder === 0) {
        return { verdict: 'noop', code: null };
    }
    if (manifest.releaseSequence <= state.installedSequence) return reject(CODES.RELEASE_ROLLBACK_REFUSED);
    if (versionOrder <= 0) return reject(CODES.RELEASE_VERSION_NOT_NEWER);
    if (compareNassajReleaseVersions(manifest.minUpgradeFrom, state.installedVersion) > 0) {
        return { ...reject(CODES.UPGRADE_PATH_REQUIRED), extra: { requiredVersion: manifest.minUpgradeFrom } };
    }
    return null;
}

/** Rule 9: a newer verified manifest that lists the installed version warns. */
function revocationWarnings(state, manifest) {
    const newer = manifest.releaseSequence > state.installedSequence;
    const listed = state.installedVersion !== null && manifest.revokedVersions.includes(state.installedVersion);
    return newer && listed ? [WARNINGS.CURRENT_RELEASE_REVOKED] : [];
}

/**
 * Trust state after activating an accepted candidate. Re-checks monotonicity
 * so a caller cannot record a rollback even without calling decide first.
 * Re-applying the installed release (same version and sequence) is a no-op
 * that returns the current state unchanged, not a rollback.
 * @param {object} state current trust state
 * @param {object} manifest accepted manifest
 * @param {{attestedAt: string}} options trusted attestation time (ISO UTC, ms precision)
 * @returns {object} sealed next state
 */
export function advanceTrustState(state, manifest, { attestedAt }) {
    assertTrustState(state);
    validateReleaseManifest(manifest);
    const blocked = freshnessCode(state, manifest);
    if (blocked?.verdict === 'noop') return state;
    if (blocked) failRelease(blocked.code, 'candidate is not strictly newer');
    return sealState({
        installedVersion: manifest.version,
        installedSequence: manifest.releaseSequence,
        minReleaseSequence: state.minReleaseSequence,
        lastVerifiedAt: attestedAt,
    });
}

/**
 * Read `control/trust-state.json`. Missing → `trust_state_missing`; symlink,
 * non-file, oversize, bad UTF-8/JSON, non-canonical bytes, bad shape or
 * integrity → `trust_state_invalid`. Never returns a partial state.
 * @param {string} file absolute path
 * @returns {object} frozen trust state
 */
export function readTrustState(file) {
    const text = readBoundedText(file);
    let value;
    try { value = JSON.parse(text); } catch { failRelease(CODES.TRUST_STATE_INVALID, 'trust state is not JSON'); }
    const state = assertTrustState(value);
    if (`${canonicalJson(state)}\n` !== text) failRelease(CODES.TRUST_STATE_INVALID, 'trust state is not canonical');
    return state;
}

function readBoundedText(file) {
    let fd;
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > TRUST_STATE_MAX_BYTES) failRelease(CODES.TRUST_STATE_INVALID, 'unsafe file');
        const bytes = fs.readFileSync(fd);
        if (bytes.byteLength > TRUST_STATE_MAX_BYTES) failRelease(CODES.TRUST_STATE_INVALID, 'unsafe file');
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
        throw mapReadError(error);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function mapReadError(error) {
    if (error instanceof ReleaseManifestError) return error;
    if (error?.code === 'ENOENT') return new ReleaseManifestError(CODES.TRUST_STATE_MISSING, 'trust state is missing');
    if (error instanceof TypeError || error?.code === 'ELOOP') {
        return new ReleaseManifestError(CODES.TRUST_STATE_INVALID, 'trust state is unreadable');
    }
    return error;
}

/**
 * Durably write the next trust state: validate, refuse any regression against
 * the state on disk, then tmp (0600, O_EXCL) → write → fsync → rename → fsync dir.
 * A missing file is allowed (installer seed); a corrupt one fails closed.
 * Rewriting an identical state is an idempotent no-op retry.
 * @param {string} file absolute path of control/trust-state.json
 * @param {object} next sealed state from seedTrustState/advanceTrustState
 */
export function writeTrustState(file, next) {
    assertTrustState(next);
    const current = readExistingState(file);
    if (current) assertMonotonicSuccessor(current, next);
    writeFileDurably(file, `${canonicalJson(next)}\n`);
}

function readExistingState(file) {
    try {
        return readTrustState(file);
    } catch (error) {
        if (error.code === CODES.TRUST_STATE_MISSING) return null;
        throw error;
    }
}

function assertMonotonicSuccessor(current, next) {
    if (canonicalJson(current) === canonicalJson(next)) return;
    const advances = next.installedSequence > current.installedSequence;
    const floorKept = next.minReleaseSequence >= current.minReleaseSequence;
    if (!advances || !floorKept) {
        failRelease(CODES.RELEASE_ROLLBACK_REFUSED, 'trust state may only move forward');
    }
    if (current.installedVersion !== null && compareNassajReleaseVersions(next.installedVersion, current.installedVersion) <= 0) {
        failRelease(CODES.RELEASE_VERSION_NOT_NEWER, 'trust state version may only move forward');
    }
}

function writeFileDurably(file, text) {
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
        try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
    const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
