import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getAntigravityTokenPath } from '@/modules/providers/list/antigravity/antigravity-token-reader.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { PROVIDER_MODELS_CACHE_VERSION } from '@/modules/providers/services/provider-models.service.js';
import {
  GEMINI_GOVERNANCE_FILENAME,
  GEMINI_HOME_SUBDIR,
  geminiGovernanceSource,
} from '@/services/isolation/gemini-governance-material.js';
import { AppError } from '@/shared/utils.js';

import { resolveHarnessId } from './descriptors.js';

/**
 * T-1749 / ADR-159 D1 — the `gemini` provider is removed server-side; agy
 * (antigravity), which merely shares the ~/.gemini HOME, is untouched; historical
 * rows stay read-only (no destructive migration); the model catalog is retired.
 */

test('the registry no longer resolves gemini — clean 4xx, never a crash', () => {
  assert.throws(
    () => providerRegistry.resolveProvider('gemini'),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 400);
      return true;
    },
  );
});

test('agy/antigravity provider is still registered (separate module)', () => {
  const agy = providerRegistry.resolveProvider('antigravity');
  assert.ok(agy);
});

test('gemini is not offered as an updatable harness (not a CLI row)', () => {
  assert.equal(resolveHarnessId('gemini'), null);
});

test('the model-catalog cache version was bumped to retire gemini entries', () => {
  assert.equal(PROVIDER_MODELS_CACHE_VERSION, 6);
});

/**
 * agy REGRESSION GUARD (D1 "keep untouched"): agy stores its state under
 * `~/.gemini/antigravity-cli/**` and ingests `~/.gemini/GEMINI.md`. Both are
 * `~/.gemini` consumers, NOT the removed gemini provider, so removing gemini
 * must leave them resolving byte-identically.
 */
test('agy still resolves its credential under ~/.gemini/antigravity-cli', () => {
  assert.equal(
    getAntigravityTokenPath(null),
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  );
});

test('agy governance material still reads ~/.gemini/GEMINI.md', () => {
  assert.equal(GEMINI_HOME_SUBDIR, '.gemini');
  assert.equal(GEMINI_GOVERNANCE_FILENAME, 'GEMINI.md');
  assert.equal(geminiGovernanceSource(), path.join(os.homedir(), '.gemini', 'GEMINI.md'));
});
