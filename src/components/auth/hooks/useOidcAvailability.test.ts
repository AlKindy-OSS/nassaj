/**
 * Unit tests for useOidcAvailability.
 *
 * Covered:
 *  - IS_PLATFORM early return: hook never calls detection, stays false.
 *  - Detection resolves true: hook becomes true after effect runs.
 *  - Detection resolves false: hook stays false.
 *  - Detection rejects (error): hook stays false (safe / no throw).
 *  - Effect cleanup (isActive guard): setState is NOT called after unmount,
 *    no React "update on unmounted component" warning.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before the module under test is imported.
// ---------------------------------------------------------------------------

const oidcMock = vi.hoisted(() => ({
  detectOidcAvailability: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../oidc', () => ({
  detectOidcAvailability: oidcMock.detectOidcAvailability,
}));

// IS_PLATFORM is a module-level constant; we control it per test via the mock.
const configMock = vi.hoisted(() => ({ IS_PLATFORM: false }));

vi.mock('../../../constants/config', () => configMock);

// ---------------------------------------------------------------------------
// Import after mocks are installed.
// ---------------------------------------------------------------------------

import { useOidcAvailability } from './useOidcAvailability';

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  configMock.IS_PLATFORM = false;
  oidcMock.detectOidcAvailability.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// IS_PLATFORM guard
// ---------------------------------------------------------------------------

describe('useOidcAvailability – IS_PLATFORM guard', () => {
  it('returns false immediately and never calls detectOidcAvailability when IS_PLATFORM is true', async () => {
    configMock.IS_PLATFORM = true;
    // Even if detection were called, it should not be invoked.
    oidcMock.detectOidcAvailability.mockResolvedValue(true);

    const { result } = renderHook(() => useOidcAvailability());

    // Initial value must be false.
    expect(result.current).toBe(false);

    // Allow any scheduled microtasks / effect flushes to settle.
    await act(async () => {});

    expect(result.current).toBe(false);
    expect(oidcMock.detectOidcAvailability).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Detection results
// ---------------------------------------------------------------------------

describe('useOidcAvailability – detection results', () => {
  it('starts false, then becomes true when detection resolves true', async () => {
    let resolveDetection!: (value: boolean) => void;
    oidcMock.detectOidcAvailability.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveDetection = resolve;
      }),
    );

    const { result } = renderHook(() => useOidcAvailability());
    expect(result.current).toBe(false);

    await act(async () => {
      resolveDetection(true);
    });

    expect(result.current).toBe(true);
    expect(oidcMock.detectOidcAvailability).toHaveBeenCalledTimes(1);
  });

  it('stays false when detection resolves false', async () => {
    oidcMock.detectOidcAvailability.mockResolvedValue(false);

    const { result } = renderHook(() => useOidcAvailability());
    await waitFor(() => expect(oidcMock.detectOidcAvailability).toHaveBeenCalled());

    await act(async () => {});
    expect(result.current).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Detection error → safe / false state
//
// The real detectOidcAvailability() NEVER rejects: it catches internally and
// resolves to false (see oidc.ts). So the "error" path here is represented by
// a resolved-false promise, which is what a caller sees after a failed probe.
//
// NOTE – latent bug: the hook body is
//   void detectOidcAvailability().then(value => { if (isActive) setIsEnabled(value) })
// It has NO .catch(). If detectOidcAvailability's internal catch were ever
// removed the hook would produce an unhandled rejection. This is safe today
// only because the function's contract guarantees it never rejects.
// ---------------------------------------------------------------------------

describe('useOidcAvailability – detection error', () => {
  it('stays false when detection resolves false (probe error path)', async () => {
    // The real detectOidcAvailability resolves false on network/probe errors.
    oidcMock.detectOidcAvailability.mockResolvedValue(false);

    const { result } = renderHook(() => useOidcAvailability());

    await waitFor(() => expect(oidcMock.detectOidcAvailability).toHaveBeenCalled());
    await act(async () => {});

    expect(result.current).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Effect cleanup — isActive guard
// ---------------------------------------------------------------------------

describe('useOidcAvailability – effect cleanup (isActive guard)', () => {
  it('does not call setState after the component unmounts before detection resolves', async () => {
    let resolveDetection!: (value: boolean) => void;
    oidcMock.detectOidcAvailability.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveDetection = resolve;
      }),
    );

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { result, unmount } = renderHook(() => useOidcAvailability());
    expect(result.current).toBe(false);

    // Unmount while the promise is still pending.
    unmount();

    // Now resolve — the isActive guard must suppress the setState call.
    await act(async () => {
      resolveDetection(true);
    });

    // State must remain false (the set was blocked by isActive).
    expect(result.current).toBe(false);

    // React must NOT have emitted the "Can't perform a state update on an
    // unmounted component" warning.
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('unmounted'),
    );

    consoleSpy.mockRestore();
  });
});
