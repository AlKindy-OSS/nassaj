import type { BigIntStats, Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { physicalMemberOf } from './contained-file.js';
import { openPinned, type PinnedHandle } from './pinned-fd.js';
import { isParkName } from './session-transcript-park.js';
import { parkKey, readParkLedger, writeParkLedger, type ParkLedgerEntry } from './transcript-park-ledger.js';
import { removalSpecOf } from './session-transcript-specs.js';

/**
 * B-1608 T2 — boot-time sweep of names the transcript removal left parked
 * (`parked_left`: neither unlinked nor linked back; either park form,
 * session-transcript-park.ts). Such a file is invisible to every reader and
 * would otherwise stay forever.
 *
 * Scope and checks:
 *   - only provider roots: every provider's operator/shared roots and the
 *     members' `<users>/<n>/<underHome>` roots, each walked once by realpath;
 *     a member root that physically lies in another member's tree is skipped
 *     (ADR-201 H1);
 *   - every directory is pinned (`O_DIRECTORY|O_NOFOLLOW`) through its pinned
 *     parent; a symlinked directory is never entered;
 *   - qa 2: an entry is removed only when the removal ledgered it after
 *     verifying it (transcript-park-ledger.ts: same directory, name, device
 *     and inode) — a park left by the `swapped` path is never removed;
 *   - and only when its name is a park name, it is a regular
 *     single-link file (pinned, no-follow), its inode change time — set by the
 *     rename that parked it — is older than the grace period, and it is still
 *     that same file right before the unlink through the pinned directory.
 * Never throws; returns counts only (no paths, no content).
 */

export type ParkSweepOptions = {
  /** Clock for the grace test; tests move it forward instead of ageing files. */
  now?: number;
  /** Minimum age of the park (inode change time); default {@link PARK_GRACE_MS}. */
  graceMs?: number;
};

export type ParkSweepResult = { roots: number; removed: number; kept: number };

/** A parked name younger than this may belong to a removal still in flight. */
export const PARK_GRACE_MS = 60 * 60 * 1000;
const PROVIDERS = ['claude', 'codex', 'antigravity', 'kimi', 'deepseek', 'glm', 'hermes', 'qwen', 'cursor'];
const PROC_FD_DIR = '/proc/self/fd';
/** Deepest level below a root (Claude `<project>/<id>/subagents/workflows/<wf>`, agy brains). */
const MAX_DEPTH = 6;
/** Entries listed per root before the walk stops. */
const MAX_ENTRIES = 500_000;

type Sweep = { cutoffMs: number; result: ParkSweepResult; budget: number; ledgered: Set<string>; swept: Set<string> };

function through(dir: PinnedHandle, name: string): string {
  return path.join(PROC_FD_DIR, String(dir.handle.fd), name);
}

/** Numeric member ids under `<home>/.nassaj-users` (listing only). */
async function memberIds(): Promise<string[]> {
  const users = path.join(os.homedir(), '.nassaj-users');
  const names = await fsp.readdir(users).catch(() => [] as string[]);
  return names.filter((name) => /^\d+$/.test(name));
}

/** Literal provider roots with the member that owns each (null for operator/shared). */
async function providerRoots(): Promise<Array<{ root: string; member: string | null }>> {
  const members = await memberIds();
  const roots: Array<{ root: string; member: string | null }> = [];
  for (const provider of PROVIDERS) {
    const spec = removalSpecOf(provider);
    if (!spec) continue;
    for (const root of await spec.sharedRoots().catch(() => [] as string[])) roots.push({ root, member: null });
    if (!spec.underHome) continue;
    const underHome = spec.underHome;
    for (const member of members) roots.push({ root: path.join(os.homedir(), '.nassaj-users', member, underHome), member });
  }
  return roots;
}

/** Realpaths of the roots to sweep: own-tree roots only (H1), each once. */
async function sweepRoots(): Promise<string[]> {
  const real = new Set<string>();
  for (const { root, member } of await providerRoots()) {
    const resolved = await fsp.realpath(root).catch(() => null);
    if (!resolved) continue;
    const owner = await physicalMemberOf(resolved);
    if (owner === null || owner === member) real.add(resolved);
  }
  return [...real];
}

/** True while `name` in `dir` is still the pinned file `stat`. */
async function isStill(dir: PinnedHandle, name: string, stat: BigIntStats): Promise<boolean> {
  const now = await fsp.lstat(through(dir, name), { bigint: true }).catch(() => null);
  return now !== null && now.isFile() && now.dev === stat.dev && now.ino === stat.ino && now.nlink === 1n;
}

/** One park-named entry: pinned single-link, aged past the grace, unchanged, then unlinked. */
async function sweepParked(dir: PinnedHandle, name: string, sweep: Sweep): Promise<void> {
  let parked: PinnedHandle;
  try {
    parked = await openPinned(path.join(dir.realpath, name), 'file', { singleLink: true, via: through(dir, name) });
  } catch {
    sweep.result.kept += 1;
    return;
  }
  try {
    const key = parkKey(dir.realpath, name, parked.stat);
    const old = Number(parked.stat.ctimeMs) < sweep.cutoffMs;
    if (old && sweep.ledgered.has(key) && await isStill(dir, name, parked.stat)) {
      await fsp.unlink(through(dir, name));
      sweep.swept.add(key);
      sweep.result.removed += 1;
    } else {
      sweep.result.kept += 1;
    }
  } catch {
    sweep.result.kept += 1;
  } finally {
    await parked.handle.close().catch(() => undefined);
  }
}

/** Entries of a pinned directory with their own (never followed) types, bounded. */
async function entriesOf(dir: PinnedHandle, sweep: Sweep): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  const handle = await fsp.opendir(path.join(PROC_FD_DIR, String(dir.handle.fd)));
  try {
    for (let entry = await handle.read(); entry && sweep.budget > 0; entry = await handle.read()) {
      sweep.budget -= 1;
      entries.push(entry);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return entries;
}

/** Walks one pinned directory: park-named files are swept, subdirectories entered (pinned). */
async function sweepDirectory(dir: PinnedHandle, depth: number, sweep: Sweep): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await entriesOf(dir, sweep);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isParkName(entry.name)) {
      if (entry.isFile()) await sweepParked(dir, entry.name, sweep);
      else sweep.result.kept += 1;
    } else if (entry.isDirectory() && depth < MAX_DEPTH) {
      let child: PinnedHandle;
      try {
        child = await openPinned(path.join(dir.realpath, entry.name), 'directory', { via: through(dir, entry.name) });
      } catch {
        continue;
      }
      try {
        await sweepDirectory(child, depth + 1, sweep);
      } finally {
        await child.handle.close().catch(() => undefined);
      }
    }
  }
}

/**
 * Sweeps aged park files under the provider roots (see the module comment).
 * Never throws; a root or directory that cannot be pinned is skipped.
 */
export async function sweepParkedTranscripts(options: ParkSweepOptions = {}): Promise<ParkSweepResult> {
  const ledger = await readParkLedger();
  if (ledger.length === 0) return { roots: 0, removed: 0, kept: 0 };
  const sweep: Sweep = {
    cutoffMs: (options.now ?? Date.now()) - (options.graceMs ?? PARK_GRACE_MS),
    result: { roots: 0, removed: 0, kept: 0 },
    budget: 0,
    ledgered: new Set(ledger.map((entry) => parkKey(entry.dir, entry.name, entry))),
    swept: new Set(),
  };
  for (const root of await sweepRoots().catch(() => [] as string[])) {
    let dir: PinnedHandle;
    try {
      dir = await openPinned(root, 'directory');
    } catch {
      continue;
    }
    sweep.result.roots += 1;
    sweep.budget = MAX_ENTRIES;
    try {
      await sweepDirectory(dir, 0, sweep);
    } finally {
      await dir.handle.close().catch(() => undefined);
    }
  }
  await pruneLedger(sweep.swept);
  return sweep.result;
}

/** Drops swept entries and entries whose park name is gone; re-read so a concurrent append survives. */
async function pruneLedger(swept: Set<string>): Promise<void> {
  const kept: ParkLedgerEntry[] = [];
  for (const entry of await readParkLedger()) {
    const key = parkKey(entry.dir, entry.name, entry);
    const present = await fsp.lstat(path.join(entry.dir, entry.name)).then(() => true, () => false);
    if (!swept.has(key) && present) kept.push(entry);
  }
  await writeParkLedger(kept);
}

/** Boot hook: runs the sweep off the startup path and logs counts once. */
export function startParkedTranscriptSweep(): void {
  void sweepParkedTranscripts().then((result) => {
    if (result.removed > 0 || result.kept > 0) {
      console.warn('Parked transcript sweep', { event: 'parked_transcript_sweep', ...result });
    }
  }, () => undefined);
}
