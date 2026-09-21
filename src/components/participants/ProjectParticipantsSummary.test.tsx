import type { TFunction } from 'i18next';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const useProjectParticipants = vi.fn();
vi.mock('./hooks', () => ({
  useProjectParticipants: (...args: unknown[]) => useProjectParticipants(...args),
}));

import ProjectParticipantsSummary from './ProjectParticipantsSummary';

const t = ((key: string, options?: Record<string, unknown>) => {
  if (key === 'participants.loadedSessionUsers') return `Participants in loaded conversations: ${options?.count}`;
  if (key === 'participants.usersAria') return `${options?.count} participants`;
  if (key === 'participants.projectSummary') return `${options?.users} users · ${options?.agents} agents`;
  return options?.defaultValue as string ?? key;
}) as unknown as TFunction;

const user = {
  userId: 'u1',
  username: 'Owner',
  role: 'owner' as const,
  first_seen: '',
  last_seen: '',
  message_count: 1,
  avatarUrl: null,
};

afterEach(() => {
  cleanup();
  useProjectParticipants.mockReset();
});

describe('ProjectParticipantsSummary cached agents', () => {
  it('uses deduplicated loaded-session humans and never requests the aggregate endpoint', () => {
    const load = vi.fn();
    useProjectParticipants.mockReturnValue({ status: 'idle', users: [], agents: [], agentsSource: null, load });
    const { container } = render(<ProjectParticipantsSummary projectId="p1" locale="en" t={t} active loadedSessions={[
      { id: 's1', participants: [{ userId: 1, username: 'Owner', role: 'owner' }] },
      { id: 's2', owner: { userId: 1, username: 'Owner' } },
      { id: 's3', owner: { userId: 2, username: 'Guest' } },
    ]} showAvatars={false} />);
    expect(useProjectParticipants).toHaveBeenCalledWith(null);
    expect(load).not.toHaveBeenCalled();
    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(container.textContent).toBe('Participants in loaded conversations: 2');
    expect(container.querySelector('[data-project-participants-source="loaded-sessions"]')).toBeTruthy();
  });

  it('does not claim that an empty loaded subset means an empty project', () => {
    const load = vi.fn();
    useProjectParticipants.mockReturnValue({ status: 'idle', users: [], agents: [], agentsSource: null, load });
    const { container } = render(<ProjectParticipantsSummary projectId="p1" locale="en" t={t} active loadedSessions={[]} />);
    expect(load).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('shows only the human count when the agent list is cache-sourced', () => {
    useProjectParticipants.mockReturnValue({
      status: 'success', users: [user], agents: [{ id: 'agent-1' }], agentsSource: 'cache', load: vi.fn(),
    });

    render(<ProjectParticipantsSummary projectId="p1" locale="en" t={t} active={false} showAvatars={false} />);

    expect(screen.getByText('1 participants')).toBeTruthy();
    expect(screen.queryByText('1 users · 1 agents')).toBeNull();
  });

  it('does not invent a zero-agent summary when cached data contains no humans', () => {
    useProjectParticipants.mockReturnValue({
      status: 'success', users: [], agents: [{ id: 'agent-1' }], agentsSource: 'cache', load: vi.fn(),
    });

    const { container } = render(
      <ProjectParticipantsSummary projectId="p1" locale="en" t={t} active={false} showAvatars={false} />,
    );

    expect(container.textContent).toBe('');
  });

  it('preserves the complete summary for servers that do not provide cache metadata', () => {
    useProjectParticipants.mockReturnValue({
      status: 'success', users: [user], agents: [{ id: 'agent-1' }], agentsSource: null, load: vi.fn(),
    });

    render(<ProjectParticipantsSummary projectId="p1" locale="en" t={t} active={false} showAvatars={false} />);

    expect(screen.getByText('1 users · 1 agents')).toBeTruthy();
  });
});
