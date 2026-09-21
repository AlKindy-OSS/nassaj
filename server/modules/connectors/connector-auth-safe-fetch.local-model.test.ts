/**
 * connector-auth-safe-fetch.local-model.test — the ADR-163 local-inference URL rules
 * (B-1268). Pure unit test: no DB, no network (the resolver/transport are injected).
 *
 * Proves, for the LOCAL MODEL path only (the connector path is untouched):
 *  - loopback and tailnet/RFC1918 endpoints on a normal inference port are accepted
 *    over plain http;
 *  - the cloud metadata address, the nassaj port itself, and privileged loopback ports
 *    (< 1024) are refused — before and after DNS resolution;
 *  - plaintext http toward a public address is refused, while https is accepted
 *    (owner decision: a remote endpoint is the connector's responsibility, over TLS).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { safeFetchLocalModelJson, validateLocalModelUrl } = await import('./connector-auth-safe-fetch.js');

/** Resolver stub shaped like node:dns lookup results used by the real resolver. */
const resolverFor = (address: string, family: 4 | 6 = 4) =>
  async () => [{ address, family }];

const transportOk = async () => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: (async function* body() { yield Buffer.from('{"data":[]}'); }()),
  destroy: () => {},
} as never);

const fetchWith = (url: string, address: string, family: 4 | 6 = 4) =>
  safeFetchLocalModelJson(url, null, { resolver: resolverFor(address, family), transport: transportOk });

describe('validateLocalModelUrl — accepted local endpoints', () => {
  it('accepts loopback and tailnet endpoints on an inference port over http', () => {
    assert.equal(validateLocalModelUrl('http://127.0.0.1:11434/v1').port, '11434');
    assert.equal(validateLocalModelUrl('http://100.64.0.5:11434/v1').port, '11434');
    assert.equal(validateLocalModelUrl('http://192.168.1.20:8000/v1').port, '8000');
    assert.equal(validateLocalModelUrl('https://models.example.com/v1').protocol, 'https:');
  });
});

describe('validateLocalModelUrl — refused endpoints', () => {
  const refused = [
    ['cloud metadata host name', 'http://metadata.google.internal/v1'],
    ['link-local metadata address', 'http://169.254.169.254/v1'],
    ['the nassaj port itself', 'http://127.0.0.1:3004/v1'],
    ['a privileged loopback port', 'http://127.0.0.1:80/v1'],
    ['a privileged localhost port', 'http://localhost:22/v1'],
    ['plaintext http to a public address', 'http://8.8.8.8:11434/v1'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['embedded credentials', 'http://user:pass@127.0.0.1:11434/v1'],
    ['an interpolation template', 'http://127.0.0.1:${PORT}/v1'],
  ] as const;

  for (const [label, url] of refused) {
    it(`refuses ${label}`, () => {
      assert.throws(() => validateLocalModelUrl(url), /local_model_url_(forbidden|invalid)/);
    });
  }

  it('refuses 169.254.169.254 even though it parses as a URL', () => {
    assert.throws(() => validateLocalModelUrl('http://169.254.169.254:11434/v1'), /local_model_url_forbidden/);
  });
});

describe('safeFetchLocalModelJson — the resolved address decides', () => {
  it('fetches a name that resolves to loopback on an inference port', async () => {
    assert.deepEqual(await fetchWith('http://ollama.internal:11434/v1/models', '127.0.0.1'), { data: [] });
  });

  it('fetches a tailnet address over http', async () => {
    assert.deepEqual(await fetchWith('http://100.64.0.5:11434/v1/models', '100.64.0.5'), { data: [] });
  });

  it('refuses a name that resolves to a metadata address', async () => {
    await assert.rejects(fetchWith('http://ollama.internal:11434/v1/models', '169.254.169.254'),
      /local_model_address_forbidden/);
  });

  it('refuses plaintext http once the name resolves to a public address', async () => {
    await assert.rejects(fetchWith('http://ollama.example.com:11434/v1/models', '93.184.216.34'),
      /local_model_address_forbidden/);
  });

  it('allows https toward that same public address', async () => {
    assert.deepEqual(await fetchWith('https://ollama.example.com/v1/models', '93.184.216.34'), { data: [] });
  });
});
