/**
 * ADR-226 (supersedes ADR-221 L2 and its ACK): what an OpenCode child needs so the shared
 * Claude-parity engine decides every tool call.
 *
 *  - the channel-client plugin in a content-addressed, read-only directory that holds only
 *    the plugin file, verified on every spawn; its sha256 is the digest the hello must carry;
 *  - L1 `OPENCODE_PERMISSION` = `{"*":"allow"}` + Claude's deny rules (+ the plan block): the
 *    engine asks and decides, so OpenCode must not auto-reject on its own (external_directory,
 *    doom_loop), and Claude's deny rules stay a second layer;
 *  - the child env, applied after every sanitize/endpoint step: the plugin FIRST in the inline
 *    config (a plugin before it could show it decoy args, stage 0 item 6), `lsp:false` and
 *    `formatter:false` (Claude runs neither), OPENCODE_DISABLE_LSP_DOWNLOAD=1, OPENCODE_PURE and
 *    every OPENCODE_EXPERIMENTAL_* / OPENCODE_ENABLE_* variable removed (code mode would bypass
 *    the hook), and — owner decision D2 — project config off on every spawn;
 *  - the `nassaj:<code>:` marker a refused tool call carries.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as databaseModule from '@/modules/database/index.js';
import { collectClaudePermissionRules } from '@/services/isolation/claude-permission-rules.js';
import { readClaudeSpawnSettings } from '@/services/isolation/claude-spawn-settings.js';
import { OPENCODE_DISABLE_PROJECT_CONFIG_ENV } from '@/services/isolation/opencode-baseurl-guard.js';
import { emitOpenCodeRules } from '@/services/isolation/opencode-rule-emitter.js';

export const PARITY_CODES = Object.freeze({
  denied: 'permission_denied_by_claude_rule',
  policy: 'PERMISSION_EFFECTIVE_POLICY_REQUIRED',
  unavailable: 'opencode_parity_unavailable',
  notLoaded: 'opencode_parity_not_loaded',
  selftestFailed: 'opencode_parity_selftest_failed',
  selftestUnavailable: 'opencode_parity_selftest_unavailable',
});

/**
 * Owner decision D2 (recommended: yes, awaiting the owner): OPENCODE_DISABLE_PROJECT_CONFIG=1
 * on EVERY OpenCode spawn, not only the carrier/local branch. It closes project plugins,
 * tools, commands, agents and opencode.json at read time. Flip to `false` to let legacy
 * spawns load project config again (their unknown tools are still denied by the engine, but a
 * project plugin's load-time code is not stopped).
 */
export const OPENCODE_PROJECT_CONFIG_OFF_FOR_EVERY_SPAWN = true;

const PLUGIN_NAME = 'nassaj-claude-parity.js';
const PLUGIN_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '../../../../assets/opencode', PLUGIN_NAME);
const MANAGED = 'managed policy settings';
const TOOL_ERROR_MARK = /nassaj:(permission_denied_by_claude_rule|opencode_parity_unavailable):/;
/** Env families stripped from the child (stage 0 item 10 lists the 1.19.5 members). */
const STRIPPED_ENV = /^OPENCODE_(EXPERIMENTAL|ENABLE)_|^OPENCODE_EXPERIMENTAL$|^OPENCODE_PURE$|^NASSAJ_OPENCODE_PARITY_/;

/** A refusal carrying the error code the client shows. */
export class OpenCodeParityRefusal extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * nassaj's own directory for parity material (outside /tmp). It lives under the
 * SERVER process's home / XDG_STATE_HOME, shared by every member's turns, not under a
 * member's home.
 */
export function parityRoot(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'nassaj', 'opencode-parity');
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** True when `dir` holds exactly the plugin file with the expected content. */
function pluginDirIntact(dir: string, source: Buffer): boolean {
  try {
    const names = fs.readdirSync(dir);
    return names.length === 1 && names[0] === PLUGIN_NAME
      && fs.readFileSync(path.join(dir, PLUGIN_NAME)).equals(source);
  } catch {
    return false;
  }
}

/** Writes the plugin into a fresh staging dir and moves it to `dir` (first writer wins). */
function stagePluginDir(root: string, dir: string, source: Buffer): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(root, '.staging-'));
  // Owner-only directory, read-only file. Not a config dir (opencode never writes
  // here); integrity is the per-spawn check, not the mode bits.
  fs.writeFileSync(path.join(staging, PLUGIN_NAME), source, { mode: 0o444 });
  try {
    fs.renameSync(staging, dir);
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The content-addressed plugin directory, created on first use and re-verified on
 * every call: exactly one file, the plugin, byte-equal to the shipped source. `hash` is the
 * plugin digest the hello must carry.
 * I1 (self-heal): a directory that is not intact (any same-uid process can drop a
 * file into it) is renamed to a quarantine name, audited and staged again, so one
 * stray file cannot stop OpenCode for every member. Refuses only if re-staging fails.
 * @returns {{ dir: string, file: string, hash: string }}
 */
export function ensureParityPluginDir(root: string = parityRoot(), sourceFile: string = PLUGIN_SOURCE) {
  const source = fs.readFileSync(sourceFile);
  const hash = sha256(source);
  const dir = path.join(root, `nassaj-parity-${hash.slice(0, 32)}`);
  const file = path.join(dir, PLUGIN_NAME);
  if (!fs.existsSync(dir)) stagePluginDir(root, dir, source);
  if (pluginDirIntact(dir, source)) return { dir, file, hash };
  const quarantine = `${dir}.quarantine-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(dir, quarantine);
  } catch { /* gone or unmovable: re-staging below decides */ }
  databaseModule.auditLogDb?.record('opencode_parity_plugin_quarantined', {
    metadata: { engine: 'opencode', pluginHash: hash.slice(0, 32), quarantine: path.basename(quarantine) },
  });
  console.warn('[OpenCode] parity plugin dir was not intact; quarantined and re-staged', {
    code: 'opencode_parity_plugin_quarantined', quarantine: path.basename(quarantine),
  });
  if (!fs.existsSync(dir)) stagePluginDir(root, dir, source);
  if (!pluginDirIntact(dir, source)) {
    throw new OpenCodeParityRefusal(PARITY_CODES.unavailable, 'The OpenCode parity plugin directory is not intact.');
  }
  return { dir, file, hash };
}

/**
 * L1 for this turn: `{"*":"allow"}`, then Claude's deny rules OpenCode can express, then the
 * plan block. Ask rules and rules L1 cannot express are the engine's alone (it refuses what
 * it cannot enforce), so they are not translated here; an unreadable source refuses.
 * @param claudeEnv Claude's spawn env for the member, or null (managed rules only)
 */
export function prepareOpenCodeL1(input: {
  claudeMode: string;
  claudeEnv: NodeJS.ProcessEnv | null;
  cwd: string | null;
  userId: string | number | null;
  disallowedTools?: unknown[];
  managedSettingsDir?: string;
}): string {
  const ctx = { userId: input.userId, managedSettingsDir: input.managedSettingsDir };
  let sources = readClaudeSpawnSettings(input.claudeEnv ?? { HOME: os.homedir() }, input.cwd, ctx);
  if (!input.claudeEnv) sources = sources.filter((s) => s.label === MANAGED);
  const { rules, unreadable } = collectClaudePermissionRules(sources, { disallowedTools: input.disallowedTools ?? [] });
  if (unreadable.length) {
    throw new OpenCodeParityRefusal(PARITY_CODES.policy, `Claude settings cannot be read: ${unreadable.join(', ')}.`);
  }
  return JSON.stringify(emitOpenCodeRules({ plan: input.claudeMode === 'plan', rules }));
}

/** The inline config nassaj already built (or a new one); throws when it is not a JSON object. */
function readInlineConfig(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  let inline: unknown;
  try {
    inline = JSON.parse(text);
  } catch {
    inline = null;
  }
  if (!inline || typeof inline !== 'object' || Array.isArray(inline)) {
    throw new OpenCodeParityRefusal(PARITY_CODES.unavailable, 'The OpenCode inline config is not a JSON object.');
  }
  return inline as Record<string, unknown>;
}

/**
 * The child env for the turn. Applied last, after every sanitize and endpoint guard.
 * @param parity `l1Text` from prepareOpenCodeL1, `pluginFile` from ensureParityPluginDir
 */
export function applyOpenCodeParityEnv(
  env: NodeJS.ProcessEnv,
  parity: { l1Text: string; pluginFile: string },
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!STRIPPED_ENV.test(key)) next[key] = value;
  const inline = readInlineConfig(next.OPENCODE_CONFIG_CONTENT);
  const ours = pathToFileURL(parity.pluginFile).href;
  const others = (Array.isArray(inline.plugin) ? inline.plugin : []).filter((entry) => entry !== ours);
  inline.plugin = [ours, ...others];
  inline.lsp = false;
  inline.formatter = false;
  next.OPENCODE_CONFIG_CONTENT = JSON.stringify(inline);
  next.OPENCODE_PERMISSION = parity.l1Text;
  next.OPENCODE_DISABLE_LSP_DOWNLOAD = '1';
  if (OPENCODE_PROJECT_CONFIG_OFF_FOR_EVERY_SPAWN) next[OPENCODE_DISABLE_PROJECT_CONFIG_ENV] = '1';
  return next;
}

/** The parity code carried by a refused tool call's error text, or null. */
export function parityToolErrorCode(content: unknown): string | null {
  return typeof content === 'string' ? (TOOL_ERROR_MARK.exec(content)?.[1] ?? null) : null;
}

/** User-facing text per parity code (the client shows its own localised text by code). */
export const PARITY_ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  [PARITY_CODES.denied]: 'OpenCode tried an action that Claude\'s permission rules forbid or you did not approve; it was blocked.',
  [PARITY_CODES.unavailable]: 'nassaj\'s permission channel was not available, so every tool was blocked.',
});

const mcpNamesOf = (config: unknown): string[] => {
  const mcp = (config as { mcp?: unknown } | null)?.mcp;
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return [];
  return Object.entries(mcp as Record<string, unknown>)
    .filter(([, entry]) => (entry as { enabled?: unknown } | null)?.enabled !== false)
    .map(([name]) => name);
};

/**
 * ADR-226 M1: the MCP server names one spawn configures — the member's config file
 * (`<configHome>/opencode.json`, or `.jsonc` when it is plain JSON) and nassaj's inline
 * config — so the engine can split `<server>_<tool>` names. A server with `enabled: false`
 * is not listed; project config is never read on a nassaj spawn (D2). A file that does not
 * parse contributes nothing: its tools then match no server and are denied (fail-closed).
 * @param configHome the child's `$XDG_CONFIG_HOME/opencode`
 * @param inlineConfig the child's OPENCODE_CONFIG_CONTENT, if any
 */
export function configuredOpenCodeMcpServers(configHome: string, inlineConfig?: string): string[] {
  const names = new Set<string>();
  const texts = ['opencode.json', 'opencode.jsonc'].map((file) => {
    try {
      return fs.readFileSync(path.join(configHome, file), 'utf8');
    } catch {
      return null;
    }
  });
  for (const text of [...texts, inlineConfig ?? null]) {
    if (text === null) continue;
    try {
      for (const name of mcpNamesOf(JSON.parse(text))) names.add(name);
    } catch { /* not plain JSON: nothing from it */ }
  }
  return [...names].sort();
}
