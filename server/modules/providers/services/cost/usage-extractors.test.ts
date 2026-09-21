/**
 * اختبارات المُستخرِج على **بيانات حقيقية**: الـfixtures مقتطعة حرفياً من
 * سجلّات على هذا الجهاز (أسطر assistant كاملة الاستهلاك، حُذف منها نصّ
 * المحتوى فقط). درس مُكلَّف سابق في هذا المستودع: اختبارات خضراء على fixtures
 * مصطنعة لا تُثبت شيئاً عن بيانات الإنتاج.
 *
 * الأرقام المتوقَّعة أدناه محسوبة من الـfixtures نفسها لا مكتوبة تخميناً.
 */

import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, copyFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ClaudeUsageAccumulator,
  extractClaudeSessionUsage,
  extractCodexConversationUsage,
  extractCodexSessionUsage,
} from '@/modules/providers/services/cost/usage-extractors.js';
import {
  resolveCodexLinkedRollouts,
  withTranscriptReadPermit,
} from '@/modules/providers/list/codex/codex-rollout-links.js';

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

test('كودكس: `last_token_usage` ينتج سجلات أدوار قابلة لمطابقة التذييل', async () => {
  const dir = await makeSessionDir();
  const rollout = path.join(dir, 'rollout.jsonl');
  const row = (timestamp: string, id: string, input: number, cached: number, output: number) => [
    JSON.stringify({ timestamp, type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer', id, content: [{ type: 'output_text', text: 'تم' }],
    } }),
    JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
    } } }),
  ].join('\n');
  try {
    await writeFile(rollout, [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      row('2026-09-01T00:00:01.000Z', 'msg-first', 100, 20, 10),
      row('2026-09-01T00:01:01.000Z', 'msg-second', 300, 70, 35),
    ].join('\n'));

    const usage = await extractCodexSessionUsage(
      rollout, undefined, undefined, undefined, undefined, undefined, { captureRequests: true },
    );
    assert.deepEqual(usage.requests?.map((request) => request.uuid), ['msg-first', 'msg-second']);
    assert.deepEqual(usage.requests?.map((request) => request.totals), [
      { input: 80, cacheRead: 20, output: 10, cacheWrite5m: 0, cacheWrite1h: 0 },
      { input: 230, cacheRead: 70, output: 35, cacheWrite5m: 0, cacheWrite1h: 0 },
    ]);
    assert.deepEqual(usage.perModel[0].totals, {
      input: 230, cacheRead: 70, output: 35, cacheWrite5m: 0, cacheWrite1h: 0,
    });
    assert.equal(usage.perModel[0].requests, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('كودكس: عدّاد بين جوابين يُربط بالجواب النهائي التالي لا السابق', async () => {
  const dir = await makeSessionDir();
  const rollout = path.join(dir, 'rollout.jsonl');
  try {
    await writeFile(rollout, [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({ timestamp: '2026-09-02T00:00:01.000Z', type: 'response_item', payload: {
        type: 'message', role: 'assistant', phase: 'final_answer', id: 'msg-previous', content: [{ type: 'output_text', text: 'الأول' }],
      } }),
      JSON.stringify({ timestamp: '2026-09-02T00:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 20, output_tokens: 3 }, last_token_usage: { input_tokens: 20, output_tokens: 3 },
      } } }),
      JSON.stringify({ timestamp: '2026-09-02T00:00:03.000Z', type: 'response_item', payload: {
        type: 'message', role: 'assistant', phase: 'final_answer', id: 'msg-current', content: [{ type: 'output_text', text: 'الثاني' }],
      } }),
    ].join('\n'));
    const usage = await extractCodexSessionUsage(
      rollout, undefined, undefined, undefined, undefined, undefined, { captureRequests: true },
    );
    assert.equal(usage.requests?.[0]?.uuid, 'msg-current');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test('إلغاء قارئ كودكس يصل إلى بوابة القراءة ولا يبدأ stream جديداً', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('test abort', 'AbortError'));
  await assert.rejects(
    extractCodexSessionUsage('/path/that/must/not/be/opened.jsonl', undefined, undefined, controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
});

test('manifest يثبت إحصاء metadata ولا يعلن fresh إذا أضيف spawn قبل التحقق', async () => {
  const dir = await makeSessionDir();
  const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const childId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const root = path.join(dir, `rollout-${rootId}.jsonl`);
  try {
    await writeFile(root, `${JSON.stringify({
      type: 'session_meta', payload: { id: rootId, session_id: rootId, thread_source: 'user' },
    })}\n`);
    const before = await stat(root);
    const manifest = await resolveCodexLinkedRollouts(root, undefined, async () => {
      await appendFile(root, `${JSON.stringify({
        type: 'event_msg',
        payload: { type: 'sub_agent_activity', kind: 'started', agent_thread_id: childId, agent_path: '/root/late' },
      })}\n`);
    });
    assert.equal(manifest.complete, false);
    assert.match(manifest.limitReason ?? '', /changed after metadata/i);
    assert.equal(manifest.files[0].size, before.size, 'البصمة المثبتة من fd لا من stat لاحق');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('root قديم بلا هوية صالحة ومعه روابط لا يمكن اعتباره snapshot مكتملًا', async () => {
  const dir = await makeSessionDir();
  const childId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const root = path.join(dir, 'legacy.jsonl');
  try {
    await writeFile(root, `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'sub_agent_activity', kind: 'started', agent_thread_id: childId, agent_path: '/root/legacy' },
    })}\n`);
    const manifest = await resolveCodexLinkedRollouts(root);
    assert.equal(manifest.complete, false);
    assert.match(manifest.limitReason ?? '', /no valid root identity/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fstat اللاحق يرصد تعديل rollout أثناء تمريرة الاستخدام', async () => {
  const dir = await makeSessionDir();
  const rollout = path.join(dir, 'rollout.jsonl');
  const observation = { unstable: false };
  try {
    await writeFile(rollout, `${JSON.stringify({
      type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } },
    })}\n`);
    await extractCodexSessionUsage(rollout, undefined, undefined, undefined, observation, async () => {
      await appendFile(rollout, `${JSON.stringify({ type: 'event_msg', payload: { type: 'late' } })}\n`);
    });
    assert.equal(observation.unstable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('singleflight المرجعي يبقي القارئ للعميل الباقي ويبدأ محاولة جديدة بعد إلغاء الجميع', async () => {
  const dir = await makeSessionDir();
  const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const root = path.join(dir, `rollout-${rootId}.jsonl`);
  const blockers: Array<{ ready: Promise<void>; release: () => void; done: Promise<void> }> = [];
  const blockers2: typeof blockers = [];
  try {
    await writeFile(root, `${JSON.stringify({
      type: 'session_meta', payload: { id: rootId, session_id: rootId, thread_source: 'user' },
    })}\n`);
    for (let index = 0; index < 4; index += 1) {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const done = withTranscriptReadPermit(undefined, async () => { entered(); await wait; });
      blockers.push({ ready, release, done });
    }
    await Promise.all(blockers.map((blocker) => blocker.ready));

    const first = new AbortController();
    const survivor = new AbortController();
    const firstPromise = resolveCodexLinkedRollouts(root, first.signal);
    const survivorPromise = resolveCodexLinkedRollouts(root, survivor.signal);
    const firstRejected = assert.rejects(firstPromise, (error: unknown) =>
      error instanceof Error && error.name === 'AbortError');
    first.abort();
    await firstRejected;
    blockers.forEach((blocker) => blocker.release());
    assert.equal((await survivorPromise).complete, true, 'إلغاء مرجع واحد لا يلغي المرجع الباقي');
    await Promise.all(blockers.map((blocker) => blocker.done));

    for (let index = 0; index < 4; index += 1) {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const done = withTranscriptReadPermit(undefined, async () => { entered(); await wait; });
      blockers2.push({ ready, release, done });
    }
    await Promise.all(blockers2.map((blocker) => blocker.ready));
    const allA = new AbortController();
    const allB = new AbortController();
    const allAPromise = resolveCodexLinkedRollouts(root, allA.signal);
    const allBPromise = resolveCodexLinkedRollouts(root, allB.signal);
    const allARejected = assert.rejects(allAPromise, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    const allBRejected = assert.rejects(allBPromise, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    allA.abort();
    allB.abort();
    await Promise.all([allARejected, allBRejected]);

    const retry = resolveCodexLinkedRollouts(root);
    blockers2.forEach((blocker) => blocker.release());
    assert.equal((await retry).complete, true, 'الطلب الجديد لا ينضم إلى flight ملغى');
    await Promise.all(blockers2.map((blocker) => blocker.done));
  } finally {
    blockers.forEach((blocker) => blocker.release());
    blockers2.forEach((blocker) => blocker.release());
    await rm(dir, { recursive: true, force: true });
  }
});

test('سقف القراءة العالمي مشترك بين streams كلود وكودكس', async () => {
  const dir = await makeSessionDir();
  const codex = path.join(dir, 'codex.jsonl');
  const claude = path.join(dir, 'claude.jsonl');
  const blockers: Array<{ ready: Promise<void>; release: () => void; done: Promise<void> }> = [];
  let releaseCodex!: () => void;
  let codexAtPostStat!: () => void;
  try {
    await writeFile(codex, `${JSON.stringify({
      type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } },
    })}\n`);
    await writeFile(claude, `${JSON.stringify({
      type: 'assistant', timestamp: '2026-08-17T00:00:00.000Z', requestId: 'r1',
      message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
    })}\n`);
    for (let index = 0; index < 3; index += 1) {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const done = withTranscriptReadPermit(undefined, async () => { entered(); await wait; });
      blockers.push({ ready, release, done });
    }
    await Promise.all(blockers.map((blocker) => blocker.ready));
    const codexReachedPostStat = new Promise<void>((resolve) => { codexAtPostStat = resolve; });
    const codexWait = new Promise<void>((resolve) => { releaseCodex = resolve; });
    const codexRead = extractCodexSessionUsage(
      codex, undefined, undefined, undefined, undefined,
      async () => { codexAtPostStat(); await codexWait; },
    );
    await codexReachedPostStat;
    let claudeSettled = false;
    const claudeRead = extractClaudeSessionUsage(claude).finally(() => { claudeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(claudeSettled, false, 'كلود ينتظر لأن كودكس يشغل الخانة العالمية الرابعة');
    releaseCodex();
    await Promise.all([codexRead, claudeRead]);
    blockers.forEach((blocker) => blocker.release());
    await Promise.all(blockers.map((blocker) => blocker.done));
  } finally {
    releaseCodex?.();
    blockers.forEach((blocker) => blocker.release());
    await rm(dir, { recursive: true, force: true });
  }
});

test('كودكس: لا يسقط الأبناء بعد 128 رابطاً صريحاً', async () => {
  const dir = await makeSessionDir();
  const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const root = path.join(dir, `rollout-root-${rootId}.jsonl`);
  const childId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

  try {
    const rootLines = [JSON.stringify({
      type: 'session_meta',
      payload: { id: rootId, session_id: rootId, thread_source: 'user' },
    })];
    for (let index = 1; index <= 129; index += 1) {
      const id = childId(index);
      rootLines.push(JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity', kind: 'started', agent_thread_id: id, agent_path: `/root/worker-${index}`,
        },
      }));
      await writeFile(
        path.join(dir, `rollout-child-${id}.jsonl`),
        `${JSON.stringify({
          type: 'session_meta',
          payload: {
            id, session_id: rootId, parent_thread_id: rootId, thread_source: 'subagent',
            agent_path: `/root/worker-${index}`, source: { subagent: true },
          },
        })}\n${JSON.stringify({
          type: 'event_msg',
          payload: { type: 'token_count', info: { total_token_usage: { input_tokens: index, output_tokens: 1 } } },
        })}\n`,
      );
    }
    rootLines.push(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } },
    }));
    await writeFile(root, `${rootLines.join('\n')}\n`);

    const usage = await extractCodexConversationUsage(root);
    assert.equal(usage.subagentRequests, 129);
    assert.equal(usage.perModel[0].requests, 130);
    assert.equal(usage.perModel[0].totals.input, 8_386);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('مدة العمل: طوابع محادثة كلود وحدها ليست قياساً لمدة العمل', async () => {
  const dir = await makeSessionDir();
  const transcript = path.join(dir, 'sess.jsonl');

  try {
    await writeFile(
      transcript,
      `${JSON.stringify({ timestamp: '2026-08-17T08:00:00.000Z', type: 'user' })}\n` +
        `${JSON.stringify({
          timestamp: '2026-08-17T08:02:30.000Z',
          type: 'assistant',
          message: { id: 'message-1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
        })}\n`,
    );

    const usage = await extractClaudeSessionUsage(transcript);
    assert.equal(usage.workDurationMs, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('مدة العمل: أحداث كودكس المرتبطة بلا مدة صريحة لا تُقدَّر من طوابعها', async () => {
  const dir = await makeSessionDir();
  const rootId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const childId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const root = path.join(dir, `rollout-root-${rootId}.jsonl`);
  const child = path.join(dir, `rollout-child-${childId}.jsonl`);

  try {
    await writeFile(
      root,
      `${JSON.stringify({ timestamp: '2026-08-17T08:00:00.000Z', type: 'session_meta', payload: { id: rootId, session_id: rootId, thread_source: 'user' } })}\n` +
        `${JSON.stringify({ timestamp: '2026-08-17T08:01:00.000Z', type: 'event_msg', payload: { type: 'sub_agent_activity', kind: 'started', agent_thread_id: childId, agent_path: '/root/worker' } })}\n`,
    );
    await writeFile(
      child,
      `${JSON.stringify({ timestamp: '2026-08-17T08:03:30.000Z', type: 'session_meta', payload: { id: childId, session_id: rootId, parent_thread_id: rootId, thread_source: 'subagent', agent_path: '/root/worker', source: { subagent: true } } })}\n`,
    );

    const usage = await extractCodexConversationUsage(root);
    assert.equal(usage.workDurationMs, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('مدة العمل: تجمع نتائج الأدوات والأبناء المرتبطين مرةً واحدة فقط', async () => {
  const dir = await makeSessionDir();
  const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const childId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const root = path.join(dir, `rollout-root-${rootId}.jsonl`);
  const child = path.join(dir, `rollout-child-${childId}.jsonl`);
  const result = (text: string) => JSON.stringify({
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text }] },
  });

  try {
    await writeFile(
      root,
      `${JSON.stringify({ type: 'session_meta', payload: { id: rootId, session_id: rootId, thread_source: 'user' } })}\n` +
        `${JSON.stringify({
          type: 'event_msg',
          payload: { type: 'sub_agent_activity', kind: 'started', agent_thread_id: childId, agent_path: '/root/worker' },
        })}\n` +
        `${result('{"agentId":"worker-a","totalDurationMs":120}')}` + '\n' +
        // نفس نتيجة الأداة قد يعيدها السجل؛ لا تضاعف زمن العامل.
        `${result('{"agentId":"worker-a","totalDurationMs":120}')}` + '\n' +
        `${result('{"totalDurationMs":30}')}` + '\n',
    );
    await writeFile(
      child,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: childId,
          session_id: rootId,
          parent_thread_id: rootId,
          thread_source: 'subagent',
          source: { subagent: true },
          agent_path: '/root/worker',
        },
      })}\n` +
        // الأب والابن يحملان أحياناً نتيجة العامل ذاتها؛ المعرّف ثابت.
        `${result('{"agentId":"worker-a","totalDurationMs":120}')}` + '\n' +
        `${result('{"agentId":"worker-b","totalDurationMs":250}')}` + '\n',
    );

    const usage = await extractCodexConversationUsage(root);
    assert.equal(usage.workDurationMs, 400);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('أوبوس: مفتاح الدور = uuid صف النصّ لا صف التفكير (B-1024)', () => {
  // نمط أوبوس الحقيقي (الجلسة الشاهدة dce0e476): صفّ thinking بـuuid مستقل ثم
  // صفّ text بـuuid آخر، بنفس message.id وrequestId ونفس usage تماماً. كان
  // نزعُ التكرار «الأكبر مخرَجاً» (متساوٍ هنا) يُبقي uuid التفكير، فيصير مفتاح
  // الدور معرّفاً لا تجده الواجهة (transcriptMessageId = uuid صف النصّ).
  const accumulator = new ClaudeUsageAccumulator(undefined, undefined, true);
  const usage = {
    input_tokens: 6,
    output_tokens: 348,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 0,
  };
  accumulator.addEntry({
    type: 'assistant', uuid: '3d71f0c1-thinking', requestId: 'req_aaaaaaaa',
    timestamp: '2026-09-10T16:02:50.614Z',
    message: { id: 'msg_bbbbbbbb', model: 'claude-opus-5', usage,
      content: [{ type: 'thinking' }] },
  });
  accumulator.addEntry({
    type: 'assistant', uuid: 'f37a3c3b-text', requestId: 'req_aaaaaaaa',
    timestamp: '2026-09-10T16:02:54.653Z',
    message: { id: 'msg_bbbbbbbb', model: 'claude-opus-5', usage,
      content: [{ type: 'text' }] },
  });

  const requests = accumulator.requests();
  assert.equal(requests.length, 1, 'الصفّان يُنزعان إلى طلب واحد');
  const [request] = requests;
  assert.equal(request.uuid, 'f37a3c3b-text', 'المفتاح = uuid صف النصّ النهائي');
  assert.equal(request.timestampMs, Date.parse('2026-09-10T16:02:54.653Z'),
    'الطابع الممثِّل = صف النصّ');
  assert.equal(request.firstTimestampMs, Date.parse('2026-09-10T16:02:50.614Z'),
    'أبكر طابع = صف التفكير، ليمتدّ الدور إلى بداية التفكير');
  assert.equal(request.totals.output, 348, 'المخرجات لا تُضاعَف');
  // المجموع محفوظ: طلب واحد لا اثنان.
  assert.equal(accumulator.result().perModel[0].requests, 1);
});

test('أوبوس: uuid صف النصّ يفوز أياً كان ترتيب ورود الصفّين', () => {
  // شبكة أمان: حتى لو ورد صفّ النصّ أولاً ثم التفكير، المُعرِّف يتبع أحدث طابع
  // زمني (صف النصّ) لا ترتيب التغذية.
  const accumulator = new ClaudeUsageAccumulator(undefined, undefined, true);
  const usage = { input_tokens: 6, output_tokens: 271 };
  accumulator.addEntry({
    type: 'assistant', uuid: 'bb523bd2-text', requestId: 'req_cccccccc',
    timestamp: '2026-09-10T16:05:07.917Z',
    message: { id: 'msg_dddddddd', model: 'claude-opus-5', usage },
  });
  accumulator.addEntry({
    type: 'assistant', uuid: 'c34711d6-thinking', requestId: 'req_cccccccc',
    timestamp: '2026-09-10T16:05:04.069Z',
    message: { id: 'msg_dddddddd', model: 'claude-opus-5', usage },
  });
  const [request] = accumulator.requests();
  assert.equal(request.uuid, 'bb523bd2-text');
  assert.equal(request.firstTimestampMs, Date.parse('2026-09-10T16:05:04.069Z'));
});
