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
import { readServerErrorFence, readServerErrorRetryable } from '../utils/serverErrorMessage';
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

/** Wired exactly like `consumeOutboxIngressVerdict` (fence/retryable readers included). */
function verdictWithFence(msg: Record<string, unknown>) {
  return resolveOutboxVerdict(msg, {
    isActiveViewSession: false,
    readErrorCode: readServerErrorCode as (m: unknown) => string | null,
    readErrorDetail: readServerErrorDetail as (m: unknown) => string | null,
    readErrorFence: readServerErrorFence as (m: unknown) => ReturnType<typeof readServerErrorFence>,
    readErrorRetryable: readServerErrorRetryable as (m: unknown) => ReturnType<typeof readServerErrorRetryable>,
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

describe('B-1076 حجب الصلاحيات — إطار complete', () => {
  // qa-critic (B-1076 round 1, CRITICAL): الإطار الحقيقي من
  // `withCoordinationMetadata` (chat-websocket.service.ts) يضع
  // `sameClientMsgIdRetryable: notStarted===true` على كل إطار طرفي — فحجبٌ
  // بـ`notStarted:true` يصل **دائماً** بهذا العلم `true` أيضاً. حذفه من
  // fixtures هذا الملف كان يخفي عطلاً حقيقياً: البطاقة كانت تُعيد نفس
  // `clientMsgId` إلى جلسةٍ مختلفة (`useChatComposerState.retryOutboxEntry`).
  it('effect_scope_fenced بنطاق session يحمل الحجب و retryable:false و sameClientMsgIdRetryable:true', () => {
    expect(verdictWithFence({
      kind: 'complete',
      clientMsgId: CMID,
      success: false,
      notStarted: true,
      retryable: false,
      sameClientMsgIdRetryable: true,
      code: 'effect_scope_fenced',
      fence: { scopeKind: 'session', reasonCode: 'unknown_effect' },
    })).toEqual({
      action: 'fail',
      id: CMID,
      code: 'effect_scope_fenced',
      detail: null,
      fence: { scopeKind: 'session', reasonCode: 'unknown_effect' },
      retryable: false,
      sameClientMsgIdRetryable: true,
    });
  });

  it('generation_blocked بلا fence يحمل الرمز و retryable:false بلا نطاق', () => {
    expect(verdictWithFence({
      kind: 'complete', clientMsgId: CMID, success: false, code: 'generation_blocked',
      notStarted: true, retryable: false, sameClientMsgIdRetryable: true,
    })).toEqual({
      action: 'fail', id: CMID, code: 'generation_blocked', detail: null, fence: null,
      retryable: false, sameClientMsgIdRetryable: true,
    });
  });

  it.each(['generation_transitioning', 'actor_revoked_or_stale', 'sqlite_busy', 'unknown'])(
    '%s يبقى بلا fence/retryable حين لا يصلان — لا تغيير عن السلوك السابق',
    (code) => {
      expect(verdictWithFence({ kind: 'complete', clientMsgId: CMID, success: false, code }))
        .toEqual({ action: 'fail', id: CMID, code, detail: null });
    },
  );

  it('retryable:true على أحد الرمزين القاطعين لا يُخترع حجباً (يُنقل كما وصل)', () => {
    expect(verdictWithFence({
      kind: 'complete', clientMsgId: CMID, success: false, code: 'effect_scope_fenced', retryable: true,
    })).toEqual({
      action: 'fail', id: CMID, code: 'effect_scope_fenced', detail: null, fence: null, retryable: true,
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
