import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '../../../../types/app';

import MainContentHeader from './MainContentHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en', dir: () => 'ltr' },
  }),
}));
vi.mock('../../../../hooks/useUiPreferences', () => ({
  useUiPreferences: () => ({ setPreference: vi.fn() }),
}));
vi.mock('../../../../hooks/useResolvedTabsMode', () => ({ useResolvedTabsMode: () => 'hidden' }));
vi.mock('./MobileMenuButton', () => ({ default: () => <button type="button">menu</button> }));
vi.mock('./MainContentTabSwitcher', () => ({ default: ({ sessionTabsOnly }: { sessionTabsOnly?: boolean }) => sessionTabsOnly ? <button>chat/shell</button> : null }));
vi.mock('./MainContentTitle', () => ({ default: () => <span>title</span> }));
vi.mock('./HeaderUsageIndicator', () => ({ default: () => null }));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

describe('MainContentHeader height and safe area', () => {
  afterEach(cleanup);

  it('keeps safe-area padding outside the 46px conversation rail on mobile', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    const { container } = render(
      <MainContentHeader
        activeTab="chat"
        setActiveTab={vi.fn()}
        selectedProject={{} as Project}
        selectedSession={null}
        isMobile
        onMenuClick={vi.fn()}
      />,
    );
    const safeArea = container.firstElementChild;

    expect(safeArea?.className).toContain('pwa-header-safe');
    expect(safeArea?.className).not.toContain('h-[46px]');
    expect(safeArea?.className).not.toContain('border-b');
    expect(safeArea?.firstElementChild?.className).toContain('app-top-rail');
    // T-1703 removed structural dividers from all themes.
    expect(safeArea?.firstElementChild?.className).not.toContain('border-b');
    expect(safeArea?.firstElementChild?.className).not.toContain('sidebar-top-rail');
    expect(safeArea?.firstElementChild?.className).not.toContain('py-');
    const scrollingContent = container.querySelector('[data-session-header-scroll]');
    expect(scrollingContent?.contains(screen.getByRole('button', { name: 'menu' }))).toBe(false);
    const sessionControls = container.querySelector('[data-session-tab-controls]');
    expect(sessionControls).not.toBeNull();
    expect(sessionControls?.parentElement?.dataset.headerTrailingControls).toBe('true');
    expect(scrollingContent?.contains(sessionControls)).toBe(false);
  });
});
