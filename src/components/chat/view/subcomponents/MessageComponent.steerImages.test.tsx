/**
 * B-1697: the steer branch of MessageComponent must hand the message's images
 * to SteerBubble (it used to pass the text only, so a steer's picture vanished).
 * The reload path is covered end to end: a history row (clean text + store
 * refs) goes through normalizedToChatMessages into the rendered bubble.
 */
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { normalizedToChatMessages } from '../../hooks/useChatMessages';

import MessageComponent from './MessageComponent';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
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

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const BUCKET = 'cd'.repeat(16);

const renderMessage = (message: Record<string, unknown>) => render(
  <MessageComponent
    {...({ prevMessage: null, createDiff: () => [], provider: 'claude', message } as unknown as Props)}
  />,
);

const steerMessage = (images?: Array<{ name: string; data: string }>) => ({
  id: 's1',
  type: 'user',
  content: 'انظر الصورة',
  timestamp: '2026-10-27T10:00:00.000Z',
  injected: true,
  deliveryStatus: 'delivered',
  steerSenderDisplayName: 'سارة',
  images,
});

describe('MessageComponent — steer images (B-1697)', () => {
  it('passes message.images to the steer bubble', () => {
    const { container } = renderMessage(steerMessage([{ name: 'image_0.png', data: PNG }]));
    const bubble = container.querySelector('[data-steer-injected="true"]');
    expect(bubble).not.toBeNull();
    const img = bubble!.querySelector('[data-steer-images="true"] img');
    expect(img?.getAttribute('src')).toBe(PNG);
    expect(container.querySelector('[data-user-message-bubble]')).toBeNull();
  });

  it('renders the steer bubble without a grid when it carried no images', () => {
    const { container } = renderMessage(steerMessage());
    expect(container.querySelector('[data-steer-injected="true"]')).not.toBeNull();
    expect(container.querySelector('[data-steer-images]')).toBeNull();
  });

  it('reload: a history steer row with store refs becomes a bubble with its images', () => {
    const [converted] = normalizedToChatMessages([{
      id: 'u1_steer', kind: 'text', role: 'user', content: 'انظر الصورة', provider: 'claude', sessionId: 'x',
      timestamp: '2026-10-27T10:00:00.000Z', injected: true, deliveryStatus: 'delivered', userId: 2,
      steerClientMsgId: 'c-1', images: [{ bucket: BUCKET, name: 'image_0.png' }],
    } as never]);
    expect(converted.injected).toBe(true);
    expect(converted.images).toEqual([{ name: 'image_0.png', data: `/api/chat-images/${BUCKET}/image_0.png` }]);
    const { container } = renderMessage(converted as unknown as Record<string, unknown>);
    expect(container.querySelector('[data-steer-injected="true"] [data-steer-images="true"]')).not.toBeNull();
  });
});
