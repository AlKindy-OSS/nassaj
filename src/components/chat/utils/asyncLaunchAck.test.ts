import { describe, expect, it } from 'vitest';

import { isAsyncLaunchAck, isAsyncLaunchAckResult } from './asyncLaunchAck';

describe('async launch ack detection (B-1665)', () => {
  it('recognises the structured marker', () => {
    expect(isAsyncLaunchAck({ isAsync: true, status: 'async_launched' })).toBe(true);
    expect(isAsyncLaunchAck({ isAsync: false, status: 'completed' })).toBe(false);
    expect(isAsyncLaunchAck(null)).toBe(false);
  });

  it('recognises the ack text when the structured payload is deferred', () => {
    expect(isAsyncLaunchAckResult({ content: 'Async agent launched successfully.\nagentId: x' })).toBe(true);
    expect(isAsyncLaunchAckResult({ content: 'x', toolUseResult: { isAsync: true, status: 'async_launched' } })).toBe(true);
  });

  it('does not treat a real report that quotes the phrase mid-text as an ack', () => {
    expect(isAsyncLaunchAckResult({ content: 'Report: the log said Async agent launched successfully' })).toBe(false);
    expect(isAsyncLaunchAckResult(null)).toBe(false);
  });
});
