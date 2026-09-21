import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import {
  __resetWorkflowStatusStore,
  setActiveWorkflows,
} from '../../../../stores/workflowStatusStore';
import { setSessionProcessState } from '../../../../stores/sessionProcessStateStore';
import {
  __resetConversationClosedOverrides,
} from '../../../chat/hooks/useConversationClosed';

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

vi.mock('../../../llm-logo-provider/SessionProviderLogo', () => ({
  default: () => <span aria-hidden="true" />,
}));

vi.mock('../../../../shared/view/GovernanceBadge', () => ({
  default: () => null,
}));

const MainContentTitle = (await import('./MainContentTitle')).default;

const project = {
  projectId: 'project-1',
  displayName: 'nassaj-dev',
  fullPath: '/workspace/nassaj-dev',
};

const session = {
  id: 'session-1',
  summary: 'محادثة تجريبية',
  __provider: 'claude',
} as const;

function renderTitle(closed = false) {
  return render(
    <MainContentTitle
      activeTab="chat"
      selectedProject={project}
      selectedSession={{ ...session, closed }}
    />,
  );
}

afterEach(() => {
  cleanup();
  setSessionProcessState('session-1', 'idle');
  __resetWorkflowStatusStore();
  __resetConversationClosedOverrides();
});

describe('MainContentTitle workflow indicator', () => {
  it('shows persisted closed state without a session title or ID', () => {
    renderTitle(true);

    const closed = screen.getByText('Closed');
    expect(screen.queryByText(session.summary)).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy session ID/ })).toBeNull();
    expect(closed.className).not.toMatch(/border|rounded|bg-/);
  });

  it('keeps live workflow and process indicators out of the header', () => {
    setSessionProcessState('session-1', 'running');
    setActiveWorkflows({
      workflows: [{
        sessionId: 'session-1', wfId: 'wf-demo', status: 'unknown', agentsDone: 0, agentsTotal: 0,
        updatedAt: null, agents: [], agentsTruncated: false, dormant: false,
      }],
      eligible: 2, scanned: 1, capped: true, dormant: 0,
    });

    renderTitle();
    expect(screen.queryByText('sessionProcessState.running')).toBeNull();
    expect(screen.queryByText('workflowStatus.unknown')).toBeNull();

    act(() => {
      setActiveWorkflows({
        workflows: [{
          sessionId: 'session-1', wfId: 'wf-demo', status: 'running', agentsDone: 1, agentsTotal: 2,
          updatedAt: null, agents: [], agentsTruncated: false, dormant: false,
        }],
        eligible: 1, scanned: 1, capped: false, dormant: 0,
      });
    });

    expect(screen.queryByText('workflowStatus.running')).toBeNull();
  });
  it('keeps shell header free of activity status, title, and ID', () => {
    setSessionProcessState('session-1', 'running');
    render(<MainContentTitle activeTab="shell" selectedProject={project} selectedSession={{ ...session, closed: true }} />);
    expect(screen.queryByText('sessionProcessState.running')).toBeNull();
    expect(screen.getByText('Closed')).toBeTruthy();
    expect(screen.queryByText(session.summary)).toBeNull();
    expect(screen.queryByText(session.id)).toBeNull();
  });

});
