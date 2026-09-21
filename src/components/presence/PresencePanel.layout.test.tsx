import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const presence = vi.hoisted(() => ({ users: [] as Array<{ userId: string; username: string; active: boolean; since: number }> }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('../auth/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('./usePresence', () => ({
  usePresence: () => ({ users: presence.users, activeConversations: null }),
}));

vi.mock('./ActiveConversationsMenu', () => ({ ActiveConversationsMenu: () => <button>Active conversations</button> }));

import PresencePanel from './PresencePanel';

describe('PresencePanel layout', () => {
  afterEach(() => { cleanup(); presence.users = []; });

  it('keeps active people first, summarizes overflow, and restores all five avatars', () => {
    presence.users = [
      { userId: 'idle', username: 'Idle', active: false, since: 1 },
      { userId: 'later', username: 'Later', active: true, since: 3 },
      { userId: 'first', username: 'First', active: true, since: 2 },
      { userId: 'fourth', username: 'Fourth', active: false, since: 4 },
      { userId: 'fifth', username: 'Fifth', active: false, since: 5 },
    ];
    const { rerender } = render(<PresencePanel compact />);
    const list = screen.getByRole('list', { name: 'Online (5)' });
    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(3);
    expect(entries[0].querySelector('[aria-label]')?.getAttribute('aria-label')).toMatch(/^First/);
    expect(entries[1].querySelector('[aria-label]')?.getAttribute('aria-label')).toMatch(/^Later/);
    expect(within(entries[2]).getByText('+3')).toBeTruthy();
    expect(screen.getByText('Online').className).toBe('sr-only');
    rerender(<PresencePanel />);
    const restored = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(restored).toHaveLength(5);
    expect(restored.map((entry) => entry.querySelector('[aria-label]')?.getAttribute('aria-label')?.split(' — ')[0])).toEqual(['First', 'Later', 'Idle', 'Fourth', 'Fifth']);
    expect(screen.queryByText('+3')).toBeNull();
    expect(screen.getByText('Online').className).not.toContain('sr-only');
  });

  it('reserves the activity counter space for bulk controls and restores it afterwards', () => {
    const trailing = <button>Exit selection</button>;
    const { rerender } = render(<PresencePanel compact trailing={trailing} />);
    expect(screen.queryByRole('button', { name: 'Active conversations' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Exit selection' })).toBeTruthy();
    rerender(<PresencePanel trailing={trailing} />);
    expect(screen.getByRole('button', { name: 'Active conversations' })).toBeTruthy();
  });

  it('keeps its 44px row with an inset separator that adds no height', () => {
    const { container } = render(
      <PresencePanel trailing={<button type="button">Archive</button>} />,
    );
    const panel = container.querySelector('[data-presence-panel]') as HTMLElement;

    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(panel.className).toContain('h-11');
    expect(panel.className).toContain('flex-shrink-0');
    expect(panel.className).not.toContain('border-b');
    expect(panel.className).not.toContain('border-border/40');
    expect(panel.className).not.toMatch(/\bpy-/);
  });
});
