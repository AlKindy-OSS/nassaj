import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import MainContentStateView from './MainContentStateView';

afterEach(() => cleanup());

describe('MainContentStateView deep-link feedback', () => {
  it('shows a distinct not-found empty state without a retry action', () => {
    render(
      <MainContentStateView
        mode="deep-link"
        isMobile={false}
        onMenuClick={vi.fn()}
        deepLinkResolution={{ status: 'not_found', sessionId: 'missing-session' }}
      />,
    );

    expect(screen.getByText('mainContent.sessionDeepLink.not_found.title')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a retry action for a transient failure', () => {
    const retry = vi.fn();
    render(
      <MainContentStateView
        mode="deep-link"
        isMobile={false}
        onMenuClick={vi.fn()}
        deepLinkResolution={{ status: 'error', sessionId: 'failed-session', retryable: true }}
        onRetryDeepLink={retry}
      />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'mainContent.sessionDeepLink.retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
