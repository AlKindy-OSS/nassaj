/**
 * T-1295 — حكمُ الجولة يقع على إدخال صندوق الصادر الصحيح.
 *
 * هذا هو **جوهر حادثة المالك**: الرسالة تُرسَل، فيُمسح المُؤلِّف (النصّ والصور
 * والمسوّدة)، ثم يصل `error` — فلا نسخة لكلام المستخدم في أي مكان. الإدخال
 * يُكتب قبل الإرسال، وهذه الاختبارات تحرس أن الحكم يصيبه هو لا سواه.
 *
 * ‏**تحديث B-553/م3 و م9**: كان هذا الملف يقود الحكمَ عبر `applyControlEvent`
 * في خطّاف `ChatInterface` — فكان يتخطّى **موضعَي الانكسار** معاً: صدى الخادم
 * (كان في claude وحده)، وبوابةَ خطّ الأساس التي تُسقط كل حدثٍ سبق تركيب
 * المكوّن. تغطيةٌ خضراء فوق مسارٍ لم يُمَسّ (نمط «راحة fixtures الزائفة»).
 *
 * فالحكم انتقل إلى دالّة صرفة (`resolveOutboxVerdict`) تستهلكها `AppContent`
 * — طبقةٌ لا تُفكَّك — وهذا الملف يختبرها هي: كل قرار بحمولته، بلا شجرة React
 * ولا خطّاف. والحارسان المقابلان:
 *   • `server/modules/websocket/services/dispatch-client-msg-id.test.ts` —
 *     الصدى يصل من كل مزوّد.
 *   • `outboxComposerSubmit.test.tsx` — الإدخال يُكتب قبل مسح المُؤلِّف.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { describe, expect, it } from 'vitest';

import { resolveOutboxVerdict } from '../utils/messageOutbox';
import { readServerErrorCode, readServerErrorDetail } from './useChatRealtimeHandlers';

const CMID = 'cmid_1';

function verdict(
  msg: Record<string, unknown>,
  options: { isActiveViewSession?: boolean } = {},
) {
  return resolveOutboxVerdict(msg, {
    isActiveViewSession: options.isActiveViewSession ?? false,
    readErrorCode: readServerErrorCode as (m: unknown) => string | null,
    readErrorDetail: readServerErrorDetail as (m: unknown) => string | null,
  });
}

describe('error بعد إرسالٍ ناجح', () => {
  it('يرفع الإدخال بطاقةً بسببه — جوهر الحادثة', () => {
    expect(verdict({ kind: 'error', clientMsgId: CMID, code: 'spawn_failed' })).toEqual({
      action: 'fail',
      id: CMID,
      code: 'spawn_failed',
      detail: null,
    });
  });

  it('يحمل شهادة إعادة نفس الهوية من verdict إلى الصندوق', () => {
    expect(verdict({
      kind: 'error', clientMsgId: CMID, code: 'spawn_failed', sameClientMsgIdRetryable: true,
    })).toMatchObject({ action: 'fail', id: CMID, sameClientMsgIdRetryable: true });
  });

  it('يحمل التفصيل الخام بشكليه: المنظَّم والمسطَّح', () => {
    expect(
      verdict({ kind: 'error', clientMsgId: CMID, error: { code: 'usage_limit', detail: 'حصة' } }),
    ).toEqual({ action: 'fail', id: CMID, code: 'usage_limit', detail: 'حصة' });

    expect(verdict({ kind: 'error', clientMsgId: CMID, reason: 'سبب خام' })).toEqual({
      action: 'fail',
      id: CMID,
      code: 'unknown',
      detail: 'سبب خام',
    });
  });

  /**
   * الربط بـ`clientMsgId` لا بـ«أحدث معلَّق»: الحكم يحمل هوية جولته، فإدخالان
   * معلَّقان لا يلتبسان. وهذا شرط صحّة لا تحسين — التخمين كان يُصيب تشغيلاً
   * غير الذي حكم عليه الخادم.
   */
  it('يصيب الإدخال الذي يحمل هويته وحده', () => {
    expect(verdict({ kind: 'error', clientMsgId: 'cmid_B' })).toMatchObject({ id: 'cmid_B' });
    expect(verdict({ kind: 'error', clientMsgId: 'cmid_A' })).toMatchObject({ id: 'cmid_A' });
  });
});

describe('session_busy — رفضُ محاولةٍ لا نهايةُ جولة', () => {
  it('على الشاشة المعروضة: لا بطاقة (B-518 يردّ النصّ إلى المُؤلِّف)', () => {
    expect(
      verdict({ kind: 'error', clientMsgId: CMID, code: 'session_busy' }, { isActiveViewSession: true }),
    ).toEqual({ action: 'confirm', id: CMID });
  });

  it('لجلسة خلفية: بطاقة — لا مُؤلِّف يُردّ إليه النصّ', () => {
    expect(
      verdict({ kind: 'error', clientMsgId: CMID, code: 'session_busy' }, { isActiveViewSession: false }),
    ).toMatchObject({ action: 'fail', code: 'session_busy' });
  });
});

describe('complete', () => {
  it('اكتمالٌ سليم يحذف الإدخال — فلا تتراكم بطاقات «نجحت»', () => {
    expect(verdict({ kind: 'complete', clientMsgId: CMID })).toEqual({ action: 'confirm', id: CMID });
  });

  it('الإجهاض لا يُنتج بطاقة: الجولة بدأت وقرارُ الإيقاف للمستخدم', () => {
    expect(verdict({ kind: 'complete', clientMsgId: CMID, aborted: true, success: false })).toEqual({
      action: 'confirm',
      id: CMID,
    });
  });

  it('رفضٌ قبل الإقلاع (success:false) يُنتج بطاقة', () => {
    expect(
      verdict({ kind: 'complete', clientMsgId: CMID, success: false, error: 'مزوّد مُعطَّل' }),
    ).toEqual({ action: 'fail', id: CMID, code: 'run_failed', detail: 'مزوّد مُعطَّل' });
  });

  it('complete الملتبس يحفظ رمز الخادم ولا يطمسه إلى run_failed', () => {
    expect(verdict({
      kind: 'complete',
      clientMsgId: CMID,
      success: false,
      code: 'client_msg_id_already_started',
      notStarted: true,
      sameClientMsgIdRetryable: false,
      error: 'This message id may already be running.',
    })).toEqual({
      action: 'fail',
      id: CMID,
      code: 'client_msg_id_already_started',
      detail: 'This message id may already be running.',
      sameClientMsgIdRetryable: false,
    });
  });
});

describe('session_created', () => {
  it('معرّف صحيح ⇒ قبولٌ مؤكَّد فيُحذف الإدخال', () => {
    expect(verdict({ kind: 'session_created', clientMsgId: CMID, newSessionId: 's-1' })).toEqual({
      action: 'confirm',
      id: CMID,
    });
  });

  it('معرّف فارغ ⇒ فشلُ إقلاع فيُرفع الإدخال بطاقةً', () => {
    expect(verdict({ kind: 'session_created', clientMsgId: CMID, newSessionId: null })).toMatchObject({
      action: 'fail',
      code: 'session_create_failed',
    });
  });
});

describe('تدهور رشيق', () => {
  it('حمولة بلا هوية لا تمسّ الصندوق', () => {
    expect(verdict({ kind: 'complete' })).toBeNull();
    expect(verdict({ kind: 'error', code: 'spawn_failed' })).toBeNull();
  });

  it('ما ليس حكماً لا يُنتج قراراً', () => {
    expect(verdict({ kind: 'stream_delta', clientMsgId: CMID })).toBeNull();
    expect(verdict({ kind: 'permission_request', clientMsgId: CMID })).toBeNull();
  });
});
