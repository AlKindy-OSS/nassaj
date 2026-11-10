/**
 * B-1707 / ADR-226 wiring — the REAL spawnOpenCode with a fake `opencode` that plays the
 * channel-client plugin (hello over fd 3), records its argv/env and the prompt it read
 * from stdin, and replays stderr lines opencode prints. Proves what reaches the child and
 * the client under the owner ruling (OpenCode = Claude's mode):
 *   - no mode → Claude's implicit default (settings defaultMode) → no flag, or plan;
 *   - OpenCode's skip flag is NEVER passed (bypass and full_delegation included, ADR-226);
 *     plan → `--agent plan`; L1 = `{"*":"allow"}` + Claude's deny rules (+ the plan block);
 *     an inherited OPENCODE_PERMISSION never passes;
 *   - the prompt goes over stdin after the hello, never in argv;
 *   - parity enforce without full_delegation is refused before any process starts;
 *   - a carrier turn keeps losing every inherited OPENCODE_CONFIG* source (B-1367); the
 *     inline config it gets is nassaj's (plugin first, lsp/formatter off);
 *   - auto-rejections are one `permission_auto_rejected` frame per permission, and
 *     the closing rejection carries the code; a usage dump is one
 *     `opencode_cli_args_rejected` frame.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { FAKE_OPENCODE_PARITY_PRELUDE, installManagedClaudePlugins } from '@/shared/__tests__/fake-opencode-parity.js';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

// ADR-152 A1 §3.4: an opencode run needs a signed-in member (id 7), recorded
// against a real schema.
{
  const memberDb = await import('@/modules/database/index.js');
  await memberDb.initializeDatabase();
  memberDb.getConnection().prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (7, 'member-7', 'x')").run();
}

type Frame = { kind?: string; code?: string; content?: string };
type Writer = { userId: number; sessionId: string | null; send(m: Frame): void; setSessionId(id: string): void };
type Spawned = { argv: string[]; env: Record<string, string | null>; prompt: string };

const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'oc-perm-wiring-'));
const dumpPath = path.join(scratch, 'spawn.json');
const stderrPath = path.join(scratch, 'stderr.txt');
const fakeBin = path.join(scratch, 'opencode');
const ENV_KEYS = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'OPENCODE_PURE',
  'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_LSP_DOWNLOAD', 'OPENCODE_EXPERIMENTAL_CODE_MODE', 'OPENCODE_ENABLE_EXA'];
const SKIP = '--dangerously-skip-permissions';
const INHERITED_PERMISSION = '{"*":"allow","external_directory":"allow"}';
/** ADR-226: OPENCODE_PERMISSION is always nassaj's L1, `"*":"allow"` first, never the inherited one. */
function assertNassajPermission(env: Record<string, string | null>): Record<string, unknown> {
  assert.notEqual(env.OPENCODE_PERMISSION, INHERITED_PERMISSION);
  const l1 = JSON.parse(env.OPENCODE_PERMISSION ?? 'null');
  assert.equal(typeof l1, 'object');
  assert.equal(Object.keys(l1)[0], '*');
  assert.equal(l1['*'], 'allow');
  return l1;
}
/** The carrier env: OPENCODE_CONFIG/_DIR stripped, inline config = nassaj's keys only. */
function assertCarrierEnv(env: Record<string, string | null>): void {
  assert.equal(env.OPENCODE_CONFIG, null);
  assert.equal(env.OPENCODE_CONFIG_DIR, null);
  assert.deepEqual(Object.keys(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).sort(), ['formatter', 'lsp', 'plugin']);
  assertNassajPermission(env);
}
const REJECT = (name: string, pattern: string) =>
  `\u001b[93m\u001b[1m! \u001b[0mpermission requested: ${name} (${pattern}); auto-rejecting`;
// The run member's (7) own Claude settings: OpenCode follows THAT tree (ADR-152 A1).
const claudeSettings = path.join(SANDBOX_HOME, '.nassaj-users', '7', '.claude', 'settings.json');

let spawnOpenCode: (command: string, options: Record<string, unknown>, ws: Writer) => Promise<void>;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Runs one turn; `stderr` lines and `exitCode` are what the fake opencode replays. */
async function run(options: Record<string, unknown>, stderr: string[] = [], exitCode = 0, stdout: object[] = [], usage = false) {
  fs.writeFileSync(stderrPath, JSON.stringify({ lines: stderr, exitCode, stdout, usage }));
  const cwd = fs.mkdtempSync(path.join(scratch, 'project-'));
  const frames: Frame[] = [];
  const writer: Writer = {
    userId: 7,
    sessionId: null,
    send(m) { frames.push(m); },
    setSessionId(id) { this.sessionId = id; },
  };
  let rejected: (Error & { providerErrorCode?: string }) | null = null;
  await spawnOpenCode('hi', { cwd, model: 'opencode/glm-5.3-flash-free', ...options }, writer)
    .catch((error: Error) => { rejected = error; });
  const spawned = fs.existsSync(dumpPath) ? JSON.parse(fs.readFileSync(dumpPath, 'utf8')) as Spawned : null;
  return { frames, spawned, rejected: rejected as (Error & { providerErrorCode?: string }) | null };
}

before(async () => {
  fs.writeFileSync(fakeBin, `#!${process.execPath}
${FAKE_OPENCODE_PARITY_PRELUDE}
(async () => {
const fs = require('fs');
const env = {};
for (const k of ${JSON.stringify(ENV_KEYS)}) env[k] = process.env[k] ?? null;
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(stderrPath)}, 'utf8'));
// An argv opencode refuses prints its usage and exits before any plugin loads.
if (plan.usage) {
  fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({ argv: process.argv.slice(2), env, prompt: '' }));
  for (const line of plan.lines) process.stderr.write(line + '\\n');
  process.exit(1);
}
await globalThis.FAKE_OPENCODE_READY;
fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({ argv: process.argv.slice(2), env, prompt: globalThis.FAKE_OPENCODE_PROMPT }));
for (const line of plan.lines) process.stderr.write(line + '\\n');
for (const event of plan.stdout || []) console.log(JSON.stringify(event));
if (plan.exitCode === 0) {
  console.log(JSON.stringify({ type: 'text', sessionID: 'oc-perm-1', text: 'ok' }));
  console.log(JSON.stringify({ type: 'step_finish', sessionID: 'oc-perm-1' }));
}
process.exitCode = plan.exitCode;
})();
`, { mode: 0o755 });
  installManagedClaudePlugins(SANDBOX_HOME, 7);
  // The carrier governance gate needs the neutral source it copies into the config home.
  fs.mkdirSync(path.join(SANDBOX_HOME, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX_HOME, '.claude', 'AGENTS.md'), '# neutral governance\n');
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  setEnv('OPENCODE_PATH', fakeBin);
  setEnv('NASSAJ_OPENCODE_CARRIER', '1');
  // Server-side sources that must never reach the child as they are.
  setEnv('OPENCODE_CONFIG', path.join(scratch, 'evil.json'));
  setEnv('OPENCODE_CONFIG_DIR', scratch);
  setEnv('OPENCODE_CONFIG_CONTENT', '{"permission":{"*":"deny"}}');
  setEnv('OPENCODE_PERMISSION', INHERITED_PERMISSION);
  ({ spawnOpenCode } = await import('./opencode-cli.js'));
});

beforeEach(() => {
  fs.rmSync(dumpPath, { force: true });
  fs.rmSync(claudeSettings, { force: true });
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('B-1707 OpenCode follows the Claude permission mode', () => {
  it('no mode = Claude implicit default: no flag, and the inherited OPENCODE_PERMISSION is dropped', async () => {
    const { spawned, frames } = await run({});
    assert.ok(spawned, `opencode must start: ${JSON.stringify(frames)}`);
    assert.equal(spawned.argv.includes(SKIP), false);
    assert.equal(spawned.argv.includes('--agent'), false);
    assertNassajPermission(spawned.env);
  });

  it('ADR-226: the prompt reaches opencode over stdin after the hello, never in argv', async () => {
    const { spawned } = await run({});
    assert.ok(spawned);
    assert.match(spawned.prompt, /hi/);
    assert.equal(spawned.argv.some((arg) => /\bhi\b/.test(arg)), false);
    assert.equal(spawned.argv.includes('--'), false);
  });

  it('ADR-226: lsp/formatter off, LSP download off, project config off (D2), experimental flags stripped', async () => {
    setEnv('OPENCODE_EXPERIMENTAL_CODE_MODE', '1');
    setEnv('OPENCODE_ENABLE_EXA', '1');
    try {
      const { spawned } = await run({});
      assert.ok(spawned);
      const inline = JSON.parse(spawned.env.OPENCODE_CONFIG_CONTENT ?? '{}');
      assert.equal(inline.lsp, false);
      assert.equal(inline.formatter, false);
      assert.match(String(inline.plugin?.[0]), /nassaj-claude-parity\.js$/, 'the parity plugin is first');
      assert.equal(spawned.env.OPENCODE_DISABLE_LSP_DOWNLOAD, '1');
      assert.equal(spawned.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
      assert.equal(spawned.env.OPENCODE_EXPERIMENTAL_CODE_MODE, null);
      assert.equal(spawned.env.OPENCODE_ENABLE_EXA, null);
    } finally {
      setEnv('OPENCODE_EXPERIMENTAL_CODE_MODE', undefined);
      setEnv('OPENCODE_ENABLE_EXA', undefined);
    }
  });

  it('no mode + Claude settings defaultMode plan → read-only plan run', async () => {
    fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { defaultMode: 'plan' } }));
    const { spawned } = await run({});
    assert.ok(spawned);
    const at = spawned.argv.indexOf('--agent');
    assert.equal(spawned.argv[at + 1], 'plan');
    const l1 = assertNassajPermission(spawned.env);
    assert.equal(l1.edit, 'deny');
    assert.equal(l1.bash, 'deny');
  });

  // ADR-226 (was: the skip flag): the parity engine decides bypass; OpenCode gets no flag.
  it('bypassPermissions → no skip flag (the engine decides every call)', async () => {
    const { spawned } = await run({ permissionMode: 'bypassPermissions' });
    assert.ok(spawned);
    assert.equal(spawned.argv.includes(SKIP), false);
    assertNassajPermission(spawned.env);
  });

  it('a Claude settings bypass gate keeps OpenCode off the skip flag too', async () => {
    fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }));
    const { spawned } = await run({ permissionMode: 'bypassPermissions' });
    assert.ok(spawned);
    assert.equal(spawned.argv.includes(SKIP), false);
  });

  it('parity enforce + full_delegation → bypass without the skip flag; Task is denied in L1', async () => {
    const { spawned } = await run({
      permissionMode: 'plan',
      permissionExecution: { mode: 'enforce', effectivePolicy: { profileId: 'full_delegation' } },
    });
    assert.ok(spawned);
    assert.equal(spawned.argv.includes(SKIP), false);
    assert.equal(spawned.argv.includes('--agent'), false);
    assert.equal(assertNassajPermission(spawned.env).task, 'deny');
  });

  it('parity enforce without full_delegation is refused before any process starts', async () => {
    const { spawned, frames, rejected } = await run({
      permissionExecution: { mode: 'enforce', effectivePolicy: null },
    });
    assert.equal(spawned, null);
    assert.ok(rejected);
    assert.deepEqual(frames.filter((f) => f.kind === 'error').map((f) => f.code), ['permission_denied']);
  });

  it('a GLM carrier turn follows the same mode and still loses every OPENCODE_CONFIG* source', async () => {
    for (const options of [{ model: 'glm/glm-4.6' }, { model: 'glm/glm-4.6', carrier: true }]) {
      fs.rmSync(dumpPath, { force: true });
      const { spawned, frames } = await run({ ...options, permissionMode: 'bypassPermissions' });
      assert.ok(spawned, `carrier must start: ${JSON.stringify(frames)}`);
      assert.equal(spawned.argv.includes(SKIP), false);
      assertCarrierEnv(spawned.env);
    }
  });
});

describe('B-1707 honest stderr', () => {
  it('one permission_auto_rejected frame per permission; other stderr stays unclassified', async () => {
    const { frames } = await run({}, [
      REJECT('external_directory', '/home/x/outside/*'),
      REJECT('external_directory', '/home/user/*'),
      REJECT('bash', 'rm -rf /home/x'),
      'some other opencode warning',
    ]);
    const errors = frames.filter((f) => f.kind === 'error');
    const rejected = errors.filter((f) => f.code === 'permission_auto_rejected');
    assert.deepEqual(rejected.map((f) => (f.content ?? '').match(/"(\w+)"/)?.[1]), ['external_directory', 'bash']);
    assert.ok(rejected.every((f) => !/\/home\//.test(f.content ?? '')), 'no path in the frame');
    const plain = errors.filter((f) => !f.code);
    assert.ok(plain.some((f) => /some other opencode warning/.test(f.content ?? '')));
    assert.ok(plain.every((f) => !/auto-rejecting/.test(f.content ?? '')));
  });

  it('a failed run carries permission_auto_rejected on its closing rejection (P3)', async () => {
    const { rejected } = await run({}, [REJECT('external_directory', '/x/*')], 1);
    assert.ok(rejected);
    assert.equal(rejected.providerErrorCode, 'permission_auto_rejected');
  });

  it('a usage dump is one opencode_cli_args_rejected frame and the closing code (I1)', async () => {
    const usage = ['opencode run [message..]', '', 'run opencode with a message', '', 'Options:',
      '      --auto         auto-approve permissions that are not explicitly denied (dangerous!)'];
    const { frames, rejected } = await run({}, usage, 1, [], true);
    const errors = frames.filter((f) => f.kind === 'error');
    assert.deepEqual(errors.map((f) => f.code), ['opencode_cli_args_rejected'], JSON.stringify(errors));
    assert.equal(rejected?.providerErrorCode, 'opencode_cli_args_rejected');
  });
});

describe('ADR-226 Claude rules bind the turn', () => {
  const refusedTool = (code: string) => ({
    type: 'tool_use', sessionID: 'oc-perm-1',
    part: { tool: 'bash', callID: 'c1', state: { status: 'error', input: { command: 'pm2 restart all' },
      error: `Error: nassaj:${code}: Claude's rule covers "pm2 restart all"` } },
  });

  it('a refused call on stdout (no decision recorded) kills the turn as an undecided result', async () => {
    // The fake prints a settled tool part the broker never decided: a bypass, so the turn fails.
    const { frames, rejected } = await run({}, [], 0, [refusedTool('permission_denied_by_claude_rule')]);
    assert.ok(rejected);
    assert.equal(rejected.providerErrorCode, 'parity_undecided_result');
    assert.ok(frames.some((f) => f.kind === 'error' && f.code === 'parity_undecided_result'));
  });

  it('a plugin that never says hello: nothing is written to stdin, the tree is killed, opencode_parity_not_loaded', async () => {
    setEnv('FAKE_OPENCODE_SKIP_HELLO', '1');
    setEnv('NASSAJ_OPENCODE_HANDSHAKE_TIMEOUT_MS', '1500');
    try {
      const { frames, rejected } = await run({});
      assert.ok(rejected);
      assert.equal(rejected.providerErrorCode, 'opencode_parity_not_loaded');
      assert.deepEqual(frames.filter((f) => f.kind === 'error').map((f) => f.code), ['opencode_parity_not_loaded']);
    } finally {
      setEnv('FAKE_OPENCODE_SKIP_HELLO', undefined);
      setEnv('NASSAJ_OPENCODE_HANDSHAKE_TIMEOUT_MS', undefined);
    }
  });

  it('a path-specifier deny rule (engine only, not expressible in L1) still runs the turn', async () => {
    fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { deny: ['Read(./secrets/**)'] } }));
    const { spawned, frames } = await run({});
    assert.ok(spawned, JSON.stringify(frames));
    assert.equal(assertNassajPermission(spawned.env).read, undefined, 'L1 carries no path rule');
  });

  it('M3: a corrupt Claude settings file refuses; a missing one does not', async () => {
    fs.writeFileSync(claudeSettings, '{corrupt');
    const corrupt = await run({});
    assert.equal(corrupt.spawned, null);
    assert.deepEqual(corrupt.frames.filter((f) => f.kind === 'error').map((f) => f.code),
      ['PERMISSION_EFFECTIVE_POLICY_REQUIRED']);
    fs.rmSync(claudeSettings, { force: true });
    assert.ok((await run({})).spawned);
  });

  it('a user deny rule reaches L1; OPENCODE_PURE never reaches the child', async () => {
    setEnv('OPENCODE_PURE', '1');
    try {
      fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { deny: ['Bash(b1711-marker:*)'] } }));
      const { spawned } = await run({});
      assert.ok(spawned);
      const l1 = assertNassajPermission(spawned.env);
      assert.equal((l1.bash as Record<string, string>)['b1711-marker *'], 'deny');
      assert.equal(spawned.env.OPENCODE_PURE, null);
    } finally {
      setEnv('OPENCODE_PURE', undefined);
    }
  });
});
