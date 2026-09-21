/**
 * حالة نهاية جولة المحادثة، وإقرارُ رؤيتها — المستودع (B-577).
 *
 * حقيقتان منفصلتان عمداً:
 *   • `session_run_outcomes` — كيف انتهت آخر جولة. **عالميّة**: خاصّةُ المحادثة
 *     لا خاصّةُ من شغّلها ولا من ينظر إليها (مطلب المالك 2026-08-08).
 *   • `global_seen_at` — متى أقرّ أي عضو بالحكم للجميع. السؤال لا يُقَرّ
 *     بمجرد الفتح؛ يبقى حتى الإجابة أو الإلغاء الفعلي.
 *
 * وفصلُهما هو الإصلاح بعينه: كانتا مدموجتين في مدخلة `localStorage` واحدة، فكان
 * فتحُ المحادثة يحذف الحقيقةَ نفسها فتضيع عن بقية الأعضاء — ومن لم يكن متصفّحه
 * مفتوحاً لحظة الانتهاء لا يعرف أن شيئاً وقع أصلاً.
 *
 * الرؤية: لا منطقَ وصولٍ جديد هنا. كل قراءةٍ تأخذ مسارات المشاريع المرئية
 * (‏`projectsDb.getVisibleProjectPaths`) وتنضمّ إلى `sessions` — والحكمُ الذي
 * لا صفَّ جلسةٍ له، أو مسارُ مشروعه فارغ، **لا يُعرض**: فشلٌ مغلقٌ عند الجهل.
 */

import { getConnection } from '@/modules/database/connection.js';

import { VALID_OUTCOMES, type SessionOutcome } from '../../../../shared/session-outcome.js';

export type SessionOutcomeRow = {
  sessionId: string;
  outcome: SessionOutcome;
  outcomeAt: string;
  provider: string | null;
  globalSeenAt: string | null;
};

type OutcomeDbRow = {
  session_id: string;
  outcome: string;
  outcome_at: string;
  provider: string | null;
  global_seen_at: string | null;
};

const toRow = (row: OutcomeDbRow): SessionOutcomeRow => ({
  sessionId: row.session_id,
  outcome: row.outcome as SessionOutcome,
  outcomeAt: row.outcome_at,
  provider: row.provider,
  globalSeenAt: row.global_seen_at,
});

/** السؤال دائم الظهور، أما النهاية والخطأ فيُخفيهما الإقرار العالمي. */
export function isOutcomeVisible(row: SessionOutcomeRow): boolean {
  return row.outcome === 'question'
    || row.globalSeenAt === null
    || row.globalSeenAt < row.outcomeAt;
}

/** حدٌّ أعلى لمعرّفات الاستعلام الواحد — يحمي `IN (...)` من صفحةٍ ضخمة. */
const MAX_IDS_PER_QUERY = 500;

/**
 * يسجّل حكم آخر جولة. صفٌّ واحد لكل محادثة: الحكم الجديد يحلّ محلّ سابقه،
 * و`outcome_at` يُجدَّد — فيُلغى بذلك إقرارُ **كل** المستخدمين بلا كتابةٍ واحدة
 * في جدول القراءات.
 */
export function recordOutcome(
  sessionId: string,
  outcome: SessionOutcome,
  provider: string | null = null,
): void {
  if (!sessionId || !VALID_OUTCOMES.has(outcome)) return;
  getConnection()
    .prepare(
      /**
       * ‏الطابع بدقّة الميلّي لا الثانية: `CURRENT_TIMESTAMP` دقّتُه ثانيةٌ
       * واحدة، فجولةٌ تنتهي ويُقَرّ بها ثم تنتهي أخرى في **نفس الثانية** تُنتج
       * `outcome_at` مساوياً لـ`seen_at` — فيُعدّ الحكم الجديد مقروءاً ولا تظهر
       * شارته. نفس فخّ «نفس-الثانية» المسجَّل في B-163.
       */
      `INSERT INTO session_run_outcomes (session_id, outcome, outcome_at, provider)
       VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'), ?)
       ON CONFLICT(session_id) DO UPDATE SET
         outcome = excluded.outcome,
         -- تزايدٌ صارم: حكمان في نفس المللّي يُنتجان طابعاً متساوياً، فيبقى
         -- إقرارُ الحكم الأول ساري المفعول على الثاني ولا تظهر شارته. فإن لم
         -- تتقدّم الساعة، نتقدّم نحن مللّياً واحداً.
         outcome_at = MAX(
           excluded.outcome_at,
           strftime('%Y-%m-%d %H:%M:%f', session_run_outcomes.outcome_at, '+0.001 seconds')
         ),
         provider = COALESCE(excluded.provider, session_run_outcomes.provider),
         global_seen_at = NULL`
    )
    .run(sessionId, outcome, provider);
}

/**
 * يمحو الحكم: بدأت جولةٌ جديدة، أو أوقف المستخدم الجولة بنفسه، أو أُجيب السؤال.
 * حكمٌ ميّت معلّقٌ على محادثةٍ عادت تعمل تضليلٌ أسوأ من الصمت.
 */
export function clearOutcome(sessionId: string): void {
  if (!sessionId) return;
  getConnection().prepare('DELETE FROM session_run_outcomes WHERE session_id = ?').run(sessionId);
}

/** أحكامُ مجموعةٍ من المحادثات — استعلامٌ واحد لا N+1. */
export function getOutcomesForSessions(sessionIds: readonly string[]): Map<string, SessionOutcomeRow> {
  const ids = sessionIds.filter(Boolean).slice(0, MAX_IDS_PER_QUERY);
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = getConnection()
    .prepare(
      `SELECT session_id, outcome, outcome_at, provider, global_seen_at
         FROM session_run_outcomes
        WHERE session_id IN (${placeholders})`
    )
    .all(...ids) as OutcomeDbRow[];
  return new Map(rows.map((row) => [row.session_id, toRow(row)]));
}

/**
 * الأحكام المشتركة الظاهرة حالياً، ضمن مشاريع الطالب المرئية وحدها.
 *
 * هذه لقطةُ العدّاد: الشريط الجانبي مُصفَّح فقد لا يحمل كل الجلسات، وهذه تُعيد
 * عشرات الصفوف باستعلامٍ مفهرس واحد. ولا تنشر شيئاً عن جلسةٍ لا يراها الطالب:
 * لا صفّاً ولا عدداً — بخلاف presence الذي ينشر عدداً مخفياً عمداً ليصدق رقمُ
 * «من يعمل الآن». والتباين مقصود: ذاك رقمٌ مجمَّع، وهذه دعوى على محادثةٍ بعينها.
 */
export function getUnseenOutcomes(
  userId: number,
  visibleProjectPaths: readonly string[],
): SessionOutcomeRow[] {
  if (!userId || visibleProjectPaths.length === 0) return [];
  const placeholders = visibleProjectPaths.map(() => '?').join(',');
  const rows = getConnection()
    .prepare(
      `SELECT o.session_id, o.outcome, o.outcome_at, o.provider, o.global_seen_at
         FROM session_run_outcomes o
         JOIN sessions s ON s.session_id = o.session_id
        WHERE s.project_path IN (${placeholders})
          AND s.isArchived = 0
          AND (
            o.outcome = 'question'
            OR o.global_seen_at IS NULL
            OR o.global_seen_at < o.outcome_at
          )
     ORDER BY o.outcome_at DESC`
    )
    .all(...visibleProjectPaths) as OutcomeDbRow[];
  return rows.map(toRow);
}

/**
 * إقرارٌ برؤية حكم محادثة عبر CAS. لا يُكتب إلا إذا طابق `expectedOutcomeAt`
 * نسخة الحكم التي شاهدها العميل، كي لا يطفئ طلبٌ متأخر حكماً أحدث لم يُرَ.
 */
export function markOutcomeSeen(sessionId: string, expectedOutcomeAt: string): boolean {
  if (!sessionId || !expectedOutcomeAt) return false;
  const db = getConnection();
  return db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE session_run_outcomes
            SET global_seen_at = outcome_at
          WHERE session_id = ?
            AND outcome_at = ?
            AND outcome IN ('done', 'error')`
      )
      .run(sessionId, expectedOutcomeAt);
    if ((result.changes ?? 0) === 0) return false;

    // Rollback compatibility: النسخة القديمة تقرأ session_outcome_reads لكل
    // مستخدم. نكتب النسخة الحالية لكل المستخدمين الموجودين كي لا تعيد الشارة
    // بعد الرجوع للكود القديم. الطابع الأقدم لا يخفي جولة أحدث.
    db.prepare(
      `INSERT INTO session_outcome_reads (user_id, session_id, seen_at)
       SELECT id, ?, ? FROM users WHERE true
       ON CONFLICT(user_id, session_id) DO UPDATE SET seen_at = excluded.seen_at`
    ).run(sessionId, expectedOutcomeAt);
    return true;
  })();
}

/**
 * ‏T-1340 — «تحديد كغير مقروء»: يُبطل الإقرار العالمي فتعود الشارة للجميع.
 *
 * يُرجع الحكم القائم إن وُجد، ليُحدِّث العميلُ عرضه فوراً بلا جلبٍ ثانٍ.
 */
export function clearOutcomeSeen(sessionId: string): SessionOutcomeRow | null {
  if (!sessionId) return null;
  const db = getConnection();
  db.transaction(() => {
    db.prepare("UPDATE session_run_outcomes SET global_seen_at = NULL WHERE session_id = ? AND outcome IN ('done', 'error')")
      .run(sessionId);
    db.prepare('DELETE FROM session_outcome_reads WHERE session_id = ?').run(sessionId);
  })();
  return getOutcomesForSessions([sessionId]).get(sessionId) ?? null;
}

/**
 * ‏B-577 — سؤالٌ معلَّق لا يعمّر أطول من عمليته.
 *
 * صفُّ `question` ينجو من إعادة تشغيل الخادم، وطلبُ الإذن نفسه لا ينجو — فتبقى
 * شارةٌ زرقاء تنتظر سؤالاً لم يعد موجوداً. إقلاع الخادم يعني أن العملية
 * الحاملة للسؤال أُلغيت فعلياً؛ لذلك يُحذف الحكم ضمن تنظيف الإقلاع.
 * تُستدعى مرّةً عند الإقلاع.
 */
export function clearStaleQuestionOutcomes(): number {
  const result = getConnection()
    .prepare("DELETE FROM session_run_outcomes WHERE outcome = 'question'")
    .run();
  return result.changes ?? 0;
}

/**
 * الحكمُ ومسارُ مشروع جلسته معاً — لبثّ الدلتا مُصفّاةً بالرؤية.
 *
 * ‏`outcome` قد يكون `null` (سقط الحكم: بدأت جولة، أو أُجيب السؤال) والمسار
 * موجود — وتلك حالةٌ تُبَثّ عمداً كي تُطفأ الشارة عند الجميع. أمّا مسارٌ فارغ
 * فلا يُبَثّ شيء: لا سبيل إلى معرفة من يراه.
 */
export function getOutcomeForBroadcast(
  sessionId: string,
): {
  projectPath: string | null;
  outcome: SessionOutcome | null;
  outcomeAt: string | null;
  outcomeState: 'visible' | 'seen' | 'absent';
} {
  if (!sessionId) {
    return { projectPath: null, outcome: null, outcomeAt: null, outcomeState: 'absent' };
  }
  const row = getConnection()
    .prepare(
      `SELECT s.project_path AS project_path, o.outcome AS outcome,
              o.outcome_at AS outcome_at, o.provider AS provider,
              o.global_seen_at AS global_seen_at
         FROM sessions s
    LEFT JOIN session_run_outcomes o ON o.session_id = s.session_id
        WHERE s.session_id = ?`
    )
    .get(sessionId) as ({ project_path: string | null } & OutcomeDbRow) | undefined;
  if (!row) {
    return { projectPath: null, outcome: null, outcomeAt: null, outcomeState: 'absent' };
  }
  if (!row.outcome || !VALID_OUTCOMES.has(row.outcome)) {
    return {
      projectPath: row.project_path,
      outcome: null,
      outcomeAt: null,
      outcomeState: 'absent',
    };
  }
  const visible = Boolean(
    isOutcomeVisible(toRow(row)),
  );
  return {
    projectPath: row.project_path,
    outcome: visible ? (row.outcome as SessionOutcome) : null,
    // في حالة seen نرسل نسخة الصف الخام كي يعرف العميل أي حكم أُقر عالمياً.
    outcomeAt: row.outcome_at,
    outcomeState: visible ? 'visible' : 'seen',
  };
}

export const sessionOutcomesDb = {
  recordOutcome,
  clearOutcome,
  getOutcomesForSessions,
  isOutcomeVisible,
  getOutcomeForBroadcast,
  getUnseenOutcomes,
  markOutcomeSeen,
  clearOutcomeSeen,
  clearStaleQuestionOutcomes,
};
