/**
 * Skill-body rows render as one compact expandable line, not a user bubble.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/MessageComponent.skillLoad.test.tsx
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import type { NormalizedMessage } from '../../../../stores/useSessionStore';

import MessageComponent from './MessageComponent';

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; name?: string }) =>
      (opts?.defaultValue || key).replace('{{name}}', opts?.name ?? ''),
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../auth', async (importOriginal) => ({
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

describe('skill-load row', () => {
  const normalized = {
    id: 'm1', sessionId: 's', timestamp: '2026-10-05T10:00:00.000Z', provider: 'claude',
    kind: 'text', role: 'assistant', isSkillLoad: true, skillName: 'project-manager',
    content: 'Base directory for this skill: /x/skills/project-manager\n\nSKILL BODY',
  } as NormalizedMessage;

  it('is converted to a non-user chat message keeping the skill flags', () => {
    const [chat] = normalizedToChatMessages([normalized]);
    expect(chat.type).toBe('assistant');
    expect(chat.isSkillLoad).toBe(true);
    expect(chat.skillName).toBe('project-manager');
  });

  it('renders one collapsed disclosure with the skill name and no user bubble', () => {
    const [chat] = normalizedToChatMessages([normalized]);
    const view = render(
      <MessageComponent {...({ prevMessage: null, createDiff: () => [], provider: 'claude', message: chat } as unknown as Props)} />,
    );
    const details = view.container.querySelector('details[data-skill-load]') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(view.getByText('Skill loaded: project-manager')).toBeTruthy();
    expect(view.container.querySelector('[data-user-message-bubble]')).toBeNull();
    expect(details.querySelector('pre')?.textContent).toContain('SKILL BODY');
  });

  it('does not group the following assistant reply under the skill line', () => {
    const [skill] = normalizedToChatMessages([normalized]);
    const reply = { id: 'a1', type: 'assistant', content: 'reply', timestamp: '2026-10-05T10:00:01.000Z' };
    const render1 = (prev: unknown) => render(
      <MessageComponent {...({ prevMessage: prev, createDiff: () => [], provider: 'claude', message: reply } as unknown as Props)} />,
    ).container.querySelector('.chat-message');
    expect(render1(skill)?.className).not.toContain('grouped');
    cleanup();
    expect(render1({ id: 'a0', type: 'assistant', content: 'x' })?.className).toContain('grouped');
  });

  it('keeps the visible label inside the accessible name (no aria-label override)', () => {
    const [chat] = normalizedToChatMessages([normalized]);
    const view = render(
      <MessageComponent {...({ prevMessage: null, createDiff: () => [], provider: 'claude', message: chat } as unknown as Props)} />,
    );
    expect(view.container.querySelector('details[data-skill-load] summary')?.hasAttribute('aria-label')).toBe(false);
  });
});
