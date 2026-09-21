/**
 * حارس انحدار للعيب المُبلَّغ (B-1021): «الشارة تعرض كلفة آخر ردّ فقط بدل
 * الكلفة التراكمية». يعيد إنتاج محادثة متعدّدة الأدوار على شكل سجلّ Claude
 * الحقيقي (بثّ مكرَّر، حلقة أداة، رسالة وكيل فرعي، سطر مصطنع) ويثبت:
 *
 *  1. `extractClaudeSessionUsage` يعيد **الإجمالي التراكمي** لكل الأدوار — لو
 *     عاد إلى «آخر ردّ فقط» لسقط الاختبار (المخرجات والطلبات أقلّ بكثير).
 *  2. مجموع توكنات `turns` = إجماليات `perModel` بالضبط (مطلب المنسّق).
 *  3. حدود الأدوار = رسائل المستخدم البشرية وحدها؛ نتيجة الأداة ومطالبة الوكيل
 *     الفرعي (origin=coordinator) ليست حدوداً.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSessionTurns } from './session-turns.js';
import { extractClaudeSessionUsage, type ModelUsage } from './usage-extractors.js';

const OPUS = 'claude-opus-4-6';

const assistant = (
  uuid: string,
  timestamp: string,
  messageId: string,
  output: number,
  input: number,
  cacheRead: number,
): string => JSON.stringify({
  type: 'assistant',
  uuid,
  timestamp,
  requestId: `req_${messageId}`,
  message: {
    id: messageId,
    role: 'assistant',
    model: OPUS,
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
    },
  },
});

const humanUser = (uuid: string, timestamp: string, text: string): string => JSON.stringify({
  type: 'user', uuid, timestamp, message: { role: 'user', content: text },
});

const toolResult = (uuid: string, timestamp: string): string => JSON.stringify({
  type: 'user', uuid, timestamp,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
});

const subagentPrompt = (uuid: string, timestamp: string): string => JSON.stringify({
  type: 'user', uuid, timestamp, origin: { kind: 'coordinator' },
  message: { role: 'user', content: 'internal subagent prompt' },
});

// محادثة: دوران بشريّان. الدور 1 ردّ واحد يُبَثّ سطرين (يُنزَع تكراره).
// الدور 2 حلقة أداة: رسالة أداة ثم نتيجتها ثم الردّ النهائي، ومطالبة وكيل فرعي.
const TRANSCRIPT = [
  humanUser('u1', '2026-02-01T00:00:00Z', 'أول سؤال'),
  assistant('a1a', '2026-02-01T00:00:02Z', 'msg_1', 5, 10, 1000),  // بثّ جزئي
  assistant('a1b', '2026-02-01T00:00:03Z', 'msg_1', 50, 10, 1000), // اكتمال البثّ (نفس الطلب)
  humanUser('u2', '2026-02-01T00:05:00Z', 'سؤال ثانٍ'),
  assistant('a2', '2026-02-01T00:05:02Z', 'msg_2', 30, 2, 0),      // رسالة أداة
  toolResult('tr1', '2026-02-01T00:05:03Z'),                        // ليست حدّ دور
  subagentPrompt('sp1', '2026-02-01T00:05:04Z'),                    // ليست حدّ دور
  assistant('a3', '2026-02-01T00:05:06Z', 'msg_3', 40, 3, 500),    // الردّ النهائي
  JSON.stringify({ type: 'assistant', uuid: 'syn', timestamp: '2026-02-01T00:05:07Z',
    message: { id: 'msg_syn', role: 'assistant', model: '<synthetic>', usage: { output_tokens: 999 } } }),
].join('\n') + '\n';

// المتوقَّع تراكمياً (opus): 3 طلبات فريدة، مخرجات 50+30+40=120، مدخلات 15،
// قراءة مخبّأ 1500. لا يشمل المصطنع.
const EXPECTED = { requests: 3, output: 120, input: 15, cacheRead: 1500 };
// «آخر ردّ فقط» لو تسلّل: مخرجات 40 وطلب واحد — القيَم التي يجب أن يرفضها الحارس.

test('التراكمي لا آخر ردّ: extractClaudeSessionUsage يجمع كل الأدوار', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'turns-regress-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, TRANSCRIPT);
    const usage = await extractClaudeSessionUsage(file, undefined, undefined, undefined, { captureRequests: true });

    const opus = usage.perModel.find((model: ModelUsage) => model.model === OPUS);
    assert.ok(opus, 'يجب أن يظهر نموذج opus');
    assert.equal(opus.requests, EXPECTED.requests);
    assert.equal(opus.totals.output, EXPECTED.output);
    assert.equal(opus.totals.input, EXPECTED.input);
    assert.equal(opus.totals.cacheRead, EXPECTED.cacheRead);
    // النموذج المصطنع لا يُسعَّر ولا يُحتسب.
    assert.equal(usage.perModel.some((model: ModelUsage) => model.model === '<synthetic>'), false);

    // حدود الأدوار: المستخدمان البشريّان فقط.
    assert.equal(usage.userBoundariesMs?.length, 2);
    assert.deepEqual(usage.userBoundariesMs, [
      Date.parse('2026-02-01T00:00:00Z'),
      Date.parse('2026-02-01T00:05:00Z'),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('مجموع توكنات turns = إجماليات perModel (بلا صفوف مقياس ⇒ مسار احتياطي)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'turns-sum-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, TRANSCRIPT);
    const usage = await extractClaudeSessionUsage(file, undefined, undefined, undefined, { captureRequests: true });
    const turns = buildSessionTurns(usage.requests ?? [], [], usage.userBoundariesMs ?? []);

    // دوران، مفتاح كلٍّ آخر رسالة مساعد فيه.
    assert.equal(turns.length, 2);
    assert.deepEqual(turns.map((turn) => turn.assistantMessageId), ['a1b', 'a3']);

    const sumField = (field: 'input' | 'output' | 'cacheRead') =>
      turns.reduce((total, turn) => total + turn.tokens[field], 0);
    const opus = usage.perModel.find((model: ModelUsage) => model.model === OPUS)!;
    assert.equal(sumField('output'), opus.totals.output);
    assert.equal(sumField('input'), opus.totals.input);
    assert.equal(sumField('cacheRead'), opus.totals.cacheRead);
    assert.equal(turns.reduce((total, turn) => total + turn.requests, 0), opus.requests);

    // الدور الثاني يضمّ رسالة الأداة والردّ النهائي (طلبان، مخرجات 70).
    assert.equal(turns[1].requests, 2);
    assert.equal(turns[1].tokens.output, 70);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// سطر استهلاك بلا مُعرِّفين ولا uuid ولا طابع: يحتسبه result() في perModel،
// فيجب أن تحتسبه requests() أيضاً (بمفتاح بديل) كي يبقى الثابت غير مشروط.
const DEGENERATE_TRANSCRIPT = [
  humanUser('u1', '2026-04-01T00:00:00Z', 'سؤال'),
  assistant('a1', '2026-04-01T00:00:02Z', 'msg_1', 20, 5, 0),
  // سطر بلا message.id ولا requestId ولا uuid ولا timestamp — يُدفَع لـanonymous.
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: OPUS, usage: { output_tokens: 33 } } }),
].join('\n') + '\n';

test('السطر ناقص المعرّف محتسَبٌ في turns كما في perModel — الثابت غير مشروط', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'turns-degenerate-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, DEGENERATE_TRANSCRIPT);
    const usage = await extractClaudeSessionUsage(file, undefined, undefined, undefined, { captureRequests: true });

    const opus = usage.perModel.find((model: ModelUsage) => model.model === OPUS)!;
    assert.equal(opus.totals.output, 20 + 33); // كلا الطلبين محسوب في perModel
    assert.equal(opus.requests, 2);
    // requests() يشمل السطر المجهول (لا يُسقَط) — نفس عدد ما حسبه result().
    assert.equal((usage.requests ?? []).length, 2);

    const turns = buildSessionTurns(usage.requests ?? [], [], usage.userBoundariesMs ?? []);
    const sumOut = turns.reduce((total, turn) => total + turn.tokens.output, 0);
    const sumReq = turns.reduce((total, turn) => total + turn.requests, 0);
    assert.equal(sumOut, opus.totals.output);
    assert.equal(sumReq, opus.requests);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
