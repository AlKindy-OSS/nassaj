/**
 * claude-hook-runner — runs Claude's command hooks for a non-Claude harness exactly as
 * Claude Code does (T-2089 S3, ADR-225). Provider-neutral.
 *
 * Claude semantics mirrored:
 *  - matcher: empty, `*` or absent matches every tool; otherwise an anchored regex;
 *  - the hook gets Claude's JSON payload on stdin and runs through /bin/sh with the
 *    member's Claude env (same HOME as his Claude launch), CLAUDE_PROJECT_DIR, and
 *    CLAUDE_PLUGIN_ROOT for plugin hooks; host secrets are stripped last;
 *  - `timeout` is in seconds (default 60); matching hooks of one event run in parallel;
 *  - exit 2 blocks with stderr as the reason; any other failure (non-zero exit, crash,
 *    timeout) is a non-blocking error reported as a notice;
 *  - exit 0 JSON: `continue:false`, `decision:"block"`, hookSpecificOutput
 *    permissionDecision / decision.behavior / additionalContext; for UserPromptSubmit plain
 *    stdout is context.
 * Nassaj-stricter rules: a hook that rewrites input (updatedInput) is refused; a hook whose
 * output exceeds the cap blocks; a timeout (or the output cap) kills the hook's process group; hooks never
 * run in tmpfs (cwd refused, TMPDIR moved to /var/tmp); a concurrency cap applies.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { sanitizeHostSecretEnv } from '../isolation/sanitize-vendor-agent-env.js';
import { enabledPluginInstalls, pluginHookValues } from './claude-hooks.js';

export const HOOK_CODES = Object.freeze({
  typeUnsupported: 'parity_hook_type_unsupported',
  sourceUnreadable: 'parity_hook_source_unreadable',
  malformed: 'parity_hook_malformed',
  tmpfs: 'parity_hook_tmpfs',
});
const DEFAULT_TIMEOUT_S = 60;
const MANAGED_LABEL = 'managed policy settings';
const STDOUT_CAP = 1024 * 1024;
const SAFE_TMPDIR = '/var/tmp';

/** A launch-time refusal of the hook runner. */
export class HookRefusal extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'HookRefusal';
    this.code = code;
  }
}

/** Claude's matcher test. */
export function matcherMatches(matcher, name) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(name);
  } catch {
    return matcher === name;
  }
}

/** Adds one hooks value (`{ Event: [{ matcher, hooks: [...] }] }`) to `into`. */
function addHooks(into, value, pluginRoot) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw new HookRefusal(HOOK_CODES.malformed, 'A hooks value is malformed.');
  for (const [event, groups] of Object.entries(value)) {
    if (groups === undefined || groups === null) continue;
    if (!Array.isArray(groups)) throw new HookRefusal(HOOK_CODES.malformed, `Hooks for ${event} are malformed.`);
    for (const group of groups) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : [null]) {
        if (hook?.type !== 'command' || typeof hook.command !== 'string') {
          throw new HookRefusal(HOOK_CODES.typeUnsupported, `A ${event} hook of type "${hook?.type}" cannot run outside Claude.`);
        }
        const timeout = Number.isFinite(hook.timeout) && hook.timeout > 0 ? hook.timeout : DEFAULT_TIMEOUT_S;
        (into[event] ??= []).push({ matcher: group.matcher, command: hook.command, timeout, pluginRoot });
      }
    }
  }
}

/**
 * Every command hook Claude loads for these sources: settings, then enabled plugins.
 * @param {Array<{ status: string, settings: object|null }>} sources readClaudeSpawnSettings()
 * @param {NodeJS.ProcessEnv} env Claude's env for the member (plugin registry location)
 * @returns {Record<string, Array<{ matcher?: string, command: string, timeout: number, pluginRoot: string|null }>>}
 */
export function collectClaudeHooks(sources, env) {
  const loaded = sources.filter((source) => source.status === 'ok');
  const hooks = {};
  // allowManagedHooksOnly (managed policy): only managed hooks run, no user/project/plugin hook.
  const managedOnly = loaded.some((s) => s.label === MANAGED_LABEL && s.settings?.allowManagedHooksOnly === true);
  for (const { label, settings } of loaded) {
    if (!managedOnly || label === MANAGED_LABEL) addHooks(hooks, settings?.hooks, null);
  }
  if (managedOnly) return hooks;
  let installs;
  try {
    installs = enabledPluginInstalls(loaded, env).map((install) => ({ ...install, values: pluginHookValues(install.installPath) }));
  } catch (error) {
    throw new HookRefusal(HOOK_CODES.sourceUnreadable, `An enabled Claude plugin cannot be read: ${error?.message ?? error}.`);
  }
  for (const { installPath, values } of installs) for (const value of values) addHooks(hooks, value, installPath);
  return hooks;
}

/** Mount points of tmpfs filesystems (read once). */
let tmpfsMounts = null;
function isTmpfsPath(file) {
  if (tmpfsMounts === null) {
    try {
      tmpfsMounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n').map((line) => line.split(' '))
        .filter((fields) => fields[2] === 'tmpfs' || fields[2] === 'ramfs').map((fields) => fields[1]);
    } catch { tmpfsMounts = ['/tmp', '/dev/shm']; }
  }
  const resolved = path.resolve(file);
  return tmpfsMounts.some((mount) => mount !== '/' && (resolved === mount || resolved.startsWith(`${mount}/`)));
}

/** A FIFO limiter of `max` concurrent tasks. */
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { task, resolve } = queue.shift();
    task().then(resolve, resolve).finally(() => { active -= 1; next(); });
  };
  return (task) => new Promise((resolve) => { queue.push({ task, resolve }); next(); });
}
const globalSlot = limiter(16);

/** Runs one hook command; resolves to its raw outcome (never rejects). */
function runCommand(hook, payload, { env, cwd, stdoutCap }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', hook.command], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error: String(error?.message ?? error) });
      return;
    }
    const outcome = { stdout: '', stderr: '', oversize: false, timedOut: false };
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { outcome.timedOut = true; killGroup(); }, hook.timeout * 1000);
    child.stdout.on('data', (chunk) => {
      outcome.stdout += chunk;
      if (outcome.stdout.length > stdoutCap) { outcome.oversize = true; killGroup(); }
    });
    child.stderr.on('data', (chunk) => { if (outcome.stderr.length < stdoutCap) outcome.stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { outcome.error = String(error?.message ?? error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ...outcome, code, signal }); // like Claude, a normal close leaves the hook's own children alone
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Classifies a raw outcome: block | ok | error. */
function classify(raw, hook) {
  const label = path.basename(hook.command.split(/\s+/).find((w) => /hooks?\//.test(w)) ?? hook.command.slice(0, 60));
  if (raw.oversize) return { kind: 'block', reason: `Hook ${label} output exceeded ${STDOUT_CAP} bytes; refused.` };
  if (raw.timedOut) return { kind: 'error', notice: `Hook ${label} timed out after ${hook.timeout}s.` };
  if (raw.error || raw.signal || (raw.code !== 0 && raw.code !== 2)) {
    return { kind: 'error', notice: (raw.stderr || raw.error || `Hook ${label} failed (${raw.signal ?? raw.code}).`).trim() };
  }
  if (raw.code === 2) return { kind: 'block', reason: raw.stderr.trim() };
  const text = raw.stdout.trim();
  let json = null;
  if (text.startsWith('{')) { try { json = JSON.parse(text); } catch { json = null; } }
  return { kind: 'ok', json: json && typeof json === 'object' ? json : null, stdout: json ? '' : text };
}

const RANK = { allow: 1, ask: 2, deny: 3 };
/** Keeps the strongest decision (deny > ask > allow); the first reason at that rank wins. */
function stronger(current, decision, reason) {
  if (!decision || (current.decision && RANK[current.decision] >= RANK[decision])) return current;
  return { decision, reason: reason ?? '' };
}

/** PreToolUse: the combined decision of every outcome. */
function combinePreToolUse(outcomes) {
  let best = { decision: null, reason: '' };
  const additionalContext = [];
  const notices = [];
  for (const out of outcomes) {
    if (out.kind === 'error') { notices.push(out.notice); continue; }
    if (out.kind === 'block') { best = stronger(best, 'deny', out.reason); continue; }
    const json = out.json ?? {};
    const specific = json.hookSpecificOutput ?? {};
    if (typeof specific.additionalContext === 'string') additionalContext.push(specific.additionalContext);
    if (json.continue === false) best = stronger(best, 'deny', json.stopReason || 'A hook stopped the turn.');
    if (specific.updatedInput !== undefined) {
      best = stronger(best, 'deny', 'A hook rewrote the tool input (updatedInput); Nassaj refuses rewritten calls.');
    }
    if (['allow', 'ask', 'deny'].includes(specific.permissionDecision)) {
      best = stronger(best, specific.permissionDecision, specific.permissionDecisionReason);
    } else if (json.decision === 'block') best = stronger(best, 'deny', json.reason);
    else if (json.decision === 'approve') best = stronger(best, 'allow', json.reason);
  }
  return { decision: best.decision, ...(best.decision ? { reason: best.reason } : {}), additionalContext, notices };
}

/** UserPromptSubmit / PostToolUse / PostToolBatch: block flag, reason, context. */
function combineBlocking(outcomes, { plainStdoutIsContext }) {
  let reason = null;
  const additionalContext = [];
  const notices = [];
  for (const out of outcomes) {
    if (out.kind === 'error') { notices.push(out.notice); continue; }
    if (out.kind === 'block') { reason ??= out.reason; continue; }
    const json = out.json ?? {};
    const context = json.hookSpecificOutput?.additionalContext;
    if (typeof context === 'string') additionalContext.push(context);
    else if (plainStdoutIsContext && out.stdout) additionalContext.push(out.stdout);
    if (json.decision === 'block') reason ??= json.reason ?? 'Blocked by a hook.';
    if (json.continue === false) reason ??= json.stopReason ?? 'A hook stopped the turn.';
  }
  return { blocked: reason !== null, reason, additionalContext, notices };
}

/** PermissionRequest: allow / deny behavior (deny wins). */
function combinePermissionRequest(outcomes) {
  let best = { decision: null, reason: '' };
  const notices = [];
  for (const out of outcomes) {
    if (out.kind === 'error') { notices.push(out.notice); continue; }
    if (out.kind === 'block') { best = stronger(best, 'deny', out.reason); continue; }
    const behavior = out.json?.hookSpecificOutput?.decision;
    if (behavior?.behavior === 'allow' || behavior?.behavior === 'deny') {
      best = stronger(best, behavior.behavior, behavior.message);
    }
  }
  return { decision: best.decision, ...(best.decision ? { reason: best.reason } : {}), notices };
}

/** The env one hook runs with. */
function hookEnv(base, cwd, pluginRoot) {
  const env = { ...base, CLAUDE_PROJECT_DIR: cwd };
  if (pluginRoot) env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  else delete env.CLAUDE_PLUGIN_ROOT;
  if (!env.TMPDIR || isTmpfsPath(env.TMPDIR)) env.TMPDIR = SAFE_TMPDIR;
  return sanitizeHostSecretEnv(env);
}

/**
 * @param {{ hooks: ReturnType<typeof collectClaudeHooks>, env: NodeJS.ProcessEnv, cwd: string, sessionId: string,
 *   transcriptPath: string, permissionMode: string, maxConcurrent?: number, stdoutCap?: number }} input
 */
export function createClaudeHookRunner({ hooks, env, cwd, sessionId, transcriptPath, permissionMode,
  maxConcurrent = 4, stdoutCap = STDOUT_CAP }) {
  if (isTmpfsPath(cwd)) throw new HookRefusal(HOOK_CODES.tmpfs, 'Claude hooks never run in a tmpfs directory.');
  const slot = limiter(Math.max(1, maxConcurrent));
  // A new dsh session gets its id after session/new: setSession moves later hooks onto it.
  const session = { sessionId, transcriptPath };
  const base = (event, agent) => ({ session_id: session.sessionId, transcript_path: session.transcriptPath, cwd, permission_mode: permissionMode,
    hook_event_name: event, ...(agent?.id ? { agent_id: agent.id, agent_type: agent.type ?? 'general-purpose' } : {}) });

  /** Runs every hook of `event` matching `name` (null: no matcher filter). */
  async function run(event, name, payload) {
    const matching = (hooks[event] ?? []).filter((hook) => name === null || matcherMatches(hook.matcher, name));
    return Promise.all(matching.map((hook) => slot(() => globalSlot(async () => classify(
      await runCommand(hook, payload, { env: hookEnv(env, cwd, hook.pluginRoot), cwd, stdoutCap }), hook)))));
  }
  const tool = (event, { tool_name, tool_input, tool_use_id, agent, ...rest }) => run(event, tool_name,
    { ...base(event, agent), tool_name, tool_input, tool_use_id, ...rest });

  return {
    /** @param {{ sessionId: string, transcriptPath: string }} next */
    setSession: (next) => { Object.assign(session, next); },
    preToolUse: async (call) => combinePreToolUse(await tool('PreToolUse', call)),
    permissionRequest: async (call) => combinePermissionRequest(await tool('PermissionRequest', call)),
    postToolUse: async (call) => {
      const { blocked, ...rest } = combineBlocking(await tool('PostToolUse', call), { plainStdoutIsContext: false });
      return { block: blocked, ...rest };
    },
    postToolBatch: async (batch) => {
      const { blocked, ...rest } = combineBlocking(await run('PostToolBatch', null, { ...base('PostToolBatch'), ...batch }),
        { plainStdoutIsContext: false });
      return { block: blocked, ...rest };
    },
    userPromptSubmit: async ({ prompt }) => {
      const { blocked, reason, ...rest } = combineBlocking(await run('UserPromptSubmit', null,
        { ...base('UserPromptSubmit'), prompt }), { plainStdoutIsContext: true });
      return { blocked, ...(blocked ? { reason } : {}), ...rest };
    },
  };
}

