/**
 * claude-active-model-sentinel.test.ts — B-313
 *
 * الجلسة كانت تُبلِّغ عن نموذجها الفعّال بـ`<synthetic>` — وهو وسم يكتبه Claude
 * Code على صفوفه المولَّدة ذاتياً (إشعار الحصّة، المقاطعة، خطأ الـAPI) لا معرّف
 * نموذج. القارئ يمشي من آخر السطور فيأخذ أول `model` يجده، فأي جلسة انتهت على
 * إشعار كهذا تُبلِّغ عن الوسم — ويسري في الدور التالي عبر resolveResumeModel
 * كوسيط `--model` فعليّ.
 *
 * ## أصل الـfixture (لا أشكال مصطنعة — درس 2026-06-28)
 * السطور أدناه مأخوذة **بشكلها الحقيقي** من
 * ~/.claude/projects/<project-slug>/<session-id>.jsonl
 * (مقيس 2026-07-30: 5 من 179 نصّاً محلياً آخرُ صفٍّ فيها يحمل نموذجاً هو
 * `<synthetic>`)، وقُصِّر نصّ الرسالة فقط.
 *
 * Run: node --import tsx/esm --test server/modules/providers/list/claude/__tests__/claude-active-model-sentinel.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { __readClaudeSessionModelFromJsonlForTests as readModel } from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = '00000001-0000-4000-8000-000000000001';

/** صفّ مساعد حقيقي بنموذج حقيقي. */
const realAssistantRow = (model: string) => JSON.stringify({
  type: 'assistant',
  uuid: 'aaa11111-2222-3333-4444-555566667777',
  sessionId: SESSION_ID,
  timestamp: '2026-07-12T07:05:00.000Z',
  message: {
    id: 'msg_real',
    model,
    role: 'assistant',
    type: 'message',
    content: [{ type: 'text', text: 'ok' }],
  },
});

/** صفّ Claude Code المولَّد ذاتياً — إشعار الحصّة، بوسم `<synthetic>`. */
const syntheticRow = JSON.stringify({
  type: 'assistant',
  uuid: '00000002-0000-4000-8000-000000000002',
  sessionId: SESSION_ID,
  timestamp: '2026-07-12T07:06:48.320Z',
  message: {
    id: '00000003-0000-4000-8000-000000000003',
    model: '<synthetic>',
    role: 'assistant',
    stop_reason: 'stop_sequence',
    type: 'message',
    content: [{ type: 'text', text: "You've reached your Fable 5 limit." }],
  },
});

const userRow = JSON.stringify({
  type: 'user',
  sessionId: SESSION_ID,
  message: { role: 'user', content: 'مرحباً' },
});

const withTranscript = async (
  lines: string[],
  run: (jsonlPath: string) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-active-model-'));
  const jsonlPath = path.join(dir, `${SESSION_ID}.jsonl`);
  await writeFile(jsonlPath, `${lines.join('\n')}\n`, 'utf8');
  try {
    await run(jsonlPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('B-313: صفّ <synthetic> الأخير لا يُبلَّغ نموذجاً — يُرجَع آخر نموذج حقيقي قبله', async () => {
  await withTranscript([userRow, realAssistantRow('claude-opus-4-8'), syntheticRow], async (p) => {
    assert.deepEqual(await readModel(SESSION_ID, p), { model: 'claude-opus-4-8' });
  });
});

test('B-313: نصّ لا يحوي إلا صفّاً مولَّداً ⇒ null (فيسقط المتصل على افتراضي المزوّد لا على الوسم)', async () => {
  await withTranscript([userRow, syntheticRow], async (p) => {
    assert.equal(await readModel(SESSION_ID, p), null);
  });
});

test('B-313: أي وسم بين قوسين زاويّتين مرفوض، لا `<synthetic>` وحده', async () => {
  const otherSentinel = syntheticRow.replace('<synthetic>', '<none>');
  await withTranscript([userRow, realAssistantRow('sonnet'), otherSentinel], async (p) => {
    assert.deepEqual(await readModel(SESSION_ID, p), { model: 'sonnet' });
  });
});

test('لا انحدار: نصّ بنماذج حقيقية فقط يُعيد الأحدث (آخر صفّ)', async () => {
  await withTranscript(
    [userRow, realAssistantRow('sonnet'), realAssistantRow('claude-opus-5')],
    async (p) => {
      assert.deepEqual(await readModel(SESSION_ID, p), { model: 'claude-opus-5' });
    },
  );
});

test('لا انحدار: معرّف نموذج جديد غير مُدرَج في الكتالوج يُمرَّر كما هو (درس B-235)', async () => {
  await withTranscript([userRow, realAssistantRow('claude-opus-9-future')], async (p) => {
    assert.deepEqual(await readModel(SESSION_ID, p), { model: 'claude-opus-9-future' });
  });
});
