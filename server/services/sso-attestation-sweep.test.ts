/**
 * T-1939 slice 3 — the periodic sweep that closes live access of linked
 * members past the SSO attestation window (database module mocked; the SQL
 * that selects stale linked non-owners is covered in user-identities.db.test).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

type StaleRow = { userId: number; latestAttestedAt: number | null };
let staleRows: StaleRow[] = [];
const queries: Array<{ cutoffMs: number; afterUserId: number; limit: number }> = [];
const audits: Array<{ event: string; payload: Record<string, unknown> }> = [];
let queryFailure: Error | null = null;

mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userIdentitiesDb: {
      listStaleLinkedNonOwners: (cutoffMs: number, afterUserId: number, limit: number) => {
        queries.push({ cutoffMs, afterUserId, limit });
        if (queryFailure) throw queryFailure;
        return staleRows.filter((row) => row.userId > afterUserId).slice(0, limit);
      },
    },
    auditLogDb: {
      record: (event: string, payload: Record<string, unknown>) => audits.push({ event, payload }),
    },
  },
});
mock.module(url('../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: { revokeUserIdentity: () => { throw new Error('default revoke must not run'); } },
});

const {
  runSsoAttestationSweep, resetSsoAttestationSweepState, startSsoAttestationSweep, stopSsoAttestationSweep,
} = await import('./sso-attestation-sweep.js');
const { SSO_ATTESTATION_EXPIRED_REVOCATION } = await import(
  '../modules/account-wallet/user-realtime-revocation.js'
);

const KEYS = ['OIDC_ENABLED', 'OIDC_ROLE_PROJECT_ID', 'OIDC_ATTESTATION_MAX_AGE_HOURS'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
after(() => {
  stopSsoAttestationSweep();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
beforeEach(() => {
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ROLE_PROJECT_ID = 'proj-synth';
  delete process.env.OIDC_ATTESTATION_MAX_AGE_HOURS;
  staleRows = [];
  queries.length = 0;
  audits.length = 0;
  queryFailure = null;
  resetSsoAttestationSweepState();
});

function recorder(closedSockets = 1) {
  const calls: Array<{ userId: number; revocation: unknown }> = [];
  const revoke = (userId: number, revocation: unknown) => {
    calls.push({ userId, revocation });
    return { abortedRuns: 0, closedSockets, endedInteractiveSessions: 0 };
  };
  return { calls, revoke };
}

test('revokes each stale linked member with the expiry policy, cutoff = now - window', () => {
  staleRows = [{ userId: 3, latestAttestedAt: NOW - 13 * HOUR_MS }, { userId: 9, latestAttestedAt: null }];
  const { calls, revoke } = recorder();
  assert.equal(runSsoAttestationSweep({ nowMs: NOW, revoke }), 2);
  assert.deepEqual(calls.map((call) => call.userId), [3, 9]);
  assert.equal(calls[0].revocation, SSO_ATTESTATION_EXPIRED_REVOCATION);
  assert.equal(queries[0].cutoffMs, NOW - 12 * HOUR_MS);
  assert.deepEqual(audits.map((audit) => audit.event), ['sso_attestation_expired', 'sso_attestation_expired']);
  assert.deepEqual(audits[0].payload, { userId: 3, metadata: { closedSockets: 1, endedInteractiveSessions: 0 } });
});

test('expiry policy leaves running turns alone but ends shells and terminals', () => {
  assert.deepEqual(SSO_ATTESTATION_EXPIRED_REVOCATION, { abortReason: null, endInteractiveSessions: true });
});

test('a member already revoked for the same attestation is not revoked again', () => {
  staleRows = [{ userId: 3, latestAttestedAt: NOW - 13 * HOUR_MS }];
  const { calls, revoke } = recorder();
  runSsoAttestationSweep({ nowMs: NOW, revoke });
  runSsoAttestationSweep({ nowMs: NOW + 5 * 60_000, revoke });
  assert.equal(calls.length, 1);
  staleRows = [{ userId: 3, latestAttestedAt: NOW - 1000 }];
  runSsoAttestationSweep({ nowMs: NOW + 13 * HOUR_MS, revoke });
  assert.equal(calls.length, 2, 'a newer attestation that aged out again is revoked again');
});

test('nothing open → revoked but not audited', () => {
  staleRows = [{ userId: 4, latestAttestedAt: null }];
  const { calls, revoke } = recorder(0);
  runSsoAttestationSweep({ nowMs: NOW, revoke });
  assert.equal(calls.length, 1);
  assert.equal(audits.length, 0);
});

test('bounded: at most maxRevocations per tick; the rest follow on the next tick', () => {
  staleRows = Array.from({ length: 7 }, (_, index) => ({ userId: index + 1, latestAttestedAt: null }));
  const { calls, revoke } = recorder();
  assert.equal(runSsoAttestationSweep({ nowMs: NOW, revoke, maxRevocations: 5 }), 5);
  assert.equal(runSsoAttestationSweep({ nowMs: NOW, revoke, maxRevocations: 5 }), 2);
  assert.deepEqual(calls.map((call) => call.userId), [1, 2, 3, 4, 5, 6, 7]);
});

test('pages through more than one query page', () => {
  staleRows = Array.from({ length: 450 }, (_, index) => ({ userId: index + 1, latestAttestedAt: null }));
  const { calls, revoke } = recorder(0);
  assert.equal(runSsoAttestationSweep({ nowMs: NOW, revoke, maxRevocations: 1000 }), 450);
  assert.equal(calls.length, 450);
  assert.deepEqual(queries.map((query) => query.afterUserId), [0, 200, 400]);
});

test('errors are logged, never thrown; a failed revocation is retried next tick', (t) => {
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  staleRows = [{ userId: 3, latestAttestedAt: null }];
  let fail = true;
  const calls: number[] = [];
  const revoke = (userId: number) => {
    calls.push(userId);
    if (fail) throw new Error('boom');
    return { abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 };
  };
  assert.equal(runSsoAttestationSweep({ nowMs: NOW, revoke }), 0);
  fail = false;
  assert.equal(runSsoAttestationSweep({ nowMs: NOW, revoke }), 1);
  assert.deepEqual(calls, [3, 3]);
  queryFailure = new Error('db down');
  assert.doesNotThrow(() => runSsoAttestationSweep({ nowMs: NOW, revoke }));
  const logged = stderr.mock.calls.map((call) => String(call.arguments[0]));
  assert.ok(logged.some((line) => line.includes('revocation_failed')));
  assert.ok(logged.some((line) => line.includes('sweep_failed')));
});

test('OIDC disabled: no query and no revocation', () => {
  process.env.OIDC_ENABLED = 'false';
  staleRows = [{ userId: 3, latestAttestedAt: null }];
  const { calls, revoke } = recorder();
  assert.equal(runSsoAttestationSweep({ nowMs: NOW, revoke }), 0);
  assert.equal(queries.length, 0);
  assert.equal(calls.length, 0);
});

test('timer is unref\'d, idempotent and stoppable', (t) => {
  const handles: Array<{ unref: () => void; unrefCalled: boolean }> = [];
  const setIntervalMock = t.mock.method(globalThis, 'setInterval', () => {
    const handle = { unrefCalled: false, unref() { this.unrefCalled = true; } };
    handles.push(handle);
    return handle;
  });
  const clearIntervalMock = t.mock.method(globalThis, 'clearInterval', () => {});
  const stop = startSsoAttestationSweep({ intervalMs: 1000 });
  startSsoAttestationSweep({ intervalMs: 1000 });
  assert.equal(setIntervalMock.mock.callCount(), 1);
  assert.equal(handles[0].unrefCalled, true);
  stop();
  assert.equal(clearIntervalMock.mock.callCount(), 1);
});
