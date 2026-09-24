import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import { normalizedToChatMessages } from '../../hooks/useChatMessages';

import ChatMessageImage from './ChatMessageImage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

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
    expect(image.className).toContain('h-auto');
    expect(image.className).toContain('max-w-full');

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
});
