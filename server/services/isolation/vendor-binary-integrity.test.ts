/**
 * SL-7 / M-4 (OCC-15, ADR-062) — vendor binary sha256 pin + fail-closed launch
 * guard. Tests use REAL temp files hashed with REAL sha256 (no synthetic digest
 * fixtures — lesson feedback_synthetic_fixtures_false_confidence): the only
 * injected value is the EXPECTED pin for the positive/match case, which is
 * derived from the actual bytes on disk. The negative cases run against the real
 * shipped pins.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PINNED_VENDOR_DIGESTS,
  VENDOR_BINARY_PIN_FLAG,
  VendorBinaryIntegrityError,
  computeFileSha256,
  isVendorBinaryPinEnabled,
  resolveExecutableForHashing,
  verifyVendorBinaryDigest,
} from '@/services/isolation/vendor-binary-integrity.js';
import { resolveOpenCodeBinaryPath } from '@/shared/utils.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vbi-'));
}

/** Runs `fn`, asserts it threw a VendorBinaryIntegrityError, and returns it. */
function catchIntegrityError(fn: () => unknown): VendorBinaryIntegrityError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof VendorBinaryIntegrityError, `expected VendorBinaryIntegrityError, got ${err}`);
    return err;
  }
  assert.fail('expected VendorBinaryIntegrityError to be thrown, but nothing threw');
}

function writeFileWith(dir: string, name: string, content: string): { file: string; sha256: string } {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  return { file, sha256 };
}

/** Snapshot + restore the two live env keys resolveOpenCodeBinaryPath reads. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const keys = ['OPENCODE_PATH', VENDOR_BINARY_PIN_FLAG];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) {
    prev[k] = process.env[k];
  }
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev[k];
      }
    }
  }
}

// ---------- the shipped pins are exactly the OCC-15/KG-1 root-of-trust values ----------

test('PINNED_VENDOR_DIGESTS: opencode + kimi carry the exact OCC-15/KG-1 digests', () => {
  assert.equal(
    PINNED_VENDOR_DIGESTS.opencode.sha256,
    '0cbfb6de55aa4ce3c74da12d8516376033693a88abca6238c5be32bf98130636',
  );
  assert.equal(PINNED_VENDOR_DIGESTS.opencode.version, '1.17.18');
  assert.equal(
    PINNED_VENDOR_DIGESTS.kimi.sha256,
    '46a0095fa08385027e2e2d02d3c3ee274ecc2094f136dc745910bd72273f7763',
  );
  assert.equal(PINNED_VENDOR_DIGESTS.kimi.version, '0.28.1');
});

// ---------- the arming flag ----------

test('isVendorBinaryPinEnabled: only explicit truthy strings arm the guard', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(isVendorBinaryPinEnabled({ [VENDOR_BINARY_PIN_FLAG]: v }), true, `"${v}" arms`);
  }
  for (const v of [undefined, '', '0', 'false', 'no', 'off', 'enabled?']) {
    assert.equal(
      isVendorBinaryPinEnabled({ [VENDOR_BINARY_PIN_FLAG]: v as string }),
      false,
      `"${v}" does not arm`,
    );
  }
});

// ---------- DISABLED = strict no-op (literal opencode back-compat) ----------

test('verifyVendorBinaryDigest: DISABLED is a strict no-op — no hashing, no throw, path unchanged', () => {
  let hashed = false;
  const out = verifyVendorBinaryDigest('opencode', '/definitely/does/not/exist/opencode', {
    enforced: false,
    hashFile: () => {
      hashed = true;
      return 'x';
    },
  });
  assert.equal(out, '/definitely/does/not/exist/opencode');
  assert.equal(hashed, false, 'a disabled guard must not even read the binary');
});

// ---------- ENABLED + digest MATCH → path returned ----------

test('verifyVendorBinaryDigest: ENABLED + matching sha256 returns the path unchanged', () => {
  const dir = tmpDir();
  const { file, sha256 } = writeFileWith(dir, 'opencode', 'approved-bytes-v1');
  const out = verifyVendorBinaryDigest('opencode', file, {
    enforced: true,
    pins: { opencode: { sha256 } },
  });
  assert.equal(out, file);
});

// ---------- ENABLED + digest MISMATCH → refuse spawn ----------

test('verifyVendorBinaryDigest: ENABLED + deviated bytes throws (spawn refused)', () => {
  const dir = tmpDir();
  // Real file, real hash — but the shipped opencode pin will not match it.
  const { file } = writeFileWith(dir, 'opencode', 'TAMPERED-not-the-real-1.17.18');
  const err = catchIntegrityError(() => verifyVendorBinaryDigest('opencode', file, { enforced: true }));
  assert.equal(err.reason, 'mismatch');
  assert.equal(err.vendorId, 'opencode');
  assert.equal(err.expected, PINNED_VENDOR_DIGESTS.opencode.sha256);
  assert.equal(err.resolvedPath, file);
  assert.notEqual(err.actual, err.expected);
});

// ---------- ENABLED + unverifiable → fail-closed ----------

test('verifyVendorBinaryDigest: ENABLED + unlocatable binary fails closed (unverifiable)', () => {
  const err = catchIntegrityError(
    () => verifyVendorBinaryDigest('opencode', '/no/such/opencode', { enforced: true }),
  );
  assert.equal(err.reason, 'unverifiable');
});

// ---------- ENABLED + unpinned vendor → out of mandate, pass-through ----------

test('verifyVendorBinaryDigest: ENABLED but vendor has no pin is a pass-through no-op', () => {
  const out = verifyVendorBinaryDigest('some-future-cli', '/whatever/bin', { enforced: true });
  assert.equal(out, '/whatever/bin');
});

// ---------- both pinned vendors are enforced by the SAME primitive ----------

test('verifyVendorBinaryDigest: kimi is pinned too (deviated dist/main.mjs refused)', () => {
  const dir = tmpDir();
  const { file } = writeFileWith(dir, 'main.mjs', 'not-the-real-kimi-0.28.1');
  const err = catchIntegrityError(() => verifyVendorBinaryDigest('kimi', file, { enforced: true }));
  assert.equal(err.vendorId, 'kimi');
  assert.equal(err.expected, PINNED_VENDOR_DIGESTS.kimi.sha256);
});

// ---------- PATH-fallback resolution (M-4: covers the bare-`opencode` branch) ----------

test('resolveExecutableForHashing: a bare command name is resolved through $PATH', () => {
  const dir = tmpDir();
  const { file } = writeFileWith(dir, 'opencode', 'bytes');
  const resolved = resolveExecutableForHashing('opencode', { PATH: `/nope${path.delimiter}${dir}` });
  assert.equal(resolved, file);
});

test('resolveExecutableForHashing: an absolute path is used verbatim; a missing one is null', () => {
  const dir = tmpDir();
  const { file } = writeFileWith(dir, 'opencode', 'bytes');
  assert.equal(resolveExecutableForHashing(file, {}), file);
  assert.equal(resolveExecutableForHashing('/no/such/file', {}), null);
  assert.equal(resolveExecutableForHashing('bare-not-on-path', { PATH: dir }), null);
});

test('verifyVendorBinaryDigest: ENABLED verifies a bare command via $PATH, then matches', () => {
  const dir = tmpDir();
  const { sha256 } = writeFileWith(dir, 'opencode', 'path-resolved-bytes');
  const out = verifyVendorBinaryDigest('opencode', 'opencode', {
    enforced: true,
    env: { PATH: dir },
    pins: { opencode: { sha256 } },
  });
  assert.equal(out, 'opencode', 'returns the ORIGINAL spawn target, not the hashed absolute path');
});

test('computeFileSha256: matches node crypto over the same bytes', () => {
  const dir = tmpDir();
  const { file, sha256 } = writeFileWith(dir, 'blob', 'hello sl-7');
  assert.equal(computeFileSha256(file), sha256);
});

// ---------- M-4 wiring: the guard runs AFTER resolveOpenCodeBinaryPath resolves ----------

test('resolveOpenCodeBinaryPath: OPENCODE_PATH override is verified AFTER resolution (M-4)', () => {
  const dir = tmpDir();
  const { file } = writeFileWith(dir, 'opencode', 'override-bytes-not-pinned');

  // Guard OFF → literal back-compat: the override is returned unchanged even
  // though its bytes do not match the pin (no hashing at all).
  withEnv({ OPENCODE_PATH: file, [VENDOR_BINARY_PIN_FLAG]: undefined }, () => {
    assert.equal(resolveOpenCodeBinaryPath(), file);
  });

  // Guard ON → the SAME override path is now hashed post-resolution and, being
  // un-pinned bytes, refused. This proves the pin cannot be routed around by
  // OPENCODE_PATH (verification happens after the override branch resolves).
  withEnv({ OPENCODE_PATH: file, [VENDOR_BINARY_PIN_FLAG]: '1' }, () => {
    const err = catchIntegrityError(() => resolveOpenCodeBinaryPath());
    assert.equal(err.reason, 'mismatch');
    assert.equal(err.resolvedPath, file);
  });
});
