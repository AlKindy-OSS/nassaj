/**
 * حالة نهاية جولة المحادثة — قاعدةٌ واحدة يقرؤها الخادم والعميل (B-577).
 *
 * ‏نموذج المالك الخماسي (2026-08-07): أوقفها بنفسه ⇒ لا حالة، اكتملت ⇒ `done`،
 * تنتظر جوابه ⇒ `question`، خطأٌ أو انقطاعٌ أو توقّفٌ بلا ردّ ⇒ `error`، تعمل
 * ⇒ `running` (من مراقب العمليات، لا من هنا).
 *
 * **لماذا في `shared/` لا في مخزن العميل:** الحالة كانت تُشتقّ في المتصفّح
 * وتُخزَّن في `localStorage`، فمن كان متصفّحه مغلقاً لحظة الانتهاء — أو فتح من
 * جهازٍ آخر، أو كانت الجولة لعضوٍ آخر — لا يرى شيئاً أبداً. ومطلبُ المالك
 * (2026-08-08) أن الحالة خاصّةُ **المحادثة** لا خاصّةَ المتصفّح: «من غير المهم
 * هي تعمل تحت أي مستخدم، أي مستخدم يجب أن يتمكن من معرفة عدد المحادثات النشطة
 * وحالتها». فصار الاشتقاق خادمياً، وبقيت نفس القاعدة حرفاً بحرف للطرفين — لا
 * نسختان تتباعدان.
 */

/**
 * ما تنتظره المحادثة من صاحبها، مرتّبةً بالأولوية تنازلياً في `OUTCOME_RANK`:
 * سؤالٌ ينتظر جواباً يعلو على خطأٍ وقع، وكلاهما يعلو على نهايةٍ ناجحة.
 */
export type SessionOutcome = 'question' | 'error' | 'done';

export const OUTCOME_RANK: Record<SessionOutcome, number> = {
  question: 3,
  error: 2,
  done: 1,
};

export const VALID_OUTCOMES: ReadonlySet<string> = new Set<SessionOutcome>([
  'question',
  'error',
  'done',
]);

/** الأعلى أولويةً بين حالتين — أو `null` إن لم توجد أيّ حالة. */
export function strongerOutcome(
  a: SessionOutcome | null,
  b: SessionOutcome | null,
): SessionOutcome | null {
  if (!a) return b;
  if (!b) return a;
  return OUTCOME_RANK[a] >= OUTCOME_RANK[b] ? a : b;
}

export type OutcomeSignalPayload = {
  kind?: unknown;
  text?: unknown;
  processState?: unknown;
  aborted?: unknown;
  success?: unknown;
  isError?: unknown;
  exitCode?: unknown;
  code?: unknown;
  requestId?: unknown;
  toolUseId?: unknown;
  callId?: unknown;
  /**
   * ‏B-577 — رفضٌ وقع **قبل** أن تبدأ جولةٌ أصلاً (مزوّد مُعطَّل، مشروع غير
   * مرئي، محادثة مشغولة). حمولتُه `kind:'complete'` بـ`success:false`، فلو
   * عوملت نهايةَ جولةٍ لكتب **المُحاوِل المرفوض** شارةَ خطأ على محادثةٍ سليمة
   * يراها أصحابها. وعلَمٌ صريح أصدق من تخمينٍ من نصّ الرسالة.
   */
  notStarted?: unknown;
  /** المزوّد كما أعلنته الحمولة — يُخزَّن للعرض لا للحكم. */
  provider?: unknown;
};

export type OutcomeSignal =
  | { action: 'outcome'; outcome: SessionOutcome }
  | { action: 'clear' }
  | null;

/**
 * الحكم على حمولةٍ واحدة: ماذا تعني لحالة الجلسة؟
 *
 *   `outcome` — حالةٌ تُسجَّل.
 *   `clear`   — الحكم السابق سقط ولا يُخلَفه شيء (إيقافٌ بطلب المستخدم، أو
 *               جولةٌ جديدة بدأت فأبطلت حكم سابقتها، أو أُجيب السؤال).
 *   `null`    — الحمولة لا تعني شيئاً لهذه الطبقة.
 *
 * والتسامح في تصنيف الفشل مقصود: الإشارات **ليست موحّدة** بين المزوّدات
 * (‏claude وحده يحمل `aborted`، وcodex لا يبعث `exitCode` أصلاً، وcursor يبعث
 * `isError`). فأي دليل فشلٍ يكفي، وغيابُ كلّ دليلٍ يعني نجاحاً — وهو الاتجاه
 * الآمن: «تمّ» كاذبة تُكلّف فتحةً زائدة، و«خطأ» كاذبة تُقلق بلا سبب.
 */
export function deriveOutcomeSignal(
  msg: OutcomeSignalPayload,
  options: { hasVerdict?: boolean } = {},
): OutcomeSignal {
  // ١) سؤالٌ ينتظر جواب المستخدم — الجولة واقفةٌ عليه.
  if (msg.kind === 'permission_request' || msg.kind === 'interactive_prompt') {
    return { action: 'outcome', outcome: 'question' };
  }
  // أُجيب السؤال أو أُلغي ⇒ لم تعد المحادثة تنتظر شيئاً منه.
  if (msg.kind === 'permission_cancelled') {
    return { action: 'clear' };
  }

  if (msg.kind === 'status' && msg.text === 'process_state') {
    // جولةٌ جديدة بدأت ⇒ حكم الجولة السابقة انقضى أثره.
    if (msg.processState === 'running') return { action: 'clear' };
    if (msg.processState === 'idle') {
      // خمود بعد حكمٍ صريح = تأكيدٌ له لا حدثٌ جديد. أمّا خمودٌ بلا حكم فهو
      // «توقّفت دون ردّ» — الحالة الرابعة في نموذج المالك.
      return options.hasVerdict ? null : { action: 'outcome', outcome: 'error' };
    }
    return null;
  }

  // ‏B-577: رفضٌ قبل بدء الجولة لا يُنتج حالة على محادثةٍ لم تعمل أصلاً.
  if (msg.notStarted === true) return null;

  if (msg.kind === 'complete') {
    // إيقافٌ بطلب المستخدم: لا مؤشّر. ويُستثنى الإجهاض الذي **فشل** — تلك
    // نهايةٌ لم يخترها أحد.
    if (msg.aborted === true && msg.success !== false) return { action: 'clear' };
    const failed =
      msg.success === false
      || msg.isError === true
      || (typeof msg.exitCode === 'number' && msg.exitCode !== 0);
    return { action: 'outcome', outcome: failed ? 'error' : 'done' };
  }

  if (msg.kind === 'error') {
    // ‏`session_busy` رفضُ محاولةِ إرسالٍ لم تبدأ، والجولة الحيّة تعمل الآن
    // (B-518). وسمُه خطأً يضع علامة فشلٍ على محادثةٍ سليمة تشتغل.
    if (msg.code === 'session_busy') return null;
    return { action: 'outcome', outcome: 'error' };
  }

  return null;
}

/**
 * أنواع الحمولات التي وحدها تُغيّر حالة المحادثة.
 *
 * حارسٌ يسبق كل شيء عند نقطة الكتابة: `WebSocketWriter.send` تمرّ بها **كل
 * قطعة بثّ** (توكن بتوكن)، فلا يجوز أن يدخلها منطقُ اشتقاق.
 */
export const OUTCOME_SIGNAL_KINDS: ReadonlySet<string> = new Set([
  'complete',
  'error',
  'permission_request',
  'interactive_prompt',
  'permission_cancelled',
]);
