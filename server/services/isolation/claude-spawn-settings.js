/**
 * ADR-221 (B-1711): the settings files a Claude spawn loads for (env, cwd), read once
 * and shared by every reader that mirrors Claude (the permission mode and the
 * permission rules other harnesses must obey).
 *
 * Each source is classified, never silently skipped:
 *  - `missing`    the file does not exist (Claude runs without it);
 *  - `unreadable` it exists but cannot be read, or is not a JSON object (Claude
 *                 refuses such a spawn; mirrors fail closed on it, M3);
 *  - `ok`         parsed object in `settings`.
 * Results are cached per (userId, cwd) and reused only while every file's stat
 * signature (inode, size, mtime) is unchanged.
 */
import fs from 'node:fs';

import { claudeSpawnSettingsFiles } from './engine-anthropic-credential-guard.js';

const CACHE_LIMIT = 256;
const cache = new Map();

/** @param {string} file @returns {string} stat signature, or 'missing' / 'error:<code>' */
function statSignature(file) {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : `error:${code}`;
  }
}

/** @param {string} file @returns {{ status: 'ok'|'missing'|'unreadable', settings: object|null }} */
function readSource(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing', settings: null };
    return { status: 'unreadable', settings: null };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { status: 'ok', settings: parsed };
  } catch { /* corrupt: classified below */ }
  return { status: 'unreadable', settings: null };
}

/**
 * Every settings source the Claude spawn for this user and cwd loads, classified.
 * @param {NodeJS.ProcessEnv} env Claude's spawn env for the member (HOME / CLAUDE_CONFIG_DIR)
 * @param {string|null|undefined} cwd the working directory
 * @param {{ userId?: string|number|null, managedSettingsDir?: string }} [ctx] cache key part / test seam
 * @returns {Array<{ file: string, label: string, status: 'ok'|'missing'|'unreadable', settings: object|null }>}
 *   An unreadable managed drop-in directory is reported as one `unreadable` source.
 */
export function readClaudeSpawnSettings(env, cwd, ctx = {}) {
  let files;
  try {
    files = claudeSpawnSettingsFiles(env, cwd, ctx.managedSettingsDir);
  } catch {
    return [{ file: '<managed-settings.d>', label: 'managed policy settings', status: 'unreadable', settings: null }];
  }
  const key = `${ctx.userId ?? ''}\u0000${cwd ?? ''}\u0000${env?.CLAUDE_CONFIG_DIR ?? env?.HOME ?? ''}`
    + `\u0000${ctx.managedSettingsDir ?? ''}`;
  const signature = files.map(({ file }) => `${file}=${statSignature(file)}`).join('\n');
  const hit = cache.get(key);
  if (hit && hit.signature === signature) return hit.sources;
  const sources = files.map(({ file, label }) => ({ file, label, ...readSource(file) }));
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, { signature, sources });
  return sources;
}
