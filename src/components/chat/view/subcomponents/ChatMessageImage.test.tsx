import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import { normalizedToChatMessages } from '../../hooks/useChatMessages';

import ChatMessageImage from './ChatMessageImage';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../../utils/api', () => ({ authenticatedFetch }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => { cleanup(); authenticatedFetch.mockReset(); });

describe('ChatMessageImage', () => {
  it('يعرض معاينة قابلة للنقر ويفتح الصورة المكبّرة ثم يغلقها', () => {
    render(<ChatMessageImage src="data:image/png;base64,AA==" alt="shot.png" />);

    const preview = screen.getByRole('button', { name: 'Preview shot.png' });
    expect(preview.className).toContain('rounded-none');
    expect(preview.className).toContain('border-0');
    expect(preview.className).toContain('bg-transparent');
    expect(preview.className).toContain('focus-visible:ring-ring');
    expect(preview.className).not.toContain('overflow-hidden');
    expect(preview.className).not.toContain('rounded-lg');

    const image = screen.getByRole('img', { name: 'shot.png' });
    expect(image.className).toContain('h-56');
    expect(image.className).toContain('object-cover');
    expect(image.className).toContain('max-w-full');
    expect(image.getAttribute('decoding')).toBe('async');

    fireEvent.click(preview);
    expect(screen.getByRole('dialog', { name: 'shot.png' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'images.closePreview' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('يمرّر صورة تاريخ Codex من NormalizedMessage إلى المعاينة والـlightbox', () => {
    const dataUrl = 'data:image/png;base64,AA==';
    const historyMessage: NormalizedMessage = {
      id: 'history-user-1',
      sessionId: 'codex-session-1',
      timestamp: '2026-08-17T10:03:18.025Z',
      provider: 'codex',
      kind: 'text',
      role: 'user',
      content: '',
      images: [dataUrl],
    };

    const [chatMessage] = normalizedToChatMessages([historyMessage]);
    expect(chatMessage.images).toEqual([{ data: dataUrl, name: 'image_1' }]);

    const [image] = chatMessage.images!;
    render(<ChatMessageImage src={image.data} alt={image.name} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview image_1' }));
    expect(screen.getByRole('dialog', { name: 'image_1' })).toBeDefined();
  });

  it('B-1665: reserves the final thumbnail box while the authenticated fetch is pending', async () => {
    let resolveFetch: (value: unknown) => void = () => {};
    authenticatedFetch.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    Object.assign(URL, { createObjectURL: () => 'blob:shot', revokeObjectURL: () => {} }); // jsdom lacks both
    render(<ChatMessageImage src="/api/chat-images/a.png" alt="a.png" />);
    const placeholder = screen.getByTestId('chat-image-placeholder');
    expect(placeholder.className).toContain('h-56');
    expect(placeholder.className).toContain('w-full');

    resolveFetch({ ok: true, blob: async () => new Blob(['x']) });
    const image = await screen.findByRole('img', { name: 'a.png' });
    expect(image.className).toContain('h-56');
    expect(screen.queryByTestId('chat-image-placeholder')).toBeNull();
  });

  it('B-1665: a failed silent fetch removes the placeholder and renders nothing', async () => {
    authenticatedFetch.mockResolvedValue({ ok: false, status: 404 });
    const { container } = render(<ChatMessageImage src="/api/chat-images/gone.png" />);
    await waitFor(() => expect(screen.queryByTestId('chat-image-placeholder')).toBeNull());
    expect(container.innerHTML).toBe('');
  });

  it('B-1665: a failed fetch with showLoadError still shows the visible error', async () => {
    authenticatedFetch.mockResolvedValue({ ok: false, status: 403 });
    render(<ChatMessageImage src="/api/assistant-images?path=x" showLoadError objectFit="contain" />);
    expect(screen.getByTestId('chat-image-placeholder').className).toContain('h-40');
    expect(await screen.findByRole('img', { name: 'تعذّر تحميل الصورة' })).toBeDefined();
  });
});
