/**
 * T-1804 — قفلُ الترتيب: قاعدة النشر العام فوق فحص `bypassPermissions`.
 *
 * لماذا اختبارُ مصدرٍ لا اختبارُ سلوك: الـ`canUseTool` التفاعليّ يُركَّب داخل
 * `runClaudeSDKQuery` على جلسةٍ حيّة بمقبسٍ ومُصادقةٍ وعمليةِ CLI، فلا يُستخرج
 * وحدةً. والخطرُ الحقيقيّ ليس منطقَ القاعدة (مغطّى وحدويّاً في
 * `services/public-page-agent-guidance.test.ts`) بل **موضعُها**: `bypassPermissions`
 * يُرجِع `allow` باكراً، فسطرٌ واحدٌ ينزلق تحته يجعل القاعدة كوداً ميّتاً في
 * الوضع الذي يحتاجها أكثر من غيره — وهي بعينها حادثة `cleanSpawnEnv` وسياج
 * المحرّك T-1209. ما يُقاس هنا هو ذلك الانزلاق.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./claude-sdk.js', import.meta.url), 'utf8');

test('the public-page rule sits ABOVE the bypassPermissions early allow', () => {
  const cage = source.indexOf('const publicPageVerdict = evaluatePublicPageWrite(');
  const bypass = source.indexOf("if (sdkOptions.permissionMode === 'bypassPermissions') {", cage);
  assert.ok(cage > 0, 'القاعدة غائبة عن مسار الجلسة التفاعلية');
  assert.ok(bypass > cage, 'انزلقت القاعدة تحت bypass فصارت كوداً ميّتاً هناك');
});

test('the refusal goes through the logged deny path, like every other gate here', () => {
  assert.match(source, /denyWithLog\(publicPageVerdict\.message, 'public-page-build-output'\)/);
});

test('the interactive callback is the only place the cage is wired', () => {
  assert.equal(source.split('evaluatePublicPageWrite(').length - 1, 1, 'استدعاءٌ واحد لا غير');
});
