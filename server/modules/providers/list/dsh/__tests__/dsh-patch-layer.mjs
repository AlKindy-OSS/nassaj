/**
 * dsh-patch-layer — test-only reader for the dsh loader patch subset that the
 * T-2086 acceptance suite cares about (ADR-224).
 *
 * A dsh profile is composed as an ordered list of patch layers: bundle defaults,
 * then <DSH_HOME>/profiles/<name>/cordis.patch.yml (the user layer), then each
 * `--patch` overlay in argv order. Later layers win per entry id. This module
 * reads only the keys the governance contract pins (`disabled`, `config.enabled`,
 * `config.baseURL`) from either JSON (valid YAML) or the block-YAML subset used by
 * the fixtures, and composes them with the same last-wins rule real dsh applied
 * in the 2026-11-07 recording (fixtures/dsh-acp-recording.json).
 */

import fs from 'node:fs';

/** Official DeepSeek Anthropic-compatible root (dsh's own default). */
export const DSH_PUBLIC_BASE_URL = 'https://api.deepseek.com/anthropic';

/** Rows whose uploads the Nassaj layer must switch off. */
export const DSH_UPLOAD_ROWS = Object.freeze(['session-log-deepseek', 'plugin-package-inventory-deepseek']);
export const DSH_TELEMETRY_ROW = 'session-telemetry-otel';
export const DSH_LLM_ROW = 'llm-deepseek';

const scalar = (raw) => {
  const value = raw.trim().replace(/^['"]|['"]$/g, '');
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

/** Parses one layer into `[{ id, disabled?, enabled?, baseURL? }]`; unknown keys are ignored. */
export function parsePatchLayer(text) {
  const trimmed = text.replace(/^\s*#.*$/gm, '').trim();
  if (trimmed === '' || trimmed === '[]') return [];
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed).map((entry) => ({
      id: entry.id,
      ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
      ...(entry.config?.enabled === undefined ? {} : { enabled: entry.config.enabled }),
      ...(entry.config?.baseURL === undefined ? {} : { baseURL: entry.config.baseURL }),
    }));
  }
  const entries = [];
  for (const line of trimmed.split('\n')) {
    const item = /^-\s+id:\s*(.+)$/.exec(line);
    if (item) { entries.push({ id: scalar(item[1]) }); continue; }
    const field = /^\s+(disabled|enabled|baseURL):\s*(.+)$/.exec(line);
    if (field && entries.length > 0) entries[entries.length - 1][field[1]] = scalar(field[2]);
  }
  return entries;
}

/** Reads a layer file; a missing file is an empty layer. */
export function readPatchLayer(file) {
  try {
    return parsePatchLayer(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Composes layers over the shipped acp defaults. `env` supplies the two inputs
 * real dsh reads at boot: DEEPSEEK_BASE_URL (baseURL fallback) and
 * DSH_TELEMETRY_DISABLED (any non-empty value disables the telemetry row).
 * @returns {{ sessionLog: boolean, pluginPackages: boolean, telemetry: boolean, baseURL: string }}
 */
export function composeDshLayers(layers, env = {}) {
  const rows = new Map([
    ['session-log-deepseek', { disabled: false, enabled: true }],
    ['plugin-package-inventory-deepseek', { disabled: false, enabled: true }],
    [DSH_TELEMETRY_ROW, { disabled: false }],
    [DSH_LLM_ROW, {}],
  ]);
  for (const layer of layers) {
    for (const entry of layer) {
      const row = rows.get(entry.id);
      if (!row) continue;
      for (const key of ['disabled', 'enabled', 'baseURL']) if (entry[key] !== undefined) row[key] = entry[key];
    }
  }
  const on = (id) => {
    const row = rows.get(id);
    return row.disabled !== true && row.enabled !== false;
  };
  const telemetryOff = typeof env.DSH_TELEMETRY_DISABLED === 'string' && env.DSH_TELEMETRY_DISABLED !== '';
  return {
    sessionLog: on('session-log-deepseek'),
    pluginPackages: on('plugin-package-inventory-deepseek'),
    telemetry: !telemetryOff && on(DSH_TELEMETRY_ROW),
    baseURL: rows.get(DSH_LLM_ROW).baseURL ?? env.DEEPSEEK_BASE_URL ?? DSH_PUBLIC_BASE_URL,
  };
}
