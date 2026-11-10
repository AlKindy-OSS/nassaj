/**
 * Launch trust of an npm-lock install tree (T-2086 S4, ADR-224). UNCONDITIONAL:
 * not behind NASSAJ_VENDOR_BINARY_PIN.
 *
 *   - full check: the whole version dir against its committed tree manifest,
 *     after every install/update/rollback and once at boot (in the background);
 *   - cheap check on every launch: the launcher resolves to the entry of a
 *     reviewed pin, the entry bytes match the manifest, that version's last
 *     full verdict is `verified`, and the tree's stat signature (path, kind,
 *     inode, size, mtime, mode of every entry) still equals the one taken when
 *     it was verified. A changed signature refuses the launch and re-runs the
 *     full check (an unchanged-content touch is cleared by it).
 *
 * A launch before the first full verdict is refused `unverified` and starts
 * the verification, so the next launch passes (fail-closed, never a wait).
 */

import fs from 'node:fs';
import os from 'node:os';

import { activeNpmLockSource } from './npm-lock-source.js';
import {
  currentVersion, isReviewedVersion, keptVersions, loadReviewedPin, versionDir, versionOfEntry, versionsDir, type NpmLockInstallSource,
} from './pins.js';
import { hashSmallFileSync, treeStatSignatureSync, verifyTreeManifest } from './tree-manifest.js';

type Verdict = 'verified' | 'tampered';

/** Last full verdict per version dir. */
const verdicts = new Map<string, Verdict>();
/** Stat signature of each verified version dir, taken around its full check. */
const signatures = new Map<string, string>();

/** The stat signature of `dir`, or null when the tree cannot be read. */
function statSignature(dir: string): string | null {
  try {
    return treeStatSignatureSync(dir);
  } catch {
    return null;
  }
}

/** Records `verdict` for `dir`, with the signature a verified tree must keep. */
function setVerdict(dir: string, verdict: Verdict, signature: string | null): void {
  if (verdict === 'verified' && signature !== null) {
    verdicts.set(dir, 'verified');
    signatures.set(dir, signature);
    return;
  }
  verdicts.set(dir, 'tampered');
  signatures.delete(dir);
}
const running = new Map<string, Promise<Verdict>>();

/** Test hook: forget every verdict. */
export function _resetNpmLockTrust(): void {
  verdicts.clear();
  signatures.clear();
  running.clear();
}

/** Records a verdict reached by an install flow (it ran the same full check). */
export function recordTreeVerdict(dir: string, verdict: Verdict): void {
  setVerdict(dir, verdict, verdict === 'verified' ? statSignature(dir) : null);
}

/** Full check of `version`'s tree; records and returns the verdict. Never throws. */
export async function verifyVersionTree(source: NpmLockInstallSource, home: string, version: string): Promise<Verdict> {
  const dir = versionDir(source, home, version);
  const inFlight = running.get(dir);
  if (inFlight) return inFlight;
  let signature: string | null = null;
  const job = (async (): Promise<Verdict> => {
    try {
      const before = statSignature(dir);
      const { manifest } = loadReviewedPin(source, home, version);
      const result = await verifyTreeManifest(dir, manifest);
      if (!result.ok) {
        console.warn('[dsh-tree-tampered]', { version, changed: result.changedPackages, error: result.error ?? null });
      }
      // The tree must not change while it is hashed: the signature the launches
      // compare against is the one the verified bytes had.
      signature = before !== null && before === statSignature(dir) ? before : null;
      return result.ok && signature !== null ? 'verified' : 'tampered';
    } catch {
      return 'tampered';
    }
  })();
  running.set(dir, job);
  const verdict = await job;
  running.delete(dir);
  setVerdict(dir, verdict, signature);
  return verdict;
}

/** Boot: full check of every kept version (current first). Never throws. */
export async function verifyNpmLockTreesAtBoot(home = os.homedir()): Promise<void> {
  const source = activeNpmLockSource();
  const current = currentVersion(source, home);
  const order = [...new Set([...(current ? [current] : []), ...keptVersions(source, home)])];
  for (const version of order) {
    if (isReviewedVersion(source, home, version)) await verifyVersionTree(source, home, version);
  }
}

/** Refusal codes of the launch check. */
export type TreeRefusal = 'tree_unmanaged' | 'tree_tampered' | 'tree_unverified';

/**
 * The cheap per-launch check of the resolved launcher `script`; null = trusted.
 * Starts a background full check when no verdict exists yet.
 */
export function npmLockLaunchRefusal(script: string, home = os.homedir()): TreeRefusal | null {
  const source = activeNpmLockSource();
  let real: string;
  try {
    real = fs.realpathSync(script);
  } catch {
    return 'tree_unmanaged';
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(versionsDir(source, home));
  } catch {
    return 'tree_unmanaged';
  }
  const version = versionOfEntry(source, realRoot, real);
  if (!version || !isReviewedVersion(source, home, version)) return 'tree_unmanaged';
  let entrySha: string;
  try {
    entrySha = loadReviewedPin(source, home, version).manifest.entry.sha256;
  } catch {
    return 'tree_unmanaged';
  }
  const dir = versionDir(source, home, version);
  if (hashSmallFileSync(real) !== entrySha) {
    setVerdict(dir, 'tampered', null);
    return 'tree_tampered';
  }
  const verdict = verdicts.get(dir);
  if (verdict === 'verified') {
    if (statSignature(dir) === signatures.get(dir)) return null;
    console.warn('[dsh-tree-changed] the install tree changed after its check; re-verifying', { version });
    verdicts.delete(dir);
    signatures.delete(dir);
    void verifyVersionTree(source, home, version);
    return 'tree_tampered';
  }
  if (verdict === 'tampered') return 'tree_tampered';
  void verifyVersionTree(source, home, version);
  return 'tree_unverified';
}
