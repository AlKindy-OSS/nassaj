import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const run = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'board.mjs');
const REPO = path.dirname(path.dirname(SCRIPT));

async function refused(root, ...args) {
  try {
    await run(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, NASSAJ_BOARD_PATH: path.join(root, 'attacker-selected.json') },
    });
    assert.fail('product board command unexpectedly succeeded');
  } catch (error) {
    assert.equal(error.code, 2);
    return String(error.stderr);
  }
}

describe('ADR-174 product board boundary', () => {
  it('keeps live plan, status, and board records out of the product Git tree', async () => {
    const { stdout } = await run('git', [
      '-C', REPO, 'ls-files', '--', 'PROJECT_PLAN.md', 'PROJECT_STATUS.md', 'docs/project-state.json',
    ]);
    assert.equal(stdout, '');
  });

  it('refuses every mutation and points to the typed core CLI', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-guard-'));
    const sentinel = path.join(root, 'sentinel.json');
    fs.writeFileSync(sentinel, '{"unchanged":true}\n');
    for (const args of [
      ['add', 'task', '--title', 'x'],
      ['update', 'T-1', '--status', 'done'],
    ]) {
      const stderr = await refused(root, ...args);
      assert.match(stderr, /disabled in nassaj-dev/);
      assert.match(stderr, /nassaj-core.*scripts\/board\.mjs --product nassaj-dev/);
    }
    assert.equal(fs.readFileSync(sentinel, 'utf8'), '{"unchanged":true}\n');
    assert.equal(fs.existsSync(path.join(root, 'attacker-selected.json')), false);
  });

  it('does not accept a free board path for reads', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-guard-'));
    const selected = path.join(root, 'attacker-selected.json');
    fs.writeFileSync(selected, '{"tasks":[{"id":"T-SECRET"}]}\n');
    const stderr = await refused(root, 'get', 'T-SECRET');
    assert.match(stderr, /reads are unavailable/);
    assert.doesNotMatch(stderr, /T-SECRET/);
  });
});
