/**
 * vendor-cli-permissions — SL-4 (ADR-062): the ONE place that turns a permission
 * mode into a governed CLI provider's flags (OpenCode incl. the GLM carrier).
 *
 * OWNER RULING (2026-10-28, B-1707): "every harness is treated the same way as
 * Claude Code for permissions; the permissions and restrictions are identical to
 * Claude Code's." For OpenCode this file therefore no longer applies a ceiling of
 * its own. The caller passes the mode CLAUDE would run under for the same request
 * (claude-permission-mode.js: parity `enforce`, the route/client mode,
 * skipPermissions, the settings defaultMode for an implicit default, and the
 * settings `disableBypassPermissionsMode` gate), and this table only translates it:
 *   - bypassPermissions → no flag (ADR-226): the shared Claude-parity engine decides every
 *     tool call (bypass included) and OPENCODE_PERMISSION starts with `"*":"allow"`, so
 *     OpenCode's own skip flag is never passed. The SL-4 operator flag
 *     OPENCODE_ALLOW_FULL_ACCESS stays RETIRED.
 *   - plan → `--agent plan` plus a nassaj-generated OPENCODE_PERMISSION that denies
 *     `edit` and `bash`. Measured on 1.19.3: the plan agent alone is NOT read-only
 *     (bash stays allowed, and a user config `edit: allow` overrides its edit deny).
 *   - default / acceptEdits / auto / dontAsk → no flag: the engine applies Claude's
 *     rules and asks the member (ADR-226 §3).
 *
 * VENDOR FLAG TABLES (grounded in the real CLIs, NOT invented):
 *   OpenCode (sst/opencode, run.ts read at v1.4.0, v1.14.33, v1.19.3, v2.2.0):
 *     `run` parses argv strictly. `--agent plan` and OPENCODE_PERMISSION are verified
 *     on the installed 1.19.5 (ADR-226 stage 0).
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
    // ADR-226: no skip flag; the parity engine allows what Claude's bypass allows.
    return { flags: [], permission: null, network: true, fullAccess: true, ceiling: 'full' };
  }
  // default / acceptEdits / anything else: the parity engine applies Claude's rules.
  return { flags: [], permission: null, network: true, fullAccess: false, ceiling: 'default' };
}

/** Fail-closed lockdown for any vendor we don't have a table for. */
function lockedDefault() {
  return { flags: [], network: false, fullAccess: false, ceiling: 'locked' };
}

/**
 * Translate a permission mode into the CLI flags + capability booleans for a given
 * vendor. OpenCode/GLM: pass the mode Claude would run under
 * (resolveClaudeEffectivePermissionMode); it is translated as is, per the B-1707
 * ruling.
 *
 * @param {string} vendorId   e.g. 'opencode' (alias: 'glm' -> opencode carrier).
 * @param {unknown} [permissionMode] the mode; normalized internally.
 * @returns {VendorPermissionFlags}
 */
function mapPermissionModeToVendorFlags(vendorId, permissionMode) {
  const mode = normalizePermissionMode(permissionMode);
  const vendor = typeof vendorId === 'string' ? vendorId.trim().toLowerCase() : '';

  switch (vendor) {
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
};
