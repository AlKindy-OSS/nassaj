/**
 * vendor-cli-permissions — SL-4 (ADR-062): the ONE permission-ceiling chokepoint
 * that BOTH live agent spawn paths (interactive WS + REST /api/agent) funnel
 * through when launching a governed CLI provider (Kimi native, OpenCode carrier).
 *
 * WHY A SINGLE MAPPER (the danger it locks down):
 *   The interactive WS path forwards CLIENT-supplied `options` (including
 *   `permissionMode`) straight into the launcher. If each launcher translated the
 *   mode to CLI flags on its own, a client could pick the most permissive mode and
 *   reach a vendor's "auto-approve everything" flag (Kimi `--yolo`, OpenCode
 *   `--auto` — the latter's own help literally reads "dangerous!") on a SHARED uid,
 *   giving full disk/network to any authenticated user. This is the exact Codex
 *   B-169/T-884 hole, one CLI removed. So — exactly like
 *   `mapPermissionModeToCodexOptions` (server/openai-codex.js) — the ceiling is
 *   enforced HERE, once, and every call site simply appends the returned flags.
 *
 * THE CEILING (mirrors Codex T-884 / T-895, default OFF for full-access + network):
 *   - A client-chosen `bypassPermissions` is CAPPED to the same safe autonomous
 *     ceiling as `acceptEdits`/`default`. It reaches a vendor's full-access flag
 *     ONLY when the operator has opted the whole deployment in via a SERVER env flag
 *     (`KIMI_ALLOW_FULL_ACCESS` / `OPENCODE_ALLOW_FULL_ACCESS` === 'true'), never a
 *     per-user or client-controlled value.
 *   - Outbound network is OFF by default and never raised by a client. It rides only
 *     with a granted full-access ceiling, plus (Kimi only) an independent operator
 *     flag `KIMI_ALLOW_NETWORK==='true'` — matching Codex's server-flag-only network.
 *   - `plan` mode maps to each vendor's read-only planning surface (Kimi `--plan`,
 *     OpenCode `--agent plan`): the safest ceiling, no writes.
 *
 * VENDOR FLAG TABLES (grounded in the real CLIs, NOT invented):
 *   Kimi (@moonshot-ai/kimi-code, KG-1 §1.1):  --plan  <  --auto  <  -y/--yolo
 *     (three explicit permission flags, tiered like gemini-cli's
 *      plan < --approval-mode auto_edit < --yolo). `--auto` = auto-approve edits
 *      within the workspace (the safe autonomous tier, == Codex workspace-write);
 *      `--yolo` = full unrestricted access (== Codex danger-full-access).
 *   OpenCode (sst/opencode 1.17.18, `opencode run --help`, verified live):
 *     --agent plan  <  (no flag = OpenCode's own ask/deny default)  <  --auto
 *     (`--auto` help text: "auto-approve permissions that are not explicitly denied
 *      (dangerous!)" — OpenCode's full-access escalation; there is NO mid-tier flag,
 *      so `acceptEdits` stays on the safe default just like `default`).
 *
 * ASSUMPTION FLAGGED FOR LIVE VERIFICATION (§4.5 G-KIMI-LIVE): Kimi is not installed
 * on this node, so the plan/auto/yolo ORDERING is taken from the KG-1 research gate
 * and the gemini precedent. If a live `kimi --help` ever shows `--auto` to be the
 * dangerous full tier (with no separate mid tier), the Kimi `--auto` cases below must
 * move behind the operator flag. OpenCode's table is verified against the live binary.
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
 */

/** Canonical internal permission modes after alias normalization. */
const MODE_PLAN = 'plan';
const MODE_DEFAULT = 'default';
const MODE_ACCEPT_EDITS = 'acceptEdits';
const MODE_BYPASS = 'bypass';

/**
 * Alias table folding both nassaj-native modes and the gemini/vendor vocabularies
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

/** Operator (SERVER-env only) escape-hatch flags. Never per-user / client-set. */
const SERVER_FLAGS = Object.freeze({
  KIMI_ALLOW_FULL_ACCESS: 'KIMI_ALLOW_FULL_ACCESS',
  KIMI_ALLOW_NETWORK: 'KIMI_ALLOW_NETWORK',
  OPENCODE_ALLOW_FULL_ACCESS: 'OPENCODE_ALLOW_FULL_ACCESS',
});

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
 * OpenCode carrier permission table (used for the GLM carrier path too).
 * @param {'plan'|'default'|'acceptEdits'|'bypass'} mode
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {VendorPermissionFlags}
 */
function mapOpencode(mode, env) {
  if (mode === MODE_PLAN) {
    // Built-in read-only `plan` agent — cannot edit files.
    return { flags: ['--agent', 'plan'], network: false, fullAccess: false, ceiling: 'plan' };
  }

  if (mode === MODE_BYPASS && isServerFlagOn(env, SERVER_FLAGS.OPENCODE_ALLOW_FULL_ACCESS)) {
    // --auto = "auto-approve permissions ... (dangerous!)": OpenCode's full-access
    // escalation, network-capable. Reachable ONLY behind the operator flag.
    return { flags: ['--auto'], network: true, fullAccess: true, ceiling: 'full' };
  }

  // default / acceptEdits / capped-bypass: OpenCode has NO mid-tier flag, so we emit
  // nothing and let the default build agent run under its own ask/deny policy
  // (byte-identical to today's `opencode run` argv). Network stays OFF. The client's
  // mode choice cannot raise this ceiling.
  return { flags: [], network: false, fullAccess: false, ceiling: 'default' };
}

/** Fail-closed lockdown for any vendor we don't have a table for. */
function lockedDefault() {
  return { flags: [], network: false, fullAccess: false, ceiling: 'locked' };
}

/**
 * Translate a permission mode into the CLI flags + capability booleans for a given
 * vendor, applying the shared ceiling. This is the SINGLE enforcement point both the
 * WS and REST launch paths must call — a client's `permissionMode` can never widen
 * the ceiling beyond what an operator SERVER flag allows.
 *
 * @param {string} vendorId   e.g. 'kimi', 'opencode' (alias: 'glm' -> opencode carrier).
 * @param {unknown} [permissionMode] client/route-supplied mode; normalized internally.
 * @param {Record<string, string | undefined>} [env] server env carrying operator flags.
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
      return mapOpencode(mode, env);
    default:
      // Unknown vendor: never emit an escalation flag. Fail-closed.
      return lockedDefault();
  }
}

export {
  mapPermissionModeToVendorFlags,
  normalizePermissionMode,
  SERVER_FLAGS,
};
