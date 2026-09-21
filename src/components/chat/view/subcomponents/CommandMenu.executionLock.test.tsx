import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CommandMenu from './CommandMenu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe('CommandMenu execute lock', () => {
  it('labels model-disabled skills without disabling manual selection', () => {
    const command = { name: '/to-spec', namespace: 'skill', type: 'skill', metadata: { disableModelInvocation: true } };
    const onSelect = vi.fn();
    render(<CommandMenu commands={[command]} isOpen onClose={vi.fn()} onSelect={onSelect} />);
    expect(screen.getByText('skillObservations.manualOnly')).toBeTruthy();
    const row = screen.getByText('/to-spec').closest('[role="option"]');
    expect(row?.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(row!);
    expect(onSelect).toHaveBeenCalledWith(command, 0, false);
  });
  it('يمنع اختيار صف execute المعطل مع إبقاء صف insert قابلاً للاختيار', () => {
    const compact = {
      name: '/compact',
      namespace: 'builtin',
      type: 'built-in',
      metadata: { type: 'builtin', hasHandler: true },
    };
    const rename = {
      name: '/rename',
      namespace: 'builtin',
      type: 'built-in',
      metadata: { type: 'builtin', hasHandler: true, argumentHint: '<name>' },
    };
    const onSelect = vi.fn();

    render(
      <CommandMenu
        commands={[compact, rename]}
        isOpen
        onClose={vi.fn()}
        onSelect={onSelect}
        isCommandDisabled={(command) => command.name === '/compact'}
      />,
    );

    const compactRow = screen.getByText('/compact').closest('[role="option"]');
    const renameRow = screen.getByText('/rename').closest('[role="option"]');
    expect(compactRow?.getAttribute('aria-disabled')).toBe('true');
    expect(renameRow?.hasAttribute('aria-disabled')).toBe(false);

    fireEvent.click(compactRow!);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(renameRow!);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(rename, 1, false);
  });

  it('يعكس تخطيط القائمة في RTL مع إبقاء أسماء الأوامر LTR', () => {
    render(
      <CommandMenu
        commands={[{ name: '/models', namespace: 'builtin', description: 'عرض النماذج' }]}
        isOpen
        dir="rtl"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('listbox').getAttribute('dir')).toBe('rtl');
    expect(screen.getByText('/models').getAttribute('dir')).toBe('ltr');
  });

  it('يعرض العنوان العربي وcanonical مرة واحدة ضمن bdi قابل للوصول', () => {
    const command = {
      name: '/compact',
      namespace: 'builtin',
      view: {
        canonicalName: '/compact',
        title: 'ضغط',
        description: 'اضغط سياق Codex الحالي.',
        aliases: ['/ضغط'],
        searchTerms: ['/compact', '/ضغط'],
      },
    };
    render(<CommandMenu commands={[command]} selectedIndex={0} isOpen dir="rtl" onClose={vi.fn()} />);

    const canonical = screen.getByText('/compact');
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('commandMenu.ariaLabel');
    expect(screen.getByRole('option').getAttribute('aria-selected')).toBe('true');
    expect(canonical.tagName).toBe('BDI');
    expect(canonical.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText((_, element) => element?.tagName === 'SPAN' && element.textContent === 'ضغط (/compact)')).toBeTruthy();
  });
});
