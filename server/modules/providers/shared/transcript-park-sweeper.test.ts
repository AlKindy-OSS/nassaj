/**
 * B-1608 T2 — the boot sweep removes aged park files left by the transcript
 * removal (`parked_left`), in both park forms, and nothing else: only under
 * provider roots, only regular single-link files with a park name, only past
 * the grace period, never through a symlinked directory.
 *
 * Sandbox: a /var/tmp HOME with members /1 and /10. Files cannot be aged (the
 * grace is on the inode change time, which the park rename sets), so the
 * sweep's clock is moved forward instead.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { initializeDatabase } from '@/modules/database/index.js';
import { AGY_BRAIN_UNDER_HOME } from '@/modules/providers/list/antigravity/agy-brain-layout.js';

import { recordVerifiedPark } from './transcript-park-ledger.js';
import { PARK_GRACE_MS, sweepParkedTranscripts } from './transcript-park-sweeper.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
process.env.NASSAJ_GOVERNANCE_DIR = path.join(SANDBOX_HOME, 'nassaj-core');
await initializeDatabase();

const USERS = path.join(SANDBOX_HOME, '.nassaj-users');
const LONG = (name: string, hex = '0123456789abcdef'): string => `.${name}.nassaj-removing-${hex}`;
const SHORT = (hex = '0123456789abcdef'): string => `.nassaj-removing-${hex}`;
const later = (): number => Date.now() + PARK_GRACE_MS + 60_000;

function write(file: string, text = 'parked'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Writes a park file the removal verified before parking it (qa 2: only these are swept). */
async function parked(file: string): Promise<string> {
  write(file);
  const stat = fs.statSync(file, { bigint: true });
  await recordVerifiedPark(fs.realpathSync(path.dirname(file)), path.basename(file), stat);
  return file;
}

const exists = (target: string): boolean => fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;

test('aged park files in every provider root and both forms are removed; everything else stays', async () => {
  const claudeOp = path.join(SANDBOX_HOME, '.claude', 'projects', '-p');
  const claude1 = path.join(USERS, '1', '.claude', 'projects', '-p');
  const swept = [
    await parked(path.join(claudeOp, LONG('a.jsonl'))),
    await parked(path.join(claudeOp, SHORT('aaaaaaaaaaaaaaaa'))),
    await parked(path.join(claude1, LONG('b.jsonl'))),
    await parked(path.join(USERS, '10', '.claude', 'projects', '-p', 'id', 'subagents', 'workflows', 'wf_1', SHORT('bbbbbbbbbbbbbbbb'))),
    await parked(path.join(SANDBOX_HOME, '.codex', 'sessions', '2026', '09', '01', LONG('rollout-x.jsonl'))),
    await parked(path.join(SANDBOX_HOME, AGY_BRAIN_UNDER_HOME, 'id', '.system_generated', 'logs', LONG('transcript.jsonl'))),
  ];
  const kept = [
    write(path.join(claudeOp, 'a.jsonl')),
    write(path.join(claudeOp, '.a.jsonl.nassaj-removing-short')),
    // Neither form: wrong hex length, and the never-produced `.nassaj-rm-` guess.
    write(path.join(claudeOp, '.nassaj-removing-0123')),
    write(path.join(claudeOp, '.nassaj-rm-0123456789abcdef')),
    write(path.join(claudeOp, `${LONG('c.jsonl')}.tmp`)),
    // Outside every provider root.
    write(path.join(SANDBOX_HOME, 'notes', LONG('n.jsonl'))),
    write(path.join(USERS, '1', LONG('n.jsonl'))),
  ];
  const result = await sweepParkedTranscripts({ now: later() });
  for (const file of swept) assert.equal(exists(file), false, path.relative(SANDBOX_HOME, file));
  for (const file of kept) assert.equal(exists(file), true, path.relative(SANDBOX_HOME, file));
  assert.equal(result.removed, swept.length);
});

test('a park file younger than the grace period stays', async () => {
  const fresh = await parked(path.join(SANDBOX_HOME, '.claude', 'projects', '-fresh', LONG('f.jsonl')));
  await sweepParkedTranscripts();
  assert.equal(exists(fresh), true);
  await sweepParkedTranscripts({ now: later() });
  assert.equal(exists(fresh), false);
});

test('park-named symlinks, hard links and directories stay, and their targets are untouched', async () => {
  const dir = path.join(SANDBOX_HOME, '.claude', 'projects', '-links');
  const victim = write(path.join(USERS, '10', 'private.txt'), 'victim');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(victim, path.join(dir, LONG('s.jsonl')));
  fs.linkSync(victim, path.join(dir, LONG('h.jsonl')));
  fs.mkdirSync(path.join(dir, SHORT('dddddddddddddddd')));
  await sweepParkedTranscripts({ now: later() });
  assert.equal(fs.lstatSync(path.join(dir, LONG('s.jsonl'))).isSymbolicLink(), true);
  assert.equal(exists(path.join(dir, LONG('h.jsonl'))), true);
  assert.equal(exists(path.join(dir, SHORT('dddddddddddddddd'))), true);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'victim');
  assert.equal(fs.statSync(victim).nlink, 2);
});

test('a symlinked directory inside a provider root is never entered', async () => {
  const outside = path.join(SANDBOX_HOME, 'elsewhere');
  const victim = write(path.join(outside, LONG('v.jsonl')), 'victim');
  fs.symlinkSync(outside, path.join(SANDBOX_HOME, '.claude', 'projects', '-linked-dir'));
  await sweepParkedTranscripts({ now: later() });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'victim');
});

test('a member root that physically lies in another member\'s tree is not swept through it', async () => {
  const victimRoot = path.join(USERS, '10', 'stash');
  const victim = write(path.join(victimRoot, '-p', LONG('v.jsonl')), 'victim');
  const codexRoot1 = path.join(USERS, '1', '.codex', 'sessions');
  fs.mkdirSync(path.dirname(codexRoot1), { recursive: true });
  fs.symlinkSync(victimRoot, codexRoot1);
  await sweepParkedTranscripts({ now: later() });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'victim');
});

test('the server starts the sweep at boot', () => {
  const boot = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'index.js'), 'utf8');
  assert.match(boot, /\n\s+startParkedTranscriptSweep\(\);/);
  assert.match(boot, /import \{[^}]*\bstartParkedTranscriptSweep\b[^}]*\} from '@\/modules\/providers\/index\.js';/);
});

test('qa 2: an aged park file the removal never verified (not in the ledger) is kept', async () => {
  const dir = path.join(SANDBOX_HOME, '.claude', 'projects', '-unverified');
  const unverified = write(path.join(dir, SHORT('cccccccccccccccc')));
  const replaced = await parked(path.join(dir, SHORT('eeeeeeeeeeeeeeee')));
  // Moved aside (not deleted) so the new file cannot reuse its inode number.
  fs.renameSync(replaced, path.join(dir, 'moved-aside'));
  write(replaced, 'another file at the ledgered name');
  await sweepParkedTranscripts({ now: later() });
  assert.equal(exists(unverified), true, 'a park that came out of `swapped` is never swept');
  assert.equal(fs.readFileSync(replaced, 'utf8'), 'another file at the ledgered name', 'the ledger binds dev/ino, not the name');
});
