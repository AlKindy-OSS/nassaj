#!/usr/bin/env node
/**
 * board.mjs — the ONE writer for `docs/project-state.json`.
 *
 * WHY THIS EXISTS (T-1150). The board is a single JSON file and several Claude
 * sessions work this repo at once. Every session was doing its own
 * read-modify-write with an ad-hoc `node -e`, which loses writes two ways:
 *
 *   1. LOST UPDATE — session A reads, session B reads, A writes, B writes. B's
 *      snapshot is older, so A's items vanish. Measured three times on
 *      2026-07-31: T-1133, T-1135, B-351, then T-1142, T-1143, B-358, B-359.
 *   2. ID COLLISION — both sessions compute `max(id) + 1` from their own
 *      snapshot and get the same number. The loser's id is then reused for an
 *      unrelated item, so commit messages and code comments that cite it end up
 *      pointing at someone else's task. That happened in commit 275d48dc.
 *
 * Reserving an id before writing does NOT fix this: the clobber happens after
 * the reservation. The only fix is to make read → mutate → write ATOMIC, which
 * means two rules this tool enforces and a hand-written `node -e` cannot:
 *
 *   • A caller never supplies a whole board. It supplies a MUTATION, which is
 *     applied to a snapshot read fresh inside the lock. A stale caller can no
 *     longer erase anything it did not name.
 *   • Ids are allocated inside that same lock, so two sessions cannot mint one
 *     number twice.
 *
 * THREE TRAPS THIS FILE HANDLES, each of which has bitten this repo:
 *
 *   • `docs/project-state.json` is a SYMLINK into nassaj-core. Writing a temp
 *     file and renaming it onto the link path would replace the link with a
 *     regular file and silently split the two repos apart. We resolve realpath
 *     first and rename inside the real file's own directory.
 *   • The board is written with `indent=1`. Re-serializing at 2 reformats ~8700
 *     lines and turns every concurrent edit into a conflict.
 *   • The UI reads this file live. A partial write is a parse error on screen,
 *     so the swap is a rename (atomic) and never an in-place truncate.
 *
 * USAGE
 *   node scripts/board.mjs add task  --title "…" [--note "…"] [--priority high]
 *   node scripts/board.mjs add issue --title "…" [--triage "…"] [--severity high]
 *   node scripts/board.mjs add adr   --title "…" [--note "…"] [--status proposed]
 *   node scripts/board.mjs update T-1139 --status done [--append-note "…"]
 *   node scripts/board.mjs get T-1139
 *   node scripts/board.mjs verify T-1139 T-1140      # exit 1 if any is missing
 *
 * `add` prints the allocated id on stdout and nothing else, so it can be
 * captured: `ID=$(node scripts/board.mjs add task --title …)`.
 */
import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = process.env.NASSAJ_BOARD_PATH ?? path.join(HERE, '..', 'docs', 'project-state.json');

/** The board's on-disk formatting. Changing this rewrites the whole file. */
const INDENT = 1;

/** How long before a lock is presumed abandoned (a killed session leaves one). */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 120;
const LOCK_TIMEOUT_MS = 15_000;

/**
 * Where each kind of item lives, how its ids are prefixed, and how wide the
 * number is. `pad` matters: every decision on this board is written ADR-089, so
 * minting ADR-90 puts the newest decision BEFORE ADR-089 in any lexical sort and
 * breaks every grep for `ADR-0\d\d`. Tasks and issues have never been padded.
 */
const KINDS = {
  task: { list: 'tasks', prefix: 'T', pad: 0 },
  issue: { list: 'issues', prefix: 'B', pad: 0 },
  adr: { list: 'decisions', prefix: 'ADR', pad: 3 },
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** True when a pid is still running (signal 0 probes without delivering). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Exclusive lock via `O_EXCL` create — no dependency, and the failure mode is
 * safe: if we cannot take it we wait, and if we time out we throw rather than
 * write. A lock whose owning pid is gone and whose file is older than
 * LOCK_STALE_MS is stolen, so one killed session cannot freeze the board.
 */
function withLock(realBoard, fn) {
  const lockPath = path.join(path.dirname(realBoard), '.project-state.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;

  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      let holder = null;
      try {
        holder = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        holder = null;
      }
      const age = Date.now() - (holder?.at ? Date.parse(holder.at) : 0);
      if (holder?.pid && !pidAlive(holder.pid) && age > LOCK_STALE_MS) {
        try {
          unlinkSync(lockPath);
        } catch { /* another waiter won the steal — loop and retry */ }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `board is locked by pid ${holder?.pid ?? '?'} since ${holder?.at ?? '?'} — `
          + 'another session is writing. Retry, or remove the lock if that pid is gone: '
          + lockPath,
        );
      }
      sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
    try {
      unlinkSync(lockPath);
    } catch { /* already gone */ }
  }
}

/** Reads the board. Called INSIDE the lock so the snapshot cannot be stale. */
function readBoard(realBoard) {
  return JSON.parse(readFileSync(realBoard, 'utf8'));
}

/**
 * Atomic swap: temp file in the REAL file's directory (same filesystem, and it
 * keeps the nassaj-dev symlink pointing at nassaj-core), then rename.
 */
function writeBoard(realBoard, board) {
  board.updated = new Date().toISOString().slice(0, 10);
  const tmp = path.join(path.dirname(realBoard), `.project-state.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(board, null, INDENT)}\n`, 'utf8');
  renameSync(tmp, realBoard);
}

/** Every id in use, across every list — ids must be unique board-wide. */
function usedIds(board) {
  const ids = new Set();
  for (const { list } of Object.values(KINDS)) {
    for (const item of board[list] ?? []) {
      if (item?.id) {
        ids.add(item.id);
      }
    }
  }
  return ids;
}

/**
 * Next free id for a prefix. Scans the WHOLE board, not just the target list:
 * a `B-` id could otherwise be minted while an issue with that number exists in
 * a list we did not look at.
 */
function nextId(board, prefix, pad = 0) {
  const ids = usedIds(board);
  const format = (n) => `${prefix}-${String(n).padStart(pad, '0')}`;
  let max = 0;
  for (const id of ids) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  let candidate = max + 1;
  // Probe BOTH spellings: a padded id and its bare form are the same number, so
  // an unpadded straggler must still block the padded candidate.
  while (ids.has(format(candidate)) || ids.has(`${prefix}-${candidate}`)) {
    candidate += 1;
  }
  return format(candidate);
}

function findItem(board, id) {
  for (const { list } of Object.values(KINDS)) {
    const found = (board[list] ?? []).find((item) => item?.id === id);
    if (found) {
      return { item: found, list };
    }
  }
  return null;
}

/** `--flag value` pairs plus repeatable `--set key=value`. */
function parseFlags(argv) {
  const flags = {};
  const sets = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${key} needs a value`);
    }
    i += 1;
    if (key === 'set') {
      const eq = value.indexOf('=');
      if (eq < 0) {
        throw new Error(`--set expects key=value, got "${value}"`);
      }
      sets[value.slice(0, eq)] = value.slice(eq + 1);
    } else {
      flags[key] = value;
    }
  }
  return { flags, sets };
}

const today = () => new Date().toISOString().slice(0, 10);

function cmdAdd(kindName, argv) {
  const kind = KINDS[kindName];
  if (!kind) {
    throw new Error(`unknown kind "${kindName}" — expected task | issue | adr`);
  }
  const { flags, sets } = parseFlags(argv);
  if (!flags.title) {
    throw new Error('--title is required');
  }

  const realBoard = realpathSync(BOARD);
  return withLock(realBoard, () => {
    const board = readBoard(realBoard);
    const id = flags.id ?? nextId(board, kind.prefix, kind.pad ?? 0);
    if (usedIds(board).has(id)) {
      throw new Error(`${id} already exists — refusing to overwrite it`);
    }

    const phase = board.tasks?.[0]?.phase;
    const base = kindName === 'adr'
      ? { id, date: today(), status: flags.status ?? 'proposed', title: flags.title }
      : {
        id,
        kind: kindName === 'issue' ? 'bug' : 'task',
        phase,
        status: flags.status ?? (kindName === 'issue' ? 'open' : 'pending'),
        found: today(),
        title: flags.title,
      };

    for (const field of ['priority', 'owner', 'severity', 'source', 'note', 'triage']) {
      if (flags[field] !== undefined) {
        base[field] = flags[field];
      }
    }
    Object.assign(base, sets);

    board[kind.list] = board[kind.list] ?? [];
    board[kind.list].push(base);
    writeBoard(realBoard, board);
    return id;
  });
}

function cmdUpdate(id, argv) {
  const { flags, sets } = parseFlags(argv);
  const realBoard = realpathSync(BOARD);
  return withLock(realBoard, () => {
    const board = readBoard(realBoard);
    const found = findItem(board, id);
    if (!found) {
      throw new Error(`${id} not found — it may have been clobbered by another session`);
    }
    const { item } = found;

    for (const [key, value] of Object.entries(flags)) {
      if (key === 'append-note') {
        item.note = item.note ? `${item.note} ${value}` : value;
      } else if (key === 'append-triage') {
        item.triage = item.triage ? `${item.triage} ${value}` : value;
      } else {
        item[key] = value;
      }
    }
    Object.assign(item, sets);
    writeBoard(realBoard, board);
    return id;
  });
}

function cmdGet(id) {
  const board = readBoard(realpathSync(BOARD));
  const found = findItem(board, id);
  if (!found) {
    throw new Error(`${id} not found`);
  }
  return JSON.stringify(found.item, null, 2);
}

/**
 * Confirms ids are still present — the cheap check that catches a clobber by a
 * concurrent session right after a write, while it is still trivial to redo.
 */
function cmdVerify(ids) {
  const board = readBoard(realpathSync(BOARD));
  const missing = ids.filter((id) => !findItem(board, id));
  if (missing.length) {
    throw new Error(`missing from the board: ${missing.join(', ')}`);
  }
  return `ok — ${ids.length} present`;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'add':
      return cmdAdd(rest[0], rest.slice(1));
    case 'update':
      return cmdUpdate(rest[0], rest.slice(1));
    case 'get':
      return cmdGet(rest[0]);
    case 'verify':
      return cmdVerify(rest);
    default:
      throw new Error('usage: board.mjs <add|update|get|verify> …  (see the header of this file)');
  }
}

try {
  const out = main();
  if (out) {
    process.stdout.write(`${out}\n`);
  }
} catch (error) {
  process.stderr.write(`board: ${error.message}\n`);
  process.exit(1);
}
