/**
 * ADR-194 D1/D10 CI guard (T-1962 S1): the env-only SSO switch was replaced by
 * ssoPolicyEnforced() and ssoLoginAvailable(). Its identifier must never come
 * back anywhere under server/, src/ or shared/ (code, tests or comments).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCANNED_ROOTS = ['server', 'src', 'shared'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-server']);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|md)$/;
// Assembled so this guard never matches itself if scripts/ is ever scanned.
const FORBIDDEN = new RegExp(`\\b${'oidc'}${'Enabled'}\\b`);

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* sourceFiles(full);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      yield full;
    }
  }
}

test('the removed env-only SSO switch identifier appears nowhere under server/, src/ or shared/', () => {
  const offenders = [];
  for (const root of SCANNED_ROOTS) {
    for (const file of sourceFiles(path.join(ROOT, root))) {
      if (FORBIDDEN.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], 'use ssoPolicyEnforced() / ssoLoginAvailable() (ADR-194 D1)');
});
