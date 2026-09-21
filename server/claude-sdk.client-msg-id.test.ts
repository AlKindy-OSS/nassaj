/**
 * claude-sdk.client-msg-id.test.ts — T-1295: صدى هوية الجولة.
 *
 * العميل يكتب رسالته في صندوق الصادر **قبل** الإرسال، ويحذفها عند أوّل دليل
 * قبول ويرفعها بطاقةً عند أوّل دليل فشل. والرابط الوحيد بين الحمولة والإدخال هو
 * `clientMsgId` الذي ولّده العميل وأرسله في `options`.
 *
 * لماذا شرطُ صحّة لا تحسين: البديل المرفوض هو ربط الحكم بـ«أحدث إدخال معلَّق
 * لهذه الجلسة». البوابة التي كان يستند إليها ذلك الربط (`isLoading`) قراءةُ
 * إغلاق لا قفل، وهي عالمية لا لكل جلسة، وتُصفَّر بتبديل الجلسة وبإطار
 * `session-status`، ويتجاوزها `/btw` عمداً — فقد يُطابق التخمينُ تشغيلاً غير
 * الذي حكم عليه الخادم، فتُعاد حمولةٌ إلى محادثة ليست لها.
 *
 * ما تُثبّته:
 *   1. ‏`complete` لجولةٍ سليمة يحمل الصدى (⇒ يُحذف الإدخال، فلا بطاقة «نجحت»).
 *   2. ‏`error` الطرفي يحمله (⇒ تُرفع البطاقة — وهذا جوهر حادثة المالك).
 *   3. ‏`session_created` يحمله (⇒ قبولٌ مؤكَّد لمحادثة وُلدت الآن).
 *   4. ‏`conversation_not_found` يحمله — وهو الحكم الوحيد الذي يراه العميل في
 *      مسار الاستئناف المفقود (الجولة الداخلية تبتلع خطأها عمداً).
 *   5. ‏`session_busy` يحمله (رفضٌ قاطع؛ العميل يحذف الإدخال لأن B-518 يردّ
 *      النصّ إلى المُؤلِّف — ولولا الصدى لبقي الإدخال معلَّقاً إلى الأبد).
 *   6. **تدهور رشيق**: بلا `clientMsgId` لا يظهر الحقل في أي حمولة — لا
 *      `undefined` ولا `null` — فالعقد القائم غير منقوص.
 *
 * وليست fixtures مصطنعة: كل اختبار يقود `queryClaudeSDK` الإنتاجية نفسها، ولا
 * يُموَّه إلا Agent SDK.
 *
 * Runner: node:test with --experimental-test-module-mocks (npm run test:server).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock, beforeEach, afterEach } from 'node:test';

type SdkMessage = Record<string, unknown>;
type Payload = Record<string, unknown>;

let scriptedMessages: SdkMessage[] = [];
let scriptedFailure: Error | null = null;
/** يحبس بثّ الجولة الأولى حتى نُطلقه — به وحده تتحقّق مزاحمةٌ فعلية. */
let messageStreamHeld: Promise<void> = Promise.resolve();
let releaseMessageStream: () => void = () => {};

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: () => {
      const messages = scriptedMessages;
      const failure = scriptedFailure;
      const held = messageStreamHeld;
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
          await held;
          if (failure) throw failure;
        },
        interrupt: async () => {},
        supportedCommands: async () => [],
        supportedModels: async () => [],
      };
    },
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

// This suite owns message-correlation behavior, not the independently tested
// server-authoritative resume-profile gate.
mock.module('./services/isolation/resolve-claude-run-profile.js', {
  namedExports: {
    resolveClaudeRunProfileOrThrow: async ({ baseEnv = process.env } = {}) => ({
      env: { ...baseEnv }, effectiveEngine: null, engineHosts: null, pin: {},
    }),
  },
});

const sdk = (await import('./claude-sdk.js')) as unknown as {
  queryClaudeSDK: (command: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
};
const { initializeDatabase } = await import('./modules/database/init-db.js');
const { getConnection } = await import('./modules/database/connection.js');

const PROMPT = 'رسالةٌ يجب ألا تضيع';
const CMID = 'cmid_00000001-0000-4000-8000-000000000001';

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'SESSION_REGISTRY_claude'] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';
let tmpCwd = '';

/**
 * كاتب اختباري بشكل `WebSocketWriter`.
 *
 * ‏`primaryAlive` يُحاكي مقبساً حيّاً: `isSessionRunLive` يعتبر الجولةَ حيّةً
 * بـ`isPrimarySocketAlive()` أو بوجود مرايا — و«شبحٌ بلا مستمع» **ليس** حيّاً
 * عمداً كي لا يقفل مستخدماً خارج الإرسال. فبدون هذه الإشارة لا يقع رفض
 * `session_busy` أصلاً ولا يمكن اختباره.
 */
function makeWs(primaryAlive = false) {
  const sent: Payload[] = [];
  return {
    sent,
    send: (p: Payload) => { sent.push(p); },
    userId: null,
    ws: { readyState: 1 },
    ...(primaryAlive ? { isPrimarySocketAlive: () => true } : {}),
  };
}

const ofKind = (rows: Payload[], kind: string) => rows.filter((p) => p.kind === kind);

let sidCounter = 0;
const nextSid = () => `t1295-session-${++sidCounter}-0000-4000-8000-000000000000`;

/** رسالة SDK تُنتج معرّف جلسة، فيبعث المسارُ `session_created`. */
const initMessage = (sessionId: string): SdkMessage => ({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
});

beforeEach(() => {
  scriptedMessages = [];
  scriptedFailure = null;
  messageStreamHeld = Promise.resolve();
  releaseMessageStream = () => {};
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SESSION_REGISTRY_claude = '1';
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1295-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1295-cwd-'));
});

afterEach(() => {
  releaseMessageStream();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  for (const dir of [tmpConfigDir, tmpCwd]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── 1. الاكتمال ──────────────────────────────────────────────────────────────

test('T-1295: `complete` يحمل clientMsgId فيُحذف الإدخال عند القبول المؤكَّد', async () => {
  const sid = nextSid();
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd, clientMsgId: CMID }, ws);

  const done = ofKind(ws.sent, 'complete');
  assert.equal(done.length, 1);
  assert.equal(done[0].clientMsgId, CMID);
});

test('مدة الجولة: stream delta وحده ليس دليلاً دائماً ولا يعلن قياساً', async () => {
  const sid = nextSid();
  const ws = makeWs();
  scriptedMessages = [
    initMessage(sid),
    { type: 'content_block_delta', delta: { text: 'الرد النهائي' } },
  ];

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd, clientMsgId: CMID }, ws);

  const done = ofKind(ws.sent, 'complete');
  assert.equal(done.length, 1);
  assert.equal(done[0].responseTurnMetric, undefined);
  assert.equal(done[0].responseTurnDurationTotalMs, undefined);
});

test('مدة الجولة: assistant transcript UUID محفوظ يفتح العقد الحي بعد persistence فقط', async () => {
  const sid = nextSid();
  const ws = makeWs();
  await initializeDatabase();
  getConnection().prepare('INSERT OR IGNORE INTO sessions(session_id, provider) VALUES (?, ?)').run(sid, 'claude');
  scriptedMessages = [
    initMessage(sid),
    {
      type: 'assistant', uuid: 'assistant-durable-1', isSidechain: false,
      message: { role: 'assistant', content: [{ type: 'text', text: 'الرد النهائي' }] },
    },
    { type: 'result', subtype: 'success', is_error: false },
  ];

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd, clientMsgId: CMID }, ws);

  const done = ofKind(ws.sent, 'complete');
  assert.equal(done.length, 1);
  assert.equal(done[0].responseToMessageId, CMID);
  assert.ok(typeof (done[0].responseTurnMetric as Payload)?.durationMs === 'number');
  assert.equal(done[0].responseTurnDurationTotalMs, (done[0].responseTurnMetric as Payload).durationMs);
});

test('مدة الجولة: لا توسم التنفيذ الذي لا ينتهي بردّ مساعد', async () => {
  const sid = nextSid();
  const ws = makeWs();
  scriptedMessages = [initMessage(sid), { type: 'thinking', message: { content: 'تفكير فقط' } }];

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd, clientMsgId: CMID }, ws);

  const done = ofKind(ws.sent, 'complete');
  assert.equal(done.length, 1);
  assert.equal(done[0].turnStatus, undefined);
  assert.equal(done[0].turnCompletedAt, undefined);
});

// ── 2. الفشل الطرفي — جوهر حادثة المالك ──────────────────────────────────────

test('T-1295: `error` الطرفي يحمل clientMsgId فتُرفع بطاقة الرسالة الضائعة', async () => {
  const sid = nextSid();
  scriptedFailure = new Error('spawn ENOENT: the CLI died mid-run');
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd, clientMsgId: CMID }, ws);

  const failed = ofKind(ws.sent, 'error');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].clientMsgId, CMID);
});

// ── 3. مولد الجلسة ───────────────────────────────────────────────────────────

test('T-1295: `session_created` يحمل clientMsgId لمحادثة وُلدت الآن', async () => {
  const born = nextSid();
  scriptedMessages = [initMessage(born)];
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { cwd: tmpCwd, clientMsgId: CMID }, ws);

  const created = ofKind(ws.sent, 'session_created');
  assert.equal(created.length, 1);
  assert.equal(created[0].clientMsgId, CMID);
  assert.equal(created[0].newSessionId, born);
});

// ── 4. الاستئناف المفقود ─────────────────────────────────────────────────────

test('T-1295: `conversation_not_found` يحمل clientMsgId — وهو الحكم الوحيد هنا', async () => {
  const sid = nextSid();
  scriptedFailure = new Error(`No conversation found with session ID: ${sid}`);
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd, clientMsgId: CMID }, ws);

  const signalled = ws.sent.filter((p) => p.code === 'conversation_not_found');
  assert.equal(signalled.length, 1);
  assert.equal(signalled[0].clientMsgId, CMID);
});

// ── 5. الرفض القاطع ──────────────────────────────────────────────────────────

test('T-1295: `session_busy` يحمل clientMsgId فلا يبقى الإدخال معلَّقاً أبداً', { timeout: 20000 }, async () => {
  const sid = nextSid();
  const first = makeWs(true);
  const second = makeWs(true);

  // جولةٌ حيّة **محتجَزة فعلاً**، ثم محاولة ثانية على المعرّف نفسه تُرفض.
  messageStreamHeld = new Promise<void>((resolve) => { releaseMessageStream = resolve; });
  scriptedMessages = [initMessage(sid)];
  const running = sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd }, first);

  // مهلة كي تُسجَّل الجولة الأولى نشطةً قبل المزاحمة.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // المحاولة الثانية **لا تُحتجَز**: إن لم تُرفض فلتُكمل وتفشل التوكيدَ صراحةً،
  // لا أن تتعلّق على الوعد نفسه فيتجمّد الملف كله (وهو ما وقع فعلاً).
  messageStreamHeld = Promise.resolve();
  scriptedMessages = [];
  try {
    await sdk.queryClaudeSDK(
      PROMPT,
      { sessionId: sid, cwd: tmpCwd, clientMsgId: CMID },
      second,
    );

    const busy = second.sent.filter((p) => p.code === 'session_busy');
    assert.equal(busy.length, 1, 'المحاولة الثانية رُفضت فعلاً — الاختبار غير فارغ');
    assert.equal(busy[0].clientMsgId, CMID, 'الرفض القاطع يصدى بالهوية');
  } finally {
    releaseMessageStream();
    await running.catch(() => undefined);
  }
});

// ── 6. التدهور الرشيق ────────────────────────────────────────────────────────

test('T-1295: بلا clientMsgId لا يظهر الحقل في أي حمولة (العقد القائم غير منقوص)', async () => {
  const sid = nextSid();
  scriptedFailure = new Error('spawn ENOENT: the CLI died mid-run');
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd }, ws);

  assert.ok(ws.sent.length > 0, 'الجولة أنتجت حمولات فعلاً');
  for (const payload of ws.sent) {
    assert.ok(
      !('clientMsgId' in payload),
      `حقلٌ حُقن بلا داعٍ في حمولة kind=${String(payload.kind)}`
    );
  }
});
