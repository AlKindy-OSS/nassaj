/**
 * claude-parity-engine.test — T-2089 S2 (ADR-225) unit tests of the provider-neutral
 * Claude rules and the decision engine. Invariant: Nassaj's decision equals Claude's or
 * is stricter. Live facts used here: fixtures/claude-live/claude-live-measurement.json
 * (Claude Code 2.1.312) and fixtures/stage0/dsh-tool-schemas.json (dsh 0.2.2-rc.1).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { splitBashCommand } from '@/services/permission-parity/bash-command-split.js';
import { parseRuleSyntax } from '@/services/permission-parity/claude-rule-syntax.js';
import { assertReviewedTools, createClaudeParityEngine, DSH_REVIEWED_TOOLS }
  from '@/services/permission-parity/claude-parity-engine.js';

let root = '';
let cwd = '';
let dshHome = '';
let claudeHome = '';
let managed = '';
let extraDir = '';

/** An engine over one managed settings object (written to its own dir). */
function engine(mode: string, settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  // A fresh dir per engine: the shared settings reader caches by (dir, stat signature).
  managed = fs.mkdtempSync(path.join(root, 'managed-'));
  fs.writeFileSync(path.join(managed, 'managed-settings.json'), JSON.stringify(settings));
  return createClaudeParityEngine({ userId: 1, cwd, home: dshHome, sessionId: 's', transcriptPath: '/t.jsonl',
    permissionMode: mode, managedSettingsDir: managed, claudeEnv: () => ({ HOME: claudeHome }), ...extra });
}
async function decide(eng: any, tool: string, args: unknown, agent?: unknown) {
  return (await eng.decideTool({ callId: 'c1', tool, args, agent })).decision;
}
const bash = (command: string) => ({ command, description: 'unit' });

describe('T-2089 S2 parity engine', () => {
  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-parity-engine-')));
    cwd = path.join(root, 'ws');
    dshHome = path.join(root, 'dsh-home');
    claudeHome = path.join(root, 'claude-home');
    managed = path.join(root, 'managed');
    extraDir = path.join(root, 'extra');
    for (const dir of [cwd, dshHome, claudeHome, managed, extraDir, path.join(root, 'secret'), path.join(cwd, 'src')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'secret', 'key.txt'), 'k');
    fs.symlinkSync(path.join(root, 'secret'), path.join(cwd, 'link'));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('rule syntax', () => {
    it('splits tool name and specifier; bare and (*) mean the whole tool', () => {
      assert.deepEqual(parseRuleSyntax('Bash(pm2 restart *)'), { tool: 'Bash', specifier: 'pm2 restart *' });
      assert.deepEqual(parseRuleSyntax('WebSearch'), { tool: 'WebSearch', specifier: null });
      assert.deepEqual(parseRuleSyntax('Agent(*)'), { tool: 'Agent', specifier: null });
      assert.deepEqual(parseRuleSyntax('mcp__srv__tool'), { tool: 'mcp__srv__tool', specifier: null });
      assert.equal(parseRuleSyntax('Bash(unclosed'), null);
      assert.equal(parseRuleSyntax(7), null);
    });
  });

  describe('bash compound split', () => {
    it('splits on && || ; | & and newlines, outside quotes', () => {
      assert.deepEqual(splitBashCommand('a && b || c; d | e & f\ng').parts, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
      assert.deepEqual(splitBashCommand('echo "a && b" \'c; d\'').parts, ['echo "a && b" \'c; d\'']);
    });
    it('extracts $() and backtick bodies, and bash -c / sh -c strings', () => {
      const { parts } = splitBashCommand('echo $(pm2 restart nassaj-dev) `id`; bash -c "ls && pm2 kill"');
      for (const want of ['pm2 restart nassaj-dev', 'id', 'ls', 'pm2 kill']) assert.ok(parts.includes(want), `${want} in ${parts}`);
    });
    it('strips redirections from the part and reports file writes', () => {
      const split = splitBashCommand('echo hi > /tmp/out 2>&1');
      assert.deepEqual(split.parts, ['echo hi']);
      assert.deepEqual(split.writes, ['/tmp/out']);
    });
    it('marks unbalanced quotes, heredocs and unclosed substitutions unparseable', () => {
      for (const command of ['echo "x; pm2 restart nassaj-dev', 'cat <<EOF\nx\nEOF', 'echo $(ls']) {
        assert.equal(splitBashCommand(command).parseable, false, command);
      }
    });
  });

  describe('bash rules', () => {
    const deny = { permissions: { deny: ['Bash(pm2 restart nassaj-dev)', 'Bash(pkill:*)'], allow: ['Bash(ls *)', 'Bash(echo *)'] } };
    it('a deny inside any compound part, substitution or bash -c denies', async () => {
      const eng = engine('bypassPermissions', deny);
      for (const command of ['ls && pm2 restart nassaj-dev', 'echo $(pm2 restart nassaj-dev)',
        'bash -c "pm2 restart nassaj-dev"', 'pkill node', 'pkill', 'pm2  restart   nassaj-dev']) {
        assert.equal(await decide(eng, 'bash', bash(command)), 'deny', command);
      }
    });
    it('an unparseable command matching a deny prefix anywhere is denied, and never allowed', async () => {
      const eng = engine('default', deny);
      assert.equal(await decide(eng, 'bash', bash('echo "x; pm2 restart nassaj-dev')), 'deny');
      assert.equal(await decide(eng, 'bash', bash('echo "unclosed')), 'ask');
    });
    it('allow covers a compound only when every part is allowed; a file redirection is not covered', async () => {
      const eng = engine('default', deny);
      assert.equal(await decide(eng, 'bash', bash('ls -la && echo done')), 'allow');
      assert.equal(await decide(eng, 'bash', bash('ls && rm -rf src')), 'ask');
      assert.equal(await decide(eng, 'bash', bash('echo hi > notes.txt')), 'ask');
    });
    it('dsh bash workdir is matched as `cd <workdir> && <command>`', async () => {
      const eng = engine('default', { permissions: { deny: ['Bash(cd /srv:*)'] } });
      assert.equal(await decide(eng, 'bash', { ...bash('ls'), workdir: '/srv' }), 'deny');
    });
  });

  describe('precedence deny > ask > allow', () => {
    it('applies across sources and effects', async () => {
      const eng = engine('default', { permissions: { allow: ['Bash(git *)'], ask: ['Bash(git push *)'], deny: ['Bash(git push --force *)'] } });
      assert.equal(await decide(eng, 'bash', bash('git status')), 'allow');
      assert.equal(await decide(eng, 'bash', bash('git push origin')), 'ask');
      assert.equal(await decide(eng, 'bash', bash('git push --force origin')), 'deny');
    });
    it('an ask rule asks even in bypassPermissions (measured on Claude 2.1.312)', async () => {
      const eng = engine('bypassPermissions', { permissions: { ask: ['Bash(echo t2089-ask:*)'] } });
      assert.equal(await decide(eng, 'bash', bash('echo t2089-ask hi')), 'ask');
    });
  });

  describe('path rules', () => {
    it('anchors: //abs, /x from the settings file dir, x and ./x from cwd', async () => {
      const eng = engine('bypassPermissions', { permissions: { deny: [`Read(/${root}/secret/**)`, 'Edit(/policy/**)',
        'Edit(src/gen/**)', 'Read(./private/**)'] } });
      assert.equal(await decide(eng, 'read', { file_path: path.join(root, 'secret', 'key.txt') }), 'deny');
      assert.equal(await decide(eng, 'write', { file_path: path.join(managed, 'policy', 'a'), content: '' }), 'deny');
      assert.equal(await decide(eng, 'write', { file_path: path.join(cwd, 'policy', 'a'), content: '' }), 'allow');
      assert.equal(await decide(eng, 'edit', { file_path: 'src/gen/a.ts', old_string: 'a', new_string: 'b' }), 'deny');
      assert.equal(await decide(eng, 'read', { file_path: 'private/x' }), 'deny');
    });
    it('~ in allow is Claude\'s HOME only; in deny/ask it is Claude\'s AND dsh\'s HOME', async () => {
      const eng = engine('default', { permissions: { allow: ['Edit(~/notes/**)'], deny: ['Read(~/vault/**)'] } });
      const edit = (file: string) => ({ file_path: file, old_string: 'a', new_string: 'b' });
      assert.equal(await decide(eng, 'edit', edit(path.join(claudeHome, 'notes', 'a'))), 'allow');
      assert.equal(await decide(eng, 'edit', edit(path.join(dshHome, 'notes', 'a'))), 'ask');
      assert.equal(await decide(eng, 'read', { file_path: path.join(claudeHome, 'vault', 'k') }), 'deny');
      assert.equal(await decide(eng, 'read', { file_path: path.join(dshHome, 'vault', 'k') }), 'deny');
    });
    it('dsh expands ~/ to its own HOME and leaves $HOME literal (stage-0 measurement)', async () => {
      const eng = engine('bypassPermissions', { permissions: { deny: ['Edit(~/vault/**)', `Edit(/${cwd}/$HOME/**)`] } });
      assert.equal(await decide(eng, 'write', { file_path: '~/vault/x', content: '' }), 'deny');
      assert.equal(await decide(eng, 'write', { file_path: '$HOME/x', content: '' }), 'deny');
    });
    it('normalization: deny/ask if the raw OR real path matches; allow only if both do', async () => {
      const eng = engine('default', { permissions: { deny: [`Read(/${root}/secret/**)`], allow: ['Read(link/**)'] } });
      assert.equal(await decide(eng, 'read', { file_path: path.join(cwd, 'src', '..', '..', 'secret', 'key.txt') }), 'deny');
      assert.equal(await decide(eng, 'read', { file_path: path.join(cwd, 'link', 'key.txt') }), 'deny');
      const allowOnly = engine('default', { permissions: { allow: ['Read(link/**)'] } });
      assert.equal(await decide(allowOnly, 'read', { file_path: path.join(cwd, 'link', 'key.txt') }), 'ask');
    });
    it('Read rules govern grep and glob; Edit rules govern write and edit', async () => {
      const eng = engine('bypassPermissions', { permissions: { deny: [`Read(/${root}/secret/**)`, 'Edit(src/**)'] } });
      assert.equal(await decide(eng, 'grep', { pattern: 'k', path: path.join(root, 'secret') }), 'deny');
      assert.equal(await decide(eng, 'glob', { pattern: '*', path: path.join(root, 'secret') }), 'deny');
      assert.equal(await decide(eng, 'write', { file_path: 'src/a.ts', content: '' }), 'deny');
    });
  });

  describe('WebFetch domains and unsupported syntax', () => {
    it('WebFetch(domain:) deny covers subdomains; allow covers the exact host only', async () => {
      const eng = engine('default', { permissions: { deny: ['WebFetch(domain:evil.test)'], allow: ['WebFetch(domain:docs.test)'] } });
      assert.equal(await decide(eng, 'web_fetch', { url: 'https://cdn.evil.test/x' }), 'deny');
      assert.equal(await decide(eng, 'web_fetch', { url: 'https://docs.test/a' }), 'allow');
      assert.equal(await decide(eng, 'web_fetch', { url: 'https://api.docs.test/a' }), 'ask');
    });
    it('mcp__ rules parse (dsh exposes no MCP tool here)', () => {
      assert.doesNotThrow(() => engine('default', { permissions: { deny: ['mcp__srv', 'mcp__srv__tool'] } }));
    });
    it('an uncovered allow rule is absent (ask); an uncovered deny/ask refuses the launch', () => {
      assert.doesNotThrow(() => engine('default', { permissions: { allow: ['FancyTool(x)'] } }));
      assert.throws(() => engine('default', { permissions: { deny: ['FancyTool(x)'] } }), { code: 'parity_rule_unsupported' });
      assert.throws(() => engine('default', { permissions: { ask: ['Bash(unclosed'] } }), { code: 'parity_rule_unsupported' });
    });
  });

  describe('modes', () => {
    const withExtra = () => ({ permissions: { additionalDirectories: [extraDir] } });
    it('default: reads inside cwd and additionalDirectories pass, outside asks; edits ask', async () => {
      const eng = engine('default', withExtra());
      assert.equal(await decide(eng, 'read', { file_path: 'src/a.ts' }), 'allow');
      assert.equal(await decide(eng, 'read', { file_path: path.join(extraDir, 'a') }), 'allow');
      assert.equal(await decide(eng, 'read', { file_path: path.join(root, 'secret', 'key.txt') }), 'ask');
      assert.equal(await decide(eng, 'write', { file_path: 'src/a.ts', content: '' }), 'ask');
      assert.equal(await decide(eng, 'bash', bash('ls')), 'ask');
    });
    it('acceptEdits: edits inside the working dirs pass, outside asks', async () => {
      const eng = engine('acceptEdits', withExtra());
      assert.equal(await decide(eng, 'write', { file_path: 'src/a.ts', content: '' }), 'allow');
      assert.equal(await decide(eng, 'write', { file_path: path.join(extraDir, 'a'), content: '' }), 'allow');
      assert.equal(await decide(eng, 'write', { file_path: path.join(root, 'secret', 'x'), content: '' }), 'ask');
    });
    it('plan: reads follow default, every non-read tool is denied', async () => {
      const eng = engine('plan', {});
      assert.equal(await decide(eng, 'read', { file_path: 'src/a.ts' }), 'allow');
      for (const [tool, args] of [['write', { file_path: 'a', content: '' }], ['bash', bash('ls')], ['subagent', { description: 'd', prompt: 'p' }]] as const) {
        assert.equal(await decide(eng, tool, args), 'deny', tool);
      }
    });
    it('bypassPermissions: allows unless a deny or ask rule matches', async () => {
      const eng = engine('bypassPermissions', { permissions: { deny: ['Bash(rm *)'] } });
      assert.equal(await decide(eng, 'bash', bash('rm -rf x')), 'deny');
      assert.equal(await decide(eng, 'write', { file_path: path.join(root, 'secret', 'x'), content: '' }), 'allow');
    });
    it('~/.claude is a sensitive path: ask outside bypass (even over an allow), allowed in bypass (measured)', async () => {
      const file = { file_path: path.join(dshHome, '.claude', 'x'), content: 'x' };
      assert.equal(await decide(engine('default', { permissions: { allow: ['Edit(~/.claude/**)'] } }), 'write', file), 'ask');
      assert.equal(await decide(engine('acceptEdits', {}), 'write', { ...file, file_path: path.join(claudeHome, '.claude', 'x') }), 'ask');
      assert.equal(await decide(engine('bypassPermissions', {}), 'write', file), 'allow');
    });
  });

  describe('qa veto C1: wrappers, constructs and quoting cannot hide a deny/ask (bypass and default)', () => {
    const settings = { permissions: { deny: ['Bash(pm2 restart *)', 'Bash(rm:*)'], ask: ['Bash(git push *)'] } };
    const hidden = ['timeout 9 pm2 restart a', 'timeout -s KILL 9 pm2 restart a', 'nohup pm2 restart a', 'command pm2 restart a',
      'builtin pm2 restart a', 'noglob pm2 restart a', 'stdbuf -o0 pm2 restart a', 'nice -n 5 pm2 restart a', 'nice pm2 restart a',
      'xargs pm2 restart', 'echo a | xargs pm2 restart', '(pm2 restart a)', '( pm2 restart a )', '{ pm2 restart a; }',
      'for i in 1; do pm2 restart a; done', 'if true; then pm2 restart a; fi', 'if false; then :; else pm2 restart a; fi',
      'while true; do pm2 restart a; done', '! pm2 restart a', '"pm2" restart a', "'pm2' restart a", 'p\\m2 restart a',
      'time pm2 restart a', 'FOO=1 timeout 3 nohup pm2 restart a', 'r\\m -rf x', '"rm" -rf x'];
    for (const mode of ['bypassPermissions', 'default']) {
      it(`${mode}: each hidden form of a denied command is denied`, async () => {
        const eng = engine(mode, settings);
        for (const command of hidden) assert.equal(await decide(eng, 'bash', bash(command)), 'deny', command);
      });
      it(`${mode}: \`time git push\` and \`(git push origin)\` ask`, async () => {
        const eng = engine(mode, settings);
        for (const command of ['time git push origin', '(git push origin)', 'nohup git push origin']) {
          assert.equal(await decide(eng, 'bash', bash(command)), 'ask', command);
        }
      });
    }
  });

  describe('qa veto C2: Read/Edit path rules reach Bash file effects; Read deny covers edits', () => {
    const secret = () => path.join(root, 'secret', 'key.txt');
    const settings = () => ({ permissions: { deny: [`Read(/${root}/secret/**)`, `Edit(/${root}/locked/**)`] } });
    for (const mode of ['bypassPermissions', 'default']) {
      it(`${mode}: redirections, tee and file commands are checked against Edit/Read deny`, async () => {
        const eng = engine(mode, settings());
        const locked = path.join(root, 'locked', 'f');
        for (const command of [`echo x > ${locked}`, `echo x >> ${locked}`, `echo x | tee ${locked}`, `echo x | tee -a ${locked}`,
          `echo x &> ${locked}`, `echo x >| ${locked}`, `cat < ${secret()}`, `cat ${secret()}`, `head -n 1 ${secret()}`,
          `tail ${secret()}`, `sed -n 1p ${secret()}`, `timeout 3 cat ${secret()}`, `(cat ${secret()})`]) {
          assert.equal(await decide(eng, 'bash', bash(command)), 'deny', command);
        }
      });
      it(`${mode}: a Read deny blocks Write and Edit on the same path`, async () => {
        const eng = engine(mode, settings());
        assert.equal(await decide(eng, 'write', { file_path: secret(), content: 'x' }), 'deny');
        assert.equal(await decide(eng, 'edit', { file_path: secret(), old_string: 'a', new_string: 'b' }), 'deny');
      });
    }
  });

  describe('qa round 2: attached redirects, sed -i, dd of=, cd chains', () => {
    for (const mode of ['bypassPermissions', 'default']) {
      it(`${mode}: each write form into an Edit-denied dir is denied`, async () => {
        const eng = engine(mode, { permissions: { deny: [`Edit(/${root}/locked/**)`] } });
        const locked = path.join(root, 'locked', 'f');
        for (const command of [`echo x>${locked}`, `echo x>>${locked}`, `echo x 2>${locked}`, `echo "a>b">${locked}`,
          `sed -i s/a/b/ ${locked}`, `dd if=/dev/zero of=${locked}`, `cd ${path.join(root, 'locked')} && echo x > f`,
          `cd ${root} && echo x > locked/f`, `cd ${root}; tee locked/f`]) {
          assert.equal(await decide(eng, 'bash', bash(command)), 'deny', command);
        }
      });
    }
    it('a quoted > is not a redirect', async () => {
      const eng = engine('default', { permissions: { allow: ['Bash(echo *)'] } });
      assert.equal(await decide(eng, 'bash', bash('echo "a>b"')), 'allow');
    });
  });

  describe('qa veto I1/I2: domain wildcards and redirect gaps', () => {
    it('WebFetch(domain:*.evil.test) denies subdomains; trailing dots are ignored', async () => {
      const eng = engine('bypassPermissions', { permissions: { deny: ['WebFetch(domain:*.evil.test)', 'WebFetch(domain:bad.test.)'] } });
      assert.equal(await decide(eng, 'web_fetch', { url: 'https://a.evil.test/x' }), 'deny');
      assert.equal(await decide(eng, 'web_fetch', { url: 'https://a.b.evil.test./x' }), 'deny');
      assert.equal(await decide(eng, 'web_fetch', { url: 'https://bad.test/x' }), 'deny');
      assert.equal(await decide(eng, 'web_fetch', { url: 'https://good.test/x' }), 'allow');
    });
    it('`>& file`, `<> file` and `>| file` are file writes an echo allow does not cover', async () => {
      const eng = engine('default', { permissions: { allow: ['Bash(echo *)'] } });
      for (const command of ['echo x >& /etc/t', 'echo x <> /etc/t', 'echo x >| /etc/t', 'echo x >&/etc/t']) {
        assert.equal(await decide(eng, 'bash', bash(command)), 'ask', command);
      }
      assert.equal(await decide(eng, 'bash', bash('echo x 2>&1')), 'allow');
    });
  });

  describe('arguments and tools', () => {
    it('qa C2: a subagent call with its own cwd is denied (Task has no cwd); without one it is decided as Task', async () => {
      const eng = engine('bypassPermissions', {});
      for (const tool of ['subagent', 'subagent_fork']) {
        assert.equal(await decide(eng, tool, { description: 'd', prompt: 'p', cwd: '/' }), 'deny', tool);
        assert.equal(await decide(eng, tool, { description: 'd', prompt: 'p', cwd: 'sub' }), 'deny', tool);
        assert.equal(await decide(eng, tool, { description: 'd', prompt: 'p' }), 'allow', tool);
      }
    });
    it('non-object arguments and unknown tools are denied', async () => {
      const eng = engine('bypassPermissions', {});
      for (const args of [[1, 2], 'x', null, 7]) assert.equal(await decide(eng, 'bash', args), 'deny', JSON.stringify(args));
      assert.equal(await decide(eng, 'mystery_tool', {}), 'deny');
    });
    it('the reviewed map covers every live dsh tool and maps to Claude tool names', async () => {
      const schemas = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dsh-policy-tools.json'), 'utf8'));
      const names = schemas.tools.map((tool: { name: string }) => tool.name);
      assert.doesNotThrow(() => assertReviewedTools(names));
      assert.deepEqual([...names].sort(), [...Object.keys(DSH_REVIEWED_TOOLS)].sort());
      assert.throws(() => assertReviewedTools(['mystery_tool']), { code: 'parity_tool_unreviewed' });
      const eng = engine('bypassPermissions', {});
      const verdict = await eng.decideTool({ callId: 'c', tool: 'write', args: { file_path: 'a.txt', content: 'x' } });
      assert.deepEqual(verdict.claude, { tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'a.txt'), content: 'x' } });
    });
  });
});
