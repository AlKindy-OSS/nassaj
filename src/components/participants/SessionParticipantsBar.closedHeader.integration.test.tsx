/**
 * The close control and main header do not share a React parent below the app
 * state owner. This regression deliberately leaves out that callback: the
 * title must receive the shared optimistic close signal before the request
 * settles or a projects refresh arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const authenticatedFetch = vi.fn();
const useSessionParticipants = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

vi.mock('./hooks', () => ({
  useSessionParticipants: (...args: unknown[]) => useSessionParticipants(...args),
}));

vi.mock('../chat/hooks/useConversationCost', () => ({
  useConversationCost: () => ({ cost: null, status: 'loading', refresh: vi.fn() }),
}));

vi.mock('../chat/hooks/useSessionResources', () => ({
  useSessionResources: () => ({ resources: null, status: 'loading', refresh: vi.fn() }),
}));

vi.mock('../llm-logo-provider/SessionProviderLogo', () => ({ default: () => null }));
vi.mock('../../shared/view/GovernanceBadge', () => ({ default: () => null }));

import MainContentTitle from '../main-content/view/subcomponents/MainContentTitle';
import { __resetConversationClosedOverrides } from '../chat/hooks/useConversationClosed';

import SessionParticipantsBar from './SessionParticipantsBar';

const project = {
  projectId: 'project-1', displayName: 'nassaj-dev', fullPath: '/workspace/nassaj-dev',
};

function CloseHeaderTree() {
  const selectedSession = {
    id: 'session-1', summary: 'A session', __provider: 'claude' as const, closed: false,
  };

  return (
    <>
      <MainContentTitle activeTab="chat" selectedProject={project} selectedSession={selectedSession} />
      <SessionParticipantsBar
        sessionId={selectedSession.id}
        closed={selectedSession.closed}
      />
    </>
  );
}

beforeEach(() => {
  __resetConversationClosedOverrides();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockReturnValue(new Promise(() => {}));
  useSessionParticipants.mockReturnValue({
    status: 'success', participants: [], agents: [], harness: null, load: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('close state from the actual header control', () => {
  it('shows Closed immediately after clicking Close, without refresh or a visible session ID', () => {
    render(<CloseHeaderTree />);

    expect(screen.queryByText('Closed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close conversation' }));

    const closed = screen.getByText('Closed');
    expect(closed).toBeTruthy();
    expect(screen.queryByText('session-1')).toBeNull();
  });
});
