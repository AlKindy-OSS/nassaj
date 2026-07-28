/**
 * claude-managed-settings — B-14 / T-1023
 *
 * Separates "operator-imposed policy" from "user personal preference" in Claude
 * Code settings, and implements a two-layer policy delivery mechanism so that
 * hooks (zero-rule-guard, config-protection), permissions, and other policy keys
 * reach EVERY isolated session (CLAUDE_CONFIG_DIR=~/.nassaj-users/<id>/.claude)
 * without a symlink that would pollute the central file with personal writes.
 *
 * Layer 1 — /etc symlink path (unconditional; Claude Code loads this tier for
 *   EVERY session regardless of CLAUDE_CONFIG_DIR or settingSources):
 *     ~/.claude/managed-settings.json  ←  kept in sync by syncManagedSettingsFile()
 *     /etc/claude-code/managed-settings.json  →  symlink to the above (in place
 *       since 2026-06-11; requires sudo only if the symlink ever needs recreation).
 *   Claude Code's admin tier wins over the user tier for any key present in both,
 *   and a PreToolUse hook listed here cannot be suppressed by user settings.
 *
 * Layer 2 — user settings seeding (defense-in-depth, personal-pref aware):
 *     mergePolicyIntoUserSettings() seeds all POLICY_KEYS into the user's isolated
 *     settings.json at every spawn, preserving every key that is NOT a policy key
 *     (e.g. theme, language, verbosity). This ensures:
 *       (a) if the /etc symlink ever breaks, the user still has the policy in their
 *           own file;
 *       (b) nassaj's own code can read the complete effective policy from one file
 *           without consulting /etc.
 *
 * Entry point: applyOperatorPolicy(userClaudeDir, operatorHome?) — call this in
 * resolveProviderEnv's claude case, after provisionUserDirs(), on every spawn so
 * policy changes propagate without a server restart or re-provisioning.
 *
 * Design constraints:
 *   - Never reads from / writes to real ~/.claude or ~/.nassaj-users during tests —
 *     all paths are passed as explicit arguments so tests can sandbox with temp dirs.
 *   - Personal preference keys (theme, language, verbosity, …) are NEVER written to
 *     managed-settings.json and NEVER overridden in the user settings; they stay
 *     exclusively in the user tier.
 *   - All writes are atomic (tmp-file + rename) to protect against partial reads by
 *     a concurrent Claude Code process.
 *   - Every public function is non-blocking: errors are caught, logged, and never
 *     propagated to the spawn path.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------- Policy key registry ----------

/**
 * Settings keys that are OPERATOR-IMPOSED POLICY.
 * These must reach every isolated session and may not be overridden by user prefs.
 *
 *   hooks                            zero-rule-guard, config-protection, graphify hints
 *   permissions                      allow / deny rules
 *   cleanupPeriodDays                data-retention policy
 *   enabledPlugins                   fleet-wide plugin catalogue
 *   extraKnownMarketplaces           fleet-standard plugin sources
 *   effortLevel                      operator-default effort level / effort cap
 *   skipDangerousModePermissionPrompt  operator-controlled safety flag
 *
 * Any key NOT in this list is treated as a personal user preference and is never
 * copied into managed-settings.json or overwritten in the user tier.
 */
export const POLICY_KEYS = Object.freeze([
  'hooks',
  'permissions',
  'cleanupPeriodDays',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'effortLevel',
  'skipDangerousModePermissionPrompt',
]);

// ---------- Internal helpers ----------

/**
 * Read and parse a JSON file, returning {} on any error (missing, empty, or
 * malformed). Never throws.
 *
 * @param {string} filePath
 * @returns {object}
 */
function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Missing, malformed, or unreadable — treated as empty.
  }
  return {};
}

/**
 * Atomically write `content` as indented JSON to `filePath` using a sibling
 * temp file + rename so any concurrent reader never sees a partial write. The
 * temp file is cleaned up on failure (best-effort).
 *
 * Top-level keys are sorted alphabetically for a stable, diffable output.
 *
 * @param {string} filePath  absolute destination path
 * @param {object} content   plain object to serialise
 */
function atomicWriteJson(filePath, content) {
  const dir = path.dirname(filePath);
  const rand = Math.random().toString(36).slice(2);
  const tmp = path.join(dir, `.mgs-tmp-${Date.now()}-${rand}.json`);

  // Sort top-level keys so identical policy always produces identical bytes.
  const sorted = /** @type {object} */ ({});
  for (const key of Object.keys(content).sort()) {
    sorted[key] = content[key];
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n', { encoding: 'utf8' });
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * Canonical JSON string of an object (top-level keys sorted) for content
 * comparison. Used to skip unnecessary writes when the file is already current.
 *
 * @param {object} obj
 * @returns {string}
 */
function toCanonical(obj) {
  const sorted = /** @type {object} */ ({});
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return JSON.stringify(sorted, null, 2) + '\n';
}

// ---------- Public API ----------

/**
 * Read the operator's settings.json from `claudeDir` and return only the
 * POLICY_KEYS sections. Keys absent in settings.json are absent in the result.
 *
 * @param {string} claudeDir  absolute path to a .claude/ directory (operator's)
 * @returns {object}          subset of settings containing only policy keys
 */
export function readOperatorPolicySettings(claudeDir) {
  const settings = safeReadJson(path.join(claudeDir, 'settings.json'));
  const policy = /** @type {object} */ ({});
  for (const key of POLICY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      policy[key] = settings[key];
    }
  }
  return policy;
}

/**
 * Keep `claudeDir/managed-settings.json` in sync with the policy extracted from
 * `claudeDir/settings.json`.
 *
 * managed-settings.json is the file /etc/claude-code/managed-settings.json symlinks
 * to (symlink in place since 2026-06-11). Updating it here immediately updates the
 * system-wide admin tier that Claude Code loads unconditionally for ALL sessions —
 * including isolated CLAUDE_CONFIG_DIR sessions — without requiring sudo (nassaj
 * owns ~/.claude/managed-settings.json).
 *
 * The file contains EXACTLY the POLICY_KEYS present in settings.json, no more.
 * Personal keys (theme, …) are deliberately excluded. Writes are skipped when the
 * content is already current (idempotent, cheap on repeated spawns).
 *
 * @param {string} claudeDir  absolute path to the operator's .claude/ directory
 */
export function syncManagedSettingsFile(claudeDir) {
  try {
    const policy = readOperatorPolicySettings(claudeDir);
    if (Object.keys(policy).length === 0) {
      // settings.json missing or has no policy keys — nothing to write.
      return;
    }

    const managedPath = path.join(claudeDir, 'managed-settings.json');
    const current = safeReadJson(managedPath);

    if (toCanonical(current) === toCanonical(policy)) {
      return; // Already current — skip the write.
    }

    atomicWriteJson(managedPath, policy);
  } catch (err) {
    console.error('[managed-settings] syncManagedSettingsFile failed (non-blocking)', {
      claudeDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Merge operator policy settings into a user's per-user settings.json.
 *
 * Rules:
 *   - Policy keys are ALWAYS taken from `policySettings` (operator wins, no exceptions).
 *   - Every key NOT in POLICY_KEYS is preserved from the user's existing file (personal
 *     preferences such as theme, language, verbosity survive unchanged).
 *   - Creates settings.json if absent (policy-only initial content).
 *   - Idempotent: no write when the merged result equals the existing content.
 *   - Non-blocking: errors are caught, logged, and never thrown to the spawn path.
 *
 * @param {string} userClaudeDir  absolute path to the user's isolated .claude/ dir
 * @param {object} policySettings  extracted by readOperatorPolicySettings()
 */
export function mergePolicyIntoUserSettings(userClaudeDir, policySettings) {
  if (
    !policySettings ||
    typeof policySettings !== 'object' ||
    Array.isArray(policySettings) ||
    Object.keys(policySettings).length === 0
  ) {
    return;
  }

  try {
    const settingsPath = path.join(userClaudeDir, 'settings.json');
    const userSettings = safeReadJson(settingsPath);

    // Build merged result: start from user settings (preserves every personal key),
    // then overwrite each policy key with the operator-imposed value.
    const merged = { ...userSettings };
    for (const [key, value] of Object.entries(policySettings)) {
      merged[key] = value;
    }

    // Skip write if nothing changed.
    if (JSON.stringify(merged) === JSON.stringify(userSettings)) {
      return;
    }

    atomicWriteJson(settingsPath, merged);
  } catch (err) {
    console.error('[managed-settings] mergePolicyIntoUserSettings failed (non-blocking)', {
      userClaudeDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Per-spawn entry point for B-14 / T-1023 policy delivery.
 *
 * Executes both layers on every Claude session spawn:
 *   1. Reads operator policy from `operatorHome/.claude/settings.json`.
 *   2. Syncs `operatorHome/.claude/managed-settings.json` (Layer 1 — /etc path).
 *   3. Seeds policy into `userClaudeDir/settings.json` (Layer 2 — defense-in-depth).
 *
 * Policy changes in the operator settings.json propagate to all future spawns
 * without a server restart or re-provisioning.
 *
 * Call this in resolveProviderEnv's claude case, after provisionUserDirs(), before
 * setting CLAUDE_CONFIG_DIR.
 *
 * @param {string} userClaudeDir  absolute path to the user's isolated .claude/ dir
 * @param {string} [operatorHome] operator home directory (default: os.homedir())
 */
export function applyOperatorPolicy(userClaudeDir, operatorHome = os.homedir()) {
  try {
    const operatorClaudeDir = path.join(operatorHome, '.claude');
    const policy = readOperatorPolicySettings(operatorClaudeDir);
    syncManagedSettingsFile(operatorClaudeDir);
    mergePolicyIntoUserSettings(userClaudeDir, policy);
  } catch (err) {
    // Outer safety net: individual functions already catch; this guards against
    // unexpected failures (e.g. operatorHome missing) without blocking spawn.
    console.error('[managed-settings] applyOperatorPolicy failed (non-blocking)', {
      userClaudeDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
