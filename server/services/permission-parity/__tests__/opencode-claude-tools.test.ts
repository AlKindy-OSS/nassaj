/**
 * opencode-claude-tools.test — ADR-226 §1.1 (B-1759): the OpenCode 1.19.5 registry, the
 * apply_patch grammar, the MCP name split and OpenCode's path resolution, as measured in
 * fixtures/opencode-stage0/stage0-evidence.json.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  OPENCODE_TOOL_MAP, opencodeParityAdapter, opencodePermissionCard, parseApplyPatch, splitMcpToolName, toClaudeCalls,
} from '@/services/permission-parity/opencode-claude-tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STAGE0 = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'opencode-stage0', 'stage0-evidence.json'), 'utf8'));
const cwd = '/var/tmp/oc-unit/ws';
const ctx = { cwd, home: '/var/tmp/oc-unit/home', mcpServers: ['probe', 'probe_a'] };
const calls = (tool: string, args: Record<string, unknown>, extra = {}) => toClaudeCalls({ tool, args }, { ...ctx, ...extra });
const denied = (fn: () => unknown, code: string) => assert.throws(fn, (error: { code?: string }) => error?.code === code);

describe('ADR-226 OpenCode tool adapter', () => {
  it('maps every tool stage 0 saw the hook fire for (and nothing named in §1.1 as removed)', () => {
    const fired = new Set<string>();
    for (const scenario of Object.values(STAGE0.scenarios) as Array<Record<string, any>>) {
      for (const frame of [scenario.fd3Frames ?? [], scenario.a?.fd3Frames ?? [], scenario.b?.fd3Frames ?? []].flat()) {
        if (frame.type === 'pre' && typeof frame.tool === 'string' && !frame.tool.startsWith('probe')) fired.add(frame.tool);
      }
    }
    for (const tool of fired) assert.ok(Object.hasOwn(OPENCODE_TOOL_MAP.tools, tool), `${tool} is mapped`);
    for (const gone of ['batch', 'list', 'multiedit', 'lsp', 'plan', 'execute', 'patch']) {
      assert.equal(Object.hasOwn(OPENCODE_TOOL_MAP.tools, gone), false, gone);
      denied(() => calls(gone, {}), 'parity_tool_unreviewed');
    }
  });

  it('paths: relative from cwd, `~` literal (stage 0: `~/x` became <cwd>/~/x)', () => {
    assert.equal(calls('read', { filePath: 'a.txt' })[0].tool_input.file_path, path.join(cwd, 'a.txt'));
    assert.equal(calls('edit', { filePath: '~/x', oldString: 'a', newString: 'b' })[0].tool_input.file_path, path.join(cwd, '~', 'x'));
    assert.equal(opencodeParityAdapter.shellPath('~/x', ctx), path.join(ctx.home, 'x'), 'bash expands ~ itself');
    assert.equal(calls('glob', { pattern: '*.ts' })[0].tool_input.path, cwd, 'no path = cwd');
  });

  it('every built-in maps to its Claude tool and input', () => {
    assert.deepEqual(calls('edit', { filePath: 'a', oldString: 'x', newString: 'y', replaceAll: true }),
      [{ tool_name: 'Edit', cls: 'edit', tool_input: { file_path: path.join(cwd, 'a'), old_string: 'x', new_string: 'y', replace_all: true } }]);
    assert.deepEqual(calls('grep', { pattern: 'p', include: '*.js' })[0].tool_input, { pattern: 'p', path: cwd, glob: '*.js' });
    assert.deepEqual(calls('skill', { name: 's' })[0], { tool_name: 'Skill', cls: 'tool', tool_input: { skill: 's' } });
    assert.equal(calls('todowrite', { todos: [] })[0].cls, 'free');
    assert.equal(calls('webfetch', { url: 'https://x.test', format: 'text' })[0].tool_input.url, 'https://x.test');
    assert.equal(calls('task', { description: 'd', prompt: 'p', subagent_type: 'general', task_id: 't' })[0].tool_name, 'Task');
    assert.equal(calls('invalid', { tool: 'x', error: 'bad' })[0].cls, 'free');
  });

  it('bash workdir becomes a leading cd (quoted when needed) and the bash cwd', () => {
    const [plain] = calls('bash', { command: 'ls', description: 'd', workdir: 'sub' });
    assert.equal(plain.tool_input.command, 'cd sub && ls');
    assert.equal(plain.bashCwd, path.join(cwd, 'sub'));
    assert.equal(calls('bash', { command: 'ls', description: 'd', workdir: "a b'c" })[0].tool_input.command, "cd 'a b'\\''c' && ls");
  });

  it('stage 0: unknown extra fields are tolerated by OpenCode, so the adapter denies them per call', () => {
    denied(() => calls('glob', { pattern: '*', recursive: true }), 'parity_field_unreviewed');
    denied(() => calls('todowrite', { todos: [], extra: 1 }), 'parity_field_unreviewed');
    denied(() => calls('read', { filePath: 7 }), 'parity_field_unreviewed');
    assert.doesNotThrow(() => calls('read', { filePath: 'a', offset: 1, limit: 2 }), 'ignored fields are reviewed');
  });

  it('question is always denied with a plain-text hint', () => {
    assert.throws(() => calls('question', { questions: [] }), /plain text/);
  });

  describe('apply_patch grammar (M8 + stage 0)', () => {
    it('Add / Update (+ Move to) / Delete, and `*** End of File` inside an update hunk', () => {
      const text = ['*** Begin Patch', '*** Add File: a.txt', '+hi', '*** Update File: b.txt', '*** Move to: c.txt', '@@ ctx', '-x', '+y',
        '*** End of File', '*** Delete File: d.txt', '*** End Patch'].join('\n');
      assert.deepEqual(parseApplyPatch(text), [{ type: 'add', path: 'a.txt' }, { type: 'update', path: 'b.txt', movePath: 'c.txt' },
        { type: 'delete', path: 'd.txt' }]);
      assert.deepEqual(calls('apply_patch', { patchText: text }).map((c) => c.tool_input.file_path),
        ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((f) => path.join(cwd, f)));
    });
    it('H2: Add → Write{content}; Update/Move → Edit{old,new}; Delete → Edit; the card carries the patch and every file', () => {
      const text = ['*** Begin Patch', '*** Add File: a.txt', '+hi', '+there', '*** Update File: b.txt', '*** Move to: c.txt', '@@ ctx',
        ' keep', '-x', '+y', '*** End of File', '*** Delete File: d.txt', '*** End Patch'].join('\n');
      const out = calls('apply_patch', { patchText: text });
      assert.deepEqual(out.map((c) => c.tool_name), ['Write', 'Edit', 'Edit', 'Edit']);
      assert.deepEqual(out[0].tool_input, { file_path: path.join(cwd, 'a.txt'), content: 'hi\nthere' });
      assert.deepEqual([out[1].tool_input.old_string, out[1].tool_input.new_string], ['keep\nx', 'keep\ny']);
      assert.deepEqual(out[2].tool_input, { ...out[1].tool_input, file_path: path.join(cwd, 'c.txt') });
      assert.deepEqual(out[3].tool_input, { file_path: path.join(cwd, 'd.txt'), old_string: '', new_string: '' });
      const card = opencodePermissionCard({ tool: 'apply_patch', args: { patchText: text }, claude: out[2], claudeCalls: out });
      assert.equal(card.toolName, 'Edit');
      assert.equal(card.input.patchText, text);
      assert.equal(card.input.file_path, path.join(cwd, 'c.txt'));
      assert.deepEqual(card.input.files.map((f: { tool: string, file_path: string }) => [f.tool, path.basename(f.file_path)]),
        [['Write', 'a.txt'], ['Edit', 'b.txt'], ['Edit', 'c.txt'], ['Edit', 'd.txt']]);
      const single = opencodePermissionCard({ tool: 'apply_patch', args: { patchText: 'p' }, claude: out[0] });
      assert.deepEqual(single.input.files, [{ tool: 'Write', file_path: path.join(cwd, 'a.txt') }]);
      assert.deepEqual(opencodePermissionCard({ tool: 'bash', args: {}, claude: { tool_name: 'Bash', tool_input: { command: 'ls' } } }),
        { toolName: 'Bash', input: { command: 'ls' } });
    });
    it('the stage-0 patch parses (CRLF and surrounding whitespace too)', () => {
      const input = STAGE0.scenarios.applyPatch.toolParts.find((p: { tool: string }) => p.tool === 'apply_patch').input.patchText;
      assert.deepEqual(parseApplyPatch(input).map((h: { path: string }) => h.path), ['added.txt', 'rel.txt']);
      assert.equal(parseApplyPatch(`\n ${input.replaceAll('\n', '\r\n')} \n`).length, 2);
    });
    it('anything else is refused', () => {
      for (const bad of [
        '*** Begin Patch\n*** Rename File: a\n*** End Patch',
        '*** Begin Patch\n*** Add File: \n*** End Patch',
        '*** Begin Patch\n*** End Patch',
        '*** Begin Patch\n*** Add File: a\n+x',
        'cat <<EOF\n*** Begin Patch\n*** Add File: a\n*** End Patch\nEOF',
        '*** Begin Patch\n*** Add File: a\n*** Move to: b\n*** End Patch',
        '*** Begin Patch\n*** Delete File: a\n*** End of File\n*** End Patch',
        '*** Begin Patch\nstray\n*** Add File: a\n*** End Patch',
        'not a patch',
      ]) denied(() => parseApplyPatch(bad), 'parity_patch_invalid');
      denied(() => calls('apply_patch', { patchText: 7 }), 'parity_field_unreviewed');
    });
  });

  describe('MCP (M1 + stage 0 collision)', () => {
    it('every split against the configured servers; ambiguous when more than one', () => {
      assert.deepEqual(splitMcpToolName('probe_a_b', ['probe', 'probe_a']), [{ server: 'probe', tool: 'a_b' }, { server: 'probe_a', tool: 'b' }]);
      const out = calls('probe_a_b', { text: 'x' });
      assert.deepEqual(out.map((c) => [c.tool_name, c.ambiguous]), [['mcp__probe__a_b', true], ['mcp__probe_a__b', true]]);
      assert.deepEqual(calls('probe_echo', { text: 'x' }, { mcpServers: ['probe'] }), [{ tool_name: 'mcp__probe__echo', cls: 'tool', tool_input: { text: 'x' } }]);
    });
    it('server names are sanitized as OpenCode does; no configured server → deny', () => {
      assert.equal(calls('my_srv_t', {}, { mcpServers: ['my.srv'] })[0].tool_name, 'mcp__my_srv__t');
      denied(() => calls('other_x', {}), 'parity_tool_unreviewed');
      denied(() => calls('probe_', {}), 'parity_tool_unreviewed');
    });
    it('a built-in name that also splits as an MCP tool is denied', () => {
      denied(() => calls('read_mcp_resource', { server: 'probe', uri: 'u' }, { mcpServers: ['probe', 'read'] }), 'parity_tool_unreviewed');
    });
    it('resource tools name a configured server', () => {
      assert.equal(calls('read_mcp_resource', { server: 'probe', uri: 'probe://probe/r1' })[0].tool_name, 'ReadMcpResourceTool');
      assert.equal(calls('list_mcp_resources', {})[0].tool_name, 'ListMcpResourcesTool');
      denied(() => calls('read_mcp_resource', { server: 'nope', uri: 'u' }), 'parity_mcp_server_unknown');
    });
  });

  it('the harness-config sensitive set (B-1759b): .claude, .opencode, opencode.json(c), the config home', () => {
    const set = opencodeParityAdapter.configPaths;
    assert.deepEqual([...set.segments], ['.claude', '.opencode']);
    assert.deepEqual([...set.basenames], ['opencode.json', 'opencode.jsonc']);
    assert.deepEqual(set.roots({ home: '/h', env: {} }), ['/h/.config/opencode']);
    assert.deepEqual(set.roots({ home: '/h', env: { XDG_CONFIG_HOME: '/x' } }), ['/x/opencode']);
    assert.equal(set.bashWrites, true);
  });
});
