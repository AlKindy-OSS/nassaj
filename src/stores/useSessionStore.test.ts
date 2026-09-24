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

import { computeMerged, compareMessagesByTimestamp, resolveTailBookmark, selectTrulyOlder } from './useSessionStore';
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

/**
 * استرجاع فجوة بثّ (مراجعة qa-critic، بند 2) — الاسترجاع الموسَّع (البديل
 * المحلي في `mergeTailFromServer`، أو نتيجة طابور `light400`) يمرّ عبر نفس
 * `computeMerged`/`resolveTailBookmark` المستخدَمين في المسار العادي، فلا
 * حاجة لعقد جديد؛ هذه الاختبارات تثبت أن التوسيع لا يكسر الضمانات القائمة.
 */
describe('نافذة استرجاع موسَّعة تُدمَج مع صفوف حيّة (بلا فقاعات مكرّرة)', () => {
  it('لا فقاعات مكرّرة حين تحمل النافذة الموسَّعة نفس الردّ المتدفّق حياً', () => {
    // نافذة موسَّعة (200 صفّاً مثلاً) عادت من الخادم وتحمل الردّ المُثبَّت،
    // بينما لا يزال الصفّ الحيّ (`stream_delta`) في الذاكرة قبل أن يُنظَّف.
    const server = Array.from({ length: 199 }, (_, i) =>
      msg(`old-${i}`, `2026-01-01T09:${String(i % 60).padStart(2, '0')}:00.000Z`));
    server.push({
      ...msg('persisted-reply', '2026-01-01T10:00:00.000Z', 'assistant', 'الجواب النهائي'),
      responseToMessageId: 'turn-1',
    });
    const realtime = [{
      ...msg('__streaming_sess-1', '2026-01-01T09:59:59.000Z', 'assistant', 'الجواب النهائي'),
      kind: 'stream_delta' as const,
      responseToMessageId: 'turn-1',
    }];
    const merged = computeMerged(server, realtime);
    const assistantEchoes = merged.filter((m) => m.role === 'assistant' && m.content === 'الجواب النهائي');
    expect(assistantEchoes).toHaveLength(1);
  });

  it('لا تُدمِج التكرار غير المتجاور (dedupeAdjacentAssistantEchoes تشترط التجاور)', () => {
    // Two identical assistant replies for different turns, separated by an
    // unrelated row — adjacency-only dedup must not collapse these, and must
    // not reorder them either.
    const server = [
      msg('a1', '2026-01-01T10:00:00.000Z', 'assistant', 'نفس النص'),
      msg('mid', '2026-01-01T10:01:00.000Z', 'user', 'سؤال آخر'),
      msg('a2', '2026-01-01T10:02:00.000Z', 'assistant', 'نفس النص'),
    ];
    const merged = computeMerged(server, [msg('extra', '2026-01-01T10:00:30.000Z', 'user', 'ignored-branch')]);
    // extra هنا مجرّد صفّ حقيقي جديد (id غير موجود بالخادم) ليُفعِّل مسار الدمج.
    expect(merged.map((m) => m.id)).toStrictEqual(['a1', 'extra', 'mid', 'a2']);
    expect(merged.filter((m) => m.content === 'نفس النص')).toHaveLength(2);
  });

  it('طوابع زمنية متطابقة/فاسدة تحافظ على الترتيب الأصلي (فرز مستقرّ، لا انعكاس)', () => {
    const rows = [
      msg('first', 'not-a-timestamp'),
      msg('second', 'also-not-a-timestamp'),
      msg('third', '2026-01-01T10:00:00.000Z'),
      msg('fourth', '2026-01-01T10:00:00.000Z'),
    ];
    const sortedOnce = [...rows].sort(compareMessagesByTimestamp);
    // Corrupted/tied timestamps compare as 0 (never negative/positive), so a
    // stable sort must leave their relative order exactly as inserted.
    expect(sortedOnce.map((m) => m.id)).toStrictEqual(['first', 'second', 'third', 'fourth']);
    // Sorting twice must not slowly reverse the run (a common stability bug).
    const sortedTwice = [...sortedOnce].sort(compareMessagesByTimestamp);
    expect(sortedTwice.map((m) => m.id)).toStrictEqual(['first', 'second', 'third', 'fourth']);
  });

  it('علامة الذيل بعد استرجاع موسَّع + fetchMore لا تُسقِط صفحة ولا تُكرِّرها', () => {
    // الاسترجاع الموسَّع يكبّر `slot.serverMessages` (كما تفعل
    // mergeTailFromServer اليوم) بلا لمس `slot.offset` — والعلامة تُشتقّ من
    // طول الصفوف المحتفَظ بها فعلاً (B-432)، فتتبع التوسيع تلقائياً.
    const widenedServerMessages = Array.from({ length: 150 }, (_, i) =>
      msg(`w${i}`, `2026-01-01T09:${String(i % 60).padStart(2, '0')}:00.000Z`));
    const staleOffset = 20; // لم يُحدَّث بعد التوسيع، كما توثّق mergeTailFromServer عمداً.
    const bookmark = resolveTailBookmark({ offset: staleOffset, serverMessages: widenedServerMessages });
    expect(bookmark).toBe(150);

    // صفحة «الأقدم» التالية (fetchMore) تستخدم هذه العلامة كنقطة انطلاقها.
    // نافذة متداخلة جزئياً تحاكي استجابة خادم حقيقية حول نفس نقطة القطع.
    const olderPage = [
      ...Array.from({ length: 5 }, (_, i) => msg(`older${i}`, `2026-01-01T08:${String(i).padStart(2, '0')}:00.000Z`)),
      widenedServerMessages[0],
      widenedServerMessages[1],
    ];
    const trulyOlder = selectTrulyOlder(widenedServerMessages, olderPage);
    expect(trulyOlder).toHaveLength(5);
    expect(trulyOlder.map((m) => m.id)).toStrictEqual(['older0', 'older1', 'older2', 'older3', 'older4']);
    // لا فقدان: كل صفوف الصفحة الأقدم الحقيقية ظهرت؛ لا تكرار: الصفّان
    // المتداخلان (w0, w1) لم يُعادا.
  });
});
