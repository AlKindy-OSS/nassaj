/**
 * T-2035 (ADR-212) guard: every session-JWT verifier applies the sign-out
 * epoch AND the per-device revocation (round 3). A server file may call
 * `jwt.verify` only as often as it calls `tokenSessionCurrent` with the raw
 * token as its third argument, except for the reviewed allowlist below, each entry
 * naming exactly how many verifies are exempt and why. A new verifier that
 * forgets the epoch (the share-link and C4 review holes found in review)
 * fails here.
 */

import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { tokenEpochCurrent } from './token-epoch.js';

const SERVER_ROOT = path.resolve(import.meta.dirname, '../..');

/** File (relative to server/) → verifies that legitimately skip the epoch. */
const EXEMPT_VERIFIES: Readonly<Record<string, { count: number; reason: string }>> = Object.freeze({
  'middleware/auth.js': {
    count: 2,
    reason: 'the forced-rotation purpose cookie (no session epoch), and verifyTokenAllowingRecentExpiry, '
      + 'whose only caller (routes/auth.js graceRefresh) applies tokenSessionCurrent itself',
  },
  'modules/websocket/services/websocket-auth.service.ts': {
    count: 1, reason: 'rejection classifier after authenticateWebSocket already refused; authorizes nothing',
  },
  'services/oidc-verifier.service.js': {
    count: 1, reason: 'identity-provider ID/logout tokens signed by the IdP, not session JWTs',
  },
});

const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const count = (source: string, pattern: RegExp) => (source.match(pattern) ?? []).length;

function productionSources(): string[] {
  return globSync('**/*.{js,ts,mjs}', { cwd: SERVER_ROOT })
    .filter((file) => !/(^|\/)(node_modules|dist|__tests__|tests)\//.test(file))
    .filter((file) => !/\.test\.(js|ts|mjs)$/.test(file))
    .sort();
}

test('every jwt.verify outside the allowlist is paired with tokenSessionCurrent', () => {
  const offenders: string[] = [];
  for (const file of productionSources()) {
    const code = stripComments(readFileSync(path.join(SERVER_ROOT, file), 'utf8'));
    const verifies = count(code, /\bjwt\.verify\s*\(/g);
    if (verifies === 0) continue;
    // Three arguments: the raw token must reach the check (T-2035 H1), so a
    // pre-release token is judged under its derived device session.
    const epochChecks = count(code, /\btokenSessionCurrent\s*\(\s*[^,()]+,\s*[^,()]+,\s*[^,()]+/g);
    const exempt = EXEMPT_VERIFIES[file]?.count ?? 0;
    if (verifies - exempt > epochChecks) {
      offenders.push(`${file}: ${verifies} jwt.verify, ${exempt} exempt, ${epochChecks} tokenSessionCurrent`);
    }
  }
  assert.deepEqual(offenders, [], 'add a tokenSessionCurrent check (or a reviewed allowlist entry)');
});

test('no server file imports a named verify from jsonwebtoken (would bypass the scan)', () => {
  const offenders = productionSources().filter((file) => {
    const code = stripComments(readFileSync(path.join(SERVER_ROOT, file), 'utf8'));
    return /import\s*\{[^}]*\bverify\b[^}]*\}\s*from\s*['"]jsonwebtoken['"]/.test(code)
      || /import\s+(?!jwt\b)\w+\s+from\s*['"]jsonwebtoken['"]/.test(code);
  });
  assert.deepEqual(offenders, []);
});

test('allowlist entries still exist (a stale exemption is removed, not kept)', () => {
  for (const [file, entry] of Object.entries(EXEMPT_VERIFIES)) {
    const code = stripComments(readFileSync(path.join(SERVER_ROOT, file), 'utf8'));
    assert.ok(count(code, /\bjwt\.verify\s*\(/g) >= entry.count, `${file}: ${entry.reason}`);
  }
});

test('tokenEpochCurrent: missing claim is epoch 0, mismatches and junk are refused', () => {
  assert.equal(tokenEpochCurrent({}, { token_epoch: 0 }), true);
  assert.equal(tokenEpochCurrent({}, {}), true, 'pre-migration row');
  assert.equal(tokenEpochCurrent({}, { token_epoch: 1 }), false);
  assert.equal(tokenEpochCurrent({ tok_ep: 3 }, { token_epoch: 3 }), true);
  assert.equal(tokenEpochCurrent({ tok_ep: 0 }, { token_epoch: 3 }), false);
  assert.equal(tokenEpochCurrent({ tok_ep: '3' }, { token_epoch: 3 }), false);
  assert.equal(tokenEpochCurrent({ tok_ep: null }, { token_epoch: 0 }), false);
  assert.equal(tokenEpochCurrent(null, { token_epoch: 0 }), false);
});
