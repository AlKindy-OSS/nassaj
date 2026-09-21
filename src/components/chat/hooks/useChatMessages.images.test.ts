import { describe, expect, it } from 'vitest';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { normalizedToChatMessages } from './useChatMessages';

function userMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 'history-user-1',
    sessionId: 'session-1',
    timestamp: '2026-08-17T10:03:18.025Z',
    provider: 'codex',
    kind: 'text',
    role: 'user',
    content: 'رسالة بصورة',
    ...overrides,
  };
}

describe('normalizedToChatMessages — صور تاريخ المستخدم', () => {
  it('يحوّل data URLs المضمّنة إلى ChatImage بأسماء ثابتة ويزيل التكرار', () => {
    const first = 'data:image/png;base64,AA==';
    const second = 'data:image/jpeg;base64,BB==';
    const [message] = normalizedToChatMessages([
      userMessage({ images: [first, first, '', second] }),
    ]);

    expect(message.images).toEqual([
      { data: first, name: 'image_1' },
      { data: second, name: 'image_2' },
    ]);
  });

  it('يمرّر عدد الصور المستبعدة إلى ChatMessage', () => {
    const [message] = normalizedToChatMessages([
      userMessage({ imagesOmitted: 4 }),
    ]);

    expect(message.imagesOmitted).toBe(4);
  });

  it('لا يسقط رسالة بلا نص عندما تحتوي صورة مضمّنة', () => {
    const data = 'data:image/png;base64,AA==';
    const converted = normalizedToChatMessages([
      userMessage({ content: '', images: [data] }),
    ]);

    expect(converted).toHaveLength(1);
    expect(converted[0].content).toBe('');
    expect(converted[0].images).toEqual([{ data, name: 'image_1' }]);
  });

  it('لا يسقط رسالة بلا نص عندما تحمل عدداً لصور مستبعدة', () => {
    const converted = normalizedToChatMessages([
      userMessage({ content: '', imagesOmitted: 1 }),
    ]);

    expect(converted).toHaveLength(1);
    expect(converted[0].content).toBe('');
    expect(converted[0].imagesOmitted).toBe(1);
  });

  it('يحافظ على صورة ملاحظة Claude ويدمج معها الصورة المضمّنة', () => {
    const content = [
      'راجع الصورتين',
      '[Images provided at the following paths:]',
      '1. /srv/chat-images/0123456789abcdef0123456789abcdef/image_1.png',
    ].join('\n');
    const embedded = 'data:image/webp;base64,CC==';
    const [message] = normalizedToChatMessages([
      userMessage({ provider: 'claude', content, images: [embedded] }),
    ]);

    expect(message.content).toBe('راجع الصورتين');
    expect(message.images).toEqual([
      {
        data: '/api/chat-images/0123456789abcdef0123456789abcdef/image_1.png',
        name: 'image_1.png',
      },
      { data: embedded, name: 'image_1' },
    ]);
  });
});
