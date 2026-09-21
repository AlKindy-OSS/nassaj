import { FINE_POINTER_QUERY, resolveEnterSends } from '../lib/enter-behavior';

import { useMediaQuery } from './useMediaQuery';
import { useUiPreferences } from './useUiPreferences';

/**
 * هل تُرسل ضغطةُ Enter المجرّدة على هذا الجهاز الآن؟
 *
 * ‏[حرج] القيمة المحلولة **لا تُكتب في أي تخزين إطلاقاً** — حسابُ عرضٍ لا حالة.
 * ولو كُتبت لالتقطتها مرآةُ `preferencesSync` فرفعت نتيجةَ الجوال (`false`)
 * إلى الحساب فوق النيّة `'auto'`، فيصير أوّلُ فتحٍ من الهاتف قراراً دائماً على
 * كل أجهزة الحساب — وهو نفس العطل الذي جاءت هذه الميزة لإصلاحه.
 *
 * والاشتراك حيّ لا قراءةٌ مجمَّدة: وصلُ لوحة مفاتيح إلى جهاز لوحي يقلب
 * `(any-pointer: fine)` تحت المستخدم، فتتبعه القيمة بلا إعادة تحميل.
 * (حرسُ المسودّة الذي يمنع تطبيق القلب وسط تحرير رسالة يعيش عند المستهلك في
 * `useChatComposerState`، لأن المسودّة حالتُه هو.)
 */
export function useResolvedEnterBehavior(): boolean {
  const { preferences } = useUiPreferences();
  const hasFinePointer = useMediaQuery(FINE_POINTER_QUERY);

  return resolveEnterSends(preferences.enterBehavior, { hasFinePointer });
}
