/**
 * ADR-227 / T-2098 stage 3a — the out-of-process workflow task-runner has no
 * database and no engine verdict, so it would run `claude -p` on official
 * Anthropic. Handed a local model id it refuses before any child is spawned and
 * seals the task as refused (defence in depth behind the launch route and GATE2).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../task-runner.ts', import.meta.url));

test('a nassaj_local_* model is refused before claude is spawned', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'task-runner-local-'));
  const marker = path.join(root, 'spawned');
  const fakeClaude = path.join(root, 'claude');
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch ${marker}\necho '{}'\n`, { mode: 0o755 });
  try {
    const taskDir = path.join(root, 'task');
    const result = spawnSync(process.execPath, ['--import', 'tsx', runner,
      '--task-dir', taskDir, '--claude-bin', fakeClaude, '--prompt', 'p',
      '--model', 'nassaj_local_0b9c6a3e/gpt-oss-20b'], {
      cwd: process.cwd(), // resolves the tsx loader from the checkout
      env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
        TSX_TSCONFIG_PATH: process.env.TSX_TSCONFIG_PATH },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false, 'claude never ran');
    assert.match(fs.readFileSync(path.join(taskDir, 'stderr.log'), 'utf8'), /LOCAL_ENGINE_SPAWN_UNSUPPORTED/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
