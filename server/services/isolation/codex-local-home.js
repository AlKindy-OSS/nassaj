/**
 * codex-local-home — the credential-free CODEX_HOME of a Codex chat on a local
 * model server (ADR-227 "Codex and DSH bodies", T-2107).
 *
 * Measured on codex-cli 0.166.0 (T-2107 stage 3): with the member's CODEX_HOME,
 * the apps feature sent the stored ChatGPT token to chatgpt.com during a local
 * turn. So a local run gets its own home, one per server, a sibling of the
 * member's CODEX_HOME:
 *
 *   - `auth.json` — never present;
 *   - `config.toml` — never the member's (it may name a provider, MCP servers or
 *     features); nassaj writes one that only trusts the home's own hooks
 *     (codex-hook-trust.js: codex-cli 0.166.0 skips an untrusted hook silently);
 *   - `sessions/`, `hooks.json` (the B-95 service gate) and the governance entries
 *     (AGENTS.md, roles, skills, persona, rules) — linked to the member's home, so a
 *     local chat's transcript lands in the member's tree (indexed and resumed like
 *     any Codex chat) and the governance the launch just verified is what the CLI
 *     reads;
 *   - everything else the CLI writes (state databases, caches, logs) — private.
 *
 * Rebuilt under the derived-dir lock on every local spawn and re-verified; any
 * failure refuses the spawn (never the member's home as a fallback).
 */

import fs from 'node:fs';
import path from 'node:path';

import TOML from '@iarna/toml';

import { hookTrustToml } from './codex-hook-trust.js';
import { derivedConfigDirFor, ensurePrivateDir, linkEntry, withDerivedDirLock } from './engine-pin-config-dir.js';

export const CODEX_LOCAL_HOME_CODE = 'CODEX_LOCAL_HOME_FAILED';

/** Entries that must never exist in a local run's home. */
export const CODEX_LOCAL_FORBIDDEN_FILES = Object.freeze(['auth.json']);

/**
 * Credential-free entries linked from the member's home. `sessions` (resume) and
 * `hooks.json` (B-95 service gate) must resolve to the member's own when present.
 */
export const CODEX_LOCAL_LINKED_ENTRIES = Object.freeze([
  'sessions', 'archived_sessions', 'AGENTS.md', 'agents', 'skills', '.agents', 'rules', 'hooks.json',
]);
const REQUIRED_LINKS = Object.freeze(['sessions', 'hooks.json']);

const DIR_MODE = 0o700;

/**
 * Typed refusal; the message names no path or value.
 * @param {string} reason
 * @returns {Error & {code: string}}
 */
function refusal(reason) {
  const error = new Error(
    'تعذّر تجهيز مجلد Codex خالٍ من الاعتمادات لخادم النموذج المحلي، فرُفض التشغيل. '
      + `Could not prepare a credential-free Codex home for the local model server; the run was refused. (${reason})`,
  );
  return Object.assign(error, { code: CODEX_LOCAL_HOME_CODE });
}

/**
 * Sibling dir name of a local run's home, one per server.
 * @param {string} serverId local_model_servers.id
 * @returns {string}
 */
export function codexLocalHomeName(serverId) {
  const compact = String(serverId).replaceAll('-', '');
  if (!/^[A-Za-z0-9]{1,64}$/u.test(compact)) throw refusal('invalid local server id');
  return `.codex-engine-local-${compact}`;
}

/**
 * Refuses unless `config.toml`, when present, says nothing but hook trust for
 * this home's own hooks.json.
 * @param {string} localHome
 */
function verifyLocalConfig(localHome) {
  const file = path.join(localHome, 'config.toml');
  if (!fs.existsSync(file)) return;
  let parsed;
  try { parsed = TOML.parse(fs.readFileSync(file, 'utf8')); } catch { throw refusal('config.toml unreadable'); }
  const state = parsed.hooks?.state ?? {};
  const own = `${path.join(localHome, 'hooks.json')}:`;
  const clean = Object.keys(parsed).every((key) => key === 'hooks') && Object.keys(parsed.hooks ?? {}).every((key) => key === 'state')
    && Object.entries(state).every(([key, value]) => key.startsWith(own) && Object.keys(value).join() === 'trusted_hash');
  if (!clean) throw refusal('config.toml holds more than hook trust');
}

/**
 * Refuses unless no forbidden entry exists, `sessions/` and `hooks.json` resolve
 * to the member's own (when the member has them), and config.toml is clean.
 * @param {string} sourceHome the member's CODEX_HOME
 * @param {string} localHome the derived home
 */
export function verifyCodexLocalHome(sourceHome, localHome) {
  for (const name of CODEX_LOCAL_FORBIDDEN_FILES) {
    if (fs.lstatSync(path.join(localHome, name), { throwIfNoEntry: false })) throw refusal(`${name} present`);
  }
  for (const name of REQUIRED_LINKS) {
    const source = path.join(sourceHome, name);
    if (!fs.existsSync(source)) continue;
    const local = path.join(localHome, name);
    if (!fs.existsSync(local) || fs.realpathSync(local) !== fs.realpathSync(source)) {
      throw refusal(`${name} is not linked to the member home`);
    }
  }
  verifyLocalConfig(localHome);
}

/**
 * Writes the hook-trust config.toml (or none). A member hooks.json the CLI
 * cannot list refuses: a local run never runs without the member's hooks.
 * @param {string} localHome
 * @param {(localHome: string) => Promise<Array<{key: string, hash: string}>>} hookTrust
 */
async function writeHookTrust(localHome, hookTrust) {
  const file = path.join(localHome, 'config.toml');
  fs.rmSync(file, { force: true });
  if (!fs.existsSync(path.join(localHome, 'hooks.json'))) return;
  let entries;
  try { entries = await hookTrust(localHome); } catch { throw refusal('hooks could not be listed'); }
  if (entries.length === 0) throw refusal('hooks could not be trusted');
  fs.writeFileSync(file, hookTrustToml(entries), { mode: 0o600 });
}

/**
 * Rebuilds the derived home. Caller holds the lock.
 * @param {string} sourceHome
 * @param {string} localHome
 * @param {(localHome: string) => Promise<Array<{key: string, hash: string}>>} hookTrust
 */
async function rebuildCodexLocalHome(sourceHome, localHome, hookTrust) {
  ensurePrivateDir(localHome);
  for (const name of CODEX_LOCAL_FORBIDDEN_FILES) fs.rmSync(path.join(localHome, name), { force: true });
  fs.mkdirSync(path.join(sourceHome, 'sessions'), { recursive: true, mode: DIR_MODE });
  for (const name of CODEX_LOCAL_LINKED_ENTRIES) {
    const src = path.join(sourceHome, name);
    if (fs.existsSync(src)) linkEntry(src, path.join(localHome, name), name);
  }
  await writeHookTrust(localHome, hookTrust);
  verifyCodexLocalHome(sourceHome, localHome);
}

/**
 * Prepares the local run's CODEX_HOME and returns its path. Throws a typed
 * refusal; never degrades to the member's home.
 * @param {string} sourceHome the member's CODEX_HOME (resolveProviderEnv)
 * @param {string} serverId
 * @param {{ hookTrust: (localHome: string) => Promise<Array<{key: string, hash: string}>> }} opts
 *   reads the CLI's trust entries for the home's hooks.json (codex-hook-trust.js)
 * @returns {Promise<string>}
 */
export async function prepareCodexLocalHome(sourceHome, serverId, { hookTrust }) {
  if (typeof sourceHome !== 'string' || sourceHome === '') throw refusal('no member Codex home');
  const localHome = derivedConfigDirFor(sourceHome, codexLocalHomeName(serverId));
  await withDerivedDirLock(localHome, () => rebuildCodexLocalHome(path.resolve(sourceHome), localHome, hookTrust));
  return localHome;
}
