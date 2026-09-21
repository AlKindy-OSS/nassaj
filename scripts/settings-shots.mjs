#!/usr/bin/env node
/**
 * settings-shots.mjs — لقطات آلية لكل تبويبات الإعدادات، في الوضعين واللغتين.
 *
 * **لماذا وُجد.** قاعدة STYLE_LOCK §6 البند الثالث تقول: «تحقّق بصرياً بالمتصفح
 * قبل أي إعلان إنجاز — أربع مرات بدا شيء سليماً في الكود ومكسوراً على الشاشة».
 * ثم وقع ذلك بالضبط مرة خامسة في T-1172: مصفوفة طبقات بدت أنيقة في JSX وخرجت
 * على الشاشة اثني عشر مربّعاً فارغاً بلا نصّ، ورؤوسَ أعمدةٍ عربيةً فوق واجهة
 * إنجليزية. كلاهما كان سيُرى في ثانيتين لو وُجدت لقطة.
 *
 * **لماذا يوقّع توكناً بدل تسجيل الدخول.** بديله طلبُ كلمة مرور المالك وتمريرها
 * إلى متصفّح آلي — وهو ما لا يُفعل. السرّ نفسه الذي يوقّع به الخادم يوقّع به هذا
 * السكربت، والحمولة نسخةٌ من `generateToken` في `server/middleware/auth.js`
 * (‏`pwd_iat` منها إلزامي: تركُه يُنتج توكناً يرفضه الخادم بصمت).
 *
 * التشغيل: `node scripts/settings-shots.mjs [--out docs/audit/shots]`
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'docs/audit/settings-shots';

const BASE = process.env.SHOTS_BASE_URL ?? 'http://127.0.0.1:3004';
const DB = process.env.DATABASE_PATH
  ?? path.join(os.homedir(), '.local/share/nassaj-dev/db.sqlite');

/** التبويبات كما تقرأها `Settings.tsx` من `activeTab`. */
// T-1205 أسقط `vendors` حين حُذف التبويب، وT-1206 أعاده فهرساً ومنزلاً للشركة
// التي لا بلاطةَ لوكيلها. ولا يُحذف اسمٌ من هنا إلا مع تبويبه: لقطةُ تبويبٍ غير
// موجود تُنتج لقطةَ التبويب الافتراضي وتُقرأ سليمة.
const TABS = [
  'profile', 'agents', 'references', 'vendors', 'appearance', 'git',
  'api', 'notifications', 'users', 'command-board', 'about',
];

/** مقاسان: جوال حقيقي، وسطح مكتب. الأول هو ما يكسر أولاً. */
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  // الجوال يحتاج فتح درج الشريط الجانبي أولاً — زرّ الإعدادات فيه لا يُعرض إلا
  // بعده. يُفعَّل بـ`--mobile` بعد إضافة خطوة الفتح.
  ...(process.argv.includes('--mobile') ? [{ name: 'mobile', width: 390, height: 844 }] : []),
];

function envValue(key) {
  const line = readFileSync(path.join(process.cwd(), '.env'), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : null;
}

async function mintToken() {
  const secret = envValue('JWT_SECRET');
  if (!secret) throw new Error('JWT_SECRET غير موجود في .env');

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB, { readonly: true });
  const user = db
    .prepare("select id, username, role, password_changed_at from users where role='owner' order by id limit 1")
    .get();
  db.close();
  if (!user) throw new Error('لا يوجد مستخدم بدور owner');

  const { default: jwt } = await import('jsonwebtoken');
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      role: user.role,
      // نسخة طبق الأصل من generateToken — تركُها يُنتج توكناً مرفوضاً بصمت.
      pwd_iat: user.password_changed_at ?? 0,
    },
    secret,
    { expiresIn: '1h' },
  );
}

const token = await mintToken();
const { chromium } = await import('playwright');
const browser = await chromium.launch();

/**
 * محاور التغطية. اللغة محورٌ مستقلّ عن الوضع: العربية هي ما يكشف عطب RTL،
 * والفاتح هو ما يكشف الحدود الزائدة والأسطح شبه الشفافة.
 */
const MATRIX = [
  { theme: 'dark', lang: 'en' },
  { theme: 'light', lang: 'en' },
  { theme: 'dark', lang: 'ar' },
];

for (const { theme, lang } of MATRIX) {
  for (const vp of VIEWPORTS) {
    const dir = path.join(OUT, `${theme}-${lang}-${vp.name}`);
    mkdirSync(dir, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    const page = await context.newPage();

    // **الوضع الفاتح لا يُنتَج ببذر `localStorage` وحده.** تفضيل الحساب المحفوظ
    // على الخادم يهبط بعد تسجيل الدخول عبر `onApplyServerPreference('theme')`
    // فيدهس المبذور؛ وحتى إسقاط الصنف `dark` لا يكفي لأن محرّك البريستات يكتب
    // ثلاثيات HSL **مباشرةً في `style` الجذر** فتفوز على كل صنف. فالتقاطُ الفاتح
    // بلا اعتراضٍ ينتج ملفاً باسم `light-` ومحتواه داكن — وهو ما وقع فعلاً في
    // أول نسخة: إحدى عشرة لقطة تغطيةً وهمية تُقرأ دليلاً.
    //
    // الاعتراض هنا يزوّر **الاستجابة** لا الحساب: تفضيل الوضع وحده يُستبدَل،
    // وحساب المالك على الخادم لا يُكتب فيه شيء.
    await page.route('**/api/settings/ui-preferences', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      let body = {};
      try {
        body = await response.json();
      } catch {
        return route.fulfill({ response });
      }
      const prefs = body?.preferences ?? body ?? {};
      prefs.theme = theme;
      prefs.userLanguage = lang;
      await route.fulfill({
        response,
        body: JSON.stringify(body?.preferences ? { ...body, preferences: prefs } : prefs),
        headers: { ...response.headers(), 'content-type': 'application/json' },
      });
    });

    // البذر قبل أول تصيير: التوكن والوضع واللغة معاً، وإلا ومض تسجيل الدخول
    // ثم أُعيد التحميل فضاعت حالة التبويب.
    //
    // **ولماذا مراقبٌ لا سطرُ بذرٍ واحد.** بذر `localStorage` وحده لا يُنتج وضعاً
    // فاتحاً أبداً على حسابٍ تفضيله المحفوظ داكن: `ThemeContext` يشترك في
    // `onApplyServerPreference('theme')` فيهبط تفضيلُ الحساب من الخادم **بعد**
    // تسجيل الدخول ويدهس المبذور. النسخة الأولى من هذا السكربت لم تفعل ذلك،
    // فأنتجت أحد عشر ملفاً باسم `light-` ومحتواها داكن — تغطيةٌ وهمية أسوأ من
    // غيابها، لأنها تُقرأ دليلاً. المراقب يفرض الصنف على كل تغيير لاحق، ولا
    // يكتب شيئاً في حساب المالك.
    await page.addInitScript(
      ([t, th, lg]) => {
        localStorage.setItem('auth-token', t);
        localStorage.setItem('theme', th);
        localStorage.setItem('userLanguage', lg);

      },
      [token, theme, lang],
    );

    // لا مسار `/settings` في الموجّه — الإعدادات مودال تفتحه حالةٌ في الشريط
    // الجانبي. لذلك: افتح الجذر مرّة، انقر زرّ الإعدادات، ثم تنقّل بين التبويبات
    // داخل المودال. الاختيار بـ`data-settings-tab` لا باللصيقة المرئية، وإلا
    // عملت اللقطات بلغةٍ وفشلت بأخرى.
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    // ثلاثة أزرار إعدادات في الشجرة (مطويّ/سطح مكتب/جوال) واثنان منها مخفيّان
    // دائماً بحسب المقاس — `.first()` كان يلتقط المخفيّ ويتعلّق.
    await page.locator('[data-testid="open-settings"]:visible').first().click();
    await page.waitForTimeout(600);

    for (const tab of TABS) {
      const trigger = page.locator(`[data-settings-tab="${tab}"]:visible`).first();
      if ((await trigger.count()) === 0) {
        process.stdout.write(`${theme}-${lang}/${vp.name}/${tab}: غائب\n`);
        continue;
      }
      await trigger.click();
      // الشبكة الساكنة لا تعني تخطيطاً مستقرّاً: الخطوط العربية تصل بعدها
      // فتتغيّر ارتفاعات الأسطر كلها.
      await page.waitForTimeout(900);
      const modal = page.locator('.modal-backdrop').first();
      await modal.screenshot({ path: path.join(dir, `${tab}.png`) });
      process.stdout.write(`${theme}-${lang}/${vp.name}/${tab}\n`);
    }

    await context.close();
  }
}

await browser.close();
console.log(`\nتمّت اللقطات في ${OUT}`);
