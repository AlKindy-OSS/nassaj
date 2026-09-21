// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * حارس لغة سطوح الإعدادات (`docs/design/SETTINGS-SURFACE-LANGUAGE.md`، مهمة T-1172).
 *
 * **لماذا حارسٌ آليّ ولماذا الآن.** العيوب التي دفعت إلى هذا الترحيل لم تكن قراراً
 * سيئاً واحداً، بل انجرافاً: اثنان وعشرون ملفاً بنى كلٌّ منها شكله بأصناف خام،
 * فتراكمت أربع طبقات إطار على شاشة واحدة وستّ عائلات ألوان خامّة في ملف واحد. ما
 * يعيد هذا الانجراف ليس نيّةً مخالفة بل ملفاً جديداً يُكتب بعد شهر وحده. القاعدة
 * التي لا يحرسها شيء تُنسى، ومراجعة العين لا تُشغَّل في كل PR.
 *
 * **الحارس يمنع الصياغة لا يختبر الحالة** — يفحص الأصناف نصّاً في المصدر، لأن
 * العيب هنا صياغيٌّ بطبعه (`bg-card/50` بدل `bg-card`) ولا يظهر في شجرة مُصيَّرة
 * إلا بقياس بكسلي لا يملكه هذا المستوى من الاختبار.
 *
 * **التعليقات تُجرَّد قبل الفحص.** ملفات هذا المجلد توثّق أسبابها بذكر الصياغة
 * المحظورة حرفياً («`bg-card` بدل `bg-card/50`»)، فلولا التجريد لأسقط الحارسُ
 * توثيقَ نفسه — وحارسٌ يعاقب على شرح القاعدة يُحذف في أول احتكاك.
 *
 * كل استثناء أدناه مقرونٌ بسببه. استثناء بلا سبب = القاعدة ماتت بالتقسيط.
 */

const ROOT = path.join(__dirname);

/** ما هو خارج «منطقة المحتوى» أصلاً بنصّ §0 من الـBrief. */
const OUT_OF_SCOPE_SURFACES = new Set([
  'Settings.tsx', // صدفة المودال: غطاء `bg-background/80` + لوح `rounded-xl`
  'SettingsSidebar.tsx', // الشريط الجانبي سطحٌ ملاحي لا محتوى
  'UserDialogShell.tsx', // صدفة مودال ثانوية — نفس حكم `Settings.tsx`
]);

/**
 * زوجا النبرة الوحيدان المسموح بهما حتى يُضاف `--warning` و`--success` إلى
 * `src/index.css` (§6 من الـBrief). نصٌّ فقط: أي خلفية أو حدّ بهذين اللونين يسقط.
 */
const SANCTIONED_TONE_PAIRS = [
  'text-warning',
  'text-success',
];

/**
 * أصحابُ عنوان الصفحة — **ملفٌّ واحد لكل تبويب** يملك `level="page"`.
 *
 * ‏`page` مقاسُ عنوان التبويب (`text-2xl`) و`section` ما دونه. عنوانان بمقاس
 * الصفحة في شاشة واحدة يُسقطان ما يقول أيّهما يحتوي الآخر — وهو العطل الذي وُجد
 * السلّم أصلاً لعلاجه.
 *
 * ‏`ApiKeysSection.tsx` هنا بسببٍ لا استثناءً: هو **كامل** محتوى تبويب `api`،
 * فرأسُه رأسُ التبويب.
 */
const PAGE_HEADING_OWNERS = new Set([
  'AgentsSettingsTab.tsx',
  'VendorsSettingsTab.tsx',
  'UsersSettingsTab.tsx',
  'NotificationsSettingsTab.tsx',
  'AppearanceSettingsTab.tsx',
  'AboutTab.tsx',
  'ProfileSettingsTab.tsx',
  'GitSettingsTab.tsx',
  'CommandBoardSettingsTab.tsx',
  // ‏`ConnectorsSettingsTab.tsx` كان الغائب الوحيد من بين أحد عشر تبويباً تستعمل
  // `level="page"` — فحُكم عليه الحارس بعنوانٍ هو رأسُ تبويبه بحقّ. القائمة نقصت
  // اسماً، والمكوّن سليم.
  'ConnectorsSettingsTab.tsx',
  // ‏T-1242: عنوان تبويب «الوصول البرمجي» انتقل من قائمة المفاتيح إلى مفتاح
  // التشغيل الرئيسي فوقها — فالمفاتيح صارت قسماً تحته لا رأس الصفحة. مالكٌ
  // واحد للتبويب كما كان، غيرَ أنّه غيرُه.
  'ExternalApiSection.tsx',
  // تبويب «المرجعيّات» — رأسُه رأسُ تبويبه، والمواد الأربع أقسامٌ تحته.
  'ReferencesSettingsTab.tsx',
]);

/**
 * كل إسنادٍ لخاصّية `level` بصيغته الكاملة — **بما فيها القيمة المشروطة**.
 *
 * ‏عمى الحارس (‏T-1207/بند 5): كان يفحص السلاسل الحرفية وحدها، و`level={standalone ? 'page' :
 * 'section'}` قيمةٌ مشروطة لا سلسلة، فمرّ عنوانٌ ثانٍ بمقاس الصفحة داخل تبويب
 * الوكلاء والفحصُ أخضر. القاعدة كانت مكسورةً والحارسُ لا يراها — وحارسٌ أعمى
 * أسوأ من لا حارس: يُقرأ ضماناً. فيُلتقط الآن الشكلان معاً، ويُسأل عن ذكر `page`
 * داخل التعبير كلّه.
 */
const LEVEL_ATTRIBUTE = /\blevel=(?:"[^"]*"|'[^']*'|\{[^}]*\})/g;

/**
 * **حدّ خطوط الصفوف** (قرار المالك 2026-08-03، §2.2 من الـBrief).
 *
 * «صفحة المستخدمين ممكن تُستخدم فيها خطوط الجدول، لكن لا تُعمَّم كنمط على كل ما
 * يشبهها». والقاعدة بلا حارس تعود: أول وكيلٍ يرى خطّاً في تبويبٍ سيقيس عليه في
 * تبويبه، فيعود «الدفتر» الذي أُسقط في T-1172.
 *
 * القناة الوحيدة المشروعة هي `SettingsGroup divided` — تُرفع في موضع الاستدعاء
 * لا في البدائية — ومالكها **ملفٌ واحد**: جدول الأعضاء.
 */
const DIVIDED_PROP_OWNER = 'UsersSettingsTab.tsx';

/**
 * الملفّات التي كتبت `divide-y` بيدها **قبل** هذا الحدّ. دَينٌ موروث مُجمَّد لا
 * سابقةٌ يُقاس عليها: الفحص أدناه **مجموعةٌ جزئية**، فحذفُ أيٍّ منها يبقى أخضر
 * وإضافةُ ملفٍّ جديد تسقط فوراً.
 *
 * ‏`SettingsGroup.tsx` ليست دَيناً: هي **تنفيذ** الخاصيّة الاختيارية، والصنف
 * فيها لا يُرسم إلا حين تُرفع `divided` في موضع الاستدعاء.
 */
const HANDWRITTEN_DIVIDE_ALLOWED = new Set([
  'SettingsGroup.tsx',
  'ApiKeysSection.tsx', // قائمة مفاتيح — سابقة لِلحدّ، لا تُوسَّع
  'PasskeysSection.tsx', // قائمة مفاتيح مرور — سابقة لِلحدّ
  'GithubCredentialsSection.tsx', // قائمة اعتمادات — سابقة لِلحدّ
]);

/** ألفا مسموحة على النبرات لا على الأسطح (§1). */
const TONE_ALPHA = /\b(bg|text|border|ring)-(primary|destructive|ring|accent)\/\d+/g;

function collectTsx(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return collectTsx(full);
    if (!full.endsWith('.tsx')) return [];
    if (full.includes('.test.')) return [];
    return [full];
  });
}

/** يجرّد تعليقات الكتلة والسطر — انظر ديباجة الملف. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FILES = collectTsx(ROOT).map((file) => ({
  rel: path.relative(ROOT, file),
  base: path.basename(file),
  code: stripComments(readFileSync(file, 'utf8')),
}));

function offenders(predicate: (file: (typeof FILES)[number]) => RegExpMatchArray | null) {
  return FILES.flatMap((file) => {
    const hits = predicate(file);
    return hits ? [`${file.rel}: ${[...new Set(hits)].join(', ')}`] : [];
  });
}

describe('لغة سطوح الإعدادات — الحارس', () => {
  it('لا ألفا على أسطح الخلفية (خمسة ألفاءات = خمسة أسطح لا واحد)', () => {
    expect(
      offenders((file) =>
        OUT_OF_SCOPE_SURFACES.has(file.base)
          ? null
          : file.code.match(/\bbg-(card|muted|background|secondary|popover)\/\d+/g),
      ),
    ).toEqual([]);
  });

  it('لا `rounded-xl` داخل منطقة المحتوى (قيمة ثابتة لا تُشتقّ من --radius)', () => {
    expect(
      offenders((file) =>
        OUT_OF_SCOPE_SURFACES.has(file.base) ? null : file.code.match(/\brounded-xl\b/g),
      ),
    ).toEqual([]);
  });

  it('لا لصيقة دون 13px — `text-xs` ممنوع (STYLE_LOCK §1)', () => {
    expect(offenders((file) => file.code.match(/\btext-xs\b/g))).toEqual([]);
  });

  it('لا `letter-spacing` ولا ALL-CAPS على نصّ عربي (جذر B-329)', () => {
    expect(offenders((file) => file.code.match(/\b(tracking-(tight|wide|wider|widest)|uppercase)\b/g))).toEqual([]);
  });

  it('لا لون خام — عدا زوجَي النبرة المعتمدين نصّاً فقط (§6)', () => {
    const RAW =
      /\b(bg|text|border|ring|from|to|via)-(orange|green|blue|purple|red|emerald|amber|yellow|indigo|violet|teal|rose|sky|zinc|gray|slate|stone|neutral|lime|cyan|fuchsia|pink)-\d{2,3}\b/g;
    expect(
      offenders((file) => {
        let code = file.code;
        for (const pair of SANCTIONED_TONE_PAIRS) code = code.split(pair).join('');
        // `text-white` على لوحة الأفاتار المشتركة تباينٌ مقصود فوق صورة، لا نبرة.
        code = code.split('text-white').join('');
        return code.match(RAW);
      }),
    ).toEqual([]);
  });

  it('حلقة التركيز من `--ring` وحده — حين يسقط الإطار تصير الأثر الوحيد', () => {
    expect(
      offenders((file) => file.code.match(/focus-visible:ring-(?!2\b|1\b|offset|ring\b)[a-z]+-?\d*/g)),
    ).toEqual([]);
  });

  it('عنوانُ صفحةٍ واحد لكل تبويب — ولا `page` في لوحٍ داخله', () => {
    expect(
      offenders((file) => {
        if (PAGE_HEADING_OWNERS.has(file.base)) return null;
        const hits = file.code.match(LEVEL_ATTRIBUTE);
        const bad = (hits ?? []).filter((hit) => hit.includes('page'));
        return bad.length > 0 ? (bad as unknown as RegExpMatchArray) : null;
      }),
    ).toEqual([]);
  });

  it('يرى القيمة المشروطة لا السلسلة الحرفية وحدها (اختبار طفرة عكسي)', () => {
    // الصياغة بعينها التي مرّت من تحت الحارس القديم. لو عاد الفحص
    // إلى `level="page"` نصّاً لسقط هذا الاختبار قبل أن يعود العنوان الثاني.
    const conditional = `level={standalone ? 'page' : 'section'}`;
    const literal = 'level="page"';
    const innocent = `level="section"`;
    expect((conditional.match(LEVEL_ATTRIBUTE) ?? []).some((hit) => hit.includes('page'))).toBe(true);
    expect((literal.match(LEVEL_ATTRIBUTE) ?? []).some((hit) => hit.includes('page'))).toBe(true);
    expect((innocent.match(LEVEL_ATTRIBUTE) ?? []).some((hit) => hit.includes('page'))).toBe(false);
  });

  it('خطوط الصفوف حكرٌ على جدول الأعضاء — `divided` لا تُرفع في تبويب آخر', () => {
    expect(
      offenders((file) =>
        file.base === DIVIDED_PROP_OWNER
          ? null
          : file.code.match(/<SettingsGroup[^>]*\bdivided\b/g),
      ),
    ).toEqual([]);
  });

  /**
   * **ارتفاع الزرّ من `Button.tsx` وحدها** (‏T-1232، شكوى المالك 2026-08-04:
   * «وحّد حجم الأزرار… كآلية موحّدة لكامل نسّاج»).
   *
   * البدائية تعرّف السلّم: `sm` = `h-9`، و`default` = `h-10`. وثلاثةُ مواضع في
   * شجرة الوكلاء كانت تُلحق `h-8` بـ`size="sm"`، فخرج زرٌّ أقصرَ من جاره بأربعة
   * بكسلات — فرقٌ يُرى ولا يُفسَّر، ويتكرّر بلا نمطٍ لأن التجاوز اليدوي لا قاعدة
   * له.
   *
   * ويُقاس على `<Button` وحده لا على كل `h-8`: الارتفاع الصريح مشروعٌ على شارةٍ
   * أو صورةٍ أو حقل — الممنوع أن يُعاد تعريف سلّمٍ **موجود**.
   */
  it('لا ارتفاع مكتوب بيدٍ على زرّ — السلّم في `Button.tsx` وحده', () => {
    expect(
      offenders((file) =>
        file.code.match(/<Button[^>]*className="[^"]*\bh-(?:7|8|9|10|11|12)\b[^"]*"/g)),
    ).toEqual([]);
  });

  it('لا `divide-y` مكتوبة بيد في ملفٍّ جديد — القناة هي `divided` وحدها', () => {
    expect(
      offenders((file) =>
        HANDWRITTEN_DIVIDE_ALLOWED.has(file.base) ? null : file.code.match(/\bdivide-y\b/g),
      ),
    ).toEqual([]);
  });

  it('جدول الأعضاء نفسه لا يكتب الخطّ بيده — يرفع الخاصيّة (اختبار طفرة عكسي)', () => {
    // لو أُضيف `UsersSettingsTab.tsx` إلى قائمة الدَّين لصار له طريقان إلى
    // الخطّ، وسقط معنى «قناة واحدة يحرسها الفحص أعلاه».
    expect(HANDWRITTEN_DIVIDE_ALLOWED.has(DIVIDED_PROP_OWNER)).toBe(false);
    const consumer = '<SettingsGroup as="ul" divided>';
    const innocent = '<SettingsGroup as="ul">';
    expect(consumer.match(/<SettingsGroup[^>]*\bdivided\b/g)).toHaveLength(1);
    expect(innocent.match(/<SettingsGroup[^>]*\bdivided\b/g)).toBeNull();
  });

  it('الألفا مسموحة على النبرات — الحارس لا يمنعها (اختبار طفرة عكسي)', () => {
    // لو منع الحارسُ ألفا النبرات لسقط `bg-destructive/5` في بطاقة الخطر
    // و`bg-primary/15` في خلايا `TierMatrix` — وكلاهما مطلوب بنصّ §1 و§2.5.
    const sample = 'bg-destructive/5 bg-primary/15';
    expect(sample.match(TONE_ALPHA)).toHaveLength(2);
    expect(sample.match(/\bbg-(card|muted|background|secondary|popover)\/\d+/g)).toBeNull();
  });
});
