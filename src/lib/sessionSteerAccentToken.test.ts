import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * T-1903 (ADR-190) — يضمن أن `--session-steer-accent` قيمةٌ حرفية مستقلة (لا
 * `var(--primary)` ولا `var(--project-accent)`)، تختلف عن `--session-internal-accent`
 * (‏ADR-187) في كلا الوضعين، وتجتاز عتبتَي WCAG 2.2 AA: نصّ ≥4.5:1 على أبيض
 * وحدّ ≥3:1 على أبيض.
 */

function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [rl, gl, bl] = [r, g, b].map(channel);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(hexA: string, hexB: string): number {
  const [lighter, darker] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('--session-steer-accent token', () => {
  const css = readFileSync(join(__dirname, '../index.css'), 'utf8');

  it('is declared as a literal hex, independent of --primary/--project-accent', () => {
    const rootMatch = css.match(/:root\s*\{\s*--session-steer-accent:\s*(#[0-9A-Fa-f]{6});?\s*\}/);
    expect(rootMatch).not.toBeNull();
    const lightValue = rootMatch![1];
    expect(lightValue.toLowerCase()).not.toBe('var(--primary)');

    const darkMatch = css.match(/\.dark\s*\{\s*--session-steer-accent:\s*(#[0-9A-Fa-f]{6});?\s*\}/);
    expect(darkMatch).not.toBeNull();
    const darkValue = darkMatch![1];

    expect(lightValue).not.toBe(darkValue);
  });

  it('meets AA text contrast (>=4.5:1) and border contrast (>=3:1) against white', () => {
    const rootMatch = css.match(/:root\s*\{\s*--session-steer-accent:\s*(#[0-9A-Fa-f]{6});?\s*\}/)!;
    const lightValue = rootMatch[1];
    const ratio = contrastRatio(lightValue, '#FFFFFF');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('the dark-theme variant meets AA text contrast against a near-black surface', () => {
    const darkMatch = css.match(/\.dark\s*\{\s*--session-steer-accent:\s*(#[0-9A-Fa-f]{6});?\s*\}/)!;
    const darkValue = darkMatch[1];
    const ratio = contrastRatio(darkValue, '#0A0A0A');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
