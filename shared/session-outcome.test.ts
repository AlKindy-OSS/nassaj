import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveOutcomeSignal,
  strongerOutcome,
} from './session-outcome.js';

// B-544 — نموذج الحالات الخمس (قرار المالك 2026-08-07)، مطبَّقاً على كل
// الهارنسات والمزوّدات:
//   ١ أوقفها المستخدم ⇒ لا مؤشّر  ·  ٢ اكتملت ⇒ done  ·  ٣ تنتظر جوابه ⇒
//   question  ·  ٤ خطأ/انقطاع/توقّف بلا ردّ ⇒ error  ·  ٥ تعمل ⇒ running
//   (من sessionProcessStateStore لا من هنا).


describe('deriveOutcomeSignal — نموذج الحالات الخمس (B-544)', () => {
  it('١ — إيقافُ المستخدم لا يترك مؤشّراً', () => {
    assert.deepEqual(deriveOutcomeSignal({ kind: 'complete', aborted: true }), { action: 'clear' });
  });

  it('١أ — إجهاضٌ فشل ليس إيقافاً ناجحاً: يبقى خطأً', () => {
    assert.deepEqual(
      deriveOutcomeSignal({ kind: 'complete', aborted: true, success: false }),
      { action: 'outcome', outcome: 'error' },
    );
  });

  it('٢ — اكتمالٌ نظيف ⇒ done، ومهما اختلفت حمولة المزوّد', () => {
    // claude: بلا exitCode ولا success. codex: بلا exitCode أصلاً.
    assert.deepEqual(deriveOutcomeSignal({ kind: 'complete' }), { action: 'outcome', outcome: 'done' });
    // kimi/hermes/opencode/agy: exitCode صفر.
    assert.deepEqual(
      deriveOutcomeSignal({ kind: 'complete', exitCode: 0 }),
      { action: 'outcome', outcome: 'done' },
    );
  });

  it('٣ — طلب إذن أو سؤال تفاعلي ⇒ question', () => {
    assert.deepEqual(
      deriveOutcomeSignal({ kind: 'permission_request' }),
      { action: 'outcome', outcome: 'question' },
    );
    assert.deepEqual(
      deriveOutcomeSignal({ kind: 'interactive_prompt' }),
      { action: 'outcome', outcome: 'question' },
    );
  });

  it('٣أ — أُجيب السؤال أو أُلغي ⇒ تسقط الحالة', () => {
    assert.deepEqual(deriveOutcomeSignal({ kind: 'permission_cancelled' }), { action: 'clear' });
  });

  it('٤ — كل صور الفشل ⇒ error، باختلاف لهجات المزوّدات', () => {
    assert.deepEqual(deriveOutcomeSignal({ kind: 'error' }), { action: 'outcome', outcome: 'error' });
    // kimi/hermes/opencode/agy
    assert.deepEqual(
      deriveOutcomeSignal({ kind: 'complete', exitCode: 1 }),
      { action: 'outcome', outcome: 'error' },
    );
    // cursor
    assert.deepEqual(
      deriveOutcomeSignal({ kind: 'complete', isError: true }),
      { action: 'outcome', outcome: 'error' },
    );
    // claude (chat-websocket)
    assert.deepEqual(
      deriveOutcomeSignal({ kind: 'complete', success: false }),
      { action: 'outcome', outcome: 'error' },
    );
  });

  it('٤أ — خمودٌ بلا حكم سابق = «توقّفت دون ردّ» ⇒ error', () => {
    assert.deepEqual(
      deriveOutcomeSignal(
        { kind: 'status', text: 'process_state', processState: 'idle' },
        { hasVerdict: false },
      ),
      { action: 'outcome', outcome: 'error' },
    );
  });

  it('٤ب — خمودٌ بعد حكم صريح تأكيدٌ لا حدثٌ جديد', () => {
    assert.equal(
      deriveOutcomeSignal(
        { kind: 'status', text: 'process_state', processState: 'idle' },
        { hasVerdict: true },
      ),
      null,
    );
  });

  it('٥ — بدءُ جولة جديدة يُسقط حكم سابقتها', () => {
    assert.deepEqual(
      deriveOutcomeSignal({ kind: 'status', text: 'process_state', processState: 'running' }),
      { action: 'clear' },
    );
  });

  it('رفضُ الإرسال (session_busy) ليس نهاية جولة: لا يضع خطأً على محادثة تعمل', () => {
    assert.equal(deriveOutcomeSignal({ kind: 'error', code: 'session_busy' }), null);
  });

  it('الحمولات العادية لا تعني شيئاً لهذه الطبقة', () => {
    assert.equal(deriveOutcomeSignal({ kind: 'text' }), null);
    assert.equal(deriveOutcomeSignal({ kind: 'stream_delta' }), null);
  });
});

describe('strongerOutcome — أولوية العرض', () => {
  it('سؤالٌ ينتظر جواب المستخدم يعلو على كل شيء', () => {
    assert.equal(strongerOutcome('done', 'question'), 'question');
    assert.equal(strongerOutcome('error', 'question'), 'question');
  });

  it('الخطأ يعلو على النهاية الناجحة', () => {
    assert.equal(strongerOutcome('done', 'error'), 'error');
  });

  it('العدم لا يزاحم حالة قائمة', () => {
    assert.equal(strongerOutcome(null, 'done'), 'done');
    assert.equal(strongerOutcome('done', null), 'done');
    assert.equal(strongerOutcome(null, null), null);
  });
});



/**
 * B-544 — حارس **المفصل**: من الحمولة إلى الوسم، بشرط الشهادة.
 *
 * كل قطعة كانت مختبَرة وحدها والوصلة بينهما بلا حارس — وهي موضع خلل B-538
 * بعينه: حذفُ وسيطٍ من المكوّن كان يُعيد العلّة وكل الاختبارات خضراء.
 */
