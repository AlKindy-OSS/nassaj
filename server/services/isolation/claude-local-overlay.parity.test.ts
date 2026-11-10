/**
 * T-2098 stage 3b (ADR-227 Decision 10): the picker and the spawn use ONE vetting.
 * Every row the overlay offers as eligible passes the spawn's static checks, and
 * every row the spawn would run is offered as eligible; a refused model carries
 * the same reason code in both.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyClaudeLocalEngineEnv, claudeLocalModelEligibility } from './apply-claude-local-engine-env.js';
import { claudeLocalOverlayRows } from './claude-local-overlay.js';

const SERVER_ID = '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11';
const PROVIDER = 'nassaj_local_0b9c6a3e6f1e4c419a4e2f1b9e0c7d11';
const ADDRESS = '192.168.40.2';

const MODELS = [
  { id: 'fits', contextWindow: 32768 },
  { id: 'exact-floor', contextWindow: 12000 + 4096 + 2000 },
  { id: 'one-below', contextWindow: 12000 + 4096 + 2000 - 1 },
  { id: 'small-out', contextWindow: 12000 + 1024 + 2000, maxOutput: 512 },
  { id: 'small-out-below', contextWindow: 12000 + 1024 + 2000 - 1, maxOutput: 512 },
  { id: 'no-window' },
  { id: 'zero-window', contextWindow: 0 },
  { id: 'float-window', contextWindow: 32768.5 },
  { id: 'Claude-lookalike', contextWindow: 65536 },
];

const SERVERS = [
  { baseUrl: `http://${ADDRESS}:8080/v1`, verifiedAddresses: [ADDRESS] },
  { baseUrl: `http://${ADDRESS}:8080/v1`, verifiedAddresses: [] },
  { baseUrl: 'https://box.lan:8443', verifiedAddresses: [ADDRESS] },
  { baseUrl: `http://${ADDRESS}:8080/api/other`, verifiedAddresses: [ADDRESS] },
].map((shape) => ({ id: SERVER_ID, ownerId: 7, providerId: PROVIDER, name: 'Box', runtime: 'custom', models: MODELS, ...shape }));

const spawnDeps = (server: object) => ({
  enabled: () => true,
  runnable: () => true,
  listServers: () => [server],
  getSecret: () => null,
  resolvePrivate: async () => ({ address: ADDRESS, family: 4 }),
  cliVersionProven: async () => true,
});

/** The spawn reason a static overlay refusal corresponds to. */
const SPAWN_REASON: Record<string, string> = { address_untested: 'address_changed' };

test('picker eligibility and spawn verdict agree for every server shape and model', async () => {
  let compared = 0;
  for (const server of SERVERS) {
    const [row] = claudeLocalOverlayRows([server]);
    for (const model of row.models) {
      const verdict = await applyClaudeLocalEngineEnv({}, { userId: 7, requestedModel: model.value }, spawnDeps(server));
      if (model.eligibility === 'ok') {
        assert.equal(verdict.status, 'applied', `${server.baseUrl} ${model.value} offered but refused`);
      } else {
        assert.equal(verdict.status, 'unavailable', `${server.baseUrl} ${model.value} hidden but runnable`);
        const expected = SPAWN_REASON[model.eligibility] ?? model.eligibility;
        assert.equal(verdict.status === 'unavailable' && verdict.reason, expected, model.value);
      }
      compared += 1;
    }
  }
  assert.equal(compared, SERVERS.length * MODELS.length);
});

test('the exported eligibility check is the one the spawn applies', () => {
  assert.deepEqual(MODELS.map((model) => claudeLocalModelEligibility(model)), [
    'ok', 'ok', 'context_too_small', 'ok', 'context_too_small',
    'context_unknown', 'context_unknown', 'context_unknown', 'model_id_reserved',
  ]);
});

test('a model id the spawn cannot pass to the CLI is never offered', () => {
  const server = { ...SERVERS[0], models: [{ id: 'bad id', contextWindow: 65536 }, { id: 'ok-id', contextWindow: 65536 }] };
  const [row] = claudeLocalOverlayRows([server]);
  assert.deepEqual(row.models.map((model) => model.value), [`${PROVIDER}/ok-id`]);
});

test('a row outside the reserved provider namespace is never offered', () => {
  assert.deepEqual(claudeLocalOverlayRows([{ ...SERVERS[0], providerId: 'glm' }]), []);
});
