/**
 * B-1666 #8 — a conversation-search snippet finds its rendered message even when
 * the message is formatted Markdown or spans several lines, and the chat
 * scrolls to and flashes it when a session arrives with `__searchTargetSnippet`.
 *
 * RUNNER: vitest.
 */

import { useRef } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));

import { useSessionStore } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';

import { findSearchTargetElement, normalizeSearchText, searchPhrases } from './searchTargetMatch';
import { useChatSessionState } from './useChatSessionState';

function chat(...htmlMessages: string[]): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = htmlMessages.map((html) => `<div class="chat-message">${html}</div>`).join('');
  return container;
}

describe('B-1666 #8 — snippet matching', () => {
  it('drops Markdown symbols and whitespace', () => {
    expect(normalizeSearchText('**Deploy**  the\n`api` _now_')).toBe('deploytheapinow');
  });

  it('ignores a snippet too short to anchor on', () => {
    expect(searchPhrases('...short...')).toEqual([]);
  });

  it('finds a formatted message from its raw snippet', () => {
    const container = chat('<p>other message entirely</p>',
      '<p>We need to <strong>rotate the signing key</strong> before Friday, then redeploy.</p>');
    const hit = findSearchTargetElement(container,
      '...We need to **rotate the signing key** before Friday, then redeploy...');
    expect(hit?.textContent).toContain('rotate the signing key');
  });

  it('finds a multi-line message whose newlines the server folded to spaces', () => {
    const container = chat('<p>first line of the reply</p><ul><li>second line item</li><li>third line item</li></ul>');
    const hit = findSearchTargetElement(container, 'first line of the reply second line item third line item');
    expect(hit).not.toBeNull();
  });

  it('still matches when one edge of the snippet differs (e.g. masked text)', () => {
    const container = chat('<p>token [masked:assignment] then the central matched phrase appears here and continues</p>');
    const hit = findSearchTargetElement(container,
      '...token sk-ant-real-secret-value then the central matched phrase appears here and continues...');
    expect(hit).not.toBeNull();
  });
});

describe('B-1666 #8 — the chat scrolls to the search match', () => {
  const message = (id: string, content: string) => ({
    id, sessionId: 's1', kind: 'text', role: 'assistant', provider: 'claude', timestamp: '2026-10-17T10:00:00Z', content,
  });

  beforeEach(() => {
    publishServerCapabilities({ lightHistoryReady: false });
    authenticatedFetch.mockReset().mockImplementation(async (url: string) => (String(url).includes('/messages')
      ? { ok: true, json: async () => ({ messages: [message('m1', 'hello'), message('m2', 'rotate the signing key')], total: 2, hasMore: false, nextCursor: null }) }
      : { ok: false, status: 404, json: async () => ({}) }));
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('flashes the element holding the matched phrase', async () => {
    const container = chat('<p>hello</p>', '<p>Please <em>rotate the signing key</em> today</p>');
    const target = container.querySelectorAll('.chat-message')[1];
    renderHook(() => {
      const store = useSessionStore();
      const pending = useRef(null);
      const state = useChatSessionState({
        selectedSession: { id: 's1', __provider: 'claude', __searchTargetSnippet: '...Please *rotate the signing key* today' } as any,
        selectedProject: { projectId: 'p1', path: '/a', fullPath: '/a' } as any, ws: null, sendMessage: () => {},
        resetStreamingState: () => {}, pendingViewSessionRef: pending, sessionStore: store,
      });
      (state.scrollContainerRef as { current: HTMLElement | null }).current = container;
      return state;
    });

    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalled(), { timeout: 3000 });
    expect(target.classList.contains('search-highlight-flash')).toBe(true);
  });
});
