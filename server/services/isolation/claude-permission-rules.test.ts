/** ADR-221 (B-1711): the shared settings reader, the Claude rule IR, and the OpenCode emitter. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { collectClaudePermissionRules, parseClaudeRule } from './claude-permission-rules.js';
import { readClaudeSpawnSettings } from './claude-spawn-settings.js';
import { bashPatternsFor, emitOpenCodeRules } from './opencode-rule-emitter.js';

const root = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'claude-rules-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;

function layout(files: { user?: string; managed?: string; project?: string }) {
  seq += 1;
  const base = path.join(root, `c${seq}`);
  const configDir = path.join(base, 'config');
  const managedSettingsDir = path.join(base, 'managed');
  const cwd = path.join(base, 'project');
  for (const dir of [configDir, managedSettingsDir, path.join(cwd, '.claude')]) fs.mkdirSync(dir, { recursive: true });
  if (files.user !== undefined) fs.writeFileSync(path.join(configDir, 'settings.json'), files.user);
  if (files.managed !== undefined) fs.writeFileSync(path.join(managedSettingsDir, 'managed-settings.json'), files.managed);
  if (files.project !== undefined) fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), files.project);
  const env = { HOME: base, CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  return { env, cwd, ctx: { userId: seq, managedSettingsDir }, configDir };
}
const perms = (deny: string[] = [], ask: string[] = [], extra: object = {}) =>
  JSON.stringify({ permissions: { deny, ask }, ...extra });

describe('readClaudeSpawnSettings', () => {
  it('classifies ok / missing / unreadable (corrupt or not an object)', () => {
    const l = layout({ user: '{bad json', managed: '[1]', project: perms(['Bash(x)']) });
    const by = Object.fromEntries(readClaudeSpawnSettings(l.env, l.cwd, l.ctx).map((s) => [s.label, s.status]));
    assert.equal(by['user settings'], 'unreadable');
    assert.equal(by['managed policy settings'], 'unreadable');
    assert.equal(by['project settings'], 'ok');
    assert.equal(by['local project settings'], 'missing');
  });

  it('caches per (user, cwd) and re-reads when a file changes', () => {
    const l = layout({ user: perms(['Bash(a)']) });
    const first = readClaudeSpawnSettings(l.env, l.cwd, l.ctx);
    assert.equal(readClaudeSpawnSettings(l.env, l.cwd, l.ctx), first, 'same object while unchanged');
    fs.writeFileSync(path.join(l.configDir, 'settings.json'), perms(['Bash(a)', 'Bash(bb)']));
    const second = readClaudeSpawnSettings(l.env, l.cwd, l.ctx);
    assert.notEqual(second, first);
    assert.deepEqual(second.find((s) => s.label === 'user settings')?.settings, { permissions: { deny: ['Bash(a)', 'Bash(bb)'], ask: [] } });
  });
});

describe('parseClaudeRule', () => {
  it('translates the Bash shapes found in the live managed settings', () => {
    assert.deepEqual(parseClaudeRule('Bash(pkill:*)', 'deny', 's'),
      { tool: 'bash', effect: 'deny', source: 's', raw: 'Bash(pkill:*)', kind: 'bash', match: 'prefix', pattern: 'pkill' });
    assert.equal(parseClaudeRule('Bash(pm2 restart nassaj-dev)', 'deny', 's')?.match, 'exact');
    assert.equal(parseClaudeRule('Bash(pm2  restart   *)', 'ask', 's')?.pattern, 'pm2 restart *');
    assert.equal(parseClaudeRule('Bash(pm2 restart *)', 'ask', 's')?.match, 'glob');
  });

  it('bare tools and Bash(*) deny the whole tool; Claude names map to OpenCode ids', () => {
    for (const [raw, tool] of [['Bash', 'bash'], ['Bash(*)', 'bash'], ['Write', 'edit'], ['WebFetch', 'webfetch'], ['Agent', 'task']]) {
      const r = parseClaudeRule(raw, 'deny', 's');
      assert.equal(r?.kind, 'tool', raw);
      assert.equal(r?.tool, tool, raw);
    }
  });

  it('returns null for what this slice cannot enforce (never a silent allow)', () => {
    for (const raw of ['Read(./.env)', 'Edit(src/**)', 'WebFetch(domain:x.com)', 'mcp__srv__tool', 'mcp__srv',
      'UnknownTool', 'Bash(', '', 42]) {
      assert.equal(parseClaudeRule(raw, 'deny', 's'), null, String(raw));
    }
  });
});

describe('collectClaudePermissionRules', () => {
  const sources = (l: ReturnType<typeof layout>) => readClaudeSpawnSettings(l.env, l.cwd, l.ctx);

  it('collects deny and ask from every loaded source plus disallowedTools', () => {
    const l = layout({ managed: perms(['Bash(pkill:*)'], ['Bash(pm2 restart *)']), user: perms(['WebSearch']) });
    const r = collectClaudePermissionRules(sources(l), { disallowedTools: ['Bash(rm -rf *)'] });
    assert.deepEqual(r.rules.map((x) => [x.raw, x.effect, x.source]), [
      ['Bash(pkill:*)', 'deny', 'managed policy settings'],
      ['Bash(pm2 restart *)', 'ask', 'managed policy settings'],
      ['WebSearch', 'deny', 'user settings'],
      ['Bash(rm -rf *)', 'deny', 'request'],
    ]);
    assert.deepEqual(r.unsupported, []);
    assert.deepEqual(r.unreadable, []);
  });

  it('allowManagedPermissionRulesOnly keeps managed rules only', () => {
    const l = layout({ managed: perms(['Bash(a)'], [], { allowManagedPermissionRulesOnly: true }), user: perms(['Bash(b)']) });
    assert.deepEqual(collectClaudePermissionRules(sources(l)).rules.map((x) => x.raw), ['Bash(a)']);
  });

  it('reports unsupported and unreadable sources for the caller to refuse (P2, M3)', () => {
    const l = layout({ user: perms(['Read(./secret)'], ['mcp__x__y']), project: '{oops' });
    const r = collectClaudePermissionRules(sources(l));
    assert.deepEqual(r.unsupported, ['Read(./secret)', 'mcp__x__y']);
    assert.deepEqual(r.unreadable, ['project settings']);
  });

  it('a member with no settings files at all yields no rules and no refusal', () => {
    const r = collectClaudePermissionRules(sources(layout({})));
    assert.deepEqual(r, { rules: [], unsupported: [], unreadable: [] });
  });
});

// ADR-226: L1 = allow-all first, Claude's deny rules, then the plan block; asks are the engine's.
describe('emitOpenCodeRules', () => {
  const rule = (raw: string, effect: 'deny' | 'ask') => parseClaudeRule(raw, effect, 's')!;

  it('L1: allow-all first, then deny rules (prefix and trailing glob widened); ask rules are not translated', () => {
    const l1 = emitOpenCodeRules({
      plan: false,
      rules: [rule('Bash(pm2 restart *)', 'ask'), rule('Bash(pkill:*)', 'deny'), rule('Bash(pm2 restart all)', 'deny'),
        rule('WebFetch', 'ask')],
    });
    assert.deepEqual(Object.keys(l1), ['*', 'bash']);
    assert.equal(l1['*'], 'allow');
    assert.deepEqual(Object.entries(l1.bash as object), [['pkill', 'deny'], ['pkill *', 'deny'], ['pm2 restart all', 'deny']]);
  });

  it('plan: the plan block comes last, after the deny rules', () => {
    const l1 = emitOpenCodeRules({ plan: true, rules: [rule('Bash(pkill:*)', 'deny'), rule('WebSearch', 'deny')] });
    assert.deepEqual(l1, { '*': 'allow', websearch: 'deny', edit: 'deny', bash: 'deny' });
    assert.deepEqual(Object.keys(l1), ['*', 'websearch', 'edit', 'bash']);
  });

  it('a bare Bash deny wins over patterns in L1, in either order', () => {
    assert.equal(emitOpenCodeRules({ plan: false, rules: [rule('Bash(x)', 'deny'), rule('Bash', 'deny')] }).bash, 'deny');
    assert.equal(emitOpenCodeRules({ plan: false, rules: [rule('Bash', 'deny'), rule('Bash(x)', 'deny')] }).bash, 'deny');
  });

  it('bashPatternsFor never drops the base of a trailing glob', () => {
    assert.deepEqual(bashPatternsFor({ match: 'glob', pattern: 'a b *' }), ['a b *', 'a b']);
    assert.deepEqual(bashPatternsFor({ match: 'glob', pattern: 'a*b' }), ['a*b']);
  });
});
