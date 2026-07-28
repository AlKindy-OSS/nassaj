/**
 * اختبارات المُستخرِجات المبنيّة على قواعد SQLite.
 *
 * **الـfixtures هنا ليست مخترَعة**: جُملة `CREATE TABLE` منسوخة حرفياً من
 * `sqlite_master` في القاعدتين الحيّتين على هذا الجهاز
 * (‏`~/.local/share/opencode/opencode.db` و`~/.hermes/state.db`، 2026-07-28)،
 * والصفوف المُدرَجة صفوف حقيقية بقيمها كما هي — بما فيها `cost = 0` المضلّل،
 * ونموذج `opencode/big-pickle` الذي لا سعر رسمي له. الدرس مدفوع الثمن في هذا
 * المستودع: اختبار أخضر على fixture مصطنع لا يقول شيئاً عن الإنتاج.
 *
 * وما أُنشئ منها إنشاءً — جلسةٌ ابنة (‏`parent_id`) وصفّ Hermes بتوكنز تفكير
 * غير صفرية — مُعلَّم في موضعه: البنية حقيقية والقيمة مبنيّة، لأن هذا الجهاز
 * لا يحمل نظيرها بعد ولا يجوز أن تبقى القاعدة بلا اختبار.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  collectHermesCycleUsage,
  collectOpenCodeCycleUsage,
  databaseSignature,
  extractOpenCodeSessionUsage,
} from '@/modules/providers/services/cost/db-usage-extractors.js';

// ---------------------------------------------------------------------------
// المخطّطات — منسوخة حرفياً من القاعدتين الحيّتين
// ---------------------------------------------------------------------------

/** ‏`select sql from sqlite_master where name='session'` على opencode.db. */
const OPENCODE_SESSION_DDL = `CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer
        )`;

/** ‏`select sql from sqlite_master where name='message'` على opencode.db. */
const OPENCODE_MESSAGE_DDL = `CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL
        )`;

/** ‏`select sql from sqlite_master where name='sessions'` على state.db. */
const HERMES_SESSIONS_DDL = `CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    cwd TEXT,
    billing_provider TEXT,
    billing_base_url TEXT,
    billing_mode TEXT,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,
    cost_source TEXT,
    pricing_version TEXT,
    title TEXT,
    api_call_count INTEGER DEFAULT 0,
    handoff_state TEXT,
    handoff_platform TEXT,
    handoff_error TEXT,
    rewind_count INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
)`;

// ---------------------------------------------------------------------------
// صفوف حقيقية
// ---------------------------------------------------------------------------

const GLM_SESSION = 'ses_059f6304fffeBsp1wSskPj95ec';
const PICKLE_SESSION = 'ses_05a433ab2ffe89MCUXGwH31mT9';

/** ‏[id, parent_id, model, time_created, time_updated] — كما في القاعدة الحيّة. */
const OPENCODE_SESSION_ROWS: [string, string | null, string, number, number][] = [
  [
    GLM_SESSION,
    null,
    '{"id":"glm-5.2","providerID":"glm","variant":"default"}',
    1785197088688,
    1785197178159,
  ],
  [
    PICKLE_SESSION,
    null,
    '{"id":"big-pickle","providerID":"opencode","variant":"default"}',
    1785192039757,
    1785193205528,
  ],
];

/** ‏[id, session_id, time_created, data] — نصّ `data` حرفيّ من القاعدة الحيّة. */
const OPENCODE_MESSAGE_ROWS: [string, string, number, string][] = [
  [
    'msg_fa609cfd00018YpWTsfabfTzFO',
    GLM_SESSION,
    1785197088720,
    '{"role":"user","time":{"created":1785197088720},"agent":"build","model":{"providerID":"glm","modelID":"glm-5.2"},"summary":{"diffs":[]}}',
  ],
  [
    'msg_fa609d099001L1opsXkDR1axF0',
    GLM_SESSION,
    1785197088921,
    '{"parentID":"msg_fa609cfd00018YpWTsfabfTzFO","role":"assistant","cost":0,"tokens":{"total":14551,"input":7086,"output":128,"reasoning":553,"cache":{"write":0,"read":6784}},"modelID":"glm-5.2","providerID":"glm","time":{"created":1785197088921,"completed":1785197099657},"finish":"tool-calls"}',
  ],
  [
    'msg_fa609fa97001FL8XY8oBAzj04Y',
    GLM_SESSION,
    1785197099671,
    '{"parentID":"msg_fa609cfd00018YpWTsfabfTzFO","role":"assistant","cost":0,"tokens":{"total":16815,"input":2775,"output":186,"reasoning":30,"cache":{"write":0,"read":13824}},"modelID":"glm-5.2","providerID":"glm","time":{"created":1785197099671,"completed":1785197103905},"finish":"tool-calls"}',
  ],
  [
    'msg_fa60a0b230010rIlMAKg6aDPS6',
    GLM_SESSION,
    1785197103907,
    '{"parentID":"msg_fa609cfd00018YpWTsfabfTzFO","role":"assistant","cost":0,"tokens":{"total":35706,"input":18498,"output":293,"reasoning":339,"cache":{"write":0,"read":16576}},"modelID":"glm-5.2","providerID":"glm","time":{"created":1785197103907,"completed":1785197115070},"finish":"tool-calls"}',
  ],
  [
    'msg_fa60a36c0001EaSoLMseEzVYUO',
    GLM_SESSION,
    1785197115072,
    '{"parentID":"msg_fa609cfd00018YpWTsfabfTzFO","role":"assistant","cost":0,"tokens":{"total":45769,"input":9361,"output":593,"reasoning":743,"cache":{"write":0,"read":35072}},"modelID":"glm-5.2","providerID":"glm","time":{"created":1785197115072,"completed":1785197141883},"finish":"tool-calls"}',
  ],
  [
    'msg_fa60a9f7e001yiZJrLBy3BwyDo',
    GLM_SESSION,
    1785197141886,
    '{"parentID":"msg_fa609cfd00018YpWTsfabfTzFO","role":"assistant","cost":0,"tokens":{"total":48616,"input":2710,"output":528,"reasoning":962,"cache":{"write":0,"read":44416}},"modelID":"glm-5.2","providerID":"glm","time":{"created":1785197141886,"completed":1785197161219},"finish":"tool-calls"}',
  ],
  [
    'msg_fa60aeb06001WvHooydvKNk6Qa',
    GLM_SESSION,
    1785197161222,
    '{"parentID":"msg_fa609cfd00018YpWTsfabfTzFO","role":"assistant","cost":0,"tokens":{"total":51602,"input":3373,"output":103,"reasoning":1022,"cache":{"write":0,"read":47104}},"modelID":"glm-5.2","providerID":"glm","time":{"created":1785197161222,"completed":1785197178155},"finish":"tool-calls"}',
  ],
  [
    'msg_fa5bcc642001800N2EseGRsUnH',
    PICKLE_SESSION,
    1785192040002,
    '{"parentID":"msg_fa5bcc575001vk5wL9XlQVOhBB","role":"assistant","cost":0,"tokens":{"total":14605,"input":210,"output":16,"reasoning":43,"cache":{"write":0,"read":14336}},"modelID":"big-pickle","providerID":"opencode","time":{"created":1785192040002,"completed":1785192043794},"finish":"stop"}',
  ],
];

/** مجاميع الجلسة الحقيقية كما يحفظها opencode نفسه في أعمدة `session`. */
const GLM_VENDOR_TOTALS = { input: 43803, output: 1831, reasoning: 3649, cacheRead: 163776 };

/** الأسعار الرسمية لـ‏glm-5.2 من `model-pricing` (دولار لكل مليون). */
const GLM_PRICE = { input: 1.4, output: 4.4, cacheRead: 0.26 };

// ---------------------------------------------------------------------------
// بناء قواعد الاختبار
// ---------------------------------------------------------------------------

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'db-usage-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type ExtraSession = [string, string | null, string, number, number];
type ExtraMessage = [string, string, number, string];

function buildOpenCodeDatabase(
  file: string,
  extraSessions: ExtraSession[] = [],
  extraMessages: ExtraMessage[] = [],
): void {
  const db = new Database(file);
  db.exec(OPENCODE_SESSION_DDL);
  db.exec(OPENCODE_MESSAGE_DDL);

  const insertSession = db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, model, time_created, time_updated)
     VALUES (?, 'p1', ?, 'slug', '/tmp', 'title', '1.17.18', ?, ?, ?)`,
  );
  for (const row of [...OPENCODE_SESSION_ROWS, ...extraSessions]) {
    insertSession.run(row[0], row[1], row[2], row[3], row[4]);
  }

  const insertMessage = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of [...OPENCODE_MESSAGE_ROWS, ...extraMessages]) {
    insertMessage.run(row[0], row[1], row[2], row[2], row[3]);
  }

  db.close();
}

type HermesRow = {
  id: string;
  model: string | null;
  startedAt: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

/** صفوف Hermes الحقيقية (بقيمها كما هي، وكلها `reasoning_tokens = 0`). */
const HERMES_ROWS: HermesRow[] = [
  {
    id: '20260624_193817_89d4c2',
    model: 'stepfun/step-3.7-flash:free',
    startedAt: 1782319098.5122657,
    input: 13880,
    output: 28,
    cacheRead: 2688,
    cacheWrite: 0,
    reasoning: 0,
  },
  {
    id: '20260625_125816_50fe7e',
    model: 'stepfun/step-3.7-flash:free',
    startedAt: 1782381497.7637446,
    input: 15668,
    output: 38,
    cacheRead: 896,
    cacheWrite: 0,
    reasoning: 0,
  },
  {
    id: '20260627_123406_4750ef',
    model: 'nous/glm-5.2',
    startedAt: 1782552848.306589,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  },
];

function buildHermesDatabase(file: string, extraRows: HermesRow[] = []): void {
  const db = new Database(file);
  db.exec(HERMES_SESSIONS_DDL);
  const insert = db.prepare(
    `INSERT INTO sessions (id, source, model, started_at, input_tokens, output_tokens,
                           cache_read_tokens, cache_write_tokens, reasoning_tokens)
     VALUES (?, 'cli', ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of [...HERMES_ROWS, ...extraRows]) {
    insert.run(row.id, row.model, row.startedAt, row.input, row.output, row.cacheRead, row.cacheWrite, row.reasoning);
  }
  db.close();
}

const modelOf = (usage: { perModel: { model: string }[] }, model: string) =>
  usage.perModel.find((entry) => entry.model === model);

// ---------------------------------------------------------------------------
// opencode — المحادثة المفردة
// ---------------------------------------------------------------------------

test('محادثة opencode: المجاميع تطابق أعمدة المزوّد نفسه، والتفكير مخرجات', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'opencode.db');
    buildOpenCodeDatabase(file);

    const outcome = extractOpenCodeSessionUsage(file, GLM_SESSION);
    assert.equal(outcome.available, true);
    assert.ok(outcome.available);

    assert.equal(outcome.usage.provider, 'opencode');
    assert.equal(outcome.usage.perModel.length, 1);
    const [entry] = outcome.usage.perModel;

    // الحامل يُسمّي النموذج الأصلي لا «opencode».
    assert.equal(entry.model, 'glm/glm-5.2');
    assert.equal(entry.requests, 6, 'ستّ رسائل مساعد؛ رسالة المستخدم ليست طلباً');

    // الشاهد الأقوى: مجموعنا من الرسائل = العدّادات التي كتبها opencode للجلسة.
    assert.equal(entry.totals.input, GLM_VENDOR_TOTALS.input);
    assert.equal(entry.totals.cacheRead, GLM_VENDOR_TOTALS.cacheRead);
    assert.equal(
      entry.totals.output,
      GLM_VENDOR_TOTALS.output + GLM_VENDOR_TOTALS.reasoning,
      'التفكير بندٌ مستقلّ لدى opencode ⇒ يُحاسَب مخرجاتٍ',
    );
    // ‏input لا يشمل المخبّأ هنا (بخلاف كودكس) فلا يُطرح منه شيء.
    assert.ok(entry.totals.input < entry.totals.cacheRead, 'المدخلات أصغر من القراءة ⇒ غير شاملة لها');
    assert.equal(entry.totals.cacheWrite5m, 0);
    assert.equal(entry.totals.cacheWrite1h, 0);
    assert.equal(outcome.usage.subagentRequests, 0);
  });
});

test('نموذج خارج جدول الأسعار يُعرَض باسمه غير مُسعَّر، لا بصفر', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'opencode.db');
    buildOpenCodeDatabase(file);

    const outcome = extractOpenCodeSessionUsage(file, PICKLE_SESSION);
    assert.ok(outcome.available);
    const [entry] = outcome.usage.perModel;
    assert.equal(entry.model, 'opencode/big-pickle');
    assert.equal(entry.totals.input, 210);
    assert.equal(entry.totals.output, 16 + 43);
    assert.equal(entry.totals.cacheRead, 14336);

    // التسعير مسؤولية `cost-calculator`؛ المهمّ هنا أن الاسم يصل إليه كاملاً
    // فيُدرَج في `unpricedModels` بدل أن يُبتلع تحت اسم عامّ.
    const { calculateSessionCost } = await import('@/modules/providers/services/cost/cost-calculator.js');
    const cost = calculateSessionCost(outcome.usage);
    assert.equal(cost.perModel[0].costUsd, null);
    assert.deepEqual(cost.unpricedModels, ['opencode/big-pickle']);
    assert.equal(cost.complete, false);
  });
});

test('‏cost = 0 لدى المزوّد لا يُصدَّق: التوكنز تُسعَّر بجدولنا', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'opencode.db');
    buildOpenCodeDatabase(file);

    // الصفّ الحقيقي يحمل cost = 0 بينما توكنزه بمئات الآلاف — لو أُخذ به
    // لطُبع «0.00$» على محادثة كاملة.
    const db = new Database(file, { readonly: true });
    assert.equal(db.prepare('SELECT cost FROM session WHERE id = ?').get(GLM_SESSION).cost, 0);
    db.close();

    const outcome = extractOpenCodeSessionUsage(file, GLM_SESSION);
    assert.ok(outcome.available);
    const { calculateSessionCost } = await import('@/modules/providers/services/cost/cost-calculator.js');
    const cost = calculateSessionCost(outcome.usage);

    const expected =
      (GLM_VENDOR_TOTALS.input * GLM_PRICE.input +
        (GLM_VENDOR_TOTALS.output + GLM_VENDOR_TOTALS.reasoning) * GLM_PRICE.output +
        GLM_VENDOR_TOTALS.cacheRead * GLM_PRICE.cacheRead) /
      1_000_000;

    assert.ok(Math.abs(cost.totalUsd - expected) < 1e-9, `${cost.totalUsd} ≠ ${expected}`);
    assert.ok(cost.totalUsd > 0, 'محادثة بمئتي ألف توكن ليست مجّانية');
    assert.equal(cost.complete, true);
  });
});

test('النافذة تُرشَّح بطابع كل رسالة لا بتاريخ فتح المحادثة', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'opencode.db');
    buildOpenCodeDatabase(file);

    // من الرسالة الثالثة فصاعداً (الجلسة نفسها فُتحت قبل النافذة).
    const outcome = extractOpenCodeSessionUsage(file, GLM_SESSION, { since: 1785197103907 });
    assert.ok(outcome.available);
    const [entry] = outcome.usage.perModel;
    assert.equal(entry.requests, 4);
    assert.equal(entry.totals.input, 18498 + 9361 + 2710 + 3373);

    // نافذة انتهت قبل أوّل رسالة: لا نموذج ولا صفر مُلفَّق.
    const before = extractOpenCodeSessionUsage(file, GLM_SESSION, { until: 1785197088900 });
    assert.ok(before.available);
    assert.deepEqual(before.usage.perModel, []);
  });
});

test('الجلسة الابنة تُحتسب تحت أمّها وتُعدّ وكيلاً فرعياً', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'opencode.db');
    // البنية حقيقية (عمود `parent_id` في مخطّط opencode)، والصفّ مبنيٌّ هنا:
    // لا جلسة ابنة على هذا الجهاز بعد، والقاعدة لا يجوز أن تبقى بلا اختبار.
    buildOpenCodeDatabase(
      file,
      [['ses_child', GLM_SESSION, '{"id":"glm-5.2","providerID":"glm"}', 1785197150000, 1785197160000]],
      [
        [
          'msg_child_1',
          'ses_child',
          1785197151000,
          '{"role":"assistant","tokens":{"total":300,"input":100,"output":40,"reasoning":10,"cache":{"write":25,"read":125}},"modelID":"glm-5.2","providerID":"glm","time":{"created":1785197151000}}',
        ],
      ],
    );

    const outcome = extractOpenCodeSessionUsage(file, GLM_SESSION);
    assert.ok(outcome.available);
    const entry = modelOf(outcome.usage, 'glm/glm-5.2');
    assert.ok(entry);
    assert.equal(entry.requests, 7, 'ستّ للأمّ وواحدة للابنة');
    assert.equal(entry.totals.input, GLM_VENDOR_TOTALS.input + 100);
    assert.equal(entry.totals.cacheWrite5m, 25, 'لا تقسيم 5د/ساعة في بيانات opencode');
    assert.equal(outcome.usage.subagentRequests, 1);
  });
});

test('محادثة اختفت من قاعدة opencode: سببٌ مكتوب لا استثناء', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'opencode.db');
    buildOpenCodeDatabase(file);

    const outcome = extractOpenCodeSessionUsage(file, 'ses_not_there');
    assert.equal(outcome.available, false);
    assert.ok(!outcome.available && outcome.reason.length > 0);
  });
});

test('قاعدة غائبة أو تالفة: غياب مُعلَن، ولا تُنشأ ولا يُكتب فيها', async () => {
  await withTempDir(async (root) => {
    const missing = path.join(root, 'nope', 'opencode.db');
    const outcome = extractOpenCodeSessionUsage(missing, GLM_SESSION);
    assert.equal(outcome.available, false);
    assert.ok(!outcome.available && /database/i.test(outcome.reason));
    // ‏fileMustExist ⇒ لا ملف جديد على القرص.
    await assert.rejects(() => stat(missing));

    const corrupt = path.join(root, 'corrupt.db');
    await rm(corrupt, { force: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(corrupt, 'this is not a database');
    const corruptOutcome = extractOpenCodeSessionUsage(corrupt, GLM_SESSION);
    assert.equal(corruptOutcome.available, false);
    assert.equal(await readFile(corrupt, 'utf8'), 'this is not a database', 'الملف كما هو');
  });
});

test('القراءة لا تمسّ القاعدة: لا تغيّر في الملف ولا ملفّات WAL جانبية', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'opencode.db');
    buildOpenCodeDatabase(file);

    const before = await stat(file);
    const beforeBytes = await readFile(file);

    extractOpenCodeSessionUsage(file, GLM_SESSION);
    collectOpenCodeCycleUsage(file, { since: 0 });

    const after = await stat(file);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs, 'قراءة فقط ⇒ زمن التعديل ثابت');
    assert.deepEqual(await readFile(file), beforeBytes);
    assert.deepEqual((await readdir(root)).sort(), ['opencode.db'], 'لا -wal ولا -shm من قراءتنا');
  });
});

// ---------------------------------------------------------------------------
// opencode — مسح الدورة
// ---------------------------------------------------------------------------

test('مسح الدورة يجمع الجلسات الجذرية وحدها ويحترم النافذة', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'opencode.db');
    buildOpenCodeDatabase(
      file,
      [['ses_child', GLM_SESSION, '{"id":"glm-5.2","providerID":"glm"}', 1785197150000, 1785197160000]],
      [
        [
          'msg_child_1',
          'ses_child',
          1785197151000,
          '{"role":"assistant","tokens":{"total":300,"input":100,"output":40,"reasoning":10,"cache":{"write":0,"read":150}},"modelID":"glm-5.2","providerID":"glm","time":{"created":1785197151000}}',
        ],
      ],
    );

    const all = collectOpenCodeCycleUsage(file, { since: 0 });
    assert.ok(all.available);
    // جلستان جذريتان لا ثلاث: الابنة محسوبة تحت أمّها فلا تُعدّ مرّتين.
    assert.equal(all.sessions.length, 2);
    const glm = all.sessions.find((usage) => usage.perModel[0]?.model === 'glm/glm-5.2');
    assert.ok(glm);
    assert.equal(glm.perModel[0].totals.input, GLM_VENDOR_TOTALS.input + 100);

    // نافذة تبدأ بعد آخر نشاط لجلسة الـpickle: تسقط هي وحدها.
    const late = collectOpenCodeCycleUsage(file, { since: 1785197000000 });
    assert.ok(late.available);
    assert.equal(late.sessions.length, 1);
    assert.equal(late.sessions[0].perModel[0].model, 'glm/glm-5.2');

    // نافذة بعد كل شيء: لا جلسة، ولا رقم يُلفَّق.
    const empty = collectOpenCodeCycleUsage(file, { since: 1785200000000 });
    assert.ok(empty.available);
    assert.deepEqual(empty.sessions, []);
  });
});

test('قاعدة opencode غائبة تعود «غير متاح» لا مجموعاً صفرياً', async () => {
  await withTempDir(async (root) => {
    const outcome = collectOpenCodeCycleUsage(path.join(root, 'absent.db'), { since: 0 });
    assert.equal(outcome.available, false);
    assert.ok(!outcome.available && outcome.reason.includes('absent.db'));
  });
});

// ---------------------------------------------------------------------------
// Hermes
// ---------------------------------------------------------------------------

test('دورة Hermes: صفوف حقيقية، والنسبة بطابع `started_at` بالثواني', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'state.db');
    buildHermesDatabase(file);

    const all = collectHermesCycleUsage(file, { since: 0 });
    assert.ok(all.available);
    // الصفّ الثالث بلا استهلاك إطلاقاً ⇒ لا يُعدّ محادثةً مساهِمة.
    assert.equal(all.sessions.length, 2);
    const [first] = all.sessions;
    assert.equal(first.provider, 'hermes');
    assert.equal(first.perModel[0].model, 'stepfun/step-3.7-flash:free');
    assert.deepEqual(first.perModel[0].totals, {
      input: 13880,
      output: 28,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 2688,
    });

    // النافذة: `started_at` ثوانٍ عشرية ⇒ تُضرب في ألف قبل المقارنة.
    const secondOnly = collectHermesCycleUsage(file, { since: 1782381497.7 * 1000 });
    assert.ok(secondOnly.available);
    assert.equal(secondOnly.sessions.length, 1);
    assert.equal(secondOnly.sessions[0].perModel[0].totals.input, 15668);

    const none = collectHermesCycleUsage(file, { since: 0, until: 1782319098 * 1000 });
    assert.ok(none.available);
    assert.deepEqual(none.sessions, []);
  });
});

test('تفكير Hermes جزءٌ من مخرجاته فلا يُضاف إليها', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'state.db');
    // القيمة مبنيّة هنا (كل صفوف هذا الجهاز `reasoning_tokens = 0`)، والقاعدة
    // مأخوذة من كود Hermes نفسه: `output_tokens_details.reasoning_tokens`
    // بدلالة OpenAI جزءٌ من `output_tokens`، وتسعير Hermes لا يضيفه.
    buildHermesDatabase(file, [
      {
        id: '20260627_150000_aaaaaa',
        model: 'nous/glm-5.2',
        startedAt: 1782561600,
        input: 1000,
        output: 500,
        cacheRead: 200,
        cacheWrite: 100,
        reasoning: 400,
      },
    ]);

    const outcome = collectHermesCycleUsage(file, { since: 1782561000 * 1000 });
    assert.ok(outcome.available);
    assert.equal(outcome.sessions.length, 1);
    assert.deepEqual(outcome.sessions[0].perModel[0].totals, {
      input: 1000,
      output: 500,
      cacheWrite5m: 100,
      cacheWrite1h: 0,
      cacheRead: 200,
    });

    // وبادئة الحامل تسقط عند المطابقة فيُسعَّر النموذج الأصلي.
    const { calculateSessionCost } = await import('@/modules/providers/services/cost/cost-calculator.js');
    const cost = calculateSessionCost(outcome.sessions[0]);
    assert.equal(cost.perModel[0].model, 'nous/glm-5.2');
    assert.ok((cost.perModel[0].costUsd ?? 0) > 0, 'glm-5.2 مُسعَّر رغم بادئة الحامل');
  });
});

test('قاعدة Hermes غائبة: سببٌ مكتوب لا صفر', async () => {
  await withTempDir(async (root) => {
    const outcome = collectHermesCycleUsage(path.join(root, 'state.db'), { since: 0 });
    assert.equal(outcome.available, false);
    assert.ok(!outcome.available && /Hermes/.test(outcome.reason));
  });
});

// ---------------------------------------------------------------------------
// البصمة
// ---------------------------------------------------------------------------

test('البصمة تشمل ملفّي WAL: كتابة لم تصل القاعدة بعد تُبطل الكاش', async () => {
  await withTempDir(async (root) => {
    const file = path.join(root, 'opencode.db');
    buildOpenCodeDatabase(file);

    const base = await databaseSignature(file);
    assert.ok(base);

    // ‏opencode يعمل بـWAL: يكتب دقائق في `-wal` قبل أن يمسّ القاعدة نفسها،
    // فبصمة الملف وحده كانت ستُجمّد الرقم على قيمة قديمة.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${file}-wal`, Buffer.alloc(4096));
    const withWal = await databaseSignature(file);
    assert.ok(withWal);
    assert.equal(withWal.size, base.size + 4096);

    assert.equal(await databaseSignature(path.join(root, 'absent.db')), null);
  });
});
