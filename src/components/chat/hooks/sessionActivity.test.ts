/**
 * B-208 — اختبارات وحدة لمصدر الحقيقة العميلي لحالة نشاط الجلسة.
 *
 * يغطّي بندين إلزاميين من المواصفة:
 *   - بند 5: **حارس epoch** — لقطة REST تعود بعد حدث سُلطوي (complete / error /
 *     session-status) تُهمَل. بدونه: إجابة «نشطة» تصل بعد `complete` تُبقي
 *     `isLoading = true` إلى الأبد.
 *   - بند 2: **ترميز الحقيقة** — غياب `isProcessing` = غير نشطة. لا «امسح فقط
 *     عند false صريح».
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import assert from 'node:assert/strict';

import { beforeEach, describe, it } from 'vitest';

import {
  bumpSessionActivityEpoch,
  readIsProcessing,
  readSessionActivityEpoch,
  resetSessionActivityEpochs,
  runSessionActivityProbe,
  sessionActivityUrl,
  shouldClearLoadingAfterRecovery,
  shouldShowManualRefresh,
} from './sessionActivity';

const SESSION = 'sess-A';

/** جالب مؤجَّل: نتحكّم بلحظة عودته لنُدخل حدثاً سُلطوياً في الأثناء. */
function deferredFetch(payload: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchActivity = async () => {
    await gate;
    return payload as { isProcessing?: unknown } | null;
  };
  return { fetchActivity, release };
}

beforeEach(() => {
  resetSessionActivityEpochs();
});

describe('readIsProcessing — ترميز الحقيقة (بند 2)', () => {
  it('غياب الحقل كلياً = غير نشطة', () => {
    assert.equal(readIsProcessing({}), false);
    assert.equal(readIsProcessing(null), false);
    assert.equal(readIsProcessing(undefined), false);
  });

  it('قيمة غير boolean لا تُعدّ نشاطاً (لا نبني على تساهل الخادم)', () => {
    assert.equal(readIsProcessing({ isProcessing: undefined }), false);
    assert.equal(readIsProcessing({ isProcessing: null }), false);
    assert.equal(readIsProcessing({ isProcessing: 'true' }), false);
    assert.equal(readIsProcessing({ isProcessing: 1 }), false);
  });

  it('true الصريحة وحدها = نشطة', () => {
    assert.equal(readIsProcessing({ isProcessing: true }), true);
    assert.equal(readIsProcessing({ isProcessing: false }), false);
  });
});

describe('حارس epoch (بند 5)', () => {
  it('العدّاد رتيب لكل جلسة ومعزول بين الجلسات', () => {
    assert.equal(readSessionActivityEpoch(SESSION), 0);
    bumpSessionActivityEpoch(SESSION);
    bumpSessionActivityEpoch(SESSION);
    assert.equal(readSessionActivityEpoch(SESSION), 2);
    assert.equal(readSessionActivityEpoch('sess-B'), 0);
  });

  it('لقطة «نشطة» تعود بعد complete تُهمَل ولا ترفع المؤشّر', async () => {
    const { fetchActivity, release } = deferredFetch({ isProcessing: true });
    let raised = 0;

    const probe = runSessionActivityProbe({
      sessionId: SESSION,
      onActive: () => { raised += 1; },
      fetchActivity,
    });

    // الحدث السُلطوي (complete/error/session-status) يقع أثناء الطلب.
    bumpSessionActivityEpoch(SESSION);
    release();

    assert.equal(await probe, 'stale');
    assert.equal(raised, 0, 'لقطة متأخرة رفعت المؤشّر — المؤشّر يعلق للأبد');
  });

  it('لقطة «نشطة» بلا حدث في الأثناء تُطبَّق', async () => {
    const { fetchActivity, release } = deferredFetch({ isProcessing: true });
    let raised = 0;
    const probe = runSessionActivityProbe({
      sessionId: SESSION,
      onActive: () => { raised += 1; },
      fetchActivity,
    });
    release();
    assert.equal(await probe, 'applied');
    assert.equal(raised, 1);
  });

  it('حدث على جلسة أخرى لا يُبطل لقطة هذه الجلسة', async () => {
    const { fetchActivity, release } = deferredFetch({ isProcessing: true });
    let raised = 0;
    const probe = runSessionActivityProbe({
      sessionId: SESSION,
      onActive: () => { raised += 1; },
      fetchActivity,
    });
    bumpSessionActivityEpoch('sess-other');
    release();
    assert.equal(await probe, 'applied');
    assert.equal(raised, 1);
  });

  it('ردّ بلا isProcessing = idle: لا رفع للمؤشّر', async () => {
    let raised = 0;
    const outcome = await runSessionActivityProbe({
      sessionId: SESSION,
      onActive: () => { raised += 1; },
      fetchActivity: async () => ({}),
    });
    assert.equal(outcome, 'idle');
    assert.equal(raised, 0);
  });

  it('تعذّر الوصول للنقطة (غير منشورة/شبكة) = unknown بلا أي أثر', async () => {
    let raised = 0;
    const outcome = await runSessionActivityProbe({
      sessionId: SESSION,
      onActive: () => { raised += 1; },
      fetchActivity: async () => null,
    });
    assert.equal(outcome, 'unknown');
    assert.equal(raised, 0);
  });
});

describe('حرج 3 — سياسة إنزال المؤشّر بعد التعافي', () => {
  it('«unknown» لا تُنزِل المؤشّر (النقطة غير منشورة / شبكة)', () => {
    // كان الإنزال غير مشروط: ضغطة تحديث أثناء تشغيل حيّ ⇒ تختفي البطاقة وزر
    // STOP لبقية التشغيل بلا تعافٍ، وينشرها `build:client` قبل وصول الخادم.
    assert.equal(shouldClearLoadingAfterRecovery('unknown'), false);
  });

  it('«idle» وحدها قاطعة فتُنزِل', () => {
    assert.equal(shouldClearLoadingAfterRecovery('idle'), true);
  });

  it('«applied» تشغيل حيّ و«stale» حسمه حدث أحدث و«skipped» بلا معلومة ⇒ لا إنزال', () => {
    assert.equal(shouldClearLoadingAfterRecovery('applied'), false);
    assert.equal(shouldClearLoadingAfterRecovery('stale'), false);
    assert.equal(shouldClearLoadingAfterRecovery('skipped'), false);
  });
});

describe('حرج 3 — بوّابة مخرج الطوارئ (زر التحديث)', () => {
  it('بلا محادثة مفتوحة: لا زرّ', () => {
    assert.equal(
      shouldShowManualRefresh({ hasSession: false, isLoading: false, activitySourceAvailable: true }),
      false,
    );
  });

  it('بلا تشغيل: الزرّ ظاهر دائماً (السلوك القائم لا يتغيّر)', () => {
    assert.equal(
      shouldShowManualRefresh({ hasSession: true, isLoading: false, activitySourceAvailable: false }),
      true,
    );
  });

  it('أثناء التشغيل وبلا مصدر حتمي: مخفيّ (لا فخّ قبل نشر الخادم)', () => {
    assert.equal(
      shouldShowManualRefresh({ hasSession: true, isLoading: true, activitySourceAvailable: false }),
      false,
    );
  });

  it('أثناء التشغيل ومع مصدر حتمي: ظاهر (مخرج الطوارئ يُفتح ذاتياً)', () => {
    assert.equal(
      shouldShowManualRefresh({ hasSession: true, isLoading: true, activitySourceAvailable: true }),
      true,
    );
  });
});

describe('عقد النقطة', () => {
  it('المسار مطابق للنقطة المتفق عليها ومُرمَّز', () => {
    assert.equal(
      sessionActivityUrl('a/b c'),
      '/api/providers/sessions/a%2Fb%20c/activity',
    );
  });
});
