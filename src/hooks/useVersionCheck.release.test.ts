import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

vi.mock('../utils/api', () => ({ authenticatedFetch }));

import {
  isSourceAheadOfRuntime,
  isUpdatePrepared,
  resolveDegraded,
  resolvePreparedSignals,
  resolveRestartRequired,
  resolveRunningVersion,
  useVersionCheck,
} from './useVersionCheck';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  authenticatedFetch.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => response(200, {
    sourceVersion: '1.44.0.1',
    installMode: 'git',
    restartRequired: false,
    hasPendingActions: false,
  })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('private release update indicator', () => {
  it('discovers releases only through the authenticated server endpoint', async () => {
    authenticatedFetch.mockResolvedValue(response(200, {
      success: true,
      version: '99.0.0.0',
      tagName: 'v99.0.0.0',
      title: 'Private release',
      notes: 'Private release notes',
      publishedAt: '2026-08-17T00:00:00Z',
    }));

    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.updateAvailable).toBe(true));
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/system/release/latest');
    expect(fetch).toHaveBeenCalledWith('/health', { cache: 'no-store' });
    expect(hook.result.current.currentVersion).toBe('1.44.0.1');
    expect(hook.result.current.latestVersion).toBe('99.0.0.0');
    expect(hook.result.current.releaseInfo).toEqual({
      title: 'Private release',
      body: 'Private release notes',
      htmlUrl: '',
      publishedAt: '2026-08-17T00:00:00Z',
    });
  });

  it('retains the last confirmed source version across a transient health failure', async () => {
    vi.useFakeTimers();
    const healthFetch = vi.fn()
      .mockResolvedValueOnce(response(200, {
        sourceVersion: '1.44.0.1',
        installMode: 'git',
        restartRequired: false,
        hasPendingActions: false,
      }))
      .mockRejectedValue(new Error('temporary network failure'));
    vi.stubGlobal('fetch', healthFetch);
    authenticatedFetch.mockResolvedValue(response(503, { success: false }));

    const hook = renderHook(() => useVersionCheck());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.currentVersion).toBe('1.44.0.1');

    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 1000); });
    expect(healthFetch).toHaveBeenCalledTimes(2);
    expect(hook.result.current.currentVersion).toBe('1.44.0.1');
    hook.unmount();
  });

  it('fails closed for bulk lifecycle actions after an unhealthy health response', async () => {
    vi.useFakeTimers();
    const healthFetch = vi.fn()
      .mockResolvedValueOnce(response(200, {
        sourceVersion: '1.44.0.1',
        installMode: 'git',
        restartRequired: false,
        hasPendingActions: false,
        bulkLifecycleActions: true,
      }))
      .mockResolvedValueOnce(response(503, { bulkLifecycleActions: true }));
    vi.stubGlobal('fetch', healthFetch);
    authenticatedFetch.mockResolvedValue(response(503, { success: false }));

    const hook = renderHook(() => useVersionCheck());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.bulkLifecycleActions).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 1000); });
    expect(hook.result.current.bulkLifecycleActions).toBe(false);
    hook.unmount();
  });

  it('uses the live server source version and never falls back to a bundled version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      sourceVersion: null,
      installMode: 'git',
      restartRequired: false,
      hasPendingActions: false,
    })));
    authenticatedFetch.mockResolvedValue(response(200, {
      success: true,
      version: '99.0.0.0',
    }));

    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.latestVersion).toBe('99.0.0.0'));
    expect(hook.result.current.currentVersion).toBe('—');
    expect(hook.result.current.updateAvailable).toBe(false);
  });

  it('clears stale release state when the server later returns 503', async () => {
    vi.useFakeTimers();
    authenticatedFetch
      .mockResolvedValueOnce(response(200, {
        success: true,
        version: '99.0.0.0',
        tagName: 'v99.0.0.0',
        title: 'Private release',
        notes: '',
        htmlUrl: '',
        publishedAt: '',
      }))
      .mockResolvedValue(response(503, { success: false }));

    const hook = renderHook(() => useVersionCheck());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.updateAvailable).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(hook.result.current.updateAvailable).toBe(false);
    expect(hook.result.current.latestVersion).toBeNull();
    expect(hook.result.current.releaseInfo).toBeNull();

    hook.unmount();
  });

  it('retains the current release state on a conditional 304', async () => {
    vi.useFakeTimers();
    authenticatedFetch
      .mockResolvedValueOnce(response(200, {
        success: true,
        version: '99.0.0.0',
        tagName: 'v99.0.0.0',
        title: 'Private release',
        notes: '',
        publishedAt: '',
      }))
      .mockResolvedValue(response(304, null));

    const hook = renderHook(() => useVersionCheck());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.updateAvailable).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });
    expect(hook.result.current.updateAvailable).toBe(true);
    expect(hook.result.current.latestVersion).toBe('99.0.0.0');
    hook.unmount();
  });

  it('exposes a failed check and HTTP status instead of looking up to date', async () => {
    authenticatedFetch.mockResolvedValue(response(503, { success: false }));
    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.checkStatus).toBe('error'));
    expect(hook.result.current.checkHttpStatus).toBe(503);
    expect(hook.result.current.lastCheckedAt).not.toBeNull();
    expect(hook.result.current.updateAvailable).toBe(false);
    hook.unmount();
  });

  it('distinguishes a missing release from a transport failure', async () => {
    authenticatedFetch.mockResolvedValue(response(404, { success: false, code: 'release_not_found' }));
    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.checkStatus).toBe('unavailable'));
    expect(hook.result.current.checkHttpStatus).toBe(404);
    hook.unmount();
  });

  it('recheck replaces a visible failure with the new successful result', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(response(503, { success: false }))
      .mockResolvedValueOnce(response(200, { success: true, version: '99.0.0.0' }));
    const hook = renderHook(() => useVersionCheck());
    await waitFor(() => expect(hook.result.current.checkStatus).toBe('error'));

    await act(async () => { await hook.result.current.recheck(); });
    expect(hook.result.current.checkStatus).toBe('ok');
    expect(hook.result.current.latestVersion).toBe('99.0.0.0');
    hook.unmount();
  });

  it('ignores an older successful response that arrives after a newer success', async () => {
    const older = deferredResponse();
    authenticatedFetch
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(response(200, { success: true, version: '99.0.0.0' }));
    const hook = renderHook(() => useVersionCheck());
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));

    await act(async () => { await hook.result.current.recheck(); });
    expect(hook.result.current.latestVersion).toBe('99.0.0.0');

    await act(async () => {
      older.resolve(response(200, { success: true, version: '2.3.0.5' }));
      await older.promise;
    });
    expect(hook.result.current.latestVersion).toBe('99.0.0.0');
    expect(hook.result.current.checkStatus).toBe('ok');
    hook.unmount();
  });

  it('ignores an older success after the newer retry established failure', async () => {
    const older = deferredResponse();
    authenticatedFetch
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(response(503, { success: false }));
    const hook = renderHook(() => useVersionCheck());
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));

    await act(async () => { await hook.result.current.recheck(); });
    expect(hook.result.current.checkStatus).toBe('error');
    expect(hook.result.current.latestVersion).toBeNull();

    await act(async () => {
      older.resolve(response(200, { success: true, version: '99.0.0.0' }));
      await older.promise;
    });
    expect(hook.result.current.checkStatus).toBe('error');
    expect(hook.result.current.latestVersion).toBeNull();
    hook.unmount();
  });
});

// ── B-1055 / ADR-156 WI-5: prepared, awaiting activation ────────────────────

const LOADED = 'a'.repeat(64);
const PROMOTED = 'b'.repeat(64);
const CANDIDATE = 'c'.repeat(64);

function health(overrides: Record<string, unknown> = {}) {
  return {
    sourceVersion: '1.47.0.10',
    installMode: 'git',
    restartRequired: false,
    hasPendingActions: false,
    serverLoadedBuildId: LOADED,
    serverBuildIdOnDisk: LOADED,
    serverPromotedBuildId: LOADED,
    serverCandidateBuildId: null,
    ...overrides,
  };
}

describe('resolvePreparedSignals / isUpdatePrepared', () => {
  const prepared = (data: Record<string, unknown>, queued: (string | null)[] = []) =>
    isUpdatePrepared(resolvePreparedSignals(data), queued);

  it('is true for a promoted build this process did not load', () => {
    expect(prepared({
      serverLoadedBuildId: LOADED, serverBuildIdOnDisk: PROMOTED, serverPromotedBuildId: PROMOTED,
    })).toBe(true);
  });

  it('is false when the loaded build IS the promoted one', () => {
    expect(prepared({
      serverLoadedBuildId: LOADED, serverBuildIdOnDisk: LOADED, serverPromotedBuildId: LOADED,
    })).toBe(false);
  });

  it('م-6: the promoted branch uses the same test as resolveRestartRequired', () => {
    // A server naming a promoted build that is NOT the one on disk is
    // inconsistent — mid-promotion or mid-rollback. Neither signal may fire.
    const inconsistent = {
      serverLoadedBuildId: LOADED, serverBuildIdOnDisk: PROMOTED, serverPromotedBuildId: CANDIDATE,
    };
    expect(prepared(inconsistent)).toBe(false);
    expect(resolveRestartRequired({ ...inconsistent, restartRequired: true })).toBe(false);
    // An invalid on-disk identity is no evidence either.
    expect(prepared({ serverLoadedBuildId: LOADED, serverBuildIdOnDisk: 'nope' })).toBe(false);
  });

  it('B-1334: a retained candidate alone never lights the state', () => {
    expect(prepared({
      serverLoadedBuildId: LOADED, serverBuildIdOnDisk: LOADED, serverCandidateBuildId: CANDIDATE,
    })).toBe(false);
  });

  it('م-6: a queued action for ANOTHER build does not stand in for the candidate', () => {
    const health = {
      serverLoadedBuildId: LOADED, serverBuildIdOnDisk: LOADED, serverCandidateBuildId: CANDIDATE,
    };
    expect(prepared(health, [PROMOTED])).toBe(false);
    expect(prepared(health, [null])).toBe(false);
    expect(prepared(health, [])).toBe(false);
  });

  it('is true for a sealed candidate whose OWN safe-restart row is queued', () => {
    expect(prepared({
      serverLoadedBuildId: LOADED, serverBuildIdOnDisk: LOADED, serverCandidateBuildId: CANDIDATE,
    }, [PROMOTED, CANDIDATE])).toBe(true);
  });

  it('fails closed on a server that reports no loaded build identity', () => {
    expect(prepared({ serverBuildIdOnDisk: PROMOTED }, [CANDIDATE])).toBe(false);
    expect(prepared({ serverLoadedBuildId: 'not-a-build-id', serverBuildIdOnDisk: PROMOTED })).toBe(false);
  });
});

describe('B-1055 the update entry point survives a staged release', () => {
  it('stays available when the source version already matches but the build is not active', async () => {
    // Exactly the 1.47.0.9 shape: `git checkout` moved package.json to the
    // target version, so the comparison is zero, while dist-server on disk is
    // a build this process never loaded. The button used to vanish here.
    vi.stubGlobal('fetch', vi.fn(async () => response(200, health({
      restartRequired: true, serverBuildIdOnDisk: PROMOTED, serverPromotedBuildId: PROMOTED,
    }))));
    authenticatedFetch.mockResolvedValue(response(200, { success: true, version: '1.47.0.10' }));

    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.updatePrepared).toBe(true));
    expect(hook.result.current.updateAvailable).toBe(true);
    expect(hook.result.current.newerReleaseOffered).toBe(false);
    expect(hook.result.current.restartRequired).toBe(true);
    hook.unmount();
  });

  it('reports prepared even when the server ledger claims no restart is required', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, health({
      restartRequired: false, serverBuildIdOnDisk: PROMOTED, serverPromotedBuildId: PROMOTED,
    }))));
    authenticatedFetch.mockResolvedValue(response(200, { success: true, version: '1.47.0.10' }));

    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.updatePrepared).toBe(true));
    expect(hook.result.current.updateAvailable).toBe(true);
    expect(hook.result.current.restartRequired).toBe(false);
    hook.unmount();
  });

  it('stays quiet after a rollback that retained its candidate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, health({
      serverCandidateBuildId: CANDIDATE, hasPendingActions: true,
    }))));
    authenticatedFetch.mockResolvedValue(response(200, { success: true, version: '1.47.0.10' }));

    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.latestVersion).toBe('1.47.0.10'));
    expect(hook.result.current.updatePrepared).toBe(false);
    expect(hook.result.current.updateAvailable).toBe(false);
    hook.unmount();
  });

  it('separates a newer release on offer from prepared work', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, health())));
    authenticatedFetch.mockResolvedValue(response(200, { success: true, version: '99.0.0.0' }));

    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.updateAvailable).toBe(true));
    expect(hook.result.current.newerReleaseOffered).toBe(true);
    expect(hook.result.current.updatePrepared).toBe(false);
    hook.unmount();
  });
});

// ── ADR-156 WI-6: the degraded signal ───────────────────────────────────────

describe('degraded reporting from /health', () => {
  it('stays null for a healthy node and for an older server that omits the field', async () => {
    for (const extra of [{}, { degraded: false, degradedReason: null }]) {
      vi.stubGlobal('fetch', vi.fn(async () => response(200, health(extra))));
      authenticatedFetch.mockResolvedValue(response(200, { success: true, version: '1.47.0.10' }));
      const hook = renderHook(() => useVersionCheck());
      await waitFor(() => expect(hook.result.current.latestVersion).toBe('1.47.0.10'));
      expect(hook.result.current.degradedReason).toBeNull();
      hook.unmount();
    }
  });

  it('surfaces the published reason code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, health({
      degraded: true, degradedReason: 'manual_recovery_required',
    }))));
    authenticatedFetch.mockResolvedValue(response(200, { success: true, version: '1.47.0.10' }));
    const hook = renderHook(() => useVersionCheck());
    await waitFor(() => expect(hook.result.current.degradedReason).toBe('manual_recovery_required'));
    hook.unmount();
  });

  it('falls back to "unknown" for a reason this build does not know', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, health({
      degraded: true, degradedReason: 'some_future_reason',
    }))));
    authenticatedFetch.mockResolvedValue(response(200, { success: true, version: '1.47.0.10' }));
    const hook = renderHook(() => useVersionCheck());
    await waitFor(() => expect(hook.result.current.degradedReason).toBe('unknown'));
    hook.unmount();
  });
});

describe('M1 — the running version decides, not package.json (ADR-156 §F.2.2)', () => {
  it('offers the update to a degraded node whose source already sits at the target', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      sourceVersion: '1.45.0.0',
      runtimeVersion: '1.44.0.1',
      installMode: 'git',
      restartRequired: false,
      hasPendingActions: false,
    })));
    authenticatedFetch.mockResolvedValue(response(200, { success: true, version: '1.45.0.0' }));

    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.newerReleaseOffered).toBe(true));
    expect(hook.result.current.updateAvailable).toBe(true);
    expect(hook.result.current.currentVersion).toBe('1.44.0.1');
    expect(hook.result.current.sourceVersion).toBe('1.45.0.0');
    expect(hook.result.current.sourceAheadOfRuntime).toBe(true);
  });

  it('falls back to the source version when the server publishes no runtime identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      sourceVersion: '1.45.0.0', runtimeVersion: null, installMode: 'git',
    })));
    authenticatedFetch.mockResolvedValue(response(200, { success: true, version: '1.45.0.0' }));

    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.currentVersion).toBe('1.45.0.0'));
    expect(hook.result.current.newerReleaseOffered).toBe(false);
    expect(hook.result.current.sourceAheadOfRuntime).toBe(false);
  });

  it('ignores a malformed runtime version rather than printing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      sourceVersion: '1.44.0.1', runtimeVersion: '1.44.0.1-dirty', installMode: 'git',
    })));
    authenticatedFetch.mockResolvedValue(response(304, {}));

    const hook = renderHook(() => useVersionCheck());

    await waitFor(() => expect(hook.result.current.currentVersion).toBe('1.44.0.1'));
  });

  it('resolves the running version and the source-ahead signal as pure rules', () => {
    expect(resolveRunningVersion('1.44.0.1', '1.45.0.0')).toBe('1.44.0.1');
    expect(resolveRunningVersion(null, '1.45.0.0')).toBe('1.45.0.0');
    expect(resolveRunningVersion(null, null)).toBeNull();
    expect(isSourceAheadOfRuntime('1.44.0.1', '1.45.0.0')).toBe(true);
    expect(isSourceAheadOfRuntime('1.45.0.0', '1.45.0.0')).toBe(false);
    expect(isSourceAheadOfRuntime(null, '1.45.0.0')).toBe(false);
  });
});

describe('H3 — degraded reason codes the UI must name', () => {
  it('recognises source_state_unreconciled instead of reporting it as unknown', () => {
    expect(resolveDegraded({ degraded: true, degradedReason: 'source_state_unreconciled' }))
      .toBe('source_state_unreconciled');
  });

  it('still maps a reason this build does not know to unknown, and healthy to null', () => {
    expect(resolveDegraded({ degraded: true, degradedReason: 'some_future_reason' })).toBe('unknown');
    expect(resolveDegraded({ degraded: false, degradedReason: 'source_state_unreconciled' })).toBeNull();
  });
});


it('local main shows an update at the same version and never discovers a remote release', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(200, {
    sourceVersion: '1.47.0.19', runtimeVersion: '1.47.0.19', installMode: 'git', updateMode: 'local-main',
    restartRequired: false, hasPendingActions: false,
  })));
  authenticatedFetch.mockResolvedValue(response(200, { mode: 'local-main', available: true, oid: 'a'.repeat(40) }));
  const hook = renderHook(() => useVersionCheck());
  await waitFor(() => expect(hook.result.current.updateAvailable).toBe(true));
  expect(authenticatedFetch.mock.calls.every(([url]) => url === '/api/system/update/local')).toBe(true);
  expect(hook.result.current.currentVersion).toBe('1.47.0.19');
  expect(hook.result.current.releaseInfo).toBeNull();
  hook.unmount();
});
