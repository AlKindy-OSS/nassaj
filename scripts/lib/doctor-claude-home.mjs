/**
 * Read-only Claude-home layout inspection for `nassaj doctor` (T-1880).
 *
 * The Claude-home separation moves Claude's runtime out of the governance
 * checkout: `~/.claude` becomes a real directory with per-entry links into
 * `$CORE_DIR`. These checks only lstat/readlink/read — they never write — and
 * report findings as warnings, so doctor's exit code is unaffected.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Default baseline-owned settings keys (design §4), used when no manifest says otherwise. */
export const DEFAULT_BASELINE_KEYS = Object.freeze([
  'hooks', 'permissions', 'enabledPlugins', 'extraKnownMarketplaces',
  'skipDangerousModePermissionPrompt', 'env',
]);

/** Claude runtime names that must not exist as real entries inside the governance checkout. */
export const RUNTIME_NAMES = Object.freeze([
  '.credentials.json', 'history.jsonl', 'sessions', 'session-env', 'session-data',
  'shell-snapshots', 'file-history', 'paste-cache', 'debug', 'telemetry', 'daemon', 'todos',
]);

const FORBIDDEN_BASENAMES = new Set(['sync.sh', 'setup.sh']);

const lstatOrNull = (target) => { try { return fs.lstatSync(target); } catch { return null; } };
const realOrNull = (target) => { try { return fs.realpathSync(target); } catch { return null; } };
const linkTextOrNull = (target) => { try { return fs.readlinkSync(target); } catch { return null; } };

/** Governance checkout: env override, dir of the real `~/.claude/NASSAJ.md`, else `~/nassaj-core`. */
export function resolveCoreDir(home, env = process.env) {
  if (env.NASSAJ_GOVERNANCE_DIR) return path.resolve(env.NASSAJ_GOVERNANCE_DIR);
  const nassajMd = realOrNull(path.join(home, '.claude', 'NASSAJ.md'));
  return nassajMd ? path.dirname(nassajMd) : path.join(home, 'nassaj-core');
}

/** True when `target` is inside a `.git` directory or is a forbidden repo script. */
function isForbiddenTarget(target) {
  return target.split(path.sep).includes('.git') || FORBIDDEN_BASENAMES.has(path.basename(target));
}

/** Links in `dir` (depth <= 2, not following links) whose realpath is forbidden. */
function forbiddenLinks(dir, depth = 2) {
  const found = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return found; }
  for (const name of names) {
    const entry = path.join(dir, name);
    const stat = lstatOrNull(entry);
    if (stat?.isSymbolicLink()) {
      const text = linkTextOrNull(entry);
      const target = realOrNull(entry) ?? (text === null ? null : path.resolve(dir, text));
      if (target && isForbiddenTarget(target)) found.push(`${entry} -> ${target}`);
    } else if (stat?.isDirectory() && depth > 1) {
      found.push(...forbiddenLinks(entry, depth - 1));
    }
  }
  return found;
}

/** Stable JSON for comparison: object keys sorted recursively. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Baseline-owned keys from `$CORE_DIR/claude-home.manifest`, else the design default. */
function baselineKeys(coreDir) {
  const keys = readJson(path.join(coreDir, 'claude-home.manifest'))?.settingsOwners?.baseline;
  return Array.isArray(keys) && keys.every((key) => typeof key === 'string') ? keys : DEFAULT_BASELINE_KEYS;
}

/** Baseline-owned keys whose value in `$CH/settings.json` differs from the baseline. */
function settingsDrift(claudeHome, coreDir) {
  const baseline = readJson(path.join(coreDir, 'settings.json'));
  const runtime = readJson(path.join(claudeHome, 'settings.json'));
  if (!baseline || !runtime) return null;
  return baselineKeys(coreDir).filter((key) => canonical(baseline[key]) !== canonical(runtime[key]));
}

/**
 * Inspects the Claude home layout. Returns `{ level, name, detail, fix[] }`
 * findings with level `ok` or `warn` only.
 */
export function inspectClaudeHome({ home, env = process.env }) {
  const claudeHome = path.join(home, '.claude');
  const coreDir = resolveCoreDir(home, env);
  const homeStat = lstatOrNull(claudeHome);
  const findings = [];
  const add = (level, name, detail, ...fix) => findings.push({ level, name, detail, fix });
  const migrate = `run ${path.join(coreDir, 'scripts', 'migrate-claude-home.sh')} --check`;

  if (!homeStat) {
    add('ok', 'Claude home', `${claudeHome} not created yet`);
    return findings;
  }
  const legacy = homeStat.isSymbolicLink();
  if (legacy) {
    add('warn', 'Claude home layout', `legacy: ${claudeHome} is a symlink to ${realOrNull(claudeHome) ?? '(dangling)'}`, migrate);
  } else {
    add('ok', 'Claude home layout', `${claudeHome} is a real directory`);
    const links = forbiddenLinks(claudeHome);
    if (links.length) add('warn', 'Claude home links', `resolve into .git/sync.sh/setup.sh: ${links.join('; ')}`, migrate);
    const drift = settingsDrift(claudeHome, coreDir);
    if (drift?.length) add('warn', 'Claude settings drift', `baseline-owned keys differ: ${drift.join(', ')}`, `run ${path.join(coreDir, 'scripts', 'apply-claude-settings')}`);
  }

  const leftovers = RUNTIME_NAMES.filter((name) => {
    const stat = lstatOrNull(path.join(coreDir, name));
    return stat && !stat.isSymbolicLink();
  });
  if (leftovers.length) add('warn', 'Claude runtime in governance', `${coreDir} holds real runtime entries: ${leftovers.join(', ')}`, migrate);
  return findings;
}
