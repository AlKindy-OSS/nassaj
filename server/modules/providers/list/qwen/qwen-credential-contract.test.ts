import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createQwenCredentialProfile,
  providerSecretsService,
} from '../../services/provider-secrets.service.js';

import { qwenModelsForPlan } from './qwen.provider.js';

test('Qwen credential has no anonymous/operator-wide write or delete path', () => {
  assert.throws(
    () => providerSecretsService.setKey(null, 'qwen', 'token-plan-personal-key'),
    /authenticated member/,
  );
  assert.throws(
    () => providerSecretsService.deleteKey(undefined, 'qwen'),
    /no operator-wide credential slot/,
  );
});

test('ADR-200 S7: every saved profile is Token Plan, international region, any key prefix', () => {
  for (const key of ['token-plan-personal-key-42', 'sk-sp-personal-key-41', 'sk-anything-0123456789']) {
    assert.deepEqual(createQwenCredentialProfile(key), {
      version: 1,
      plan: 'token_plan',
      region: 'international',
      key,
    });
  }
});

test('rejects malformed Token Plan keys', () => {
  assert.throws(() => createQwenCredentialProfile('token plan key with spaces'), /without whitespace/);
  assert.throws(() => createQwenCredentialProfile('short'), /16–512/);
  assert.throws(() => createQwenCredentialProfile(`k${'a'.repeat(512)}`), /16–512/);
  assert.throws(() => createQwenCredentialProfile(undefined), /16–512/);
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
