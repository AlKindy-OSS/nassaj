/**
 * B-1024 — تذييل المدة لا يظهر مع أوبوس (extended thinking)
 *
 * السبب الجذري: race condition بين إطار النص المستمر من الخادم وحدث complete.
 * عند وصول إطار النص المستمر عبر appendRealtime قبل حدث complete يصبح
 * realtimeMessages = [streaming-row(بلا metric), persisted-row(بلا metric)]،
 * ثم applyResponseTurnCompletion يُلصق metric على persisted-row (آخر صف).
 * dedupeAdjacentAssistantEchoes تحتفظ بالأسبق زمنياً (streaming-row بلا metric)
 * وتحذف persisted-row (مع metric) — فيختفي التذييل.
 *
 * الإصلاح: حين يكون صفّا النص متجاوران بنفس المحتوى ويحمل الأحدث responseTurnMetric
 * دون الأقدم، يُستبدل الأقدم بالأحدث (الذي يحمل بيانات التوقيت).
 */

import { describe, it, expect } from 'vitest';

import { computeMerged } from './useSessionStore';
import type { NormalizedMessage } from './useSessionStore';

const SESSION = 'sess-opus';
const RESPONSE_TO = 'user-msg-b1024';

/** صف النص المنتهي محلياً (أنتجه finalizeStreaming، clientStream:true، بلا metric) */
const streamingRow: NormalizedMessage = {
  id: '__streaming_abc123',
  sessionId: SESSION,
  timestamp: '2026-09-10T10:00:01.000Z', // أسبق
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content: 'رد أوبوس مع تفكير مطوّل',
  responseToMessageId: RESPONSE_TO,
  clientStream: true,
  // لا responseTurnMetric
};

const METRIC = {
  durationMs: 627,
  startedAt: '2026-09-10T09:59:59.000Z',
  completedAt: '2026-09-10T10:00:01.000Z',
};

/** صف النص المُثبَّت من الخادم (وصل عبر appendRealtime، metric من applyResponseTurnCompletion) */
const persistedRow: NormalizedMessage = {
  id: 'f37a3c3b-3d2c-0000-0000-000000000000_0',
  sessionId: SESSION,
  timestamp: '2026-09-10T10:00:02.000Z', // أحدث
  provider: 'claude',
  kind: 'text',
  role: 'assistant',
  content: 'رد أوبوس مع تفكير مطوّل',
  responseToMessageId: RESPONSE_TO,
  responseTurnMetric: METRIC,
};

describe('computeMerged — Opus duration footer (B-1024)', () => {
  it('[BUG] يُثبت غياب responseTurnMetric قبل الإصلاح', () => {
    // هذا الاختبار يُثبت المشكلة: dedupeAdjacentAssistantEchoes كانت تحذف
    // persistedRow وتحتفظ بـ streamingRow (الأسبق زمنياً) حتى لو كان بلا metric.
    // بعد الإصلاح يجب أن يجتاز هذا الاختبار (القيمة المرجوّة metric موجودة).
    const result = computeMerged([], [streamingRow, persistedRow]);
    const assistantRow = result.find(m => m.kind === 'text' && m.role === 'assistant');
    expect(assistantRow?.responseTurnMetric).toEqual(METRIC);
  });

  it('يحتفظ بـ responseTurnMetric حتى حين يسبق صفّ البث المُنتهي الصفَّ المُثبَّت', () => {
    // الصف المُثبَّت وصل بعد صف البث؛ مع ذلك يجب أن يُحفظ الـ metric.
    const result = computeMerged([], [streamingRow, persistedRow]);
    expect(result).toHaveLength(1);
    expect(result[0].responseTurnMetric).toEqual(METRIC);
  });

  it('لا يُعطل مسار سونيت (صف واحد مع metric)', () => {
    const sonnetRow: NormalizedMessage = {
      id: 'sonnet-text_0',
      sessionId: SESSION,
      timestamp: '2026-09-10T10:05:00.000Z',
      provider: 'claude',
      kind: 'text',
      role: 'assistant',
      content: 'رد سونيت',
      responseToMessageId: 'user-msg-sonnet',
      responseTurnMetric: METRIC,
    };
    const result = computeMerged([], [sonnetRow]);
    expect(result[0].responseTurnMetric).toEqual(METRIC);
  });

  it('يحتفظ بـ metric الصف الأسبق حين يكون الأحدث بلا metric (Scenario B: complete أولاً)', () => {
    // Scenario B: complete يصل أولاً → applyResponseTurnCompletion يُلصق metric على
    // streaming-row؛ بعدها يصل persisted-row بلا metric.
    const streamingWithMetric: NormalizedMessage = {
      ...streamingRow,
      responseTurnMetric: METRIC,
    };
    const persistedWithoutMetric: NormalizedMessage = {
      ...persistedRow,
      responseTurnMetric: undefined,
    };
    const result = computeMerged([], [streamingWithMetric, persistedWithoutMetric]);
    expect(result).toHaveLength(1);
    expect(result[0].responseTurnMetric).toEqual(METRIC);
  });
});
