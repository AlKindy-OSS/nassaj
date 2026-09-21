/**
 * اختبارات الدالّة الصرفة `buildSessionTurns`. المسعّر مُحقَن (لا جدول أسعار
 * حقيقي) كي تختبر المنطق وحده: تجميع الطلبات في أدوار عبر نوافذ المقياس
 * والمسار الاحتياطي، والثابت المحوري — مجموع توكنات الأدوار = إجماليات
 * perModel، ومجموع كلفها = الأرضية المسعّرة.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSessionTurns, type PriceModelFn, type TurnMetricWindow } from './session-turns.js';
import type { RequestUsageRecord } from './usage-extractors.js';

const req = (
  uuid: string,
  timestamp: string,
  model: string,
  output: number,
  extra: Partial<RequestUsageRecord['totals']> = {},
  isSubagent = false,
): RequestUsageRecord => ({
  uuid,
  model,
  timestampMs: Date.parse(timestamp),
  isSubagent,
  totals: { input: 0, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, ...extra },
});

// نموذج 'free' بلا سعر رسمي (costUsd=null)؛ غيره يُسعَّر بـ 0.01$ لكل توكن مخرَج.
const priceStub: PriceModelFn = (usage) => ({
  costUsd: usage.model === 'free' ? null : usage.totals.output * 0.01,
});

const sumOutput = (records: readonly RequestUsageRecord[]): number =>
  records.reduce((total, record) => total + record.totals.output, 0);

test('نافذة المقياس تجمع كل الطلبات الواقعة في مداها تحت مفتاح رسالتها النهائية', () => {
  const requests = [
    req('r1', '2026-01-01T00:00:02Z', 'opus', 100),
    req('sub', '2026-01-01T00:00:05Z', 'opus', 40, {}, true), // وكيل فرعي داخل النافذة
    req('r-late', '2026-01-01T00:00:30Z', 'opus', 7), // خارج النافذة → احتياطي
  ];
  const windows: TurnMetricWindow[] = [
    { assistantMessageId: 'final-A', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:10Z' },
  ];
  const turns = buildSessionTurns(requests, windows, [], priceStub);

  assert.equal(turns.length, 2);
  const windowed = turns[0];
  assert.equal(windowed.assistantMessageId, 'final-A');
  assert.equal(windowed.requests, 2);
  assert.equal(windowed.tokens.output, 140);
  assert.equal(windowed.startedAt, '2026-01-01T00:00:00Z');
  assert.equal(windowed.completedAt, '2026-01-01T00:00:10Z');
  assert.equal(windowed.costUsd, 140 * 0.01);
  // الطلب خارج النافذة صار دوراً احتياطياً مفتاحه uuid آخر طلب في مقطعه.
  assert.equal(turns[1].assistantMessageId, 'r-late');
  assert.equal(turns[1].requests, 1);
});

test('بلا نوافذ: تُقطَّع الطلبات إلى أدوار بحدود المستخدم، ومفتاح كل دور آخر طلب فيه', () => {
  const b1 = Date.parse('2026-01-01T00:00:00Z');
  const b2 = Date.parse('2026-01-01T00:10:00Z');
  const requests = [
    req('a1', '2026-01-01T00:00:05Z', 'opus', 10),
    req('a2', '2026-01-01T00:00:09Z', 'opus', 20), // آخر طلب في المقطع الأول
    req('c1', '2026-01-01T00:10:30Z', 'opus', 30), // المقطع الثاني
  ];
  const turns = buildSessionTurns(requests, [], [b1, b2], priceStub);

  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.assistantMessageId), ['a2', 'c1']);
  assert.equal(turns[0].requests, 2);
  assert.equal(turns[0].tokens.output, 30);
  assert.equal(turns[0].startedAt, '2026-01-01T00:00:05.000Z');
  assert.equal(turns[0].completedAt, '2026-01-01T00:00:09.000Z');
  assert.equal(turns[1].requests, 1);
});

test('الثابت المحوري: مجموع توكنات الأدوار = إجماليات perModel، ومجموع الكلف = الأرضية المسعّرة', () => {
  const requests = [
    req('a1', '2026-01-01T00:00:05Z', 'opus', 10, { input: 5, cacheRead: 100 }),
    req('a2', '2026-01-01T00:00:09Z', 'free', 20, { cacheWrite5m: 8 }), // نموذج بلا سعر
    req('b1', '2026-01-01T00:10:30Z', 'opus', 30, { input: 3 }),
    req('sub', '2026-01-01T00:10:31Z', 'sonnet', 40, {}, true),
  ];
  const boundaries = [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:10:00Z')];
  const turns = buildSessionTurns(requests, [], boundaries, priceStub);

  // مجموع التوكنات عبر كل الأدوار = مجموعها عبر كل الطلبات (كل طلب في دور واحد).
  const sumField = (field: keyof RequestUsageRecord['totals']) =>
    turns.reduce((total, turn) => total + turn.tokens[field], 0);
  assert.equal(sumField('output'), sumOutput(requests));
  assert.equal(sumField('input'), 8);
  assert.equal(sumField('cacheRead'), 100);
  assert.equal(sumField('cacheWrite5m'), 8);

  // عدد الطلبات محفوظ.
  assert.equal(turns.reduce((total, turn) => total + turn.requests, 0), requests.length);

  // مجموع كلف الأدوار = مجموع كلف الطلبات المسعّرة فقط (opus + sonnet، لا free).
  const pricedOutput = requests.filter((r) => r.model !== 'free').reduce((t, r) => t + r.totals.output, 0);
  const sumCost = turns.reduce((total, turn) => total + (turn.costUsd ?? 0), 0);
  assert.ok(Math.abs(sumCost - pricedOutput * 0.01) < 1e-9);
});

test('costUsd أرضيةٌ: null فقط حين كل نماذج الدور بلا سعر، وإلا مجموع المسعّر منها', () => {
  const boundaries = [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:10:00Z')];
  const turns = buildSessionTurns(
    [
      req('free-only', '2026-01-01T00:00:05Z', 'free', 50), // دور كله بلا سعر
      req('mixed-free', '2026-01-01T00:10:05Z', 'free', 20),
      req('mixed-paid', '2026-01-01T00:10:06Z', 'opus', 30), // دور مختلط
    ],
    [],
    boundaries,
    priceStub,
  );

  const byKey = new Map(turns.map((turn) => [turn.assistantMessageId, turn]));
  assert.equal(byKey.get('free-only')?.costUsd, null);
  // الدور المختلط: تُتجاهَل توكنات free ويُحسَب opus وحده (أرضية، لا null).
  assert.equal(byKey.get('mixed-paid')?.costUsd, 30 * 0.01);
});

test('الترتيب زمني بطابع البداية، والمدخل الفارغ يعيد قائمة فارغة', () => {
  assert.deepEqual(buildSessionTurns([], [], [], priceStub), []);
  const turns = buildSessionTurns(
    [
      req('late', '2026-01-01T05:00:00Z', 'opus', 10),
      req('early', '2026-01-01T01:00:00Z', 'opus', 10),
    ],
    [],
    [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T03:00:00Z')],
    priceStub,
  );
  assert.deepEqual(turns.map((turn) => turn.assistantMessageId), ['early', 'late']);
});

test('أوبوس: النافذة تُطابَق بالمعرّف حين يسبق كامل الطلب بدايتها، وتُمدّ البداية للتفكير (B-1024)', () => {
  // الجلسة الشاهدة: نافذة المقياس مفتاحها uuid صف النصّ، لكنها تبدأ 16:02:54.683
  // بعد صف النصّ (16:02:54.653) بـ30ms وبعد صف التفكير (16:02:50.614) بثوانٍ،
  // فلا يلتقطها احتواءٌ زمني. المطابقة بالمعرّف تحلّها، وأبكر طابع يمدّ البداية.
  const finalUuid = 'f37a3c3b-3d2c-4251-9fc1-6362e05826b1';
  const request: RequestUsageRecord = {
    uuid: finalUuid,
    model: 'opus',
    timestampMs: Date.parse('2026-09-10T16:02:54.653Z'),
    firstTimestampMs: Date.parse('2026-09-10T16:02:50.614Z'),
    isSubagent: false,
    totals: { input: 6, output: 348, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 50 },
  };
  const windows: TurnMetricWindow[] = [
    { assistantMessageId: finalUuid, startedAt: '2026-09-10T16:02:54.683Z', completedAt: '2026-09-10T16:02:55.310Z' },
  ];
  const turns = buildSessionTurns([request], windows, [], priceStub);

  assert.equal(turns.length, 1);
  const [turn] = turns;
  // مسار النافذة، لا الاحتياطي: المفتاح = uuid صف النصّ (تجده الواجهة).
  assert.equal(turn.assistantMessageId, finalUuid);
  assert.equal(turn.requests, 1);
  assert.equal(turn.tokens.output, 348);
  // البداية مُدّت إلى صف التفكير؛ النهاية من النافذة المقيسة.
  assert.equal(turn.startedAt, '2026-09-10T16:02:50.614Z');
  assert.equal(turn.completedAt, '2026-09-10T16:02:55.310Z');
});

test('الطلب الوسطي يبقى يُطابَق بالاحتواء الزمني ولا يمدّ صفٌّ لاحقٌ البدايةَ فوق النافذة', () => {
  // طلب نهائي (uuid=النافذة) + طلب وسطي (حلقة أداة) يقع داخل النافذة زمنياً.
  const finalUuid = 'final-B';
  const requests: RequestUsageRecord[] = [
    // وسطي داخل النافذة، طابعه بعد بدايتها → لا يمدّ البداية.
    { uuid: 'tool-1', model: 'opus', timestampMs: Date.parse('2026-01-02T00:00:05Z'),
      firstTimestampMs: Date.parse('2026-01-02T00:00:05Z'), isSubagent: false,
      totals: { input: 0, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } },
    { uuid: finalUuid, model: 'opus', timestampMs: Date.parse('2026-01-02T00:00:08Z'),
      firstTimestampMs: Date.parse('2026-01-02T00:00:08Z'), isSubagent: false,
      totals: { input: 0, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } },
  ];
  const windows: TurnMetricWindow[] = [
    { assistantMessageId: finalUuid, startedAt: '2026-01-02T00:00:00Z', completedAt: '2026-01-02T00:00:10Z' },
  ];
  const turns = buildSessionTurns(requests, windows, [], priceStub);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].requests, 2);
  assert.equal(turns[0].tokens.output, 70);
  assert.equal(turns[0].startedAt, '2026-01-02T00:00:00Z', 'لا تُمدّ البداية إذ لا صفّ يسبق النافذة');
  assert.equal(turns[0].completedAt, '2026-01-02T00:00:10Z');
});
