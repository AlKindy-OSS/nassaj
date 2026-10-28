/**
 * vendor-cli-permissions — SL-4 (ADR-062): the ONE place that turns a permission
 * mode into a governed CLI provider's flags (Kimi native, OpenCode incl. the GLM
 * carrier).
 *
 * OWNER RULING (2026-10-28, B-1707): "every harness is treated the same way as
 * Claude Code for permissions; the permissions and restrictions are identical to
 * Claude Code's." For OpenCode this file therefore no longer applies a ceiling of
 * its own. The caller passes the mode CLAUDE would run under for the same request
 * (claude-permission-mode.js: parity `enforce`, the route/client mode,
 * skipPermissions, the settings defaultMode for an implicit default, and the
 * settings `disableBypassPermissionsMode` gate), and this table only translates it:
 *   - bypassPermissions → `--dangerously-skip-permissions` (approve every prompt not
 *     explicitly denied). The SL-4 operator flag OPENCODE_ALLOW_FULL_ACCESS is
 *     RETIRED: Claude's bypass has no nassaj operator gate, so OpenCode has none.
 *   - plan → `--agent plan` plus a nassaj-generated OPENCODE_PERMISSION that denies
 *     `edit` and `bash`. Measured on 1.19.3: the plan agent alone is NOT read-only
 *     (bash stays allowed, and a user config `edit: allow` overrides its edit deny).
 *   - default / acceptEdits / auto / dontAsk → no flag: OpenCode's own rules. This
 *     is NOT Claude's restriction: OpenCode's build agent allows edits and bash in
 *     the workspace without asking, and `run` auto-rejects whatever would ask
 *     (e.g. external_directory). There is no OpenCode switch that asks per edit or
 *     per command in a non-interactive run, so this gap is documented, not hidden.
 *
 * Kimi keeps its SL-4 ceiling below (KIMI_ALLOW_FULL_ACCESS); aligning Kimi with the
 * ruling is separate work.
 *
 * VENDOR FLAG TABLES (grounded in the real CLIs, NOT invented):
 *   Kimi (@moonshot-ai/kimi-code, KG-1 §1.1):  --plan  <  --auto  <  -y/--yolo
 *     (three explicit permission flags, tiered plan < auto < yolo). `--auto` = auto-approve edits
 *      within the workspace (the safe autonomous tier, == Codex workspace-write);
 *      `--yolo` = full unrestricted access (== Codex danger-full-access).
 *   OpenCode (sst/opencode, run.ts read at v1.4.0, v1.14.33, v1.19.3, v2.2.0):
 *     `--dangerously-skip-permissions` is accepted by every one of them (hidden alias
 *     of `--auto` since that flag exists), and `run` parses argv strictly, so the
 *     widest-accepted spelling is used. `--agent plan` and OPENCODE_PERMISSION are
 *     verified on the installed 1.19.3.
 *
 * ASSUMPTION FLAGGED FOR LIVE VERIFICATION (§4.5 G-KIMI-LIVE): Kimi is not installed
 * on this node, so the plan/auto/yolo ORDERING is taken from the KG-1 research gate. If a live `kimi --help` ever shows `--auto` to be the
 * dangerous full tier (with no separate mid tier), the Kimi `--auto` cases below must
 * move behind the operator flag.
 *
 * PURITY: no I/O, no DB, no logging, no imports — a deterministic pure function so it
 * is trivially testable per (vendorId, mode) and safe to call on every spawn.
 *
 * @module vendor-cli-permissions
 */

/**
 * The resolved ceiling for one spawn.
 * @typedef {Object} VendorPermissionFlags
 * @property {string[]} flags      CLI flags to append to the vendor argv (fresh array each call).
 * @property {boolean}  network    Whether outbound network is enabled (default false, server-gated).
 * @property {boolean}  fullAccess Whether the unrestricted full-access ceiling was granted.
 * @property {string}   ceiling    Human-readable ceiling label ('plan'|'workspace'|'default'|'full'|'locked').
 * @property {string|null} [permission] OpenCode only: nassaj-generated OPENCODE_PERMISSION
 *   JSON for the child env (null = leave none; the caller always drops an inherited one).
 */

/** Canonical internal permission modes after alias normalization. */
const MODE_PLAN = 'plan';
const MODE_DEFAULT = 'default';
const MODE_ACCEPT_EDITS = 'acceptEdits';
const MODE_BYPASS = 'bypass';

/**
 * Alias table folding both nassaj-native modes and the vendor vocabularies
 * onto the four canonical modes. Anything unknown/empty resolves to the SAFE default
 * (never the bypass tier) — an unrecognized client string can never widen the ceiling.
 */
const MODE_ALIASES = Object.freeze({
  plan: MODE_PLAN,
  default: MODE_DEFAULT,
  acceptedits: MODE_ACCEPT_EDITS,
  accept_edits: MODE_ACCEPT_EDITS,
  auto_edit: MODE_ACCEPT_EDITS,
  autoedit: MODE_ACCEPT_EDITS,
  bypasspermissions: MODE_BYPASS,
  bypass: MODE_BYPASS,
  yolo: MODE_BYPASS,
});

/**
 * Operator (SERVER-env only) escape-hatch flags. Never per-user / client-set.
 * OPENCODE_ALLOW_FULL_ACCESS is retired by the B-1707 ruling (OpenCode follows Claude).
 */
const SERVER_FLAGS = Object.freeze({
  KIMI_ALLOW_FULL_ACCESS: 'KIMI_ALLOW_FULL_ACCESS',
  KIMI_ALLOW_NETWORK: 'KIMI_ALLOW_NETWORK',
});

/** OpenCode `run` flag that approves every prompt not explicitly denied (v1.4.0–v2.2.0). */
const OPENCODE_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * Plan = read-only for the top-level `edit`/`bash` rules: merged after every config
 * file's top-level `permission`. Not a full cage: per-agent `agent.plan.permission`,
 * custom subagents and MCP tools can still re-allow (B-1710).
 */
const OPENCODE_PLAN_PERMISSION = JSON.stringify({ edit: 'deny', bash: 'deny' });

/**
 * Normalize a raw permission mode (client- or route-supplied) to one of the four
 * canonical modes. Case-insensitive; whitespace-trimmed. Unknown → 'default'
 * (fail-safe: a bogus mode never escalates).
 *
 * @param {unknown} permissionMode
 * @returns {'plan'|'default'|'acceptEdits'|'bypass'}
 */
function normalizePermissionMode(permissionMode) {
  if (typeof permissionMode !== 'string') return MODE_DEFAULT;
  const key = permissionMode.trim().toLowerCase();
  return MODE_ALIASES[key] ?? MODE_DEFAULT;
}

/** @param {Record<string, string | undefined> | undefined} env @param {string} key */
function isServerFlagOn(env, key) {
  return env?.[key] === 'true';
}

/**
 * Kimi native permission table.
 * @param {'plan'|'default'|'acceptEdits'|'bypass'} mode
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {VendorPermissionFlags}
 */
function mapKimi(mode, env) {
  const networkAllowed = isServerFlagOn(env, SERVER_FLAGS.KIMI_ALLOW_NETWORK);

  if (mode === MODE_PLAN) {
    // Read-only planning surface — no writes, safest ceiling. Network still gated.
    return { flags: ['--plan'], network: networkAllowed, fullAccess: false, ceiling: 'plan' };
  }

  if (mode === MODE_BYPASS) {
    // Full-access ONLY behind the operator flag; otherwise capped to the workspace
    // autonomous tier (indistinguishable from acceptEdits) — the client cannot lift it.
    if (isServerFlagOn(env, SERVER_FLAGS.KIMI_ALLOW_FULL_ACCESS)) {
      // --yolo implies unrestricted disk + network; network rides with full access.
      return { flags: ['--yolo'], network: true, fullAccess: true, ceiling: 'full' };
    }
    return { flags: ['--auto'], network: networkAllowed, fullAccess: false, ceiling: 'workspace' };
  }

  // 'default' and 'acceptEdits' both collapse to the safe workspace autonomous tier
  // (mirrors Codex mapping acceptEdits + default -> workspace-write). --auto = auto
  // approve edits inside the workspace; no full disk, no network unless server-gated.
  return { flags: ['--auto'], network: networkAllowed, fullAccess: false, ceiling: 'workspace' };
}

/**
 * OpenCode permission table (also the GLM carrier). The mode is the one CLAUDE
 * would run under for the same request (B-1707 ruling); nothing here caps it.
 * OpenCode has no network switch: its own rules allow webfetch in every mode.
 * @param {'plan'|'default'|'acceptEdits'|'bypass'} mode
 * @returns {VendorPermissionFlags}
 */
function mapOpencode(mode) {
  if (mode === MODE_PLAN) {
    return {
      flags: ['--agent', 'plan'], permission: OPENCODE_PLAN_PERMISSION,
      network: true, fullAccess: false, ceiling: 'plan',
    };
  }
  if (mode === MODE_BYPASS) {
    return {
      flags: [OPENCODE_SKIP_PERMISSIONS_FLAG], permission: null,
      network: true, fullAccess: true, ceiling: 'full',
    };
  }
  // default / acceptEdits / anything else: OpenCode's own rules (see the header for
  // how they differ from Claude's prompting modes).
  return { flags: [], permission: null, network: true, fullAccess: false, ceiling: 'default' };
}

/** Fail-closed lockdown for any vendor we don't have a table for. */
function lockedDefault() {
  return { flags: [], network: false, fullAccess: false, ceiling: 'locked' };
}

/**
 * Translate a permission mode into the CLI flags + capability booleans for a given
 * vendor. Kimi: applies its SL-4 ceiling to the client/route mode. OpenCode/GLM: pass
 * the mode Claude would run under (resolveClaudeEffectivePermissionMode); it is
 * translated as is, per the B-1707 ruling.
 *
 * @param {string} vendorId   e.g. 'kimi', 'opencode' (alias: 'glm' -> opencode carrier).
 * @param {unknown} [permissionMode] the mode; normalized internally.
 * @param {Record<string, string | undefined>} [env] server env carrying Kimi's operator flags.
 * @returns {VendorPermissionFlags}
 */
function mapPermissionModeToVendorFlags(vendorId, permissionMode, env = process.env) {
  const mode = normalizePermissionMode(permissionMode);
  const vendor = typeof vendorId === 'string' ? vendorId.trim().toLowerCase() : '';

  switch (vendor) {
    case 'kimi':
      return mapKimi(mode, env);
    case 'opencode':
    case 'glm': // GLM is carried by OpenCode (ADR-062); share the carrier table.
      return mapOpencode(mode);
    default:
      // Unknown vendor: never emit an escalation flag. Fail-closed.
      return lockedDefault();
  }
}

export {
  mapPermissionModeToVendorFlags,
  normalizePermissionMode,
  OPENCODE_PLAN_PERMISSION,
  OPENCODE_SKIP_PERMISSIONS_FLAG,
  SERVER_FLAGS,
};
