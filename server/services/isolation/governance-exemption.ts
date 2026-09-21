/**
 * governance-exemption — the ONE question the launch gates and the provisioning
 * reconciler ask about the per-engine governance switch (owner decision
 * 2026-08-08): "did this user exempt this engine?"
 *
 * WHY IT SITS IN THE ISOLATION LAYER, not in the providers module. Its four
 * callers span three layers that cannot import each other: two providers-module
 * gates (codex, opencode), a root-level launcher (kimi-agent-cli.js), and
 * provision-user-dirs.js in this same folder. The isolation layer is the only
 * one all four may reach without a cross-module barrel import (and without
 * dragging the providers barrel — and its session/watcher graph — into the
 * provisioning path).
 *
 * ONE MAPPING, ONE PLACE. The engine a gate calls itself is not always the id the
 * switch is stored under: agy's launch path knows itself as `agy`, the UI and the
 * exemption table both say `antigravity`. Every caller goes through
 * `isGovernanceExempt`, so that mapping exists exactly once — the same class of
 * two-names-one-engine bug the governance service documents at
 * provider-governance.service.ts:288-296.
 *
 * FAIL-CLOSED. Every unknown answers `false` (= governed): an anonymous id, an
 * engine with no channel, an unreadable database. The repository swallows its own
 * read errors to the same answer. The cost of a wrong `false` is that an exempt
 * user briefly keeps material they asked to drop; the cost of a wrong `true` is an
 * ungoverned engine — so the asymmetry is resolved on purpose, in one direction,
 * everywhere.
 */

import * as databaseModule from '@/modules/database/index.js';

const governanceExemptionsDb = databaseModule.governanceExemptionsDb ?? {
  isExempt: () => false,
  listExemptProviders: () => new Set<string>(),
};

/**
 * The channel ids the exemption table stores — the SAME strings the
 * `/api/governance/preferences` surface uses, so a row written by the API is the
 * row a gate reads. Anything outside this set has no channel and cannot be
 * exempted.
 */
export const GOVERNANCE_EXEMPTION_PROVIDERS = Object.freeze([
  'codex',
  'opencode',
  'kimi',
  'antigravity',
  'claude',
]);

/**
 * Launch-path engine ids that name the same channel under another name. `agy` is
 * the id resolveProviderEnv and the sharing policy use; `antigravity` is the id
 * the session, the UI and this table use. Mapping here (rather than at each call
 * site) is what keeps a gate from asking about an id no row will ever carry and
 * quietly getting "not exempt" forever.
 */
const CHANNEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  agy: 'antigravity',
  gemini: 'antigravity',
});

/** Resolves a caller's engine id to its channel id, or null when it has none. */
export function resolveGovernanceChannelId(provider: string | null | undefined): string | null {
  if (typeof provider !== 'string') {
    return null;
  }
  const normalized = provider.trim().toLowerCase();
  const channel = CHANNEL_ALIASES[normalized] ?? normalized;
  return GOVERNANCE_EXEMPTION_PROVIDERS.includes(channel) ? channel : null;
}

/**
 * True only when this user has an exemption on record for this engine.
 *
 * @param userId authenticated spawner id (null/anonymous ⇒ never exempt: an
 *   anonymous turn has no tree of its own to have been exempted from)
 * @param provider the engine id as the CALLER knows it (aliases resolved here)
 */
export function isGovernanceExempt(
  userId: string | number | null | undefined,
  provider: string,
): boolean {
  const channel = resolveGovernanceChannelId(provider);
  if (channel === null) {
    return false;
  }
  return governanceExemptionsDb.isExempt(userId, channel);
}

/**
 * The channel ids this user has exempted, resolved in ONE query. Used by the
 * provisioning pass, which must decide for every engine at once and must not
 * issue a probe per engine on a path that runs at spawn time.
 */
export function listGovernanceExemptions(userId: string | number | null | undefined): Set<string> {
  return governanceExemptionsDb.listExemptProviders(userId);
}
