import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import SidebarCollapsed from './SidebarCollapsed';

vi.mock('../../../auth/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'owner' } }) }));
vi.mock('../../../../hooks/useRawExecConfig', () => ({ useRawExecQueue: () => ({ commands: [] }) }));
vi.mock('./SystemStats', () => ({ SystemStatsCollapsed: () => null }));
vi.mock('./ClaudeUsageCollapsed', () => ({ ClaudeUsageCollapsed: () => null }));
vi.mock('./PresenceCountCollapsed', () => ({ PresenceCountCollapsed: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('scheduled messages sidebar entry', () => {
  afterEach(cleanup);

  it('shows the global actionable count and invokes app-level navigation', () => {
    const open = vi.fn();
    render(<SidebarCollapsed
      onExpand={() => undefined}
      onShowSettings={() => undefined}
      onOpenTerminals={() => undefined}
      runningTerminalsCount={0}
      terminalsActive={false}
      updateAvailable={false}
      onShowVersionModal={() => undefined}
      scheduledMessagesCount={12}
      scheduledMessagesEnabled
      scheduledMessagesActive
      onOpenScheduledMessages={open}
      t={((key: string) => key) as unknown as TFunction}
    />);

    const button = screen.getByRole('button', { name: 'chat:scheduled.center.openWithCount' });
    const terminals = screen.getByRole('button', { name: 'title' });
    expect(button.textContent).toContain('12');
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(terminals.getAttribute('aria-current')).toBeNull();
    expect(terminals.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
