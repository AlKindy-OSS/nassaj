/**
 * T-1880 (H3): replays the Claude-home separation against a REAL chokidar
 * 4.0.3 watcher and a real session DB. The filesystem steps are the engine's
 * own syscalls, issued from one python3 process per step like
 * `lib/claude_home.py`: renameat2(RENAME_EXCHANGE) for the P0 pointer swap and
 * the slug exchange, a held self-loop link instant, then the compat-link
 * replace (symlink + rename). chokidar reports every relocated transcript as
 * `unlink`; no session row may be deleted. A genuine deletion still is — but
 * only after the >= 3 s re-check.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import chokidar from 'chokidar';

import { initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import { UNLINK_RECHECK_DELAY_MS, closeSessionsWatcher, initializeSessionsWatcher } from './sessions-watcher.service.js';

const ENGINE = String.raw`
import ctypes, os, sys, time
libc = ctypes.CDLL(None, use_errno=True)
fn = libc.renameat2
fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
fn.restype = ctypes.c_int
def exchange(a, b):
    if fn(-100, a.encode(), -100, b.encode(), 2) != 0:
        err = ctypes.get_errno(); raise OSError(err, os.strerror(err))
op = sys.argv[1]
if op == 'exchange':
    exchange(sys.argv[2], sys.argv[3])
elif op == 'relocate':
    ch_entry, core_entry, hold, compat = sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5] == '1'
    exchange(ch_entry, core_entry)
    if not (os.path.islink(core_entry) and os.readlink(core_entry) == core_entry):
        exchange(ch_entry, core_entry); sys.exit('expected self-loop after exchange')
    time.sleep(hold)
    if compat:
        tmp = os.path.join(os.path.dirname(core_entry), '.' + os.path.basename(core_entry) + '.cl.tmp')
        os.symlink(ch_entry, tmp); os.rename(tmp, core_entry)
    else:
        os.unlink(core_entry)
`;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

type Fixture = { base: string; core: string; ch: string; engine: string };

function fixture(t: test.TestContext): Fixture {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'watcher-relocation-')));
  const core = path.join(base, 'nassaj-core');
  const ch = path.join(base, '.claude');
  const engine = path.join(base, 'engine.py');
  writeFileSync(engine, ENGINE);
  const saved = { HOME: process.env.HOME, NASSAJ_GOVERNANCE_DIR: process.env.NASSAJ_GOVERNANCE_DIR };
  process.env.HOME = base;
  process.env.NASSAJ_GOVERNANCE_DIR = core;
  t.after(async () => {
    await closeSessionsWatcher();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  });
  symlinkSync(core, ch); // legacy layout: ~/.claude -> governance checkout
  return { base, core, ch, engine };
}

/** Writes transcripts under `$CORE/projects/<slug>` and indexes them with the core spelling. */
function seedSlug(core: string, slug: string, ids: string[]): string[] {
  mkdirSync(path.join(core, 'projects', slug, `${ids[0]}`, 'subagents'), { recursive: true });
  writeFileSync(path.join(core, 'projects', slug, ids[0], 'subagents', 'agent-a.jsonl'), '{}\n');
  return ids.map((id) => {
    const file = path.join(core, 'projects', slug, `${id}.jsonl`);
    writeFileSync(file, '{}\n');
    sessionsDb.createSession(id, 'claude', '/workspace/t1880', undefined, undefined, undefined, file);
    return file;
  });
}

async function startWatcher(ch: string, unlinks: string[]): Promise<void> {
  await initializeSessionsWatcher({
    targets: [{ provider: 'claude', rootPath: path.join(ch, 'projects') }],
    watch: ((root: string, options: Parameters<typeof chokidar.watch>[1]) => {
      const watcher = chokidar.watch(root, options);
      watcher.on('unlink', (file: string) => unlinks.push(file));
      return watcher;
    }) as typeof chokidar.watch,
    requestSynchronization: () => undefined,
    synchronizeProviderFile: async () => ({ indexed: false, sessionId: null }) as never,
    scheduleUsageIngestion: async () => undefined,
    startUsageBackfill: async () => undefined,
    resumeUsageBackfill: async () => undefined,
    onSynchronizationComplete: () => () => undefined,
  });
}

/** P0: real `$CH.next` with a real `projects/` of per-slug links, exchanged with the `$CH` link. */
function pointerSwap({ core, ch, engine }: Fixture, slugs: string[]): void {
  const next = `${ch}.next`;
  mkdirSync(path.join(next, 'projects'), { recursive: true });
  for (const slug of slugs) symlinkSync(path.join(core, 'projects', slug), path.join(next, 'projects', slug));
  execFileSync('python3', [engine, 'exchange', next, ch]);
}

/** One slug through the engine; `holdSeconds` keeps the self-loop visible to the watcher. */
const relocate = ({ core, ch, engine }: Fixture, slug: string, compat: boolean, holdSeconds: number): void => {
  execFileSync('python3', [
    engine, 'relocate', path.join(ch, 'projects', slug), path.join(core, 'projects', slug),
    String(holdSeconds), compat ? '1' : '0',
  ]);
};

const present = (ids: string[]) => ids.filter((id) => sessionsDb.getSessionById(id) !== null && sessionsDb.getSessionById(id) !== undefined);

test('separation replay under chokidar 4.0.3: unlink storm, zero rows deleted', { timeout: 30_000 }, async (t) => {
  await initializeDatabase();
  const layout = fixture(t);
  const withCompat = ['t1880-a1', 't1880-a2'];
  const withoutCompat = ['t1880-b1'];
  const deleted = ['t1880-c1'];
  seedSlug(layout.core, '-slug-a', withCompat);
  seedSlug(layout.core, '-slug-b', withoutCompat);
  const [doomed] = seedSlug(layout.core, '-slug-c', deleted);
  const unlinks: string[] = [];
  await startWatcher(layout.ch, unlinks);

  pointerSwap(layout, ['-slug-a', '-slug-b', '-slug-c']);
  // Normal path, self-loop held long enough for chokidar to drop the subtree.
  relocate(layout, '-slug-a', true, 1.5);
  // Compat link already removed (L4 end state): only the roots fallback can save these rows.
  relocate(layout, '-slug-b', false, 0.3);
  unlinkSync(doomed); // a real retention-sweep deletion, control case

  await sleep(1_000);
  assert.deepEqual(present(deleted), deleted, 'nothing is decided before the re-check delay');
  await sleep(UNLINK_RECHECK_DELAY_MS + 1_500);

  // Observed with chokidar 4.0.3: a real dir replaced by a link (slug a) surfaces
  // as `change` on the slug entry, while a vanished subtree (slug b) emits
  // `unlink` for every transcript in it — the storm the re-check must absorb.
  assert.ok(unlinks.some((file) => file.endsWith(path.join('-slug-b', 't1880-b1.jsonl'))), unlinks.join(', '));
  assert.deepEqual(present([...withCompat, ...withoutCompat]), [...withCompat, ...withoutCompat], 'zero rows deleted');
  assert.deepEqual(present(deleted), [], 'a genuinely deleted transcript is still cleaned up');
});
