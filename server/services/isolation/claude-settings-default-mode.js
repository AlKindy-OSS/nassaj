/**
 * T-2071 (qa M5): `permissions.defaultMode` from the settings a Claude spawn loads.
 *
 * Before T-2071 nassaj left `--permission-mode` out whenever the composer sent
 * `default` (the composer's own default, i.e. no explicit choice), and the CLI then
 * applied the settings' `permissions.defaultMode`. The mode is now always passed, so
 * this reader keeps that behaviour: for an implicit `default` the settings mode wins.
 *
 * Bounded (qa round 2 I1):
 *  - Only managed policy and the user's own settings count, managed first. Project
 *    and local-project settings live in a shared cwd any member can write, so they
 *    never choose the mode of another member's run.
 *  - `bypassPermissions` is never derived: the SDK needs allowDangerouslySkipPermissions
 *    for it, which only the parity path sets. Such a value is ignored (next source).
 */
import { claudeSpawnSettingsFiles, readJsonObject } from './engine-anthropic-credential-guard.js';

/** Modes a settings file may hand an implicit `default` (bypassPermissions excluded). */
const SETTINGS_MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto']);

/** The trusted sources, by rank (lower wins); any other source is ignored. */
const SOURCE_RANK = Object.freeze({
  'managed policy settings': 0,
  'user settings': 1,
});

/**
 * The effective `permissions.defaultMode`, or null when no loaded settings file sets
 * a valid one. A malformed or unreadable file is skipped (the guard refuses those
 * elsewhere; this reader never throws).
 * @param {NodeJS.ProcessEnv} env the child's env
 * @param {string|null|undefined} cwd the child's working directory
 * @param {{ managedSettingsDir?: string }} [ctx] test seam
 * @returns {string|null}
 */
export function resolveSettingsDefaultMode(env, cwd, ctx = {}) {
  const files = claudeSpawnSettingsFiles(env, cwd, ctx.managedSettingsDir)
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => Object.hasOwn(SOURCE_RANK, entry.label))
    .sort((a, b) => SOURCE_RANK[a.label] - SOURCE_RANK[b.label] || a.index - b.index);
  for (const { file, label } of files) {
    let settings = null;
    try {
      settings = readJsonObject(file, label);
    } catch {
      continue;
    }
    const mode = settings?.permissions?.defaultMode;
    if (typeof mode === 'string' && SETTINGS_MODES.has(mode)) return mode;
  }
  return null;
}
