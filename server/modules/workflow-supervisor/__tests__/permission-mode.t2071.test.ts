/**
 * T-2071 — every headless `claude -p` the workflow supervisor spawns passes
 * `--permission-mode` explicitly, taken from the session's own mode (the CLI's
 * default flips between versions: `auto` on 2.1.285, `default` on 2.1.302).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PERMISSION_MODE_TAIL_BYTES, readSessionPermissionMode } from '../handoff.js';
import { capTranscriptPermissionMode, lastTranscriptPermissionMode } from '../permission-mode.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
}

/** A stand-in claude that records its argv (one per line) and prints `{}`. */
function fakeClaude(dir: string): { bin: string; argsFile: string } {
  const argsFile = path.join(dir, 'argv.txt');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '{}'\n`, { mode: 0o755 });
  return { bin, argsFile };
}

/** The value following `flag` in a recorded argv, or undefined. */
function flagValue(argsFile: string, flag: string): string | undefined {
  const argv = fs.readFileSync(argsFile, 'utf8').split('\n');
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

// Row shapes as the CLI 2.1.306 writes them (captured 2026-10-27, trimmed).
const humanRow = (mode: string) => JSON.stringify({
  type: 'user', isSidechain: false, message: { role: 'user', content: 'hi' },
  permissionMode: mode, promptSource: 'sdk', turnOrigin: 'sdk',
});

test('the latest top-level user row names the session mode', () => {
  const text = [humanRow('default'), humanRow('acceptEdits'), JSON.stringify({ type: 'assistant' })].join('\n');
  assert.equal(lastTranscriptPermissionMode(text), 'acceptEdits');
});

test('sidechain rows, unknown modes and garbage are skipped', () => {
  const side = JSON.stringify({ type: 'user', isSidechain: true, permissionMode: 'bypassPermissions' });
  const bogus = JSON.stringify({ type: 'user', permissionMode: 'everything' });
  const text = [humanRow('plan'), side, bogus, '{"permissionMode": broken'].join('\n');
  assert.equal(lastTranscriptPermissionMode(text), 'plan');
});

test('an absent or modeless transcript falls back to default', () => {
  assert.equal(lastTranscriptPermissionMode(null), 'default');
  assert.equal(lastTranscriptPermissionMode(JSON.stringify({ type: 'user' })), 'default');
});

test('task-runner always passes --permission-mode to claude', () => {
  const dir = scratch('t2071-task-');
  try {
    const { bin, argsFile } = fakeClaude(dir);
    const configDir = path.join(dir, 'config');
    fs.mkdirSync(configDir);
    const env = { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: configDir, TMPDIR: dir };
    const runner = path.join(here, '..', 'task-runner.ts');
    const run = (extra: string[], taskDir: string) => spawnSync(process.execPath,
      ['--import', import.meta.resolve('tsx'), runner, '--task-dir', path.join(dir, taskDir), '--claude-bin', bin,
        '--prompt', 'p', ...extra], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });

    const explicit = run(['--permission-mode', 'acceptEdits'], 'a');
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(flagValue(argsFile, '--permission-mode'), 'acceptEdits');

    const omitted = run([], 'b');
    assert.equal(omitted.status, 0, omitted.stderr);
    assert.equal(flagValue(argsFile, '--permission-mode'), 'default', 'omitted ⇒ explicit default');

    const unknown = run(['--permission-mode', 'everything'], 'c');
    assert.notEqual(unknown.status, 0, 'an unknown mode is refused, never forwarded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the resume turn passes the given --permission-mode to claude', async () => {
  const dir = scratch('t2071-resume-');
  try {
    const { bin, argsFile } = fakeClaude(dir);
    const realBinaries = await import('@/shared/harness-binaries.js');
    mock.module('@/shared/harness-binaries.js', {
      namedExports: { ...realBinaries, resolveHarnessBinaryWithOverride: () => bin },
    });
    const { defaultRunResumeTurn } = await import('../resume-turn-runner.js');
    const configDir = path.join(dir, 'config');
    fs.mkdirSync(configDir);
    const result = await defaultRunResumeTurn({
      userId: 7,
      conversationId: 'sess-1',
      projectPath: dir,
      prompt: 'p',
      systemFraming: 's',
      model: null,
      permissionMode: 'plan',
      disallowedTools: ['Agent'],
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: configDir },
      maxHoldMs: 10_000,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(flagValue(argsFile, '--permission-mode'), 'plan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4 guard: a transcript mode never raises a turn above default', () => {
  assert.equal(capTranscriptPermissionMode('plan'), 'plan', 'narrower than default stays');
  assert.equal(capTranscriptPermissionMode('default'), 'default');
  for (const wide of ['acceptEdits', 'bypassPermissions', 'auto', 'dontAsk'] as const) {
    assert.equal(capTranscriptPermissionMode(wide), 'default', wide);
  }
});

test('M4: the resume mode is capped and read from a bounded tail only', () => {
  const dir = scratch('t2071-tail-');
  try {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, `${humanRow('bypassPermissions')}\n`);
    assert.equal(readSessionPermissionMode(file), 'default', 'bypass from the transcript is capped');
    fs.writeFileSync(file, `${humanRow('plan')}\n`);
    assert.equal(readSessionPermissionMode(file), 'plan');
    const padding = `${JSON.stringify({ type: 'assistant', pad: 'x'.repeat(1000) })}\n`
      .repeat(Math.ceil(PERMISSION_MODE_TAIL_BYTES / 1000) + 10);
    fs.writeFileSync(file, `${humanRow('plan')}\n${padding}`);
    assert.equal(readSessionPermissionMode(file), 'default', 'a row before the tail is not read');
    assert.equal(readSessionPermissionMode(path.join(dir, 'absent.jsonl')), 'default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
