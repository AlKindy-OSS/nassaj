/**
 * settingsDescriptionPadding.test.ts — **وصفٌ لا يضيف معلومةً لا يعود** (‏T-1221).
 *
 * ## الشكوى والقاعدة
 *
 * المالك (2026-08-04): «كل صفحة الإعدادات فيها كمية تكرار مزعجة جداً، خلي
 * الإعدادات سهلة وبسيطة». والتكرار كان نمطاً واحداً مطبَّقاً في كل تبويب: **لكل
 * صفٍّ لصيقةٌ ثم جملةٌ تعيد صياغتها**.
 *
 *   «السمة»                ← «اختر الوضع الفاتح أو الداكن، أو اتبع إعداد نظامك»
 *                              فوق ثلاثة أزرارٍ مكتوبٌ عليها نهاري/حسب النظام/ليلي
 *   «لغة العرض»            ← «اختر اللغة المفضّلة للواجهة»
 *   «موضع الأيقونة»        ← «مكان ظهور الأيقونة بالنسبة للشعار»
 *   «تغيير اسم المستخدم»   ← «حدّث اسم المستخدم الذي تسجّل به الدخول»
 *   «إظهار أرقام الأسطر»   ← «عرض أرقام الأسطر في المحرر»
 *
 * وكلفةُ هذه الجمل ليست المساحة وحدها: هي تُعلّم القارئ **أن الأوصاف لا تُقرأ**،
 * فيتخطّى معها الوصفَ الذي يحمل تحذيراً مالياً أو حدَّ حجمٍ أو أثراً لا رجعة فيه
 * حين يمرّ به. الحشو يُفسد الإشارة، لا المساحة فقط.
 *
 * ## لماذا قائمةُ مفاتيحَ متقاعدة لا كاشفٌ دلالي
 *
 * «هل يعيد هذا الوصفُ صياغةَ لصيقته؟» سؤالٌ لا يجيبه اختبار: كاشفٌ نصّي (يبدأ
 * بـ«اختر»/«عرض»/«تفعيل») يُسقط أوصافاً صحيحة ويمرّر أخرى فاسدة، فيصير حارساً
 * يُعطَّل بعد ثالث إنذارٍ كاذب. والانحرافُ الواقعي شكلُه معروف: يعود أحدُ هذه
 * المفاتيح بعينه إلى JSX — إمّا بيدٍ تظنّ الوصف ناقصاً، أو بدمجٍ يعيد سطراً
 * محذوفاً. وهذا **يُقاس بيقين**.
 *
 * فالمفاتيح تبقى في ملفّات الترجمة عمداً (حذفها من اثنتي عشرة لغة مخاطرةٌ بلا
 * مكسب، وملفّا `ar`/`en` تعمل عليهما جلساتٌ متوازية)، والمحظور هو **قراءتها في
 * سطح**. مفتاحٌ لا يقرؤه أحد لا يُطبع على الشاشة.
 *
 * RUNNER: vitest (`npm run test:client`). ‏`NODE_ENV=test` إلزامي في هذا الريبو.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const TABS_DIR = path.join(process.cwd(), 'src/components/settings/view/tabs');

/**
 * الأوصاف التي أُسقطت في T-1221 لأنها لا تقول شيئاً لا تقوله اللصيقة والتحكّم.
 *
 * إضافةُ مفتاحٍ هنا قرارٌ يُتَّخذ مرّةً؛ وحذفُه منها هو ما يجب أن يكون صعباً —
 * فمن أراد إعادة أحدها فليُعِد النظر في السبب أعلاه أوّلاً.
 */
const RETIRED_DESCRIPTIONS: readonly string[] = Object.freeze([
  // المظهر: الأزرار والقوائم المسمّاة تقول ما كانت تقوله هذه الجمل
  'appearanceSettings.themeMode.description',
  'account.languageDescription',
  'appearanceSettings.codeEditor.theme.description',
  'appearanceSettings.codeEditor.wordWrap.description',
  'appearanceSettings.codeEditor.lineNumbers.description',
  'appearanceSettings.branding.nodeIcon.position.description',
  // الملف الشخصي: عنوانٌ يعيد نفسه، ووصفُ تبويبٍ تقوله تبويباته
  'profile.subtitle',
  'profile.username.description',
  'profile.identity.description',
  // تبويبات يقول عنوانُها ما كان وصفُها يقوله
  'notifications.description',
  'users.subtitle',
]);

/** كل ملفّات الأسطح تحت `tabs/`، عدا الاختبارات. */
function surfaceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...surfaceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

describe('لا يعود الوصف الذي لا يضيف معلومة (T-1221)', () => {
  const files = surfaceFiles(TABS_DIR);

  it('تُقرأ أسطحُ الإعدادات أصلاً — وإلّا لحرس هذا الملفُّ فراغاً', () => {
    // اختبارٌ على الحارس نفسه: لو تحرّك المجلّد لصار كلُّ ما تحته يمرّ بلا فحص.
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(RETIRED_DESCRIPTIONS)('لا سطحَ يقرأ «%s»', (key) => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(`'${key}'`));
    expect(
      offenders.map((file) => path.relative(process.cwd(), file)),
      `«${key}» عاد إلى سطحٍ يقرؤه — وهو وصفٌ أُسقط لأنه يعيد صياغة لصيقته`,
    ).toEqual([]);
  });
});
