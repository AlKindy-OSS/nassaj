/**
 * board.test.mjs — the board writer survives concurrent sessions.
 *
 * These tests run REAL concurrent processes against a REAL board file, because
 * the bug being fixed only exists between processes: a single-process simulation
 * of "two writers" would serialize itself and pass no matter what the code did.
 * Measured incidents this pins (2026-07-31): seven board items lost across three
 * separate clobbers, and one id reused for an unrelated task after being cited
 * in commit 275d48dc.
 *
 * RUNNER: node --test scripts/board.test.mjs
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';

const run = promisify(execFile);
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'board.mjs');

let root;
let realBoard;
let linkBoard;

/** A board shaped like the real one: `$version`, indent=1, the three lists. */
function seedBoard() {
  const board = {
    $version: 1,
    project: 'test',
    updated: '2026-01-01',
    tasks: [{ id: 'T-1', kind: 'task', phase: 'P-1', status: 'done', title: 'seed' }],
    issues: [{ id: 'B-1', kind: 'bug', phase: 'P-1', status: 'fixed', title: 'seed' }],
    decisions: [{ id: 'ADR-1', date: '2026-01-01', status: 'accepted', title: 'seed' }],
  };
  writeFileSync(realBoard, `${JSON.stringify(board, null, 1)}\n`, 'utf8');
}

/** Invokes the CLI against the linked path, the way a session would. */
function board(...args) {
  return run(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, NASSAJ_BOARD_PATH: linkBoard },
  });
}

const read = () => JSON.parse(readFileSync(realBoard, 'utf8'));

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
  // Mirror production: the board lives in one repo and is reached through a
  // symlink from another.
  const coreDir = path.join(root, 'core');
  const devDir = path.join(root, 'dev');
  mkdirSync(coreDir);
  mkdirSync(devDir);
  realBoard = path.join(coreDir, 'project-state.json');
  linkBoard = path.join(devDir, 'project-state.json');
  seedBoard();
  symlinkSync(realBoard, linkBoard);
});

after(() => {
  process.env.NASSAJ_BOARD_PATH = '';
});

describe('board writer — concurrent sessions (T-1150)', () => {
  it('twenty concurrent adds all land, and every id is unique', async () => {
    seedBoard();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => board('add', 'task', '--title', `concurrent ${i}`)),
    );
    const ids = results.map((r) => r.stdout.trim());

    assert.equal(new Set(ids).size, 20, `ids collided: ${ids.join(', ')}`);

    const after_ = read();
    assert.equal(after_.tasks.length, 21, 'a write was lost — this is the clobber the tool exists to stop');
    for (const id of ids) {
      assert.ok(after_.tasks.some((t) => t.id === id), `${id} vanished from the board`);
    }
  });

  it('mixed kinds stay in their own lists and never share a number', async () => {
    seedBoard();

    const results = await Promise.all([
      board('add', 'task', '--title', 'a'),
      board('add', 'issue', '--title', 'b'),
      board('add', 'adr', '--title', 'c'),
      board('add', 'task', '--title', 'd'),
      board('add', 'issue', '--title', 'e'),
    ]);
    const ids = results.map((r) => r.stdout.trim());

    assert.equal(new Set(ids).size, 5);
    const now = read();
    assert.equal(now.tasks.length, 3);
    assert.equal(now.issues.length, 3);
    assert.equal(now.decisions.length, 2);
  });

  it('an update never resurrects a stale snapshot of the rest of the board', async () => {
    seedBoard();

    // One session updates an old item while others append. If `update` wrote a
    // whole snapshot instead of a mutation, the appends would disappear.
    const [, ...added] = await Promise.all([
      board('update', 'T-1', '--status', 'in_progress'),
      board('add', 'task', '--title', 'x'),
      board('add', 'task', '--title', 'y'),
      board('add', 'task', '--title', 'z'),
    ]);

    const now = read();
    assert.equal(now.tasks.find((t) => t.id === 'T-1').status, 'in_progress');
    assert.equal(now.tasks.length, 4, 'concurrent appends were erased by the update');
    for (const r of added) {
      assert.ok(now.tasks.some((t) => t.id === r.stdout.trim()));
    }
  });

  it('writes through the symlink without replacing it', async () => {
    seedBoard();

    await board('add', 'task', '--title', 'via link');

    assert.ok(lstatSync(linkBoard).isSymbolicLink(), 'the symlink was replaced by a regular file');
    assert.ok(read().tasks.some((t) => t.title === 'via link'), 'the write missed the real file');
  });

  it('keeps indent=1 so a write is not a whole-file reformat', async () => {
    seedBoard();

    await board('add', 'task', '--title', 'indent');

    const lines = readFileSync(realBoard, 'utf8').split('\n');
    const nested = lines.find((line) => /^ "tasks":/.test(line));
    assert.ok(nested, 'top-level keys are no longer indented by exactly one space');
  });

  it('refuses to overwrite an id that already exists', async () => {
    seedBoard();

    await assert.rejects(
      () => board('add', 'task', '--title', 'dupe', '--id', 'T-1'),
      /already exists/,
    );
    assert.equal(read().tasks.length, 1, 'a refused add must not mutate the board');
  });

  it('update on a missing id fails loudly instead of inventing one', async () => {
    seedBoard();

    await assert.rejects(() => board('update', 'T-999', '--status', 'done'), /not found/);
  });

  it('verify reports a clobbered id', async () => {
    seedBoard();

    await board('verify', 'T-1', 'B-1');
    await assert.rejects(() => board('verify', 'T-1', 'T-404'), /missing from the board/);
  });

  it('append-note adds to a note instead of replacing it', async () => {
    seedBoard();

    await board('update', 'T-1', '--append-note', 'first');
    await board('update', 'T-1', '--append-note', 'second');

    const note = read().tasks.find((t) => t.id === 'T-1').note;
    assert.match(note, /first/);
    assert.match(note, /second/, 'the second append replaced the first');
  });

  it('leaves no lock file behind on success or on failure', async () => {
    seedBoard();
    const lockPath = path.join(path.dirname(realBoard), '.project-state.lock');

    await board('add', 'task', '--title', 'ok');
    assert.equal(existsSync(lockPath), false, 'lock leaked after a successful write');

    await assert.rejects(() => board('update', 'T-404', '--status', 'x'));
    assert.equal(existsSync(lockPath), false, 'lock leaked after a failed write');
  });
});
