/**
 * Unit tests for connectorsStore.
 *
 * Two guarantees, both of which exist because the store is now called from THREE
 * places (idle warm-up on app boot, the settings dialog's open effect, and the
 * tab's own mount) and none of them coordinates with the others:
 *
 *   1. single-flight + no refetch once loaded — three callers within a frame
 *      must produce ONE round of GETs, and a fourth call afterwards must produce
 *      none. Without this the fix for the spinner would have traded one slow
 *      tab for four duplicate fetches per page load.
 *
 *   2. a failed REFRESH does not blank a loaded page — `ready` and the lists
 *      survive, and the error is reported alongside them. The tab keys its
 *      spinner off `ready`, so regressing this would put "Loading…" back on
 *      screen every time a refresh failed.
 *
 * Run: npm run test:client -- src/stores/connectorsStore.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../utils/api', () => ({ authenticatedFetch: (...a: unknown[]) => authenticatedFetch(...a) }));

const { loadConnectors, resetConnectorsStore, normalizeConnectorCatalog, connectorAdditionalFieldsPayload, getSnapshotForTest } = await (async () => {
  const mod = await import('./connectorsStore');
  // The snapshot is only exposed through a hook; read it through a subscriber-free
  // path by calling the hook's own getter indirectly.
  return { ...mod, getSnapshotForTest: () => mod.__snapshotForTest() };
})();

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('connectorsStore', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    resetConnectorsStore();
  });

  it('collapses concurrent callers into one round, then stops fetching', async () => {
    authenticatedFetch.mockImplementation((url: string) => {
      if (url === '/api/connectors') return Promise.resolve(ok({ connectors: [{ id: 'notion' }] }));
      if (url === '/api/connectors/catalog') return Promise.resolve(ok({ catalog: [{ service: 'notion' }] }));
      return Promise.resolve(ok({ targets: [{ provider: 'claude', writesPerUserConfig: true }] }));
    });

    await Promise.all([loadConnectors(), loadConnectors(), loadConnectors()]);
    expect(authenticatedFetch).toHaveBeenCalledTimes(3); // three URLs, one round

    await loadConnectors();
    expect(authenticatedFetch).toHaveBeenCalledTimes(3); // already loaded: no-op

    const snap = getSnapshotForTest();
    expect(snap.ready).toBe(true);
    expect(snap.connectors).toHaveLength(1);
    expect(snap.loading).toBe(false);
  });

  it('keeps a loaded page on screen when a forced refresh fails', async () => {
    authenticatedFetch.mockImplementation((url: string) => {
      if (url === '/api/connectors') return Promise.resolve(ok({ connectors: [{ id: 'notion' }] }));
      if (url === '/api/connectors/catalog') return Promise.resolve(ok({ catalog: [] }));
      return Promise.resolve(ok({ targets: [] }));
    });
    await loadConnectors();
    expect(getSnapshotForTest().ready).toBe(true);

    authenticatedFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) }));
    await loadConnectors(true);

    const snap = getSnapshotForTest();
    expect(snap.ready).toBe(true); // the lists are still real
    expect(snap.connectors).toHaveLength(1); // and still on screen
    expect(snap.error).toEqual({ kind: 'http', status: 503 });
  });

  it('does not let a late account A response refill account B cache', async () => {
    const pendingA: Array<(value: ReturnType<typeof ok>) => void> = [];
    authenticatedFetch.mockImplementation(() => new Promise((resolve) => pendingA.push(resolve)));
    const staleA = loadConnectors();
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);

    resetConnectorsStore();
    authenticatedFetch.mockImplementation((url: string) => {
      if (url === '/api/connectors') return Promise.resolve(ok({ connectors: [{ id: 'account-b' }] }));
      if (url === '/api/connectors/catalog') return Promise.resolve(ok({ catalog: [] }));
      return Promise.resolve(ok({ targets: [] }));
    });
    await loadConnectors();
    expect(getSnapshotForTest().connectors[0]?.id).toBe('account-b');

    pendingA[0]?.(ok({ connectors: [{ id: 'account-a' }] }));
    pendingA[1]?.(ok({ catalog: [] }));
    pendingA[2]?.(ok({ targets: [] }));
    await staleA;
    expect(getSnapshotForTest().connectors[0]?.id).toBe('account-b');
  });

  it('accepts v2 public fields and fails closed on an unknown schema', () => {
    expect(normalizeConnectorCatalog({ schemaVersion: 9, catalog: [] })).toEqual([]);
    expect(normalizeConnectorCatalog({
      schemaVersion: 2,
      catalog: [{
        service: 'github', displayName: 'GitHub', summary: '', allowsSharing: false,
        official: true, authMode: 'key',
        additionalFields: [{ id: 'workspace', label: 'Workspace' }],
        oauthAvailability: 'ready',
        authMetadata: {
          profileId: 'github', method: 'api_key', readiness: 'ready',
        },
      }],
    })[0]).toMatchObject({
      additionalFields: [{ id: 'workspace', label: 'Workspace' }],
      oauthAvailability: 'ready',
      authMetadata: { profileId: 'github', method: 'api_key', readiness: 'ready' },
    });
  });

  it('derives only safe v1 fields and drops operator OAuth instructions', () => {
    const [entry] = normalizeConnectorCatalog({ catalog: [{
      service: 'gmail', displayName: 'Gmail', summary: '', allowsSharing: false,
      official: true, authMode: 'oauth',
      extraEnv: [{ envVar: 'tenant', label: 'Tenant' }],
      oauthSetup: {
        configured: false,
        redirectUri: 'https://secret.example/callback',
        registerAppUrl: 'https://developer.example',
        envVars: ['NASSAJ_OAUTH_SECRET'],
      },
    }] });
    expect(entry).toMatchObject({
      oauthAvailability: 'server_not_configured',
      additionalFields: [{ id: 'field-1', label: 'Tenant' }],
    });
    expect(entry).not.toHaveProperty('oauthSetup');
    expect(JSON.stringify(entry)).not.toMatch(/callback|developer|NASSAJ_OAUTH/);
    expect(JSON.stringify(entry)).not.toContain('tenant');
    expect(connectorAdditionalFieldsPayload(entry, { 'field-1': 'acme' }, 1)).toEqual({
      extraEnv: { tenant: 'acme' },
    });
    expect(connectorAdditionalFieldsPayload(entry, { 'field-1': 'acme' }, 2)).toEqual({
      additionalFields: { 'field-1': 'acme' },
    });
  });
});
