/**
 * vendor-binary-integrity (SL-7 / OCC-15, M-4) — sha256 root-of-trust pin for
 * the vendor CLI binaries nassaj spawns, with a FAIL-CLOSED launch guard.
 *
 * WHY
 * ---
 * Kimi (`@moonshot-ai/kimi-code`) and the GLM carrier (`sst/opencode`) are
 * third-party binaries downloaded from npm/GitHub. OCC-15 cleared their supply
 * chain for the pinned versions ONLY (opencode 1.17.18, kimi-code 0.28.1). A
 * later silent swap — a tampered install, a compromised npm tarball, a
 * PATH-shadowing `opencode` earlier in $PATH — would run un-reviewed code with
 * the vendor's cage/permission ceiling around it. This guard pins the exact
 * sha256 of each approved binary and refuses to hand the path to a spawner when
 * the on-disk bytes deviate.
 *
 * M-4 (qa-critic condition, PROVEN from code): the digest is verified AFTER the
 * FINAL path is resolved — i.e. AFTER `OPENCODE_PATH` override, the standard
 * install location, and the bare-`opencode` PATH fallback (and, for kimi, its
 * own resolver). Verifying a hard-coded path instead would let an operator route
 * around the pin with an env var. So `verifyVendorBinaryDigest` takes the
 * already-resolved path, and — for a bare command name — resolves it through
 * $PATH itself before hashing, so the PATH-fallback branch is covered too.
 *
 * BACKWARD COMPATIBILITY / OPT-IN
 * -------------------------------
 * The guard is gated behind `NASSAJ_VENDOR_BINARY_PIN` (default OFF), mirroring
 * the fleet-flag posture of NASSAJ_OPENCODE_CARRIER / KIMI_ALLOW_* (owner
 * decision, plan §7.2). When the flag is OFF the guard is a strict no-op: it
 * does NOT hash, does NOT throw, and returns the path unchanged, so the live
 * opencode path keeps working byte-for-byte. When the flag is ON and the digest
 * MATCHES the pin, the path is likewise returned unchanged. Only an ENABLED
 * guard facing a MISMATCH — or a state it cannot verify — refuses the spawn.
 *
 * FAIL-CLOSED on the unverifiable case (deliberate, per docker-sock-guard
 * precedent): once ENABLED, a binary that cannot be located or read is treated
 * exactly like a mismatch — an un-hashable binary is indistinguishable from a
 * tampered one at launch time. When DISABLED, nothing is checked at all.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Root-of-trust digests. These are the ONLY approved bytes for each vendor
 * binary (OCC-15 / KG-1, ADR-062). A version bump is a documented procedure:
 * re-verify the digest against GitHub/npm, then raise the pin here AND in the
 * ADR — never edit one without the other.
 *
 * @type {Readonly<Record<string, { version: string, artifact: string, sha256: string }>>}
 */
export const PINNED_VENDOR_DIGESTS = Object.freeze({
  // sst/opencode 1.17.18 — byte-for-byte with the official release (OCC-15 §1.3).
  opencode: Object.freeze({
    version: '1.17.18',
    artifact: 'opencode',
    sha256: '0cbfb6de55aa4ce3c74da12d8516376033693a88abca6238c5be32bf98130636',
  }),
  // @moonshot-ai/kimi-code 0.28.1 — the bundled dist/main.mjs entrypoint (KG-1 §1.1).
  kimi: Object.freeze({
    version: '0.28.1',
    artifact: 'dist/main.mjs',
    sha256: '46a0095fa08385027e2e2d02d3c3ee274ecc2094f136dc745910bd72273f7763',
  }),
});

/** Env flag that ARMS the pin. Default OFF for literal opencode back-compat. */
export const VENDOR_BINARY_PIN_FLAG = 'NASSAJ_VENDOR_BINARY_PIN';

/**
 * Typed refusal so callers/tests assert without string matching. Thrown ONLY
 * when the guard is armed AND the binary fails verification (mismatch or
 * unverifiable). Carries the vendor id and the resolved path for the log line.
 */
export class VendorBinaryIntegrityError extends Error {
  /**
   * @param {string} message
   * @param {{ vendorId?: string, resolvedPath?: string|null,
   *           expected?: string|null, actual?: string|null,
   *           reason?: 'mismatch'|'unverifiable' }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'VendorBinaryIntegrityError';
    this.vendorId = details.vendorId ?? null;
    this.resolvedPath = details.resolvedPath ?? null;
    this.expected = details.expected ?? null;
    this.actual = details.actual ?? null;
    this.reason = details.reason ?? 'mismatch';
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} whether the pin guard is armed (`1`/`true`, case-insensitive)
 */
export function isVendorBinaryPinEnabled(env = process.env) {
  const raw = env?.[VENDOR_BINARY_PIN_FLAG];
  if (typeof raw !== 'string') {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Resolves a spawn target to an absolute, readable file so it can be hashed.
 *
 * A resolved path that already contains a separator (absolute, or the standard
 * install location) is used verbatim. A BARE command name (`opencode`, `kimi`)
 * — the PATH-fallback branch of the resolver — is walked through $PATH here so
 * the pin covers exactly the binary the OS would exec. Returns null when the
 * target cannot be located as a regular file (caller decides the fail-closed
 * response based on whether the guard is armed).
 *
 * @param {string} binaryPath already-resolved spawn target (may be bare)
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null} absolute-ish readable file path, or null
 */
export function resolveExecutableForHashing(binaryPath, env = process.env) {
  if (typeof binaryPath !== 'string' || binaryPath.trim() === '') {
    return null;
  }
  const target = binaryPath.trim();

  const looksLikePath = path.isAbsolute(target)
    || target.includes(path.posix.sep)
    || target.includes(path.win32.sep);

  if (looksLikePath) {
    try {
      return fs.statSync(target).isFile() ? target : null;
    } catch {
      return null;
    }
  }

  // Bare command name — resolve through $PATH exactly like exec would (covers
  // the PATH-fallback branch of resolveOpenCodeBinaryPath, per M-4).
  const pathEntries = (env?.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = path.join(dir, target);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not in this PATH entry; keep scanning.
    }
  }
  return null;
}

/**
 * Streams a file through sha256 and returns the lowercase hex digest.
 * @param {string} filePath absolute/readable path
 * @returns {string} hex sha256
 */
export function computeFileSha256(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Verifies the on-disk bytes of an ALREADY-RESOLVED vendor binary against the
 * root-of-trust pin, and returns the path for convenient chaining
 * (`spawn(verifyVendorBinaryDigest(id, resolveX()), ...)`).
 *
 * Contract:
 *   - guard DISABLED (flag off, no explicit override) → NO-OP: returns
 *     `binaryPath` unchanged, no hashing, never throws (literal back-compat);
 *   - guard ENABLED + no pin registered for `vendorId` → NO-OP pass-through
 *     (an un-pinned vendor is out of this guard's mandate);
 *   - guard ENABLED + binary hashes to the pin → returns `binaryPath`;
 *   - guard ENABLED + MISMATCH → throws VendorBinaryIntegrityError (spawn is
 *     refused because the caller never receives a path);
 *   - guard ENABLED + UNVERIFIABLE (cannot locate/read the binary) → throws
 *     (fail-closed: un-hashable is treated as tampered).
 *
 * @param {string} vendorId e.g. 'opencode' | 'kimi'
 * @param {string} binaryPath the FINAL resolved spawn target (post-override/PATH)
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {boolean} [deps.enforced] explicit arm/disarm override (else read the flag)
 * @param {Record<string, { sha256: string }>} [deps.pins] digest table (tests)
 * @param {(p: string, env: NodeJS.ProcessEnv) => string|null} [deps.resolveExecutable]
 * @param {(p: string) => string} [deps.hashFile]
 * @param {(msg: string) => void} [deps.logError]
 * @returns {string} `binaryPath`, unchanged, when verification passes or is skipped
 * @throws {VendorBinaryIntegrityError} when armed and verification fails
 */
export function verifyVendorBinaryDigest(vendorId, binaryPath, deps = {}) {
  const {
    env = process.env,
    pins = PINNED_VENDOR_DIGESTS,
    resolveExecutable = resolveExecutableForHashing,
    hashFile = computeFileSha256,
    logError = console.error,
  } = deps;

  const enforced = typeof deps.enforced === 'boolean'
    ? deps.enforced
    : isVendorBinaryPinEnabled(env);

  // DISABLED → strict no-op. This is the branch that keeps live opencode
  // byte-for-byte unchanged when the flag is off.
  if (!enforced) {
    return binaryPath;
  }

  const pin = pins?.[vendorId];
  if (!pin || typeof pin.sha256 !== 'string' || pin.sha256.trim() === '') {
    // No root-of-trust entry for this vendor → nothing to enforce.
    return binaryPath;
  }
  const expected = pin.sha256.trim().toLowerCase();

  const resolvedPath = resolveExecutable(binaryPath, env);
  if (!resolvedPath) {
    const message = buildRefusalMessage(vendorId, binaryPath, {
      reason: 'unverifiable',
      detail: `cannot locate a readable binary for spawn target "${binaryPath}" — `
        + 'an un-hashable binary is treated as tampered (fail-closed)',
    });
    logError(message);
    throw new VendorBinaryIntegrityError(message, {
      vendorId,
      resolvedPath: null,
      expected,
      actual: null,
      reason: 'unverifiable',
    });
  }

  let actual;
  try {
    actual = hashFile(resolvedPath).trim().toLowerCase();
  } catch (err) {
    const message = buildRefusalMessage(vendorId, resolvedPath, {
      reason: 'unverifiable',
      detail: `failed to hash "${resolvedPath}" (${err?.code || err?.message || 'unknown error'}) `
        + '— treated as tampered (fail-closed)',
    });
    logError(message);
    throw new VendorBinaryIntegrityError(message, {
      vendorId,
      resolvedPath,
      expected,
      actual: null,
      reason: 'unverifiable',
    });
  }

  if (actual !== expected) {
    const message = buildRefusalMessage(vendorId, resolvedPath, {
      reason: 'mismatch',
      detail: `sha256 ${actual} does not match the pinned ${pin.version} digest ${expected}`,
    });
    logError(message);
    throw new VendorBinaryIntegrityError(message, {
      vendorId,
      resolvedPath,
      expected,
      actual,
      reason: 'mismatch',
    });
  }

  return binaryPath;
}

/**
 * @param {string} vendorId
 * @param {string|null} pathForLog
 * @param {{ reason: 'mismatch'|'unverifiable', detail: string }} info
 * @returns {string}
 */
function buildRefusalMessage(vendorId, pathForLog, info) {
  return [
    `[vendor-binary-integrity] REFUSING TO SPAWN "${vendorId}": ${info.detail}.`,
    `Resolved path: ${pathForLog ?? '(unresolved)'}.`,
    'This binary is pinned to a root-of-trust sha256 (OCC-15/ADR-062). A deviation means',
    'the on-disk bytes are not the reviewed, approved release — refusing to run un-vetted',
    'code under the vendor cage/permission ceiling.',
    `Remediation: reinstall the approved version, or (for an intentional upgrade) re-verify`,
    'the digest against GitHub/npm and raise the pin in vendor-binary-integrity.js AND the ADR.',
    `To temporarily run WITHOUT the pin, unset ${VENDOR_BINARY_PIN_FLAG} (default is off).`,
  ].join('\n');
}
