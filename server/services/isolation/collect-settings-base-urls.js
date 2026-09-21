/**
 * collect-settings-base-urls — surfaces any *_BASE_URL values declared in the
 * resolved settings.json so the base-URL guard can vet them too (ADR-037, B-ENG-3b).
 *
 * Claude Code reads `env` from settings.json at spawn IN ADDITION to the process
 * env we build. A base URL hidden there (e.g. ANTHROPIC_BASE_URL under
 * settings.env) would bypass a guard that only scanned our spawn env. This reads
 * the SAME channel Claude Code reads — settings.json in the resolved config dir —
 * and returns its base-URL values for assertAnthropicBaseUrlAllowed to check via
 * ctx.extraValues.
 *
 * It mirrors loadSettingsEnv in claude-auth.provider.ts:91-100 (config dir =
 * CLAUDE_CONFIG_DIR or ~/.claude; read settings.json; pull settings.env). It is
 * degrade-safe: a missing or corrupt settings.json yields [] rather than throwing,
 * so the guard simply has nothing extra to check.
 *
 * Reads only the filesystem; never mutates env or process.env.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Returns the *_BASE_URL string values found under settings.env in the config
 * dir's settings.json. Empty array when the file is absent/corrupt or declares
 * no base URLs.
 *
 * @param {NodeJS.ProcessEnv} env the spawn env (its CLAUDE_CONFIG_DIR locates settings.json)
 * @returns {Promise<string[]>}
 */
export async function collectSettingsBaseUrls(env) {
  const dir = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  try {
    const raw = await fs.readFile(path.join(dir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const settingsEnv = parsed && typeof parsed === 'object' ? parsed.env : null;
    if (!settingsEnv || typeof settingsEnv !== 'object' || Array.isArray(settingsEnv)) {
      return [];
    }
    const values = [];
    for (const [key, value] of Object.entries(settingsEnv)) {
      if (key.endsWith('_BASE_URL') && typeof value === 'string' && value.trim() !== '') {
        values.push(value);
      }
    }
    return values;
  } catch {
    // Missing/unreadable/invalid settings.json: nothing extra to vet.
    return [];
  }
}
