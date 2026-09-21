import type { TFunction } from 'i18next';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { SessionWithProvider } from '../../types/types';
import { applyOutcomeSnapshot } from '../../../../stores/sessionCompletionStore';
import {
  beginSessionProcessConnectionEpoch,
  invalidateSessionProcessAuthority,
  setSessionProcessState,
} from '../../../../stores/sessionProcessStateStore';
import {
  __resetWorkflowStatusStore,
  setActiveWorkflows,
} from '../../../../stores/workflowStatusStore';

const toggleClosed = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar' } }),
}));

vi.mock('../../../../contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ isMultiUser: true }),
}));

vi.mock('../../../chat/hooks/useConversationClosed', () => ({
  useConversationClosed: (_sessionId: string, { initialClosed = false }: { initialClosed?: boolean }) => ({
    closed: initialClosed,
    pending: false,
    failed: false,
    toggle: toggleClosed,
  }),
}));

const SidebarSessionItem = (await import('./SidebarSessionItem')).default;

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

const project = {
  projectId: 'proj-1',
  displayName: 'nassaj-dev',
  fullPath: '/workspace/sample-project',
};

const now = new Date('2026-08-17T12:00:00.000Z');

function renderRow(
  closed: boolean,
  overrides: Partial<SessionWithProvider> = {},
  bulkProps: Partial<Pick<ComponentProps<typeof SidebarSessionItem>, 'bulkSelectionKind' | 'isBulkSelected' | 'onToggleBulkSelectedId' | 'onToggleStar' | 'onStartBulkSelectionWithId'>> = {},
) {
  const session = {
    id: 'session-1',
    summary: 'محادثة تجريبية',
    createdAt: '2026-08-17T10:00:00.000Z',
    lastActivity: '2026-08-17T11:00:00.000Z',
    messageCount: 1,
    owner: null,
    __provider: 'claude',
    closed,
    ...overrides,
  } as SessionWithProvider;

  return render(
    <SidebarSessionItem
      project={project}
      session={session}
      selectedSession={null}
      isStarred={false}
      onToggleStar={() => {}}
      currentTime={now}
      editingSession={null}
      editingSessionName=""
      onEditingSessionNameChange={() => {}}
      onStartEditingSession={() => {}}
      onCancelEditingSession={() => {}}
      onSaveEditingSession={() => {}}
      onProjectSelect={() => {}}
      onSessionSelect={() => {}}
      onDeleteSession={() => {}}
      {...bulkProps}
      t={t}
    />,
  );
}

afterEach(() => {
  cleanup();
  toggleClosed.mockClear();
  setSessionProcessState('session-1', 'idle');
  applyOutcomeSnapshot([]);
  __resetWorkflowStatusStore();
});

describe('closed-session indicator', () => {
  it('uses the accessible close/reopen control as the only closed indicator', () => {
    const { container } = renderRow(true);

    const reopen = screen.getByRole('button', { name: 'Reopen' });
    expect(reopen.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTitle('This conversation is closed')).toBeNull();
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  });

  it('keeps a single close control for an open session and activates it', () => {
    const { container } = renderRow(false);

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.getAttribute('aria-pressed')).toBe('false');
    // idle-pin + overlay-close = 2 aria-pressed attributes in DOM (no pin in overlay)
    expect(container.querySelectorAll('[aria-pressed]')).toHaveLength(2);

    fireEvent.click(close);
    expect(toggleClosed).toHaveBeenCalledTimes(1);
  });
});

describe('bulk card selection', () => {
  it('does not start bulk selection when holding the pin on touch', () => {
    vi.useFakeTimers();
    try {
      const onStartBulkSelectionWithId = vi.fn();
      const onToggleStar = vi.fn();
      renderRow(false, {}, { onStartBulkSelectionWithId, onToggleStar });
      // Pin lives only in its own slot — no duplicate in the overlay
      const pin = screen.getByRole('button', { name: 'Pin: محادثة تجريبية' });
      const press = new Event('pointerdown', { bubbles: true });
      Object.defineProperty(press, 'pointerType', { value: 'touch' });
      fireEvent(pin.querySelector('svg')!, press);
      act(() => vi.advanceTimersByTime(600));
      expect(onStartBulkSelectionWithId).not.toHaveBeenCalled();
      fireEvent.pointerUp(pin);
      fireEvent.click(pin);
      expect(onToggleStar).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds a selection column only in bulk mode while preserving the other cells', () => {
    const normal = renderRow(false);
    const normalRow = normal.container.querySelector<HTMLElement>('[data-session-row-main]')!;
    const normalChildren = [...normalRow.children].map((child) => (child as HTMLElement).dataset.sessionSelectionRail !== undefined
      ? 'selection' : (child as HTMLElement).dataset.sessionProviderLogo !== undefined
        ? 'provider' : (child as HTMLElement).dataset.sessionPinSlot !== undefined
          ? 'pin' : (child as HTMLElement).dataset.sessionContent !== undefined
            ? 'content' : 'end');

    normal.unmount();
    const bulk = renderRow(false, {}, { bulkSelectionKind: 'sessions', onToggleBulkSelectedId: vi.fn() });
    const bulkRow = bulk.container.querySelector<HTMLElement>('[data-session-row-main]')!;

    expect(normalRow.querySelector('[data-session-selection-rail]')).toBeNull();
    expect(bulkRow.querySelector('input[type="checkbox"]')).toBeTruthy();
    expect(bulk.container.querySelector('[data-session-selection-rail]')).toBeTruthy();
    expect(bulk.container.querySelector('[data-session-pin-slot]')).toBeNull();
    expect([...bulkRow.children].slice(1).map((child) => (child as HTMLElement).dataset.sessionSelectionRail !== undefined
      ? 'selection' : (child as HTMLElement).dataset.sessionProviderLogo !== undefined
        ? 'provider' : (child as HTMLElement).dataset.sessionPinSlot !== undefined
          ? 'pin' : (child as HTMLElement).dataset.sessionContent !== undefined
            ? 'content' : 'end')).toEqual(normalChildren.filter((cell) => cell !== 'pin'));
    expect(bulk.container.querySelector('[data-session-end-rail]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('يبدّل اختيار المحادثة من البطاقة أو مربعها مرة واحدة', () => {
    const onToggleBulkSelectedId = vi.fn();
    const { container } = renderRow(false, {}, {
      bulkSelectionKind: 'sessions',
      onToggleBulkSelectedId,
    });

    fireEvent.click(container.querySelector('[data-session-card]')!);
    expect(onToggleBulkSelectedId).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggleBulkSelectedId).toHaveBeenCalledTimes(2);
  });

  it('يبقي النقر المعتاد خارج وضع التحديد ولا يبدّل الاختيار', () => {
    const onToggleBulkSelectedId = vi.fn();
    const { container } = renderRow(false, {}, { onToggleBulkSelectedId });

    fireEvent.click(container.querySelector('[data-session-card]')!);
    expect(onToggleBulkSelectedId).not.toHaveBeenCalled();
  });

  it('يعمل مربع اختيار المحادثة مع لوحة المفاتيح دون تمرير نقرة ثانية للبطاقة', () => {
    const onToggleBulkSelectedId = vi.fn();
    renderRow(false, {}, {
      bulkSelectionKind: 'sessions',
      onToggleBulkSelectedId,
    });

    const checkbox = screen.getByRole('checkbox');
    checkbox.focus();
    fireEvent.keyDown(checkbox, { key: ' ' });
    // JSDOM does not implement the browser's default Space→checkbox toggle;
    // detail=0 is the keyboard-generated click that follows it.
    fireEvent.click(checkbox, { detail: 0 });

    expect(onToggleBulkSelectedId).toHaveBeenCalledTimes(1);
  });
});

describe('sidebar workflow indicator', () => {
  it.each(['running', 'done'] as const)(
    'attaches the %s marker to the provider fallback when participants are absent',
    (state) => {
      if (state === 'running') {
        setSessionProcessState('session-1', 'running');
      } else {
        applyOutcomeSnapshot([{
          sessionId: 'session-1',
          outcome: 'done',
          outcomeAt: '2026-08-26T10:00:00.000Z',
        }]);
      }

      const { container } = renderRow(false);
      const row = container.querySelector('[data-session-row-main]');
      const providerLogo = container.querySelector('[data-session-provider-logo]');
      const pinSlot = container.querySelector('[data-session-pin-slot]');
      const content = container.querySelector('[data-session-content]');
      const indicator = container.querySelector(`[data-session-row-status="${state}"]`);

      expect(row).not.toBeNull();
      expect(providerLogo).not.toBeNull();
      expect(pinSlot).not.toBeNull();
      expect(container.querySelector('[data-session-status-slot]')).toBeNull();
      expect(content).not.toBeNull();
      expect(indicator).not.toBeNull();
      expect(indicator?.parentElement).toBe(providerLogo);
      expect(providerLogo?.parentElement).toBe(row);
      expect([...row!.children]).toEqual([
        providerLogo,
        content,
        container.querySelector('[data-session-end-rail]'),
      ]);
      expect(row?.classList.contains('gap-1')).toBe(true);
      expect(row?.classList.contains('gap-2')).toBe(false);
      expect(pinSlot?.classList.contains('h-7')).toBe(true);
      expect(pinSlot?.classList.contains('w-7')).toBe(true);
      expect(pinSlot?.classList.contains('flex-none')).toBe(true);
      expect(providerLogo?.classList.contains('relative')).toBe(true);
      expect(providerLogo?.classList.contains('overflow-visible')).toBe(true);
      expect(indicator?.classList.contains('h-3.5')).toBe(true);
      expect(indicator?.classList.contains('w-3.5')).toBe(true);
      expect(indicator?.classList.contains('flex-none')).toBe(true);
      expect(indicator?.classList.contains('absolute')).toBe(true);
      expect(indicator?.classList.contains('-end-1')).toBe(true);
      expect(indicator?.classList.contains('-bottom-1')).toBe(true);
    },
  );

  it('does not reserve a status slot while idle, then decorates the fallback logo', () => {
    const { container } = renderRow(false);
    const row = container.querySelector<HTMLElement>('[data-session-row-main]')!;
    const providerLogo = container.querySelector<HTMLElement>('[data-session-provider-logo]')!;

    expect(container.querySelector('[data-session-status-slot]')).toBeNull();
    expect(container.querySelector('[data-session-row-status]')).toBeNull();
    expect([...row.children]).toHaveLength(3);

    act(() => applyOutcomeSnapshot([{
      sessionId: 'session-1',
      outcome: 'done',
      outcomeAt: '2026-08-26T10:00:00.000Z',
    }]));

    expect(providerLogo.querySelector('[data-session-row-status="done"]')).not.toBeNull();
    expect([...row.children]).toHaveLength(3);
  });

  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [7, 4],
  ] as const)(
    'keeps avatar stacks in the desktop end rail for %i participants',
    (participantCount, renderedChildren) => {
      applyOutcomeSnapshot([{
        sessionId: 'session-1',
        outcome: 'done',
        outcomeAt: '2026-08-26T10:00:00.000Z',
      }]);

      const participants = Array.from({ length: participantCount }, (_, index) => ({
        userId: 101 + index,
        username: index === 1 ? 'Owner' : `Participant ${index}`,
        role: index === 1 ? 'owner' as const : 'participant' as const,
        avatarUrl: null,
        lastSeen: `2026-08-${String(26 - index).padStart(2, '0')}T12:00:00Z`,
      }));
      // The one-person case still needs an owner to assert owner-first binding.
      if (participantCount === 1) participants[0].role = 'owner';

      const { container } = renderRow(false, { participants });
      const ownerId = participantCount === 1 ? 101 : 102;
      const primary = container.querySelector<HTMLElement>(
        `[data-participant-primary-avatar="${ownerId}"]`,
      )!;
      const indicator = container.querySelector<HTMLElement>('[data-session-row-status="done"]')!;
      const providerLogo = container.querySelector<HTMLElement>('[data-session-provider-logo]')!;
      const stack = primary.parentElement!;
      const endRail = container.querySelector<HTMLElement>('[data-session-end-rail]')!;

      expect(primary).not.toBeNull();
      // B-824 — عكسُ ترتيبٍ سابق مقصود: كانت الحالة تُركَّب على الوجه الأول
      // (`cornerAdornment`)، وهذا الغلاف نفسه يحمل
      // `[@media(hover:hover)]:group-hover:opacity-0` — فكانت الحالة تختفي عند
      // التحويم على الصفّ، وعلى تثبيتٍ متعدّد المستخدمين هذا هو المسار العادي
      // لا حالةً طرفية. مكانها الآن صندوق الشعار دائماً، ولا شيء منها داخل
      // الرصّة الذائبة.
      expect(indicator.parentElement).toBe(providerLogo);
      expect(stack.contains(indicator)).toBe(false);
      expect(stack.querySelector('[data-session-row-status]')).toBeNull();
      // رصّة الصور داخل فتحة المشاركين ([data-session-avatar-slot]) التي هي بدورها
      // داخل سكة النهاية ([data-session-end-rail])
      expect(endRail.contains(stack)).toBe(true);
      // رصّة الصور مرئية على اللمس والفأرة بالتساوي (flex بلا قيد media)
      expect(stack.classList.contains('flex')).toBe(true);
      expect(stack.classList.contains('[@media(hover:hover)]:flex')).toBe(false);
      expect(stack.classList.contains('[@media(hover:hover)]:group-hover:hidden')).toBe(false);
      expect(stack.classList.contains('[@media(hover:hover)]:group-focus-within/session-actions:hidden')).toBe(false);
      // التحويم مُؤطَّر في فتحة المشاركين (group/avatar-slot) لا في الـrail كله
      const avatarSlot = container.querySelector<HTMLElement>('[data-session-avatar-slot]')!;
      expect(avatarSlot.classList.contains('group/avatar-slot')).toBe(true);
      const actionGroup = endRail.querySelector<HTMLElement>('.pointer-events-auto.z-20');
      expect(actionGroup?.classList.contains('[@media(hover:hover)]:group-hover/avatar-slot:flex')).toBe(true);
      expect(endRail.firstElementChild).toBe(container.querySelector('[data-session-pin-slot]'));
      expect([...stack.children]).toHaveLength(renderedChildren);
    },
  );

  it('keeps only the touch menu in the mobile end rail when participants are absent', () => {
    const { container } = renderRow(false);
    const endRail = container.querySelector<HTMLElement>('[data-session-end-rail]')!;
    const avatarSlot = container.querySelector<HTMLElement>('[data-session-avatar-slot]')!;

    // T-1: no fixed w-12 — avatar slot must not reserve space for absent images
    expect(avatarSlot.classList.contains('w-12')).toBe(false);
    // T-2: no-participant row collapses to w-0 so pin sits flush against the edge
    expect(avatarSlot.classList.contains('w-0')).toBe(true);

    expect(endRail.classList.contains('w-auto')).toBe(true);
    expect(container.querySelector('[role="group"]')).toBeNull();

    // item 5: hover zone = avatars only; empty slot must not carry group/avatar-slot
    expect(avatarSlot.classList.contains('group/avatar-slot')).toBe(false);
  });

  it('pin hover is isolated — pin-slot is not a descendant of avatar-slot (item 1)', () => {
    const { container } = renderRow(false);
    const pinSlot = container.querySelector('[data-session-pin-slot]')!;
    const avatarSlot = container.querySelector('[data-session-avatar-slot]')!;
    const endRail = container.querySelector('[data-session-end-rail]')!;

    // pin-slot is a sibling of avatar-slot, not inside it — pin hover cannot trigger group/avatar-slot
    expect(avatarSlot.contains(pinSlot)).toBe(false);
    expect(pinSlot.contains(avatarSlot)).toBe(false);
    // end-rail carries no CSS group that would make pin hover affect the overlay
    expect(endRail.classList.contains('group/session-actions')).toBe(false);
  });

  it('avatar slot uses flex layout without absolute inset-0 wrapper, overlay uses justify-start — no gap (item 4)', () => {
    const participants = [
      { userId: 101, username: 'Owner', role: 'owner' as const, avatarUrl: null, lastSeen: '2026-09-01T10:00:00Z' },
    ];
    const { container } = renderRow(false, { participants });
    const avatarSlot = container.querySelector('[data-session-avatar-slot]')!;

    // T-1: no fixed w-12 on participant rows either — slot uses w-auto min-w-6
    expect(avatarSlot.classList.contains('w-12')).toBe(false);
    // T-3: slot is a flex container so avatars are in natural flow, no absolute inset-0 wrapper
    expect(avatarSlot.classList.contains('flex')).toBe(true);
    expect(avatarSlot.classList.contains('items-center')).toBe(true);
    // No absolute inset-0 wrapper between slot and avatar stack
    expect(avatarSlot.querySelector('.absolute.inset-0.flex.items-center')).toBeNull();

    // The overlay uses justify-start so close button aligns over pin slot
    const overlay = avatarSlot.querySelector('[data-session-actions-overlay]')!;
    expect(overlay.classList.contains('justify-start')).toBe(true);
    expect(overlay.classList.contains('justify-end')).toBe(false);
  });

  it('keeps the pin visible and independent of selection outside bulk mode', () => {
    const onToggleStar = vi.fn();
    const onToggleBulkSelectedId = vi.fn();
    const { container } = renderRow(false, {}, { bulkSelectionKind: null, onToggleStar, onToggleBulkSelectedId });
    // Pin has a single slot — it is never duplicated in the overlay
    const pin = screen.getByRole('button', { name: 'Pin: محادثة تجريبية' });
    expect(pin.parentElement).toBe(container.querySelector('[data-session-pin-slot]'));
    expect(pin.classList.contains('absolute')).toBe(false);
    expect(pin.classList.contains('opacity-0')).toBe(false);
    expect(pin.classList.contains('pointer-events-auto')).toBe(true);
    fireEvent.click(pin);
    expect(onToggleStar).toHaveBeenCalledTimes(1);
    expect(onToggleBulkSelectedId).not.toHaveBeenCalled();
  });

  it('shows the session process state and only live workflow details', () => {
    setSessionProcessState('session-1', 'running');
    setActiveWorkflows({
      workflows: [{
        sessionId: 'session-1',
        wfId: 'wf_10000000-demo',
        status: 'unknown',
        agentsDone: 0,
        agentsTotal: 0,
        updatedAt: null,
        agents: [],
        agentsTruncated: false,
        dormant: false,
      }],
      eligible: 1,
      scanned: 1,
      capped: false,
      dormant: 0,
    });

    renderRow(false);
    expect(screen.getByLabelText('sessionProcessState.runningHint')).toBeTruthy();
    expect(document.querySelector('[data-session-row-status="running"]')).toBeTruthy();

    act(() => setSessionProcessState('session-1', 'frozen'));
    expect(screen.getByLabelText('sessionProcessState.frozenHint')).toBeTruthy();
    expect(screen.queryByLabelText('sessionProcessState.runningHint')).toBeNull();

    act(() => setSessionProcessState('session-1', 'running'));

    act(() => {
      setActiveWorkflows({
        workflows: [{
          sessionId: 'session-1',
          wfId: 'wf_10000000-demo',
          status: 'running',
          agentsDone: 1,
          agentsTotal: 2,
          updatedAt: null,
          agents: [],
          agentsTruncated: false,
          dormant: false,
        }],
        eligible: 1,
        scanned: 1,
        capped: false,
        dormant: 0,
      });
    });

    expect(screen.getByLabelText('sessionProcessState.runningHint')).toBeTruthy();

    act(() => setSessionProcessState('session-1', 'idle'));
    expect(screen.getByLabelText('sessionProcessState.runningHint')).toBeTruthy();

    act(() => applyOutcomeSnapshot([{
      sessionId: 'session-1',
      outcome: 'question',
      outcomeAt: '2026-08-19T00:00:00.000Z',
    }]));
    expect(screen.getByLabelText('sessionProcessState.questionHint')).toBeTruthy();
    expect(screen.queryByLabelText('sessionProcessState.runningHint')).toBeNull();

    act(() => applyOutcomeSnapshot([{
      sessionId: 'session-1',
      outcome: 'done',
      outcomeAt: '2026-08-19T00:01:00.000Z',
    }]));
    expect(screen.getByLabelText('sessionProcessState.doneHint')).toBeTruthy();
    expect(screen.queryByLabelText('sessionProcessState.runningHint')).toBeNull();

    act(() => setActiveWorkflows({
      workflows: [], eligible: 0, scanned: 0, capped: false, dormant: 0,
    }));
    expect(screen.getByLabelText('sessionProcessState.doneHint')).toBeTruthy();

    act(() => applyOutcomeSnapshot([{
      sessionId: 'session-1',
      outcome: 'error',
      outcomeAt: '2026-08-19T00:02:00.000Z',
    }]));
    expect(screen.getByLabelText('sessionProcessState.errorHint')).toBeTruthy();
  });

  it('drops a stale running claim after socket authority is lost', () => {
    const epoch = beginSessionProcessConnectionEpoch();
    setSessionProcessState('session-1', 'running', { epoch, authoritative: true });
    renderRow(false);

    expect(screen.getByLabelText('sessionProcessState.runningHint')).toBeTruthy();
    act(() => invalidateSessionProcessAuthority(epoch));

    expect(screen.queryByLabelText('sessionProcessState.runningHint')).toBeNull();
    expect(document.querySelector('[data-session-row-status="running"]')).toBeNull();
  });

  it.each([[0, 2], [1, 2], [2, 2]])(
    'reflects an orphan workflow in the row (%i/%i agents done)',
    (agentsDone, agentsTotal) => {
      setActiveWorkflows({
        workflows: [{
          sessionId: 'session-1',
          wfId: `wf_orphan_${agentsDone}`,
          status: 'orphan',
          agentsDone,
          agentsTotal,
          updatedAt: null,
          agents: [],
          agentsTruncated: false,
          dormant: false,
        }],
        eligible: 1,
        scanned: 1,
        capped: false,
        dormant: 0,
      });

      renderRow(false);
      expect(screen.getByLabelText('sessionProcessState.orphanHint')).toBeTruthy();
      expect(document.querySelector('[data-session-row-status="orphan"]')).toBeTruthy();
    },
  );
});

describe('actions overlay — avatar slot reveals close and actions', () => {
  it('overlay lives inside the avatar slot and contains exactly two buttons', () => {
    const { container } = renderRow(false);
    const overlay = container.querySelector('[data-session-actions-overlay]');
    expect(overlay).not.toBeNull();

    // close: one aria-pressed attribute in overlay (no pin in overlay)
    const pressedButtons = overlay!.querySelectorAll('[aria-pressed]');
    expect(pressedButtons).toHaveLength(1);

    // Context-menu trigger is present
    expect(overlay!.querySelector('[data-session-menu-trigger]')).not.toBeNull();

    // Total: exactly two buttons (close + menu)
    expect(overlay!.querySelectorAll('button')).toHaveLength(2);

    // Overlay sits inside the avatar slot (DOM containment), never a DOM child of pin slot.
    // Visual coverage of pin slot is via -start-7 (CSS), not DOM containment.
    const avatarSlot = container.querySelector('[data-session-avatar-slot]')!;
    expect(avatarSlot.contains(overlay)).toBe(true);
    expect(container.querySelector('[data-session-pin-slot]')?.contains(overlay)).toBeFalsy();
  });

  it('close button fills pin-slot width (w-7) and overlay extends to pin slot via -start-7 (items 2 & 3)', () => {
    const participants = [
      { userId: 101, username: 'Owner', role: 'owner' as const, avatarUrl: null, lastSeen: '2026-09-01T10:00:00Z' },
    ];
    const { container } = renderRow(false, { participants });
    const overlay = container.querySelector('[data-session-actions-overlay]')!;
    const buttons = overlay.querySelectorAll<HTMLButtonElement>('button');
    const closeBtn = buttons[0];

    // -start-7 = inset-inline-start: -1.75rem extends overlay 28px into pin slot area
    expect(overlay.classList.contains('-start-7')).toBe(true);
    // Overlay uses inset-y-0 end-0 instead of inset-0 (no cascade conflict with -start-7)
    expect(overlay.classList.contains('inset-0')).toBe(false);
    expect(overlay.classList.contains('inset-y-0')).toBe(true);

    // Close button: w-7 (28px = pin slot width) so it centres over the pin slot
    expect(closeBtn.classList.contains('w-7')).toBe(true);
    expect(closeBtn.classList.contains('h-7')).toBe(true);
    expect(closeBtn.classList.contains('flex-none')).toBe(true);

    // Both buttons are at inline-start (justify-start), close first = over pin
    expect(overlay.classList.contains('justify-start')).toBe(true);

    // Overlay is a DOM child of avatar-slot, never of pin-slot
    const avatarSlot = container.querySelector('[data-session-avatar-slot]')!;
    const pinSlot = container.querySelector('[data-session-pin-slot]')!;
    expect(avatarSlot.contains(overlay)).toBe(true);
    expect(pinSlot.contains(overlay)).toBe(false);
  });

  it('hovering on pin slot alone cannot trigger overlay (item 3)', () => {
    const { container } = renderRow(false);
    const pinSlot = container.querySelector('[data-session-pin-slot]')!;
    const avatarSlot = container.querySelector('[data-session-avatar-slot]')!;
    const endRail = container.querySelector('[data-session-end-rail]')!;

    // pin-slot is sibling of avatar-slot — pin hover cannot trigger group/avatar-slot
    expect(avatarSlot.contains(pinSlot)).toBe(false);
    expect(pinSlot.contains(avatarSlot)).toBe(false);
    // end-rail carries no CSS group that bridges pin and avatar for hover
    expect(endRail.classList.contains('group/session-actions')).toBe(false);
    expect(endRail.classList.contains('group/avatar-slot')).toBe(false);
  });

  it('the pin slot is NOT inside the overlay and has no duplicate in the overlay', () => {
    const { container } = renderRow(false);
    const overlay = container.querySelector('[data-session-actions-overlay]')!;
    // No pin (Bookmark) button inside the overlay
    const pinInOverlay = overlay.querySelector('[aria-label*="Pin"]') ??
      overlay.querySelector('[aria-label*="Unpin"]');
    expect(pinInOverlay).toBeNull();
  });

  it('first tap on avatar slot reveals overlay without calling toggleStar or close', () => {
    const onToggleStar = vi.fn();
    const { container } = renderRow(false, {}, { onToggleStar });

    const avatarSlot = container.querySelector('[data-session-avatar-slot]') as HTMLElement;
    expect(avatarSlot).not.toBeNull();

    // First tap: touchstart on avatar slot reveals the overlay
    act(() => { fireEvent.touchStart(avatarSlot); });

    // The synthesised click from the same tap is swallowed by onClickCapture
    fireEvent.click(avatarSlot);
    expect(onToggleStar).not.toHaveBeenCalled();
    // Close toggle not fired either (toggleClosed is the mock)
    expect(toggleClosed).not.toHaveBeenCalled();

    // Overlay must be visible now (touchActionsVisible=true)
    const overlay = container.querySelector('[data-session-actions-overlay]')!;
    expect(overlay).not.toBeNull();

    // Overlay has exactly 2 buttons
    expect(overlay.querySelectorAll('button')).toHaveLength(2);

    // Second tap on close in overlay runs the action
    const [closeBtn] = Array.from(overlay.querySelectorAll<HTMLButtonElement>('[aria-pressed]'));
    fireEvent.click(closeBtn);
    expect(toggleClosed).toHaveBeenCalledTimes(1);

    // toggleStar was never called throughout
    expect(onToggleStar).not.toHaveBeenCalled();
  });
});
