/**
 * opencode-governance (GL-5, ADR-062) — the fail-closed governance gate for the GLM
 * OpenCode carrier, the carrier-path sibling of Codex's ensureCodexGovernance.
 *
 * PRINCIPLE (inherited from the 2026-07-12 Codex remediation, ADR-057 §5):
 * a governed vendor CLI must NEVER run outside nassaj governance. opencode ingests its
 * global rules from `$XDG_CONFIG_HOME/opencode/AGENTS.md` and — unlike kimi's "reference
 * not privileged" posture — obeys it at the codex/gemini level (the enforced tier). So
 * before a carrier turn is spawned, the launcher (server/opencode-cli.js, carrier mode
 * only) calls this gate to verify the user's effective opencode `AGENTS.md` is AUTHENTIC
 * neutral governance — a real, non-empty file (never a symlink) whose sha256 EQUALS the
 * neutral source's. If it is missing, empty, a symlink, or drifted/subverted, the gate
 * self-heals ONCE (a direct re-materialization of the read-only 0444 COPY) and re-checks.
 *
 * FAIL-CLOSED BY THROW: if governance still cannot be attested, the shared SL-2 gate
 * (ensureVendorCliGovernance) THROWS VendorGovernanceMissingError (code
 * `governance_missing`). The launcher lets it propagate and maps it to a user-facing
 * "carrier blocked: governance not initialized" message — a returning call is the proof
 * governance is in place. This gate is what lets GL-7 flip opencode's badge to
 * `enforced:true`: the badge is only honest once a REAL fail-closed gate backs it.
 *
 * COPY, not symlink (write-through invariant): materializing a real per-user COPY means
 * a hostile same-uid opencode turn can at worst damage its OWN next-turn copy — detected
 * and rewritten here — and can NEVER write THROUGH a link into the shared, fleet-wide
 * neutral source. (GL-5 also stops the shared governance symlink in
 * provider-governance.service.ts / provision-user-dirs.js — owned by other seams — so the
 * per-user copy is what actually lands on disk.)
 *
 * The neutral source is the SAME operator-home base the Claude/Codex governance uses —
 * ~/.claude/AGENTS.md — which bootstrap-node.sh points at the governance repo's AGENTS.md (the
 * build-agents neutral output). Using the operator-home base (not a hardcoded the governance repo
 * path) keeps this portable across fleet nodes. This module is a THIN opencode facade
 * over the vendor-neutral SL-1/SL-2 primitives; it hardcodes only opencode's config-home
 * shape and governance filename.
 */

import os from 'node:os';
import path from 'node:path';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import {
  ensureVendorCliGovernance,
  GOVERNANCE_MISSING_CODE,
  VendorGovernanceMissingError,
} from '@/services/isolation/vendor-cli-governance.js';
import { readOptionalString } from '@/shared/utils.js';

export { GOVERNANCE_MISSING_CODE, VendorGovernanceMissingError };

/** The attested-governance result shape returned by the shared SL-2 gate. */
export type OpenCodeGovernanceResult = ReturnType<typeof ensureVendorCliGovernance>;

/** The vendor id used for structured results, logs and the SL-7 digest pin. */
export const OPENCODE_VENDOR_ID = 'opencode';

/** The governance filename opencode ingests from its config-home. */
export const OPENCODE_AGENTS_FILENAME = 'AGENTS.md';

/** The `opencode` subdir under XDG_CONFIG_HOME opencode reads config + AGENTS.md from. */
const OPENCODE_CONFIG_SUBDIR = 'opencode';

/** User-facing (Arabic) message for a governance-blocked carrier launch. */
export const OPENCODE_GOVERNANCE_MISSING_MESSAGE = 'جلسة OpenCode (حامل GLM) محجوبة: حوكمة نسّاج غير مُهيّأة.';

/**
 * The neutral governance source: ~/.claude/AGENTS.md — the same operator-home base the
 * Claude CLAUDE.md/NASSAJ.md and Codex governance use. Resolves (via the ~/.claude ->
 * the governance repo bootstrap symlink) to the governance repo's AGENTS.md, the build-agents neutral
 * output. Reads follow the symlink chain (safe); only writes-through are the risk.
 */
export function neutralOpenCodeGovernanceSource(): string {
  return path.join(os.homedir(), '.claude', OPENCODE_AGENTS_FILENAME);
}

/**
 * Resolves the user's effective opencode config-home — the `opencode` subdir under the
 * XDG_CONFIG_HOME that resolveProviderEnv points into the isolated per-user tree
 * (~/.nassaj-users/<id>/.config/opencode when isolated), or the operator dir
 * (~/.config/opencode) in shared mode / for anonymous ids. This is where opencode reads
 * both opencode.json (GL-2/GL-3) and the global AGENTS.md (this gate). It reuses the
 * central resolver so the isolation map lives in exactly one place (no B-152 drift).
 *
 * @param userId authenticated spawner id (null = anonymous/system)
 * @returns absolute path to `<config>/opencode`
 */
export function resolveOpenCodeConfigHomeForUser(userId: string | number | null): string {
  const env = resolveProviderEnv(userId, 'opencode', process.env);
  const xdgConfigHome = readOptionalString(env.XDG_CONFIG_HOME)
    ?? path.join(os.homedir(), '.config');
  return path.join(xdgConfigHome, OPENCODE_CONFIG_SUBDIR);
}

/**
 * Fail-closed governance gate for an opencode carrier spawn (GL-5). Verifies (and
 * self-heals once) that `<opencode-config-home>/AGENTS.md` is an authentic
 * neutral-governance COPY whose fingerprint matches the neutral source. Delegates the
 * fingerprint + single self-heal + fail-closed throw to the shared SL-2 gate.
 *
 * @param userId authenticated spawner id (null = anonymous/system)
 * @returns the attested governance result (ok:true) — the launcher spawns on return.
 * @throws {VendorGovernanceMissingError} fail-closed when governance cannot be attested
 *   after a single self-heal (missing neutral source or a write failure). The launcher
 *   must let this propagate — catching it to spawn anyway defeats the gate.
 */
export function ensureOpenCodeGovernance(userId: string | number | null): OpenCodeGovernanceResult {
  const uid = userId === undefined || userId === '' ? null : userId;
  const home = resolveOpenCodeConfigHomeForUser(uid);
  return ensureVendorCliGovernance(OPENCODE_VENDOR_ID, home, neutralOpenCodeGovernanceSource(), {
    filename: OPENCODE_AGENTS_FILENAME,
  });
}
