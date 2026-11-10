// T-2089 S2: LIVE Claude Code measurement of the permission outcomes the parity suite
// cannot derive from settings alone (ADR-225, qa conditions). Recording only, not shipped.
// Runs real `claude -p` in a fresh /var/tmp cwd with a temp HOME (real CLAUDE_CONFIG_DIR for
// auth, no API URL change), --no-session-persistence, and an extra --settings whose hooks
// log every PreToolUse / PermissionRequest payload. Everything under the run dir is deleted.
// Usage: TMPDIR=/var/tmp node measure-claude.mjs <out.json>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.argv[2];
const run = fs.mkdtempSync(path.join('/var/tmp', 't2089-claude-'));
const home = path.join(run, 'home');
const cwd = path.join(run, 'ws');
const outside = path.join(run, 'outside');
for (const dir of [home, cwd, outside, path.join(home, '.claude')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
const realHome = os.homedir();
fs.symlinkSync(path.join(realHome, 'nassaj-core'), path.join(home, 'nassaj-core'));
const hookLog = path.join(run, 'hooks.jsonl');
const logger = path.join(run, 'log-hook.mjs');
fs.writeFileSync(logger, `import fs from 'node:fs';let s='';process.stdin.on('data',(c)=>{s+=c;});`
  + `process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(hookLog)}, s.trim()+'\\n');});\n`);
const settings = path.join(run, 'extra-settings.json');
const hook = { type: 'command', command: `${process.execPath} ${logger}` };
fs.writeFileSync(settings, JSON.stringify({
  hooks: { PreToolUse: [{ matcher: '', hooks: [hook] }], PermissionRequest: [{ matcher: '', hooks: [hook] }] },
  permissions: { ask: ['Bash(echo t2089-ask:*)'] },
}));
const cases = [
  ['edit-claude-dir-default', 'default', `Use the Write tool exactly once to create ${home}/.claude/t2089-x with content x. Do nothing else.`],
  ['edit-claude-dir-bypass', 'bypassPermissions', `Use the Write tool exactly once to create ${home}/.claude/t2089-y with content y. Do nothing else.`],
  ['config-protection-default', 'default', 'Use the Write tool exactly once to create ./.eslintrc.json with content {}. Do nothing else.'],
  ['read-managed-settings-default', 'default', 'Use the Read tool exactly once on /etc/claude-code/managed-settings.json. Do nothing else.'],
  ['read-outside-default', 'default', `Use the Read tool exactly once on ${outside}/secret.txt. Do nothing else.`],
  ['ask-rule-bypass', 'bypassPermissions', 'Use the Bash tool exactly once to run: echo t2089-ask hi . Do nothing else.'],
  ['ask-rule-default', 'default', 'Use the Bash tool exactly once to run: echo t2089-ask hi . Do nothing else.'],
];
const results = [];
for (const [name, mode, prompt] of cases) {
  const before = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).length : 0;
  const r = spawnSync('claude', ['-p', prompt, '--model', 'haiku', '--permission-mode', mode, '--settings', settings,
    '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--max-turns', '3'], {
    cwd, encoding: 'utf8', timeout: 180000,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? path.join(realHome, '.claude') },
  });
  const events = (r.stdout ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const toolUses = [];
  const toolResults = [];
  for (const e of events) {
    for (const c of e.message?.content ?? []) {
      if (c.type === 'tool_use') toolUses.push({ name: c.name, input: c.input });
      if (c.type === 'tool_result') toolResults.push({ isError: !!c.is_error, text: (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 600) });
    }
  }
  const hooks = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l)) : [];
  const written = ['t2089-x', 't2089-y'].map((f) => path.join(home, '.claude', f)).filter((f) => fs.existsSync(f)).map((f) => path.basename(f));
  results.push({ name, mode, exit: r.status, toolUses, toolResults, hookEvents: hooks.map((h) => ({ event: h.hook_event_name, tool: h.tool_name, permission_mode: h.permission_mode, keys: Object.keys(h).sort() })),
    filesWritten: [...written, ...(fs.existsSync(path.join(cwd, '.eslintrc.json')) ? ['.eslintrc.json'] : [])],
    denials: events.find((e) => e.type === 'result')?.permission_denials ?? null });
}
const scrub = (s) => s.split(run).join('<RUN>').split(realHome).join('<HOST_HOME>');
const version = spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(out, `${scrub(JSON.stringify({ claudeVersion: version, measuredAt: new Date().toISOString().slice(0, 10),
  model: 'haiku', setup: 'temp HOME (nassaj-core linked), real CLAUDE_CONFIG_DIR, host /etc/claude-code managed settings, extra --settings: logging hooks + ask Bash(echo t2089-ask:*)', results }, null, 1))}\n`);
fs.rmSync(run, { recursive: true, force: true });
// Hooks still create per-project state (the slug of the temp cwd) despite --no-session-persistence.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(realHome, '.claude');
fs.rmSync(path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true, force: true });
