/**
 * themeStatusContrast.test.ts — WCAG 2.2 §1.4.3 لنبرات الحالة الثلاث
 * (`--success`, `--warning`, `--danger`) على كل بريست ووضع وسطح.
 *
 * سبب وجود الملف (‏B-399): لم تكن هذه الرموز موجودة أصلاً. فالحاجة إلى «نجاح»
 * و«تحذير» و«خطأ» نصّاً كانت تُقضى بدرجة Tailwind يكتبها المطوّر بيده — ستّ عشرة
 * مرّة في أربعة عشر ملفاً، بدرجات تضاربت بين السطحين (‏`amber-300` هنا
 * و`amber-400` هناك). وما لا يمرّ بمتغيّر لا يمرّ بحارس: قِيس بعد ذلك أن
 * `text-emerald-600` = 3.50 على الخلفية الفاتحة و3.77 على `--card`، وأن
 * `text-amber-700` يهبط إلى 4.29 داخل `bg-muted` — ثلاثتها دون 4.5.
 *
 * ‏`--destructive` استُثني عمداً من هذا الدور: هو رمز **سطح** يُقرأ فوقه
 * `--destructive-foreground`، وقياسه نصّاً على الخلفية الداكنة 1.74:1 — أي غير
 * مرئي عملياً. لذا وُلد `--danger` نبرةً نصّية مستقلّة عنه.
 *
 * الحدّ 4.5 لأن هذه النبرات تُستعمل على نصّ `text-[13px]` و`text-[11px]` — أصغر
 * من عتبة «النص الكبير» (18.66px عريض / 24px عادي) في كل مواضعها.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CUSTOM_COLORS,
  PRESET_ORDER,
  applyThemePreset,
  type ThemePresetId,
} from './theme-presets';

/* ────────────────────────── contrast math ────────────────────────── */

function channels(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100;
  const L = l / 100;
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = L - c / 2;
  const sextant: [number, number, number][] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = sextant[Math.floor(hue / 60) % 6];
  return [r + m, g + m, b + m];
}

function luminance(token: string): number {
  const m = token.trim().match(/^(-?[\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%$/);
  if (!m) throw new Error(`not an HSL token: "${token}"`);
  const [r, g, b] = channels(+m[1], +m[2], +m[3]).map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ───────────────────────── the default preset ────────────────────── */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css');
const css = readFileSync(cssPath, 'utf8');

function cssToken(name: string, dark: boolean): string {
  const base = css.indexOf('@layer base');
  const selector = dark ? '  .dark {' : '  :root {';
  const start = css.indexOf(selector, base);
  if (start < 0) throw new Error(`${selector.trim()} not found in index.css`);
  const open = css.indexOf('{', start);
  let depth = 1;
  let end = open + 1;
  while (end < css.length && depth > 0) {
    if (css[end] === '{') depth += 1;
    if (css[end] === '}') depth -= 1;
    end += 1;
  }
  const scope = css.slice(open + 1, end - 1);
  const m = scope.match(new RegExp(`${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`${name} not found in index.css (${dark ? '.dark' : ':root'})`);
  return m[1].trim();
}

/* ─────────────────────────────── the guard ───────────────────────── */

/** كل سطح يمكن أن تُرسم عليه نبرة حالة نصّاً. */
const SURFACES = ['--background', '--card', '--popover', '--muted', '--secondary'] as const;
const TONES = ['--success', '--warning', '--danger'] as const;

const MIN = 4.5;

function tokensFor(preset: ThemePresetId, dark: boolean): Record<string, string> {
  applyThemePreset({ preset, custom: DEFAULT_CUSTOM_COLORS }, dark);
  const style = document.documentElement.style;
  const read = (k: string) => style.getPropertyValue(k).trim() || cssToken(k, dark);
  const out: Record<string, string> = {};
  for (const t of TONES) out[t] = read(t);
  for (const s of SURFACES) out[s] = read(s);
  return out;
}

describe('نبرات الحالة تجتاز WCAG 1.4.3 على كل بريست ووضع وسطح', () => {
  beforeEach(() => {
    document.documentElement.style.cssText = '';
  });

  for (const preset of PRESET_ORDER) {
    for (const dark of [false, true]) {
      const label = `${preset} / ${dark ? 'dark' : 'light'}`;

      it(`${label}: كل نبرة ≥ ${MIN}:1 على الأسطح الخمسة`, () => {
        const tokens = tokensFor(preset, dark);
        const failures: string[] = [];
        for (const tone of TONES) {
          for (const surface of SURFACES) {
            const ratio = contrast(tokens[tone], tokens[surface]);
            if (ratio < MIN) failures.push(`${tone} on ${surface} = ${ratio.toFixed(2)}`);
          }
        }
        expect(failures, `${label} — ${failures.join(', ')}`).toHaveLength(0);
      });
    }
  }

  it('النبرات ثابتة عبر البريستات — الدلالة لا تتلوّن بالعلامة', () => {
    const read = () => {
      const style = document.documentElement.style;
      return TONES.map((t) => style.getPropertyValue(t).trim()).join('|');
    };
    applyThemePreset({ preset: 'alkindy', custom: DEFAULT_CUSTOM_COLORS }, false);
    const alkindy = read();
    applyThemePreset({ preset: 'gemini', custom: DEFAULT_CUSTOM_COLORS }, false);
    expect(read()).toBe(alkindy);
  });

  it('‏--danger منفصل عن --destructive: الأول نصّ والثاني سطح', () => {
    // لو تساويا لعاد العطب الذي وُلد الرمز لأجله: 1.74:1 نصّاً في الداكن.
    applyThemePreset({ preset: 'default', custom: DEFAULT_CUSTOM_COLORS }, true);
    const danger = cssToken('--danger', true);
    const destructive = cssToken('--destructive', true);
    expect(danger).not.toBe(destructive);
    expect(contrast(destructive, cssToken('--background', true))).toBeLessThan(MIN);
    expect(contrast(danger, cssToken('--background', true))).toBeGreaterThanOrEqual(MIN);
  });
});
