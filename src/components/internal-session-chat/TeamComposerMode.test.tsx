/**
 * ADR-187 team chat as a composer mode: the toolbar toggle, the team send
 * path (room endpoint only, never the model), Esc/toggle exit, a separate team
 * draft, room unavailable/re-activate, members, and B-1666 session isolation.
 *
 * Run: NODE_ENV=test npx vitest run src/components/internal-session-chat/TeamComposerMode.test.tsx
 */
import { createRef, useRef } from 'react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }),
}));
vi.mock('../../hooks/useRawExecConfig', () => ({ useRawExecConfig: () => ({ canUseRaw: true, loading: false }) }));

import ChatComposer from '../chat/view/subcomponents/ChatComposer';

import { useInternalSessionChat } from './useInternalSessionChat';
import TeamMessageBubble from './TeamMessageBubble';

class IdleSocket { onopen = null; onmessage = null; onclose = null; close() {} }

const noop = () => {};
const baseProps = {
  pendingPermissionRequests: [], handlePermissionDecision: noop, handleGrantToolPermission: () => ({ success: true }),
  claudeStatus: null, isLoading: false, onAbortSession: noop, provider: 'claude', displayProvider: 'claude',
  permissionMode: 'default', onModeSwitch: noop, thinkingMode: 'none', setThinkingMode: noop, composerMode: 'chat',
  setComposerMode: noop, agentModeAvailable: false, coordinationLevel: 'direct', setCoordinationLevel: noop,
  coordinationLevelAvailable: false, tokenBudget: null, slashCommandsCount: 0, onToggleCommandMenu: noop,
  hasInput: false, onClearInput: noop, isDragActive: false, attachedImages: [], onRemoveImage: noop,
  uploadingImages: new Map(), imageErrors: new Map(), showFileDropdown: false, filteredFiles: [], selectedFileIndex: 0,
  onSelectFile: noop, filteredCommands: [], selectedCommandIndex: 0, onCommandSelect: noop, onCloseCommandMenu: noop,
  isCommandMenuOpen: false, frequentCommands: [], attachedFiles: [], onRemoveFile: noop, uploadingFiles: new Map(),
  fileErrors: new Map(), getRootProps: () => ({}), getInputProps: () => ({}), openImagePicker: noop,
  inputHighlightRef: createRef<HTMLDivElement>(), renderInputWithMentions: (text: string) => text,
  onTextareaClick: noop, onTextareaPaste: noop, onTextareaScrollSync: noop, onTextareaInput: noop,
  placeholder: 'provider placeholder', isTextareaExpanded: false,
};

type HarnessProps = {
  sessionId: string;
  enabled?: boolean;
  onSubmit?: () => void;
  onTextareaKeyDown?: () => void;
};

function Harness({ sessionId, enabled = true, onSubmit = noop, onTextareaKeyDown = noop }: HarnessProps) {
  const teamChat = useInternalSessionChat({ sessionId, enabled });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const props = {
    ...baseProps, teamChat, teamProjectId: 'p1', textareaRef, input: 'model draft', onInputChange: noop,
    onSubmit, onTextareaKeyDown,
  } as unknown as ComponentProps<typeof ChatComposer>;
  return <ChatComposer {...props} />;
}

const response = (payload: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => payload });
const owner = { userId: 1, username: 'owner', role: 'owner' };
const sara = { userId: 7, username: 'sara', role: 'member' };
const roomWith = (...members: object[]) => ({ members, unreadMentionCount: 0, lastReadSequence: 0, role: 'owner' });

const toggle = () => screen.getByTestId('composer-team-toggle');
const textarea = (container: HTMLElement) => container.querySelector('textarea') as HTMLTextAreaElement;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const posts = (suffix: string) => authenticatedFetch.mock.calls
  .filter(([url, init]) => String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'POST');

beforeEach(() => { vi.stubGlobal('WebSocket', IdleSocket); });
afterEach(() => { cleanup(); authenticatedFetch.mockReset(); vi.unstubAllGlobals(); });

describe('composer team mode (ADR-187)', () => {
  it('shows no team toggle and calls nothing while the capability is off', () => {
    render(<Harness sessionId="s1" enabled={false} />);
    expect(screen.queryByTestId('composer-team-toggle')).toBeNull();
    // The composer's own voice-settings read is unrelated; no room request at all.
    expect(authenticatedFetch.mock.calls.some(([url]) => String(url).includes('/internal-'))).toBe(false);
  });

  it('the toolbar toggle switches the main composer into team mode and back', async () => {
    authenticatedFetch.mockImplementation(async (url: string) => response(url.endsWith('/internal-room') ? roomWith(owner) : []));
    const { container } = render(<Harness sessionId="s1" />);
    await flush();
    expect(toggle().getAttribute('aria-label')).toBe('internalChat.button');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(textarea(container).value).toBe('model draft');

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('form')!.getAttribute('data-team-mode')).toBe('on');
    expect(screen.getByTestId('composer-team-panel').textContent).toContain('internalChat.notSentNote');
    expect(textarea(container).placeholder).toBe('internalChat.placeholder');
    expect(textarea(container).getAttribute('aria-label')).toBe('internalChat.draftLabel');
    // The team draft is its own: the model draft is neither shown nor sendable here.
    expect(textarea(container).value).toBe('');

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(textarea(container).value).toBe('model draft');
  });

  it('Esc leaves team mode and keeps the unsent team draft for next time', async () => {
    authenticatedFetch.mockImplementation(async (url: string) => response(url.endsWith('/internal-room') ? roomWith(owner) : []));
    const { container } = render(<Harness sessionId="s1" />);
    await flush();
    fireEvent.click(toggle());
    fireEvent.change(textarea(container), { target: { value: 'ملاحظة للفريق' } });
    fireEvent.keyDown(textarea(container), { key: 'Escape' });
    expect(screen.queryByTestId('composer-team-panel')).toBeNull();
    expect(textarea(container).value).toBe('model draft');
    fireEvent.click(toggle());
    expect(textarea(container).value).toBe('ملاحظة للفريق');
  });

  it('Enter sends to the room endpoint only, with mentions picked from room members', async () => {
    const created = { id: 'm1', sequence: 1, body: '@sara مرحباً', authorUserId: 1, createdAt: '2026-01-01' };
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/internal-room')) return response(roomWith(owner, sara));
      return response(init?.method === 'POST' ? created : []);
    });
    const onSubmit = vi.fn();
    const onTextareaKeyDown = vi.fn();
    const { container } = render(<Harness sessionId="s1" onSubmit={onSubmit} onTextareaKeyDown={onTextareaKeyDown} />);
    await flush();
    fireEvent.click(toggle());
    const input = textarea(container);
    fireEvent.change(input, { target: { value: '@sa' } });
    expect(screen.getByRole('option', { name: /sara/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('@sara ');
    fireEvent.change(input, { target: { value: '@sara مرحباً' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(posts('/internal-messages')).toHaveLength(1));
    const request = posts('/internal-messages')[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({ body: '@sara مرحباً', mentionUserIds: [7] });
    await waitFor(() => expect(input.value).toBe(''));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onTextareaKeyDown).not.toHaveBeenCalled();
    const elsewhere = authenticatedFetch.mock.calls.map(([url]) => String(url))
      .filter((url) => !url.startsWith('/api/sessions/s1/internal-') && url !== '/api/voice/transcription/settings');
    expect(elsewhere).toEqual([]);
  });

  it('the send button submits to the team, never the provider', async () => {
    const created = { id: 'm1', sequence: 1, body: 'hi', authorUserId: 1, createdAt: '2026-01-01' };
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/internal-room')) return response(roomWith(owner));
      return response(init?.method === 'POST' ? created : []);
    });
    const onSubmit = vi.fn();
    const { container } = render(<Harness sessionId="s1" onSubmit={onSubmit} />);
    await flush();
    fireEvent.click(toggle());
    const send = screen.getByRole('button', { name: 'internalChat.send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(textarea(container), { target: { value: 'hi' } });
    expect(send.disabled).toBe(false);
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(posts('/internal-messages')).toHaveLength(1));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('entering team mode acknowledges the highest read sequence', async () => {
    const page = [
      { id: 'm3', sequence: 3, body: 'c', authorUserId: 1, createdAt: '2026-01-01' },
      { id: 'm1', sequence: 1, body: 'a', authorUserId: 1, createdAt: '2026-01-01' },
    ];
    authenticatedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/internal-room')) return response({ ...roomWith(owner), unreadMentionCount: 2 });
      return response(url.endsWith('/internal-messages') ? page : {});
    });
    render(<Harness sessionId="s1" />);
    await flush();
    expect(toggle().getAttribute('aria-label')).toBe('internalChat.toggleWithMentions');
    fireEvent.click(toggle());
    await waitFor(() => expect(posts('/internal-read')).toHaveLength(1));
    expect(JSON.parse(String((posts('/internal-read')[0][1] as RequestInit).body))).toEqual({ sequence: 3 });
  });

  it('team and shell modes exclude each other', async () => {
    authenticatedFetch.mockImplementation(async (url: string) => response(url.endsWith('/internal-room') ? roomWith(owner) : []));
    render(<Harness sessionId="s1" />);
    await flush();
    const shell = screen.getByTestId('composer-shell-toggle');
    fireEvent.click(shell);
    expect(shell.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle());
    expect(shell.getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(shell);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the creation failure and re-activates with the caller as sole owner', async () => {
    authenticatedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/revalidate')) return response(roomWith(owner));
      if (url.startsWith('/api/projects/')) return response({ data: { members: [] } });
      return response({ error: 'Not found' }, false);
    });
    render(<Harness sessionId="s1" />);
    await flush();
    fireEvent.click(toggle());
    expect((await screen.findByRole('alert')).textContent).toBe('internalChat.createFailed');
    expect(screen.getByText('internalChat.unavailable')).toBeTruthy();
    expect(posts('/internal-room')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'internalChat.reactivate' }));
    expect(await screen.findByText('internalChat.members.heading')).toBeTruthy();
    const call = posts('/revalidate')[0];
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ members: [{ userId: 1, role: 'owner' }] });
  });

  it('opens room members from the team panel', async () => {
    authenticatedFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/internal-room')) return response(roomWith(owner, sara));
      if (url.startsWith('/api/projects/')) return response({ data: { members: [] } });
      return response([]);
    });
    render(<Harness sessionId="s1" />);
    await flush();
    fireEvent.click(toggle());
    const members = screen.getByRole('button', { name: /internalChat.members.toggle/ });
    expect(members.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(members);
    expect(await screen.findByText('internalChat.members.heading')).toBeTruthy();
  });

  it('B-1666: a late send answer for room A never lands in room B', async () => {
    const held: Array<() => void> = [];
    authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/internal-room')) return response(roomWith(owner));
      if (url === '/api/sessions/s1/internal-messages' && init?.method === 'POST') {
        return new Promise((resolve) => { held.push(() => resolve(response({ id: 'a', sequence: 9, body: 'A', authorUserId: 1, createdAt: '2026-01-01' }))); });
      }
      return response([]);
    });
    const view = render(<Harness sessionId="s1" />);
    await flush();
    fireEvent.click(toggle());
    fireEvent.change(textarea(view.container), { target: { value: 'مسودة أ' } });
    fireEvent.keyDown(textarea(view.container), { key: 'Enter' });
    await waitFor(() => expect(held).toHaveLength(1));
    const sendSignal = (posts('/internal-messages')[0][1] as RequestInit).signal!;

    view.rerender(<Harness sessionId="s2" />);
    await flush();
    expect(sendSignal.aborted).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle());
    fireEvent.change(textarea(view.container), { target: { value: 'مسودة ب' } });
    held.forEach((release) => release());
    await flush();
    expect(textarea(view.container).value).toBe('مسودة ب');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a leading @mention intact in an RTL team message', () => {
    const body = '@sara رسالة للفريق @omar';
    const { container } = render(
      <TeamMessageBubble message={{ id: 1, body, authorName: 'owner', createdAt: '2026-10-20T10:00:00Z' } as never} />,
    );
    const isolated = container.querySelectorAll('bdi[dir="ltr"]');
    expect(Array.from(isolated, (el) => el.textContent)).toEqual(['@sara', '@omar']);
    expect(container.querySelector('.whitespace-pre-wrap')?.textContent).toBe(body);
  });
});
