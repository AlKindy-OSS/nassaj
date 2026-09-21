import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'ar' },
  }),
}));

const useSessionParticipants = vi.fn();
vi.mock('./hooks', () => ({
  useSessionParticipants: (...args: unknown[]) => useSessionParticipants(...args),
  useProjectParticipants: () => ({ status: 'idle', users: [], agents: [], load: vi.fn() }),
}));

const useConversationCost = vi.fn();
vi.mock('../chat/hooks/useConversationCost', () => ({
  useConversationCost: (...args: unknown[]) => useConversationCost(...args),
}));

const authenticatedFetch = vi.fn();
vi.mock('../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

import SessionParticipantsBar from './SessionParticipantsBar';

const AGENT = { id: 'a1', name: 'claude', role: 'coordinator', model: 'claude-opus-5' };

const rosterOf = (agents: unknown[] = [AGENT], participants: unknown[] = []) => {
  useSessionParticipants.mockReturnValue({
    status: 'success',
    participants,
    agents,
    load: vi.fn(),
  });
};

const mountBar = (props: Record<string, unknown> = {}) =>
  render(<SessionParticipantsBar sessionId="sess-1" {...props} />);

beforeEach(() => {
  useSessionParticipants.mockReset();
  useConversationCost.mockReset();
  authenticatedFetch.mockReset();
  useConversationCost.mockReturnValue({ cost: null, status: 'loading', refresh: vi.fn() });
  authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
  rosterOf();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('inline header controls', () => {
  it('has no independent rail or hide/restore controls, including old collapsed preferences', () => {
    localStorage.setItem('showParticipantsBar', 'false');
    const { container } = mountBar();
    expect(container.querySelector('[data-app-header-surface]')).toBeNull();
    expect(screen.queryByRole('button', { name: /participants bar/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close conversation' })).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/\b(ml-|mr-|pl-|pr-|left-|right-)/);
    localStorage.removeItem('showParticipantsBar');
  });
});

describe('حضور الضوابط', () => {
  it('تظهر حتى بلا وكلاء ولا مشاركين — الشريط لم يعد يختفي', () => {
    rosterOf([], []);
    mountBar();

    expect(screen.getByRole('button', { name: 'Close conversation' })).toBeTruthy();
  });

  it('تظهر حتى حين يفشل طلب الطاقم', () => {
    useSessionParticipants.mockReturnValue({
      status: 'error',
      participants: [],
      agents: [],
      load: vi.fn(),
    });
    mountBar();

    expect(screen.getByRole('button', { name: 'Close conversation' })).toBeTruthy();
  });

  it('بلا محادثة مفتوحة لا شريط أصلاً', () => {
    const { container } = render(<SessionParticipantsBar sessionId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('حالة التحميل تبقى هيكلاً عظمياً كما كانت', () => {
    useSessionParticipants.mockReturnValue({
      status: 'loading',
      participants: [],
      agents: [],
      load: vi.fn(),
    });
    const { container } = mountBar();

    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading participants' })).toBeTruthy();
    expect(container.querySelector('[data-app-header-surface]')).toBeNull();
  });
});

describe('معرّف الجلسة في الشريط العلوي', () => {
  it('يعرض فقط المقطع الأول داخل bdi LTR وينسخ القيمة الكاملة', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const sessionId = '11111111-2222-4333-8444-555555555555';
    render(<SessionParticipantsBar sessionId={sessionId} />);

    const copyButton = screen.getByRole('button', { name: 'Copy session ID 11111111' });
    expect(copyButton.textContent).toContain('11111111');
    expect(copyButton.textContent).not.toContain('2222');
    expect(copyButton.querySelector('bdi')?.getAttribute('dir')).toBe('ltr');
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(sessionId));
    expect(within(copyButton.parentElement!).getByRole('status').textContent).toContain('Session ID copied');
    vi.unstubAllGlobals();
  });

  it('يعرض المعرّف الكامل القابل للتحديد عند فشل النسخ', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    const sessionId = '11111111-2222-4333-8444-555555555555';
    render(<SessionParticipantsBar sessionId={sessionId} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy session ID 11111111' }));
    const fullId = await screen.findByText(sessionId);
    expect(fullId.getAttribute('dir')).toBe('ltr');
    expect(fullId.className).toContain('select-text');
    vi.unstubAllGlobals();
  });

  it('يعرض كامل المعرّف حين لا يحتوي على شرطة', () => {
    render(<SessionParticipantsBar sessionId="session" />);

    expect(screen.getByRole('button', { name: 'Copy session ID session' }).textContent).toContain('session');
  });

  it('لا يعرض أسماء المشاركين بجوار صورهم', () => {
    rosterOf([], [{ userId: 'u-1', username: 'Nawras', role: 'owner', last_seen: '2026-09-10T12:00:00Z' }]);
    render(<SessionParticipantsBar sessionId="sess-1" />);
    expect(screen.queryByText('Nawras')).toBeNull();
  });
});

describe('زر الإغلاق', () => {
  it('محادثة مغلقة تحمل زرّاً يقول «إعادة فتح»', () => {
    mountBar({ closed: true });

    const button = screen.getByRole('button', { name: 'Reopen conversation' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('الإغلاق يظهر فوراً بالنقر (تفاؤل) ويُبلَّغ الأب', () => {
    // طلب لا يُحسم: نقيس اللحظة بين النقر وردّ الخادم.
    authenticatedFetch.mockReturnValue(new Promise(() => {}));
    const onClosedChange = vi.fn();

    mountBar({ onClosedChange });

    fireEvent.click(screen.getByRole('button', { name: 'Close conversation' }));

    expect(onClosedChange).toHaveBeenCalledWith(true);
  });
});
