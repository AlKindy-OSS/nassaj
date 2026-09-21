import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { TFunction } from 'i18next';

import SidebarHeader from './SidebarHeader';

vi.mock('../../../../contexts/BrandingContext', () => ({
  useBranding: () => ({
    title: null,
    logoUrl: null,
    logoDarkUrl: null,
    logoOnly: false,
    nodeIconDataUri: null,
    nodeIconPosition: 'start',
    nodeIconHref: null,
  }),
}));
vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
const authState = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('../../../auth', () => ({ useAuth: () => ({ user: { id: 1, role: authState.role } }) }));

const t = ((key: string) => key) as unknown as TFunction;

function renderHeader(overrides: Partial<React.ComponentProps<typeof SidebarHeader>> = {}) {
  const props: React.ComponentProps<typeof SidebarHeader> = {
    activeSection: 'projects',
    onSectionChange: vi.fn(),
    runningTerminalsCount: 2,
    onCollapseSidebar: vi.fn(),
    scheduledMessagesCount: 4,
    scheduledMessagesEnabled: true,
    scheduledMessagesActive: false,
    onOpenScheduledMessages: vi.fn(),
    t,
    ...overrides,
  };

  const result = render(<MemoryRouter><SidebarHeader {...props} /></MemoryRouter>);
  return { ...result, props };
}

describe('SidebarHeader primary navigation', () => {
  afterEach(() => {
    cleanup();
    authState.role = 'owner';
  });

  it('renders three equal route actions as navigation, not mixed ARIA tabs', () => {
    const { container } = renderHeader();
    const navigation = screen.getByRole('navigation', { name: 'sections.navigation' });
    const buttons = within(navigation).getAllByRole('button');

    expect(buttons.map((button) => button.textContent)).toEqual([
      'sections.projects',
      'sections.terminals2',
      'sections.scheduled4',
    ]);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(navigation.className).toContain('grid-cols-3');
    expect(navigation.className).toContain('h-8');
    expect(navigation.className).toContain('[@media(pointer:coarse)]:h-9');
    const safeArea = container.querySelector('.pwa-header-safe');
    expect((safeArea as HTMLElement)?.style.height).toBe('');
    expect((safeArea as HTMLElement)?.style.minHeight).toBe('');
    const sidebarRail = safeArea?.firstElementChild as HTMLElement | null;
    expect(sidebarRail?.className).toContain('sidebar-top-rail');
    expect(sidebarRail?.className).toContain('-mb-2');
    expect(sidebarRail?.className).not.toContain('app-top-rail');
    expect(sidebarRail?.children[0]?.className).toContain('app-top-rail');
    expect(sidebarRail?.children[0]?.className).not.toContain('border-b');
    expect(sidebarRail?.children[0]?.className).not.toContain('border-border/40');
    expect(sidebarRail?.children[1]?.className).toContain('h-[var(--control-height-compact)]');
    expect(sidebarRail?.children[1]?.className).not.toContain('border-b');
    expect(sidebarRail?.children[1]?.className).not.toContain('border-border/40');
    expect(sidebarRail?.children[1]?.className).not.toContain('border-t');
    expect(safeArea?.className).not.toContain('border-b');
  });

  it('gives the scheduled route sole active styling and dispatches each action', () => {
    const onSectionChange = vi.fn();
    const onOpenScheduledMessages = vi.fn();
    renderHeader({ scheduledMessagesActive: true, onSectionChange, onOpenScheduledMessages });
    const navigation = screen.getByRole('navigation', { name: 'sections.navigation' });
    const projects = within(navigation).getByRole('button', { name: 'sections.projects' });
    const terminals = within(navigation).getByRole('button', { name: /sections.terminals/ });
    const scheduled = within(navigation).getByRole('button', { name: /sections.scheduled/ });

    expect(projects.getAttribute('aria-current')).toBeNull();
    expect(terminals.getAttribute('aria-current')).toBeNull();
    expect(scheduled.getAttribute('aria-current')).toBe('page');

    fireEvent.click(projects);
    fireEvent.click(terminals);
    fireEvent.click(scheduled);
    expect(onSectionChange.mock.calls).toEqual([['projects'], ['terminals']]);
    expect(onOpenScheduledMessages).toHaveBeenCalledTimes(1);
  });

  it('shows all three tabs for a non-admin — Terminals visible but leads to permission-denied state', () => {
    authState.role = 'user';
    renderHeader();
    const navigation = screen.getByRole('navigation', { name: 'sections.navigation' });

    expect(within(navigation).getAllByRole('button')).toHaveLength(3);
    expect(within(navigation).getByRole('button', { name: 'sections.projects' })).toBeTruthy();
    expect(within(navigation).getByRole('button', { name: /sections.terminals/ })).toBeTruthy();
    expect(within(navigation).getByRole('button', { name: /sections.scheduled/ })).toBeTruthy();
    expect(navigation.className).toContain('grid-cols-3');
  });

  it('keeps status badges decorative and the touch row at its accessible minimum', () => {
    renderHeader();
    const navigation = screen.getByRole('navigation', { name: 'sections.navigation' });
    const terminals = within(navigation).getByRole('button', { name: 'sections.terminals' });

    expect(within(terminals).getByText('2').getAttribute('aria-hidden')).toBe('true');
    expect(navigation.className).toContain('h-8');
    expect(navigation.className).toContain('[@media(pointer:coarse)]:h-9');
    expect(navigation.className).toContain('items-stretch');
    expect(navigation.className).not.toContain('hover:hover');
    expect(document.querySelector('.pwa-header-safe')?.firstElementChild?.className).toContain('sidebar-top-rail');
  });

  it('keeps the borderless 90px rail in mobile/PWA and uses RTL-safe spacing', () => {
    const { container } = renderHeader();
    const safeArea = container.querySelector('.pwa-header-safe');
    const sidebarRail = safeArea?.firstElementChild as HTMLElement | null;

    expect((safeArea as HTMLElement)?.style.height).toBe('');
    expect((safeArea as HTMLElement)?.style.minHeight).toBe('');
    expect(sidebarRail?.className).toContain('sidebar-top-rail');
    expect(sidebarRail?.className).toContain('-mb-2');
    expect(sidebarRail?.children[0]?.className).toContain('app-top-rail');
    expect(sidebarRail?.children[0]?.className).not.toContain('border-b');
    expect(sidebarRail?.children[0]?.className).not.toContain('border-border/40');
    expect(sidebarRail?.children[1]?.className).toContain('h-[var(--control-height-compact)]');
    expect(sidebarRail?.children[1]?.className).not.toContain('border-b');
    expect(sidebarRail?.children[1]?.className).not.toContain('border-border/40');
    expect(sidebarRail?.children[1]?.className).not.toContain('border-t');
    const physicalUtilities = Array.from(sidebarRail?.querySelectorAll('[class]') ?? [])
      .flatMap((element) => Array.from(element.classList))
      .filter((token) => /^(ml|mr|pl|pr|left|right)-/.test(token));
    expect(physicalUtilities).toEqual([]);
  });

  it('keeps the brand mark optically centered in the identity row', () => {
    renderHeader();
    const logo = screen.getByRole('img', { name: 'common:brand.logoAlt' });

    expect(logo.parentElement?.className).toContain('-translate-y-0.5');
    expect(logo.parentElement?.className).not.toContain('-translate-y-2');
  });
});
