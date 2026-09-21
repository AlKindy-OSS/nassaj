import type { SessionOutcome } from '../../../../../shared/session-outcome';
import type { SessionProcessState } from '../../../../stores/sessionProcessStateStore';

export type SessionRowIndicatorState =
  | 'question'
  | 'frozen'
  | 'running'
  | 'orphan'
  | 'error'
  | 'done';

/**
 * حالة المحادثة — خمس حالات، واحدة لكل الهارنسات والمزوّدات (B-544).
 *
 * هذه الدالة هي **المصدر الوحيد** لترتيب الأولوية في التطبيق كلّه: صفّ الشريط
 * الجانبي (SessionRowStatusIndicator) وشارة رأس المحادثة (SessionProcessBadge)
 * يقرآن منها معاً، فلا يقول سطحان شيئين مختلفين عن المحادثة نفسها (B-824 —
 * كانت الشارة ترتّب `question > frozen > running > error > done` والصفّ يرتّب
 * `question > error > done > frozen > running`).
 *
 *  - question → أزرق: الجولة واقفة تنتظر جواب المستخدم (طلب إذن/سؤال تفاعلي).
 *               أعلى الحالات أولويةً: ما ينتظر المستخدمَ يعلو على ما ينتظر
 *               النموذج. ولا يطفئه فتحُ المحادثة؛ يبقى حتى الإجابة أو الإلغاء.
 *  - error    → أحمر: خطأ، أو انقطاع، أو توقّفٌ بلا ردّ، ولم تُفتح بعد.
 *  - done     → أخضر ثابت: اكتملت ولم تُفتح. فتحُها يقرؤها للجميع، و«تحديد
 *               كغير مقروء» يعيدها للجميع.
 *  - frozen   → عنبري: عمليةٌ مجمَّدة بـ`kill -STOP`.
 *  - running  → أخضر دائر: جولة حيّة، أو ورشة خلفية جارية (fallback واحد يدخل
 *               نفس السلسلة بدل أن يصنع شارةً ثانية).
 *  - لا شيء   → الحالة الهادئة، ومنها **جولةٌ أوقفها المستخدم بنفسه**: إيقافٌ
 *               واعٍ لا يحتاج تذكيراً.
 *
 * `processState` يجب أن يكون null حين لا تكون لقطة المقبس موثوقة؛ المستهلكان
 * يطبّقان ذلك عبر `useSessionProcessStateAuthority`. والوسيط الأخير يمنع طيّ
 * الورشة اليتيمة في «لا شيء»: أي شكل orphan يظهر كحالة مستقلة في الصف.
 */
export function deriveSessionRowIndicatorState(
  processState: SessionProcessState | null,
  outcome: SessionOutcome | null,
  hasRunningWorkflow: boolean,
  hasOrphanWorkflow = false,
): SessionRowIndicatorState | null {
  if (outcome === 'question') return 'question';
  // A terminal outcome is the durable result the owner has not opened yet.
  // Polling/process hints may arrive late, so they must not cover that result.
  // A genuinely new run clears the previous outcome server-side before it
  // publishes its running state (session-outcome.service.markRunStarted).
  if (outcome === 'error') return 'error';
  if (outcome === 'done') return 'done';
  if (processState === 'frozen') return 'frozen';
  if (processState === 'running' || hasRunningWorkflow) return 'running';
  if (hasOrphanWorkflow) return 'orphan';
  return null;
}
