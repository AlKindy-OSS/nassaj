/**
 * WikiToolbar.standaloneExit.test.tsx — the way out of `/wiki`.
 *
 * Reported by the owner, 2026-07-31: "لما اوصل الويكي مافي طريقة ارجع لنسّاج".
 * The wiki renders in two places and only one of them has chrome around it —
 * as a tab inside MainContent the app's own navigation is the way back, but on
 * the standalone `/wiki` route the panel fills the viewport and the toolbar
 * carried exactly three controls: index toggle, breadcrumb, search. None of
 * them left the wiki. The only exit was the browser's back button.
 *
 * Why the exit must be a real `<a href>` and not a scripted close: the sidebar
 * opens the wiki with `window.open('/wiki', '_blank', 'noopener,noreferrer')`,
 * and `noopener` deliberately severs the `window.opener` reference that
 * `window.close()` needs. A tab opened that way cannot close itself.
 *
 * The route-level guard is a source assertion on App.tsx: a rendering test of
 * this component can never notice that the `/wiki` route stopped passing
 * `standalone`, which is the regression that would silently strand readers
 * again while every test here still passed.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import WikiToolbar from './WikiToolbar';

afterEach(cleanup);

const BACK_LABEL_AR = 'العودة إلى نسّاج';

function renderToolbar(standalone: boolean) {
  return render(
    <WikiToolbar
      sidebarOpen={false}
      onToggleSidebar={() => {}}
      sidebarToggleRef={{ current: null }}
      onOpenSearch={() => {}}
      onGoHome={() => {}}
      standalone={standalone}
    />,
  );
}

describe('the standalone wiki has a way back', () => {
  it('renders an exit link on the /wiki route', () => {
    renderToolbar(true);
    const back = screen.getByLabelText(BACK_LABEL_AR);
    expect(back).toBeTruthy();
    expect(back.tagName).toBe('A');
  });

  it('the exit points at the app root, so it works in a `noopener` tab', () => {
    renderToolbar(true);
    // getAttribute, not `.href`: jsdom resolves the property to an absolute URL.
    expect(screen.getByLabelText(BACK_LABEL_AR).getAttribute('href')).toBe('/');
  });

  it('does not render the exit when the wiki is a tab inside the app', () => {
    renderToolbar(false);
    expect(screen.queryByLabelText(BACK_LABEL_AR)).toBeNull();
  });

  it('defaults to no exit — a caller must opt in', () => {
    render(
      <WikiToolbar
        sidebarOpen={false}
        onToggleSidebar={() => {}}
        sidebarToggleRef={{ current: null }}
        onOpenSearch={() => {}}
        onGoHome={() => {}}
      />,
    );
    expect(screen.queryByLabelText(BACK_LABEL_AR)).toBeNull();
  });

  it('keeps the RTL reading and keyboard order: index, breadcrumb, search, exit', () => {
    const { container } = render(
      <WikiToolbar
        sidebarOpen={false}
        onToggleSidebar={() => {}}
        sidebarToggleRef={{ current: null }}
        onOpenSearch={() => {}}
        onGoHome={() => {}}
        standalone
        sectionTitle="ابدأ من هنا"
        pageTitle="ما هو نسّاج؟"
      />,
    );
    const toolbar = container.querySelector('[data-wiki-toolbar]')!;
    const focusables = Array.from(toolbar.querySelectorAll('button, a'));

    expect(focusables.map((node) => node.getAttribute('aria-label') ?? node.textContent?.trim()))
      .toEqual(['إظهار الفهرس', 'الرئيسية', 'ابحث في الويكي', BACK_LABEL_AR]);
    expect(toolbar.querySelector('[data-wiki-toolbar-divider]')?.nextElementSibling)
      .toBe(focusables[3]);
  });

  it('renders home as the current location instead of a no-op button', () => {
    const onGoHome = vi.fn();
    render(
      <WikiToolbar
        sidebarOpen={false}
        onToggleSidebar={() => {}}
        sidebarToggleRef={{ current: null }}
        onOpenSearch={() => {}}
        onGoHome={onGoHome}
      />,
    );

    const home = screen.getByText('الرئيسية');
    expect(home.tagName).toBe('SPAN');
    expect(home.getAttribute('aria-current')).toBe('page');
    expect(onGoHome).not.toHaveBeenCalled();
  });

  it('keeps home navigable from an article', () => {
    const onGoHome = vi.fn();
    render(
      <WikiToolbar
        sidebarOpen={false}
        onToggleSidebar={() => {}}
        sidebarToggleRef={{ current: null }}
        onOpenSearch={() => {}}
        onGoHome={onGoHome}
        sectionTitle="ابدأ من هنا"
        pageTitle="ما هو نسّاج؟"
      />,
    );

    const home = screen.getByRole('button', { name: 'الرئيسية' });
    home.click();
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });
});

describe('the route actually opts in', () => {
  const appSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'App.tsx'),
    'utf8',
  );

  it('App.tsx passes `standalone` to the /wiki panel', () => {
    // The wiki is rendered twice in the app; only the routed one takes the flag.
    expect(appSource).toMatch(/<WikiPanel\s+standalone\s*\/>/);
  });

  it('both label files carry the key — a missing one ships a raw key as a label', async () => {
    const ar = (await import('../../../i18n/locales/ar/wiki.json')).default;
    const en = (await import('../../../i18n/locales/en/wiki.json')).default;
    expect(ar.toolbar.backToApp).toBe(BACK_LABEL_AR);
    expect(typeof en.toolbar.backToApp).toBe('string');
    expect(en.toolbar.backToApp.length).toBeGreaterThan(0);
  });
});
