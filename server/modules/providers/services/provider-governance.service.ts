/**
 * provider-governance.service — the honest engine-governance descriptor behind the
 * T-900 governance badge (design: docs/plans/GOVERNANCE-BADGE-DESIGN-2026-07-15.md).
 *
 * WHAT IT ANSWERS
 * ---------------
 * "Is the engine that runs THIS (user, provider) actually running under nassaj
 * governance right now, on disk?" — expressed as { status, enforced, mechanism }.
 * The governing principle (T-883, commit d0f97941): "governed" is an IDENTITY claim
 * (a sha256 that matches the neutral source), never mere file existence. A badge that
 * lies is worse than no badge, so this service reports only what the disk attests.
 *
 * READ-ONLY, NO SELF-HEAL (design §2 + §5, constraint 1)
 * ------------------------------------------------------
 * The check reads the CURRENT disk state and NEVER writes: it must not materialize,
 * repair, or provision. That rules out resolveProviderEnv / resolveCodexHomeForUser
 * for path resolution — both call provisionUserDirs → materializeGovernanceCopy (the
 * fail-closed spawn-time repair), which would rewrite a planted symlink/drift and turn
 * every first-touch query into a silent write that reports a freshly-repaired
 * "governed". So this module re-derives each provider's effective home read-only from
 * the SAME isolation map the spawn path uses (isProviderIsolated + userConfigDir /
 * operatorCodexHome), then inspects the material with pure reads. If a later spawn
 * repairs governance, a re-fetch simply flips the verdict — the badge is only ever the
 * truth at read time (design §2). materializeGovernanceCopy / ensureCodexGovernance are
 * NEVER called from here.
 *
 * CHANNELS, NOT ONE VERDICT (ADR-093 §2, T-1195)
 * -----------------------------------------------
 * An engine does not have "a governance file": it has CHANNELS, and they differ in
 * kind. So the descriptor now also carries `sources[]` — for each channel the real
 * path, its symlink target when it is a link, the mechanism, HOW it was verified
 * (fingerprint vs. mere presence), how hard it is ENFORCED (three degrees, not the
 * boolean's two), and — when the verdict is negative — WHY, because "ungoverned"
 * folds five different on-disk situations that call for different actions. The
 * legacy `{status, enforced, mechanism}` triple keeps its exact prior meaning and
 * values so the T-900 badge is unaffected; `sources[]` is purely additive.
 *
 * PER (USER, PROVIDER), NOT PER SESSION: governance is a property of the user's
 * resolved provider home, so every session of the same provider for a user shares one
 * verdict (design §1).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { operatorCodexHome } from '@/modules/providers/list/codex/codex-home.js';
import {
  CODEX_AGENTS_FILENAME,
  governanceMatchesSource,
  neutralGovernanceSource,
} from '@/services/isolation/codex-governance-material.js';
import {
  GEMINI_GOVERNANCE_FILENAME,
  GEMINI_HOME_SUBDIR,
  geminiGovernanceMatchesSource,
  geminiGovernanceSource,
} from '@/services/isolation/gemini-governance-material.js';
import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { KIMI_HOME_SUBDIR, userConfigDir } from '@/services/isolation/provision-user-dirs.js';
import {
  fingerprintOf,
  hasUsableSource,
  readNeutralSource,
} from '@/services/isolation/vendor-cli-governance-material.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import type { LLMProvider } from '@/shared/types.js';
import { readOptionalString } from '@/shared/utils.js';

/** On-disk verdict. There is no third value: an unknown engine is 'ungoverned'; a
 *  server too old to answer is expressed as the ABSENCE of the response (404), which
 *  the client hides — this service never fabricates a value it cannot attest. */
export type ProviderGovernanceStatus = 'governed' | 'ungoverned';

/** The governance mechanism a provider HAS (static per provider), not the verdict. */
export type ProviderGovernanceMechanism =
  | 'codex-fingerprint'
  | 'claude-md'
  | 'opencode-agents'
  | 'kimi-agents'
  | 'gemini-md'
  | 'nassaj-project-md'
  | 'none';

/**
 * HOW the verdict was established (ADR-093 §2.1). `fingerprint` is an IDENTITY
 * claim (sha256 equals the neutral source); `presence` only attests the file is
 * readable and non-empty — it can NOT tell nassaj governance from any other text;
 * `none` is no check at all.
 */
export type ProviderGovernanceVerification = 'fingerprint' | 'presence' | 'none';

/**
 * How hard nassaj enforces this channel — THREE degrees, not two (ADR-093 §2.1).
 * The legacy `enforced:boolean` folds `best-effort` and `none` into one value, so a
 * materialized-but-unguarded channel (agy) reads identical to an engine that has no
 * governance channel at all.
 *
 *  - fail-closed   : a spawn guard refuses the launch when unattested (codex,
 *                    opencode, kimi).
 *  - best-effort   : nassaj materializes and verifies the material, but no guard
 *                    blocks a launch (agy home — T-1186 pending).
 *  - informational : the channel is read by the engine, but nassaj neither verifies
 *                    identity nor blocks (claude home, agy project instructions).
 *  - none          : no channel exists.
 */
export type ProviderGovernanceEnforcement =
  | 'fail-closed'
  | 'best-effort'
  | 'informational'
  | 'none';

/** Whose tree the channel lives in: the user's/operator's home, or a project dir. */
export type ProviderGovernanceScope = 'user' | 'project';

/**
 * WHY a channel is not governed (ADR-093 §2.2). "ungoverned" folds five distinct
 * on-disk situations that governanceMatchesSource collapses into `false`
 * (vendor-cli-governance-material.js), and the operator's action differs for each:
 * a missing NODE source is fixed by build-agents, a drifted copy by a launch, a
 * symlink is a write-through vector worth investigating.
 *
 *  - no_mechanism      : the engine reads no nassaj instructions at all.
 *  - source_absent     : no neutral source on this node — nothing CAN be governed.
 *  - copy_missing      : the source exists; the engine's file does not.
 *  - copy_empty        : the file exists but is empty (the CLI ingests nothing).
 *  - symlink_rejected  : the file is a symlink — rejected ON PURPOSE (write-through).
 *  - drifted           : real file, wrong bytes (stale after a source rebuild, or
 *                        subverted).
 *  - project_unresolved: EXTENSION beyond the ADR's six (declared, not guessed):
 *                        a project-scoped channel queried without a project in
 *                        context. The six above are verdicts ON a known path; this
 *                        one says no path could be derived, so nothing was read.
 *                        Never fabricates a pass or a failure of the file itself.
 */
export type ProviderGovernanceReason =
  | 'no_mechanism'
  | 'source_absent'
  | 'copy_missing'
  | 'copy_empty'
  | 'symlink_rejected'
  | 'drifted'
  | 'project_unresolved';

/** Whose tree a link action would write into (ADR-093 §4.2). */
export type ProviderGovernanceLinkScope = 'user' | 'operator';

/**
 * Why a channel offers no "link this agent to nassaj instructions" action
 * (ADR-093 §4.1/§4.4). A button that appears and then refuses is worse than no
 * button, so the refusal is DATA the surface can explain — never a disabled control.
 *
 *  - no_mechanism             : the engine reads no nassaj instructions at all.
 *  - symlink_by_design        : claude's channel is a symlink to the live source;
 *                               materializing a copy would freeze it (ADR-093 §4.1,
 *                               and the declared debt in §9).
 *  - shared_source_is_the_file: shared agy reads the neutral SOURCE itself — there
 *                               is nothing to copy onto itself.
 *  - project_scoped           : project instructions are the project's own content,
 *                               not nassaj material to materialize.
 *  - owner_required           : the write lands in the OPERATOR home, so it changes
 *                               every user on this node — owner only. Added by the
 *                               route, which is where the caller's role is known.
 */
export type ProviderGovernanceLinkRefusal =
  | 'no_mechanism'
  | 'symlink_by_design'
  | 'shared_source_is_the_file'
  | 'project_scoped'
  | 'owner_required';

/**
 * The server-side plan for linking ONE (provider, user) to nassaj governance
 * (ADR-093 §4). Every path in it is DERIVED from the provider id and the
 * authenticated user id — never supplied by a client — and it is the SINGLE source
 * of truth for both the read surface (which channel may offer the action) and the
 * write path (where the copy goes). Deciding that twice is how the button and the
 * endpoint drift apart, which is exactly the over-refusal B-362 fixed for keys.
 *
 * Computing a plan writes NOTHING: it is path arithmetic over the same isolation
 * gate the spawn path uses.
 */
export interface GovernanceLinkPlan {
  linkable: boolean;
  linkScope: ProviderGovernanceLinkScope | null;
  refusal: ProviderGovernanceLinkRefusal | null;
  /** The config-home whose <filename> the copy is materialized into. */
  home: string | null;
  filename: string | null;
  /** The neutral source the copy must be byte-identical to. */
  sourcePath: string | null;
}

/** One instruction channel an engine actually ingests (ADR-093 §2.1). */
export interface ProviderGovernanceChannel {
  /** Stable id for UI copy/i18n and (phase ب) the link action. */
  id: string;
  scope: ProviderGovernanceScope;
  /** The effective path for THIS user, or null when it cannot be derived. */
  path: string | null;
  /**
   * When `path` is a symlink: its resolved target. Always reported — being a link
   * is a security fact (the write-through vector the 0444 COPY closes), not a
   * cosmetic detail (ADR-093 §1.2/§6-3).
   */
  link: string | null;
  mechanism: ProviderGovernanceMechanism;
  verification: ProviderGovernanceVerification;
  enforcement: ProviderGovernanceEnforcement;
  status: ProviderGovernanceStatus;
  /** Null exactly when status === 'governed'. */
  reason: ProviderGovernanceReason | null;
  /** Whether THIS channel can be established by the link action (ADR-093 §4). */
  linkable: boolean;
  /** Whose home the link action would write into; null when not linkable. */
  linkScope: ProviderGovernanceLinkScope | null;
  /** Why not, when `linkable` is false. Null exactly when linkable. */
  linkRefusal: ProviderGovernanceLinkRefusal | null;
}

export interface ProviderGovernanceDescriptor {
  /** Current on-disk verdict for the caller's resolved provider home. */
  status: ProviderGovernanceStatus;
  /**
   * Whether nassaj HARD-enforces this engine's governance fail-closed at spawn — a
   * static property of the mechanism (true for codex AND opencode, whose spawn guards
   * block an ungoverned launch: codex-governance.ts and, for the GLM carrier,
   * opencode-governance.ts's ensureOpenCodeGovernance — GL-5/GL-7, ADR-062), NOT a
   * function of the current status. claude is present-but-not-enforced (no guard);
   * everything else has no mechanism.
   */
  enforced: boolean;
  /** The mechanism this provider is governed by (or 'none'). */
  mechanism: ProviderGovernanceMechanism;
  /**
   * Every instruction channel this engine ingests, in display order (ADR-093 §2.1).
   * ADDITIVE: the three legacy fields above keep their exact meaning and values, so
   * the T-900 badge (useProviderGovernance) is untouched. The first entry is the
   * PRIMARY channel the legacy triple mirrors; `[]` is impossible — an engine with
   * no mechanism still reports one honest `none` channel rather than an empty list
   * the UI would have to interpret (ADR-093 §2.4).
   */
  sources: ProviderGovernanceChannel[];
}

/** Optional context that unlocks project-scoped channels (agy's NASSAJ.md). */
export interface ProviderGovernanceOptions {
  /**
   * Absolute path of the project a turn would run in. Supplied by a caller that
   * HAS one (a session); omitted by the global settings surface, in which case the
   * project channel is reported `project_unresolved` — never guessed from a list.
   */
  projectPath?: string | null;
}

/**
 * The isolated user id to resolve a per-user home for `provider`, or null to use the
 * operator (shared) home. Mirrors resolveProviderEnv's gate exactly: isolation applies
 * only to an authenticated (non-empty) id AND only when the admin policy marks the
 * provider isolated; anonymous/null callers and shared providers use the operator home.
 * Under a credential grant (T-1675) the id is the OWNER's, as on the spawn path.
 */
function isolatedUserId(
  userId: string | number | null,
  provider: LLMProvider,
): string | number | null {
  if (userId === null || userId === undefined || userId === '') {
    return null;
  }
  return isProviderIsolated(provider) ? credentialPrincipalId(userId, provider) : null;
}

/**
 * The caller's effective CODEX_HOME, resolved READ-ONLY (byte-identical to what
 * resolveProviderEnv would set, minus the provisioning side effect).
 */
function codexHomeFor(userId: string | number | null): string {
  const isolated = isolatedUserId(userId, 'codex');
  return isolated !== null ? userConfigDir(isolated, '.codex') : operatorCodexHome();
}

/** The caller's effective CLAUDE_CONFIG_DIR, resolved READ-ONLY. */
function claudeConfigDirFor(userId: string | number | null): string {
  const isolated = isolatedUserId(userId, 'claude');
  return isolated !== null
    ? userConfigDir(isolated, '.claude')
    : path.join(os.homedir(), '.claude');
}

/**
 * The caller's effective `$HOME/.gemini` for agy, resolved READ-ONLY.
 *
 * TWO NAMES, ONE ENGINE: the session/UI provider id is `antigravity`, but the
 * sharing policy and resolveProviderEnv both key this engine as **`agy`**
 * (resolve-provider-env.js:150). Asking isProviderIsolated('antigravity') would
 * always answer "shared" and quietly report the operator's home for an isolated
 * user — so the isolation gate is queried with the SAME key the spawn path uses.
 */
function geminiHomeFor(userId: string | number | null): string {
  const isolated = isolatedUserId(userId, 'agy' as LLMProvider);
  return isolated !== null
    ? userConfigDir(isolated, GEMINI_HOME_SUBDIR)
    : path.join(os.homedir(), GEMINI_HOME_SUBDIR);
}

/**
 * The caller's effective XDG_CONFIG_HOME for opencode, resolved READ-ONLY. In shared
 * mode opencode reads a server-level XDG_CONFIG_HOME when present, else ~/.config
 * (mirrors resolveProviderEnv's opencode case and opencode's own default).
 */
function opencodeConfigHomeFor(userId: string | number | null): string {
  // T-1675: only opencode's DATA home follows a grant; config is always the
  // member's own (resolve-provider-env.js `case 'opencode'`), so no principal here.
  const isolated = userId === null || userId === undefined || userId === '' || !isProviderIsolated('opencode')
    ? null
    : userId;
  if (isolated !== null) {
    return userConfigDir(isolated, '.config');
  }
  return readOptionalString(process.env.XDG_CONFIG_HOME) ?? path.join(os.homedir(), '.config');
}

/**
 * claude "governed" = CLAUDE.md is a real, non-empty file the CLI will ingest. Read
 * FOLLOWING the link (CLAUDE.md is normally a symlink to NASSAJ.md): a present,
 * non-empty followed target ⇒ governed; missing, empty, or a non-file (EISDIR) ⇒
 * ungoverned. There is no neutral fingerprint to enforce here — the claude source
 * (full NASSAJ.md) is intentionally variable — so this is present-not-enforced
 * (design §8 م-3), weaker than codex but honest.
 */
function claudeInstructionsPresent(claudeMdPath: string): boolean {
  try {
    // readFileSync follows symlinks; throws on ENOENT / EISDIR / etc.
    return fs.readFileSync(claudeMdPath).length > 0;
  } catch {
    return false;
  }
}

/**
 * agy "governed" — TWO honest rules, because the two homes are not the same thing.
 *
 * agy ingests `$HOME/.gemini/GEMINI.md` (proven 2026-08-01 by canary probe, T-1185:
 * a bare `agy -p` recited ADR-018/T-1150/B-95 out of its loaded rules with no tool
 * use; workspace-level GEMINI.md/AGENTS.md/.agents/rules went unread).
 *
 *   • ISOLATED user — the file must be a real, non-empty, non-symlink 0444 COPY whose
 *     sha256 equals the neutral source (identical primitive to codex/opencode). A
 *     symlink is rejected on purpose: agy runs --dangerously-skip-permissions, so a
 *     link into the shared source is a write-through vector, never governance.
 *   • SHARED (operator) home — the file agy reads IS the neutral source itself, which
 *     on every fleet node is a symlink into the governance repo. Fingerprinting it
 *     against itself would be circular, and the no-symlink rule would report the very
 *     source of governance as ungoverned. So the honest check here is claude's:
 *     readable (following the link) and non-empty.
 *
 * Both paths are pure reads — no materialize, no repair (module header §READ-ONLY).
 */
function agyGovernanceStatus(
  userId: string | number | null,
): ProviderGovernanceStatus {
  const isolated = isolatedUserId(userId, 'agy' as LLMProvider) !== null;
  const geminiMdPath = path.join(geminiHomeFor(userId), GEMINI_GOVERNANCE_FILENAME);
  if (isolated) {
    return geminiGovernanceMatchesSource(geminiMdPath) ? 'governed' : 'ungoverned';
  }
  return claudeInstructionsPresent(geminiMdPath) ? 'governed' : 'ungoverned';
}

/**
 * The caller's effective KIMI_CODE_HOME, resolved READ-ONLY.
 *
 * NOT the isProviderIsolated gate: kimi's native agent path isolates
 * UNCONDITIONALLY for any authenticated user (resolve-provider-env.js:210-217 —
 * `provider === 'kimi' && mode === 'agent'`), because that CLI writes credential
 * and session state to disk. Anonymous/operator turns get no KIMI_CODE_HOME, so
 * the launcher's own fallback applies (kimi-agent-cli.js:139-142: ~/.kimi).
 * resolveProviderEnv also calls provisionUserDirs there — a WRITE this service must
 * never make, so the path is re-derived from the same shared constant instead.
 */
function kimiHomeFor(userId: string | number | null): string {
  if (userId === null || userId === undefined || userId === '') {
    return path.join(os.homedir(), KIMI_HOME_SUBDIR);
  }
  // T-1675: under a grant the agent CLI runs on the grantor's KIMI_CODE_HOME.
  return userConfigDir(credentialPrincipalId(userId, 'kimi'), KIMI_HOME_SUBDIR);
}

/** Shorthand: the plan fields a linkable channel carries. */
function linkablePlan(
  home: string,
  filename: string,
  sourcePath: string,
  isolated: boolean,
): GovernanceLinkPlan {
  return {
    linkable: true,
    linkScope: isolated ? 'user' : 'operator',
    refusal: null,
    home,
    filename,
    sourcePath,
  };
}

/** Shorthand: a channel that offers no link action, with the reason why. */
function unlinkablePlan(refusal: ProviderGovernanceLinkRefusal): GovernanceLinkPlan {
  return {
    linkable: false,
    linkScope: null,
    refusal,
    home: null,
    filename: null,
    sourcePath: null,
  };
}

/**
 * Where — and whether — "link this agent to nassaj instructions" may write for a
 * (provider, user), per ADR-093 §4.1/§4.2. PURE: derives paths, writes nothing.
 *
 * The client never supplies a path: `home` comes from the provider id plus the
 * authenticated user id through the SAME isolation gate the spawn path uses, so a
 * caller cannot aim the write anywhere. `sourcePath` is likewise a server constant
 * (the neutral governance source), never request data.
 *
 * NO BUTTON, by decision, for: claude (its channel is a symlink to the live source
 * on purpose), shared agy (the file it reads IS the source), the project channel,
 * and every engine with no mechanism (§4.4 — "a button that lies").
 */
export function resolveGovernanceLinkPlan(
  provider: LLMProvider,
  userId: string | number | null,
): GovernanceLinkPlan {
  switch (provider) {
    case 'codex':
      return linkablePlan(
        codexHomeFor(userId),
        CODEX_AGENTS_FILENAME,
        neutralGovernanceSource(),
        isolatedUserId(userId, 'codex') !== null,
      );
    case 'opencode':
      return linkablePlan(
        path.join(opencodeConfigHomeFor(userId), 'opencode'),
        CODEX_AGENTS_FILENAME,
        neutralGovernanceSource(),
        isolatedUserId(userId, 'opencode') !== null,
      );
    case 'kimi':
      // kimi's agent path isolates for ANY authenticated user (not by admin
      // policy), so an authenticated caller always writes into their own tree.
      return linkablePlan(
        kimiHomeFor(userId),
        CODEX_AGENTS_FILENAME,
        neutralGovernanceSource(),
        userId !== null && userId !== undefined && userId !== '',
      );
    case 'antigravity': {
      const isolated = isolatedUserId(userId, 'agy' as LLMProvider) !== null;
      if (!isolated) {
        // The shared home's GEMINI.md IS the neutral source; "linking" it would
        // copy a file onto itself (ADR-093 §4.1).
        return unlinkablePlan('shared_source_is_the_file');
      }
      return linkablePlan(
        geminiHomeFor(userId),
        GEMINI_GOVERNANCE_FILENAME,
        geminiGovernanceSource(),
        true,
      );
    }
    case 'claude':
      return unlinkablePlan('symlink_by_design');
    default:
      return unlinkablePlan('no_mechanism');
  }
}

/**
 * Why an engine offers no per-user governance switch at all (owner decision
 * 2026-08-08). Like the link refusals above, this is DATA the surface explains —
 * never a control that appears and then refuses.
 *
 *  - no_mechanism : the engine reads no nassaj instructions in the first place,
 *                   so it is ALREADY running in its vendor default. There is
 *                   nothing an exemption could remove.
 *  - shared_tree  : this engine's material lives in the OPERATOR home for this
 *                   caller (the provider is policy-'shared', or the caller is
 *                   anonymous). Removing it there would de-govern EVERY user on
 *                   the node, so a per-user switch has no per-user meaning — and
 *                   for shared agy the file in question IS the neutral source
 *                   itself, which must never be deleted by a member-facing
 *                   toggle. Refused for every role, owner included: the fix is
 *                   to isolate the provider, not to widen this switch.
 */
export type GovernanceExemptionRefusal = 'no_mechanism' | 'shared_tree';

/**
 * WHAT MUST LEAVE THE DISK for one (provider, user) to actually run in the
 * vendor's default posture (owner decision 2026-08-08, qa-critic veto V3).
 *
 * V3 IS WHY THIS EXISTS. "Stop materializing on the next provisioning pass" is
 * not an exemption: the material is ALREADY on disk for every user on this node
 * (measured 2026-08-08), so a switch that only skips future writes would change
 * nothing for anyone who already has the files — the feature would ship
 * producing exactly zero effect. An exemption therefore has to name the paths
 * whose REMOVAL is the exemption, and this is where they are named, once, for
 * both the write path and the provisioning reconciler.
 *
 * PURE: derives paths, reads and writes nothing. Every path comes from the
 * provider id plus the AUTHENTICATED user id through the same isolation gate the
 * spawn path uses, so no caller can aim a delete.
 *
 * `paths` may hold MORE than one entry (claude's channel is two links), and its
 * order is the removal order. An engine with `refusal !== null` always carries
 * an EMPTY paths array — an unexemptible engine must not be able to leak a path
 * into a delete loop by accident.
 */
export interface GovernanceMaterialPlan {
  /** Whether this engine can be exempted for this user at all. */
  exemptible: boolean;
  /** Why not. Null exactly when exemptible. */
  refusal: GovernanceExemptionRefusal | null;
  /** Whose tree the material lives in; null when not exemptible. */
  scope: ProviderGovernanceLinkScope | null;
  /**
   * Every path whose removal de-governs this engine for this user. Empty
   * whenever `exemptible` is false.
   */
  paths: string[];
  /**
   * How hard nassaj enforces this engine at launch — folded to the three values
   * the governance-preferences API speaks (fail-closed / best-effort / none), so
   * the switch can tell the member what they are actually turning off. claude's
   * `informational` folds to `none`: nassaj neither verifies its content nor
   * blocks a launch on it, which is what `none` means to that surface.
   */
  enforcement: 'fail-closed' | 'best-effort' | 'none';
}

/** Shorthand: an engine whose material can be removed for this user. */
function exemptibleMaterial(
  paths: string[],
  scope: ProviderGovernanceLinkScope,
  enforcement: GovernanceMaterialPlan['enforcement'],
): GovernanceMaterialPlan {
  return { exemptible: true, refusal: null, scope, paths, enforcement };
}

/** Shorthand: an engine with no per-user switch, and the reason why. */
function unexemptibleMaterial(
  refusal: GovernanceExemptionRefusal,
  enforcement: GovernanceMaterialPlan['enforcement'],
): GovernanceMaterialPlan {
  return { exemptible: false, refusal, scope: null, paths: [], enforcement };
}

/**
 * Resolves the removal plan for one (provider, user). See GovernanceMaterialPlan.
 *
 * ISOLATION IS THE GATE, for every engine: an exemption may only ever touch a
 * path inside the caller's OWN isolated tree. When the provider resolves to the
 * operator home the plan refuses with `shared_tree` rather than deleting there,
 * because that single delete would strip governance from every member at once —
 * and in shared agy's case would delete the node's neutral SOURCE.
 */
export function resolveGovernanceMaterialPlan(
  provider: LLMProvider,
  userId: string | number | null,
): GovernanceMaterialPlan {
  switch (provider) {
    case 'codex': {
      if (isolatedUserId(userId, 'codex') === null) {
        return unexemptibleMaterial('shared_tree', 'fail-closed');
      }
      return exemptibleMaterial(
        [path.join(codexHomeFor(userId), CODEX_AGENTS_FILENAME)],
        'user',
        'fail-closed',
      );
    }
    case 'opencode': {
      if (isolatedUserId(userId, 'opencode') === null) {
        return unexemptibleMaterial('shared_tree', 'fail-closed');
      }
      return exemptibleMaterial(
        [path.join(opencodeConfigHomeFor(userId), 'opencode', CODEX_AGENTS_FILENAME)],
        'user',
        'fail-closed',
      );
    }
    case 'kimi': {
      // kimi's agent path isolates for ANY authenticated user (not by admin
      // policy — resolve-provider-env.js:210-217), so an authenticated caller
      // always has a tree of their own; only anonymous falls back to ~/.kimi.
      if (userId === null || userId === undefined || userId === '') {
        return unexemptibleMaterial('shared_tree', 'fail-closed');
      }
      return exemptibleMaterial(
        [path.join(kimiHomeFor(userId), CODEX_AGENTS_FILENAME)],
        'user',
        'fail-closed',
      );
    }
    case 'antigravity': {
      if (isolatedUserId(userId, 'agy' as LLMProvider) === null) {
        // The shared home's GEMINI.md IS the neutral source (§4.1). Deleting it
        // would not exempt a user — it would destroy governance for the node.
        return unexemptibleMaterial('shared_tree', 'best-effort');
      }
      return exemptibleMaterial(
        [path.join(geminiHomeFor(userId), GEMINI_GOVERNANCE_FILENAME)],
        'user',
        // No launch guard blocks agy yet (T-1186): nassaj materializes and
        // verifies the copy, but an ungoverned agy turn still runs.
        'best-effort',
      );
    }
    case 'claude': {
      // A LINK, NOT A COPY — the declared difference (ADR-093 §4.1/§9). claude's
      // channel is a per-user SYMLINK into the operator home, deliberately, so
      // that the coordinator's live instructions are never frozen into a stale
      // copy. That shapes the exemption rather than blocking it: removing the
      // LINK removes the channel for this user only, and unlink(2) never follows
      // a symlink, so the operator's file behind it is untouched. Both names are
      // removed because both are materialized by provisioning and both are read
      // by name (CLAUDE.md is what the CLI ingests; NASSAJ.md is the same
      // material reachable under its own name from the user's tree).
      if (isolatedUserId(userId, 'claude') === null) {
        return unexemptibleMaterial('shared_tree', 'none');
      }
      const claudeDir = claudeConfigDirFor(userId);
      return exemptibleMaterial(
        [path.join(claudeDir, 'CLAUDE.md'), path.join(claudeDir, 'NASSAJ.md')],
        'user',
        // Present-but-not-enforced: no guard blocks an ungoverned claude launch
        // and no fingerprint is verified.
        'none',
      );
    }
    default:
      // cursor / hermes / deepseek / glm / sakana: no governance
      // channel exists, so these engines are already running in their vendor
      // default and there is nothing an exemption could remove.
      return unexemptibleMaterial('no_mechanism', 'none');
  }
}

/**
 * The symlink target of `targetPath`, or null when it is not a link. Pure read:
 * lstat + readlink/realpath only. A DANGLING link still reports its raw target —
 * "points at a file that isn't there" is exactly what the operator needs to see.
 */
function linkTargetOf(targetPath: string): string | null {
  try {
    if (!fs.lstatSync(targetPath).isSymbolicLink()) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    return fs.realpathSync(targetPath);
  } catch {
    try {
      return fs.readlinkSync(targetPath);
    } catch {
      return null;
    }
  }
}

/**
 * Classifies a FINGERPRINT channel exactly as governanceMatchesSource does — same
 * order, same rejections — but keeps the discarded WHY (ADR-093 §2.2). The verdict
 * is asserted below to equal the primitive's boolean, so the two can never drift.
 */
function classifyFingerprintChannel(
  targetPath: string,
  sourcePath: string,
): { status: ProviderGovernanceStatus; reason: ProviderGovernanceReason | null } {
  const source = readNeutralSource(sourcePath) as { fingerprint: string } | null;
  if (!source) {
    return { status: 'ungoverned', reason: 'source_absent' };
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch {
    return { status: 'ungoverned', reason: 'copy_missing' };
  }
  if (stat.isSymbolicLink()) {
    // Rejected on purpose: a link into the shared source is the write-through
    // vector the per-user 0444 COPY exists to close.
    return { status: 'ungoverned', reason: 'symlink_rejected' };
  }
  if (!stat.isFile()) {
    return { status: 'ungoverned', reason: 'copy_missing' };
  }
  let current: Buffer;
  try {
    current = fs.readFileSync(targetPath);
  } catch {
    return { status: 'ungoverned', reason: 'copy_missing' };
  }
  if (current.length === 0) {
    return { status: 'ungoverned', reason: 'copy_empty' };
  }
  if (fingerprintOf(current) !== source.fingerprint) {
    return { status: 'ungoverned', reason: 'drifted' };
  }
  return { status: 'governed', reason: null };
}

/**
 * Classifies a PRESENCE channel (claude's CLAUDE.md, agy's shared GEMINI.md): the
 * file is read FOLLOWING links, and only "readable and non-empty" is attested —
 * there is no identity claim to make (ADR-093 §2.3-2). `sourcePath` is optional:
 * when the channel has a neutral source that is itself absent on this node, that is
 * reported as `source_absent` rather than blamed on the user's file.
 */
function classifyPresenceChannel(
  targetPath: string,
  sourcePath?: string,
): { status: ProviderGovernanceStatus; reason: ProviderGovernanceReason | null } {
  let content: Buffer;
  try {
    content = fs.readFileSync(targetPath);
  } catch {
    if (sourcePath !== undefined && !hasUsableSource(sourcePath)) {
      return { status: 'ungoverned', reason: 'source_absent' };
    }
    return { status: 'ungoverned', reason: 'copy_missing' };
  }
  if (content.length === 0) {
    return { status: 'ungoverned', reason: 'copy_empty' };
  }
  return { status: 'governed', reason: null };
}

/** Projects a link plan onto the three channel fields that describe the action. */
function linkFieldsOf(plan: GovernanceLinkPlan): Pick<
  ProviderGovernanceChannel,
  'linkable' | 'linkScope' | 'linkRefusal'
> {
  return { linkable: plan.linkable, linkScope: plan.linkScope, linkRefusal: plan.refusal };
}

/** The single honest channel of an engine that reads no nassaj instructions. */
function noMechanismChannel(): ProviderGovernanceChannel {
  return {
    id: 'none',
    scope: 'user',
    path: null,
    link: null,
    mechanism: 'none',
    verification: 'none',
    enforcement: 'none',
    status: 'ungoverned',
    reason: 'no_mechanism',
    ...linkFieldsOf(unlinkablePlan('no_mechanism')),
  };
}

/**
 * agy's SECOND channel (ADR-093 §2.3-3): the project instructions nassaj injects
 * itself into the first message of a fresh conversation — `<projectPath>/NASSAJ.md`,
 * falling back to `<projectPath>/CLAUDE.md` (agy-cli.js:115,153). It is neither
 * verified nor enforced (`informational`): nassaj reads whatever the project holds
 * and prepends it. Without a project in context nothing is read at all.
 */
function agyProjectChannel(projectPath?: string | null): ProviderGovernanceChannel {
  const base: Omit<ProviderGovernanceChannel, 'path' | 'link' | 'status' | 'reason'> = {
    id: 'agy-project',
    scope: 'project',
    mechanism: 'nassaj-project-md',
    verification: 'none',
    enforcement: 'informational',
    // No link action: these are the PROJECT's own instructions, not nassaj
    // governance material to materialize (ADR-093 §4.1 lists no primitive for it).
    ...linkFieldsOf(unlinkablePlan('project_scoped')),
  };
  const root = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!root) {
    return { ...base, path: null, link: null, status: 'ungoverned', reason: 'project_unresolved' };
  }
  const primary = path.join(root, 'NASSAJ.md');
  const fallback = path.join(root, 'CLAUDE.md');
  const primaryVerdict = classifyPresenceChannel(primary);
  if (primaryVerdict.status === 'governed') {
    return { ...base, path: primary, link: linkTargetOf(primary), ...primaryVerdict };
  }
  const fallbackVerdict = classifyPresenceChannel(fallback);
  if (fallbackVerdict.status === 'governed') {
    return { ...base, path: fallback, link: linkTargetOf(fallback), ...fallbackVerdict };
  }
  // Neither file usable: report the PRIMARY path (the one to create) with its verdict.
  return { ...base, path: primary, link: linkTargetOf(primary), ...primaryVerdict };
}

export const providerGovernanceService = {
  /**
   * Computes the honest governance descriptor for one (provider, user) from the
   * CURRENT disk state. Pure read — never materializes, provisions, or repairs.
   *
   * @param provider the LLM provider to describe
   * @param userId authenticated caller id (null = anonymous/operator/shared home)
   */
  getGovernance(
    provider: LLMProvider,
    userId: string | number | null,
    options: ProviderGovernanceOptions = {},
  ): ProviderGovernanceDescriptor {
    switch (provider) {
      case 'codex': {
        // Identity check via the EXACT primitive the fail-closed guard reads at spawn
        // (governanceMatchesSource): a real, non-empty, non-symlink 0444 copy whose
        // sha256 matches the neutral source. Pure read — a symlink or drift is
        // reported ungoverned and left on disk untouched (no self-heal).
        const agentsPath = path.join(codexHomeFor(userId), CODEX_AGENTS_FILENAME);
        const verdict = classifyFingerprintChannel(agentsPath, neutralGovernanceSource());
        return {
          status: governanceMatchesSource(agentsPath) ? 'governed' : 'ungoverned',
          enforced: true,
          mechanism: 'codex-fingerprint',
          sources: [
            {
              id: 'codex-home',
              ...linkFieldsOf(resolveGovernanceLinkPlan(provider, userId)),
              scope: 'user',
              path: agentsPath,
              link: linkTargetOf(agentsPath),
              mechanism: 'codex-fingerprint',
              verification: 'fingerprint',
              // codex-governance.ts blocks the launch when unattested (ADR-057 §5).
              enforcement: 'fail-closed',
              ...verdict,
            },
          ],
        };
      }
      case 'claude': {
        // PRESENCE, NOT IDENTITY (ADR-093 §2.3-2): the check is "readable and
        // non-empty", following the link — it cannot tell nassaj governance from any
        // other text, and no guard blocks an ungoverned claude launch. The channel
        // therefore declares verification:'presence' + enforcement:'informational'
        // so the surface stops reading like the fingerprinted engines. The legacy
        // triple is unchanged: `status` still answers "will the CLI ingest a file",
        // which is all it ever attested.
        const claudeMdPath = path.join(claudeConfigDirFor(userId), 'CLAUDE.md');
        const verdict = classifyPresenceChannel(claudeMdPath);
        return {
          status: claudeInstructionsPresent(claudeMdPath) ? 'governed' : 'ungoverned',
          enforced: false,
          mechanism: 'claude-md',
          sources: [
            {
              id: 'claude-home',
              ...linkFieldsOf(resolveGovernanceLinkPlan(provider, userId)),
              scope: 'user',
              path: claudeMdPath,
              // Normally a symlink chain into the governance repo — reported, because
              // it is the write-through vector still open for this engine (ADR-093 §6-3).
              link: linkTargetOf(claudeMdPath),
              mechanism: 'claude-md',
              verification: 'presence',
              enforcement: 'informational',
              ...verdict,
            },
          ],
        };
      }
      case 'opencode': {
        // Identity check via the EXACT primitive the fail-closed carrier guard reads at
        // spawn (governanceMatchesSource, same as codex): a real, non-empty, non-symlink
        // 0444 COPY whose sha256 matches the neutral source. Since GL-5 (ADR-062) stops
        // the shared governance symlink and materializes a per-user COPY, a symlink is no
        // longer legitimate — it IS the write-through vector — so it is rejected here just
        // as ensureOpenCodeGovernance rejects it. enforced:true because that gate blocks
        // an ungoverned carrier launch fail-closed (GL-7). Pure read — a symlink or drift
        // is reported ungoverned and left on disk untouched (no self-heal).
        const agentsPath = path.join(
          opencodeConfigHomeFor(userId),
          'opencode',
          CODEX_AGENTS_FILENAME,
        );
        const verdict = classifyFingerprintChannel(agentsPath, neutralGovernanceSource());
        return {
          status: governanceMatchesSource(agentsPath) ? 'governed' : 'ungoverned',
          enforced: true,
          mechanism: 'opencode-agents',
          sources: [
            {
              id: 'opencode-home',
              ...linkFieldsOf(resolveGovernanceLinkPlan(provider, userId)),
              scope: 'user',
              path: agentsPath,
              link: linkTargetOf(agentsPath),
              mechanism: 'opencode-agents',
              verification: 'fingerprint',
              // ensureOpenCodeGovernance THROWS on an unattested carrier launch (GL-7).
              enforcement: 'fail-closed',
              ...verdict,
            },
          ],
        };
      }
      case 'kimi': {
        // ADR-093 §2.3-1, and §7-أ TRACED to the live path before wiring it: the WS
        // chat dispatcher routes an agent-mode kimi turn to spawnKimiAgent
        // (chat-websocket.service.ts:707, injected in index.js:303), which calls
        // prepareKimiAgentLaunch (kimi-agent-cli.js:305) → ensureVendorCliGovernance
        // (kimi-agent-cli.js:243). That gate THROWS VendorGovernanceMissingError and
        // the launcher answers with a refusal message instead of spawning — so kimi
        // is genuinely fail-closed on every agent turn, and the old
        // mechanism:'none' badge was a lie about a governed engine.
        //
        // SCOPE OF THE CLAIM: it holds for the AGENT path only. kimi's tool-less
        // chat path (spawnKimi) passes through no gate — it is globally disabled on
        // this deployment (DISABLED_PROVIDERS; only the agent run bypasses that
        // disable), so no ungoverned kimi turn is reachable, but the enforcement
        // belongs to the agent launcher, not to the provider id in the abstract.
        const agentsPath = path.join(kimiHomeFor(userId), CODEX_AGENTS_FILENAME);
        const verdict = classifyFingerprintChannel(agentsPath, neutralGovernanceSource());
        return {
          status: verdict.status,
          enforced: true,
          mechanism: 'kimi-agents',
          sources: [
            {
              id: 'kimi-home',
              ...linkFieldsOf(resolveGovernanceLinkPlan(provider, userId)),
              scope: 'user',
              path: agentsPath,
              link: linkTargetOf(agentsPath),
              mechanism: 'kimi-agents',
              verification: 'fingerprint',
              enforcement: 'fail-closed',
              ...verdict,
            },
          ],
        };
      }
      case 'antigravity': {
        // TWO channels (ADR-093 §2.3-3). (1) the home GEMINI.md agy actually ingests
        // — fingerprinted when isolated, presence-only when it IS the shared source;
        // best-effort either way, since no launch guard blocks agy yet (T-1186).
        // (2) the project instructions nassaj injects itself — informational.
        const isolated = isolatedUserId(userId, 'agy' as LLMProvider) !== null;
        const geminiMdPath = path.join(geminiHomeFor(userId), GEMINI_GOVERNANCE_FILENAME);
        const homeVerdict = isolated
          ? classifyFingerprintChannel(geminiMdPath, geminiGovernanceSource())
          : classifyPresenceChannel(geminiMdPath, geminiGovernanceSource());
        return {
          status: agyGovernanceStatus(userId),
          enforced: false,
          mechanism: 'gemini-md',
          sources: [
            {
              id: 'agy-home',
              ...linkFieldsOf(resolveGovernanceLinkPlan(provider, userId)),
              scope: 'user',
              path: geminiMdPath,
              link: linkTargetOf(geminiMdPath),
              mechanism: 'gemini-md',
              verification: isolated ? 'fingerprint' : 'presence',
              enforcement: 'best-effort',
              ...homeVerdict,
            },
            agyProjectChannel(options.projectPath),
          ],
        };
      }
      default:
        // cursor / hermes / deepseek / glm / sakana:
        // no governance mechanism in the code ⇒ always honestly ungoverned. This is
        // the total default, so a provider added to the union later is ungoverned
        // (never accidentally inherits another engine's badge) until wired here.
        return {
          status: 'ungoverned',
          enforced: false,
          mechanism: 'none',
          sources: [noMechanismChannel()],
        };
    }
  },
};
