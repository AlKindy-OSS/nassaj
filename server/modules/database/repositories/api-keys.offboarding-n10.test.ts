/**
 * ADR-H20 N10 (V8): the identity provider sends no back-channel notice when a
 * member is deactivated, deleted or loses a role, so member offboarding relies
 * on the attestation. This proves what actually stops a linked member's API keys:
 *
 *   - the T-1939 session attestation (12 h) does NOT stop API keys by itself;
 *   - the T-1946 API-key window (days since the last SSO sign-in, default 7,
 *     owner-settable down to 1) does: past it the key is refused;
 *   - an owner unlink deletes the keys at once (existing T-1946 tests).
 *
 * Real repository SQL on the isolated test database; no mocks.
 */
import assert from 'node:assert/strict';
import test, { before } from 'node:test';

import { getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { writeDisabledRecordOn } from '@/modules/database/repositories/sso-oidc-config.js';
import { API_KEY_SSO_WINDOW_DEFAULT_DAYS, apiKeySsoWindowDb } from '@/modules/database/repositories/api-key-sso-window.js';
import { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import { userDb } from '@/modules/database/repositories/users.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
let sequence = 0;

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  await initializeDatabase();
  stopReconcileScheduler();
  // The plain T-1946 window (SSO owner-disabled), as in api-keys.sso-window.test.ts.
  writeDisabledRecordOn(getConnection(), 'owner', Date.now());
});

/**
 * A linked member whose last SSO sign-in was `ageMs` before NOW, with one API
 * key. Only owner/admin accounts hold API keys (B-464), so the member is an admin.
 */
function memberLastSignedIn(ageMs: number) {
  const user = userDb.createUser(`n10_member_${++sequence}`, 'hash', 'admin');
  const linkId = userIdentitiesDb.link(user.id, 'https://idp.example', `sub-n10-${sequence}`);
  userIdentitiesDb.markAttested(linkId, user.id, NOW - ageMs);
  return apiKeysDb.createApiKey(user.id, 'automation').apiKey;
}

const resolves = (apiKey: string) => apiKeysDb.resolveApiKey(apiKey, NOW);

test('N10: the 12 h session attestation alone does not stop a member\'s API key', () => {
  apiKeySsoWindowDb.setDays(API_KEY_SSO_WINDOW_DEFAULT_DAYS);
  const key = memberLastSignedIn(13 * HOUR_MS);
  assert.equal(resolves(key).ok, true, 'a deactivated member keeps a working key until the key window ends');
});

test('N10: the API-key window stops it — default 7 days, 1 day at the owner minimum', () => {
  apiKeySsoWindowDb.setDays(API_KEY_SSO_WINDOW_DEFAULT_DAYS);
  const inside = memberLastSignedIn(7 * DAY_MS);
  const past = memberLastSignedIn(7 * DAY_MS + 1);
  assert.equal(resolves(inside).ok, true);
  const refused = resolves(past);
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.reason, 'sso_attestation_expired');

  apiKeySsoWindowDb.setDays(1);
  try {
    const day = memberLastSignedIn(DAY_MS + 1);
    assert.equal(resolves(day).ok, false, 'with the window at 1 day, offboarding takes at most 24 h');
  } finally {
    apiKeySsoWindowDb.setDays(API_KEY_SSO_WINDOW_DEFAULT_DAYS);
  }
});
