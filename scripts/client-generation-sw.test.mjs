import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const asset = `https://example.test/assets/generations/${'a'.repeat(64)}/fixed.png`;

function worker({ cache = {}, fetch: fetchImpl = async () => ({ status: 200, type: 'basic', clone() { return this; } }), open } = {}) {
  const events = new Map();
  const requests = [];
  const defaultCache = { match: async () => null, put: async () => {}, ...cache };
  runInNewContext(source, {
    URL, Response, caches: { open: open || (async () => defaultCache), keys: async () => [] },
    self: { location: { origin: 'https://example.test' }, addEventListener: (name, fn) => events.set(name, fn) },
    fetch: (request, options) => { requests.push(options); return fetchImpl(request, options); },
  });
  return { requests, request(url = asset, mode = 'cors', method = 'GET') {
    let response;
    events.get('fetch')({ request: { url, mode, method }, respondWith(value) { response = value; } });
    return response;
  } };
}

test('quota or cache open/read failures never discard a successful asset response', async () => {
  for (const options of [
    { cache: { put: async () => { throw Error('quota'); } } },
    { open: async () => { throw Error('unavailable'); } },
    { cache: { match: async () => { throw Error('unavailable'); } } },
  ]) assert.equal((await worker(options).request()).status, 200);
});
test('cached generation survives network loss; failures and redirected assets are never cached', async () => {
  const cached = { cached: true };
  assert.equal(await worker({ cache: { match: async () => cached }, fetch: async () => { throw Error('offline'); } }).request(), cached);
  for (const response of [{ status: 502 }, { status: 200, type: 'basic', redirected: true }, { status: 200, type: 'opaque' }]) {
    let writes = 0;
    const sw = worker({ fetch: async () => response, cache: { put: async () => writes++ } });
    assert.equal(await sw.request(), response); assert.equal(writes, 0);
  }
  assert.equal((await worker({ fetch: async () => { throw Error('offline'); } }).request()).type, 'error');
});
test('documents/version never fall back to stale cache; offline navigation remains legible', async () => {
  const sw = worker({ fetch: async () => { throw Error('offline'); } });
  const navigation = await sw.request('https://example.test/', 'navigate');
  assert.match(await navigation.text(), /Offline/);
  assert.equal(navigation.headers.get('Cache-Control'), 'no-store');
  assert.equal((await sw.request('https://example.test/version.json')).type, 'error');
  assert.deepEqual(sw.requests.map(options => options.cache), ['no-store', 'no-store']);
  assert.equal((await sw.request('https://example.test/fixed.png')).type, 'error');
  assert.equal(sw.requests.at(-1).cache, 'no-cache');
});
test('API, cross origin, websockets and mutations pass through untouched', () => {
  const sw = worker();
  for (const url of ['https://other.test/fixed.png', 'https://example.test/api/x', 'https://example.test/ws']) assert.equal(sw.request(url), undefined);
  assert.equal(sw.request(asset, 'cors', 'POST'), undefined);
  assert.equal(sw.requests.length, 0);
});

test('activation claims clients even when cache enumeration or deletion fails', async () => {
  for (const failure of ['keys', 'delete']) {
    let activation;
    let claims = 0;
    runInNewContext(source, {
      self: { addEventListener: (name, handler) => { if (name === 'activate') activation = handler; }, clients: { claim: async () => { claims++; } } },
      caches: {
        keys: async () => { if (failure === 'keys') throw Error('storage unavailable'); return ['claude-ui-v8']; },
        delete: async () => { throw Error('storage unavailable'); },
      },
    });
    let completion;
    activation({ waitUntil: promise => { completion = promise; } });
    await completion;
    assert.equal(claims, 1, failure);
  }
});
