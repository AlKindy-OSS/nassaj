/**
 * B-379 — قائمة سياق واحدة على الشاشة، لا كومة قوائم.
 *
 * الحارس القديم كان يستمع لـ`mousedown` وحده. وعلى اللمس لا `mousedown` أصلاً:
 * الضغط المطوّل يولّد `pointerdown` ثم `contextmenu`. فكل صفّ يُلمس يفتح قائمته
 * وتبقى سابقتها مفتوحة — وهو ما ظهر على الجوال: ثلاث قوائم مكدّسة في الحيّز
 * نفسه، بنودها متداخلة ولا يُعرف أيّها يخصّ أي محادثة.
 *
 * يُثبَّت هنا المساران معاً: `pointerdown` خارج القائمة يغلقها (وهو ما يمرّ به
 * اللمس فعلاً)، وفتح قائمة أخرى يغلق ما قبلها حتى لو لم يمرّ pointerdown خارجها.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/components/sidebar/view/subcomponents/SidebarSessionItem.contextMenuSingle.test.tsx
 */
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { SessionWithProvider } from '../../types/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar' } }),
}));

const SidebarSessionItem = (await import('./SidebarSessionItem')).default;
const { announceContextMenuOpen } = await import('../../hooks/useDismissableContextMenu');

const t = ((key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key) as unknown as TFunction;

const project = { projectId: 'proj-1', displayName: 'nassaj-dev', fullPath: '/home/dev/nassaj' };

const makeSession = (id: string) =>
  ({
    id,
    summary: `محادثة ${id}`,
    createdAt: '2026-07-20T10:00:00.000Z',
    lastActivity: '2026-07-20T12:00:00.000Z',
    messageCount: 3,
    owner: null,
    __provider: 'claude',
  }) as never;

function renderRow(
  id: string,
  overrides: {
    isStarred?: boolean;
    isChatActive?: boolean;
    isSelected?: boolean;
    onSaveEditingSession?: () => void;
    onCancelEditingSession?: () => void;
    onToggleStar?: (session: SessionWithProvider, projectId: string) => void;
    onProjectSelect?: () => void;
    onSessionSelect?: () => void;
    editingSession?: string | null;
    onStartBulkSelectionWithId?: (kind: 'projects' | 'sessions', id: string) => void;
  } = {},
) {
  const {
    isStarred = false,
    onToggleStar = () => {},
    onProjectSelect = () => {},
    onSessionSelect = () => {},
    editingSession = null,
    onStartBulkSelectionWithId = () => {},
  } = overrides;
  return render(
    <SidebarSessionItem
      project={project}
      session={makeSession(id)}
      selectedSession={overrides.isSelected ? makeSession(id) : null}
      isChatActive={overrides.isChatActive}
      isStarred={isStarred}
      onToggleStar={onToggleStar}
      currentTime={new Date('2026-07-20T13:00:00.000Z')}
      editingSession={editingSession}
      editingSessionName=""
      onEditingSessionNameChange={() => {}}
      onStartEditingSession={() => {}}
      onCancelEditingSession={overrides.onCancelEditingSession ?? (() => {})}
      onSaveEditingSession={overrides.onSaveEditingSession ?? (() => {})}
      onProjectSelect={onProjectSelect}
      onSessionSelect={onSessionSelect}
      onDeleteSession={() => {}}
      onStartBulkSelectionWithId={onStartBulkSelectionWithId}
      t={t}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('B-379 — قائمة سياق واحدة لا كومة', () => {
  it('marks a retained conversation current only when chat is visible', () => {
    const inactive = renderRow('sess-1', { isSelected: true, isChatActive: false });
    expect(inactive.container.querySelector('[aria-current="page"]')).toBeNull();
    expect(inactive.container.querySelector('[data-session-selected]')).toBeNull();
    cleanup();
    const active = renderRow('sess-1', { isSelected: true, isChatActive: true });
    expect(active.container.querySelector('[aria-current="page"]')).not.toBeNull();
    expect(active.container.querySelector('[data-session-selected]')).not.toBeNull();
  });

  it('ينسخ معرف الجلسة الخام لا عنوانها أو رابطها ويغلق القائمة بعد النجاح', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { container } = renderRow('session-id:123/abc');
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-session-menu-trigger]')!);
    const items = screen.getAllByRole('menuitem');
    for (const item of items) {
      expect(item.classList.contains('min-h-7')).toBe(true);
      expect(item.classList.contains('[@media(pointer:coarse)]:min-h-8')).toBe(true);
      expect(item.classList.contains('py-1')).toBe(true);
    }
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy session ID' }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('session-id:123/abc');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it.each(['denied', 'unavailable'])('يبقي القائمة ويعرض خطأ عند تعذر الحافظة: %s', async (failure) => {
    vi.stubGlobal('navigator', failure === 'denied'
      ? { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } }
      : {});
    const { container } = renderRow('session-id-123');
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-session-menu-trigger]')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy session ID' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not copy the session ID');
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('يبدأ تحديد المحادثة نفسها من أول بند في القائمة ويغلقها', () => {
    const onStartBulkSelectionWithId = vi.fn();
    const { container } = renderRow('sess-1', { onStartBulkSelectionWithId });

    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-session-menu-trigger]')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Select conversation' }));

    expect(onStartBulkSelectionWithId).toHaveBeenCalledWith('sessions', 'sess-1');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('علامة التثبيت بجوار العنوان تبدّل الحالة من دون فتح الجلسة', () => {
    const onToggleStar = vi.fn();
    const onSessionSelect = vi.fn();
    renderRow('sess-1', { onToggleStar, onSessionSelect });

    // Pin has a single slot — it is never duplicated in the overlay
    const pin = screen.getByRole('button', { name: 'Pin: محادثة sess-1' });
    const icon = pin.querySelector('svg');
    expect(pin.classList.contains('h-7')).toBe(true);
    expect(pin.classList.contains('w-7')).toBe(true);
    expect(pin.closest('[data-session-pin-slot]')).not.toBeNull();
    expect(pin.classList.contains('text-muted-foreground/25')).toBe(true);
    expect(pin.classList.contains('hover:text-muted-foreground/60')).toBe(true);
    expect(pin.classList.contains('opacity-0')).toBe(false);
    expect(pin.classList.contains('pointer-events-auto')).toBe(true);
    expect([...pin.classList].some((name) => name.startsWith('[@media(hover:none)]:opacity-'))).toBe(false);
    expect(pin.classList.contains('transition-colors')).toBe(true);
    expect(pin.closest('a')).toBeNull();
    expect(pin.tabIndex).toBe(0);
    expect(icon?.classList.contains('h-3.5')).toBe(true);
    expect(icon?.classList.contains('w-3.5')).toBe(true);
    expect(icon?.classList.contains('fill-current')).toBe(true);
    expect(icon?.classList.contains('fill-none')).toBe(false);
    expect(icon?.getAttribute('stroke-width')).toBe('0');
    expect([...pin.classList].some((name) => name === 'border' || name.startsWith('border-'))).toBe(false);
    expect([...pin.classList].some((name) => name.startsWith('bg-'))).toBe(false);
    expect(document.querySelector('[data-session-pin-ghost]')).toBeNull();

    fireEvent.click(pin);

    expect(onToggleStar).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }), 'proj-1');
    expect(onSessionSelect).not.toHaveBeenCalled();
  });

  it('يحوّل رمز التثبيت فور إلغاء التثبيت إلى الرمادي الباهت', () => {
    const { rerender } = renderRow('sess-1', { isStarred: true });

    // Pin has a single slot — it is never duplicated in the overlay
    const pinned = screen.getByRole('button', { name: 'Unpin: محادثة sess-1' });
    expect(pinned.classList.contains('text-[color:var(--project-accent,hsl(var(--primary)))]')).toBe(true);
    expect([...pinned.classList].some((name) => name === 'border' || name.startsWith('border-'))).toBe(false);
    expect([...pinned.classList].some((name) => name.startsWith('bg-'))).toBe(false);
    expect(pinned.classList.contains('hover:text-[color:var(--project-accent,hsl(var(--primary)/0.8))]')).toBe(true);
    expect(pinned.classList.contains('opacity-0')).toBe(false);
    expect(document.querySelector('[data-session-pin-ghost]')).toBeNull();

    rerender(
      <SidebarSessionItem
        project={project}
        session={makeSession('sess-1')}
        selectedSession={null}
        isStarred={false}
        onToggleStar={() => {}}
        currentTime={new Date('2026-07-20T13:00:00.000Z')}
        editingSession={null}
        editingSessionName=""
        onEditingSessionNameChange={() => {}}
        onStartEditingSession={() => {}}
        onCancelEditingSession={() => {}}
        onSaveEditingSession={() => {}}
        onProjectSelect={() => {}}
        onSessionSelect={() => {}}
        onDeleteSession={() => {}}
        t={t}
      />,
    );

    const [pin] = screen.getAllByRole('button', { name: 'Pin: محادثة sess-1' });
    expect(pin.classList.contains('text-muted-foreground/25')).toBe(true);
    expect(pin.classList.contains('text-primary')).toBe(false);
    expect(pin.classList.contains('transition-colors')).toBe(true);
    expect([...pin.classList].some((name) => name.startsWith('[@media(hover:none)]:opacity-'))).toBe(false);
    expect(pin.classList.contains('opacity-0')).toBe(false);
    expect(document.querySelector('[data-session-pin-ghost]')).toBeNull();
  });

  it('يحافظ على الرمز الممتلئ في الحالتين ويطابق فعل قائمة السياق', () => {
    const { rerender, container } = renderRow('sess-1', { isStarred: true });

    const unpinIdleBtn = screen.getByRole('button', { name: 'Unpin: محادثة sess-1' });
    expect(unpinIdleBtn.querySelector('svg')?.classList.contains('fill-current')).toBe(true);

    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-session-menu-trigger]')!);
    const unpinItem = screen.getByRole('menuitem', { name: 'Unpin' });
    expect(unpinItem.querySelector('svg')?.classList.contains('lucide-bookmark')).toBe(true);
    expect(unpinItem.querySelector('svg')?.classList.contains('fill-current')).toBe(true);

    fireEvent.pointerDown(document.body);
    rerender(
      <SidebarSessionItem
        project={project}
        session={makeSession('sess-1')}
        selectedSession={null}
        isStarred={false}
        onToggleStar={() => {}}
        currentTime={new Date('2026-07-20T13:00:00.000Z')}
        editingSession={null}
        editingSessionName=""
        onEditingSessionNameChange={() => {}}
        onStartEditingSession={() => {}}
        onCancelEditingSession={() => {}}
        onSaveEditingSession={() => {}}
        onProjectSelect={() => {}}
        onSessionSelect={() => {}}
        onDeleteSession={() => {}}
        t={t}
      />,
    );

    const pinAfterUnpin = screen.getByRole('button', { name: 'Pin: محادثة sess-1' });
    expect(pinAfterUnpin.querySelector('svg')?.classList.contains('fill-current')).toBe(true);
    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-session-menu-trigger]')!);
    const pinItem = screen.getByRole('menuitem', { name: 'Pin' });
    expect(pinItem.querySelector('svg')?.classList.contains('lucide-bookmark')).toBe(true);
    expect(pinItem.querySelector('svg')?.classList.contains('fill-current')).toBe(false);
  });

  it('يبقي الرابط سطح SPA مستقلاً ويترك modified-click للمتصفح', () => {
    const onProjectSelect = vi.fn();
    const onSessionSelect = vi.fn();
    const { container } = renderRow('sess-1', { onProjectSelect, onSessionSelect });
    const link = container.querySelector('a')!;

    expect(link.getAttribute('href')).toContain('/session/sess-1');
    expect(link.querySelector('button,[role="button"]')).toBeNull();

    expect(fireEvent.click(link)).toBe(false);
    expect(onProjectSelect).toHaveBeenCalledTimes(1);
    expect(onSessionSelect).toHaveBeenCalledTimes(1);

    // امنع jsdom من محاولة التنقّل بعد أن يمرّ الحدث بمعالج React؛ المتصفح
    // الحقيقي يتولى modified-click، والمهم هنا أن مسار SPA لا يعترضه.
    document.addEventListener('click', (event) => event.preventDefault(), { once: true });
    fireEvent.click(link, { ctrlKey: true });
    expect(onProjectSelect).toHaveBeenCalledTimes(1);
    expect(onSessionSelect).toHaveBeenCalledTimes(1);
  });

  it('زر القائمة لا يفتح المحادثة ولا يعيش داخل الرابط', () => {
    const onSessionSelect = vi.fn();
    const { container } = renderRow('sess-1', { onSessionSelect });
    const menuTrigger = container.querySelector<HTMLButtonElement>('[data-session-menu-trigger]')!;

    expect(menuTrigger.closest('a')).toBeNull();
    fireEvent.click(menuTrigger);

    expect(onSessionSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('يبقي أفعال اللمس والفأرة والمحرر فوق طبقة محتوى البطاقة', () => {
    const { container } = renderRow('sess-1');
    const triggers = [...container.querySelectorAll<HTMLElement>('[data-session-menu-trigger]')];

    // الزرّ المستقلّ للّمس حُذف؛ المشغّل الوحيد الآن داخل الطبقة (z-20)
    expect(triggers).toHaveLength(1);
    for (const trigger of triggers) {
      expect(trigger.parentElement?.classList.contains('z-20')).toBe(true);
    }

    cleanup();
    const editing = renderRow('sess-1', { editingSession: 'sess-1' });
    const editor = editing.container.querySelector<HTMLInputElement>('input[dir="auto"]')?.parentElement;
    expect(editor?.classList.contains('z-20')).toBe(true);
  });

  it('pointerdown خارج القائمة يغلقها (مسار اللمس، بلا mousedown)', () => {
    const { container } = renderRow('sess-1');
    fireEvent.contextMenu(container.querySelector('a')!);
    expect(screen.getByRole('menu')).toBeTruthy();

    // الضغط المطوّل على الجوال لا يمرّ بـmousedown إطلاقاً.
    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('فتح قائمة أخرى يغلق المفتوحة قبلها', () => {
    const { container } = renderRow('sess-1');
    fireEvent.contextMenu(container.querySelector('a')!);
    expect(screen.getAllByRole('menu')).toHaveLength(1);

    // صفّ آخر يعلن فتح قائمته — بلا أي pointerdown خارج الأولى.
    // الإعلان حدث DOM خام خارج act، فيُلفّ ليُفرَّغ تحديث الحالة قبل الفحص.
    act(() => announceContextMenuOpen('session:sess-2'));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('mousedown القديم ما زال يغلق (الفأرة تولّد pointerdown قبله)', () => {
    const { container } = renderRow('sess-1');
    fireEvent.contextMenu(container.querySelector('a')!);

    fireEvent.pointerDown(document.body, { pointerType: 'mouse' });

    expect(screen.queryByRole('menu')).toBeNull();
  });
});

it('session rename replaces title controls and preserves IME/Enter/Escape without navigation', () => {
  const save = vi.fn(); const cancel = vi.fn(); const select = vi.fn();
  renderRow('s1', { editingSession: 's1', onSaveEditingSession: save, onCancelEditingSession: cancel, onSessionSelect: select });
  const input = screen.getByRole('textbox');
  expect(document.querySelector('[data-session-pin-slot]')).toBeNull();
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(save).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(select).not.toHaveBeenCalled();
});
