import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  enforcePlatformIsolationGuard,
  PlatformIsolationViolationError,
} from './platform-isolation-guard.service.js';

/**
 * B-5 boot guard. The dangerous combination is: platform mode ON +
 * Claude provider 'isolated' + more than one active user. Every other
 * combination must boot cleanly (no throw).
 */
describe('enforcePlatformIsolationGuard', () => {
  const isolated = (p) => p === 'claude';
  const shared = () => false;

  it('throws when platform + claude isolated + >1 active user', () => {
    assert.throws(
      () =>
        enforcePlatformIsolationGuard({
          isPlatform: true,
          isIsolated: isolated,
          activeUserCount: () => 2,
        }),
      PlatformIsolationViolationError
    );
  });

  it('throws for many active users too', () => {
    assert.throws(
      () =>
        enforcePlatformIsolationGuard({
          isPlatform: true,
          isIsolated: isolated,
          activeUserCount: () => 9,
        }),
      PlatformIsolationViolationError
    );
  });

  it('passes when platform mode is OFF (OSS JWT path), regardless of users', () => {
    assert.doesNotThrow(() =>
      enforcePlatformIsolationGuard({
        isPlatform: false,
        isIsolated: isolated,
        activeUserCount: () => 50,
      })
    );
  });

  it("passes when claude is 'shared' (sharing is the intended policy)", () => {
    assert.doesNotThrow(() =>
      enforcePlatformIsolationGuard({
        isPlatform: true,
        isIsolated: shared,
        activeUserCount: () => 50,
      })
    );
  });

  it('passes when exactly one active user exists', () => {
    assert.doesNotThrow(() =>
      enforcePlatformIsolationGuard({
        isPlatform: true,
        isIsolated: isolated,
        activeUserCount: () => 1,
      })
    );
  });

  it('passes when zero active users exist', () => {
    assert.doesNotThrow(() =>
      enforcePlatformIsolationGuard({
        isPlatform: true,
        isIsolated: isolated,
        activeUserCount: () => 0,
      })
    );
  });

  it('only consults the active-user count for the guarded combination', () => {
    let called = 0;
    // platform OFF → must short-circuit before counting users.
    enforcePlatformIsolationGuard({
      isPlatform: false,
      isIsolated: isolated,
      activeUserCount: () => {
        called += 1;
        return 5;
      },
    });
    assert.equal(called, 0);
  });
});
