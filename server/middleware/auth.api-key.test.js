/** T-2044 S1: validateApiKey uses a constant-time compare and stays a no-op when unset. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { validateApiKey } from './auth.js';

/** Run the middleware with the given headers; returns { nextCalled, status, body }. */
function run(headers) {
  const outcome = { nextCalled: false, status: null, body: null };
  const res = {
    status(code) { outcome.status = code; return this; },
    json(body) { outcome.body = body; return this; },
  };
  validateApiKey({ headers }, res, () => { outcome.nextCalled = true; });
  return outcome;
}

function withApiKey(t, value) {
  const previous = process.env.API_KEY;
  if (value === undefined) delete process.env.API_KEY; else process.env.API_KEY = value;
  t.after(() => {
    if (previous === undefined) delete process.env.API_KEY; else process.env.API_KEY = previous;
  });
}

test('API_KEY unset: every request passes, header or not', (t) => {
  withApiKey(t, undefined);
  assert.equal(run({}).nextCalled, true);
  assert.equal(run({ 'x-api-key': 'anything' }).nextCalled, true);
});

test('matching header passes', (t) => {
  withApiKey(t, 'gate-key-123');
  assert.deepEqual(run({ 'x-api-key': 'gate-key-123' }), { nextCalled: true, status: null, body: null });
});

test('mismatch, missing and array headers get a generic 401', (t) => {
  withApiKey(t, 'gate-key-123');
  for (const headers of [
    { 'x-api-key': 'gate-key-124' },
    { 'x-api-key': 'short' },
    {},
    { 'x-api-key': ['gate-key-123'] },
  ]) {
    const outcome = run(headers);
    assert.equal(outcome.nextCalled, false);
    assert.equal(outcome.status, 401);
    assert.deepEqual(outcome.body, { error: 'Invalid API key' });
  }
});
