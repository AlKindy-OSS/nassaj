/**
 * claude-parity-engine-adapters.test — ADR-226 unit tests of the generalized engine: the
 * harness adapter (dsh default, OpenCode), the multi-call strongest decision, the
 * harness-config sensitive set, the host rules on Claude's terms, the dontAsk/auto modes
 * and the Claude-env requirement. Invariant: Nassaj's decision equals Claude's or is stricter.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createClaudeParityEngine } from '@/services/permission-parity/claude-parity-engine.js';
import { opencodeParityAdapter } from '@/services/permission-parity/opencode-claude-tools.js';

type Row = Record<string, any>;
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
let root = '';
let cwd = '';
let home = '';
let claudeHome = '';

/** An engine over one managed settings object; `adapter: null` = the dsh default. */
function engine(mode: string, settings: Row = {}, extra: Row = {}) {
  const managed = fs.mkdtempSync(path.join(root, 'managed-'));
  fs.writeFileSync(path.join(managed, 'managed-settings.json'), JSON.stringify(settings));
  return createClaudeParityEngine({ userId: 1, cwd: extra.cwd ?? cwd, home, sessionId: 's', transcriptPath: '/t.jsonl', permissionMode: mode,
    managedSettingsDir: managed, claudeEnv: () => ({ HOME: claudeHome }), adapter: opencodeParityAdapter, ...extra });
}
let seq = 0;
const decide = async (eng: Row, tool: string, args: Row, extra: Row = {}) => eng.decideTool({ callId: `c${(seq += 1)}`, sessionID: 'ses', tool, args, ...extra });
const edit = (filePath: string) => ({ filePath, oldString: 'a', newString: 'b' });
const bash = (command: string) => ({ command, description: 'unit' });

describe('ADR-226 parity engine adapters', () => {
  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-parity-adapters-')));
    cwd = path.join(root, 'ws');
    home = path.join(root, 'oc-home');
    claudeHome = path.join(root, 'claude-home');
    for (const dir of [cwd, home, claudeHome]) fs.mkdirSync(dir, { recursive: true });
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('Claude env (H3, C1)', () => {
    it('no env (null or throwing, as Claude\'s spawn throws) refuses with PERMISSION_EFFECTIVE_POLICY_REQUIRED', () => {
      for (const claudeEnv of [() => null, () => { throw new Error('no member'); }]) {
        assert.throws(() => engine('default', {}, { claudeEnv }), { code: 'PERMISSION_EFFECTIVE_POLICY_REQUIRED' });
      }
    });
    it('requireClaudeEnv:false keeps the managed-only reading', async () => {
      const eng = engine('bypassPermissions', { permissions: { deny: ['Bash'] } }, { claudeEnv: () => null, requireClaudeEnv: false });
      assert.equal((await decide(eng, 'bash', bash('ls'))).decision, 'deny');
    });
    it('a mode outside the mirrored set is refused', () => {
      assert.throws(() => engine('yolo'), { code: 'parity_mode_unsupported' });
    });
  });

  describe('modes (§3, M10 assumptions)', () => {
    it('dontAsk: every ask becomes a deny and no PermissionRequest hook runs', async () => {
      const witness = path.join(root, 'perm-request-witness');
      const settings = { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: `touch ${witness}` }] }] } };
      const eng = engine('dontAsk', settings);
      const verdict = await decide(eng, 'bash', bash('echo plain'));
      assert.equal(verdict.decision, 'deny');
      assert.match(verdict.reason, /dontAsk/);
      assert.equal(fs.existsSync(witness), false);
      assert.equal((await decide(eng, 'read', { filePath: 'a.txt' })).decision, 'allow', 'reads in cwd still run');
    });
    it('auto is decided as default (no classifier: stricter)', async () => {
      for (const mode of ['auto', 'default']) {
        const eng = engine(mode);
        assert.deepEqual([(await decide(eng, 'edit', edit('a.txt'))).decision, (await decide(eng, 'read', { filePath: '/etc/hostname' })).decision],
          ['ask', 'ask'], mode);
      }
    });
  });

  describe('multi-call and MCP', () => {
    const patch = ['*** Begin Patch', '*** Add File: a.txt', '+x', '*** Update File: b.txt', '*** Move to: secret/c.txt', '@@', '-x', '+y', '*** End Patch'].join('\n');
    it('apply_patch: the strongest decision over all derived Edits; every Claude call is reported', async () => {
      const eng = engine('acceptEdits', { permissions: { ask: ['Edit(secret/**)'] } });
      const verdict = await decide(eng, 'apply_patch', { patchText: patch });
      assert.equal(verdict.decision, 'ask');
      assert.equal(verdict.claude.tool_input.file_path, path.join(cwd, 'secret', 'c.txt'), 'the deciding call');
      assert.equal(verdict.claudeCalls.length, 3);
      assert.equal((await decide(engine('acceptEdits'), 'apply_patch', { patchText: patch })).decision, 'allow');
      assert.equal((await decide(eng, 'apply_patch', { patchText: '*** Begin Patch\n*** Copy File: a\n*** End Patch' })).decision, 'deny');
    });
    it('apply_patch (H2): Add is a Write with content, Update an Edit with the lines; hooks see the content', async () => {
      const verdict = await decide(engine('default'), 'apply_patch', { patchText: patch });
      assert.deepEqual(verdict.claudeCalls.map((c: Row) => [c.tool_name, path.basename(c.tool_input.file_path)]),
        [['Write', 'a.txt'], ['Edit', 'b.txt'], ['Edit', 'c.txt']]);
      assert.equal(verdict.claudeCalls[0].tool_input.content, 'x');
      assert.deepEqual([verdict.claudeCalls[1].tool_input.old_string, verdict.claudeCalls[1].tool_input.new_string], ['x', 'y']);
      // A PreToolUse hook that denies on the added text: it can only see it through tool_input.content.
      const hook = path.join(root, 'deny-on-content.cjs');
      fs.writeFileSync(hook, `let r='';process.stdin.on('data',c=>r+=c).on('end',()=>{const i=JSON.parse(r).tool_input||{};
if(String(i.content||'').includes('TOKEN')){process.stderr.write('content hook saw TOKEN');process.exit(2);}process.exit(0);});`);
      const settings = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `node ${hook}` }] }] } };
      const secret = ['*** Begin Patch', '*** Add File: n.txt', '+TOKEN=1', '*** End Patch'].join('\n');
      const denied = await decide(engine('bypassPermissions', settings), 'apply_patch', { patchText: secret });
      assert.equal(denied.decision, 'deny');
      assert.match(denied.reason, /content hook saw TOKEN/);
      assert.equal((await decide(engine('bypassPermissions', settings), 'apply_patch', { patchText: patch })).decision, 'allow');
    });
    it('an ambiguous MCP name is denied even with no rule; a server rule covers every tool of the server', async () => {
      const servers = { mcpServers: ['probe', 'probe_a'] };
      assert.equal((await decide(engine('bypassPermissions'), 'probe_a_b', { text: 'x' }, servers)).decision, 'deny');
      assert.equal((await decide(engine('bypassPermissions'), 'probe_echo', { text: 'x' }, servers)).decision, 'allow');
      assert.equal((await decide(engine('bypassPermissions', { permissions: { deny: ['mcp__probe'] } }), 'probe_echo', {}, servers)).decision, 'deny');
      assert.equal((await decide(engine('default', { permissions: { allow: ['mcp__probe__echo'] } }), 'probe_echo', {}, servers)).decision, 'allow');
      assert.equal((await decide(engine('default'), 'probe_echo', {}, servers)).decision, 'ask', 'Claude asks for an MCP tool');
      const configured = engine('bypassPermissions', {}, { mcpServers: ['probe'] });
      assert.equal((await decide(configured, 'probe_echo', {})).decision, 'allow', 'engine-level servers');
    });
    it('unknown tools, unreviewed fields and question are denied with a reason', async () => {
      const eng = engine('bypassPermissions');
      assert.equal((await decide(eng, 'custom_tool', {})).decision, 'deny');
      assert.match((await decide(eng, 'glob', { pattern: '*', deep: true })).reason, /not reviewed/);
      assert.match((await decide(eng, 'question', { questions: [] })).reason, /plain text/);
    });
  });

  describe('harness-config sensitive set (B-1759b)', () => {
    it('OpenCode: bash writes into the set ask over an allow rule; bypass allows', async () => {
      const allow = { permissions: { allow: ['Bash(echo:*)', 'Edit(**)'] } };
      const def = engine('default', allow);
      assert.equal((await decide(def, 'bash', bash('echo x > .opencode/plugin/p.js'))).decision, 'ask');
      assert.equal((await decide(def, 'edit', edit(path.join(cwd, 'sub', 'opencode.jsonc')))).decision, 'ask', 'any depth');
      assert.equal((await decide(def, 'edit', edit(path.join(home, '.config', 'opencode', 'command', 'x.md')))).decision, 'ask', 'config home');
      assert.equal((await decide(engine('bypassPermissions', allow), 'bash', bash('echo x > opencode.json'))).decision, 'allow');
    });
    it('dsh keeps `.claude` only (an OpenCode file is not sensitive there)', async () => {
      const dsh = engine('acceptEdits', {}, { adapter: undefined });
      assert.equal((await dsh.decideTool({ callId: 'd1', tool: 'edit', args: { file_path: 'opencode.json', old_string: 'a', new_string: 'b' } })).decision, 'allow');
      assert.equal((await dsh.decideTool({ callId: 'd2', tool: 'edit', args: { file_path: '.claude/x', old_string: 'a', new_string: 'b' } })).decision, 'ask');
    });
  });

  describe('host rules on Claude\'s terms (B-1762)', () => {
    const dist = () => path.join(appRoot, 'dist', `parity-unit-${process.pid}`, 'x.html');
    it('the public-page cage binds in bypass on OpenCode and dsh; an allow rule lifts it, an ask rule does not', async () => {
      const opts = { cwd: appRoot };
      assert.equal((await decide(engine('bypassPermissions', {}, opts), 'edit', edit(dist()))).decision, 'deny');
      const dsh = engine('bypassPermissions', {}, { ...opts, adapter: undefined });
      assert.equal((await dsh.decideTool({ callId: 'p1', tool: 'write', args: { file_path: dist(), content: 'x' } })).decision, 'deny', 'dsh');
      const allowed = engine('default', { permissions: { allow: [`Edit(/${path.dirname(dist())}/**)`] } }, opts);
      assert.equal((await decide(allowed, 'edit', edit(dist()))).decision, 'allow');
      const asked = engine('bypassPermissions', { permissions: { allow: [`Edit(/${path.dirname(dist())}/**)`], ask: ['Edit(**/x.html)'] } }, opts);
      assert.equal((await decide(asked, 'edit', edit(dist()))).decision, 'deny', 'an ask rule reaches canUseTool on Claude');
      assert.equal(fs.existsSync(path.dirname(dist())), false);
    });
  });

  it('the decision path never reads a raw `~`: OpenCode edits `<cwd>/~/x`', async () => {
    const verdict = await decide(engine('bypassPermissions'), 'edit', edit('~/x'));
    assert.equal(verdict.claude.tool_input.file_path, path.join(cwd, '~', 'x'));
  });
});
