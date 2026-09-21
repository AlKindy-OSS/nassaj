import type { TFunction } from 'i18next';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import ParticipantAvatarStack from './ParticipantAvatarStack';
import type { SessionParticipant } from './types';

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

const participant = (
  userId: string,
  role: SessionParticipant['role'],
  lastSeen: string,
): SessionParticipant => ({
  userId,
  username: userId,
  role,
  first_seen: '',
  last_seen: lastSeen,
  message_count: 0,
  avatarUrl: null,
});

afterEach(cleanup);

/**
 * ‏B-824 — كانت الرصّة تقبل `cornerAdornment` فتُركِّب حالةَ المحادثة على الوجه
 * الأول. أُزيلت البوابة كلّها: الرصّة تذوب إلى `opacity-0` عند التحويم، فكانت
 * تبتلع الحالةَ معها. هذه الاختبارات تحرس أن تبقى الرصّة وجوهاً فقط.
 */
describe('ParticipantAvatarStack', () => {
  it('renders nothing without participants', () => {
    const { container } = render(
      <ParticipantAvatarStack participants={[]} locale="ar" t={t} />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('marks the owner-first avatar, not the newest input row', () => {
    const { container } = render(
      <ParticipantAvatarStack
        participants={[
          participant('newest', 'participant', '2026-08-27T12:00:00Z'),
          participant('owner', 'owner', '2026-08-20T12:00:00Z'),
          participant('older', 'participant', '2026-08-19T12:00:00Z'),
        ]}
        max={3}
        locale="ar"
        t={t}
      />,
    );

    const owner = container.querySelector<HTMLElement>('[data-participant-primary-avatar="owner"]')!;

    expect(owner).not.toBeNull();
    expect(container.querySelectorAll('[data-participant-primary-avatar]')).toHaveLength(1);
    expect(container.querySelector('[data-participant-primary-avatar="newest"]')).toBeNull();
  });

  it('never hosts a session status indicator', () => {
    const { container } = render(
      <ParticipantAvatarStack
        participants={[participant('owner', 'owner', '2026-08-20T12:00:00Z')]}
        locale="ar"
        t={t}
      />,
    );

    expect(container.querySelector('[data-session-row-status]')).toBeNull();
    // كل الوجوه على مستوى واحد فيسري عليها `[&>*+*]:-ms-2` بلا استثناء.
    for (const face of container.querySelectorAll('[role="group"] > *')) {
      expect(face.classList.contains('inline-flex')).toBe(true);
      expect(face.classList.contains('relative')).toBe(false);
    }
  });
});
