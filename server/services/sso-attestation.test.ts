/**
 * T-1939 slice 3 — attestation window resolution and the freshness predicate
 * (database module mocked; route-level coverage lives in
 * routes/auth.sso-attestation.test.ts).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

let summary: { linkCount: number; latestAttestedAt: number | null } = { linkCount: 1, latestAttestedAt: NOW };
let user: { id: number; role: string } | undefined = { id: 5, role: 'user' };

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userIdentitiesDb: { attestationSummary: () => summary },
    userDb: { getUserById: () => user },
  },
});

const {
  resolveAttestationMaxAgeMs, ssoAttestationFresh, userSsoAttestationFresh,
} = await import('./sso-attestation.js');

const KEYS = ['OIDC_ENABLED', 'OIDC_ROLE_PROJECT_ID', 'OIDC_ATTESTATION_MAX_AGE_HOURS'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
after(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
beforeEach(() => {
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ROLE_PROJECT_ID = 'proj-synth';
  delete process.env.OIDC_ATTESTATION_MAX_AGE_HOURS;
  summary = { linkCount: 1, latestAttestedAt: NOW };
  user = { id: 5, role: 'user' };
});

test('window: default 12h; invalid input falls back; values clamp to 1..24h', () => {
  assert.equal(resolveAttestationMaxAgeMs(undefined), 12 * HOUR_MS);
  assert.equal(resolveAttestationMaxAgeMs(''), 12 * HOUR_MS);
  assert.equal(resolveAttestationMaxAgeMs('abc'), 12 * HOUR_MS);
  assert.equal(resolveAttestationMaxAgeMs('6'), 6 * HOUR_MS);
  assert.equal(resolveAttestationMaxAgeMs('0'), 1 * HOUR_MS);
  assert.equal(resolveAttestationMaxAgeMs('-5'), 1 * HOUR_MS);
  assert.equal(resolveAttestationMaxAgeMs('48'), 24 * HOUR_MS);
  assert.equal(resolveAttestationMaxAgeMs('1.5'), 1.5 * HOUR_MS);
});

test('boundary: 11:59h fresh, 12:01h stale; the env window moves the boundary', () => {
  summary.latestAttestedAt = NOW - (12 * HOUR_MS - 60_000);
  assert.equal(userSsoAttestationFresh(user, NOW), true);
  summary.latestAttestedAt = NOW - (12 * HOUR_MS + 60_000);
  assert.equal(userSsoAttestationFresh(user, NOW), false);
  process.env.OIDC_ATTESTATION_MAX_AGE_HOURS = '100';
  assert.equal(userSsoAttestationFresh(user, NOW), true, 'clamped to 24h');
  process.env.OIDC_ATTESTATION_MAX_AGE_HOURS = '0';
  summary.latestAttestedAt = NOW - (HOUR_MS + 60_000);
  assert.equal(userSsoAttestationFresh(user, NOW), false, 'clamped to 1h');
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

test('OIDC disabled: everyone is fresh', () => {
  process.env.OIDC_ENABLED = 'false';
  summary = { linkCount: 1, latestAttestedAt: null };
  assert.equal(userSsoAttestationFresh(user, NOW), true);
  assert.equal(ssoAttestationFresh(5, NOW), true);
});

test('id form mirrors the user form', () => {
  summary.latestAttestedAt = NOW - 13 * HOUR_MS;
  assert.equal(ssoAttestationFresh(5, NOW), false);
  summary.latestAttestedAt = NOW - HOUR_MS;
  assert.equal(ssoAttestationFresh(5, NOW), true);
});
