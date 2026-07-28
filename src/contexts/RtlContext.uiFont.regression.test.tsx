/**
 * Regression guard for the interface-font change (Settings → Appearance).
 *
 * Removing the `:root[dir="rtl"] { font-family: Tajawal … }` rule from
 * index.css was a *typography* change only. Direction is owned by RtlContext
 * (dir/lang on <html>) and by the bidi correction rules that live next to the
 * deleted block; if a future edit takes any of them with it, RTL silently
 * regresses in ways that are hard to spot in a screenshot (mirrored select
 * chevron, code runs dragged to the wrong side).
 *
 * So this file asserts both halves: the runtime behaviour, and the stylesheet
 * invariants that survived the deletion.
 */

import { readFileSync } from 'node:fs';

import { render, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';

import i18n from '../i18n/config.js';

import { RtlProvider } from './RtlContext.jsx';

// Paths are resolved from the repo root: under vite-node `import.meta.url` is
// an http:// URL, so it cannot be handed to node:fs.
const repoRoot = process.cwd();
const indexCss = readFileSync(`${repoRoot}/src/index.css`, 'utf8');
const indexHtml = readFileSync(`${repoRoot}/index.html`, 'utf8');

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  cleanup();
});

describe('RTL direction after the font rule was removed', () => {
  it('still flips the document to rtl/ar for Arabic', async () => {
    await i18n.changeLanguage('ar');
    render(<RtlProvider><div /></RtlProvider>);

    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
  });

  it('still returns to ltr/en for a Latin language', async () => {
    await i18n.changeLanguage('en');
    render(<RtlProvider><div /></RtlProvider>);

    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });
});

describe('index.css invariants', () => {
  it('no longer forces a font family on RTL', () => {
    // The deleted rule, in any whitespace shape.
    expect(indexCss).not.toMatch(/:root\[dir="rtl"\]\s*(body\s*,\s*)?[^{]*\{[^}]*font-family:\s*'Tajawal'/);
    // No font *declaration* may name Tajawal any more (the prose comment that
    // explains why the rule went away is expected to mention it).
    expect(indexCss).not.toMatch(/font-family:[^;]*Tajawal/);
  });

  it('keeps the direction corrections that lived beside it', () => {
    // Mirrored <select> chevron (background-position has no logical form).
    expect(indexCss).toMatch(/:root\[dir="rtl"\]\s+select\s*\{[^}]*background-position:\s*left/);
    // Technical surfaces pinned LTR + bidi-isolated inside an RTL document.
    expect(indexCss).toMatch(/:root\[dir="rtl"\]\s+\[dir="ltr"\][^{]*\{[^}]*direction:\s*ltr/);
    expect(indexCss).toMatch(/:root\[dir="rtl"\][^{]*\.cm-editor[^{]*\{[^}]*unicode-bidi:\s*isolate/);
  });

  it('keeps monospace on code/terminal surfaces under RTL', () => {
    expect(indexCss).toMatch(/:root\[dir="rtl"\][^{]*\{[^}]*font-family:\s*ui-monospace/);
  });

  it('routes the interface font through the single --font-ui variable', () => {
    expect(indexCss).toMatch(/--font-ui:\s*-apple-system/);
    expect(indexCss).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font-ui\)/);
  });
});

describe('index.html', () => {
  it('loads no remote web font (the app must work offline)', () => {
    expect(indexHtml).not.toContain('fonts.googleapis.com/css');
    expect(indexHtml).not.toContain('fonts.gstatic.com');
  });
});
