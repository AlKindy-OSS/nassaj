/**
 * WikiHome.landing.test.tsx — the two rules the landing-page redesign rests on.
 *
 * 1. NO SECOND INDEX. The landing page and the index column used to print the
 *    same nineteen page titles in one viewport. The landing page now navigates
 *    by symptom and question — headings inside pages — and repeats only the
 *    opening section's three steps, which it shows as a numbered path, a thing
 *    the index cannot express.
 *
 * 2. ONE AL-KINDY MARK IN THE PANEL. The mark attributes the authorship of the
 *    text, so it belongs at the end of the document's entrance, once. The index
 *    used to carry a second copy below its own fold.
 *
 * Rendering assertions are paired with source guards, because the failure they
 * protect against — someone reinstating the sidebar footer or the
 * close-the-index trick — is a source edit, and a rendering test of one
 * component cannot see it.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { SECTIONS } from '../wikiContent';
import { SYMPTOMS, QUESTIONS } from '../wikiDesk';

import WikiHome from './WikiHome';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(__dirname, relative), 'utf8');

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('WikiHome — rendered', () => {
  it('carries exactly one Al-Kindy mark', () => {
    const { container } = render(<WikiHome onNavigate={vi.fn()} onOpenSearch={vi.fn()} />);
    expect(container.querySelectorAll('img[src="/alkindy-symbol.svg"]')).toHaveLength(1);
  });

  it('shows no page title outside the dedicated start path', () => {
    const pathSection = SECTIONS.find((section) => section.id === 'start') ?? SECTIONS[0];
    if (!pathSection) return;
    const { container } = render(<WikiHome onNavigate={vi.fn()} onOpenSearch={vi.fn()} />);
    const clickable = Array.from(container.querySelectorAll('button')).map((b) =>
      (b.textContent ?? '').trim(),
    );

    for (const section of SECTIONS.filter((candidate) => candidate !== pathSection)) {
      for (const page of section.pages) {
        expect(
          clickable.some((text) => text.includes(page.title)),
          `"${page.title}" belongs to the index, not to the landing page`,
        ).toBe(false);
      }
      expect(clickable.some((t) => t.includes(section.title))).toBe(false);
    }
  });

  it('shows the start section as three numbered steps regardless of index order', () => {
    const pathSection = SECTIONS.find((section) => section.id === 'start') ?? SECTIONS[0];
    if (!pathSection) return;
    const { container } = render(<WikiHome onNavigate={vi.fn()} onOpenSearch={vi.fn()} />);
    const steps = container.querySelectorAll('[data-wiki-step]');
    expect(steps).toHaveLength(Math.min(3, pathSection.pages.length));
    expect(
      Array.from(container.querySelectorAll('[data-wiki-step-number]')).map(
        (n) => n.textContent,
      ),
    ).toEqual(['1', '2', '3'].slice(0, steps.length));
    expect(
      Array.from(steps).map(
        (step) => step.querySelector('[data-wiki-step-title]')?.textContent,
      ),
    ).toEqual(pathSection.pages.slice(0, 3).map((page) => page.title));
  });

  it('navigates to a heading anchor, not just to the file', () => {
    if (SYMPTOMS.length === 0) return;
    const onNavigate = vi.fn();
    render(<WikiHome onNavigate={onNavigate} onOpenSearch={vi.fn()} />);

    fireEvent.click(screen.getByText(SYMPTOMS[0].label));
    expect(onNavigate).toHaveBeenCalledWith(SYMPTOMS[0].file, SYMPTOMS[0].anchor);

    fireEvent.click(screen.getByText(QUESTIONS[0].label));
    expect(onNavigate).toHaveBeenCalledWith(QUESTIONS[0].file, QUESTIONS[0].anchor);
  });

  it('gives the two desk panels the same number of rows', () => {
    if (SECTIONS.length === 0) return;
    const { container } = render(<WikiHome onNavigate={vi.fn()} onOpenSearch={vi.fn()} />);
    const panels = container.querySelectorAll('[data-wiki-home-panel]');
    expect(panels).toHaveLength(2);
    const rowCounts = Array.from(panels).map(
      (p) => p.querySelectorAll('[data-wiki-entry-row]').length,
    );
    expect(rowCounts[0]).toBe(rowCounts[1]);
    expect(rowCounts[0]).toBe(6); // five entries plus the tail
  });

  it('opens the search dialog from the first block', () => {
    const onOpenSearch = vi.fn();
    const { container } = render(
      <WikiHome onNavigate={vi.fn()} onOpenSearch={onOpenSearch} />,
    );
    fireEvent.click(container.querySelector('[data-wiki-home-search]')!);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it('keeps every full-width home control on one visual surface', () => {
    const { container } = render(<WikiHome onNavigate={vi.fn()} onOpenSearch={vi.fn()} />);
    const controls = container.querySelectorAll(
      '[data-wiki-home-search], [data-wiki-step], [data-wiki-entry-row]',
    );

    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.classList.contains('nassaj-control')).toBe(true);
      expect(control.children).toHaveLength(1);
      expect(control.firstElementChild?.classList.contains('nassaj-control__surface')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

describe('source guards', () => {
  const sidebar = read('./WikiSidebar.tsx');
  const panel = read('./WikiPanel.tsx');
  const css = read('./wiki-panel.css');
  const home = read('./WikiHome.tsx');

  it('the index carries no Al-Kindy mark and no footer hook', () => {
    expect(sidebar).not.toContain('data-wiki-footer');
    expect(sidebar).not.toContain('alkindy-symbol.svg');
    expect(css).not.toContain('data-wiki-footer');
  });

  it('the index keeps the Nassaj logo in both themes', () => {
    expect(sidebar).toContain('nassaj-logo-on-light.svg');
    expect(sidebar).toContain('nassaj-logo-on-dark.svg');
    expect(sidebar).toContain('dark:hidden');
    expect(sidebar).toContain('dark:block');
  });

  it('nothing closes the index on the landing page any more', () => {
    expect(panel).not.toContain('shouldSidebarBeOpen');
    expect(panel).toContain('useState<boolean>(getInitialSidebarState)');
  });

  it('no size-tiering remains', () => {
    expect(home).not.toContain('toHomeBlocks');
    expect(home).not.toContain('LARGE_SECTION_PAGES');
    expect(home).not.toContain('data-wiki-home-tier');
    expect(css).not.toContain('data-wiki-home-tier');
  });

  it('the landing page never rotates or mirrors an icon', () => {
    expect(home).not.toContain('rtl:rotate-180');
    expect(home).not.toContain('rtl:-scale-x-100');
  });

  it('sizes its grids from the home container, not the viewport', () => {
    expect(css).toMatch(/container-name:\s*wiki-home/);
    expect(css).toMatch(/container-type:\s*inline-size/);
    expect(css).toMatch(/@container wiki-home \(min-width:\s*44rem\)/);
    expect(css).not.toMatch(
      /@media \(min-width:\s*768px\)[^{]*\{[\s\S]{0,120}\[data-wiki-home-desk\]/,
    );
  });

  it('puts geometry on roots and drawing plus wrapping on their surfaces', () => {
    for (const hook of ['home-search', 'step', 'entry-row']) {
      expect(css).toContain(`[data-wiki-${hook}] > .nassaj-control__surface`);
    }
    expect(css).toMatch(/\[data-wiki-step\] > \.nassaj-control__surface[\s\S]{0,500}white-space:\s*normal/);
    expect(css).toMatch(/\[data-wiki-entry-row\] > \.nassaj-control__surface[\s\S]{0,900}white-space:\s*normal/);
  });
});
