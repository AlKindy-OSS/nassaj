/**
 * `resolveVendorTranscriptForRead` must find a vendor transcript even when it was
 * written under a legacy (physical-overlay) project hash that no longer matches
 * the logical project path the session row records — the exact divergence that
 * blanked overlay-launched vendor sessions. It must also refuse a stored
 * jsonl_path that escapes the provider's root, and `vendorProjectHash` must leave
 * non-overlay paths hashing exactly as md5(path) did before.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  resolveVendorTranscriptForRead,
  vendorProjectHash,
} from './vendor-transcript.js';

const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

async function withTemporaryHome(runTest: (home: string) => Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const home = await mkdtemp('/var/tmp/vendor-resolve-home-');
  process.env.HOME = home;
  try {
    await runTest(home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

test('reads a file stored under a hash different from the passed project path (scan recovery)', async () => {
  await withTemporaryHome(async (home) => {
    const sessionId = 'sess-legacy-hash';
    // The file was written under a PHYSICAL overlay hash; the caller passes the
    // LOGICAL project path, whose hash points at a directory that never existed.
    const legacyHash = md5('/repo/.git/nassaj-session-overlays/instances/x/workspace');
    const file = path.join(home, '.nassaj-vendor-sessions', 'qwen', legacyHash, `${sessionId}.jsonl`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ type: 'meta', projectPath: '/repo' })}\n`);

    const resolved = await resolveVendorTranscriptForRead('qwen', sessionId, '/repo', null);
    assert.equal(resolved, file, 'the scan must recover the legacy-hash file');
  });
});

test('rejects a stored jsonl_path that escapes the provider root', async () => {
  await withTemporaryHome(async (home) => {
    const sessionId = 'sess-escape';
    // A crafted jsonl_path outside ~/.nassaj-vendor-sessions/<provider> must be
    // refused even though its leaf name matches — jsonl_path is a DB column.
    const outside = path.join(home, 'outside', `${sessionId}.jsonl`);
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, `${JSON.stringify({ type: 'meta' })}\n`);

    const resolved = await resolveVendorTranscriptForRead('kimi', sessionId, '/repo', outside);
    assert.equal(resolved, null, 'a jsonl_path outside the provider root is not trusted');
  });
});

test('vendorProjectHash of a plain non-overlay path equals md5(path)', () => {
  // A path that does not resolve to an overlay workspace is returned unchanged by
  // logicalProjectPathForWorkspace, so its hash must be byte-for-byte the legacy
  // md5(path). '/work/proj' does not exist, so realpath fails and the mapper
  // returns the input untouched.
  const plainPath = '/work/proj';
  assert.equal(vendorProjectHash(plainPath), md5(plainPath));
});
