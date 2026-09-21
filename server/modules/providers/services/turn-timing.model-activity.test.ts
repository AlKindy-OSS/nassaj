/**
 * حارس بدء الدور (B-1024): `startedAt` يجب أن يُثبَّت عند **أول** نشاط للنموذج
 * بما فيه كتلة التفكير، لا عند أول نصّ. أوبوس يفكّر ثوانٍ قبل أن يتكلّم؛ لو
 * فتح النصُّ وحده نافذةَ القياس لسقط كامل زمن التفكير من مدة الدور المقيسة.
 * هنا نختبر المُسنِد الصرف `isModelActivity` ومحاكاة دور thinking ثم text عبر
 * `createTurnTimer` الذي يستعمله مسار claude-sdk نفسه.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTurnTimer, isModelActivity } from './turn-timing.service.js';

test('isModelActivity: التفكير والأدوات والدلتا ونصّ المساعد نشاطٌ؛ صدى المستخدم ونتيجة الأداة ليست', () => {
  assert.equal(isModelActivity({ kind: 'thinking' }), true);
  assert.equal(isModelActivity({ kind: 'tool_use' }), true);
  assert.equal(isModelActivity({ kind: 'stream_delta' }), true);
  assert.equal(isModelActivity({ kind: 'text', role: 'assistant' }), true);
  // ليست نشاط نموذج:
  assert.equal(isModelActivity({ kind: 'text', role: 'user' }), false);
  assert.equal(isModelActivity({ kind: 'tool_result' }), false);
  assert.equal(isModelActivity({ kind: 'text' }), false);
  assert.equal(isModelActivity({}), false);
});

test('دور thinking ثم text: البداية تُثبَّت عند التفكير لا عند النصّ', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(Date.parse('2026-09-10T16:02:50.614Z'));
  const timer = createTurnTimer();

  // ترتيب الوصول الفعلي لدور أوبوس: كتلة التفكير أولاً.
  const stream = [
    { kind: 'thinking' },
    { kind: 'text', role: 'assistant' },
  ];

  // أول رسالة (التفكير) عند 16:02:50.614 — تفتح النافذة.
  assert.equal(isModelActivity(stream[0]), true);
  if (isModelActivity(stream[0])) timer.markModelActivity();

  // ثم يمرّ زمن التفكير (~4 ثوانٍ) قبل أن يظهر النصّ.
  t.mock.timers.tick(4_039);
  assert.equal(isModelActivity(stream[1]), true);
  if (isModelActivity(stream[1])) timer.markModelActivity();

  // البداية = لحظة التفكير الأولى، غير مزحزحة بورود النصّ اللاحق.
  assert.equal(timer.startedAt(), '2026-09-10T16:02:50.614Z');
});
