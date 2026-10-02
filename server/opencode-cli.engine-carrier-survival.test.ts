/**
 * opencode-cli.engine-carrier-survival.test.ts — tripwire: GLM and the Qwen
 * Coding Plan still ride the OpenCode carrier after `glm` and `qwen` are deleted
 * as agent bodies.
 *
 *   - the two carrier catalogs are non-empty and are served as `glm/*` and
 *     `qwen-plan/*` rows of the OpenCode listing;
 *   - a run whose RESOLVED model is `glm/*` or `qwen-plan/*` is recognized as a
 *     carrier run, which is what engages the carrier guards in the launcher.
 *
 * Pins the decision functions and the catalog merge; the guarded spawn itself is
 * covered by opencode-cli.qwen-plan.test.ts and glm-carrier.integration.test.ts.
 *
 * Runner: node:test (`npm run test:server -- <this file>`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGlmCarrierModelOptions,
  OPENCODE_CARRIER_PROVIDER_ID,
  withGlmCarrierModels,
  withQwenPlanModels,
} from '@/modules/providers/list/opencode/opencode-models.provider.js';
import { GLM_CARRIER_MODELS } from '@/modules/providers/shared/vendor/vendor-config.js';
import {
  isQwenPlanModel,
  QWEN_PLAN_KEY_ENV,
  QWEN_PLAN_MODEL_PREFIX,
  QWEN_PLAN_MODELS,
  withQwenPlanEnv,
} from '@/services/isolation/opencode-qwen-plan.js';

import { isOpenCodeCarrierRun } from './opencode-cli.js';

describe('OpenCode carrier: GLM and the Qwen Coding Plan still ride it', () => {
  const ARMED = { NASSAJ_OPENCODE_CARRIER: '1' } as NodeJS.ProcessEnv;
  const glmModelIds = Object.keys(GLM_CARRIER_MODELS);

  it('keeps a non-empty GLM carrier catalog and serves it as glm/* rows', () => {
    assert.ok(glmModelIds.length > 0, 'GLM_CARRIER_MODELS must not be empty');
    assert.equal(OPENCODE_CARRIER_PROVIDER_ID, 'glm');
    assert.deepEqual(
      buildGlmCarrierModelOptions().map((option) => option.value),
      glmModelIds.map((id) => `glm/${id}`),
    );

    const live = { OPTIONS: [{ value: 'opencode/big-pickle', label: 'Big Pickle' }], DEFAULT: 'opencode/big-pickle' };
    const merged = withGlmCarrierModels(live, ARMED);
    assert.equal(merged.DEFAULT, 'opencode/big-pickle', 'the carrier never takes over the default');
    for (const id of glmModelIds) {
      assert.ok(merged.OPTIONS.some((option) => option.value === `glm/${id}`), `glm/${id} must be offered`);
    }
    assert.deepEqual(withGlmCarrierModels(live, {}), live, 'flag off leaves the catalog untouched');
  });

  it('detects the carrier from a resolved glm/* model', () => {
    for (const id of glmModelIds) {
      assert.equal(isOpenCodeCarrierRun({}, ARMED, `glm/${id}`), true, `glm/${id} must engage the carrier guards`);
    }
    assert.equal(isOpenCodeCarrierRun({ model: 'anthropic/claude-sonnet-4-5' }, ARMED, `glm/${glmModelIds[0]}`), true);
    assert.equal(isOpenCodeCarrierRun({}, ARMED, 'opencode/glm-5.2'), false);
    assert.equal(isOpenCodeCarrierRun({}, {}, `glm/${glmModelIds[0]}`), false, 'flag off is a hard no');
  });

  it('keeps the Qwen plan catalog and serves it as qwen-plan/* rows to a compatible profile', () => {
    assert.ok(QWEN_PLAN_MODELS.length > 0, 'QWEN_PLAN_MODELS must not be empty');
    assert.equal(QWEN_PLAN_MODEL_PREFIX, 'qwen-plan/');
    for (const model of QWEN_PLAN_MODELS) {
      assert.equal(typeof model.value, 'string');
      assert.equal(typeof model.label, 'string');
    }

    const live = { OPTIONS: [{ value: 'opencode/big-pickle', label: 'Big Pickle' }], DEFAULT: 'opencode/big-pickle' };
    const armed = { NASSAJ_OPENCODE_QWEN_PLAN: '1' } as NodeJS.ProcessEnv;
    const profile = { plan: 'coding_plan', region: 'international', key: 'sk-sp-member' };

    const offered = withQwenPlanModels(live, profile, armed);
    assert.deepEqual(
      offered.OPTIONS.filter((option) => isQwenPlanModel(option.value)).map((option) => option.value),
      QWEN_PLAN_MODELS.map((model) => `qwen-plan/${model.value}`),
    );
    assert.equal(offered.DEFAULT, 'opencode/big-pickle');

    const withheld = withQwenPlanModels(live, null, armed);
    assert.equal(withheld.OPTIONS.some((option) => isQwenPlanModel(option.value)), false, 'no key, no rows');
    const disarmed = withQwenPlanModels(live, profile, {});
    assert.equal(disarmed.OPTIONS.some((option) => isQwenPlanModel(option.value)), false, 'flag off, no rows');
  });

  it('detects the carrier from a resolved qwen-plan/* model and carries the key in one variable', () => {
    for (const model of QWEN_PLAN_MODELS) {
      assert.equal(isQwenPlanModel(`qwen-plan/${model.value}`), true);
    }
    assert.equal(isQwenPlanModel('opencode/qwen3-coder-plus'), false);
    assert.equal(isQwenPlanModel('glm/glm-5.2'), false);

    const child = withQwenPlanEnv({ PATH: '/usr/bin' }, 'sk-sp-member');
    assert.equal(child[QWEN_PLAN_KEY_ENV], 'sk-sp-member');
    assert.equal(QWEN_PLAN_KEY_ENV, 'NASSAJ_QWEN_PLAN_API_KEY');
  });
});
