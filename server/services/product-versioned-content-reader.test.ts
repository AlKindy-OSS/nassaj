import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GovernanceContentUnavailable,
  readProductVersionedContent,
} from './governance-content-resolver.js';

function productFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-content-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), '# local architecture\n');
  return root;
}

test('reads a regular local product file through the descriptor walk', () => {
  const root = productFixture();
  const result = readProductVersionedContent(root, 'docs/ARCHITECTURE.md');
  assert.equal(result.content, '# local architecture\n');
  assert.equal(result.provenance.source, 'product-versioned');
  assert.match(result.provenance.sha256, /^[a-f0-9]{64}$/);
});

test('rejects an intermediate symlink before opening the product file', () => {
  const root = productFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'product-content-outside-'));
  fs.writeFileSync(path.join(outside, 'ARCHITECTURE.md'), '# external\n');
  fs.renameSync(path.join(root, 'docs'), path.join(root, 'docs-real'));
  fs.symlinkSync(outside, path.join(root, 'docs'), 'dir');
  assert.throws(
    () => readProductVersionedContent(root, 'docs/ARCHITECTURE.md'),
    GovernanceContentUnavailable,
  );
});

test('rejects an intermediate directory swapped for a symlink during the FD read', () => {
  const root = productFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'product-content-swap-'));
  fs.writeFileSync(path.join(outside, 'ARCHITECTURE.md'), '# external\n');
  const originalRead = fs.readSync;
  let swapped = false;
  fs.readSync = function patchedRead(...args: Parameters<typeof fs.readSync>) {
    if (!swapped) {
      swapped = true;
      fs.renameSync(path.join(root, 'docs'), path.join(root, 'docs-original'));
      fs.symlinkSync(outside, path.join(root, 'docs'), 'dir');
    }
    return originalRead.apply(fs, args as never);
  } as typeof fs.readSync;
  try {
    assert.throws(
      () => readProductVersionedContent(root, 'docs/ARCHITECTURE.md'),
      GovernanceContentUnavailable,
    );
  } finally {
    fs.readSync = originalRead;
  }
});
