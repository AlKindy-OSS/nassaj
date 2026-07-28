/**
 * codex-governance — fail-closed governance gate for Codex spawns (ADR-057 §5,
 * owner decision 2026-07-12; hardened 2026-07-12 remediation).
 *
 * Principle: Codex — like any agent engine — must NEVER run outside nassaj
 * governance. Before a turn is spawned, the caller (server/openai-codex.js)
 * verifies that the user's effective $CODEX_HOME/AGENTS.md is authentic neutral
 * governance — a real, non-empty file whose content fingerprint MATCHES the
 * neutral source (codex-governance-material.governanceMatchesSource). If it does
 * not (missing, empty, a symlink, or drifted/subverted content), this module
 * attempts a single self-heal — re-provision the per-user tree, then a direct
 * re-materialization of the governance COPY into the resolved home — and re-checks.
 * If governance still cannot be attested, the launch is refused: no thread is
 * started and the caller returns a structural `governance_missing` error.
 *
 * IDENTITY, not existence: the pre-remediation guard accepted any non-empty file,
 * so a Codex turn running danger-full-access could subvert its own governance file
 * (or leave a stale one) and still launch. The identity fingerprint check closes
 * that, and materializing a real per-user COPY (never a symlink) means a hostile
 * turn can at worst damage its OWN next-turn copy — detected and rewritten here —
 * and can never write THROUGH a link into the shared fleet-wide neutral source.
 *
 * The neutral source is the SAME base the Claude CLAUDE.md/NASSAJ.md links use —
 * ~/.claude/AGENTS.md — which bootstrap-node.sh points at nassaj-core/AGENTS.md
 * (the build-agents neutral output). Using the operator-home base (not a hardcoded
 * nassaj-core path) keeps this portable across fleet nodes.
 */

import path from 'node:path';

import {
  provisionUserDirs,
  invalidateProvisioned,
} from '@/services/isolation/provision-user-dirs.js';
import {
  CODEX_AGENTS_FILENAME,
  governanceMatchesSource,
  materializeGovernanceCopy,
  readNeutralGovernance,
} from '@/services/isolation/codex-governance-material.js';

import { resolveCodexHomeForUser } from './codex-home.js';

export { CODEX_AGENTS_FILENAME };

/** Structural error code emitted when a Codex launch is refused for lack of governance. */
export const GOVERNANCE_MISSING_CODE = 'governance_missing';

/** User-facing (Arabic) message for a governance-blocked Codex launch. */
export const GOVERNANCE_MISSING_MESSAGE = 'جلسة Codex محجوبة: حوكمة نسّاج غير مُهيّأة.';

export type GovernanceResult = {
  ok: boolean;
  codexHome: string;
  agentsPath: string;
  repaired?: boolean;
  reason?: string;
};

/**
 * Fail-closed governance gate. Verifies (and self-heals once) that the user's
 * effective $CODEX_HOME/AGENTS.md is an authentic neutral-governance COPY whose
 * fingerprint matches the neutral source.
 *
 * Repair order when the identity check fails:
 *   1. For an authenticated user, FORCE a full re-provision (invalidate the
 *      in-process guard first — resolveProviderEnv already provisioned this
 *      lifetime, so a plain call would no-op and never rewrite a vanished or
 *      drifted copy). provisionUserDirs re-materializes the governance copy.
 *   2. Backstop: re-materialize the copy directly into the resolved home — covers
 *      the operator/anonymous/shared home (which provisionUserDirs does not manage)
 *      and any residual per-user gap.
 *
 * @param userId authenticated spawner id (null = anonymous/system)
 * @returns whether the launch is governed; the caller BLOCKS the spawn on ok=false
 */
export function ensureCodexGovernance(userId: string | number | null): GovernanceResult {
  const uid = userId === undefined || userId === '' ? null : userId;
  const codexHome = resolveCodexHomeForUser(uid);
  const agentsPath = path.join(codexHome, CODEX_AGENTS_FILENAME);

  if (governanceMatchesSource(agentsPath)) {
    return { ok: true, codexHome, agentsPath };
  }

  // Repair (1): force a full re-provision for a real user (re-materializes the copy).
  if (uid !== null) {
    try {
      invalidateProvisioned(uid);
      provisionUserDirs(uid);
    } catch (err) {
      console.error('[Codex] governance repair provisioning failed', {
        userId: uid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Repair (2): direct re-materialization backstop (also governs operator/anonymous/
  // shared homes provisionUserDirs never touches).
  const governed = governanceMatchesSource(agentsPath) || materializeGovernanceCopy(codexHome);

  if (governed) {
    return { ok: true, codexHome, agentsPath, repaired: true };
  }

  // Distinguish "no neutral source on this node" from "source present but the copy
  // could not be attested" (e.g. a filesystem write failure) for operator triage.
  const reason = readNeutralGovernance() ? 'governance_unverified' : 'neutral_source_absent';
  return { ok: false, codexHome, agentsPath, reason };
}
