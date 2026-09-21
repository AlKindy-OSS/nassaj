import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import MessageComponent from './MessageComponent';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; defaultValue?: string }) => (
      key === 'images.omitted' ? `omitted:${options?.count}` : options?.defaultValue || key
    ),
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../../hooks/useServerActionCatalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useServerActionCatalog: () => ({
    catalog: [],
    runAction: async () => ({ status: 'error', code: 'not_initialized' }),
    liveStatusOf: () => null,
  }),
}));

type Props = ComponentProps<typeof MessageComponent>;

afterEach(cleanup);

const renderUserMessage = (imagesOmitted?: number, content = 'صف الصور', originKind?: 'coordinator') => render(
  <MessageComponent
    {...({
      prevMessage: null,
      createDiff: () => [],
      provider: 'codex',
      message: {
        id: 'm1',
        type: 'user',
        content,
        timestamp: '2026-08-17T10:03:18.025Z',
        imagesOmitted,
        originKind,
      },
    } as unknown as Props)}
  />,
);

describe('MessageComponent — الصور المستبعدة من التاريخ', () => {
  it('يربط فقاعة المستخدم وتفاصيلها برموز الثيم بدل درجات زرقاء ثابتة', () => {
    const { container } = renderUserMessage(3);
    const content = screen.getByText('صف الصور');
    const bubble = content.parentElement;
    const omitted = screen.getByRole('status');

    expect(bubble).not.toBeNull();
    expect(bubble?.className).toContain('--user-bubble-background,hsl(var(--primary))');
    expect(bubble?.className).toContain('--user-bubble-foreground,var(--primary-foreground)');
    expect(omitted.className).toContain('border-[hsl(var(--user-bubble-foreground,var(--primary-foreground))/0.25)]');
    expect(omitted.className).toContain('bg-[hsl(var(--user-bubble-foreground,var(--primary-foreground))/0.1)]');
    expect(omitted.className).toContain('--user-bubble-foreground,var(--primary-foreground)');
    expect(container.innerHTML).not.toMatch(/(?:bg|border|text)-blue-/);
    expect(container.innerHTML).not.toContain('text-primary-foreground/80');
  });

  it.each([undefined, 'coordinator'] as const)('يحصر لون النسخ الجديد في الفقاعة البشرية (origin=%s)', (originKind) => {
    const { container } = renderUserMessage(undefined, 'محتوى قابل للنسخ', originKind);
    const copy = screen.getByRole('button', { name: 'Copy as text' });
    expect(copy.className.includes('--user-bubble-muted-foreground')).toBe(originKind !== 'coordinator');
    expect(container.querySelector('[data-user-message-bubble]') !== null).toBe(originKind !== 'coordinator');
  });

  it('يعرض عدداً واضحاً داخل فقاعة المستخدم بدلاً من الاختفاء الصامت', () => {
    renderUserMessage(3, '');
    expect(screen.getByRole('status').textContent).toContain('omitted:3');
  });

  it('لا يعرض placeholder عندما لا توجد صور مستبعدة', () => {
    renderUserMessage();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
