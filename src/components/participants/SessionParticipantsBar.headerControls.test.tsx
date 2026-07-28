/**
 * SessionParticipantsBar.headerControls.test.tsx — هندسة الشيفرون ليست تفصيلاً
 * تجميلياً.
 *
 * ChatInterface يثبّت عمود أزراره العائم على `end-[14px] / sm:end-[18px]`
 * محسوبةً على شيفرون الطيّ وهو **آخر عنصر** في هذا الصفّ (انظر التعليق الطويل
 * قرب ChatInterface.tsx:756-772). أي ضابط يُضاف بعده يزيحه فينفصل الزرّ العائم
 * عن محوره بصمت — بلا خطأ نوعي ولا اختبار يسقط. لذا يُثبَّت هنا صراحةً:
 *   • الشيفرون آخر أبناء الصفّ،
 *   • و`ms-auto` انتقلت إلى مجموعة الضوابط لا إلى الشيفرون.
 *
 * ويُثبَّت معها أن الشريط لم يعد يختفي عند خلوّ الطاقم: ضوابط على مستوى
 * المحادثة (الكلفة والإغلاق) لا يجوز أن تصير غير قابلة للوصول لأن السجل لم
 * يُنتج وكيلاً بعد.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  render(<SessionParticipantsBar sessionId="sess-1" onHide={() => {}} {...props} />);

const row = () => screen.getByRole('group');
const chevron = () => screen.getByRole('button', { name: 'Hide participants bar' });

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

describe('هندسة الصفّ', () => {
  it('الشيفرون يبقى آخر أبناء الصفّ بعد إضافة الضوابط', () => {
    mountBar();
    expect(row().lastElementChild).toBe(chevron());
  });

  it('ms-auto انتقلت إلى مجموعة الضوابط ولم تبقَ على الشيفرون', () => {
    mountBar();

    expect(chevron().className).not.toContain('ms-auto');

    const controls = row().children[row().children.length - 2];
    expect(controls.className).toContain('ms-auto');
    // المجموعة هي التي تحمل الكلفة والإغلاق فعلاً.
    expect(controls.querySelectorAll('button').length).toBe(2);
  });

  it('لا إزاحات فيزيائية في المجموعة (RTL ينعكس كلياً)', () => {
    mountBar();
    const controls = row().children[row().children.length - 2] as HTMLElement;
    expect(controls.outerHTML).not.toMatch(/\b(ml-|mr-|pl-|pr-|left-|right-)/);
  });
});

describe('حضور الضوابط', () => {
  it('تظهر حتى بلا وكلاء ولا مشاركين — الشريط لم يعد يختفي', () => {
    rosterOf([], []);
    mountBar();

    expect(screen.getByRole('button', { name: 'Close conversation' })).toBeTruthy();
    expect(row()).toBeTruthy();
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
    const { container } = render(<SessionParticipantsBar sessionId={null} onHide={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('حالة التحميل تبقى هيكلاً عظمياً كما كانت', () => {
    useSessionParticipants.mockReturnValue({
      status: 'loading',
      participants: [],
      agents: [],
      load: vi.fn(),
    });
    mountBar();

    expect(screen.queryByRole('group')).toBeNull();
  });
});

describe('وسم الإغلاق', () => {
  it('محادثة مغلقة تحمل وسماً خفيفاً وزرّاً يقول «إعادة فتح»', () => {
    mountBar({ closed: true });

    expect(screen.getByText('Closed')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Reopen conversation' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('الإغلاق يظهر فوراً بالنقر (تفاؤل) ويُبلَّغ الأب', () => {
    // طلب لا يُحسم: نقيس اللحظة بين النقر وردّ الخادم.
    authenticatedFetch.mockReturnValue(new Promise(() => {}));
    const onClosedChange = vi.fn();

    mountBar({ onClosedChange });

    fireEvent.click(screen.getByRole('button', { name: 'Close conversation' }));

    expect(screen.getByText('Closed')).toBeTruthy();
    expect(onClosedChange).toHaveBeenCalledWith(true);
  });
});
