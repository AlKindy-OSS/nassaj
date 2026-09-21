/**
 * B-1058: the managed terminal launcher must find a Claude binary that a
 * pm2/systemd-launched server cannot see on its minimal PATH (native installer
 * in ~/.local/bin). Regression seen on a fleet node after 1.47.0.9:
 * "Claude executable not found before installing the managed terminal launcher".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  installManagedClaudeTerminalEnv,
  resolveRealClaudeBinary,
  wellKnownClaudeInstallCandidates,
} from './managed-claude-terminal-env.js';

const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/games'].join(path.delimiter);

function makeExecutable(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
}

function withTempHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'b1058-home-'));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('B-1058: falls back to the native installer path ~/.local/bin/claude when PATH lacks it', () => {
  withTempHome((home) => {
    const real = makeExecutable(path.join(home, '.local', 'bin', 'claude'));
    const env = { HOME: home, PATH: SYSTEM_PATH } as NodeJS.ProcessEnv;
    delete env.CLAUDE_CLI_PATH;
    const resolved = resolveRealClaudeBinary(env, 'claude', {
      // Only the temp HOME exists; every system PATH entry is treated as missing.
      existsSync: (p) => String(p).startsWith(home) && fs.existsSync(p),
    });
    assert.equal(resolved, path.resolve(real));
  });
});

test('B-1058: a PATH hit still wins over the well-known install dirs', () => {
  withTempHome((home) => {
    makeExecutable(path.join(home, '.local', 'bin', 'claude'));
    const onPath = makeExecutable(path.join(home, 'custom-bin', 'claude'));
    const env = {
      HOME: home,
      PATH: [path.join(home, 'custom-bin'), SYSTEM_PATH].join(path.delimiter),
    } as NodeJS.ProcessEnv;
    assert.equal(resolveRealClaudeBinary(env, 'claude'), path.resolve(onPath));
  });
});

test('B-1058: well-known candidates are ordered native → legacy local → npm-global → /usr/local/bin', () => {
  const list = wellKnownClaudeInstallCandidates({ HOME: '/home/user' } as NodeJS.ProcessEnv, 'claude');
  assert.deepEqual(list, [
    '/home/user/.local/bin/claude',
    '/home/user/.claude/local/claude',
    '/home/user/.claude/local/bin/claude',
    '/home/user/.npm-global/bin/claude',
    '/usr/local/bin/claude',
  ]);
  assert.deepEqual(
    wellKnownClaudeInstallCandidates({} as NodeJS.ProcessEnv, 'claude'),
    ['/usr/local/bin/claude'],
    'no HOME ⇒ only the system-wide candidate',
  );
});

test('B-1058: the error names the command, HOME, and the CLAUDE_CLI_PATH remedy', () => {
  withTempHome((home) => {
    const env = { HOME: home, PATH: SYSTEM_PATH } as NodeJS.ProcessEnv;
    assert.throws(
      () => resolveRealClaudeBinary(env, 'claude', { existsSync: () => false }),
      (error: unknown) => {
        const message = (error as Error).message;
        return message.startsWith('Claude executable not found before installing the managed terminal launcher')
          && message.includes(`HOME=${home}`)
          && message.includes('CLAUDE_CLI_PATH');
      },
    );
  });
});

test('B-1058: installManagedClaudeTerminalEnv records the fallback binary as the real bin', () => {
  withTempHome((home) => {
    const real = makeExecutable(path.join(home, '.local', 'bin', 'claude'));
    const base = { HOME: home, PATH: SYSTEM_PATH } as NodeJS.ProcessEnv;
    // Use a working dir whose PATH really lacks claude: mask CLAUDE_CLI_PATH.
    const saved = process.env.CLAUDE_CLI_PATH;
    delete process.env.CLAUDE_CLI_PATH;
    try {
      const env = installManagedClaudeTerminalEnv(base, { userId: 7, mode: 'general' });
      // The launcher only wins when the system PATH genuinely has no claude;
      // on a dev box that has one, the PATH hit is the correct answer instead.
      const expectedFromPath = SYSTEM_PATH.split(path.delimiter)
        .map((dir) => path.join(dir, 'claude'))
        .find((file) => fs.existsSync(file));
      assert.equal(env.NASSAJ_MANAGED_CLAUDE_REAL_BIN, expectedFromPath ?? path.resolve(real));
      assert.equal(env.NASSAJ_MANAGED_CLAUDE_MODE, 'general');
    } finally {
      if (saved !== undefined) process.env.CLAUDE_CLI_PATH = saved;
    }
  });
});
