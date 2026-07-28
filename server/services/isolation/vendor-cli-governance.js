/**
 * vendor-cli-governance — the vendor-NEUTRAL, fail-closed governance GATE (SL-2,
 * ADR-062). Generalizes Codex's ensureCodexGovernance (codex-governance.ts) into a
 * vendorId-parametrized gate so a single mechanism guards EVERY governed CLI
 * provider spawn (kimi native + the opencode carrier next) and any future one.
 *
 * PRINCIPLE (inherited verbatim from the 2026-07-12 Codex remediation, ADR-057 §5):
 * a governed vendor CLI must NEVER run outside nassaj governance. Before a turn is
 * spawned, the launch seam calls this gate with the vendor's effective config-home
 * and neutral governance source. The gate verifies the per-user
 * <home>/<filename> is AUTHENTIC neutral governance — a real, non-empty file (never
 * a symlink) whose sha256 EQUALS the neutral source's (delegated to the SL-1
 * primitive governanceMatchesSource). If it does not (missing, empty, a symlink, or
 * drifted/subverted content), the gate self-heals ONCE — a direct re-materialization
 * of the read-only (0444) COPY via the SL-1 materializeGovernanceCopy — and re-checks.
 *
 * FAIL-CLOSED BY THROW: if governance still cannot be attested after the single
 * self-heal, the gate THROWS a VendorGovernanceMissingError (code
 * `governance_missing`). Unlike Codex's ensureCodexGovernance (which returns
 * { ok:false } and relies on its one caller to block), this neutral gate serves
 * multiple launchers, so it makes refusal structural: a launcher that does not
 * explicitly catch-and-degrade CANNOT spawn an ungoverned turn. A returning call is
 * the proof governance is in place. (The caller maps this to its own vendor-specific
 * quota-style user error, e.g. kimi/opencode "session blocked: governance not
 * initialized".)
 *
 * IDENTITY, not existence: a pre-remediation guard that accepts any non-empty file
 * lets a full-access turn subvert its own governance file (or leave a stale one) and
 * still launch. The fingerprint identity check closes that; materializing a real
 * per-user COPY (never a symlink) means a hostile same-uid turn can at worst damage
 * its OWN next-turn copy — detected and rewritten here — and can NEVER write THROUGH
 * a link into the shared, fleet-wide neutral source.
 *
 * NEUTRALITY / no provisioning dependency: this gate does the DIRECT
 * re-materialization backstop only (Codex's "repair 2"); it deliberately does NOT
 * import provision-user-dirs (Codex's "repair 1", a full re-provision). That keeps
 * the neutral gate free of the provisioning cycle and lets each vendor's launch seam
 * own any re-provision step above it. Its only internal import is the SL-1 leaf
 * primitive.
 */

import path from 'node:path';

import {
  DEFAULT_GOVERNANCE_FILE_MODE,
  governanceMatchesSource,
  materializeGovernanceCopy,
  readNeutralSource,
} from './vendor-cli-governance-material.js';

/** Structural error code emitted when a governed CLI launch is refused for lack of governance. */
export const GOVERNANCE_MISSING_CODE = 'governance_missing';

/**
 * Reason discriminators carried on a refusal, for operator triage:
 *  - neutral_source_absent: no neutral source on this node (build-agents output
 *    missing / wrong path) — nothing CAN be governed here.
 *  - governance_unverified: the source is present but the per-user copy could not be
 *    attested after self-heal (e.g. a filesystem write failure).
 */
export const GOVERNANCE_REASON = Object.freeze({
  NEUTRAL_SOURCE_ABSENT: 'neutral_source_absent',
  GOVERNANCE_UNVERIFIED: 'governance_unverified',
});

/**
 * Thrown (fail-closed) when a governed CLI launch cannot be attested. The launch
 * seam must let this propagate — catching it to spawn anyway defeats the gate.
 */
export class VendorGovernanceMissingError extends Error {
  /**
   * @param {object} detail
   * @param {string} detail.vendorId
   * @param {string} detail.home
   * @param {string} detail.governancePath
   * @param {string} detail.reason one of GOVERNANCE_REASON
   * @param {unknown} [detail.cause] the underlying write error, when any
   */
  constructor({ vendorId, home, governancePath, reason, cause }) {
    super(
      `Governance not attested for vendor "${vendorId}" at ${governancePath} (${reason}) — launch refused`,
    );
    this.name = 'VendorGovernanceMissingError';
    this.code = GOVERNANCE_MISSING_CODE;
    this.vendorId = vendorId;
    this.home = home;
    this.governancePath = governancePath;
    this.reason = reason;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * @typedef {object} VendorGovernanceResult
 * @property {true} ok always true on return (refusal is a throw, never ok:false).
 * @property {string} vendorId the vendor whose launch was governed.
 * @property {string} home the effective config-home the copy lives under.
 * @property {string} governancePath the materialized <home>/<filename>.
 * @property {boolean} repaired whether a self-heal write was needed this call.
 */

/**
 * Fail-closed governance gate for a governed CLI spawn. Verifies (and self-heals
 * once) that <home>/<filename> is an authentic neutral-governance COPY whose
 * fingerprint matches the neutral source at `sourcePath`.
 *
 * The governance filename defaults to the basename of the neutral source
 * (e.g. a source of ~/.claude/AGENTS.md ⇒ the copy is <home>/AGENTS.md), which keeps
 * the gate neutral — it hardcodes no vendor filename. A vendor that ingests the same
 * content under a different name overrides it via `options.filename`.
 *
 * @param {string} vendorId the vendor being launched (e.g. 'kimi', 'opencode') —
 *   used for the structured result and the fail-closed error/log context.
 * @param {string} home the vendor's effective per-user config-home.
 * @param {string} sourcePath absolute path to the neutral governance source.
 * @param {{ filename?: string, mode?: number }} [options]
 *   filename: the governance filename the vendor CLI ingests (default:
 *     basename(sourcePath)).
 *   mode: file mode for the copy (default 0444).
 * @returns {VendorGovernanceResult} on success — governance is attested in place.
 * @throws {VendorGovernanceMissingError} fail-closed when governance cannot be
 *   attested after a single self-heal (missing source or install failure).
 */
export function ensureVendorCliGovernance(vendorId, home, sourcePath, options = {}) {
  const filename = options.filename ?? path.basename(sourcePath);
  const mode = options.mode ?? DEFAULT_GOVERNANCE_FILE_MODE;
  const governancePath = path.join(home, filename);

  // Fast path: already authentic, current governance — no write.
  if (governanceMatchesSource(governancePath, sourcePath)) {
    return { ok: true, vendorId, home, governancePath, repaired: false };
  }

  // Self-heal ONCE: materializeGovernanceCopy internally re-checks then (re)writes a
  // real read-only COPY whenever the target is missing, a symlink, empty, or drifted.
  let writeError;
  const governed = materializeGovernanceCopy(home, filename, sourcePath, {
    mode,
    onError: (err) => {
      writeError = err;
    },
  });

  if (governed && governanceMatchesSource(governancePath, sourcePath)) {
    return { ok: true, vendorId, home, governancePath, repaired: true };
  }

  // Fail-closed: distinguish "no neutral source on this node" from "source present
  // but the copy could not be attested" (e.g. a write failure) for operator triage.
  const reason = readNeutralSource(sourcePath)
    ? GOVERNANCE_REASON.GOVERNANCE_UNVERIFIED
    : GOVERNANCE_REASON.NEUTRAL_SOURCE_ABSENT;

  console.error(`[${vendorId}] governance gate FAILED — launch BLOCKED`, {
    vendorId,
    home,
    governancePath,
    reason,
    error: writeError instanceof Error ? writeError.message : writeError,
  });

  throw new VendorGovernanceMissingError({
    vendorId,
    home,
    governancePath,
    reason,
    cause: writeError,
  });
}
