/**
 * transcript-parser.models.test.ts — B-352
 *
 * الخاصية تحت الاختبار: جلسةٌ غيّرت نموذجها وسط المحادثة تُعيد **كل** نماذجها،
 * بترتيب أول ظهور، وبعدد أدوارٍ حقيقي لكل واحد.
 *
 * الـfixture مشتقّ من transcript إنتاج فعلي (الجلسة
 * 00000001-0000-4000-8000-000000000001: ‏kimi-k3 → kimi-k2.6 → claude-opus-5
 * بنفس معرّف الجلسة) لا من بنية مؤلَّفة: نصوص الرسائل ومدخلات الأدوات وحدها
 * مُنقّاة، أما أغلفة الصفوف وحقولها فكما كتبها الـSDK. درس حادثة 2026-06-28:
 * fixtures مصطنعة تُمرِّر اختباراً أخضر على شكلٍ لا وجود له في الإنتاج.
 *
 * أُعيد اشتقاقه (‏B-397) بصفوف `user` حقيقية: نسخته الأولى جُرِّدت منها كلياً،
 * فكانت تُثبِّت العدّ بإدخالات assistant لأنه المقياس الوحيد الممكن على شكلٍ بلا
 * أدوار — وهو المقياس الذي أنتج «×100» في الرأس. الدرس نفسه مطبَّقاً على نفسه:
 * fixture ناقص البنية يجعل الاختبار يحرس السلوك الخطأ بثقة.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json --test \
 *        server/services/__tests__/transcript-parser.models.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseClaudeStyleTranscript } from '../transcript-parser.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'multi-model-session.jsonl',
);

test('B-352 — يُعيد كل نموذج أجاب في الجلسة، لا الأول وحده', async () => {
  const agents = await parseClaudeStyleTranscript(FIXTURE);
  const models = agents.filter((a) => a.agent_kind === 'model');

  assert.deepEqual(
    models.map((m) => m.agent_name),
    ['kimi-k3', 'kimi-k2.6', 'claude-opus-5'],
    'الترتيب = أول ظهور في الـtranscript، فيقرأ الصفّ كتاريخ المحادثة',
  );
});

test('B-352 — عدد الأدوار الحقيقي لكل نموذج، لا 1 ثابتة', async () => {
  const agents = await parseClaudeStyleTranscript(FIXTURE);
  const byName = new Map(agents.map((a) => [a.agent_name, a.invocation_count]));

  assert.equal(byName.get('kimi-k3'), 2);
  assert.equal(byName.get('kimi-k2.6'), 1);
  assert.equal(byName.get('claude-opus-5'), 2);
});

test('العدّ بالأدوار لا بإدخالات assistant — دورٌ أداتيّ واحد يبقى واحداً', async () => {
  const agents = await parseClaudeStyleTranscript(FIXTURE);
  const byName = new Map(agents.map((a) => [a.agent_name, a.invocation_count]));

  // الـfixture يمنح kimi-k3 دورين: الأول إدخالان، والثاني ينفق **خمسة** إدخالات
  // assistant على استدعاءات أدوات. العدّ القديم (إدخالاً إدخالاً) كان يقول ×7؛
  // وهذا ما جعل محادثةً من سؤالين تُعلن «×100» في الرأس والقارئ يرى ردّين.
  const k3Entries = readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: { model?: string } })
    .filter((e) => e.type === 'assistant' && e.message?.model === 'kimi-k3').length;

  assert.equal(k3Entries, 7, 'الـfixture فعلاً يحوي سبعة إدخالات assistant لـkimi-k3');
  assert.equal(byName.get('kimi-k3'), 2, 'لكنها دوران اثنان — والعدّاد يقول اثنين');
});

test('B-352 — النموذج الاصطناعي <synthetic> لا يُحسَب نموذجاً', async () => {
  const agents = await parseClaudeStyleTranscript(FIXTURE);
  assert.equal(
    agents.some((a) => a.agent_name === '<synthetic>'),
    false,
    'الـSDK يكتبه للأدوار الأداتية/المقطوعة — ليس مُجيباً',
  );
});

test('B-352 — كل صفّ نموذج يحمل agent_model مطابقاً لاسمه', async () => {
  const agents = await parseClaudeStyleTranscript(FIXTURE);
  for (const model of agents.filter((a) => a.agent_kind === 'model')) {
    assert.equal(model.agent_model, model.agent_name);
  }
});
