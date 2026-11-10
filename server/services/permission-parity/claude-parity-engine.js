/**
 * claude-parity-engine — the Claude-policy decision for one tool call of a harness that
 * mirrors Claude (dsh: T-2089 S2, ADR-225; OpenCode: ADR-226). Invariant: Nassaj's
 * decision equals Claude's or is stricter.
 *
 * A harness adapter (dsh-claude-tools.js `dshParityAdapter`, the default;
 * opencode-claude-tools.js `opencodeParityAdapter`) turns the harness call into one or more
 * Claude calls; each is decided, and the call takes the strongest decision (deny > ask >
 * allow). Order per Claude call, with the facts measured on Claude Code 2.1.312
 * (__tests__/fixtures/claude-live/claude-live-measurement.json):
 *   1. arguments not a JSON object, a tool outside the adapter's reviewed map, a field the
 *      map did not review, or an adapter parse failure → deny;
 *   2. a deny rule → deny;
 *   3. Nassaj host rules (nassaj-host-rules.js, the public-page cage) unless an allow rule
 *      covers the call → deny (Claude's canUseTool terms, B-171);
 *   4. plan mode: any non-read tool → deny;
 *   5. an ask rule → ask (also in bypassPermissions: measured);
 *   6. a write into the harness-config sensitive set (`.claude` for every harness; plus
 *      `.opencode`, `opencode.json(c)` and the OpenCode config home on OpenCode) → ask unless
 *      bypassPermissions (measured: Claude asks "sensitive file" even over an allow rule,
 *      and writes it in bypass);
 *   7. bypassPermissions → allow;
 *   8. an allow rule (bash: every compound part) → allow;
 *   9. a tool Claude runs without a prompt → allow;
 *  10. reads inside cwd / additionalDirectories → allow; acceptEdits: edits there → allow;
 *  11. otherwise → ask. An ambiguous MCP name (several server splits) is denied after the
 *      rules of every split were matched.
 * Modes: `auto` is decided as `default` (no equivalent of Claude's classifier: stricter);
 * `dontAsk` turns every ask into a deny (both assumptions until measured, ADR-226 M10).
 * Claude's hooks (claude-hook-runner.js) wrap this order as Claude runs them: PreToolUse
 * first (a block or deny wins with the hook's own reason; its ask asks; its allow is NOT
 * taken as a bypass of rules or mode — stricter, unverified on Claude), then, for a call
 * that would ask, PermissionRequest hooks before any member card.
 * Claude's env comes from claudeSpawnEnvFor (grants honoured, ADR-226 H3); no env → the
 * engine refuses (PERMISSION_EFFECTIVE_POLICY_REQUIRED).
 */
import path from 'node:path';

import { claudeSpawnEnvFor } from '../isolation/claude-spawn-env.js';
import { readClaudeSpawnSettings } from '../isolation/claude-spawn-settings.js';

import { splitBashCommand } from './bash-command-split.js';
import { collectClaudeHooks, createClaudeHookRunner } from './claude-hook-runner.js';
import { bashAllowCovers, ruleCovers } from './claude-rule-match.js';
import { collectParityRules } from './claude-rules.js';
import { DSH_REVIEWED_TOOLS, dshParityAdapter } from './dsh-claude-tools.js';
import { nassajHostRuleDenial } from './nassaj-host-rules.js';
import { insideDirs, pathForms } from './path-rule-match.js';

export { DSH_REVIEWED_TOOLS } from './dsh-claude-tools.js';

export const PARITY_CODES = Object.freeze({
  settingsUnreadable: 'parity_settings_unreadable',
  ruleUnsupported: 'parity_rule_unsupported',
  toolUnreviewed: 'parity_tool_unreviewed',
  modeUnsupported: 'parity_mode_unsupported',
  policy: 'PERMISSION_EFFECTIVE_POLICY_REQUIRED',
});

/** The Claude modes the engine decides (ADR-226 §3). */
export const PARITY_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);

/** A launch-time refusal of the parity engine; `code` is one of PARITY_CODES. */
export class ParityRefusal extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ParityRefusal';
    this.code = code;
  }
}

/** Throws ParityRefusal(parity_tool_unreviewed) unless every name is in the reviewed map. */
export function assertReviewedTools(names, reviewed = DSH_REVIEWED_TOOLS) {
  const unknown = [...names].filter((name) => !Object.hasOwn(reviewed, name));
  if (unknown.length) {
    throw new ParityRefusal(PARITY_CODES.toolUnreviewed, `dsh tool(s) not reviewed for Claude parity: ${unknown.join(', ')}.`);
  }
}

/** Claude's spawn env for the member (claudeSpawnEnvFor: grants honoured); throws as Claude's spawn does. */
export function defaultClaudeEnv(userId) {
  return claudeSpawnEnvFor(userId, process.env);
}

/** Claude's class of a Claude tool, when the adapter did not name one. */
const CLAUDE_CLASS = Object.freeze({ Bash: 'bash', Read: 'read', Glob: 'read', Grep: 'read', Edit: 'edit', Write: 'edit',
  MultiEdit: 'edit', NotebookEdit: 'edit', WebFetch: 'fetch', TodoWrite: 'free', BashOutput: 'free' });
const STRENGTH = Object.freeze({ allow: 0, ask: 1, deny: 2 });

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const verdict = (decision, reason, claude = null) => ({ decision, ...(reason ? { reason } : {}), claude });

/** The paths a Claude read/edit call touches (a glob's absolute literal head included). */
function callPaths(cls, input) {
  if (cls === 'edit' || (cls === 'read' && input.file_path)) return [input.file_path];
  if (cls !== 'read') return [];
  const paths = [input.path];
  if (typeof input.pattern === 'string' && input.pattern.startsWith('/')) {
    paths.push(input.pattern.split(/[*?[{]/)[0] || '/');
  }
  return paths;
}

/** The engine's view of one Claude call from the adapter. */
function engineCall(claudeCall, ctx, shellPath) {
  const input = claudeCall.tool_input;
  const cls = claudeCall.cls ?? CLAUDE_CLASS[claudeCall.tool_name] ?? 'tool';
  const call = { claude: claudeCall.tool_name, cls, input, paths: callPaths(cls, input), ambiguous: claudeCall.ambiguous === true };
  if (cls === 'bash') {
    call.split = splitBashCommand(input.command);
    const cwd = claudeCall.bashCwd ?? ctx.cwd;
    // A relative path after a `cd` is taken from every dir of the chain (stricter than tracking order).
    const bases = [cwd, ...call.split.cdTargets.map((dir) => shellPath(dir, { ...ctx, cwd }))];
    const resolve = (file) => bases.map((dir) => shellPath(file, { ...ctx, cwd: dir }));
    call.bashWrites = call.split.fileWrites.flatMap(resolve);
    call.bashReads = call.split.fileReads.flatMap(resolve);
  }
  return call;
}

/** The strongest rule effect covering the call, with its rule. */
function ruleEffect(rules, call, anchors) {
  for (const effect of ['deny', 'ask']) {
    const rule = rules.find((r) => r.effect === effect && ruleCovers(r, call, anchors));
    if (rule) return { effect, rule };
  }
  const allows = rules.filter((r) => r.effect === 'allow');
  const allowed = call.cls === 'bash' ? bashAllowCovers(allows, call) : allows.some((r) => ruleCovers(r, call, anchors));
  return allowed ? { effect: 'allow', rule: null } : { effect: null, rule: null };
}

/** Whether a path is in the adapter's harness-config sensitive set. */
function inConfigSet(file, configPaths, ctx) {
  const roots = configPaths.roots(ctx).flatMap((root) => Object.values(pathForms(root)));
  const { normal, real } = pathForms(file);
  return [normal, real].some((value) => value.split(path.sep).some((part) => configPaths.segments.includes(part))
    || configPaths.basenames.includes(path.basename(value))
    || roots.some((root) => value === root || value.startsWith(`${root}${path.sep}`)));
}

const sensitiveWrite = (call, configPaths, ctx) => (call.cls === 'edit' && call.paths.some((file) => inConfigSet(file, configPaths, ctx)))
  || (configPaths.bashWrites === true && call.cls === 'bash' && call.bashWrites.some((file) => inConfigSet(file, configPaths, ctx)));

/** Steps 4–11 of the header for a call no deny rule or host rule covers. */
function modeDecision(mode, call, matched, { workingDirs, configPaths, ctx }) {
  if (mode === 'plan' && call.cls !== 'read' && call.cls !== 'free') {
    return ['deny', `Plan mode: ${call.claude} is not a read-only tool.`];
  }
  if (matched.effect === 'ask') return ['ask', `Claude asks before ${call.claude} (${matched.rule.source}: ${matched.rule.raw}).`];
  if (sensitiveWrite(call, configPaths, ctx) && mode !== 'bypassPermissions') return ['ask', `Claude asks before editing a sensitive file.`];
  if (mode === 'bypassPermissions' || matched.effect === 'allow' || call.cls === 'free') return ['allow'];
  const inside = call.paths.length > 0 && call.paths.every((file) => insideDirs(pathForms(file), workingDirs));
  if (inside && (call.cls === 'read' || (call.cls === 'edit' && mode === 'acceptEdits'))) return ['allow'];
  return ['ask', `Claude asks before ${call.claude}.`];
}

/** Claude's env for the member, or a refusal (requireClaudeEnv) / null (managed-only). */
function claudeEnvFor({ userId, claudeEnv = defaultClaudeEnv, requireClaudeEnv = true }) {
  let env = null;
  let failure = null;
  try { env = claudeEnv(userId) ?? null; } catch (error) { failure = error; }
  if (!env && requireClaudeEnv) {
    throw Object.assign(new ParityRefusal(PARITY_CODES.policy, 'The Claude permission policy for this member cannot be built.'),
      failure ? { cause: failure } : {});
  }
  return env;
}

/** Rules and working dirs for one engine; throws ParityRefusal. */
function loadPolicy(input) {
  const { userId, cwd, managedSettingsDir, disallowedTools } = input;
  const env = claudeEnvFor(input);
  const fallbackHome = { HOME: input.home ?? cwd, PATH: '/usr/bin:/bin' };
  const sources = readClaudeSpawnSettings(env ?? fallbackHome, cwd, { userId, managedSettingsDir });
  const loaded = env ? sources : sources.filter((source) => source.label === 'managed policy settings');
  const policy = collectParityRules(loaded, { cwd, disallowedTools });
  if (policy.unreadable.length) {
    throw new ParityRefusal(PARITY_CODES.settingsUnreadable, `Claude settings cannot be read: ${policy.unreadable.join(', ')}.`);
  }
  if (policy.unsupported.length) {
    throw new ParityRefusal(PARITY_CODES.ruleUnsupported,
      `Claude has ${policy.unsupported.length} deny/ask rule(s) parity cannot enforce: ${policy.unsupported.slice(0, 5).join(', ')}.`);
  }
  const hookEnvBase = env ?? fallbackHome;
  return { ...policy, claudeHome: hookEnvBase.HOME, hooks: collectClaudeHooks(loaded, hookEnvBase), hookEnvBase };
}

/** The strongest of several [decision, reason, call] entries (first one wins a tie). */
const strongest = (entries) => entries.reduce((best, entry) => (STRENGTH[entry[0]] > STRENGTH[best[0]] ? entry : best));

/**
 * @param {{ userId: unknown, cwd: string, home: string, sessionId?: string, transcriptPath?: string,
 *   permissionMode: string, managedSettingsDir?: string, claudeEnv?: (userId: unknown) => NodeJS.ProcessEnv|null,
 *   requireClaudeEnv?: boolean, disallowedTools?: unknown[], adapter?: typeof dshParityAdapter,
 *   mcpServers?: string[], harnessEnv?: NodeJS.ProcessEnv }} input `home` is the harness HOME;
 *   `permissionMode` Claude's effective mode; `mcpServers` the MCP servers configured for the spawn;
 *   `harnessEnv` the harness child env (XDG_CONFIG_HOME for the sensitive set)
 * @returns {{ mode: string, adapter: object, decideTool: (call: { callId: string, sessionID?: string, tool: string,
 *   args: unknown, agent?: unknown, mcpServers?: string[], env?: NodeJS.ProcessEnv })
 *   => Promise<{ decision: 'allow'|'deny'|'ask', reason?: string, claude: object|null, claudeCalls?: object[] }> }}
 */
export function createClaudeParityEngine(input) {
  const { cwd, home, permissionMode: mode } = input;
  const adapter = input.adapter ?? dshParityAdapter;
  if (!PARITY_MODES.includes(mode)) {
    throw new ParityRefusal(PARITY_CODES.modeUnsupported, `Claude's "${mode}" mode is not mirrored.`);
  }
  const ruleMode = mode === 'auto' || mode === 'dontAsk' ? 'default' : mode;
  const policy = loadPolicy(input);
  const hooks = createClaudeHookRunner({ hooks: policy.hooks, env: policy.hookEnvBase, cwd, sessionId: input.sessionId,
    transcriptPath: input.transcriptPath, permissionMode: mode });
  const anchors = { cwd, claudeHome: policy.claudeHome, dshHome: adapter.harnessHome({ cwd, home }) };
  const workingDirs = [cwd, ...policy.additionalDirectories.map((dir) => (dir.startsWith('~/')
    ? path.join(policy.claudeHome, dir.slice(2)) : path.resolve(cwd, dir)))];

  /** Rules, host rules and mode, with the PreToolUse hook result folded in (steps 2–11). */
  function policyDecision(call, pre, ctx) {
    const matched = ruleEffect(policy.rules, call, anchors);
    if (matched.effect === 'deny') {
      return ['deny', `Permission to use ${call.claude} has been denied (${matched.rule.source}: ${matched.rule.raw}).`];
    }
    if (matched.effect !== 'allow') {
      const host = nassajHostRuleDenial({ tool_name: call.claude, tool_input: call.input }, { cwd });
      if (host) return ['deny', host.reason];
    }
    if (call.ambiguous) return ['deny', `Nassaj: the MCP tool name of ${call.claude} matches more than one configured server.`];
    const [decision, reason] = modeDecision(ruleMode, call, matched, { workingDirs, configPaths: adapter.configPaths, ctx });
    if (decision !== 'deny' && pre.decision === 'ask') return ['ask', pre.reason || reason];
    return [decision, reason];
  }

  /** PreToolUse hooks and policy for one Claude call: [decision, reason, claude, extra]. */
  async function decideOne(claudeCall, call, hookCall, ctx) {
    const pre = await hooks.preToolUse(hookCall);
    const extra = { additionalContext: pre.additionalContext, notices: pre.notices };
    if (pre.decision === 'deny') return ['deny', pre.reason, claudeCall, extra];
    return [...policyDecision(call, pre, ctx), claudeCall, extra];
  }

  /** PermissionRequest hooks for the asking calls; dontAsk denies without asking. */
  async function settleAsk(asking, hookCalls, fallbackReason) {
    if (mode === 'dontAsk') return { decision: 'deny', reason: `Claude's dontAsk mode denies this call: ${fallbackReason}`, notices: [] };
    const notices = [];
    const answers = [];
    for (const index of asking) {
      const answer = await hooks.permissionRequest(hookCalls[index]);
      notices.push(...answer.notices);
      answers.push(answer);
    }
    const denied = answers.find((answer) => answer.decision === 'deny');
    if (denied) return { decision: 'deny', reason: denied.reason || fallbackReason, notices };
    if (answers.every((answer) => answer.decision === 'allow')) return { decision: 'allow', reason: answers[0].reason, notices };
    return { decision: 'ask', reason: fallbackReason, notices };
  }

  async function decideTool({ callId, tool, args, agent, mcpServers, env }) {
    if (!isPlainObject(args)) return verdict('deny', 'Tool arguments must be a JSON object.');
    const ctx = { cwd, home, mcpServers: mcpServers ?? input.mcpServers ?? [], env: { ...input.harnessEnv, ...env } };
    let claudeCalls;
    try {
      claudeCalls = adapter.toClaudeCalls({ tool, args }, ctx);
    } catch (error) {
      return verdict('deny', error?.code && error.message ? error.message : `Tool "${tool}" is not reviewed for Claude parity.`);
    }
    if (!Array.isArray(claudeCalls) || claudeCalls.length === 0) return verdict('deny', `Tool "${tool}" maps to no Claude call.`);
    const claudes = claudeCalls.map(({ tool_name: name, tool_input: toolInput }) => ({ tool_name: name, tool_input: toolInput }));
    const hookCalls = claudes.map((claude) => ({ ...claude, tool_use_id: callId, agent }));
    const results = await Promise.all(claudeCalls.map((claudeCall, index) => decideOne(claudes[index],
      engineCall(claudeCall, ctx, adapter.shellPath), hookCalls[index], ctx)));
    const extra = { additionalContext: results.flatMap((r) => r[3].additionalContext ?? []), notices: results.flatMap((r) => r[3].notices ?? []) };
    let [decision, reason, claude] = strongest(results);
    if (decision === 'ask') {
      const asking = results.map((r, index) => (r[0] === 'ask' ? index : -1)).filter((index) => index >= 0);
      const settled = await settleAsk(asking, hookCalls, reason);
      extra.notices = [...extra.notices, ...settled.notices];
      [decision, reason] = [settled.decision, settled.reason || reason];
    }
    return { ...verdict(decision, reason, claude), ...(claudes.length > 1 ? { claudeCalls: claudes } : {}), ...extra };
  }
  return { mode, adapter, decideTool, userPromptSubmit: (prompt) => hooks.userPromptSubmit(prompt), hooks,
    setSession: (session) => hooks.setSession(session),
    resolvePath: (value) => adapter.absolutePath(value, { cwd, home }) };
}
