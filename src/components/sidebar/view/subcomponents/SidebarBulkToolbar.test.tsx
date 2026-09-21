import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import arSidebar from '../../../../i18n/locales/ar/sidebar.json';
import deSidebar from '../../../../i18n/locales/de/sidebar.json';
import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import faSidebar from '../../../../i18n/locales/fa/sidebar.json';
import idSidebar from '../../../../i18n/locales/id/sidebar.json';
import itSidebar from '../../../../i18n/locales/it/sidebar.json';
import jaSidebar from '../../../../i18n/locales/ja/sidebar.json';
import koSidebar from '../../../../i18n/locales/ko/sidebar.json';
import ruSidebar from '../../../../i18n/locales/ru/sidebar.json';
import trSidebar from '../../../../i18n/locales/tr/sidebar.json';
import urSidebar from '../../../../i18n/locales/ur/sidebar.json';
import zhCnSidebar from '../../../../i18n/locales/zh-CN/sidebar.json';

import SidebarBulkToolbar from './SidebarBulkToolbar';

afterEach(cleanup);

describe('SidebarBulkToolbar', () => {
  it('keeps one selection kind and exposes bulk actions only after selection', () => {
    const onAction = vi.fn();
    render(
      <SidebarBulkToolbar
        kind="projects"
        selectedCount={0}
        visibleCount={2}
        isArchived={false}
        isBusy={false}
        isAvailable={false}
        onSelectVisible={vi.fn()}
        onClear={vi.fn()}
        onAction={onAction}
      />,
    );

    expect((screen.getByRole('button', { name: 'Archive' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses permanent-delete contract action for a selected batch', () => {
    const onAction = vi.fn();
    render(
      <SidebarBulkToolbar
        kind="sessions"
        selectedCount={2}
        visibleCount={2}
        isArchived={false}
        isBusy={false}
        isAvailable
        onSelectVisible={vi.fn()}
        onClear={vi.fn()}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(onAction).toHaveBeenCalledWith('delete_permanently');
  });

  it('shows the selection utilities in the more sheet without a duplicate selection summary', async () => {
    render(
      <SidebarBulkToolbar
        kind="sessions"
        selectedCount={2}
        visibleCount={3}
        isArchived={false}
        isBusy={false}
        isAvailable
        onSelectVisible={vi.fn()}
        onClear={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    expect(screen.queryByText('2 selected conversations')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const selectVisible = screen.getByRole('button', { name: 'Select visible' });
    const closeMenu = screen.getByRole('button', { name: 'Close menu' });
    expect(selectVisible).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(closeMenu));

    const reopen = screen.getByRole('button', { name: 'Reopen' });
    closeMenu.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(reopen);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(closeMenu);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More actions' }));
  });

  it('uses 44px touch targets below the compact desktop breakpoint', () => {
    render(
      <SidebarBulkToolbar
        kind="sessions"
        selectedCount={2}
        visibleCount={3}
        isArchived={false}
        isBusy={false}
        isAvailable
        onSelectVisible={vi.fn()}
        onClear={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('p-1');
    expect(dialog.className).toContain('md:w-fit');
    expect(dialog.className).toContain('md:max-w-[200px]');
    expect(dialog.querySelector('.grid')?.className).toContain('md:w-[154px]');
    expect(dialog.querySelector('.grid')?.className).toContain('gap-0.5');
    expect(screen.getByRole('button', { name: 'Select visible' }).className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: 'Select visible' }).className).toContain('md:min-h-8');
    expect(screen.getByRole('button', { name: 'Select visible' }).className).toContain('justify-start');
    expect(screen.getByRole('button', { name: 'Select visible' }).className).toContain('bulk-more-dialog-button');
    expect(screen.getByRole('button', { name: 'Close menu' }).className).toContain('md:size-8');
    expect(screen.getByRole('button', { name: 'More actions' }).className).toContain('md:size-8');
    expect(dialog.querySelector('.bulk-more-dialog-header')?.className).toContain('md:h-8');
  });

  it('uses a clean 36px desktop rail without doubled separators or shadow', () => {
    const { container } = render(
      <SidebarBulkToolbar
        kind="projects"
        selectedCount={2}
        visibleCount={3}
        isArchived={false}
        isBusy={false}
        isAvailable
        onSelectVisible={vi.fn()}
        onClear={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    const toolbar = container.firstElementChild as HTMLElement;
    expect(toolbar.className).toContain('min-h-11');
    expect(toolbar.className).toContain('md:h-9');
    expect(toolbar.className).not.toContain('border-y');
    expect(toolbar.className).not.toContain('shadow');
  });

  it('uses a two-action grid for projects', () => {
    render(
      <SidebarBulkToolbar
        kind="projects"
        selectedCount={2}
        visibleCount={3}
        isArchived={false}
        isBusy={false}
        isAvailable
        onSelectVisible={vi.fn()}
        onClear={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('dialog').querySelectorAll('.bulk-more-dialog-button')).toHaveLength(2);
  });

  it('provides every bulk label in every bundled sidebar locale', () => {
    const locales = [arSidebar, deSidebar, enSidebar, faSidebar, idSidebar, itSidebar, jaSidebar, koSidebar, ruSidebar, trSidebar, urSidebar, zhCnSidebar];
    for (const locale of locales) {
      expect(Object.keys(locale.bulk ?? {}).sort()).toEqual(Object.keys(enSidebar.bulk).sort());
    }
  });
});
