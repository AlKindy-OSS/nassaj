/**
 * claude-hook-runner.test — T-2089 S3 (ADR-225): the provider-neutral Claude hook runner.
 * Every hook here is a sandbox script; side effects are witness files under the sandbox.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { collectClaudeHooks, createClaudeHookRunner, matcherMatches }
  from '@/services/permission-parity/claude-hook-runner.js';
import { createClaudeParityEngine } from '@/services/permission-parity/claude-parity-engine.js';

let root = '';
let cwd = '';
let home = '';
let configDir = '';

/** A settings source list in readClaudeSpawnSettings' shape. */
const source = (settings: Record<string, unknown>) => [{ file: path.join(root, 'managed-settings.json'),
  label: 'managed policy settings', status: 'ok', settings }];
const cmd = (command: string, extra: Record<string, unknown> = {}) => ({ type: 'command', command, ...extra });
const group = (matcher: string, ...hooks: unknown[]) => ({ matcher, hooks });
const env = () => ({ HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: configDir, JWT_SECRET: 'host-secret' });
function runner(hooks: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const collected = collectClaudeHooks(source({ hooks }), env());
  return createClaudeHookRunner({ hooks: collected, env: env(), cwd, sessionId: 'sess-1',
    transcriptPath: path.join(root, 'transcript.jsonl'), permissionMode: 'default', ...extra });
}
const pre = (tool_name = 'Bash', tool_input: Record<string, unknown> = { command: 'ls' }, agent?: unknown) =>
  ({ tool_name, tool_input, tool_use_id: 'toolu_1', agent });

describe('T-2089 S3 Claude hook runner', () => {
  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-hook-runner-')));
    cwd = path.join(root, 'ws');
    home = path.join(root, 'home');
    configDir = path.join(home, '.claude');
    for (const dir of [cwd, configDir]) fs.mkdirSync(dir, { recursive: true });
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('collection', () => {
    it('collects settings hooks and enabled plugin hooks with their plugin root', () => {
      const plugin = path.join(root, 'plugin-a');
      fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(plugin, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {
        PreToolUse: [group('Write', cmd('${CLAUDE_PLUGIN_ROOT}/guard.sh'))] } }));
      fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{}');
      fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
        'a@market': [{ installPath: plugin }] } }));
      const hooks = collectClaudeHooks([...source({ hooks: { PreToolUse: [group('Bash', cmd('true'))] } }),
        { file: path.join(home, '.claude', 'settings.json'), label: 'user settings', status: 'ok',
          settings: { enabledPlugins: { 'a@market': true } } }], env());
      assert.equal(hooks.PreToolUse.length, 2);
      assert.equal(hooks.PreToolUse[1].pluginRoot, plugin);
      fs.rmSync(path.join(configDir, 'plugins'), { recursive: true, force: true });
    });
    it('refuses a non-command hook type and an enabled plugin that is not installed', () => {
      assert.throws(() => collectClaudeHooks(source({ hooks: { PreToolUse: [group('', { type: 'prompt', prompt: 'x' })] } }), env()),
        { code: 'parity_hook_type_unsupported' });
      assert.throws(() => collectClaudeHooks(source({ enabledPlugins: { 'ghost@market': true } }), env()),
        { code: 'parity_hook_source_unreadable' });
    });
    it('matchers follow Claude: empty and * match all, otherwise an anchored regex', () => {
      assert.equal(matcherMatches('', 'Bash'), true);
      assert.equal(matcherMatches('*', 'Bash'), true);
      assert.equal(matcherMatches(undefined, 'Bash'), true);
      assert.equal(matcherMatches('Edit|Write', 'Write'), true);
      assert.equal(matcherMatches('Bash', 'BashOutput'), false);
      assert.equal(matcherMatches('mcp__.*', 'mcp__srv__x'), true);
    });
  });

  describe('qa veto I5 (part): allowManagedHooksOnly', () => {
    it('keeps only managed hooks', () => {
      const pre1 = { PreToolUse: [group('', cmd('true'))] };
      const kept = collectClaudeHooks([{ file: path.join(root, 'managed-settings.json'), label: 'managed policy settings', status: 'ok',
        settings: { hooks: pre1, allowManagedHooksOnly: true } }, { file: path.join(home, '.claude', 'settings.json'),
        label: 'user settings', status: 'ok', settings: { hooks: pre1 } }], env());
      assert.equal(kept.PreToolUse.length, 1);
    });
  });

  describe('PreToolUse', () => {
    it('sends Claude\'s payload on stdin (agent fields only for a subagent)', async () => {
      const log = path.join(root, 'payloads.jsonl');
      const run = runner({ PreToolUse: [group('', cmd(`cat >> ${log}; echo >> ${log}`))] });
      await run.preToolUse(pre('Write', { file_path: path.join(cwd, 'a'), content: 'x' }));
      await run.preToolUse(pre('Write', { file_path: path.join(cwd, 'b'), content: 'y' }, { id: 'agent-1', type: 'backend-dev' }));
      const [main, sub] = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.deepEqual(Object.keys(main).sort(), ['cwd', 'hook_event_name', 'permission_mode', 'session_id', 'tool_input',
        'tool_name', 'tool_use_id', 'transcript_path']);
      assert.equal(main.hook_event_name, 'PreToolUse');
      assert.equal(main.cwd, cwd);
      assert.equal(sub.agent_id, 'agent-1');
      assert.equal(sub.agent_type, 'backend-dev');
    });
    it('exit 2 blocks with stderr as the reason; other non-zero exits, crashes and timeouts do not block', async () => {
      assert.deepEqual((await runner({ PreToolUse: [group('', cmd('echo nope >&2; exit 2'))] }).preToolUse(pre()))
        .decision, 'deny');
      const blocked = await runner({ PreToolUse: [group('', cmd('echo "  nope  " >&2; exit 2'))] }).preToolUse(pre());
      assert.equal(blocked.reason, 'nope');
      for (const command of ['echo oops >&2; exit 1', '/nonexistent/hook.sh', 'kill -SEGV $$']) {
        const result = await runner({ PreToolUse: [group('', cmd(command))] }).preToolUse(pre());
        assert.equal(result.decision, null, command);
        assert.ok(result.notices.length >= 1, command);
      }
    });
    it('a timeout kills the whole process group and does not block', async () => {
      const pidFile = path.join(root, 'grandchild.pid');
      const started = Date.now();
      const result = await runner({ PreToolUse: [group('', cmd(`sleep 30 & echo $! > ${pidFile}; wait`, { timeout: 1 }))] })
        .preToolUse(pre());
      assert.ok(Date.now() - started < 5000);
      assert.equal(result.decision, null);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    });
    it('JSON permissionDecision combines deny > ask > allow; additionalContext is kept', async () => {
      const out = (decision: string) => cmd(`echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
        permissionDecision: decision, permissionDecisionReason: `r-${decision}`, additionalContext: `c-${decision}` } })}'`);
      const ask = await runner({ PreToolUse: [group('', out('allow'), out('ask'))] }).preToolUse(pre());
      assert.equal(ask.decision, 'ask');
      assert.equal(ask.reason, 'r-ask');
      assert.deepEqual(ask.additionalContext.sort(), ['c-allow', 'c-ask']);
      const deny = await runner({ PreToolUse: [group('', out('ask'), out('deny'))] }).preToolUse(pre());
      assert.deepEqual([deny.decision, deny.reason], ['deny', 'r-deny']);
      const legacy = await runner({ PreToolUse: [group('', cmd(`echo '{"decision":"block","reason":"old"}'`))] }).preToolUse(pre());
      assert.deepEqual([legacy.decision, legacy.reason], ['deny', 'old']);
    });
    it('updatedInput is refused with a clear reason; an oversized stdout is refused', async () => {
      const update = await runner({ PreToolUse: [group('', cmd(`echo '${JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'rm -rf /' } } })}'`))] }).preToolUse(pre());
      assert.equal(update.decision, 'deny');
      assert.match(update.reason, /updatedInput/);
      const big = await runner({ PreToolUse: [group('', cmd('head -c 3000000 /dev/zero | tr "\\0" a'))] }).preToolUse(pre());
      assert.equal(big.decision, 'deny');
      assert.match(big.reason, /output/);
    });
    it('runs hooks under the member\'s Claude HOME, CLAUDE_PROJECT_DIR, plugin root only for plugin hooks, no host secrets', async () => {
      const log = path.join(root, 'env.txt');
      const run = runner({ PreToolUse: [group('', cmd(`env > ${log}`))] });
      await run.preToolUse(pre());
      const seen = Object.fromEntries(fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
      assert.equal(seen.HOME, home);
      assert.equal(seen.CLAUDE_PROJECT_DIR, cwd);
      assert.equal(seen.JWT_SECRET, undefined);
      assert.equal(seen.CLAUDE_PLUGIN_ROOT, undefined);
      assert.ok(!/^\/(tmp|dev\/shm)(\/|$)/.test(seen.TMPDIR ?? '/var/tmp'), `TMPDIR ${seen.TMPDIR}`);
    });
    it('caps concurrency', async () => {
      const started = Date.now();
      await runner({ PreToolUse: [group('', cmd('sleep 0.3'), cmd('sleep 0.3'), cmd('sleep 0.3'))] }, { maxConcurrent: 1 }).preToolUse(pre());
      assert.ok(Date.now() - started >= 850, `elapsed ${Date.now() - started}`);
    });
    it('never runs in tmpfs', () => {
      assert.throws(() => createClaudeHookRunner({ hooks: {}, env: env(), cwd: '/dev/shm', sessionId: 's',
        transcriptPath: path.join(root, 't.jsonl'), permissionMode: 'default' }), { code: 'parity_hook_tmpfs' });
    });
  });

  describe('other events', () => {
    it('UserPromptSubmit: exit 2 blocks; plain stdout and JSON additionalContext reach the model', async () => {
      const blocked = await runner({ UserPromptSubmit: [group('', cmd('echo stop >&2; exit 2'))] }).userPromptSubmit({ prompt: 'hi' });
      assert.deepEqual([blocked.blocked, blocked.reason], [true, 'stop']);
      const context = await runner({ UserPromptSubmit: [group('', cmd('echo plain-context'),
        cmd(`echo '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"json-context"}}'`))] })
        .userPromptSubmit({ prompt: 'hi' });
      assert.equal(context.blocked, false);
      assert.deepEqual(context.additionalContext.sort(), ['json-context', 'plain-context']);
      const json = await runner({ UserPromptSubmit: [group('', cmd(`echo '{"decision":"block","reason":"policy"}'`))] })
        .userPromptSubmit({ prompt: 'hi' });
      assert.deepEqual([json.blocked, json.reason], [true, 'policy']);
    });
    it('PostToolUse and PostToolBatch: block and additionalContext', async () => {
      const post = await runner({ PostToolUse: [group('Bash', cmd('echo fix-it >&2; exit 2'))] })
        .postToolUse({ ...pre(), tool_response: { stdout: 'x' } });
      assert.deepEqual([post.block, post.reason], [true, 'fix-it']);
      const batch = await runner({ PostToolBatch: [group('', cmd(`echo '{"hookSpecificOutput":{"hookEventName":"PostToolBatch","additionalContext":"batch-ctx"}}'`))] })
        .postToolBatch({ tool_calls: [] });
      assert.deepEqual([batch.block, batch.additionalContext], [false, ['batch-ctx']]);
    });
    it('PermissionRequest: allow / deny behavior', async () => {
      const behave = (behavior: string) => cmd(`echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
        decision: { behavior, message: `m-${behavior}` } } })}'`);
      assert.equal((await runner({ PermissionRequest: [group('', behave('allow'))] }).permissionRequest(pre())).decision, 'allow');
      const denied = await runner({ PermissionRequest: [group('', behave('deny'))] }).permissionRequest(pre());
      assert.deepEqual([denied.decision, denied.reason], ['deny', 'm-deny']);
      assert.equal((await runner({}).permissionRequest(pre())).decision, null);
    });
  });

  describe('engine integration', () => {
    function engineWith(settings: Record<string, unknown>, mode = 'default') {
      const dir = fs.mkdtempSync(path.join(root, 'managed-'));
      fs.writeFileSync(path.join(dir, 'managed-settings.json'), JSON.stringify(settings));
      return createClaudeParityEngine({ userId: 1, cwd, home: path.join(root, 'dsh-home'), sessionId: 'sess-1',
        transcriptPath: path.join(root, 'transcript.jsonl'), permissionMode: mode, managedSettingsDir: dir,
        claudeEnv: () => env() });
    }
    it('a PreToolUse block denies with the hook reason, even in bypass', async () => {
      const engine = engineWith({ hooks: { PreToolUse: [group('Bash', cmd('echo guard-says-no >&2; exit 2'))] } }, 'bypassPermissions');
      const verdict = await engine.decideTool({ callId: 'c', tool: 'bash', args: { command: 'ls', description: 'd' } });
      assert.deepEqual([verdict.decision, verdict.reason], ['deny', 'guard-says-no']);
    });
    it('a PermissionRequest hook answers an ask before any card', async () => {
      const allow = cmd(`echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`);
      const engine = engineWith({ hooks: { PermissionRequest: [group('Bash', allow)] } });
      assert.equal((await engine.decideTool({ callId: 'c', tool: 'bash', args: { command: 'ls', description: 'd' } })).decision, 'allow');
    });
    it('engine.userPromptSubmit runs the hooks', async () => {
      const engine = engineWith({ hooks: { UserPromptSubmit: [group('', cmd('echo halt >&2; exit 2'))] } });
      assert.deepEqual(await engine.userPromptSubmit({ prompt: 'hi' }), { blocked: true, reason: 'halt', additionalContext: [], notices: [] });
    });
  });
});
