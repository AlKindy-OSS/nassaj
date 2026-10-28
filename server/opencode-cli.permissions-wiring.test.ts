/**
 * B-1707 wiring — the REAL spawnOpenCode with a fake `opencode` that records its
 * argv/env and replays stderr lines opencode 1.19.3 prints. Proves what reaches
 * the child and the client under the owner ruling (OpenCode = Claude's mode):
 *   - no mode → Claude's implicit default (settings defaultMode) → no flag, or plan;
 *   - bypassPermissions / parity full_delegation → the skip flag; plan → `--agent plan`
 *     with nassaj's OPENCODE_PERMISSION; an inherited OPENCODE_PERMISSION never passes;
 *   - parity enforce without full_delegation is refused before any process starts;
 *   - a carrier turn keeps losing every inherited OPENCODE_CONFIG* source (B-1367);
 *   - auto-rejections are one `permission_auto_rejected` frame per permission, and
 *     the closing rejection carries the code; a usage dump is one
 *     `opencode_cli_args_rejected` frame.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

type Frame = { kind?: string; code?: string; content?: string };
type Writer = { userId: null; sessionId: string | null; send(m: Frame): void; setSessionId(id: string): void };
type Spawned = { argv: string[]; env: Record<string, string | null> };

const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'oc-perm-wiring-'));
const dumpPath = path.join(scratch, 'spawn.json');
const stderrPath = path.join(scratch, 'stderr.txt');
const fakeBin = path.join(scratch, 'opencode');
const ENV_KEYS = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION'];
const SKIP = '--dangerously-skip-permissions';
const REJECT = (name: string, pattern: string) =>
  `\u001b[93m\u001b[1m! \u001b[0mpermission requested: ${name} (${pattern}); auto-rejecting`;
const claudeSettings = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(SANDBOX_HOME, '.claude'), 'settings.json');

let spawnOpenCode: (command: string, options: Record<string, unknown>, ws: Writer) => Promise<void>;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Runs one turn; `stderr` lines and `exitCode` are what the fake opencode replays. */
async function run(options: Record<string, unknown>, stderr: string[] = [], exitCode = 0) {
  fs.writeFileSync(stderrPath, JSON.stringify({ lines: stderr, exitCode }));
  const cwd = fs.mkdtempSync(path.join(scratch, 'project-'));
  const frames: Frame[] = [];
  const writer: Writer = {
    userId: null,
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
const fs = require('fs');
const env = {};
for (const k of ${JSON.stringify(ENV_KEYS)}) env[k] = process.env[k] ?? null;
fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({ argv: process.argv.slice(2), env }));
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(stderrPath)}, 'utf8'));
for (const line of plan.lines) process.stderr.write(line + '\\n');
if (plan.exitCode === 0) {
  console.log(JSON.stringify({ type: 'text', sessionID: 'oc-perm-1', text: 'ok' }));
  console.log(JSON.stringify({ type: 'step_finish', sessionID: 'oc-perm-1' }));
}
process.exitCode = plan.exitCode;
`, { mode: 0o755 });
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
  setEnv('OPENCODE_PERMISSION', '{"*":"allow","external_directory":"allow"}');
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
    assert.equal(spawned.env.OPENCODE_PERMISSION, null);
  });

  it('no mode + Claude settings defaultMode plan → read-only plan run', async () => {
    fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { defaultMode: 'plan' } }));
    const { spawned } = await run({});
    assert.ok(spawned);
    const at = spawned.argv.indexOf('--agent');
    assert.equal(spawned.argv[at + 1], 'plan');
    assert.deepEqual(JSON.parse(spawned.env.OPENCODE_PERMISSION ?? 'null'), { edit: 'deny', bash: 'deny' });
  });

  it('bypassPermissions → the skip flag before the prompt', async () => {
    const { spawned } = await run({ permissionMode: 'bypassPermissions' });
    assert.ok(spawned?.argv.includes(SKIP));
    assert.match(spawned.argv.at(-1) ?? '', /hi/);
    assert.ok(spawned.argv.indexOf(SKIP) < spawned.argv.length - 1);
    assert.equal(spawned.env.OPENCODE_PERMISSION, null);
  });

  it('a Claude settings bypass gate keeps OpenCode off the skip flag too', async () => {
    fs.writeFileSync(claudeSettings, JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }));
    const { spawned } = await run({ permissionMode: 'bypassPermissions' });
    assert.ok(spawned);
    assert.equal(spawned.argv.includes(SKIP), false);
  });

  it('parity enforce + full_delegation → skip flag, even with a restricted request mode', async () => {
    const { spawned } = await run({
      permissionMode: 'plan',
      permissionExecution: { mode: 'enforce', effectivePolicy: { profileId: 'full_delegation' } },
    });
    assert.ok(spawned?.argv.includes(SKIP));
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
      assert.ok(spawned.argv.includes(SKIP));
      for (const key of ENV_KEYS) assert.equal(spawned.env[key], null, key);
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
    const { frames, rejected } = await run({}, usage, 1);
    const errors = frames.filter((f) => f.kind === 'error');
    assert.deepEqual(errors.map((f) => f.code), ['opencode_cli_args_rejected'], JSON.stringify(errors));
    assert.equal(rejected?.providerErrorCode, 'opencode_cli_args_rejected');
  });
});
