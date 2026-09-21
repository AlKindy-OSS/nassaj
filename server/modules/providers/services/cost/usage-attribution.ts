/**
 * نسبة الاستهلاك إلى مستخدم بعينه **داخل** المحادثة الواحدة.
 *
 * المشكلة التي يحلّها هذا الملف: المحادثة وحدةُ وصولٍ لا وحدةُ محاسبة. كان
 * `sessionScope` يرشّح المحادثات ثم يَنسب مجموع المحادثة كاملاً إلى كل مشارك
 * فيها، فينتج عن ذلك خطآن لا واحد:
 *
 *  1. **ازدواج**: محادثة يشترك فيها اثنان تُحسب مرّتين، فمجموع البطاقات يتجاوز
 *     ما فوترته المنصّة فعلاً.
 *  2. **نسبةٌ إلى الخطأ**: من دخل المحادثة بعد أن أُنفق فيها المال يُحمَّله.
 *     مقيس على الإنتاج 2026-07-31: مستخدم استهلاكه من كيمي **صفر** عُرضت
 *     بطاقته بـ$2.49، لأنه دخل المحادثة في 23:46:33 وآخر طلب كيمي فيها كان
 *     23:41:57 — أي قبل دخوله بخمس دقائق.
 *
 * والقاعدة هنا: **كل دور مساعد يُنسب إلى كاتب أقرب مطالبة تسبقه زمنياً**، وهو
 * المعنى الحرفي لـ«من طلب هذا العمل». وأدوار الوكلاء الفرعيين والورشات ترث
 * مؤلِّف مطالبتهم الأمّ بالبناء نفسه: طوابعها تقع بعد المطالبة التي أطلقتها
 * وقبل التي تليها، فلا تحتاج ربطاً خاصاً.
 *
 * حدود معلومة تُقال ولا تُبتلع:
 *
 *  • **ما قبل أول مطالبة مسجَّلة يذهب للمالك.** ‏`message_authors` يُملأ من
 *    واجهة نسّاج، فمحادثة قُيدت من الطرفية لا صفوف لها وتُنسب كلّها للمالك.
 *    هذا أصدق تقدير متاح، وإسقاطها من الجميع يجعل المجموع يقلّ عن الفاتورة.
 *
 *  • **النسبة زمنية لا سببية.** لو أرسل مستخدمان مطالبتين متداخلتين في نفس
 *    الثانية، فأدوار ما بينهما تذهب لصاحب الأحدث. السجلّ لا يحمل ربطاً أدقّ.
 */

import { participantsDb } from '@/modules/database/index.js';

/**
 * مرشِّح سطر استهلاك: `true` = هذا الدور يخصّ المستخدم المستهدَف.
 * تُستدعى مرّة لكل سطر `assistant`، فبحثها ثنائيّ لا خطّي.
 */
export type UsageAttribution = (timestampMs: number) => boolean;

/**
 * يبني المرشِّح لمحادثة ومستخدم.
 *
 * يعود `null` حين لا نسبة مطلوبة أصلاً (مزوّد مشترك، أو مستخدم غير محدَّد)،
 * و`null` تعني **احسب كل شيء** — لا «احسب لا شيء». التمييز مقصود: الغياب هنا
 * غياب سؤال لا غياب إجابة.
 */
export function buildSessionAttribution(
  sessionId: string,
  userId: number | null,
): UsageAttribution | null {
  if (userId === null || !Number.isInteger(userId)) {
    return null;
  }

  const { ownerUserId, timeline } = participantsDb.getSessionAttribution(sessionId);

  // محادثة بلا خطّ مؤلِّفين: كلّها للمالك (أو لا شيء إن لم يكن هو المستهدَف).
  if (timeline.length === 0) {
    const belongs = ownerUserId === userId;
    return () => belongs;
  }

  // كل الخطّ لمستخدم واحد هو المستهدَف، والمالك هو نفسه ⇒ لا حاجة لبحث.
  const soleAuthor = timeline.every((entry) => entry.userId === timeline[0].userId);
  if (soleAuthor && timeline[0].userId === userId && (ownerUserId ?? userId) === userId) {
    return () => true;
  }

  const boundaries = timeline.map((entry) => entry.atMs);
  const owners = timeline.map((entry) => entry.userId);

  return (timestampMs: number): boolean => {
    // طابع غير صالح لا يُنسب تخميناً: يُترك للمالك كسائر ما لا مطالبة قبله.
    if (!Number.isFinite(timestampMs)) {
      return ownerUserId === userId;
    }

    // أقرب مطالبة **تسبق** هذا الدور: آخر عنصر طابعه ≤ الطابع.
    let low = 0;
    let high = boundaries.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (boundaries[mid] <= timestampMs) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    // دورٌ سبق أول مطالبة مسجَّلة (سجلّ أقدم من الميزة، أو محادثة طرفية) ⇒ للمالك.
    return found === -1 ? ownerUserId === userId : owners[found] === userId;
  };
}
