/**
 * B-1535 / ADR-196: the share sweeper writes (UPDATE session_shares) on its first
 * tick, so it must start only after normal admission opens. Starting it during
 * security_startup_authorized produced an unreviewed startup SQL effect.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.js'), 'utf8');

/** Index of the single occurrence of needle; fails when absent or duplicated. */
function only(needle: string): number {
  const first = source.indexOf(needle);
  assert.ok(first >= 0, `missing ${needle}`);
  assert.equal(source.indexOf(needle, first + 1), -1, `duplicated ${needle}`);
  return first;
}

test('session share sweeper starts after serving admission, never in the startup phase', () => {
  const sweeper = only('sessionShareRuntime.startSweeper();');
  assert.ok(sweeper > only('await backgroundLifecycle.start();'), 'sweeper before background start');
  assert.ok(sweeper > only('normalAdmissionReady = true;'), 'sweeper before normal admission');
  assert.ok(sweeper > only('await listenWithGuard({'), 'sweeper before the listener');
  assert.ok(sweeper > only('privateSecurityReady = true;'), 'sweeper inside security startup');
});
