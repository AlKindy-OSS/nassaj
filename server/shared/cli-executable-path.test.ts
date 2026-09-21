import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveCliExecutablePath, wellKnownCliInstallCandidates } from '@/shared/cli-executable-path.js';

/** Builds a throwaway HOME with executables at the given relative paths. */
function makeHome(executables: string[], nonExecutable: string[] = []): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-exec-path-'));
  for (const rel of [...executables, ...nonExecutable]) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, executables.includes(rel) ? 0o755 : 0o644);
  }
  return home;
}

const minimalPm2Env = { PATH: '/nonexistent-a:/nonexistent-b' };

test('B-1138: bare command missing from a pm2 PATH resolves to ~/.local/bin', () => {
  const home = makeHome(['.local/bin/codex']);
  const resolved = resolveCliExecutablePath('codex', { homedir: () => home, env: minimalPm2Env, platform: 'linux' });
  assert.equal(resolved, path.join(home, '.local/bin/codex'));
});

test('a PATH hit wins over the well-known dirs', () => {
  const home = makeHome(['.local/bin/hermes', 'custom/hermes']);
  const env = { PATH: path.join(home, 'custom') };
  const resolved = resolveCliExecutablePath('hermes', { homedir: () => home, env, platform: 'linux' });
  assert.equal(resolved, path.join(home, 'custom/hermes'));
});

test('a path-like override is honored verbatim', () => {
  const resolved = resolveCliExecutablePath('agy', { override: '/opt/agy/bin/agy', env: minimalPm2Env, platform: 'linux' });
  assert.equal(resolved, '/opt/agy/bin/agy');
});

test('a bare override is itself resolved', () => {
  const home = makeHome(['.local/bin/qwen-code']);
  const resolved = resolveCliExecutablePath('qwen', {
    override: 'qwen-code', homedir: () => home, env: minimalPm2Env, platform: 'linux',
  });
  assert.equal(resolved, path.join(home, '.local/bin/qwen-code'));
});

test('a non-executable candidate is skipped; nothing found returns the bare command', () => {
  const home = makeHome([], ['.local/bin/kimi']);
  const resolved = resolveCliExecutablePath('kimi', { homedir: () => home, env: minimalPm2Env, platform: 'linux' });
  assert.equal(resolved, 'kimi');
});

test('vendor-specific home dirs are probed after ~/.local/bin', () => {
  const home = makeHome(['.opencode/bin/opencode']);
  const resolved = resolveCliExecutablePath('opencode', {
    extraHomeDirs: ['.opencode/bin'], homedir: () => home, env: minimalPm2Env, platform: 'linux',
  });
  assert.equal(resolved, path.join(home, '.opencode/bin/opencode'));
});

test('win32 keeps the bare command for cross-spawn PATHEXT lookup', () => {
  assert.equal(resolveCliExecutablePath('cursor-agent', { platform: 'win32' }), 'cursor-agent');
});

test('candidate order: native installer, vendor dirs, npm-global, system prefix', () => {
  assert.deepEqual(wellKnownCliInstallCandidates('/h', 'x', ['.v/bin']), [
    '/h/.local/bin/x', '/h/.v/bin/x', '/h/.npm-global/bin/x', '/usr/local/bin/x',
  ]);
  assert.deepEqual(wellKnownCliInstallCandidates('', 'x'), ['/usr/local/bin/x']);
});
