/**
 * T-1904 e2e (bug 2) — the live raw transcript frame for an injected steer
 * message arrives through the generic realtime path (every session mirror
 * gets it, sender and starter included) IN ADDITION to the amber SteerBubble
 * ChatInterface already inserted from `steer-queued`. This matcher is what
 * suppresses that duplicate blue bubble.
 */

import { describe, expect, it } from 'vitest';

import { isDuplicateSteerInjectionMatch, type TrackedSteerInjection } from './steerDuplicateDetection';

function tracked(entries: Record<string, TrackedSteerInjection>) {
  return new Map(Object.entries(entries));
}

describe('isDuplicateSteerInjectionMatch', () => {
  it('matches by steerClientMsgId', () => {
    const map = tracked({ 'steer-1': { text: 'focus here', sessionId: 's1', at: Date.now() } });
    expect(isDuplicateSteerInjectionMatch(map, { steerClientMsgId: 'steer-1', sessionId: 's1', content: 'focus here' })).toBe(true);
  });

  it('matches by clientMsgId when steerClientMsgId is absent on the wire', () => {
    const map = tracked({ 'steer-1': { text: 'focus here', sessionId: 's1', at: Date.now() } });
    expect(isDuplicateSteerInjectionMatch(map, { clientMsgId: 'steer-1', sessionId: 's1' })).toBe(true);
  });

  it('falls back to content+session match within the recency window when no id is present', () => {
    const now = Date.now();
    const map = tracked({ 'steer-1': { text: 'focus here', sessionId: 's1', at: now } });
    expect(isDuplicateSteerInjectionMatch(map, { sessionId: 's1', content: 'focus here' }, now + 5_000)).toBe(true);
  });

  it('does not match content from a DIFFERENT session', () => {
    const now = Date.now();
    const map = tracked({ 'steer-1': { text: 'focus here', sessionId: 's1', at: now } });
    expect(isDuplicateSteerInjectionMatch(map, { sessionId: 's2', content: 'focus here' }, now + 1_000)).toBe(false);
  });

  it('does not match content outside the recency window', () => {
    const now = Date.now();
    const map = tracked({ 'steer-1': { text: 'focus here', sessionId: 's1', at: now } });
    expect(isDuplicateSteerInjectionMatch(map, { sessionId: 's1', content: 'focus here' }, now + 60_000)).toBe(false);
  });

  it('returns false for an ordinary message with no id and no matching text', () => {
    const map = tracked({ 'steer-1': { text: 'focus here', sessionId: 's1', at: Date.now() } });
    expect(isDuplicateSteerInjectionMatch(map, { sessionId: 's1', content: 'unrelated message' })).toBe(false);
  });

  it('returns false when nothing is tracked', () => {
    expect(isDuplicateSteerInjectionMatch(new Map(), { sessionId: 's1', content: 'hi' })).toBe(false);
  });
});
