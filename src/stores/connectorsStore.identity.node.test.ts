import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

type FetchResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
let fetchConnector: (url: string) => Promise<FetchResponse>;

mock.module('../utils/api', {
  namedExports: {
    authenticatedFetch: (url: string) => fetchConnector(url),
  },
});

const store = await import('./connectorsStore');
const ok = (body: unknown): FetchResponse => ({ ok: true, status: 200, json: async () => body });

test('late account A connector reads cannot refill account B cache', async () => {
  store.resetConnectorsStore();
  const pendingA: Array<(response: FetchResponse) => void> = [];
  fetchConnector = async () => new Promise((resolve) => pendingA.push(resolve));
  const staleAccountA = store.loadConnectors();
  assert.equal(pendingA.length, 3);

  store.resetConnectorsStore();
  fetchConnector = async (url) => {
    if (url === '/api/connectors') return ok({ connectors: [{ id: 'account-b' }] });
    if (url === '/api/connectors/catalog') return ok({ catalog: [] });
    return ok({ targets: [] });
  };
  await store.loadConnectors();
  assert.equal(store.__snapshotForTest().connectors[0]?.id, 'account-b');

  pendingA[0]?.(ok({ connectors: [{ id: 'account-a' }] }));
  pendingA[1]?.(ok({ catalog: [] }));
  pendingA[2]?.(ok({ targets: [] }));
  await staleAccountA;
  assert.equal(store.__snapshotForTest().connectors[0]?.id, 'account-b');
  store.resetConnectorsStore();
});

for (const failure of [false, true]) {
  test(`late A connector body ${failure ? 'failure' : 'success'} cannot alter B`, async () => {
    store.resetConnectorsStore();
    let release!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const body = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    fetchConnector = async (url) => url === '/api/connectors'
      ? { ok: true, status: 200, json: () => { reading(); return body; } }
      : ok(url.endsWith('/catalog') ? { catalog: [] } : { targets: [] });
    const oldRead = store.loadConnectors();
    await started;
    store.resetConnectorsStore();
    fetchConnector = async (url) => ok(url === '/api/connectors'
      ? { connectors: [{ id: 'account-b' }] }
      : url.endsWith('/catalog') ? { catalog: [] } : { targets: [] });
    await store.loadConnectors();
    const before = store.__snapshotForTest();
    if (failure) reject(new Error('account-a-private-error'));
    else release({ connectors: [{ id: 'account-a' }] });
    await oldRead;
    assert.deepEqual(store.__snapshotForTest(), before);
    store.resetConnectorsStore();
  });
}
