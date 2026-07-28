/**
 * B-89 — computeMerged chronological ordering
 *
 * Verifies that messages arriving out-of-order (realtime before server, or
 * interleaved timestamps) are re-sorted by timestamp after the server/realtime
 * merge, so the chat view never renders bubbles out of sequence.
 *
 * Run: npm run test:client -- --reporter=verbose \
 *        src/stores/useSessionStore.test.ts
 */

import { describe, it, expect } from 'vitest';

import { computeMerged } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

function msg(
  id: string,
  timestamp: string,
  role: 'user' | 'assistant' = 'user',
  content = 'x',
): NormalizedMessage {
  return {
    id,
    sessionId: 'sess-1',
    timestamp,
    provider: 'claude',
    kind: 'text',
    role,
    content,
  };
}

describe('computeMerged — chronological ordering (B-89)', () => {
  it('returns server-only array unchanged when realtime is empty', () => {
    const server = [
      msg('a', '2026-01-01T10:00:00.000Z'),
      msg('b', '2026-01-01T10:01:00.000Z'),
    ];
    expect(computeMerged(server, [])).toStrictEqual(server);
  });

  it('sorts realtime-only array when server is empty', () => {
    const realtime = [
      msg('b', '2026-01-01T10:01:00.000Z'),
      msg('a', '2026-01-01T10:00:00.000Z'),
    ];
    const result = computeMerged([], realtime);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
  });

  it('sorts merged result when realtime messages interleave with server messages', () => {
    // server: t=0 and t=2; realtime: t=3 and t=1 (out of order)
    const server = [
      msg('s0', '2026-01-01T10:00:00.000Z'),
      msg('s2', '2026-01-01T10:02:00.000Z'),
    ];
    const realtime = [
      msg('r3', '2026-01-01T10:03:00.000Z'),
      msg('r1', '2026-01-01T10:01:00.000Z'),
    ];
    const result = computeMerged(server, realtime);
    expect(result.map((m) => m.id)).toStrictEqual(['s0', 'r1', 's2', 'r3']);
  });

  it('sorts when realtime message sits between two server messages by timestamp', () => {
    const server = [
      msg('s0', '2026-01-01T10:00:00.000Z', 'assistant'),
      msg('s2', '2026-01-01T10:02:00.000Z', 'assistant'),
    ];
    const realtime = [
      msg('r1', '2026-01-01T10:01:00.000Z', 'user'),
    ];
    const result = computeMerged(server, realtime);
    expect(result.map((m) => m.id)).toStrictEqual(['s0', 'r1', 's2']);
  });

  it('deduplicates messages already present in server (same id in realtime dropped)', () => {
    const server = [msg('a', '2026-01-01T10:00:00.000Z')];
    const realtime = [msg('a', '2026-01-01T10:00:00.000Z')];
    const result = computeMerged(server, realtime);
    expect(result.length).toBe(1);
  });

  it('drops local_ realtime rows whose user text is already in server', () => {
    const server = [msg('srv-1', '2026-01-01T10:00:00.000Z', 'user', 'hello')];
    const realtime = [msg('local_xyz', '2026-01-01T09:59:59.000Z', 'user', 'hello')];
    const result = computeMerged(server, realtime);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('srv-1');
  });

  it('preserves both messages when timestamps are identical (no crash, no drop)', () => {
    const server = [msg('a', '2026-01-01T10:00:00.000Z')];
    const realtime = [msg('b', '2026-01-01T10:00:00.000Z')];
    const result = computeMerged(server, realtime);
    expect(result.length).toBe(2);
    const ids = result.map((m) => m.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });
});
