/**
 * B-1058 / T-1873: the managed terminal launcher runs the ONE claude the harness
 * registry resolves — the native installer's `~/.local/bin/claude` under the
 * OPERATOR home (or the server `CLAUDE_CLI_PATH` override). A pm2/systemd
 * server's minimal PATH, the PTY's isolated HOME and a member env's
 * CLAUDE_CLI_PATH never change which binary runs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  installManagedClaudeTerminalEnv,
  MANAGED_CLAUDE_WRAPPER,
  resolveRealClaudeBinary,
} from './managed-claude-terminal-env.js';

const SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/games'].join(path.delimiter);

function makeExecutable(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return file;
}

/** Runs `fn` with a temp OPERATOR home ($HOME) and no server CLAUDE_CLI_PATH. */
function withOperatorHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'b1058-home-'));
  const saved = { HOME: process.env.HOME, CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH };
  process.env.HOME = home;
  delete process.env.CLAUDE_CLI_PATH;
  try {
    return fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('resolves the native installer path under the operator home', () => {
  withOperatorHome((home) => {
    const real = makeExecutable(path.join(home, '.local', 'bin', 'claude'));
    assert.equal(resolveRealClaudeBinary(), path.resolve(real));
  });
});

test('a claude found first on some PATH never wins over the registry', () => {
  withOperatorHome((home) => {
    const real = makeExecutable(path.join(home, '.local', 'bin', 'claude'));
    makeExecutable(path.join(home, 'custom-bin', 'claude'));
    const base = {
      HOME: path.join(home, 'member'),
      PATH: [path.join(home, 'custom-bin'), SYSTEM_PATH].join(path.delimiter),
      CLAUDE_CLI_PATH: path.join(home, 'custom-bin', 'claude'),
    } as NodeJS.ProcessEnv;
    const env = installManagedClaudeTerminalEnv(base, { userId: 7, mode: 'general' });
    assert.equal(env.NASSAJ_MANAGED_CLAUDE_REAL_BIN, path.resolve(real));
    assert.equal(env.NASSAJ_MANAGED_CLAUDE_MODE, 'general');
  });
});

test('the server CLAUDE_CLI_PATH override is honoured', () => {
  withOperatorHome((home) => {
    const custom = makeExecutable(path.join(home, 'opt', 'claude'));
    process.env.CLAUDE_CLI_PATH = custom;
    assert.equal(resolveRealClaudeBinary(), custom);
  });
});

test('the error keeps the publishable prefix and names the CLAUDE_CLI_PATH remedy', () => {
  withOperatorHome(() => {
    assert.throws(
      () => resolveRealClaudeBinary(),
      (error: unknown) => {
        const message = (error as Error).message;
        return message.startsWith('Claude executable not found before installing the managed terminal launcher')
          && message.includes('~/.local/bin/claude')
          && message.includes('CLAUDE_CLI_PATH');
      },
    );
  });
});

test('the launcher never resolves to its own shim', () => {
  withOperatorHome(() => {
    process.env.CLAUDE_CLI_PATH = MANAGED_CLAUDE_WRAPPER;
    assert.throws(() => resolveRealClaudeBinary(), /managed terminal launcher itself/);
  });
});
