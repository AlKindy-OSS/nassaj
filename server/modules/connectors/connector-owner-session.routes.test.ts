import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import {
  createConnectorOwnerSessionRoutes,
  type ConnectorOwnerSessionDependencies,
  type StepUpRefusal,
} from './connector-owner-session.routes.js';

const ORIGIN = 'https://nassaj.example';

class FakeRefusal extends Error implements StepUpRefusal {
  constructor(readonly code: string, readonly status: number, readonly reason?: string,
    readonly retryAfterSeconds?: number) {
    super(`refused: ${code}`);
  }
}

type Harness = Readonly<{
  audits: Array<[string, Record<string, unknown>]>;
  records: Array<[number, string]>;
  verifierCalls: unknown[];
  clearedOidc: number[];
  limited: number[];
}>;

const serve = async (
  overrides: Partial<ConnectorOwnerSessionDependencies>,
  send: (base: string) => Promise<Response>,
  user: { id: number } | null = { id: 7 },
): Promise<{ response: Response; body: unknown } & Harness> => {
  const harness: Harness = { audits: [], records: [], verifierCalls: [], clearedOidc: [], limited: [] };
  const deps: ConnectorOwnerSessionDependencies = {
    resolveOrigin: () => ORIGIN,
    verifyEvidence: async (_req, caller, audience, evidence) => {
      harness.verifierCalls.push({ caller, audience, evidence });
      return { authMethod: 'password', authTimeMs: 1 };
    },
    record: (res, userId, authMethod) => {
      harness.records.push([userId, authMethod]);
      res.cookie('__Host-nassaj_connector_recent_auth', 'x', { secure: true, path: '/' });
      return 'ok';
    },
    audit: (event, data) => { harness.audits.push([event, data as unknown as Record<string, unknown>]); },
    asStepUpRefusal: error => (error instanceof FakeRefusal ? error : null),
    clearOidcTransaction: () => { harness.clearedOidc.push(1); },
    routeLimiter: (_req, _res, next) => { harness.limited.push(1); next(); },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as express.Request & { user: unknown }).user = user;
    next();
  });
  app.use('/owner-session', createConnectorOwnerSessionRoutes(deps));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const response = await send(`http://127.0.0.1:${(server.address() as AddressInfo).port}/owner-session/step-up`);
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null, ...harness };
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
};

const post = (stepUp: unknown, origin: string | null = ORIGIN) => (url: string) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  body: JSON.stringify({ stepUp }),
});

test('a verified password step-up sets the session and answers 204 with an id-only audit', async () => {
  const result = await serve({}, post({ method: 'password', password: 'example-hunter2' }));
  assert.equal(result.response.status, 204);
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.match(result.response.headers.get('set-cookie') ?? '', /__Host-nassaj_connector_recent_auth=/u);
  assert.deepEqual(result.records, [[7, 'password']]);
  assert.deepEqual(result.verifierCalls, [{
    caller: { id: 7 }, audience: 'connector_owner', evidence: { method: 'password', password: 'example-hunter2' },
  }]);
  assert.equal(result.audits.length, 1);
  assert.equal(result.audits[0][0], 'connector_step_up_success');
  assert.deepEqual(result.audits[0][1].metadata, { method: 'password' });
  assert.doesNotMatch(JSON.stringify(result.audits), /hunter2/u, 'evidence never reaches the audit log');
  assert.deepEqual(result.clearedOidc, []);
});

test('unauthenticated callers get 401 AUTH_REQUIRED before the limiter or verifier', async () => {
  const result = await serve({}, post({ method: 'password', password: 'x' }), null);
  assert.equal(result.response.status, 401);
  assert.deepEqual(result.body, { error: 'Authentication required.', code: 'AUTH_REQUIRED' });
  assert.deepEqual([result.limited, result.verifierCalls, result.records], [[], [], []]);
});

test('origin: unconfigured is 503, mismatch or absence is 403, both before any verification', async () => {
  const unconfigured = await serve({ resolveOrigin: () => null }, post({ method: 'password', password: 'x' }));
  assert.equal(unconfigured.response.status, 503);
  assert.equal((unconfigured.body as { code: string }).code, 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED');
  const throwing = await serve({ resolveOrigin: () => { throw new Error('down'); } },
    post({ method: 'password', password: 'x' }));
  assert.equal((throwing.body as { code: string }).code, 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED');
  for (const origin of ['https://attacker.example', null]) {
    const rejected = await serve({}, post({ method: 'password', password: 'x' }, origin));
    assert.equal(rejected.response.status, 403);
    assert.equal((rejected.body as { code: string }).code, 'CONNECTOR_ORIGIN_REJECTED');
    assert.deepEqual([rejected.verifierCalls, rejected.records], [[], []]);
  }
});

test('the origin is resolved per request', async () => {
  let origin = 'https://old.example';
  const deps = { resolveOrigin: () => origin };
  assert.equal((await serve(deps, post({ method: 'password', password: 'x' }, ORIGIN))).response.status, 403);
  origin = ORIGIN;
  assert.equal((await serve(deps, post({ method: 'password', password: 'x' }, ORIGIN))).response.status, 204);
});

test('verifier refusals keep their status and code; 429 carries Retry-After', async () => {
  const cases: Array<[FakeRefusal, number]> = [
    [new FakeRefusal('step_up_failed', 401, 'oidc_grant_invalid'), 401],
    [new FakeRefusal('sso_step_up_required', 403), 403],
    [new FakeRefusal('step_up_invalid_request', 400), 400],
    [new FakeRefusal('step_up_rate_limited', 429, undefined, 120), 429],
  ];
  for (const [refusal, status] of cases) {
    const result = await serve({ verifyEvidence: async () => { throw refusal; } },
      post({ method: 'password', password: 'x' }));
    assert.equal(result.response.status, status);
    assert.deepEqual(result.body, { error: refusal.message, code: refusal.code });
    assert.equal(result.response.headers.get('retry-after'), refusal.retryAfterSeconds ? '120' : null);
    assert.deepEqual(result.records, [], 'no session after a refusal');
    assert.equal(result.audits[0][0], 'connector_step_up_failure');
    assert.deepEqual(result.audits[0][1].metadata, { method: 'password', reason: refusal.reason ?? refusal.code });
  }
});

test('an unexpected verifier error is a generic 500 step_up_unavailable with a sanitized log', async () => {
  const logged: unknown[] = [];
  const failure = Object.assign(new TypeError('argon2 exploded: secret'), { code: 'ERR_ARGON2' });
  const result = await serve({
    verifyEvidence: async () => { throw failure; },
    logVerifierError: detail => { logged.push(detail); },
  }, post({ method: 'passkey', response: { signature: 'sig-secret' } }));
  assert.equal(result.response.status, 500);
  assert.deepEqual(result.body, { error: 'Verification failed.', code: 'step_up_unavailable' });
  assert.doesNotMatch(JSON.stringify(result.body), /argon2|secret/u);
  assert.deepEqual(result.audits[0][1].metadata, { method: 'passkey', reason: 'verifier_error' });
  assert.deepEqual(logged, [{ name: 'TypeError', code: 'ERR_ARGON2' }], 'name and code only');
  assert.doesNotMatch(JSON.stringify(logged), /argon2 exploded|secret/u);
});

test('the default verifier-error log carries no message or evidence', async (t) => {
  const errorLog = t.mock.method(console, 'error', () => undefined);
  await serve({ verifyEvidence: async () => { throw new Error('boom: hunter2'); } },
    post({ method: 'password', password: 'hunter2' }));
  assert.equal(errorLog.mock.callCount(), 1);
  assert.deepEqual(errorLog.mock.calls[0].arguments, ['connector step-up verifier error', { name: 'Error' }]);
});

test('a missing session adapter is 503 CONNECTOR_RECENT_AUTH_UNAVAILABLE, not an origin problem', async () => {
  const result = await serve({ isAvailable: () => false }, post({ method: 'password', password: 'x' }));
  assert.equal(result.response.status, 503);
  assert.deepEqual(result.body, {
    error: 'Recent authentication is unavailable.', code: 'CONNECTOR_RECENT_AUTH_UNAVAILABLE',
  });
  assert.deepEqual([result.verifierCalls, result.records], [[], []]);
  assert.equal(result.response.headers.get('set-cookie'), null);
});

test('a repeated verifier rate-limit refusal is audited once per window, other refusals always', async () => {
  let allowance = 1;
  const auditRateLimited = () => { allowance -= 1; return allowance >= 0; };
  const limited = new FakeRefusal('step_up_rate_limited', 429, undefined, 60);
  const first = await serve({ verifyEvidence: async () => { throw limited; }, auditRateLimited },
    post({ method: 'password', password: 'x' }));
  const second = await serve({ verifyEvidence: async () => { throw limited; }, auditRateLimited },
    post({ method: 'password', password: 'x' }));
  assert.deepEqual([first.response.status, second.response.status], [429, 429]);
  assert.equal(second.response.headers.get('retry-after'), '60');
  assert.equal(first.audits.length, 1);
  assert.equal(second.audits.length, 0, 'the repeat inside the window is not re-recorded');
  const failed = await serve({
    verifyEvidence: async () => { throw new FakeRefusal('step_up_failed', 401, 'bad_password'); },
    auditRateLimited,
  }, post({ method: 'password', password: 'x' }));
  assert.equal(failed.audits.length, 1, 'non-rate-limit refusals are not de-duplicated');
});

test('a session that could not be recorded is reported as 503, never as success', async () => {
  const result = await serve({ record: () => 'unavailable' }, post({ method: 'password', password: 'x' }));
  assert.equal(result.response.status, 503);
  assert.deepEqual(result.body, {
    error: 'Recent authentication is unavailable.', code: 'CONNECTOR_RECENT_AUTH_UNAVAILABLE',
  });
  assert.equal(result.response.headers.get('set-cookie'), null);
  assert.deepEqual(result.audits.map(([event]) => event), ['connector_step_up_failure']);
});

test('an oidc_grant clears the browser transaction on success and on refusal; methods are audited safely', async () => {
  const ok = await serve({
    verifyEvidence: async () => ({ authMethod: 'oidc', authTimeMs: 1 }),
  }, post({ method: 'oidc_grant', grant: 'g'.repeat(43) }));
  assert.equal(ok.response.status, 204);
  assert.deepEqual(ok.records, [[7, 'oidc']]);
  assert.deepEqual(ok.clearedOidc, [1]);
  assert.deepEqual(ok.audits[0][1].metadata, { method: 'oidc_grant' });
  assert.doesNotMatch(JSON.stringify(ok.audits), /ggggg/u, 'the grant is not logged');

  const refused = await serve({
    verifyEvidence: async () => { throw new FakeRefusal('step_up_failed', 401, 'oidc_grant_invalid'); },
  }, post({ method: 'oidc_grant', grant: 'replayed' }));
  assert.equal(refused.response.status, 401);
  assert.deepEqual(refused.clearedOidc, [1]);

  const unknown = await serve({
    verifyEvidence: async () => { throw new FakeRefusal('step_up_invalid_request', 400); },
  }, post({ method: 'telepathy' }));
  assert.deepEqual(unknown.audits[0][1].metadata, { method: 'none', reason: 'step_up_invalid_request' });
});

test('the route limiter answers for itself (429) and the verifier is not reached', async () => {
  const result = await serve({
    routeLimiter: (_req, res) => {
      res.set('Retry-After', '60').status(429).json({ error: 'slow down', code: 'step_up_rate_limited' });
    },
  }, post({ method: 'password', password: 'x' }));
  assert.equal(result.response.status, 429);
  assert.equal(result.response.headers.get('retry-after'), '60');
  assert.deepEqual(result.verifierCalls, []);
});
