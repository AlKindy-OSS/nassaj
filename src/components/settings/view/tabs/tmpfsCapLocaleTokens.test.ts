/**
 * tmpfsCapLocaleTokens.test.ts — T-1868 MEDIUM 2 (qa round).
 *
 * `TmpfsCapSection.tsx` isolates the `/tmp` path from surrounding text with
 * `<bdi dir="ltr">`, driven by a `{{path}}` token in `tmpfsCap.title` /
 * `tmpfsCap.description`. Seven locales (de/it/ja/ko/ru/tr/zh-CN) once carried
 * the old literal-`/tmp` English text with no token at all — harmless in
 * isolation, but `withBidiIsolatedPath` used to append an extra `<bdi>/tmp</bdi>`
 * unconditionally, so those seven rendered the path TWICE. The component-side
 * fix makes that function tolerant (no token → plain text, no phantom `<bdi>`);
 * this guard pins the other half: every locale that defines these two keys at
 * all must define them WITH the token, so a locale added later can't reproduce
 * the double-render by omission alone.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES_DIR = path.join(__dirname, '../../../../i18n/locales');
// بعض اللغات (fa/id/ur حالياً) لا تشحن settings.json إطلاقاً بعد — تسقط إلى
// الإنجليزية عبر fallbackLng، فلا شيء لهذا الحارس ليفحصه فيها.
const locales = readdirSync(LOCALES_DIR).filter((entry) =>
  existsSync(path.join(LOCALES_DIR, entry, 'settings.json')),
);

function tmpfsCap(locale: string): { title?: string; description?: string } | null {
  const raw = readFileSync(path.join(LOCALES_DIR, locale, 'settings.json'), 'utf8');
  const parsed = JSON.parse(raw) as { tmpfsCap?: { title?: string; description?: string } };
  return parsed.tmpfsCap ?? null;
}

describe('tmpfsCap.{title,description} — كل لغة تُعرِّفهما تحمل توكن {{path}}', () => {
  for (const locale of locales) {
    const cap = tmpfsCap(locale);
    // لا مفتاح tmpfsCap إطلاقاً = سقوطٌ سليم إلى الإنجليزية عبر fallbackLng —
    // لا شيء يُفحص هنا (فارسي/إندونيسي/أردو حالياً).
    if (!cap) continue;

    it(`${locale}: tmpfsCap.title يحمل {{path}}`, () => {
      expect(cap.title, `${locale} tmpfsCap.title missing`).toBeTruthy();
      expect(cap.title).toContain('{{path}}');
      // ولا مسارٌ حرفيٌّ إلى جانب التوكن — وإلا يظهر مرّتين.
      expect(cap.title).not.toMatch(/\/tmp(?!\.cred)/);
    });

    it(`${locale}: tmpfsCap.description يحمل {{path}}`, () => {
      expect(cap.description, `${locale} tmpfsCap.description missing`).toBeTruthy();
      expect(cap.description).toContain('{{path}}');
      expect(cap.description).not.toMatch(/\/tmp(?!\.cred)/);
    });
  }

  it('يفحص أكثر من لغة واحدة فعلاً (اختبار طفرة عكسي على الاكتشاف)', () => {
    const withKey = locales.filter((locale) => tmpfsCap(locale));
    expect(withKey.length).toBeGreaterThanOrEqual(8);
  });
});
