/**
 * claude-hooks — the hooks Claude loads for one spawn, provider-neutral (T-2089 S3,
 * ADR-225). Moved here from dsh-permission-parity (T-2086, f83892259) so the pre-spawn
 * check and the hook runner read hooks the same way Claude does: settings `hooks`, and
 * every enabled plugin (its hooks/hooks.json and its manifest `hooks`, inline or by path).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude hook events that can stop a tool call or a prompt before it runs. */
export const BLOCKING_HOOK_EVENTS = Object.freeze(['PreToolUse', 'UserPromptSubmit', 'PermissionRequest']);

/**
 * The state of one Claude `hooks` value: 'none', 'blocking', or 'malformed'
 * (anything Claude might read as a hook but this check cannot read as none).
 */
export function hookState(hooks) {
  if (hooks === undefined || hooks === null) return 'none';
  if (typeof hooks !== 'object' || Array.isArray(hooks)) return 'malformed';
  let state = 'none';
  for (const [event, value] of Object.entries(hooks)) {
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) return 'malformed';
    if (value.length > 0 && BLOCKING_HOOK_EVENTS.includes(event)) state = 'blocking';
  }
  return state;
}

/** Parsed JSON at `file`, undefined when absent; throws when unreadable or malformed. */
export function readJsonIfPresent(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text);
}

/** The hooks object of a hooks document (`{ hooks: {...} }` or the events themselves). */
const hooksOf = (doc) => (doc && typeof doc === 'object' && !Array.isArray(doc) && 'hooks' in doc ? doc.hooks : doc);

/** Every hooks value one installed plugin declares; throws when it cannot be read. */
export function pluginHookValues(installPath) {
  const values = [];
  const hooksFile = readJsonIfPresent(path.join(installPath, 'hooks', 'hooks.json'));
  if (hooksFile !== undefined) values.push(hooksOf(hooksFile));
  const declared = readJsonIfPresent(path.join(installPath, '.claude-plugin', 'plugin.json'))?.hooks;
  for (const entry of declared === undefined ? [] : [].concat(declared)) {
    if (typeof entry !== 'string') {
      values.push(hooksOf(entry));
      continue;
    }
    const file = path.resolve(installPath, entry);
    if (path.relative(installPath, file).startsWith('..')) throw new Error('plugin hooks path escapes the plugin');
    const doc = readJsonIfPresent(file);
    if (doc === undefined) throw new Error('plugin hooks file missing');
    values.push(hooksOf(doc));
  }
  return values;
}

/** Plugin ids enabled (`true`) in any loaded source. */
export function enabledPluginIds(sources) {
  const enabled = new Set();
  for (const { status, settings } of sources) {
    const plugins = status === 'ok' ? settings?.enabledPlugins : null;
    if (plugins && typeof plugins === 'object') {
      for (const [id, on] of Object.entries(plugins)) if (on === true) enabled.add(id);
    }
  }
  return enabled;
}

/**
 * Install paths of every enabled plugin; throws when one is not installed or unreadable.
 * @returns {Array<{ id: string, installPath: string }>}
 */
export function enabledPluginInstalls(sources, env) {
  const enabled = enabledPluginIds(sources);
  if (enabled.size === 0) return [];
  const configDir = env?.CLAUDE_CONFIG_DIR || path.join(env?.HOME || os.homedir(), '.claude');
  const installed = readJsonIfPresent(path.join(configDir, 'plugins', 'installed_plugins.json'))?.plugins;
  return [...enabled].flatMap((id) => {
    const installs = installed?.[id];
    if (!Array.isArray(installs) || installs.length === 0) throw new Error(`plugin ${id} is not installed`);
    return installs.map((install) => {
      if (typeof install?.installPath !== 'string') throw new Error(`plugin ${id} has no install path`);
      return { id, installPath: install.installPath };
    });
  });
}

/** True when every plugin enabled in `sources` is proven free of blocking hooks. */
export function pluginsFreeOfBlockingHooks(sources, env) {
  try {
    return enabledPluginInstalls(sources, env)
      .every(({ installPath }) => pluginHookValues(installPath).every((value) => hookState(value) === 'none'));
  } catch {
    return false;
  }
}
