import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStickyEffortMode } from './stickyEffortMode';

const KNOWN = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;
const DEFAULT_MODE = 'medium';

const decide = (overrides: Partial<Parameters<typeof resolveStickyEffortMode>[0]>) =>
  resolveStickyEffortMode({
    sessionId: 'sess-1',
    previousSessionId: 'sess-1',
    isFirstRun: false,
    storedMode: null,
    knownModeIds: KNOWN,
    defaultMode: DEFAULT_MODE,
    ...overrides,
  });

test('محادثة جديدة بلا مُعرِّف: لا استعادة ولا تصفير', () => {
  assert.deepEqual(
    decide({ sessionId: null, previousSessionId: null, isFirstRun: true }),
    { action: 'keep' },
  );
});

test('العطل المُبلَّغ عنه: ولادة المُعرِّف بعد أول إرسال لا تمسح الاختيار', () => {
  // المستخدم اختار max ثم أرسل أول رسالة، فوُلد مُعرِّف الجلسة (null ← id).
  // أي 'apply' هنا يعني عودة المستوى للافتراضي أمام عين المستخدم.
  assert.deepEqual(
    decide({ sessionId: 'sess-new', previousSessionId: null, isFirstRun: false }),
    { action: 'keep' },
  );
});

test('إعادة تحميل الصفحة على محادثة قائمة تستعيد المخزَّن', () => {
  assert.deepEqual(
    decide({ sessionId: 'sess-1', previousSessionId: null, isFirstRun: true, storedMode: 'high' }),
    { action: 'apply', mode: 'high' },
  );
});

test('فتح محادثة بلا مخزَّن يُنزلها على الافتراضي لا على مستوى المحادثة السابقة', () => {
  assert.deepEqual(
    decide({ sessionId: 'sess-b', previousSessionId: 'sess-a', storedMode: null }),
    { action: 'apply', mode: DEFAULT_MODE },
  );
});

test('التبديل بين محادثتين يستعيد مخزَّن كلٍّ منهما', () => {
  assert.deepEqual(
    decide({ sessionId: 'sess-b', previousSessionId: 'sess-a', storedMode: 'low' }),
    { action: 'apply', mode: 'low' },
  );
});

test('إعادة التشغيل على نفس المحادثة لا تلمس اختياراً حديثاً', () => {
  // الأثر قد يُعاد تشغيله (StrictMode أو إعادة تصيير) بينما المستخدم رفع المستوى
  // للتوّ ولم يُكتَب بعد؛ استعادة المخزَّن حينها تتراجع عن اختياره.
  assert.deepEqual(
    decide({ sessionId: 'sess-1', previousSessionId: 'sess-1', storedMode: 'none' }),
    { action: 'keep' },
  );
});

test('قيمة مخزَّنة فاسدة أو من فضاء مزوّد آخر تُهمَل لصالح الافتراضي', () => {
  assert.deepEqual(
    decide({ sessionId: 'sess-b', previousSessionId: 'sess-a', storedMode: 'ludicrous' }),
    { action: 'apply', mode: DEFAULT_MODE },
  );
  // codex لا يعرف ultracode: قائمة المزوّد المحصورة تُسقطها فتؤول للافتراضي.
  assert.deepEqual(
    decide({
      sessionId: 'sess-b',
      previousSessionId: 'sess-a',
      storedMode: 'ultracode',
      knownModeIds: ['none', 'low', 'medium', 'high'],
    }),
    { action: 'apply', mode: DEFAULT_MODE },
  );
});

test('المخزَّن "none" قيمة مشروعة لا تُقرأ فراغاً', () => {
  // 'none' زائف منطقياً (falsy-looking) — أي فحص بـ Boolean(stored) يبتلعه
  // ويُرجع الافتراضي، فيُفقد اختيار المستخدم الصريح بإطفاء التفكير.
  assert.deepEqual(
    decide({ sessionId: 'sess-b', previousSessionId: 'sess-a', storedMode: 'none' }),
    { action: 'apply', mode: 'none' },
  );
});
