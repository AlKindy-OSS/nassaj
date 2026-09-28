/**
 * T-1904 e2e (bug 2) — root cause: `chatMessageToNormalized` (the converter
 * `addMessage` uses for a LIVE, locally-inserted row — e.g. ChatInterface's
 * synthetic SteerBubble insertion on `steer-queued`) allowlisted fields and
 * silently dropped `injected`/`deliveryStatus`/`steerClientMsgId`/
 * `steerSenderDisplayName`. This is a SEPARATE code path from the history
 * converter (useChatMessages.ts, fixed earlier in T-1903) — exactly the kind
 * of mirrored logic that drifts. Without this fix the live bubble rendered as
 * a plain blue user message with a "?" avatar, only turning amber after a
 * reload pulled the real converter.
 */

import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../types/types';

import { chatMessageToNormalized } from './useChatSessionState';

describe('chatMessageToNormalized — steer fields parity', () => {
  it('preserves injected/deliveryStatus/steerClientMsgId/steerSenderDisplayName', () => {
    const msg: ChatMessage = {
      type: 'user',
      content: 'focus on the bug',
      userId: 7,
      injected: true,
      deliveryStatus: 'queued',
      steerClientMsgId: 'steer-abc123',
      steerSenderDisplayName: 'سارة',
      timestamp: Date.now(),
    };

    const normalized = chatMessageToNormalized(msg, 's1', 'claude');

    expect(normalized).toMatchObject({
      kind: 'text',
      role: 'user',
      content: 'focus on the bug',
      userId: 7,
      injected: true,
      deliveryStatus: 'queued',
      steerClientMsgId: 'steer-abc123',
      steerSenderDisplayName: 'سارة',
    });
  });

  it('leaves the fields undefined for an ordinary (non-steer) message', () => {
    const msg: ChatMessage = { type: 'user', content: 'hello', timestamp: Date.now() };
    const normalized = chatMessageToNormalized(msg, 's1', 'claude');
    expect(normalized).toMatchObject({ kind: 'text', role: 'user', content: 'hello' });
    expect((normalized as any).injected).toBeUndefined();
    expect((normalized as any).steerSenderDisplayName).toBeUndefined();
  });
});
