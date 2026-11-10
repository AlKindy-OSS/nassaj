import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  enforcePlatformIsolationGuard,
  PlatformIsolationViolationError,
} from './platform-isolation-guard.service.js';

/**
 * B-5 boot guard, ADR-152 amendment 1 §3.6. Platform mode collapses every
 * session onto the first active user, which is credential sharing for every
 * provider. With more than one active user it refuses to boot; there is no
 * "shared" policy that makes the combination acceptable.
 */
describe('enforcePlatformIsolationGuard', () => {
  it('throws when platform + >1 active user', () => {
    assert.throws(
      () => enforcePlatformIsolationGuard({ isPlatform: true, activeUserCount: () => 2 }),
      PlatformIsolationViolationError,
    );
  });

  it('throws for many active users too', () => {
    assert.throws(
      () => enforcePlatformIsolationGuard({ isPlatform: true, activeUserCount: () => 9 }),
      PlatformIsolationViolationError,
    );
  });

  it('cannot be bypassed by an injected or stored sharing policy (no isIsolated seam)', () => {
    assert.throws(
      () => enforcePlatformIsolationGuard({ isPlatform: true, isIsolated: () => false, activeUserCount: () => 50 }),
      PlatformIsolationViolationError,
    );
  });

  it('lists only the remedies that keep credentials apart (no "set shared" advice)', () => {
    assert.throws(
      () => enforcePlatformIsolationGuard({ isPlatform: true, activeUserCount: () => 3 }),
      (error) => {
        assert.ok(error instanceof PlatformIsolationViolationError);
        assert.doesNotMatch(error.message, /'shared'|sharing policy/i);
        assert.match(error.message, /disable platform mode/i);
        assert.match(error.message, /reduce active users to at most one/i);
        return true;
      },
    );
  });

  it('passes when platform mode is OFF (OSS JWT path), regardless of users', () => {
    assert.doesNotThrow(() => enforcePlatformIsolationGuard({ isPlatform: false, activeUserCount: () => 50 }));
  });

  it('passes when exactly one active user exists', () => {
    assert.doesNotThrow(() => enforcePlatformIsolationGuard({ isPlatform: true, activeUserCount: () => 1 }));
  });

  it('passes when zero active users exist', () => {
    assert.doesNotThrow(() => enforcePlatformIsolationGuard({ isPlatform: true, activeUserCount: () => 0 }));
  });

  it('only consults the active-user count in platform mode', () => {
    let called = 0;
    enforcePlatformIsolationGuard({
      isPlatform: false,
      activeUserCount: () => {
        called += 1;
        return 5;
      },
    });
    assert.equal(called, 0);
  });
});
