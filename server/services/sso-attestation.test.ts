/**
 * T-1939 slice 3 / ADR-194 D1 — the freshness predicate over the SSO state
 * (database module and state model mocked; the state model itself is covered
 * by sso-config.service.test.ts, route-level coverage lives in
 * routes/auth.sso-attestation.test.ts).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import { createSsoConfigDouble } from './__tests__/sso-config-double.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let summary: { linkCount: number; latestAttestedAt: number | null } = { linkCount: 1, latestAttestedAt: NOW };
let user: { id: number; role: string } | undefined = { id: 5, role: 'user' };
const sso = createSsoConfigDouble();

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userIdentitiesDb: { attestationSummary: () => summary },
    userDb: { getUserById: () => user },
  },
});
mock.module(url('./sso-config.service.js'), { namedExports: sso.exports });

const {
  resolveLegacyAttestationHours, ssoAttestationFresh, userSsoAttestationFresh,
} = await import('./sso-attestation.js');

beforeEach(() => {
  sso.setActive(true);
  sso.state.maxAgeHours = 12;
  summary = { linkCount: 1, latestAttestedAt: NOW };
  user = { id: 5, role: 'user' };
});

test('legacy env hours: default 12; invalid input falls back; whole hours clamped to 1..24', () => {
  assert.equal(resolveLegacyAttestationHours(undefined), 12);
  assert.equal(resolveLegacyAttestationHours(''), 12);
  assert.equal(resolveLegacyAttestationHours('abc'), 12);
  assert.equal(resolveLegacyAttestationHours('6'), 6);
  assert.equal(resolveLegacyAttestationHours('0'), 1);
  assert.equal(resolveLegacyAttestationHours('-5'), 1);
  assert.equal(resolveLegacyAttestationHours('48'), 24);
  assert.equal(resolveLegacyAttestationHours('1.5'), 1);
});

test('boundary: 11:59h fresh, 12:01h stale; the active row window moves the boundary', () => {
  summary.latestAttestedAt = NOW - (12 * HOUR_MS - 60_000);
  assert.equal(userSsoAttestationFresh(user, NOW), true);
  summary.latestAttestedAt = NOW - (12 * HOUR_MS + 60_000);
  assert.equal(userSsoAttestationFresh(user, NOW), false);
  sso.state.maxAgeHours = 24;
  assert.equal(userSsoAttestationFresh(user, NOW), true, '24h window');
  sso.state.maxAgeHours = 1;
  summary.latestAttestedAt = NOW - (HOUR_MS + 60_000);
  assert.equal(userSsoAttestationFresh(user, NOW), false, '1h window');
});

test('a linked member never stamped is stale', () => {
  summary.latestAttestedAt = null;
  assert.equal(userSsoAttestationFresh(user, NOW), false);
});

test('owner, non-linked and missing users are always fresh', () => {
  summary = { linkCount: 1, latestAttestedAt: null };
  assert.equal(userSsoAttestationFresh({ id: 1, role: 'owner' }, NOW), true);
  assert.equal(userSsoAttestationFresh(null, NOW), true);
  summary = { linkCount: 0, latestAttestedAt: null };
  assert.equal(userSsoAttestationFresh(user, NOW), true);
  user = undefined;
  assert.equal(ssoAttestationFresh(5, NOW), true);
});

test('policy not enforced: everyone is fresh', () => {
  sso.setActive(false);
  summary = { linkCount: 1, latestAttestedAt: null };
  assert.equal(userSsoAttestationFresh(user, NOW), true);
  assert.equal(ssoAttestationFresh(5, NOW), true);
});

test('enforced but login unavailable: a freshly attested linked member is stale (D1)', () => {
  sso.state.loginAvailable = false;
  summary.latestAttestedAt = NOW;
  assert.equal(userSsoAttestationFresh(user, NOW), false);
  assert.equal(ssoAttestationFresh(5, NOW), false);
  assert.equal(userSsoAttestationFresh({ id: 1, role: 'owner' }, NOW), true, 'the owner is never governed');
  summary = { linkCount: 0, latestAttestedAt: null };
  assert.equal(userSsoAttestationFresh(user, NOW), true, 'an unlinked member is not governed');
});

test('id form mirrors the user form', () => {
  summary.latestAttestedAt = NOW - 13 * HOUR_MS;
  assert.equal(ssoAttestationFresh(5, NOW), false);
  summary.latestAttestedAt = NOW - HOUR_MS;
  assert.equal(ssoAttestationFresh(5, NOW), true);
});
