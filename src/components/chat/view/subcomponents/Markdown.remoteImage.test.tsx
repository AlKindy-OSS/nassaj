/**
 * B-1667: plain Markdown images `![alt](src)` must not let a remote URL reach
 * any viewer's browser, in assistant messages and in Markdown tool cards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ChatActionsContext, type ChatActionsContextValue } from '../../context/ChatActionsContext';
import { MarkdownContent } from '../../tools/components/ContentRenderers/MarkdownContent';

import { Markdown } from './Markdown';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key }),
}));
vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { id: 1, username: 'owner' } }),
}));
vi.mock('../../../../hooks/useRawExecConfig', () => ({
  useRawExecConfig: () => ({ canUseRaw: false, loading: false }),
  useRawExecQueue: () => ({ commands: [], canUseRaw: false, loading: false, refresh: () => {} }),
  invalidateRawExecConfig: () => {},
  refreshRawExecConfig: () => {},
}));
const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => mockFetch(...args) }));

const CTX: ChatActionsContextValue = {
  catalog: [], runAction: async () => ({ status: 'error' as const, code: 'test' }), userRole: 'owner',
  inlineExecEnabled: true, liveStatusOf: () => null, sessionId: 'session-abc',
};

function renderMd(md: string, Component: typeof Markdown | typeof MarkdownContent = Markdown) {
  const node = Component === Markdown ? <Markdown>{md}</Markdown> : <MarkdownContent content={md} />;
  return render(<ChatActionsContext.Provider value={CTX}>{node}</ChatActionsContext.Provider>);
}

const imgSources = () => Array.from(document.querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '');

afterEach(() => { cleanup(); mockFetch.mockReset(); });

describe('Markdown img renderer (B-1667)', () => {
  it.each([
    'https://evil.example/p.png?d=secret',
    'http://evil.example/p.png',
    'HTTPS://evil.example/p.png',
    '//evil.example/p.png',
  ])('%s → visible error and no <img> carrying the remote source', (src) => {
    renderMd(`look ![x](${src}) here`);
    expect(screen.getByRole('img', { name: 'الروابط البعيدة معطّلة' })).toBeDefined();
    expect(imgSources().some((value) => value.includes('evil.example'))).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a remote image inside a Markdown tool card is blocked too', () => {
    renderMd('![leak](https://evil.example/t.png)', MarkdownContent);
    expect(screen.getByRole('img', { name: 'الروابط البعيدة معطّلة' })).toBeDefined();
    expect(imgSources()).toEqual([]);
  });

  it('an /api/ path outside the image allowlist is not fetched with the viewer token', () => {
    renderMd('![x](/api/user/delete-account)');
    expect(screen.getByRole('img', { name: 'طلب صورة غير صالح' })).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('an absolute path goes through the authenticated assistant-images endpoint', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    renderMd('![shot](/home/operator/shot.png)');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockFetch.mock.calls[0][0]).toBe('/api/assistant-images?path=%2Fhome%2Foperator%2Fshot.png&session=session-abc');
  });

  it('a data: image renders directly', () => {
    renderMd('![inline](data:image/png;base64,AA==)');
    expect(imgSources()).toEqual(['data:image/png;base64,AA==']);
  });

  it('an empty source shows the invalid-request error', () => {
    renderMd('![empty]()');
    expect(screen.getByRole('img', { name: 'طلب صورة غير صالح' })).toBeDefined();
  });

  it('a remote LINK (not an image) still renders as a link', () => {
    renderMd('[docs](https://example.com/docs)');
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toBe('https://example.com/docs');
  });
});
