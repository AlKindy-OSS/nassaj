/**
 * usersAvatar.test.tsx — يثبت ظهور الـavatar (حرف أوّل أو صورة) في صفّ المستخدم
 * داخل تبويب «المستخدمون» (T-1685)، ويحرس أن التلميح:
 *
 * - يستخدم `users.roles.*` من مجال `settings` لا `participants.*`
 * - يعرض `users.lastLogin` حين last_login موجود — لا `participants.lastSeen`
 * - يعرض `users.neverLoggedIn` حين last_login فارغ
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.defaultValue as string) ?? key,
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../../auth', () => ({
  useAuth: () => ({
    user: { id: 1, role: 'owner' },
  }),
}));

// vi.mock يُرفع قبل تهيئة أي متغيّر؛ البيانات تُحدَّد داخل المصنع مباشرةً.
vi.mock('../../../hooks/useUsersAdmin', () => ({
  useUsersAdmin: () => ({
    users: [
      {
        id: 2,
        username: 'نورس',
        role: 'admin',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
        last_login: null,               // ← تغطّي حالة neverLoggedIn
        avatar_url: 'color:blue',
      },
      {
        id: 3,
        username: 'alice',
        role: 'user',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
        last_login: '2026-08-27T12:00:00Z', // ← تغطّي حالة lastLogin
        avatar_url: null,
      },
    ],
    invites: [],
    isLoading: false,
    loadError: null,
    updateRole: vi.fn(),
    updateStatus: vi.fn(),
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
    resetPassword: vi.fn(),
    deleteUser: vi.fn(),
  }),
}));

import UsersSettingsTab from './UsersSettingsTab';

afterEach(cleanup);

/** يُشغّل التلميح بـ focus على حاوية tabIndex من ParticipantAvatar ويُعيد innerHTML الكامل. */
function focusAvatarAndGetBody(avatarLabel: string): string {
  const avatarEl = screen.getAllByRole('img').find(
    (el) => el.getAttribute('aria-label')?.includes(avatarLabel),
  )!;
  // التلميح يلتصق بأقرب tabIndex=0 — وهو العنصر الحاضن الذي يُصيَّر من Tooltip
  const trigger = avatarEl.closest('[tabindex="0"]') as HTMLElement | null;
  if (trigger) fireEvent.focus(trigger);
  return document.body.innerHTML;
}

describe('avatar في صفوف قائمة المستخدمين (T-1685)', () => {
  it('يُصيَّر لكل مستخدم عنصر role="img" يحمل اسمه في aria-label', () => {
    render(<UsersSettingsTab />);

    const avatars = screen.getAllByRole('img');
    expect(avatars.length).toBeGreaterThanOrEqual(2);

    expect(avatars.find((el) => el.getAttribute('aria-label')?.includes('نورس'))).toBeTruthy();
    expect(avatars.find((el) => el.getAttribute('aria-label')?.includes('alice'))).toBeTruthy();
  });

  it('يُصيَّر الحرف الأوّل من اسم المستخدم حين لا يوجد مسار صورة', () => {
    render(<UsersSettingsTab />);

    const body = document.querySelector('body')!;
    // 'alice' بلا avatar_url → 'A'
    expect(body.textContent).toContain('A');
    // 'نورس' لها color:blue → 'ن'
    expect(body.textContent).toContain('ن');
  });

  it('aria-label يستخدم users.roles.* (settings namespace) لا participants.roles.*', () => {
    render(<UsersSettingsTab />);

    const avatars = screen.getAllByRole('img');

    const norseLabel = avatars.find((el) =>
      el.getAttribute('aria-label')?.includes('نورس'),
    )?.getAttribute('aria-label') ?? '';
    expect(norseLabel).toContain('users.roles.admin');
    expect(norseLabel).not.toContain('participants.roles');

    const aliceLabel = avatars.find((el) =>
      el.getAttribute('aria-label')?.includes('alice'),
    )?.getAttribute('aria-label') ?? '';
    expect(aliceLabel).toContain('users.roles.user');
    expect(aliceLabel).not.toContain('participants.roles');
  });

  it('التلميح يعرض users.lastLogin حين last_login موجود — لا participants.lastSeen', () => {
    render(<UsersSettingsTab />);

    // 'alice' لها last_login مضبوط
    const html = focusAvatarAndGetBody('alice');
    expect(html).toContain('users.lastLogin');
    expect(html).not.toContain('participants.lastSeen');
    expect(html).not.toContain('Last seen');
  });

  it('التلميح يعرض users.neverLoggedIn حين last_login فارغ', () => {
    render(<UsersSettingsTab />);

    // 'نورس' لها last_login: null
    const html = focusAvatarAndGetBody('نورس');
    expect(html).toContain('users.neverLoggedIn');
    expect(html).not.toContain('participants.lastSeen');
  });
});
