/**
 * security-posture.test.ts — T-1085 deployment posture resolver.
 *
 * The invariant under test is asymmetric ON PURPOSE: env may ESCALATE a
 * single-user node to shared, but nothing may DOWNGRADE a genuinely shared node
 * to single-user. That asymmetry is what keeps the 2026-07-14 "no disable flag"
 * committee decision intact while letting an ordinary install boot.
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/services/isolation/security-posture.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SECURITY_POSTURE_ENV, resolveSecurityPosture } from './security-posture.js';

/** Single-user baseline: no env override, no platform mode, one account. */
function base(overrides: Record<string, unknown> = {}) {
  return {
    env: {} as NodeJS.ProcessEnv,
    isPlatform: false,
    activeUserCount: () => 1,
    ...overrides,
  };
}

describe('resolveSecurityPosture — single-user', () => {
  it('one active account on a non-platform node is single-user', () => {
    const res = resolveSecurityPosture(base());
    assert.equal(res.posture, 'single-user');
    assert.equal(res.shared, false);
  });

  it('a fresh install with ZERO accounts is still single-user (nobody to protect yet)', () => {
    const res = resolveSecurityPosture(base({ activeUserCount: () => 0 }));
    assert.equal(res.shared, false);
  });
});

describe('resolveSecurityPosture — shared', () => {
  it('more than one active account is shared', () => {
    const res = resolveSecurityPosture(base({ activeUserCount: () => 2 }));
    assert.equal(res.posture, 'shared');
    assert.match(res.reason, /2 active accounts/);
  });

  it('platform mode is shared regardless of the account count', () => {
    const res = resolveSecurityPosture(base({ isPlatform: true }));
    assert.equal(res.shared, true);
    assert.match(res.reason, /platform mode/i);
  });

  it(`${SECURITY_POSTURE_ENV}=strict escalates a single-user node`, () => {
    const res = resolveSecurityPosture(
      base({ env: { [SECURITY_POSTURE_ENV]: 'strict' } as NodeJS.ProcessEnv }),
    );
    assert.equal(res.shared, true);
    assert.match(res.reason, /operator-declared/);
  });

  it('accepts the "shared" spelling and is case/whitespace tolerant', () => {
    const res = resolveSecurityPosture(
      base({ env: { [SECURITY_POSTURE_ENV]: '  SHARED ' } as NodeJS.ProcessEnv }),
    );
    assert.equal(res.shared, true);
  });
});

describe('resolveSecurityPosture — no env value can DOWNGRADE a shared node', () => {
  // This is the whole safety argument for narrowing the docker guard's scope.
  for (const value of ['permissive', 'single-user', 'off', 'false', '0', 'none', 'disabled']) {
    it(`${SECURITY_POSTURE_ENV}=${value} does NOT make a 3-account host single-user`, () => {
      const res = resolveSecurityPosture(
        base({
          env: { [SECURITY_POSTURE_ENV]: value } as NodeJS.ProcessEnv,
          activeUserCount: () => 3,
        }),
      );
      assert.equal(res.shared, true, 'a shared host must stay shared whatever the env says');
    });
  }

  it(`${SECURITY_POSTURE_ENV}=permissive does not disable platform-mode strictness either`, () => {
    const res = resolveSecurityPosture(
      base({ env: { [SECURITY_POSTURE_ENV]: 'permissive' } as NodeJS.ProcessEnv, isPlatform: true }),
    );
    assert.equal(res.shared, true);
  });
});

describe('resolveSecurityPosture — unreadable state fails toward shared', () => {
  it('a throwing user count is treated as shared, not as single-user', () => {
    const res = resolveSecurityPosture(
      base({
        activeUserCount: () => {
          throw new Error('database is locked');
        },
      }),
    );
    assert.equal(res.shared, true);
    assert.match(res.reason, /database is locked/);
  });

  it('a non-numeric user count is treated as shared', () => {
    const res = resolveSecurityPosture(base({ activeUserCount: () => undefined as unknown as number }));
    assert.equal(res.shared, true);
  });

  it('a missing env object does not crash the resolver', () => {
    const res = resolveSecurityPosture(base({ env: undefined }));
    assert.equal(res.shared, false);
  });
});
