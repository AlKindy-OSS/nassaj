/**
 * B-1611 — the B-1609 descriptor-name rule at every site that opens a file by
 * its own means: the kernel's name for the descriptor (`/proc/self/fd/<n>` link
 * text) is compared verbatim, never re-resolved by name with `realpath`.
 *
 * Fixture (as in B-1609): the opened name is a second link to a foreign file;
 * right after the open a genuine file is renamed over it and a symlink
 * `<name> (deleted)` → `<name>` is planted. The descriptor still holds the
 * foreign inode; `realpath` of its /proc text follows the planted link back to
 * the genuine name, so a realpath comparison admits the foreign bytes.
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// eslint-disable-next-line boundaries/dependencies -- exercises the scanner's descriptor gate directly.
import { getCodebaseStats } from '@/modules/projects/services/codebase-stats.service.js';
import { forkClaudeTranscript, TranscriptForkError } from '@/modules/providers/list/claude/claude-transcript-fork.js';
import { openActorSource } from '@/modules/providers/list/codex/codex-actor-source.js';
import { descriptorNamed, PinnedOpenError } from '@/modules/providers/shared/pinned-fd.js';
import { readBoundedFile } from '@/shared/utils.js';

// eslint-disable-next-line boundaries/no-unknown -- the command route's fd-bound reader.
import { readContainedCommandFile } from '../../../routes/commands.js';

const SERVER_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const FOREIGN_TEXT = 'zqforeign one\nzqforeign two\nzqforeign three\n';
const GENUINE_TEXT = 'genuine\n';

function sandbox(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** `target` as a second link to a foreign file outside the root; returns the root. */
function linkedTarget(name: string): { root: string; target: string } {
  const outside = sandbox('b1611-outside-');
  const root = sandbox('b1611-root-');
  const foreign = path.join(outside, 'secret.txt');
  fs.writeFileSync(foreign, FOREIGN_TEXT);
  const target = path.join(root, name);
  fs.linkSync(foreign, target);
  return { root, target };
}

/** Renames a genuine file over `target` and plants `<target> (deleted)` → `target`. */
function replaceAndPlant(target: string): void {
  fs.writeFileSync(`${target}.genuine`, GENUINE_TEXT);
  fs.renameSync(`${target}.genuine`, target);
  fs.symlinkSync(target, `${target} (deleted)`);
}

/**
 * Runs `run` while the first `FileHandle.stat()` on a descriptor opened as
 * `target` first applies {@link replaceAndPlant} (after open, before the checks).
 */
async function withPlantOnFirstStat<T>(target: string, run: () => Promise<T>): Promise<T> {
  const probe = await fsp.open(target, 'r');
  const prototype = Object.getPrototypeOf(probe) as { stat: (...args: unknown[]) => Promise<unknown> };
  await probe.close();
  const original = prototype.stat;
  let planted = false;
  prototype.stat = async function patchedStat(this: fsp.FileHandle, ...args: unknown[]) {
    if (!planted && fs.readlinkSync(`/proc/self/fd/${this.fd}`) === target) {
      planted = true;
      replaceAndPlant(target);
    }
    return original.apply(this, args);
  };
  try {
    return await run();
  } finally {
    prototype.stat = original;
  }
}

/**
 * Models the B-1609 kernel window for descriptors opened as `target`: the first
 * read of their `/proc/self/fd/<n>` link returns the live name (a rename over
 * `target` has dropped the inode to one link but not yet moved the dentry);
 * every later read returns `<target> (deleted)` (the rename has completed).
 */
async function withRenameWindow<T>(target: string, run: () => Promise<T>): Promise<T> {
  const readlink = fsp.readlink;
  const seen = new Set<string>();
  (fsp as { readlink: typeof fsp.readlink }).readlink = (async (...args: Parameters<typeof fsp.readlink>) => {
    const text = await readlink(...args);
    const link = String(args[0]);
    if (!link.startsWith('/proc/self/fd/') || text !== target) return text;
    if (seen.has(link)) return `${target} (deleted)`;
    seen.add(link);
    return text;
  }) as typeof fsp.readlink;
  try {
    return await run();
  } finally {
    (fsp as { readlink: typeof fsp.readlink }).readlink = readlink;
  }
}

test('descriptorNamed: the exact kernel name is admitted', async () => {
  const root = sandbox('b1611-named-');
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, GENUINE_TEXT);
  const handle = await fsp.open(file, 'r');
  try {
    assert.equal(await descriptorNamed(handle.fd, file), true);
    assert.equal(await descriptorNamed(handle.fd, file, { singleLink: true }), true);
    assert.equal(await descriptorNamed(handle.fd, path.join(root, 'b.txt')), false);
  } finally {
    await handle.close();
  }
});

test('descriptorNamed: a planted "<name> (deleted)" symlink cannot vouch for an unlinked descriptor', async () => {
  const { target } = linkedTarget('a.txt');
  const handle = await fsp.open(target, 'r');
  try {
    replaceAndPlant(target);
    assert.equal(await fsp.realpath(`/proc/self/fd/${handle.fd}`), target, 'realpath is fooled');
    assert.equal(await descriptorNamed(handle.fd, target), false);
  } finally {
    await handle.close();
  }
});

test('descriptorNamed: a single-link name read inside a rename window is re-checked after the directory settles', async () => {
  // The procFdDir seam models the kernel view (see the B-1609 test): the live
  // name on the first read, `(deleted)` once the in-flight rename completes.
  const root = sandbox('b1611-window-');
  const proc = sandbox('b1611-proc-');
  const target = path.join(root, 'a.txt');
  fs.writeFileSync(target, GENUINE_TEXT);
  const link = path.join(proc, '7');
  fs.symlinkSync(target, link);
  const readlink = fsp.readlink;
  let reads = 0;
  (fsp as { readlink: typeof fsp.readlink }).readlink = (async (...args: Parameters<typeof fsp.readlink>) => {
    const text = await readlink(...args);
    if (args[0] === link && ++reads === 1) { fs.rmSync(link); fs.symlinkSync(`${target} (deleted)`, link); }
    return text;
  }) as typeof fsp.readlink;
  try {
    assert.equal(await descriptorNamed(7, target, { singleLink: true, procFdDir: proc }), false);
    assert.equal(reads, 2, 'the name is read again after the settle');
  } finally {
    (fsp as { readlink: typeof fsp.readlink }).readlink = readlink;
  }
});

test('descriptorNamed: a host without the /proc fd directory fails closed', async () => {
  await assert.rejects(descriptorNamed(0, '/x', { procFdDir: path.join(os.tmpdir(), 'b1611-no-proc-dir') }),
    (error: unknown) => error instanceof PinnedOpenError && error.reason === 'proc_unavailable');
});

test('readBoundedFile: a planted "(deleted)" name does not admit a replaced descriptor', async () => {
  const { root, target } = linkedTarget('SKILL.md');
  const read = withPlantOnFirstStat(target, () =>
    readBoundedFile(target, { rootDir: root, budget: { maxBytes: 1 << 20, bytesRead: 0 } }));
  const outcome = await read.then((bytes) => bytes.toString('utf8'), (error: NodeJS.ErrnoException) => error.code);
  assert.doesNotMatch(String(outcome), /zqforeign/, 'foreign bytes admitted through a planted "(deleted)" name');
  assert.equal(outcome, 'BOUNDED_READ_IDENTITY');
});

test('codebase stats: a descriptor whose name was replaced after open is not counted', async () => {
  const { root, target } = linkedTarget('a.ts');
  const stats = await getCodebaseStats(root, {
    force: true,
    hooks: { afterOpenFile: (relative) => { if (relative === 'a.ts') replaceAndPlant(target); } },
  });
  assert.notEqual(stats.totalLines, 3, 'the foreign file\'s lines were counted');
  assert.equal(stats.fileCount, 0);
});

test('codex actor source: a single-link source named inside a rename window is refused', async () => {
  const root = sandbox('b1611-codex-');
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, '{"type":"session_meta"}\n');
  await assert.rejects(withRenameWindow(file, () => openActorSource(root, file)), /actor_source_unavailable/);
});

test('claude fork: a single-link source named inside a rename window is refused', async () => {
  const root = sandbox('b1611-fork-');
  const id = '00000000-0000-4000-a611-000000000001';
  const file = path.join(root, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: id,
    cwd: '/workspace/b1611', message: { role: 'user', content: 'hi' } })}\n`);
  const forked = withRenameWindow(file, () => forkClaudeTranscript({ sourceFilePath: file, sourceSessionId: id }));
  await assert.rejects(forked, (error: unknown) => error instanceof TranscriptForkError
    && error.code === 'source_unreadable' && /identity is not trusted/.test(error.message));
});

test('command file: a single-link file named inside a rename window is refused', async () => {
  const root = sandbox('b1611-commands-');
  const file = path.join(root, 'cmd.md');
  fs.writeFileSync(file, 'command');
  await assert.rejects(withRenameWindow(file, () => readContainedCommandFile(file, [root])),
    (error: unknown) => (error as { code?: string }).code === 'COMMAND_ACCESS_DENIED');
});

/** `realpath(` applied to a `/proc/self/fd/` spelling, inline or through a const holding one. */
function resolvesProcFd(source: string): number[] {
  const held = [...source.matchAll(/\bconst\s+(\w+)\s*=\s*`\/proc\/self\/fd\//g)].map((match) => match[1]);
  const sink = new RegExp(`realpath(?:Sync)?\\(\\s*(?:[\`'"]/proc/self/fd/${held.map((name) => `|${name}\\b`).join('')})`);
  return source.split('\n').flatMap((line, index) => (sink.test(line) ? [index + 1] : []));
}

/** Server sources (no tests) that resolve a `/proc/self/fd` link by name. */
function realpathOnProcFd(): string[] {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!/\.(?:ts|js|mjs)$/.test(entry.name) || /\.test\.|__tests__|\/tests\//.test(full)) continue;
      for (const line of resolvesProcFd(fs.readFileSync(full, 'utf8'))) hits.push(`${path.relative(SERVER_ROOT, full)}:${line}`);
    }
  };
  walk(SERVER_ROOT);
  return hits;
}

test('guard self-test: inline and const-held /proc/self/fd spellings are both caught', () => {
  assert.deepEqual(resolvesProcFd('await realpath(`/proc/self/fd/${fd}`);'), [1]);
  assert.deepEqual(resolvesProcFd('const p = `/proc/self/fd/${fd}`;\nawait realpath(p);'), [2]);
  assert.deepEqual(resolvesProcFd('await readlink(`/proc/self/fd/${fd}`);'), []);
});

/**
 * Not a descriptor-name gate: the retained-entry check of the migration CLI
 * (argv[1] is `/proc/self/fd/5`) only decides whether this module is the entry
 * point; it admits no bytes, and the host runner owns fd 5.
 */
const ALLOWED = ['scripts/release-database-migration.ts'];

test('guard: no server source resolves a /proc/self/fd link with realpath (B-1611)', () => {
  const hits = realpathOnProcFd().filter((hit) => !ALLOWED.some((file) => hit.startsWith(`${file}:`)));
  assert.deepEqual(hits, []);
});
