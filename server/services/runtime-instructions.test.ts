/**
 * T-1804 — كلُّ مُشعِلٍ يمرّ بالواجهة التي تحلّ مسار الناشر، لا بالوحدة النقيّة.
 *
 * العطبُ الذي يقفله هذا الملفّ ليس منطقيّاً بل «تسرُّبُ استيراد»: مُشعِلٌ واحد
 * يستورد `shared/documentSharingInstructions.js` مباشرةً يستقبل المُعامل
 * الافتراضي `null`، فيُحقن في جولاته سطرُ المنع بلا أمرٍ بديل بينما تحصل بقيّة
 * المزوّدات على الأمر — فرقٌ صامتٌ لا يكشفه اختبارُ نصٍّ ولا typecheck.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { getRuntimeInstructions, withRuntimeInstructions } from './runtime-instructions.js';
import { resolvePublicPagePublisher } from './public-page-agent-guidance.js';

/** المُشعِلات العشرة، بمسارها من جذر المستودع. */
const LAUNCHERS = [
  'server/claude-sdk.js', 'server/openai-codex.js', 'server/agy-cli.js', 'server/hermes-cli.js',
  'server/opencode-cli.js', 'server/qwen-cli.js', 'server/kimi-agent-cli.js', 'server/cursor-cli.js',
  'server/gemini-cli.js', 'server/modules/providers/shared/vendor/vendor-runtime.js',
];

test('every launcher imports the resolving facade, and none the pure module directly', () => {
  for (const launcher of LAUNCHERS) {
    const source = readFileSync(new URL(`../../${launcher}`, import.meta.url), 'utf8');
    assert.match(source, /RuntimeInstructions[^\n]*from '[^']*runtime-instructions\.js'/, launcher);
    assert.doesNotMatch(source, /from '[^']*documentSharingInstructions\.js'/, `${launcher}: تجاوزَ الحلّ`);
  }
});

test('the facade injects this host’s resolved publisher, not a relative path', () => {
  const resolved = resolvePublicPagePublisher();
  const instructions = getRuntimeInstructions('delegate');
  assert.doesNotMatch(instructions, /node scripts\//, 'مسارٌ نسبيّ لا يعمل من cwd الوكيل');
  if (resolved) {
    assert.ok(instructions.includes(`node ${resolved} publish`), 'الأمر المحقون ليس مسار هذا الجهاز');
    assert.ok(withRuntimeInstructions('مرحبا', 'direct').includes(resolved), 'قناة المطالبة تخلّفت عن القناة الأصيلة');
  } else {
    assert.doesNotMatch(instructions, /public-page-publish/, 'وعدٌ بأداةٍ غائبة');
  }
});
