/**
 * codex-hook-trust — trust for the member's own hooks inside a local run's
 * CODEX_HOME (ADR-227 / T-2107 qa critical 2).
 *
 * Measured on codex-cli 0.166.0: a hook in `$CODEX_HOME/hooks.json` runs only
 * when the home's config.toml trusts it (`[hooks.state."<key>"] trusted_hash`);
 * an untrusted hook is skipped silently, and a `-c` override does not count. The
 * key and the hash are the CLI's own (`hooks/list` of its App Server), so they
 * are read from the CLI, never recomputed, and only for hooks that come from the
 * home's `hooks.json` (the member's nassaj-managed hooks, e.g. the B-95 service
 * gate) — a project's hooks are never trusted here.
 *
 * The App Server runs with no key in its env and the vendor-contacting features
 * and analytics off. The answer is cached in the home, keyed by the hooks.json
 * bytes and the CLI path, so a spawn reads it once per change.
 *
 * B-1790: a cloud chat runs on the member's own CODEX_HOME, whose config.toml
 * nassaj does not own. ensureCodexHomeHookTrust trusts there exactly the hooks in
 * the form sync-harness-homes installs (nassaj-core's dist/codex/hooks.json: the
 * service gate and the live-root guard, both from one nassaj-core), inside one
 * marked block, leaves every other byte of the file as it was, and asks the CLI
 * itself to confirm the trust (its own TOML parser), or refuses the spawn.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { CODEX_LOCAL_DISABLED_FEATURES } from './apply-codex-local-engine-env.js';

const TRUST_CACHE = '.nassaj-hook-trust.json';
const CACHE_VERSION = 'v3';
const LIST_TIMEOUT_MS = 15_000;
/** The tag sync-harness-homes ends each nassaj hook command with (any suffix). */
const NASSAJ_TAG = /# nassaj-service-gate(?::[a-z-]+)?$/u;
/**
 * The exact wrapper of nassaj-core's dist/codex/hooks.json, `@NASSAJ_CORE@` rendered
 * to an absolute path: the guard engine, its fail-closed check and its tag.
 */
const NASSAJ_WRAPPER = new RegExp('^f=(/[A-Za-z0-9._/-]+)/hooks/(service-gate|live-root-guard)\\.js; n=/usr/bin/node; '
  + '\\[ -r "\\$f" \\] && \\[ -x "\\$n" \\] \\|\\| \\{ echo "(service-gate|live-root-guard): engine \\$f or \\$n missing; '
  + 'shell call blocked fail-closed" >&2; exit 2; \\}; exec "\\$n" "\\$f" --harness codex # nassaj-service-gate(:live-root)?$', 'u');
const BLOCK_START = '# >>> nassaj hook trust (managed by nassaj; do not edit)';
const BLOCK_END = '# <<< nassaj hook trust';
export const CODEX_HOOK_TRUST_CODE = 'CODEX_HOOK_TRUST_FAILED';

/**
 * The nassaj-core path of a hook command in the exact dist form, else null.
 * @param {unknown} command
 * @returns {string|null}
 */
function nassajHookCore(command) {
  const match = NASSAJ_WRAPPER.exec(typeof command === 'string' ? command : '');
  if (!match) return null;
  const [, core, engine, echoed, suffix] = match;
  const consistent = engine === echoed && (engine === 'live-root-guard') === (suffix === ':live-root');
  return consistent ? core : null;
}

/**
 * True when `command` is one of nassaj's guard hooks exactly as nassaj installs it.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isNassajCodexHookCommand(command) {
  return nassajHookCore(command) !== null;
}

/**
 * Hooks of the home's own hooks.json as the CLI lists them.
 * @param {{ codexBin: string, codexHome: string, cwd: string, spawnImpl?: typeof spawn }} input
 * `core` is the nassaj-core path of a hook in the exact form nassaj installs (else
 * null), `tagged` whether the command carries the nassaj tag at all, `trusted` the
 * CLI's own verdict for the home's current config.toml.
 * @returns {Promise<Array<{key: string, hash: string, core: string|null, tagged: boolean, trusted: boolean}>>}
 */
function listHomeHooks({ codexBin, codexHome, cwd, spawnImpl = spawn }) {
  const features = CODEX_LOCAL_DISABLED_FEATURES.flatMap((name) => ['-c', `features.${name}=false`]);
  const child = spawnImpl(codexBin, [...features, '-c', 'analytics.enabled=false', 'app-server'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hooks/list timed out')); }, LIST_TIMEOUT_MS);
    const done = (fn, value) => { clearTimeout(timer); child.kill('SIGTERM'); fn(value); };
    child.on('error', (error) => done(reject, error));
    child.on('exit', () => done(reject, new Error('hooks/list ended without an answer')));
    child.stdin.on('error', () => { /* a CLI that exited early is reported by 'exit' */ });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
      }
      if (message.id !== 2) return;
      if (message.error) return done(reject, new Error('hooks/list failed'));
      const own = path.join(codexHome, 'hooks.json');
      const hooks = (message.result?.data ?? []).flatMap((entry) => entry.hooks ?? [])
        .filter((hook) => hook.source === 'user' && hook.sourcePath === own && /^sha256:[0-9a-f]{64}$/u.test(hook.currentHash ?? ''));
      const entry = (hook) => ({
        key: hook.key, hash: hook.currentHash, core: nassajHookCore(hook.command), tagged: NASSAJ_TAG.test(hook.command ?? ''),
        trusted: hook.trustStatus === 'trusted',
      });
      done(resolve, [...new Map(hooks.map((hook) => [hook.key, entry(hook)])).values()]);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'nassaj-hook-trust', version: '1' } } });
  });
}

/**
 * Trust entries for the home's hooks.json; [] when the home has none. Cached by
 * content (the CLI's trust verdict is not cached). Throws when hooks exist but the
 * CLI cannot list them.
 * @param {{ codexBin: string, codexHome: string, cwd: string, spawnImpl?: typeof spawn }} input
 * @returns {Promise<Array<{key: string, hash: string, core: string|null, tagged: boolean}>>}
 */
export async function readCodexHookTrust(input) {
  const hooksFile = path.join(input.codexHome, 'hooks.json');
  if (!fs.existsSync(hooksFile)) return [];
  const fingerprint = crypto.createHash('sha256')
    .update(CACHE_VERSION).update('\0').update(fs.readFileSync(hooksFile)).update('\0').update(input.codexBin).digest('hex');
  const cacheFile = path.join(input.codexHome, TRUST_CACHE);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.fingerprint === fingerprint && Array.isArray(cached.entries)) return cached.entries;
  } catch { /* no cache yet */ }
  const entries = (await listHomeHooks(input)).map(({ trusted, ...entry }) => entry);
  fs.writeFileSync(cacheFile, `${JSON.stringify({ fingerprint, entries })}\n`, { mode: 0o600 });
  return entries;
}

/**
 * The config.toml body that trusts exactly these hooks and says nothing else.
 * @param {Array<{key: string, hash: string}>} entries
 * @returns {string}
 */
export function hookTrustToml(entries) {
  return entries.map(({ key, hash }) => `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`).join('\n');
}

/** A typed refusal naming what to fix: the spawn does not start. */
function trustRefusal(problem) {
  return Object.assign(new Error(`The Codex service guard could not be enabled for this chat: ${problem}`), {
    code: CODEX_HOOK_TRUST_CODE,
  });
}

/** The key of a `[hooks.state."<key>"]` header line, or null. */
function stateTableKey(line) {
  const match = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/u.exec(line);
  if (!match) return null;
  const quoted = match[1];
  return quoted.startsWith('"') ? JSON.parse(quoted) : quoted.slice(1, -1);
}

/** `text` without the managed block and without any table trusting one of `keys`. */
function stripOwnedTrust(text, keys, file) {
  const broken = () => trustRefusal(`${file} has a broken nassaj hook trust block; delete the lines from "${BLOCK_START}" `
    + `to "${BLOCK_END}" and retry.`);
  const kept = [];
  let inBlock = false;
  let inOwnedTable = false;
  for (const line of text.split(/(?<=\n)/u)) {
    const bare = line.replace(/\r?\n$/u, '');
    if (bare === BLOCK_START) { if (inBlock) throw broken(); inBlock = true; continue; }
    if (bare === BLOCK_END) { if (!inBlock) throw broken(); inBlock = false; continue; }
    if (inBlock) continue;
    if (/^\s*\[/u.test(bare)) inOwnedTable = keys.has(stateTableKey(bare));
    if (!inOwnedTable) kept.push(line);
  }
  if (inBlock) throw broken();
  return kept.join('');
}

/**
 * The member's config.toml text with trust for exactly `entries` in one managed
 * block at its end. Every other byte is kept, except a stale table that trusts one
 * of these keys (nassaj's own hooks), which the block replaces. The text is not
 * parsed here: the CLI confirms the result (ensureCodexHomeHookTrust).
 * @param {string} text current config.toml ('' when absent)
 * @param {Array<{key: string, hash: string}>} entries
 * @param {string} [file] the file's path, for the refusal text
 * @returns {string}
 */
export function withHookTrustBlock(text, entries, file = 'config.toml') {
  const kept = stripOwnedTrust(text, new Set(entries.map((entry) => entry.key)), file);
  if (entries.length === 0) return kept;
  const block = `${BLOCK_START}\n${hookTrustToml(entries)}${BLOCK_END}\n`;
  return kept && !kept.endsWith('\n') ? `${kept}\n${block}` : `${kept}${block}`;
}

/** Writes `text` over `file` (a symlink's target) atomically, keeping the mode; null text removes it. */
function replaceFile(file, text, mode) {
  if (text === null) { fs.rmSync(file, { force: true }); return; }
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.nassaj-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(temporary, text, { mode });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** The member's config.toml as written: the real file behind a symlink, its text and mode. */
function readConfig(codexHome) {
  const link = path.join(codexHome, 'config.toml');
  const stat = fs.statSync(link, { throwIfNoEntry: false });
  const file = stat ? fs.realpathSync(link) : link;
  return { file, text: stat ? fs.readFileSync(file, 'utf8') : null, mode: stat ? stat.mode & 0o777 : 0o600 };
}

/** Logs the original cause server-side (paths and messages only, never file contents). */
function logRefusal(file, cause) {
  console.warn('[Codex] service guard trust refused', { file, cause: cause instanceof Error ? cause.message : String(cause) });
}

/** The dist-form nassaj hooks of the home, or a refusal naming hooks.json. */
async function nassajEntries(input, hooksFile) {
  let all;
  try { all = await readCodexHookTrust(input); } catch (error) {
    logRefusal(hooksFile, error);
    throw trustRefusal(`Codex could not list the hooks in ${hooksFile}; check that it is valid JSON and that the Codex CLI starts, then retry.`);
  }
  const forged = all.filter((entry) => entry.tagged && !entry.core);
  if (forged.length > 0) logRefusal(hooksFile, `${forged.length} tagged hook(s) not in the nassaj form were left untrusted`);
  const entries = all.filter((entry) => entry.core);
  const fix = 're-run sync-harness-homes to restore nassaj\'s hooks, then retry.';
  if (entries.length === 0) throw trustRefusal(`${hooksFile} has no service guard hook in the form nassaj installs; ${fix}`);
  if (new Set(entries.map((entry) => entry.core)).size > 1) throw trustRefusal(`${hooksFile} names two nassaj-core paths; ${fix}`);
  return entries;
}

/** Asks the CLI whether every entry is trusted now; restores the member file and refuses if not. */
async function confirmOrRestore(input, config, entries) {
  let listed = [];
  try { listed = await listHomeHooks(input); } catch (error) { logRefusal(config.file, error); }
  const trusted = new Set(listed.filter((hook) => hook.trusted).map((hook) => `${hook.key}\0${hook.hash}`));
  if (entries.every((entry) => trusted.has(`${entry.key}\0${entry.hash}`))) return;
  replaceFile(config.file, config.text, config.mode);
  logRefusal(config.file, 'the CLI did not confirm the trust');
  throw trustRefusal(`Codex did not accept the trust written to ${config.file}; check that it is valid TOML and holds no other `
    + `[hooks.state] entry for ${path.join(input.codexHome, 'hooks.json')}, then retry.`);
}

/**
 * B-1790: before a cloud Codex spawn, makes the member home's config.toml trust
 * exactly nassaj's own guard hooks in its hooks.json, so the B-95 service gate and
 * the live-root guard run. Without a nassaj hook the CLI is not run and only a stale
 * managed block is removed. Writes only on change (atomic, mode kept, through a
 * symlink to its target), then the CLI confirms the trust or the file is restored.
 * @param {{ codexBin: string, codexHome: string, cwd: string, spawnImpl?: typeof spawn }} input
 * @returns {Promise<Array<{key: string, hash: string, core: string|null, tagged: boolean}>>} the trusted entries
 */
export async function ensureCodexHomeHookTrust(input) {
  const hooksFile = path.join(input.codexHome, 'hooks.json');
  const tagged = fs.existsSync(hooksFile) && /# nassaj-service-gate/u.test(fs.readFileSync(hooksFile, 'utf8'));
  const entries = tagged ? await nassajEntries(input, hooksFile) : [];
  const config = readConfig(input.codexHome);
  const next = withHookTrustBlock(config.text ?? '', entries, config.file);
  if (next === (config.text ?? '')) return entries;
  try { replaceFile(config.file, next, config.mode); } catch (error) {
    logRefusal(config.file, error);
    throw trustRefusal(`${config.file} could not be written; check its permissions, then retry.`);
  }
  if (entries.length > 0) await confirmOrRestore(input, config, entries);
  return entries;
}
