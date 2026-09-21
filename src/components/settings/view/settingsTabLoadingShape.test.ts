// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * حارس شكل الانتظار في تبويبات الإعدادات (‏ADR-098، سؤال المالك 2026-08-04).
 *
 * **القاعدة.** التبويب يُصيِّر عنوانه (‏`SettingsSection`) **قبل** أي فرع انتظار،
 * ويضع «جارٍ التحميل» داخل جسمه. الممنوع هو الارتداد المبكر: `if (loading)
 * return <نص/>;` قبل العنوان.
 *
 * **لماذا حارس وليس اتفاقاً.** أحد عشر تبويباً يتبع القاعدة وواحدٌ خالفها، ولم
 * يخالفها عن سوء نيّة: كاتبه أراد أن تُشبه حالةُ الانتظار حالةَ القائمة الفارغة،
 * وهو قرار محلّي معقول أنتج نتيجةً عامة سيّئة. القاعدة التي لا يحرسها شيء
 * تُنسى، والملف التالي يُكتب بعد شهر وحده.
 *
 * **ما يكسره الارتداد المبكر** — قِيس على صفحة «الوصول البرمجي» بلقطة المالك:
 *   1. لوحة فارغة تماماً أثناء الانتظار: لا شيء يقول أيّ تبويب هذا، فيُقرأ عطلاً.
 *   2. قفزة تخطيط عند وصول البيانات — يُستبدل سطرٌ واحد بصفحة كاملة.
 *   3. الفشل يصير صامتاً: لو تعطّل الطلب فلا عنوان يدلّ على موضع الخطأ.
 *
 * **الحارس يمنع الصياغة لا يختبر الحالة**، كحارس لغة السطوح المجاور: العيب
 * بنيويٌّ في ترتيب الشيفرة، ويظهر في المصدر قبل أن يظهر في شجرة مُصيَّرة.
 *
 * كل استثناء أدناه مقرونٌ بسببه وببند يُغلقه. استثناء بلا بند = القاعدة ماتت
 * بالتقسيط.
 */

const TABS_ROOT = path.join(__dirname, 'tabs');

/**
 * الاستثناء الوحيد، وهو مؤقَّت بحكم بنده لا بحكم العادة.
 *
 * `CredentialsSettingsTab.tsx` كان — لحظة كتابة هذا الحارس — قيد إعادة كتابة في
 * شجرة عمل جلسة موازية (إضافة `ExternalApiSection`، ‏T-1242). إصلاح ترتيبه
 * حينها كان سيضمّ ميزةً نصف مكتملة لغير كاتبها، وهو ثمنٌ أعلى من الانتظار.
 */
const KNOWN_VIOLATIONS = new Map<string, string>([
  ['CredentialsSettingsTab.tsx', 'T-1259 — يُصلَح فور تحرّر الملف من جلسة T-1242'],
]);

/** يجمع كل ملفات التبويبات، بما فيها المجلدات الفرعية (api-settings, users-settings…). */
function collectTabFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTabFiles(full, found);
    } else if (entry.endsWith('.tsx') && !entry.endsWith('.test.tsx')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * يجرّد التعليقات قبل الفحص. ملفات هذا المجلد توثّق أسبابها بذكر الصياغة
 * المحظورة حرفياً، فلولا التجريد لأسقط الحارسُ توثيقَ نفسه — وحارسٌ يعاقب على
 * شرح القاعدة يُحذف عند أول احتكاك.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('شكل الانتظار في تبويبات الإعدادات', () => {
  const files = collectTabFiles(TABS_ROOT);

  it('يجد تبويبات ليفحصها (حارسٌ لا يفحص شيئاً حارسٌ ميّت)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [path.basename(f), f] as const))(
    '%s — لا يكون فرع الانتظار أول ما يُصيَّر',
    (basename, full) => {
      const source = stripComments(readFileSync(full, 'utf8'));

      // فرع انتظار يرتدّ فوراً: `if (…loading…) { return <…`.
      const earlyReturn = /if\s*\([^)]*\bloading\b[^)]*\)\s*\{?\s*return\s*\(?\s*</;
      const early = earlyReturn.exec(source);
      if (!early) {
        expect(KNOWN_VIOLATIONS.has(basename)).toBe(false);
        return;
      }

      // المحك ليس «هل يملك SettingsSection» — فبعض التبويبات تُركّب أقساماً ولا
      // تستدعيه مباشرة (وهذا ما جعل صيغةً أولى من هذا الحارس تمرّ على المخالفة
      // المعروفة). المحك: هل هذا الارتداد هو **أول** ما يُصيَّره المكوّن؟ إن كان
      // كذلك فالصفحة تختفي كلها أثناء الانتظار.
      const firstJsxReturn = /return\s*\(?\s*</.exec(source);
      const loadingIsFirstRender =
        firstJsxReturn !== null && firstJsxReturn.index === early.index + early[0].lastIndexOf('return');

      if (!loadingIsFirstRender) {
        expect(KNOWN_VIOLATIONS.has(basename)).toBe(false);
        return;
      }

      expect(
        KNOWN_VIOLATIONS.get(basename),
        `${basename}: فرع الانتظار هو أول ما يُصيَّر، فتختفي الصفحة كلها أثناء ` +
          'التحميل. ضع الشرط داخل الجسم كما تفعل بقية التبويبات، أو سجّل استثناءً ' +
          'ببنده في KNOWN_VIOLATIONS.',
      ).toBeTruthy();
    },
  );
});
