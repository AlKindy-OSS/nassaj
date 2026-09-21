/**
 * hermes-runtime.test.ts — B-403 / B-404 / T-1198.
 *
 * The fixtures below are LIFTED FROM THE OPERATOR'S REAL `~/.hermes` tree as it
 * stood on 2026-08-03 (the incident state: `credential_pool.copilot` populated,
 * `providers.nous` holding `invalid_grant` and no token). Synthetic fixtures are
 * exactly how the old badge passed review while lying in production.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseHermesModelBlock,
  readHermesCachedModels,
  readHermesRuntimeConfig,
  selectHermesCredential,
} from '@/modules/providers/list/hermes/hermes-runtime.js';

// Verbatim head of the real config.yaml after `hermes config set`.
const REAL_CONFIG = `model:
  default: gpt-4o
  provider: copilot
  base_url: https://inference-api.nousresearch.com/v1
providers: {}
fallback_providers: []
`;

// Verbatim shape of the real auth.json at the moment the badge said "Connected".
const REAL_AUTH = {
  providers: {
    nous: {
      client_id: 'hermes-cli',
      token_type: 'Bearer',
      last_auth_error: {
        provider: 'nous',
        code: 'invalid_grant',
        message: 'Invalid refresh token',
        relogin_required: true,
      },
    },
  },
  credential_pool: {
    nous: [],
    copilot: [{ source: 'gh_cli', type: 'api_key' }],
  },
};

const withHome = async (fn: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hermes-runtime-'));
  try {
    await mkdir(path.join(home, '.hermes'), { recursive: true });
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

test('parseHermesModelBlock: يقرأ provider وdefault من الكتلة الحقيقية', () => {
  assert.deepEqual(parseHermesModelBlock(REAL_CONFIG), {
    provider: 'copilot',
    defaultModel: 'gpt-4o',
  });
});

test('parseHermesModelBlock: يتوقف عند نهاية الكتلة فلا يلتقط مفاتيح غيرها', () => {
  const yaml = 'model:\n  provider: nous\nagent:\n  provider: SHOULD_NOT_WIN\n';
  assert.equal(parseHermesModelBlock(yaml).provider, 'nous');
});

test('parseHermesModelBlock: ملف بلا كتلة model يعطي null لا قيمة مخترعة', () => {
  assert.deepEqual(parseHermesModelBlock('toolsets:\n- hermes-cli\n'), {
    provider: null,
    defaultModel: null,
  });
});

test('readHermesRuntimeConfig: غياب الملف لا يرمي — يعود بـnull', async () => {
  await withHome(async (home) => {
    assert.deepEqual(await readHermesRuntimeConfig(home), { provider: null, defaultModel: null });
  });
});

test('readHermesCachedModels: يعيد معرّفات هرمز المجرّدة للمزوّد المطلوب', async () => {
  await withHome(async (home) => {
    await writeFile(
      path.join(home, '.hermes', 'provider_models_cache.json'),
      JSON.stringify({ copilot: { models: ['gpt-4o', 'gpt-5.5'] }, anthropic: { models: ['x'] } }),
      'utf8',
    );
    assert.deepEqual(await readHermesCachedModels('copilot', home), ['gpt-4o', 'gpt-5.5']);
    assert.deepEqual(await readHermesCachedModels('nous', home), []);
    assert.deepEqual(await readHermesCachedModels(null, home), []);
  });
});

test('B-404: اعتماد copilot لا يُصادِق على تشغيل nous', () => {
  const verdict = selectHermesCredential(REAL_AUTH, 'nous');
  assert.equal(verdict.authenticated, false);
  assert.match(verdict.error ?? '', /Invalid refresh token/);
  assert.match(verdict.error ?? '', /^nous:/);
});

test('B-404: نفس الملف يُصادِق حين يكون مزوّد التشغيل copilot فعلاً', () => {
  const verdict = selectHermesCredential(REAL_AUTH, 'copilot');
  assert.equal(verdict.authenticated, true);
  assert.equal(verdict.email, 'copilot credentials');
});

test('B-404: مزوّد تشغيل مجهول (config غير مقروء) يبقى fail-open على أي اعتماد', () => {
  assert.equal(selectHermesCredential(REAL_AUTH, null).authenticated, true);
});

test('B-404: مزوّد تشغيل بلا اعتماد ولا خطأ مخزَّن يعطي سبباً صريحاً', () => {
  const verdict = selectHermesCredential({ providers: {}, credential_pool: {} }, 'copilot');
  assert.equal(verdict.authenticated, false);
  assert.match(verdict.error ?? '', /copilot/);
});

/**
 * سبب الحكم يُعرض حرفياً في بطاقة الحساب — وهي واجهة مترجَمة. أي جملة بلغة
 * مثبَّتة هنا تخترق i18n وتظهر عربيةً وسط صفحة إنجليزية (وبالعكس). ما يمرّ من
 * هذه الطبقة هو حقيقة المزوّد بصياغته وحده، والنصيحة تُصاغ في العميل.
 */
test('سبب الحكم لا يحمل نصّاً بلغة مثبَّتة يخترق i18n', () => {
  const arabic = /[؀-ۿ]/;
  for (const verdict of [
    selectHermesCredential(REAL_AUTH, 'nous'),
    selectHermesCredential({ providers: {}, credential_pool: {} }, 'copilot'),
    selectHermesCredential({}, null),
  ]) {
    assert.doesNotMatch(verdict.error ?? '', arabic);
  }
});
