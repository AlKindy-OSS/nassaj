/**
 * opencode-local-tier (ADR-LOCAL-INSTR-TIER-001, S4) — prepares the per-user config
 * dir a local-model OpenCode turn runs under, ~/.nassaj-users/<id>/.config-local:
 *  - a real 0700 `opencode/` dir (never a link);
 *  - AGENTS.md verified against ~/.claude/AGENTS.local.md (fail-closed, no fallback);
 *  - agent/ with generated cards of the allowed agents, command/ + skills/ linked;
 *  - opencode.json with the usual provider/limit material, the task allow-list and
 *    the MCP overlay of the member's ordinary config (so servers never vanish).
 * OPENCODE_DISABLE_CLAUDE_CODE_PROMPT is deliberately never set (qa C1).
 */

import path from 'node:path';

import { ensurePrivateRealDirectory } from '@/services/isolation/opencode-config-lock.js';
import { materializeOpenCodeConfig, readOpenCodeMcpOverlay } from '@/services/isolation/opencode-config-material.js';
import {
  LOCAL_INSTRUCTION_TIER,
  materializeLocalAgentCards,
} from '@/services/isolation/opencode-local-tier-material.js';
import { linkOpenCodeLocalSharedConfig } from '@/services/isolation/provision-user-dirs.js';

import {
  ensureOpenCodeGovernance,
  localAgentCardSourceDir,
  localConfigHomeForMember,
  resolveOpenCodeConfigHomeForUser,
  type OpenCodeGovernanceResult,
} from './opencode-governance.js';

export type PreparedLocalTier = {
  /** The XDG_CONFIG_HOME of the turn. */
  configHome: string;
  governance: OpenCodeGovernanceResult;
};

/**
 * Builds (idempotently) the local config dir of `callerId` and returns its
 * XDG_CONFIG_HOME. Throws on any failure; the launcher refuses the turn.
 * @throws {LocalInstructionsUnavailableError} slim instructions unavailable
 * @throws {LocalAgentCardsUnavailableError} an allowed agent card is missing
 */
export function prepareOpenCodeLocalTier(callerId: string | number): PreparedLocalTier {
  const opencodeDir = localConfigHomeForMember(callerId);
  // Refuses a symlinked or escaping ancestor (.config-local, opencode/) before any write.
  ensurePrivateRealDirectory(opencodeDir);
  linkOpenCodeLocalSharedConfig(opencodeDir);
  const governance = ensureOpenCodeGovernance(callerId, opencodeDir, { tier: LOCAL_INSTRUCTION_TIER });
  materializeLocalAgentCards(opencodeDir, localAgentCardSourceDir());
  const ok = materializeOpenCodeConfig(opencodeDir, {
    callerId,
    tier: LOCAL_INSTRUCTION_TIER,
    // Always the ordinary config's current overlay ({} when it has none or cannot be
    // read), so a removed server never survives in the local copy.
    mcp: readOpenCodeMcpOverlay(resolveOpenCodeConfigHomeForUser(callerId)),
  });
  if (!ok) throw new Error('تعذّر تهيئة إعداد خادم النماذج.');
  return { configHome: path.dirname(opencodeDir), governance };
}
