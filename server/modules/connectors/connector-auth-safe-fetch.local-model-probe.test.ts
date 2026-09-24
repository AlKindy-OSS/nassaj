/**
 * connector-auth-safe-fetch.local-model-probe.test — B-1298(a) authenticated probe.
 *
 * `safeProbeLocalModelAuth` POSTs a minimal body to an endpoint (e.g. /chat/completions)
 * and returns ONLY the HTTP status, without loading a model or reading a body. It reuses
 * the SAME pinned DNS + address validation as the GET fetch, so SSRF rules still apply.
 *
 * Pure unit test: no DB, no network (resolver/transport injected).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { safeProbeLocalModelAuth } = await import('./connector-auth-safe-fetch.js');

const resolverFor = (address: string, family: 4 | 6 = 4) => async () => [{ address, family }];

/** Records the request the transport received so the probe's method/body can be asserted. */
const transportReturning = (status: number, seen: { method?: string; body?: string; auth?: string }) =>
  async (input: { method: string; body: Buffer | null; headers: Record<string, string> }) => {
    seen.method = input.method;
    seen.body = input.body ? input.body.toString() : null;
    seen.auth = input.headers.authorization;
    return {
      status,
      headers: { 'content-type': 'application/json' },
      body: (async function* body() { yield Buffer.from('{}'); }()),
      cancel: () => {},
    } as never;
  };

describe('safeProbeLocalModelAuth — status is returned, not thrown', () => {
  it('POSTs a minimal body with the bearer key and returns 401 for a bad key', async () => {
    const seen: { method?: string; body?: string; auth?: string } = {};
    const result = await safeProbeLocalModelAuth('http://127.0.0.1:8080/v1/chat/completions', 'bad-key', {
      resolver: resolverFor('127.0.0.1'), transport: transportReturning(401, seen),
    });
    assert.deepEqual(result, { status: 401 });
    assert.equal(seen.method, 'POST');
    assert.equal(seen.body, '{}');
    assert.equal(seen.auth, 'Bearer bad-key');
  });

  it('returns a 400 validation status for a valid key (not a 401)', async () => {
    const seen: { method?: string } = {};
    const result = await safeProbeLocalModelAuth('http://127.0.0.1:8080/v1/chat/completions', 'good-key', {
      resolver: resolverFor('127.0.0.1'), transport: transportReturning(400, seen),
    });
    assert.deepEqual(result, { status: 400 });
  });

  it('omits the authorization header when no key is configured', async () => {
    const seen: { auth?: string } = {};
    await safeProbeLocalModelAuth('http://127.0.0.1:8080/v1/chat/completions', null, {
      resolver: resolverFor('127.0.0.1'), transport: transportReturning(400, seen),
    });
    assert.equal(seen.auth, undefined);
  });
});

describe('safeProbeLocalModelAuth — SSRF rules still apply', () => {
  it('refuses a name that resolves to a cloud metadata address', async () => {
    await assert.rejects(
      safeProbeLocalModelAuth('http://ollama.internal:11434/v1/chat/completions', 'k', {
        resolver: resolverFor('169.254.169.254'), transport: transportReturning(200, {}),
      }),
      /local_model_address_forbidden/,
    );
  });

  it('refuses the nassaj port before any transport call', async () => {
    await assert.rejects(
      safeProbeLocalModelAuth('http://127.0.0.1:3004/v1/chat/completions', 'k', {
        resolver: resolverFor('127.0.0.1'), transport: transportReturning(200, {}),
      }),
      /local_model_url_forbidden/,
    );
  });

  it('refuses a key containing header-injection characters', async () => {
    await assert.rejects(
      safeProbeLocalModelAuth('http://127.0.0.1:8080/v1/chat/completions', 'bad\r\nkey', {
        resolver: resolverFor('127.0.0.1'), transport: transportReturning(200, {}),
      }),
      /local_model_key_invalid/,
    );
  });
});
