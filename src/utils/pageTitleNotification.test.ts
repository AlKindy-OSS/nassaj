/**
 * علامة عنوان التبويب — كاتبٌ واحد، وحالةٌ لا لحظة.
 *
 * تاريخ العلّة الذي يحرسه هذا الملف:
 *  • **B-506**: للعنوان أكثر من مالك. تأثير عنوان المشروع في الشريط الجانبي
 *    يُعاد تشغيله مع كل بثّ `projects_updated` — ونهايةُ أي دور تُطلق واحداً —
 *    فكان يكتب `document.title` مباشرةً فيمحو العلامة بعد أقل من ثانية. الحارس
 *    هو الكاتب الموحّد `setPageBaseTitle`.
 *  • **T-1294**: علامةٌ لكل نهاية، فـ«تمّ» على جولة فشلت كذبة.
 *  • **B-538/B-544**: العلامة إعلانُ حالةٍ قائمة لا إشعارُ لحظة. زال المؤقّت
 *    كلّه، وصارت ثلاث علامات تُشتقّ من حالة الجلسات: سؤالٌ ينتظر جواب المستخدم،
 *    أو خطأ، أو نهايةٌ ناجحة.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const DONE = '[Done] ';
const ERROR = '[Error] ';
const ASK = '[Ask] ';

/**
 * الوحدة تحمل حالة على مستوى الموديول (العلامة الحيّة)، فكل اختبار يستوردها
 * من جديد ليبدأ من صفحة بيضاء.
 */
async function freshModule() {
  vi.resetModules();
  return import('./pageTitleNotification');
}

describe('pageTitleNotification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.title = 'ـنسَّاجـ';
  });

  it('يضع العلامة على العنوان حسب الحالة', async () => {
    const { setTitleOutcome } = await freshModule();

    setTitleOutcome('done');
    expect(document.title).toBe(`${DONE}ـنسَّاجـ`);
  });

  it('كاتبُ العنوان الأساس لا يمحو العلامة — الانحدار الأصلي (B-506)', async () => {
    const { setTitleOutcome, setPageBaseTitle } = await freshModule();

    setTitleOutcome('done');
    // ما يفعله تأثير الشريط الجانبي عند كل بثّ `projects_updated`.
    setPageBaseTitle('nassaj-dev - ـنسَّاجـ');

    expect(document.title).toBe(`${DONE}nassaj-dev - ـنسَّاجـ`);
  });

  it('يحدّث الاسم الأساس تحت العلامة بدل تكديس بادئة ثانية', async () => {
    const { setTitleOutcome, setPageBaseTitle } = await freshModule();

    setTitleOutcome('error');
    setPageBaseTitle('أ - ـنسَّاجـ');
    setPageBaseTitle('ب - ـنسَّاجـ');

    expect(document.title).toBe(`${ERROR}ب - ـنسَّاجـ`);
  });

  it('لا يُعيد بادئةً مُرِّرت داخل الاسم الأساس نفسه', async () => {
    const { setTitleOutcome, setPageBaseTitle } = await freshModule();

    setTitleOutcome('done');
    setPageBaseTitle(`${DONE}nassaj-dev - ـنسَّاجـ`);

    expect(document.title).toBe(`${DONE}nassaj-dev - ـنسَّاجـ`);
  });

  it('بلا حالةٍ قائمة يكتب الاسم الأساس مجرّداً', async () => {
    const { setPageBaseTitle } = await freshModule();

    setPageBaseTitle('nassaj-dev - ـنسَّاجـ');

    expect(document.title).toBe('nassaj-dev - ـنسَّاجـ');
  });

  /**
   * B-538/B-544 — الحارس الأهمّ: العلامة **لا تزول بمرور الوقت**. كانت تُمسح
   * بعد ثانيتين من حضور المستخدم، فمن كان غائباً — وهو وحده من تعنيه — لم
   * يرها قطّ. عمرُها اليوم عمرُ الحالة التي رفعتها.
   */
  it('لا تزول بمرور الوقت مهما طال', async () => {
    vi.useFakeTimers();
    try {
      const { setTitleOutcome } = await freshModule();

      setTitleOutcome('done');
      vi.advanceTimersByTime(60_000);

      expect(document.title).toBe(`${DONE}ـنسَّاجـ`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('تزول حين تُفتح آخر محادثة تنتظر', async () => {
    const { setTitleOutcome } = await freshModule();

    setTitleOutcome('done');
    setTitleOutcome(null);

    expect(document.title).toBe('ـنسَّاجـ');
  });

  /**
   * B-544 — تبديل الحالة يستبدل البادئة ولا يكدّسها، في كل الاتجاهات: كان
   * `[Error]` يحجب `[Done]` حجباً دائماً لأن رفعها كان مشروطاً بغياب الأخرى.
   */
  it('تبديل الحالة يستبدل البادئة في الاتجاهين', async () => {
    const { setTitleOutcome } = await freshModule();

    setTitleOutcome('done');
    setTitleOutcome('error');
    expect(document.title).toBe(`${ERROR}ـنسَّاجـ`);

    setTitleOutcome('done');
    expect(document.title).toBe(`${DONE}ـنسَّاجـ`);

    setTitleOutcome('question');
    expect(document.title).toBe(`${ASK}ـنسَّاجـ`);
  });

  it('العلامات لاتينية ولا تُترجَم — RTL ينقلب بغيرها (T-1294)', async () => {
    const { setTitleOutcome } = await freshModule();

    for (const [outcome, prefix] of [['done', DONE], ['error', ERROR], ['question', ASK]] as const) {
      setTitleOutcome(null);
      setTitleOutcome(outcome);
      expect(document.title.startsWith(prefix)).toBe(true);
      // أول محرف قوي في العنوان لاتيني ⇒ لا ينقلب الاتجاه في RTL.
      expect(/^[[A-Za-z]/.test(document.title)).toBe(true);
    }
  });

  it('اسم العلامة واسم المشروع جزآن لا يدهس أحدهما الآخر', async () => {
    const { setPageBrandName, setPageContextName, setTitleOutcome } = await freshModule();

    setPageBrandName('دار الكِندِي');
    setPageContextName('nassaj-dev');
    setTitleOutcome('question');

    expect(document.title).toBe(`${ASK}nassaj-dev - دار الكِندِي`);

    setPageContextName(null);
    expect(document.title).toBe(`${ASK}دار الكِندِي`);
  });
});

/**
 * حارس الملكية: أي كاتب مباشر لـ`document.title` خارج هذه الوحدة يمحو العلامة
 * صامتاً. يمنع **الصياغة** لا الحالة — أرخص من مطاردة الانحدار بعد وقوعه.
 */
describe('ملكية document.title', () => {
  const SRC = join(process.cwd(), 'src');
  const ALLOWED = new Set(['utils/pageTitleNotification.ts', 'utils/pageTitleNotification.test.ts']);

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('لا كاتب مباشر خارج الوحدة', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (ALLOWED.has(rel)) continue;
      // التعليقات تُنزع أولاً: أكثر مواضع ذكر `document.title` في هذا المستودع
      // تعليقاتٌ تنهى عن الكتابة المباشرة — عدُّها مخالفةً يجعل الحارس يصيح
      // على من يشرح القاعدة لا على من يخرقها.
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      // يلتقط الإسناد المباشر وصيغة الإضافة معاً.
      if (/(^|[^.\w])document\.title\s*(=[^=]|\+=)/.test(source)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
