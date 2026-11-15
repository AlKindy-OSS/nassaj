/**
 * T-2098 stage 3b / T-2107 stage 5 / T-2108 (ADR-227 Decision 10): the picker and the spawn
 * use ONE vetting per body. Every row the overlay offers as eligible passes that
 * body's spawn static checks, and every row the spawn would run is offered as
 * eligible; a refused model carries the same reason code in both.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyClaudeLocalEngineEnv, claudeLocalModelEligibility } from './apply-claude-local-engine-env.js';
import { applyCodexLocalEngineEnvOrThrow } from './apply-codex-local-engine-env.js';
import { resolveDshLocalEngineOrThrow } from './apply-dsh-local-engine-env.js';
import { LOCAL_OVERLAY_BODIES, localOverlayRows } from './local-overlay.js';

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
  { id: 'codex-floor', contextWindow: 22000 + 4096 + 2000 },
  { id: 'codex-below', contextWindow: 22000 + 4096 + 2000 - 1 },
  { id: 'dsh-floor', contextWindow: 16000 + 4096 + 2000 },
  { id: 'dsh-below', contextWindow: 16000 + 4096 + 2000 - 1 },
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
  isVersionProven: async () => true,
});

/** The spawn's verdict per body, reduced to applied / the refusal reason. */
const SPAWN: Record<string, (server: object, model: string) => Promise<string>> = {
  claude: async (server, model) => {
    const verdict = await applyClaudeLocalEngineEnv({}, { userId: 7, requestedModel: model }, spawnDeps(server));
    return verdict.status === 'unavailable' ? verdict.reason : verdict.status;
  },
  codex: async (server, model) => {
    try {
      await applyCodexLocalEngineEnvOrThrow({}, { userId: 7, requestedModel: model, cliVersion: '0' }, spawnDeps(server));
      return 'applied';
    } catch (error) {
      return (error as { reason?: string }).reason ?? 'thrown';
    }
  },
  dsh: async (server, model) => {
    try {
      await resolveDshLocalEngineOrThrow({ userId: 7, requestedModel: model, cliVersion: '0.0.0' }, spawnDeps(server));
      return 'applied';
    } catch (error) {
      return (error as { reason?: string }).reason ?? 'thrown';
    }
  },
};

/** The spawn reason a static overlay refusal corresponds to. */
const SPAWN_REASON: Record<string, string> = { address_untested: 'address_changed' };

for (const body of ['claude', 'codex', 'dsh'] as const) {
  test(`${body}: picker eligibility and spawn verdict agree for every server shape and model`, async () => {
    let compared = 0;
    for (const server of SERVERS) {
      const [row] = localOverlayRows([server], LOCAL_OVERLAY_BODIES[body]);
      for (const model of row.models) {
        const verdict = await SPAWN[body](server, model.value);
        if (model.eligibility === 'ok') {
          assert.equal(verdict, 'applied', `${server.baseUrl} ${model.value} offered but refused`);
        } else {
          assert.equal(verdict, SPAWN_REASON[model.eligibility] ?? model.eligibility, `${body} ${model.value}`);
        }
        compared += 1;
      }
    }
    assert.equal(compared, SERVERS.length * MODELS.length);
  });
}

test('each body states the context floor its own spawn applies', () => {
  const [claude] = localOverlayRows([SERVERS[0]], LOCAL_OVERLAY_BODIES.claude);
  const [codex] = localOverlayRows([SERVERS[0]], LOCAL_OVERLAY_BODIES.codex);
  const floor = (row: typeof claude, id: string) => row.models.find((m) => m.value.endsWith(`/${id}`))?.minContextWindow;
  assert.equal(floor(claude, 'fits'), 12000 + 4096 + 2000);
  assert.equal(floor(claude, 'small-out'), 12000 + 1024 + 2000);
  assert.equal(floor(codex, 'fits'), 22000 + 4096 + 2000);
  assert.equal(codex.models.find((m) => m.value.endsWith('/codex-below'))?.eligibility, 'context_too_small');
  assert.equal(codex.models.find((m) => m.value.endsWith('/Claude-lookalike'))?.eligibility, 'ok');
  const [dsh] = localOverlayRows([SERVERS[0]], LOCAL_OVERLAY_BODIES.dsh);
  assert.equal(floor(dsh, 'fits'), 16000 + 4096 + 2000);
  assert.equal(dsh.models.find((m) => m.value.endsWith('/dsh-floor'))?.eligibility, 'ok');
  assert.equal(dsh.models.find((m) => m.value.endsWith('/dsh-below'))?.eligibility, 'context_too_small');
});

test('the exported eligibility check is the one the spawn applies', () => {
  assert.deepEqual(MODELS.map((model) => claudeLocalModelEligibility(model)), [
    'ok', 'ok', 'context_too_small', 'ok', 'context_too_small',
    'context_unknown', 'context_unknown', 'context_unknown', 'model_id_reserved', 'ok', 'ok', 'ok', 'ok',
  ]);
});

test('a model id the spawn cannot pass to the CLI is never offered', () => {
  const server = { ...SERVERS[0], models: [{ id: 'bad id', contextWindow: 65536 }, { id: 'ok-id', contextWindow: 65536 }] };
  const [row] = localOverlayRows([server], LOCAL_OVERLAY_BODIES.claude);
  assert.deepEqual(row.models.map((model) => model.value), [`${PROVIDER}/ok-id`]);
});

test('a row outside the reserved provider namespace is never offered', () => {
  assert.deepEqual(localOverlayRows([{ ...SERVERS[0], providerId: 'glm' }], LOCAL_OVERLAY_BODIES.codex), []);
});
