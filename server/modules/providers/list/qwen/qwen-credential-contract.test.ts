import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQwenCredentialProfile,
  isQwenCodingPlanKey,
  providerSecretsService,
} from '../../services/provider-secrets.service.js';

import { qwenModelsForPlan } from './qwen.provider.js';

test('performs bounded syntax-only validation for personal Coding Plan keys', () => {
  assert.equal(isQwenCodingPlanKey('sk-sp-personal_123.ABC'), true);
  assert.equal(isQwenCodingPlanKey('sk-api-metered'), false);
  assert.equal(isQwenCodingPlanKey('sk-sp-'), false);
  assert.equal(isQwenCodingPlanKey('sk-sp-secret with spaces'), false);
  assert.equal(isQwenCodingPlanKey(`sk-sp-${'a'.repeat(507)}`), false);
});

test('Qwen credential has no anonymous/operator-wide write or delete path', () => {
  assert.throws(
    () => providerSecretsService.setKey(null, 'qwen', 'sk-sp-personal-key'),
    /authenticated member/,
  );
  assert.throws(
    () => providerSecretsService.deleteKey(undefined, 'qwen'),
    /no operator-wide credential slot/,
  );
});

test('stores Coding and Token Plan profiles with explicit region metadata', () => {
  assert.deepEqual(createQwenCredentialProfile(
    'sk-sp-personal-key-41', 'coding_plan', 'china',
  ), {
    version: 1,
    plan: 'coding_plan',
    region: 'china',
    key: 'sk-sp-personal-key-41',
  });

  assert.deepEqual(createQwenCredentialProfile(
    'token-plan-personal-key-42', 'token_plan', 'international',
  ), {
    version: 1,
    plan: 'token_plan',
    region: 'international',
    key: 'token-plan-personal-key-42',
  });
});

test('rejects ambiguous or malformed Qwen profiles', () => {
  assert.throws(
    () => createQwenCredentialProfile('sk-sp-personal-key-43', 'unknown', 'international'),
    /plan must be/,
  );
  assert.throws(
    () => createQwenCredentialProfile('token plan key with spaces', 'token_plan', 'international'),
    /without whitespace/,
  );
});

test('each Qwen plan default is present in its own catalog', () => {
  for (const plan of ['coding_plan', 'token_plan'] as const) {
    const models = qwenModelsForPlan(plan);
    assert.equal(models.OPTIONS.some((option) => option.value === models.DEFAULT), true);
  }
  assert.equal(
    qwenModelsForPlan('token_plan').OPTIONS.some((option) => option.value === 'qwen3-coder-plus'),
    false,
  );
});
