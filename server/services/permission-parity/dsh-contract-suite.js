/**
 * dsh-contract-suite — the static parts of the dsh integration contract (T-2091, ADR-225):
 * the security rows a composed dsh profile must still carry (measured: an unknown layer id is
 * ignored silently, so a renamed row would drop its protection without any error), the
 * test layer used by the offline contract run, and the plugin's engines.dsh range.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Rows whose presence and state carry Nassaj's protection (llm origin, uploads, accounts, self-prompts, preset). */
export const DSH_SECURITY_ROWS = Object.freeze(['llm-deepseek', 'session-log-deepseek', 'plugin-package-inventory-deepseek',
  'session-telemetry-otel', 'plugin-manager', 'tool-plugin-manager', 'deepseek-account', 'llm-deepseek-account', 'llm-pi-ai',
  'goal-round-driver', 'tool-jobs', 'permission', 'ptc-runtime']);

/** The state each security row must have in the composed tree (a semantic --dump-config check). */
export const DSH_SECURITY_EXPECTATIONS = Object.freeze({
  'llm-deepseek': { config: { baseURL: 'https://api.deepseek.com/anthropic' } },
  'session-log-deepseek': { disabled: true },
  'plugin-package-inventory-deepseek': { disabled: true },
  'session-telemetry-otel': { disabled: true },
  'plugin-manager': { disabled: true },
  'tool-plugin-manager': { disabled: true },
  'deepseek-account': { disabled: true },
  'llm-deepseek-account': { disabled: true },
  'llm-pi-ai': { disabled: true },
  'goal-round-driver': { disabled: true },
  'tool-jobs': { config: { completionDelivery: 'quiet' } },
  permission: { config: { defaultPreset: 'danger-full-access' } },
  'ptc-runtime': { disabled: true },
  'sandbox-policy': { config: { mode: 'danger-full-access' } },
  approval: { config: { policy: 'never' } },
  'nassaj-policy': {},
});

const unquote = (value) => value.trim().replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1');

/**
 * The rows of `dsh … --dump-config` (top-level `- id:` entries; `disabled`, `name` and
 * one-line `config` scalars).
 * @param {string} text
 * @returns {{ rows: Array<{ id: string, name?: string, disabled?: boolean, config: Record<string, string> }> }}
 */
export function parseDumpConfig(text) {
  const rows = [];
  let row = null;
  let inConfig = false;
  for (const line of String(text).split('\n')) {
    const start = /^- id: (.+)$/.exec(line);
    if (start) { row = { id: unquote(start[1]), config: {} }; rows.push(row); inConfig = false; continue; }
    if (!row) continue;
    const top = /^ {2}([A-Za-z]+):(.*)$/.exec(line);
    if (top) {
      inConfig = top[1] === 'config';
      if (top[1] === 'disabled') row.disabled = top[2].trim() === 'true';
      if (top[1] === 'name') row.name = unquote(top[2]);
      continue;
    }
    const nested = inConfig ? /^ {4}([A-Za-z]+): (.+)$/.exec(line) : null;
    if (nested) row.config[nested[1]] = unquote(nested[2]);
  }
  return { rows };
}

/** The security row ids missing from a composed tree. */
export function checkSecurityRows(dump) {
  const ids = new Set((dump?.rows ?? []).map((row) => row.id));
  return DSH_SECURITY_ROWS.filter((id) => !ids.has(id));
}

/** Every security row whose state differs from DSH_SECURITY_EXPECTATIONS (`id.key`), missing rows included. */
export function checkSecurityRowsSemantic(dump) {
  const byId = new Map((dump?.rows ?? []).map((row) => [row.id, row]));
  const problems = [];
  for (const [id, expected] of Object.entries(DSH_SECURITY_EXPECTATIONS)) {
    const row = byId.get(id);
    if (!row) { problems.push(`${id}: missing`); continue; }
    if (expected.disabled === true && row.disabled !== true) problems.push(`${id}.disabled`);
    for (const [key, value] of Object.entries(expected.config ?? {})) if (row.config?.[key] !== value) problems.push(`${id}.config.${key}`);
  }
  return problems;
}

/** Top-level rows of a patch layer text, by id (insert blocks keyed `insert:<ids>`). */
function layerRows(text) {
  const rows = new Map();
  let key = null;
  for (const line of text.split('\n')) {
    const id = /^- id: (.+)$/.exec(line);
    if (id) key = id[1].trim();
    else if (/^- insert:/.test(line)) key = `insert:${rows.size}`;
    else if (/^\S/.test(line) && !line.startsWith('#')) key = null;
    if (key) rows.set(key, `${rows.get(key) ?? ''}${line}\n`);
  }
  return rows;
}

/**
 * The offline-contract test layer: the pinned production layer with ONLY the llm-deepseek
 * row's baseURL pointed at the local fake LLM. changedRows is computed, not asserted here.
 * @param {string} production the pinned server/governance/dsh-nassaj-layer.yml text
 * @param {string} origin e.g. http://127.0.0.1:47000/anthropic
 */
export function buildDshTestLayer(production, origin) {
  const text = production.replace('baseURL: https://api.deepseek.com/anthropic', `baseURL: ${origin}`);
  const before = layerRows(production);
  const after = layerRows(text);
  const changedRows = [...new Set([...before.keys(), ...after.keys()])].filter((key) => before.get(key) !== after.get(key));
  return { text: `# T-2091 TEST LAYER — offline contract suite only; refused by prepareDshLaunch (pin).\n${text}`, changedRows };
}

const PLUGIN_PACKAGE = fileURLToPath(new URL('../../governance/dsh-policy-plugin/package.json', import.meta.url));

/** semver tuple; prerelease sorts before its release. */
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(text).trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
}
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/**
 * null when the policy plugin's engines.dsh range (">=x <y" form, prereleases included as dsh
 * compares them) admits `version`, else the
 * code that holds an update: dsh would disable the plugin row and every launch would be refused.
 */
export function checkPluginEngines(version, range = JSON.parse(fs.readFileSync(PLUGIN_PACKAGE, 'utf8')).engines?.dsh) {
  const v = parseVersion(version);
  if (!v || typeof range !== 'string') return 'dsh_plugin_engines_incompatible';
  // dsh compares with prereleases included (measured T-2091: 0.2.2-rc.1 satisfies ">=0.2.1 <1.0.0").
  for (const part of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
    const bound = m ? parseVersion(m[2]) : null;
    if (!bound) return 'dsh_plugin_engines_incompatible';
    const c = compare(v, bound);
    const ok = { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0 }[m[1] ?? '='];
    if (!ok) return 'dsh_plugin_engines_incompatible';
  }
  return null;
}
