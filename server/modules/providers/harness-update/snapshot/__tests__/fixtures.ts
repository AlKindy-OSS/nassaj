/**
 * Test-only helpers for the T-1871 snapshot libraries. Every fixture lives
 * under NASSAJ_TEST_TEMP_ROOT (default /var/tmp) — never /tmp (tmpfs), never a
 * real harness install or real member data.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { HarnessSnapshotManifest } from '../manifest.js';

/** Creates a fresh private fixture dir under /var/tmp and returns it. */
export function makeFixtureRoot(prefix = 'nassaj-t1871-'): string {
  const parent = process.env.NASSAJ_TEST_TEMP_ROOT || '/var/tmp';
  if (parent === '/tmp' || parent.startsWith('/tmp/') || parent.startsWith('/dev/shm')) {
    throw new Error('fixtures must not live on tmpfs');
  }
  return fs.mkdtempSync(path.join(parent, prefix));
}

/** Removes a fixture dir, restoring write bits first so chmod-ed dirs go too. */
export function removeFixture(root: string): void {
  const unlock = (p: string): void => {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st || !st.isDirectory()) return;
    fs.chmodSync(p, 0o700);
    for (const child of fs.readdirSync(p)) unlock(path.join(p, child));
  };
  unlock(root);
  fs.rmSync(root, { recursive: true, force: true });
}

/** Writes `content` to `file`, creating parents. */
export function writeFixtureFile(file: string, content: string | Buffer, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

/** A minimal valid manifest; override any field. */
export function makeManifest(over: Partial<HarnessSnapshotManifest> = {}): HarnessSnapshotManifest {
  const createdAt = over.createdAt ?? 1_700_000_000_000;
  return {
    schema: 1,
    jobId: 'job-1',
    harness: 'codex',
    kind: 'update',
    trigger: 'manual',
    userId: 1,
    createdAt,
    expiresAt: createdAt + 7 * 24 * 3600 * 1000,
    state: 'snapshotted',
    stateHistory: [{ state: 'snapshotted', at: createdAt }],
    from: { version: '1.0.0', binarySha256: 'a'.repeat(64), treeSha256: 'b'.repeat(64) },
    to: null,
    binary: null,
    stores: null,
    restore: null,
    counted: false,
    ...over,
  };
}

/** File mode bits of `p` (no follow). */
export function modeOf(p: string): number {
  return fs.lstatSync(p).mode & 0o777;
}
