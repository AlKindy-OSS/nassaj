/**
 * dsh-local-layer — the per-turn patch layer of a local DSH turn (ADR-227 "DSH
 * local corrector", T-2108). Still ONE `--patch`, last: generated from the bytes
 * of the shipped Nassaj layer that were verified against its sha256 pin in memory
 * (dsh-launch.js readVerifiedNassajDshLayer), as an object, then serialized with
 * JSON.stringify (JSON is valid YAML), never by string templates. The intended
 * difference from the shipped layer, and nothing else:
 *   - `llm-deepseek` points at the turn's corrector (loopback), reads its key from
 *     NASSAJ_DSH_LOCAL_TOKEN, and lists the one local model;
 *   - the model rows (`agent-default-model`, `acp`, the compaction summarizer) name
 *     the local model id, so no request names a DeepSeek model;
 *   - `web-search-deepseek` and `web-deepseek-api` are disabled (vendor origins
 *     carrying DEEPSEEK_API_KEY; T-2108 qa condition 2);
 *   - the policy plugin row names the plugin by its ABSOLUTE verified path, because
 *     dsh resolves a relative name against the layer's directory (qa condition 1).
 *
 * The file is written once (O_EXCL | O_NOFOLLOW, 0600) into a 0700 per-run
 * directory under a nassaj-owned root outside every member tree, and the directory
 * is removed when the turn ends. A boot sweep removes directories of dead servers.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';

import { DSH_LAUNCH_ERROR, DshLaunchError } from './dsh-launch.js';

/** The variable DSH reads the corrector token from (`apiKeyEnv`). */
export const DSH_LOCAL_TOKEN_ENV = 'NASSAJ_DSH_LOCAL_TOKEN';
/** The model group the local model is listed in (the llm-deepseek provider's id). */
export const DSH_LOCAL_MODEL_GROUP = 'deepseek-official';
/** Rows with a vendor origin that a local turn turns off (dump-config inventory, 0.2.2-rc.1). */
export const DSH_LOCAL_DISABLED_ROWS = Object.freeze(['web-search-deepseek', 'web-deepseek-api']);
/** The generated layer's file name inside its run directory. */
export const DSH_LOCAL_LAYER_FILE = 'nassaj-local-layer.yml';

const LLM_ROW = 'llm-deepseek';
const POLICY_ROW = 'nassaj-policy';

/**
 * The rows a local turn sets, keyed by id, in the order they are appended.
 * @param {{ baseURL: string, model: string, contextWindow: number, maxTokens: number }} input
 * @returns {Map<string, object>}
 */
function localRows({ baseURL, model, contextWindow, maxTokens }) {
  const route = { provider: DSH_LOCAL_MODEL_GROUP, model };
  return new Map([
    [LLM_ROW, { id: LLM_ROW, config: {
      baseURL, apiKeyEnv: DSH_LOCAL_TOKEN_ENV, maxTokens, defaultContextWindow: contextWindow,
      models: [{ id: model, name: model, contextWindow, maxTokens }],
    } }],
    ['agent-default-model', { id: 'agent-default-model', config: route }],
    ['acp', { id: 'acp', config: route }],
    ['compaction-basic', { id: 'compaction-basic', config: {
      summarizationProvider: DSH_LOCAL_MODEL_GROUP, summarizationModel: model, headroomTokens: maxTokens,
    } }],
    ...DSH_LOCAL_DISABLED_ROWS.map((id) => [id, { id, disabled: true }]),
  ]);
}

/**
 * The shipped rows, or a LAYER_UNTRUSTED refusal when they are not the expected shape.
 * @param {string} shippedText verified bytes of the shipped layer
 * @returns {Array<Record<string, any>>}
 */
function shippedRows(shippedText) {
  const rows = parse(shippedText);
  const valid = Array.isArray(rows) && rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))
    && rows.some((row) => row.id === LLM_ROW)
    && rows.some((row) => Array.isArray(row.insert) && row.insert.some((entry) => entry?.id === POLICY_ROW));
  if (!valid) throw new DshLaunchError(DSH_LAUNCH_ERROR.LAYER_UNTRUSTED, 'The Nassaj dsh patch layer is not in its expected shape.');
  return rows;
}

/**
 * Builds the rows of a local turn's layer from the verified shipped layer.
 * @param {string} shippedText verified bytes of the shipped layer
 * @param {{ baseURL: string, model: string, contextWindow: number, maxTokens: number,
 *   pluginEntry: string }} input `pluginEntry` is the absolute path of the verified plugin entry
 * @returns {Array<Record<string, any>>}
 */
export function buildDshLocalLayer(shippedText, input) {
  if (!path.isAbsolute(input.pluginEntry)) {
    throw new DshLaunchError(DSH_LAUNCH_ERROR.POLICY_PLUGIN_UNTRUSTED, 'The dsh policy plugin path is not absolute.');
  }
  const overrides = localRows(input);
  const out = [];
  for (const row of shippedRows(shippedText)) {
    if (Array.isArray(row.insert)) {
      out.push(...overrides.values());
      overrides.clear();
      out.push({ ...row, insert: row.insert.map((entry) => (entry?.id === POLICY_ROW ? { ...entry, name: input.pluginEntry } : entry)) });
    } else if (overrides.has(row.id)) {
      out.push(overrides.get(row.id));
      overrides.delete(row.id);
    } else {
      out.push(row);
    }
  }
  return [...out, ...overrides.values()];
}

/**
 * The nassaj-owned root of local DSH run directories (outside every member tree).
 * @param {string} [home] the nassaj process home
 * @returns {string}
 */
export function dshLocalRunsRoot(home = os.homedir()) {
  return path.join(home, '.nassaj-dsh-local-runs');
}

/**
 * Makes `dir` a real 0700 directory owned by this process; a symlink or a foreign
 * owner is refused, never followed.
 * @param {string} dir
 */
function ensurePrivateRoot(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new DshLaunchError(DSH_LAUNCH_ERROR.HOME_NOT_DIRECTORY, 'The local dsh run directory cannot be prepared.');
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * Writes the layer once into a fresh per-run directory.
 * @param {Array<object>} rows
 * @param {{ root: string, runId: string }} target
 * @returns {{ dir: string, file: string }}
 */
export function writeDshLocalLayer(rows, { root, runId }) {
  ensurePrivateRoot(root);
  const dir = path.join(root, `${process.pid}-${runId}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, DSH_LOCAL_LAYER_FILE);
  try {
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
    const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(rows)}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, file };
}

/** Removes a run directory; a missing one is fine. */
export function removeDshLocalRun(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** True while `pid` names a live process. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Boot sweep: removes the run directories of servers that are no longer running.
 * @param {string} [root]
 * @returns {number} directories removed
 */
export function sweepStaleDshLocalRuns(root = dshLocalRunsRoot()) {
  let entries = [];
  try {
    // A symlink or a non-directory root is never followed (qa HIGH 3).
    if (!fs.lstatSync(root).isDirectory()) return 0;
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const match = /^(\d+)-./u.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || alive(pid)) continue;
    removeDshLocalRun(path.join(root, name));
    removed += 1;
  }
  return removed;
}
