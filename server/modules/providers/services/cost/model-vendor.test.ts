import assert from 'node:assert/strict';
import test from 'node:test';

import {
  harnessVendor,
  resolveModelVendor,
  vendorDisplayName,
} from '@/modules/providers/services/cost/model-vendor.js';

test('العطل المُبلَّغ عنه: GLM عبر حامل opencode يُنسب إلى GLM لا إلى الحامل', () => {
  // التسمية الحقيقية التي يُخرجها مُستخرِج قاعدة opencode لصفّ حقيقي:
  // {"id":"glm-5.2","providerID":"glm"} ⇒ "glm/glm-5.2".
  assert.equal(resolveModelVendor('glm/glm-5.2', 'opencode'), 'glm');
  assert.equal(resolveModelVendor('glm/glm-5.2[1m]', 'opencode'), 'glm');
});

test('نماذج بوّابة OpenCode Zen تبقى لـOpenCode — الاسم واحد والمعنى مختلف', () => {
  // هنا الحامل والمورّد يتصادفان: البوّابة المستضافة تُدفع فعلاً.
  assert.equal(resolveModelVendor('opencode/big-pickle', 'opencode'), 'opencode-zen');
  assert.equal(resolveModelVendor('opencode/deepseek-v4-flash-free', 'opencode'), 'opencode-zen');
});

test('نموذج مرّ بحامل ولم يُعرف مورّده يبقى unknown ولا يُلحَق بالحامل', () => {
  // إلحاقه بـOpenCode Zen كان سيضخّم فاتورة اشتراك لم يُستهلك منه شيء.
  assert.equal(resolveModelVendor('mystery-model-9', 'opencode'), 'unknown');
  assert.equal(harnessVendor('opencode'), null, 'الحامل لا مورّد طبيعي له');
});

test('اسم النموذج وحده يكفي حين لا بادئة حامل', () => {
  assert.equal(resolveModelVendor('claude-opus-5'), 'anthropic');
  assert.equal(resolveModelVendor('claude-fable-5'), 'anthropic');
  assert.equal(resolveModelVendor('gpt-5.6-sol'), 'openai');
  assert.equal(resolveModelVendor('gemini-3.1-pro-preview'), 'google');
  assert.equal(resolveModelVendor('glm-5.2'), 'glm');
  assert.equal(resolveModelVendor('kimi-k3'), 'moonshot');
  assert.equal(resolveModelVendor('deepseek-v4-pro'), 'deepseek');
});

test('البادئة المكتوبة من المزوّد تغلب اسم النموذج', () => {
  // نموذج أنثروبيك يُقدَّم عبر بوّابة أخرى: من يُدفع له هو صاحب البادئة.
  assert.equal(resolveModelVendor('anthropic/claude-fable-5', 'opencode'), 'anthropic');
  // وبالعكس: بادئة glm على اسم لا يبدأ بـglm.
  assert.equal(resolveModelVendor('glm/some-internal-name', 'opencode'), 'glm');
});

test('الجسم ملاذ أخير لا أول: كودكس يخدم gpt، وأنتيغرافيتي جوجل', () => {
  assert.equal(resolveModelVendor('', 'codex'), 'openai');
  assert.equal(resolveModelVendor('unnamed', 'antigravity'), 'google');
  assert.equal(resolveModelVendor('unnamed', 'claude'), 'anthropic');
  // بلا جسم ولا اسم معروف: unknown، لا افتراض.
  assert.equal(resolveModelVendor('unnamed'), 'unknown');
});

test('نموذج كلود شُغِّل عبر حامل opencode يُحسب على اشتراك كلود', () => {
  // صفّ حقيقي في قاعدة opencode: providerID=opencode ولكن الاسم claude-fable-5.
  // البادئة تقول البوّابة، وهي من يُدفع لها في هذه الحالة تحديداً.
  assert.equal(resolveModelVendor('opencode/claude-fable-5', 'opencode'), 'opencode-zen');
  // أمّا حين تُصرّح البادئة بأنثروبيك فالحساب على كلود.
  assert.equal(resolveModelVendor('anthropic/claude-fable-5', 'opencode'), 'anthropic');
});

test('أسماء العرض ثابتة ومقروءة', () => {
  assert.equal(vendorDisplayName('anthropic'), 'Claude');
  assert.equal(vendorDisplayName('glm'), 'GLM');
  assert.equal(vendorDisplayName('opencode-zen'), 'OpenCode Zen');
});

// ---------------------------------------------------------------------------
// حارس الانحدار للعطل المُبلَّغ عنه: بطاقة الاشتراك تتبع المورّد لا الجسم.
// ---------------------------------------------------------------------------

test('محادثة حامل واحدة تُوزَّع على مورّديها لا تُنسب كلها إلى الحامل', () => {
  // النماذج الحقيقية في قاعدة opencode على هذا الجهاز.
  const rows = [
    'glm/glm-5.2',
    'glm/glm-5.2[1m]',
    'opencode/big-pickle',
    'opencode/deepseek-v4-flash-free',
    'anthropic/claude-fable-5',
  ];

  const byVendor = new Map<string, string[]>();
  for (const model of rows) {
    const vendor = resolveModelVendor(model, 'opencode');
    byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), model]);
  }

  // ثلاثة مورّدين من جسم واحد — وهذا بالضبط ما كان ينهار حين كانت البطاقة
  // تُبنى على الجسم: كان الكل يُعدّ «OpenCode» وتظهر بطاقة GLM فارغة.
  assert.deepEqual([...byVendor.keys()].sort(), ['anthropic', 'glm', 'opencode-zen']);
  assert.equal(byVendor.get('glm')?.length, 2);
  assert.equal(byVendor.get('opencode-zen')?.length, 2);
  assert.equal(byVendor.get('anthropic')?.length, 1);
});
