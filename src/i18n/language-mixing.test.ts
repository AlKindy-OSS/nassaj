/**
 * حارس اختلاط اللغات في الواجهات (B-524).
 *
 * ثلاثة أنماط أنتجت اختلاطاً مرئياً فعلاً، وكلٌّ منها يمرّ صامتاً بلا حارس:
 *
 *   1. **ملفّ ترجمة على القرص غير مسجَّل في `resources`** — سبع لغات كانت تحمل
 *      `presence.json` مترجَماً بالكامل (168 مفتاحاً) وتعرض الشريط إنجليزياً،
 *      لأن `config.js` لم يستورده. القرص يقول «مترجَم» و i18next لا يراه.
 *   2. **قيمة عربية داخل حزمة لغة غير عربية** — تسرّبٌ عكسي يضع جملة عربية وسط
 *      واجهة إنجليزية.
 *   3. **مفتاح موجود في `ar` وغائب عن `en`** — الاحتياط هو `en`، فمفتاحٌ لا
 *      يقابله إنجليزيّ يسقط إلى اسمه الخام أمام كل مستخدم غير عربي.
 *
 * الحارس لا يفرض تغطيةً كاملة: النقص مقابل `en` سياسةٌ معلنة في `languages.js`
 * (الاحتياط لكل مفتاح)، والمفروض هنا أن يبقى النقص *اتجاهاً واحداً* فقط.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.join(HERE, 'locales');
const CONFIG = readFileSync(path.join(HERE, 'config.js'), 'utf8');

const ARABIC = /[؀-ۿ]/;

/** النطاقات المُحمَّلة خارج `resources` عمداً (‏`useWikiLabels` يستوردها بنفسه). */
const SELF_LOADED = new Set(['wiki']);

type Flat = Record<string, string>;

const flatten = (value: unknown, prefix = '', out: Flat = {}): Flat => {
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) flatten(entry, full, out);
    else out[full] = String(entry);
  }
  return out;
};

const read = (lang: string, ns: string): Flat | null => {
  const file = path.join(LOCALES, lang, `${ns}.json`);
  return existsSync(file) ? flatten(JSON.parse(readFileSync(file, 'utf8'))) : null;
};

const languages = readdirSync(LOCALES).filter((entry) => !entry.startsWith('.'));

/** النطاقات المسجَّلة لكل لغة داخل كتلة `resources` في config.js. */
const registeredFor = (lang: string): string[] => {
  const resources = CONFIG.split('resources:')[1] ?? '';
  const block = new RegExp(`['"]?${lang}['"]?:\\s*\\{([^}]*)\\}`, 'm').exec(resources);
  return block ? [...block[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]) : [];
};

test('كل ملفّ ترجمة على القرص مسجَّل في resources — لا ترجمة ميتة', () => {
  const dead: string[] = [];
  for (const lang of languages) {
    const registered = registeredFor(lang);
    for (const file of readdirSync(path.join(LOCALES, lang))) {
      const ns = file.replace('.json', '');
      if (!SELF_LOADED.has(ns) && !registered.includes(ns)) dead.push(`${lang}/${ns}`);
    }
  }
  assert.deepEqual(dead, [], `ملفات مترجَمة لا يراها i18next: ${dead.join(', ')}`);
});

test('لا قيمة عربية داخل حزمة لغة غير عربية', () => {
  const leaks: string[] = [];
  for (const lang of languages) {
    if (['ar', 'fa', 'ur'].includes(lang)) continue;
    for (const ns of registeredFor(lang)) {
      for (const [key, value] of Object.entries(read(lang, ns) ?? {})) {
        if (ARABIC.test(value)) leaks.push(`${lang}/${ns}:${key}`);
      }
    }
  }
  assert.deepEqual(leaks, [], `نصّ عربي في لغة غير عربية: ${leaks.join(', ')}`);
});

/**
 * صيغ الجمع التي تخصّ العربية وحدها. الإنجليزية تعرف `_one` و`_other` فقط، فغياب
 * `_two`/`_few`/`_many`/`_zero` عنها هو ما تقتضيه قواعد CLDR لا نقصٌ يُسدّ —
 * وi18next يختار الصيغة الصحيحة لكل لغة بنفسه.
 */
const ARABIC_ONLY_PLURAL = /_(zero|two|few|many)$/;

test('كل مفتاح عربي يقابله مفتاح إنجليزي — الاحتياط لا يسقط إلى اسم المفتاح', () => {
  const orphans: string[] = [];
  for (const file of readdirSync(path.join(LOCALES, 'ar'))) {
    const ns = file.replace('.json', '');
    const en = read('en', ns);
    if (!en) { orphans.push(`en/${ns} مفقود بالكامل`); continue; }
    for (const key of Object.keys(read('ar', ns) ?? {})) {
      if (ARABIC_ONLY_PLURAL.test(key)) continue;
      if (en[key] === undefined) orphans.push(`${ns}:${key}`);
    }
  }
  assert.deepEqual(orphans, [], `مفاتيح بلا مقابل إنجليزي: ${orphans.join(', ')}`);
});
