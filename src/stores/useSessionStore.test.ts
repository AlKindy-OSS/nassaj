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

import { computeMerged, resolveTailBookmark, selectTrulyOlder } from './useSessionStore';
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

  it('drops a local user row only when server echoes its identity', () => {
    const server = [{ ...msg('srv-1', '2026-01-01T10:00:00.000Z', 'user', 'hello'), clientMsgId: 'local_xyz' }];
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

/**
 * B-432 — صفحة «الأقدم» تُلصق أحدث الرسائل في رأس المحادثة
 *
 * نقطة `/messages` مرساتها الذيل، و`slot.offset` كان ينزلق تحت الواقع كلّما
 * كتب التشغيل الحيّ صفوفاً جديدة (mergeTailFromServer يترك العلامة عمداً،
 * وrefreshFromServer يستبدل الصفوف ولا يمسّها). فتعود صفحة «الأقدم» حاملةً
 * أحدث الصفوف ثم تُلصق في الرأس بلا فحص هوية.
 */
describe('pagination bookmark & prepend guard (B-432)', () => {
  it('derives the bookmark from rows actually held when the counter lags', () => {
    // 21 صفّاً معروضاً بينما العدّاد عالق على 20 (صفٌّ كتبه التشغيل الحيّ).
    const held = Array.from({ length: 21 }, (_, i) =>
      msg(`s${i}`, `2026-01-01T10:${String(i).padStart(2, '0')}:00.000Z`));
    expect(resolveTailBookmark({ offset: 20, serverMessages: held })).toBe(21);
  });

  it('never lets the bookmark go backwards below the stored counter', () => {
    expect(resolveTailBookmark({ offset: 40, serverMessages: [] })).toBe(40);
  });

  it('drops incoming rows already held instead of prepending duplicates', () => {
    const held = [
      msg('old', '2026-01-01T10:00:00.000Z'),
      msg('new1', '2026-01-01T17:06:00.000Z', 'assistant'),
      msg('new2', '2026-01-01T17:07:00.000Z', 'assistant'),
    ];
    // نافذة متداخلة: أول صفّين فيها معروضان أصلاً.
    const incoming = [
      msg('older1', '2026-01-01T09:58:00.000Z'),
      msg('new1', '2026-01-01T17:06:00.000Z', 'assistant'),
      msg('new2', '2026-01-01T17:07:00.000Z', 'assistant'),
    ];

    const trulyOlder = selectTrulyOlder(held, incoming);
    expect(trulyOlder.map((m) => m.id)).toStrictEqual(['older1']);

    // والنتيجة المعروضة تبقى مرتّبة: لا ردٌّ من 17:06 فوق مطالبة 10:00.
    const merged = [...trulyOlder, ...held];
    expect(merged.map((m) => m.id)).toStrictEqual(['older1', 'old', 'new1', 'new2']);
  });
});
