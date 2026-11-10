/**
 * The active npm-lock source and host facts (T-2086 S4). Production reads the
 * committed DSH pin table, the server's own node runtime and statfs; tests
 * replace any subset through `_setNpmLockTestDeps`.
 */

import fs from 'node:fs';

import { DSH_NPM_LOCK_SOURCE, type NpmLockInstallSource } from './pins.js';

/** Host facts the npm-lock flows read (tests inject). */
export interface NpmLockHostDeps {
  source: NpmLockInstallSource;
  /** The node that runs npm and dsh (the S2 resolver checks it). */
  nodeRuntime: () => { execPath: string; version: string };
  /** Free bytes on the filesystem holding `dir`. */
  freeBytes: (dir: string) => number;
}

let testDeps: Partial<NpmLockHostDeps> | null = null;

/** Test hook: replace any subset of the host facts (null restores production). */
export function _setNpmLockTestDeps(next: Partial<NpmLockHostDeps> | null): void {
  testDeps = next;
}

/** The host facts in effect. */
export function npmLockHostDeps(): NpmLockHostDeps {
  return {
    source: DSH_NPM_LOCK_SOURCE,
    nodeRuntime: () => ({ execPath: process.execPath, version: process.versions.node }),
    freeBytes: (dir) => {
      const st = fs.statfsSync(dir);
      return st.bavail * st.bsize;
    },
    ...(testDeps ?? {}),
  };
}

/** The pin table in effect. */
export function activeNpmLockSource(): NpmLockInstallSource {
  return npmLockHostDeps().source;
}
