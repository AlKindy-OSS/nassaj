/**
 * B-1076 — بطاقة صادرٍ تحت حجب صلاحية (`effect_scope_fenced`/`generation_blocked`).
 *
 * ما يحرسه هذا الملف:
 *  ١. الرمزان القاطعان يُطفئان «إعادة الإرسال»/«تحقّق» كلياً — لا يظهران إطلاقاً.
 *  ٢. «الاستمرار في محادثة جديدة» يظهر فقط حين `fence.scopeKind === 'session'`،
 *     ولمن ليس مالكاً وللمالك معاً.
 *  ٣. «مراجعة ورفع الحجب» للمالك وحده، ولأي نطاقٍ من الرمزين القاطعين.
 *  ٤. عضوٌ بلا فعلٍ متاح (نطاق مزوّد/الخادم) يرى نصّاً يوجّهه للمالك.
 *  ٥. رمزٌ عادي (`run_failed`) لا يتأثر: تبقى «إعادة الإرسال» كما هي.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { OutboxEntry } from '../../utils/messageOutbox';

import OutboxCard from './OutboxCard';

let mockRole: string | null = 'member';
const openSettingsSpy = vi.fn();

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: mockRole ? { role: mockRole } : null }),
}));

vi.mock('../../../../contexts/PaletteOpsContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePaletteOps: () => ({ openFile: vi.fn(), openSettings: openSettingsSpy, refreshProjects: vi.fn() }),
}));

vi.mock('../../utils/messageOutbox', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readOutboxImages: async () => [],
}));

function baseEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    id: 'm1',
    projectId: 'proj-1',
    sessionId: 'sess-1',
    text: 'hello',
    createdAt: Date.now(),
    status: 'failed',
    reasonCode: 'run_failed',
    reasonDetail: null,
    imageNames: [],
    intent: {},
    ...overrides,
  };
}

const noop = vi.fn();

afterEach(() => {
  cleanup();
  mockRole = 'member';
  openSettingsSpy.mockClear();
});

describe('رمزٌ عادي لا يتأثر', () => {
  it('يبقي زرّ إعادة الإرسال ظاهراً لـrun_failed', () => {
    render(<OutboxCard entry={baseEntry()} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    expect(screen.getByText('outbox.tryAgain')).toBeTruthy();
    expect(screen.queryByText('outbox.startNewConversation')).toBeNull();
    expect(screen.queryByText('outbox.reviewAndUnlock')).toBeNull();
  });
});

describe('effect_scope_fenced بنطاق session', () => {
  const entry = baseEntry({
    reasonCode: 'effect_scope_fenced',
    permanentlyBlocked: true,
    fence: { scopeKind: 'session', reasonCode: 'unknown_effect' },
  });

  it('يخفي إعادة الإرسال ويُظهر «الاستمرار في محادثة جديدة» لعضوٍ عادي', () => {
    mockRole = 'member';
    render(<OutboxCard entry={entry} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    expect(screen.queryByText('outbox.tryAgain')).toBeNull();
    expect(screen.queryByText('outbox.retry')).toBeNull();
    expect(screen.getByText('outbox.startNewConversation')).toBeTruthy();
    expect(screen.queryByText('outbox.reviewAndUnlock')).toBeNull();
  });

  it('«الاستمرار في محادثة جديدة» يستدعي onRetry بمعرّف الإدخال', () => {
    mockRole = 'member';
    const onRetry = vi.fn();
    render(<OutboxCard entry={entry} onRetry={onRetry} onEdit={noop} onDelete={noop} onVerify={noop} />);
    fireEvent.click(screen.getByText('outbox.startNewConversation'));
    expect(onRetry).toHaveBeenCalledWith('m1');
  });

  it('المالك يرى الفعلين معاً', () => {
    mockRole = 'owner';
    render(<OutboxCard entry={entry} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    expect(screen.getByText('outbox.startNewConversation')).toBeTruthy();
    expect(screen.getByText('outbox.reviewAndUnlock')).toBeTruthy();
  });

  it('«مراجعة ورفع الحجب» يفتح الإعدادات مفلترةً بجلسة هذا الإدخال', () => {
    mockRole = 'owner';
    render(<OutboxCard entry={entry} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    fireEvent.click(screen.getByText('outbox.reviewAndUnlock'));
    expect(openSettingsSpy).toHaveBeenCalledWith('system', { tab: 'system', fenceFilter: 'sess-1' });
  });
});

describe('effect_scope_fenced بنطاق مزوّد (لا محادثة جديدة لغير المالك)', () => {
  const entry = baseEntry({
    reasonCode: 'effect_scope_fenced',
    permanentlyBlocked: true,
    fence: { scopeKind: 'user_provider_purpose', reasonCode: 'unknown_effect' },
  });

  it('عضوٌ عادي لا يرى أي فعل، بل توجيهاً نحو المالك', () => {
    mockRole = 'member';
    render(<OutboxCard entry={entry} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    expect(screen.queryByText('outbox.startNewConversation')).toBeNull();
    expect(screen.queryByText('outbox.reviewAndUnlock')).toBeNull();
    expect(screen.getByText(/outbox\.reason\.fenceMemberHint|fenceMemberHint/u)).toBeTruthy();
  });

  it('المالك يرى «مراجعة ورفع الحجب» بلا فلترة جلسة (نطاق ليس session)', () => {
    mockRole = 'owner';
    render(<OutboxCard entry={entry} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    fireEvent.click(screen.getByText('outbox.reviewAndUnlock'));
    expect(openSettingsSpy).toHaveBeenCalledWith('system', { tab: 'system' });
  });
});

describe('generation_blocked — لا مخرج من طرف المستخدم', () => {
  const entry = baseEntry({ reasonCode: 'generation_blocked', permanentlyBlocked: true, fence: null });

  it('يخفي إعادة الإرسال/التحقّق كلياً بغضّ النظر عن الدور', () => {
    mockRole = 'member';
    render(<OutboxCard entry={entry} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    expect(screen.queryByText('outbox.retry')).toBeNull();
    expect(screen.queryByText('outbox.tryAgain')).toBeNull();
    expect(screen.queryByText('outbox.verify')).toBeNull();
  });

  it('يخفي «تعديل» (إرسالها من المؤلّف يعيد استهداف الجلسة المحجوبة) ويُبقي «حذف»', () => {
    render(<OutboxCard entry={entry} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    expect(screen.queryByText('outbox.edit')).toBeNull();
    expect(screen.getByText('outbox.delete')).toBeTruthy();
  });
});

describe('B-1076 «تعديل» يُخفى لكل رمزٍ قاطع، بغضّ النظر عن النطاق', () => {
  it.each([
    { scopeKind: 'session' as const },
    { scopeKind: 'user_provider_purpose' as const },
    undefined,
  ])('يخفي «تعديل» لـeffect_scope_fenced (fence: %j)', (fence) => {
    const entry = baseEntry({ reasonCode: 'effect_scope_fenced', permanentlyBlocked: true, fence: fence ?? null });
    render(<OutboxCard entry={entry} onRetry={noop} onEdit={noop} onDelete={noop} onVerify={noop} />);
    expect(screen.queryByText('outbox.edit')).toBeNull();
    expect(screen.getByText('outbox.delete')).toBeTruthy();
  });
});
