import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CoordinationLevelBadge from './CoordinationLevelBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => values?.name ? `${key}:${values.name}` : key,
  }),
}));

afterEach(cleanup);

describe('CoordinationLevelBadge', () => {
  it('يعرض المستوى المختوم على الرسالة نفسها', () => {
    render(<CoordinationLevelBadge level="delegate_review" />);
    const badge = screen.getByLabelText(
      'coordinationLevel.messageBadge:coordinationLevel.levels.delegate_review.short',
    );
    expect(badge.getAttribute('data-coordination-level')).toBe('delegate_review');
  });

  it('لا يخمّن مستوىً للرسائل القديمة التي بلا metadata', () => {
    const { container } = render(<CoordinationLevelBadge />);
    expect(container.innerHTML).toBe('');
  });
});
