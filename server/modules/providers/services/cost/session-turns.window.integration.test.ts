/**
 * حارس المسار الميت (مراجعة نقدية، B-1021): كان `turnsForSession` يستعلم
 * `response_turn_metrics` بـ`raw.uuid` المجرّد بينما الجدول يخزّن المطبَّع
 * `${raw.uuid}_${partIndex}` (Claude)، فلا يطابق شيئاً ويسقط دوماً إلى المسار
 * الاحتياطي. هنا نُدخل صفّ مقياس بالشكل المخزَّن الحقيقي، ونثبت أن مسار
 * **النافذة** يُحلّ فعلاً: مفتاح الدور = الـuuid المجرّد ونافذته من الصف
 * المخزَّن، لا من طوابع الطلبات.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  responseTurnMetricsDb,
  stopReconcileScheduler,
} from '@/modules/database/index.js';
import {
  bareTranscriptMessageId,
  turnsForSession,
} from '@/modules/providers/services/cost/session-cost.service.js';
import type { RequestUsageRecord } from '@/modules/providers/services/cost/usage-extractors.js';

async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'turns-window-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await initializeDatabase();
  stopReconcileScheduler();
  try {
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const record = (uuid: string, timestamp: string, output: number): RequestUsageRecord => ({
  uuid,
  model: 'claude-opus-4-6',
  timestampMs: Date.parse(timestamp),
  isSubagent: false,
  totals: { input: 0, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
});

test('bareTranscriptMessageId يقشّر لاحقة الجزء ويترك ما ليس UUID', () => {
  assert.equal(bareTranscriptMessageId('1f9ab7c1-7899-4232-acf0-f0bd38fa3ef7_0'),
    '1f9ab7c1-7899-4232-acf0-f0bd38fa3ef7');
  assert.equal(bareTranscriptMessageId('1f9ab7c1-7899-4232-acf0-f0bd38fa3ef7_tr_toolX'),
    '1f9ab7c1-7899-4232-acf0-f0bd38fa3ef7');
  // مزوّدات CLI أخرى: يُترك كما هو.
  assert.equal(bareTranscriptMessageId('msg_eeeeeeee'), 'msg_eeeeeeee');
  assert.equal(bareTranscriptMessageId('item_13'), 'item_13');
});

test('مسار النافذة (لا الاحتياطي) يُحلّ من الصف المخزَّن المطبَّع', async () => {
  await withDatabase(async () => {
    const sessionId = 's-window';
    const finalUuid = '1f9ab7c1-7899-4232-acf0-f0bd38fa3ef7';
    getConnection().prepare("INSERT INTO sessions (session_id, provider) VALUES (?, 'claude')").run(sessionId);
    // يُخزَّن بالمعرّف المطبَّع كما يفعل runner كلود فعلاً: <uuid>_<partIndex>.
    const outcome = responseTurnMetricsDb.recordCompleted({
      turnId: 'turn-1',
      sessionId,
      assistantMessageId: `${finalUuid}_0`,
      startedAt: '2026-03-01T00:00:00.000Z',
      completedAt: '2026-03-01T00:00:20.000Z',
    });
    assert.equal(outcome.status, 'inserted');

    // طلبان داخل نافذة الصف، وثالث خارجها تماماً.
    const requests = [
      record('req-early', '2026-03-01T00:00:05.000Z', 10),
      record(finalUuid, '2026-03-01T00:00:18.000Z', 40),
      record('req-outside', '2026-03-01T01:00:00.000Z', 7),
    ];
    // حدود مستخدم لا تخدم إلا الاحتياطي — نمرّرها كي نتأكد أن الطلبين حُسِما
    // بالنافذة رغم وجود حدّ بينهما، لا بالحدّ.
    const turns = turnsForSession(sessionId, requests, [Date.parse('2026-03-01T00:00:10.000Z')]);
    assert.ok(turns, 'يجب أن تُبنى أدوار');

    const windowTurn = turns.find((turn) => turn.assistantMessageId === finalUuid);
    assert.ok(windowTurn, 'دور النافذة مفتاحه الـuuid المجرّد لا المطبَّع');
    // الدليل القاطع على مسار النافذة: الطوابع من الصف المخزَّن، والطلبان معاً.
    assert.equal(windowTurn.startedAt, '2026-03-01T00:00:00.000Z');
    assert.equal(windowTurn.completedAt, '2026-03-01T00:00:20.000Z');
    assert.equal(windowTurn.requests, 2);
    assert.equal(windowTurn.tokens.output, 50);

    // الطلب خارج النافذة صار دوراً احتياطياً منفصلاً — فالمجموع محفوظ.
    assert.equal(turns.reduce((sum, turn) => sum + turn.requests, 0), 3);
    assert.equal(turns.reduce((sum, turn) => sum + turn.tokens.output, 0), 57);
  });
});
