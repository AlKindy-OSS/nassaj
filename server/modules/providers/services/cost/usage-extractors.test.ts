/**
 * اختبارات المُستخرِج على **بيانات حقيقية**: الـfixtures مقتطعة حرفياً من
 * سجلّات على هذا الجهاز (أسطر assistant كاملة الاستهلاك، حُذف منها نصّ
 * المحتوى فقط). درس مُكلَّف سابق في هذا المستودع: اختبارات خضراء على fixtures
 * مصطنعة لا تُثبت شيئاً عن بيانات الإنتاج.
 *
 * الأرقام المتوقَّعة أدناه محسوبة من الـfixtures نفسها لا مكتوبة تخميناً.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ClaudeUsageAccumulator,
  extractClaudeSessionUsage,
  extractCodexSessionUsage,
} from '@/modules/providers/services/cost/usage-extractors.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const makeSessionDir = async () => mkdtemp(path.join(os.tmpdir(), 'nassaj-cost-'));

test('كلود: التكرار الحقيقي في السجلّ يُنزع، وسطور <synthetic> تُستبعَد', async () => {
  const dir = await makeSessionDir();
  const transcript = path.join(dir, 'sess.jsonl');
  await copyFile(path.join(FIXTURES, 'claude-parent.jsonl'), transcript);

  const usage = await extractClaudeSessionUsage(transcript);

  assert.equal(usage.perModel.length, 1);
  const [entry] = usage.perModel;
  assert.equal(entry.model, 'claude-opus-5');
  // الـfixture ستة أسطر: طلبان فريدان (3 نسخ + نسختان) وسطر <synthetic> واحد.
  assert.equal(entry.requests, 2);
  assert.equal(usage.skipped.duplicates, 3);
  assert.equal(usage.skipped.synthetic, 1);
  assert.deepEqual(entry.totals, {
    input: 4,
    output: 1061,
    cacheWrite5m: 0,
    cacheWrite1h: 48985,
    cacheRead: 48140,
  });
});

test('الجمع الساذج (بلا نزع تكرار) كان يضخّم المخرجات — نُثبت الفارق', async () => {
  const dir = await makeSessionDir();
  const transcript = path.join(dir, 'sess.jsonl');
  await copyFile(path.join(FIXTURES, 'claude-parent.jsonl'), transcript);

  const usage = await extractClaudeSessionUsage(transcript);
  const deduped = usage.perModel[0].totals.output;

  // ما كان ينتجه الجمع الساذج على نفس الأسطر الحقيقية.
  const naive = 172 + 172 + 172 + 889 + 889;
  assert.equal(naive, 2294);
  assert.equal(deduped, 1061);
  assert.ok(naive / deduped > 2, 'التضخيم الحقيقي المقيس يتجاوز الضعف');
});

test('كلود: استهلاك الوكلاء الفرعيين يدخل الحساب بنموذجه المستقل', async () => {
  const dir = await makeSessionDir();
  const transcript = path.join(dir, 'sess.jsonl');
  await copyFile(path.join(FIXTURES, 'claude-parent.jsonl'), transcript);
  // الوكلاء الفرعيون في مجلّد بجانب الملف يحمل اسم الجلسة (بلا اللاحقة).
  await mkdir(path.join(dir, 'sess', 'subagents'), { recursive: true });
  await copyFile(
    path.join(FIXTURES, 'claude-subagent.jsonl'),
    path.join(dir, 'sess', 'subagents', 'agent-a42e68ee5814334bd.jsonl'),
  );

  const usage = await extractClaudeSessionUsage(transcript);
  const models = usage.perModel.map((entry) => entry.model).sort();
  assert.deepEqual(models, ['claude-opus-4-8', 'claude-opus-5']);

  const subagent = usage.perModel.find((entry) => entry.model === 'claude-opus-4-8');
  assert.ok(subagent);
  assert.equal(subagent.requests, 1); // أربعة أسطر حقيقية = طلب واحد مكرَّر
  assert.deepEqual(subagent.totals, {
    input: 3719,
    // الأسطر الأربعة الحقيقية: 7، 7، 7، 1061 — الأخير هو الردّ الكامل.
    output: 1061,
    cacheWrite5m: 19137,
    cacheWrite1h: 0,
    cacheRead: 9109,
  });
  assert.equal(usage.subagentRequests, 1);
});

test('غياب مجلّد الوكلاء ليس خطأً — محادثة بلا وكلاء تُقرأ كما هي', async () => {
  const dir = await makeSessionDir();
  const transcript = path.join(dir, 'sess.jsonl');
  await copyFile(path.join(FIXTURES, 'claude-parent.jsonl'), transcript);

  const usage = await extractClaudeSessionUsage(transcript);
  assert.equal(usage.subagentRequests, 0);
  assert.equal(usage.perModel.length, 1);
});

test('ملف مفقود بالكامل يُرجع صفراً لا يرمي', async () => {
  const dir = await makeSessionDir();
  const usage = await extractClaudeSessionUsage(path.join(dir, 'ghost.jsonl'));
  assert.deepEqual(usage.perModel, []);
});

test('سطر مقطوع في نهاية ملف قيد الكتابة لا يُسقط بقيّة الملف', async () => {
  const dir = await makeSessionDir();
  const transcript = path.join(dir, 'sess.jsonl');
  await copyFile(path.join(FIXTURES, 'claude-parent.jsonl'), transcript);
  await writeFile(transcript, '{"type":"assistant","message":{"id":"m', { flag: 'a' });

  const usage = await extractClaudeSessionUsage(transcript);
  assert.equal(usage.perModel[0].requests, 2);
});

test('المخرجات = أكبر سطر في المجموعة لا أوّلها (النمط الحقيقي [5,5,5,535])', () => {
  // مقيس على 4344 مجموعة مكرَّرة: output وحده يتفاوت، والأخير يحمل الكامل
  // دائماً. أخذ الأوّل يبخس أغلى بنود الفاتورة 2.34×.
  const accumulator = new ClaudeUsageAccumulator();
  for (const output of [5, 5, 5, 535]) {
    accumulator.addEntry({
      type: 'assistant',
      requestId: 'req_same',
      message: {
        id: 'msg_same',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 12,
          output_tokens: output,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 40,
          cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 },
        },
      },
    });
  }

  const [entry] = accumulator.result().perModel;
  assert.equal(entry.requests, 1);
  assert.equal(entry.totals.output, 535);
  // الحقول المدخلة تُحتسب مرّة واحدة رغم تكرار الأسطر أربعاً.
  assert.equal(entry.totals.input, 12);
  assert.equal(entry.totals.cacheRead, 900);
  assert.equal(entry.totals.cacheWrite5m, 40);
});

test('سطر بلا مُعرِّفات لا يُنزع تكراره ولا يُفقد', () => {
  const accumulator = new ClaudeUsageAccumulator();
  for (let index = 0; index < 2; index += 1) {
    accumulator.addEntry({
      type: 'assistant',
      message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 7 } },
    });
  }

  const [entry] = accumulator.result().perModel;
  assert.equal(entry.requests, 2);
  assert.equal(entry.totals.output, 14);
});

test('غياب تفصيل عمر المخبّأ يُحمَل على 5 دقائق لا على الساعة الأغلى', () => {
  const accumulator = new ClaudeUsageAccumulator();
  accumulator.addEntry({
    type: 'assistant',
    requestId: 'req_legacy',
    message: {
      id: 'msg_legacy',
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 900 },
    },
  });

  const [entry] = accumulator.result().perModel;
  assert.equal(entry.totals.cacheWrite5m, 900);
  assert.equal(entry.totals.cacheWrite1h, 0);
});

test('كودكس: يُؤخذ آخر عدّاد تراكمي لا مجموع الأحداث', async () => {
  const dir = await makeSessionDir();
  const rollout = path.join(dir, 'rollout.jsonl');
  await copyFile(path.join(FIXTURES, 'codex-rollout.jsonl'), rollout);

  const usage = await extractCodexSessionUsage(rollout);
  assert.equal(usage.perModel.length, 1);
  const [entry] = usage.perModel;
  assert.equal(entry.model, 'gpt-5.6-sol');

  // آخر حدث حقيقي: input=65710 منه cached=46336، output=671.
  // دلالة OpenAI: input شامل للمخبّأ ⇒ المحاسَب بالسعر الكامل هو الفرق.
  assert.equal(entry.totals.input, 65710 - 46336);
  assert.equal(entry.totals.cacheRead, 46336);
  assert.equal(entry.totals.output, 671);
  // الجمع عبر الأحداث كان سيعطي مدخلات أكبر من الإجمالي الحقيقي.
  assert.ok(entry.totals.input + entry.totals.cacheRead === 65710);
});

test('النافذة الشهرية ترشّح برسائل المحادثة لا بتاريخ فتحها', async () => {
  const dir = await makeSessionDir();
  const transcript = path.join(dir, 'sess.jsonl');
  await copyFile(path.join(FIXTURES, 'claude-parent.jsonl'), transcript);

  // الـfixture الحقيقي كلّه في 2026-07-28.
  const july = await extractClaudeSessionUsage(transcript, {
    since: Date.parse('2026-07-01T00:00:00Z'),
    until: Date.parse('2026-08-01T00:00:00Z'),
  });
  assert.equal(july.perModel[0].totals.output, 1061);

  // نافذة شهر سابق على نفس المحادثة ⇒ لا شيء يُنسَب إليها.
  const june = await extractClaudeSessionUsage(transcript, {
    since: Date.parse('2026-06-01T00:00:00Z'),
    until: Date.parse('2026-07-01T00:00:00Z'),
  });
  assert.deepEqual(june.perModel, []);
});

test('كودكس: حصّة النافذة طرحٌ من العدّاد التراكمي لا ترشيح', async () => {
  const dir = await makeSessionDir();
  const rollout = path.join(dir, 'rollout.jsonl');
  const line = (timestamp: string, input: number, cached: number, output: number) =>
    `${JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
          },
        },
      },
    })}\n`;

  await writeFile(
    rollout,
    `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } })}\n` +
      line('2026-06-20T10:00:00Z', 10_000, 2_000, 500) +
      line('2026-07-05T10:00:00Z', 30_000, 8_000, 1_500),
  );

  const july = await extractCodexSessionUsage(rollout, {
    since: Date.parse('2026-07-01T00:00:00Z'),
    until: Date.parse('2026-08-01T00:00:00Z'),
  });

  // الفرق بين العدّادين: مدخلات 20,000 منها 6,000 مخبّأة، ومخرجات 1,000.
  // بلا الطرح كان يوليو سيرث استهلاك يونيو كلّه.
  assert.equal(july.perModel[0].totals.input, 14_000);
  assert.equal(july.perModel[0].totals.cacheRead, 6_000);
  assert.equal(july.perModel[0].totals.output, 1_000);
});

test('كودكس بلا أي عدّاد يُرجع فراغاً لا صفراً ملفَّقاً', async () => {
  const dir = await makeSessionDir();
  const rollout = path.join(dir, 'empty.jsonl');
  await writeFile(rollout, '{"type":"turn_context","payload":{"model":"gpt-5.6-sol"}}\n');

  const usage = await extractCodexSessionUsage(rollout);
  assert.deepEqual(usage.perModel, []);
});
