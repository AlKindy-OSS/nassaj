/**
 * T-2107 qa high 6: a local chat resumed with no explicit model re-pick may carry
 * the bare model id its rollout recorded. When that id is listed on the pinned
 * server it is qualified to `<providerId>/<id>` and the chat resumes there; an
 * explicit re-pick to a model that is not local still refuses (no cloud move).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCodexLocalEngineEnvOrThrow } from './apply-codex-local-engine-env.js';
import { formatLocalEnginePin } from './local-engine-pin.js';

const SERVER = {
  id: '5d0b8a51-2c3e-4f6a-9b7c-1e2d3f4a5b6c', ownerId: 7,
  providerId: 'nassaj_local_5d0b8a512c3e4f6a9b7c1e2d3f4a5b6c', baseUrl: 'http://127.0.0.1:18080/v1',
  verifiedAddresses: ['127.0.0.1'], models: [{ id: 'first', contextWindow: 32768 }, { id: 'second', contextWindow: 32768 }],
};
const PIN = formatLocalEnginePin({ serverId: SERVER.id, ownerId: 7, origin: 'http://127.0.0.1:18080' });
const deps = {
  enabled: () => true, runnable: () => true, listServers: () => [SERVER], getSecret: () => null,
  resolvePrivate: async () => ({ address: '127.0.0.1', family: 4 }), isVersionProven: () => true,
};
const resume = (requestedModel: string, qualifyBareModel: boolean) => applyCodexLocalEngineEnvOrThrow({},
  { userId: 7, requestedModel, storedPin: PIN, cliVersion: '0.166.0', qualifyBareModel }, deps);

test('no re-pick: the bare rollout model listed on the pinned server resumes there', async () => {
  const applied = await resume('second', true);
  assert.equal(applied?.local.model, 'second', 'not the first model of the server');
});

test('no re-pick: a bare model the pinned server does not list is refused', async () => {
  await assert.rejects(resume('gpt-5.5', true), { reason: 'pin_conflict' });
});

test('an explicit re-pick to a non-local model is refused, as before', async () => {
  await assert.rejects(resume('second', false), { reason: 'pin_conflict' });
});
