/**
 * opencode-carrier-model-detection.test.ts — the GLM fold (owner decision
 * 2026-07-26): GLM is no longer a selectable provider, so the ONLY way a user
 * reaches it is OpenCode + a `glm/*` model. Such a turn arrives at the launcher
 * with `options.carrier` UNSET (nothing sets it outside the historical
 * provider-`glm` dispatch), which — before this seam — meant the entire ADR-062
 * guard chain (governance gate, baseURL allowlist, binary digest pin, loopback
 * confinement, env sanitization) was skipped on what is now the sole GLM path.
 *
 * These tests pin the DECISION function itself (isOpenCodeCarrierRun), not the
 * spawn: it is what gates the guard block in spawnOpenCode.
 *
 * RUNNER: node:test (`npm run test:server`).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { OPENCODE_CARRIER_PROVIDER_ID } from '@/modules/providers/list/opencode/opencode-models.provider.js';

import { isOpenCodeCarrierRun } from './opencode-cli.js';

const ARMED = { NASSAJ_OPENCODE_CARRIER: '1' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

test('a glm/* model makes an ordinary opencode run a CARRIER run (guards engage)', () => {
  // Exactly the shape the new UI path produces: provider=opencode, model picked
  // from opencode's live catalog, no carrier hint anywhere in the options.
  assert.equal(isOpenCodeCarrierRun({}, ARMED, 'glm/glm-5.2'), true);
  assert.equal(isOpenCodeCarrierRun({}, ARMED, 'glm/glm-5.2[1m]'), true);
});

test('the resolved model wins over a stale options.model (resume case)', () => {
  // resolveResumeModel can replace the requested model with the session's own;
  // the guard decision must follow what is actually passed to --model.
  assert.equal(isOpenCodeCarrierRun({ model: 'anthropic/claude-sonnet-4-5' }, ARMED, 'glm/glm-5.2'), true);
  // ...and an options.model already naming glm is enough on its own.
  assert.equal(isOpenCodeCarrierRun({ model: 'glm/glm-5.2' }, ARMED), true);
});

test('the explicit GL-8 carrier flag still wins on its own (historical glm dispatch)', () => {
  assert.equal(isOpenCodeCarrierRun({ carrier: true }, ARMED), true);
  assert.equal(isOpenCodeCarrierRun({ carrier: true }, ARMED, 'glm/glm-5.2'), true);
});

test('non-GLM opencode models keep the untouched legacy path', () => {
  for (const model of [
    'anthropic/claude-sonnet-4-5',
    'openai/gpt-5.1',
    // Near-misses that must NOT be mistaken for the carrier provider id.
    'opencode/glm-5.2',
    'glmx/glm-5.2',
    'zhipu/glm-5.2',
  ]) {
    assert.equal(isOpenCodeCarrierRun({}, ARMED, model), false, `${model} must not be a carrier run`);
  }
  assert.equal(isOpenCodeCarrierRun({}, ARMED, undefined), false);
  assert.equal(isOpenCodeCarrierRun({}, ARMED, null), false);
});

test('flag OFF is still a hard no on every branch (backward-compatible identity)', () => {
  assert.equal(isOpenCodeCarrierRun({ carrier: true }, OFF), false);
  assert.equal(isOpenCodeCarrierRun({}, OFF, 'glm/glm-5.2'), false);
  assert.equal(isOpenCodeCarrierRun({ model: 'glm/glm-5.2' }, OFF), false);
});

test('B-232: the decision follows the INJECTED env, never the ambient process.env (host-independent)', () => {
  // Relocated from glm-carrier.integration.test.ts, whose original assertion read
  // process.env['NASSAJ_OPENCODE_CARRIER'] directly. That broke — and was the sole
  // failing server test — once the fleet flag legitimately landed in .env on armed
  // hosts: it was testing the HOST, not the code. isOpenCodeCarrierRun takes the env
  // as an ARGUMENT, so the decision must depend ONLY on what is injected. This proves
  // it by forcing the ambient process.env to the OPPOSITE of the injected env in each
  // direction, so it holds whether or not the host has the flag set. Original intent
  // preserved and strengthened: fail-closed by default, and the flag alone never arms
  // a non-GLM turn (AND-semantics).
  const savedHostFlag = process.env.NASSAJ_OPENCODE_CARRIER;
  try {
    // Hostile host: flag ON in process.env. An injected env WITHOUT the flag must
    // STILL be OFF — even for the strongest arming case (a glm/* turn) and even
    // over an explicit options.carrier.
    process.env.NASSAJ_OPENCODE_CARRIER = 'true';
    assert.equal(isOpenCodeCarrierRun({}, OFF, 'glm/glm-5.2'), false,
      'injected env without the flag ⇒ OFF regardless of the host flag (fail-closed default)');
    assert.equal(isOpenCodeCarrierRun({ carrier: true }, OFF), false,
      'injected env without the flag overrides even options.carrier');

    // Hostile host: flag ABSENT in process.env. An injected env WITH the flag must
    // arm a glm/* turn — and the exact literal committed to .env ('true') counts.
    delete process.env.NASSAJ_OPENCODE_CARRIER;
    const injectedOn = { NASSAJ_OPENCODE_CARRIER: 'true' } as NodeJS.ProcessEnv;
    assert.equal(isOpenCodeCarrierRun({}, injectedOn, 'glm/glm-5.2'), true,
      "injected env with the flag ⇒ ON regardless of the host (the .env literal 'true' arms it)");
    // …but the flag alone never arms a non-GLM turn (AND-semantics preserved).
    assert.equal(isOpenCodeCarrierRun({}, injectedOn, 'anthropic/claude-sonnet-4-5'), false,
      'the flag alone must not arm a non-GLM turn');
  } finally {
    if (savedHostFlag === undefined) delete process.env.NASSAJ_OPENCODE_CARRIER;
    else process.env.NASSAJ_OPENCODE_CARRIER = savedHostFlag;
  }
});
