/**
 * security-posture.test.ts — T-1085 deployment posture resolver.
 *
 * The rule under test, after the 2026-07-29 correction: the strict posture is a
 * DECLARATION, not an inference. Counting accounts (the first attempt) measured
 * how many people log in, not whether they are already trusted on the host, and
 * left a two-colleague fleet node unbootable. Only two things select strict now:
 * an explicit env declaration, and platform mode — where authentication is off,
 * so no trust claim about "accounts" can be true.
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/services/isolation/security-posture.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SECURITY_POSTURE_ENV, resolveSecurityPosture } from './security-posture.js';

/** Ordinary install: no declaration, no platform mode. */
function base(overrides: Record<string, unknown> = {}) {
  return {
    env: {} as NodeJS.ProcessEnv,
    isPlatform: false,
    ...overrides,
  };
}

describe('resolveSecurityPosture — the default is trusted (an install must boot)', () => {
  it('an undeclared install is trusted', () => {
    const res = resolveSecurityPosture(base());
    assert.equal(res.posture, 'trusted');
    assert.equal(res.shared, false);
    assert.match(res.reason, new RegExp(`${SECURITY_POSTURE_ENV}=strict`), 'must name the opt-in');
  });

  it('an ABSENT env object still resolves (no crash, still trusted)', () => {
    const res = resolveSecurityPosture({ env: undefined, isPlatform: false });
    assert.equal(res.shared, false);
  });

  it('the number of accounts is IRRELEVANT — this is the 2026-07-29 regression', () => {
    // The first fix refused to boot here (2 accounts ⇒ "shared"), which is
    // exactly what left a live node dead. The resolver must not accept an
    // account count as an input at all any more.
    const res = resolveSecurityPosture(
      base({ activeUserCount: () => 12 } as unknown as Record<string, unknown>),
    );
    assert.equal(res.shared, false, 'account count must never select the strict posture');
  });

  it('an explicit "trusted" declaration is honored and named in the reason', () => {
    const res = resolveSecurityPosture(
      base({ env: { [SECURITY_POSTURE_ENV]: 'trusted' } as NodeJS.ProcessEnv }),
    );
    assert.equal(res.shared, false);
    assert.match(res.reason, /operator-declared/);
  });
});

describe('resolveSecurityPosture — strict is a declaration', () => {
  it(`${SECURITY_POSTURE_ENV}=strict selects the fail-closed posture`, () => {
    const res = resolveSecurityPosture(
      base({ env: { [SECURITY_POSTURE_ENV]: 'strict' } as NodeJS.ProcessEnv }),
    );
    assert.equal(res.posture, 'shared');
    assert.equal(res.shared, true);
  });

  it('accepts the "shared" spelling, case-insensitively and trimmed', () => {
    const res = resolveSecurityPosture(
      base({ env: { [SECURITY_POSTURE_ENV]: '  SHARED ' } as NodeJS.ProcessEnv }),
    );
    assert.equal(res.shared, true);
  });

  it('an unrecognized value does NOT silently select strict (it falls back to trusted)', () => {
    const res = resolveSecurityPosture(
      base({ env: { [SECURITY_POSTURE_ENV]: 'yes-please' } as NodeJS.ProcessEnv }),
    );
    assert.equal(res.shared, false);
  });
});

describe('resolveSecurityPosture — platform mode cannot be downgraded', () => {
  // Platform mode DISABLES authentication (every request resolves to the first
  // user, see middleware/auth.js), so "the accounts here are operators" is not a
  // claim the operator is in a position to make. Checked before the env read.

  it('platform mode alone selects strict', () => {
    const res = resolveSecurityPosture(base({ isPlatform: true }));
    assert.equal(res.shared, true);
    assert.match(res.reason, /authentication is disabled/i);
  });

  for (const value of ['trusted', 'permissive', 'off', 'false', '0', 'none']) {
    it(`${SECURITY_POSTURE_ENV}=${value} does NOT downgrade platform mode`, () => {
      const res = resolveSecurityPosture(
        base({ env: { [SECURITY_POSTURE_ENV]: value } as NodeJS.ProcessEnv, isPlatform: true }),
      );
      assert.equal(res.shared, true);
    });
  }

  it('reads VITE_IS_PLATFORM from env when isPlatform is not injected', () => {
    const res = resolveSecurityPosture({ env: { VITE_IS_PLATFORM: 'true' } as NodeJS.ProcessEnv });
    assert.equal(res.shared, true);
  });

  it('any VITE_IS_PLATFORM value other than the exact string "true" is off', () => {
    const res = resolveSecurityPosture({ env: { VITE_IS_PLATFORM: '1' } as NodeJS.ProcessEnv });
    assert.equal(res.shared, false);
  });
});
