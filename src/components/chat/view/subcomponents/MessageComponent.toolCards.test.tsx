/**
 * B-1665: tool cards in light history and Agent delegations.
 *  - a deferred input must not render invented defaults ("Agent: Running task", "$ ")
 *  - the "Load tool details" button follows the deferral marker even when a result exists
 *  - an Agent async-launch ack is never dumped as raw text under a "Details" card
 *  - agy `send_message(...)` reply text becomes a card only for antigravity rows
 */
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import type { NormalizedMessage } from '../../../../stores/useSessionStore';

import MessageComponent from './MessageComponent';

vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const base = (opts?.defaultValue as string) || key;
      const vars = Object.entries(opts ?? {}).filter(([name]) => name !== 'defaultValue');
      return vars.length ? `${base}(${vars.map(([name, value]) => `${name}=${String(value)}`).join(',')})` : base;
    },
    i18n: { language: 'ar' },
  }),
}));
vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), useAuth: () => ({ user: null }),
}));
vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), useAuth: () => ({ user: null }),
}));
vi.mock('../../../../hooks/useServerActionCatalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useServerActionCatalog: () => ({
    catalog: [], runAction: async () => ({ status: 'error', code: 'x' }), liveStatusOf: () => null,
  }),
}));

type Props = ComponentProps<typeof MessageComponent>;
afterEach(cleanup);

const ts = '2026-10-17T10:00:00.000Z';
const ACK = 'Async agent launched successfully.\nagentId: a1b2 (internal ID)\noutput_file: /tmp/agent.out';

const tool = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: 'call-1', sessionId: 's', timestamp: ts, provider: 'claude', kind: 'tool_use', toolId: 'tu-1', ...over,
} as NormalizedMessage);
const result = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: 'res-1', sessionId: 's', timestamp: ts, provider: 'claude', kind: 'tool_result', toolId: 'tu-1',
  content: 'ok', ...over,
} as NormalizedMessage);

function renderRow(rows: NormalizedMessage[], provider = 'claude', index = 0) {
  const message = normalizedToChatMessages(rows)[index];
  const props = { message, prevMessage: null, provider, onRequestDeferredHistory: () => {} } as unknown as Props;
  return { message, ...render(<MessageComponent {...props} />) };
}

describe('deferred tool input (light history)', () => {
  it('a deferred input converts to an empty string, an empty object stays "{}"', () => {
    const [deferred] = normalizedToChatMessages([tool({ toolName: 'Bash', toolInput: undefined })]);
    const [empty] = normalizedToChatMessages([tool({ toolName: 'Bash', toolInput: {} })]);
    expect(deferred.toolInput).toBe('');
    expect(empty.toolInput).toBe('{}');
  });

  it('a completed Bash with deferred input shows the load button, not an empty "$ " row', () => {
    const deferredPayload = { fields: ['toolInput'] };
    const { container } = renderRow([
      tool({ toolName: 'Bash', toolInput: undefined, deferredPayload }),
      result({ content: 'done' }),
    ]);
    expect(screen.getByRole('button', { name: 'Load tool details' })).toBeDefined();
    expect(container.textContent).not.toMatch(/\$\s*$/m);
  });

  it('a deferred Agent container is named from its subagent record, never "Running task"', () => {
    const subagent = { id: 'sa', parentId: null, label: 'Audit the scroll code', state: 'running', agentName: 'qa-critic' };
    const { container } = renderRow([
      tool({ toolName: 'Agent', toolInput: undefined, subagent, deferredPayload: { fields: ['toolInput'] } } as never),
    ]);
    expect(container.textContent).toContain('subagent.titleWithType(type=qa-critic)');
    expect(container.textContent).toContain('description=Audit the scroll code');
    expect(container.textContent).not.toContain('Running task');
    expect(screen.getByRole('button', { name: 'Load tool details' })).toBeDefined();
  });

  it('a deferred container with no record gets the neutral localized title', () => {
    const { container } = renderRow([tool({ toolName: 'Task', toolInput: undefined })]);
    expect(container.textContent).toContain('subagent.title');
    expect(container.textContent).not.toMatch(/Agent: Running task|Subagent \//);
  });
});

describe('Agent delegations and launch acks', () => {
  it('an Agent container whose result is the async ack shows no raw text and no Details card', () => {
    const { container } = renderRow([
      tool({ toolName: 'Agent', toolInput: { description: 'Scan', subagent_type: 'researcher', prompt: 'go' } }),
      result({ content: ACK, toolUseResult: { isAsync: true, status: 'async_launched' } } as never),
    ]);
    expect(container.textContent).not.toContain('Async agent launched successfully');
    expect(container.textContent).not.toContain('tools.titles.details');
    expect(container.textContent).toContain('Sub-agent'); // the delegation badge
  });

  it('a completed container whose result is only the ack never shows the ack as its final result', () => {
    // Light history: toolUseResult deferred, so the container counts as complete.
    const { container } = renderRow([
      tool({ toolName: 'Agent', toolInput: { description: 'Scan', subagent_type: 'researcher', prompt: 'go' } }),
      result({ content: ACK }),
    ]);
    expect(container.textContent).not.toContain('Async agent launched successfully');
    expect(container.textContent).not.toContain('output_file');
  });

  it('an orphaned ack (light history, no toolUseResult) renders the localized chip', () => {
    const { message, container } = renderRow([result({ id: 'orphan', toolId: 'missing', content: ACK })]);
    expect(message.backgroundAgentAck).toBe(true);
    expect(container.textContent).toContain('subagent.backgroundLaunched');
    expect(container.textContent).not.toContain('output_file');
  });

  it('an orphaned sub-agent report that is not an ack stays readable', () => {
    const subagent = { id: 'sa', parentId: null, label: 'x', state: 'completed' };
    const { message, container } = renderRow([
      result({ id: 'orphan', toolId: 'missing', content: 'Final report: all green', subagent } as never),
    ]);
    expect(message.backgroundAgentAck).toBeUndefined();
    expect(container.textContent).toContain('Final report: all green');
  });
});

describe('agy send_message reply text', () => {
  const text = 'Here is my answer.\n\nsend_message(Recipient="ibrahim", RecipientName="parent", message="Build is green")';
  const reply = (provider: string) => ({
    id: 'r1', sessionId: 's', timestamp: ts, provider, kind: 'text', role: 'assistant', content: text,
  } as NormalizedMessage);

  it('an antigravity row renders the call as a card titled with the recipient', () => {
    const { container } = renderRow([reply('antigravity')], 'antigravity');
    expect(container.textContent).toContain('agyMessage.to(name=parent)');
    expect(container.textContent).toContain('Build is green');
    expect(container.textContent).not.toContain('send_message(');
  });

  it('the row provider decides, not the session provider', () => {
    const { container } = renderRow([reply('claude')], 'antigravity');
    expect(container.textContent).toContain('send_message(');
    expect(container.textContent).not.toContain('agyMessage.to');
  });
});
