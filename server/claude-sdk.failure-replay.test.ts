/**
 * claude-sdk.failure-replay.test.ts — B-515: حمولة الفشل (وطلب الإذن) يجب أن
 * تكون **قابلة للاسترجاع**، لا أن تُلقى على مقبس قد يكون ميّتاً.
 *
 * الخلل الذي تُثبّته هذه الاختبارات
 * ---------------------------------
 * ADR-041 يخزّن كل حمولة حيّة في مخزن الجلسة الحلقي عبر `sendAndBuffer`، فيُعاد
 * بثّها تفاضلياً (`seq > lastSeq`) لأي مقبس يستأنف. لكن `error` و
 * `permission_request` و`permission_cancelled` كانت تتجاوزه بـ`ws.send` مباشر
 * «كي لا يُرهَن الفشل بالسجل». والنتيجة أن الحمولة الوحيدة التي لا مصدرَ ثانياً
 * لها ضاعت نهائياً حين مات المقبس: إعادةُ البثّ لا تجدها (لم تُخزَّن قطّ)، ودمجُ
 * الذيل عبر REST لا يجدها (الأخطاء ليست صفوفاً في سجلّ المحادثة). قياس الحادثة:
 * ‏2026-08-06T15:18:57 — `code=1006` و`hadActiveStreamAtClose=true`.
 *
 * وقد كشف الاختبار الأول عطلاً أسبق منعقداً فوق هذا (بلا معرّف لوحة بعد):
 * ‏`injectedHosts`
 * و`effectiveEngineProvider` كانتا `const` **داخل** `try`، وتُقرآن في `catch`
 * (‏B-411، ‏96f5752b، ‏2026-08-03). فكل جولة تفشل كانت ترتدّ
 * `ReferenceError: injectedHosts is not defined` قبل بناء حمولة الخطأ بأسطر: لا
 * خطأ يصل صاحبه، ولا `notifyRunFailed` يُطلق — فشلٌ صامت تماماً. ولولا رفعهما
 * خارج `try` لبقي تخزين حمولة الخطأ كوداً لا يُبلَغ أصلاً.
 *
 * ما تُثبّته الاختبارات:
 *   1. خطأ الجولة الطرفي يصل المقبس الحيّ **ويبقى** في المخزن فيُعاد بثّه.
 *   2. وصولاً واحداً لا اثنين على مقبس حيّ (التخزين لا يضاعف الإرسال).
 *   3. ‏`conversation_not_found` — وهي تحمل نصّ رسالة المستخدم نفسه — قابلة
 *      لإعادة البثّ كذلك.
 *   4. طلب الإذن وإلغاؤه يُخزَّنان معاً، بهذا الترتيب.
 *   5. عقد الإطفاء محفوظ: بعلم `SESSION_REGISTRY_claude` مطفأً يصل الخطأ كما كان
 *      بلا `sequence` وبلا مخزن.
 *
 * لماذا ليست fixtures مصطنعة: كل اختبار يقود `queryClaudeSDK` الإنتاجية نفسها،
 * ولا يُموَّه إلا Agent SDK (لا معنى لعملية CLI حقيقية هنا)، ويقرأ النتيجة من
 * `attachClaudeSDKSession` — مسار إعادة البثّ الذي تستدعيه طبقة الويب سوكِت
 * حرفياً عند `check-session-status`.
 *
 * Runner: node:test with --experimental-test-module-mocks (npm run test:server).
 * تسجيل موك الـSDK يسبق استيراد الوحدة تحت الاختبار، ومن ثمّ الاستيراد الديناميكي.
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
let lastQueryArg: { prompt?: unknown; options?: Record<string, unknown> } | null = null;
let releaseMessageStream: () => void = () => {};
let messageStreamHeld: Promise<void> = Promise.resolve();

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: { prompt?: unknown; options?: Record<string, unknown> }) => {
      lastQueryArg = arg;
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

// Resume-profile enforcement has its own focused suite; this file isolates
// terminal failure recording and replay.
mock.module('./services/isolation/resolve-claude-run-profile.js', {
  namedExports: {
    resolveClaudeRunProfileOrThrow: async ({ baseEnv = process.env } = {}) => ({
      env: { ...baseEnv }, effectiveEngine: null, engineHosts: null, pin: {},
    }),
  },
});

const sdk = (await import('./claude-sdk.js')) as unknown as {
  queryClaudeSDK: (command: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
  attachClaudeSDKSession: (sessionId: string, lastSeq: number, send: (p: Payload) => void) => number;
};

const PROMPT = 'أعد بناء الوحدة من فضلك';

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'SESSION_REGISTRY_claude'] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';
let tmpCwd = '';

/** كاتب اختباري بشكل WebSocketWriter: يلتقط ما أُرسل فعلاً على المقبس. */
function makeWs() {
  const sent: Payload[] = [];
  return { sent, send: (p: Payload) => { sent.push(p); }, userId: null, ws: { readyState: 1 } };
}

/** ما يستلمه مقبس يستأنف من الصفر — نفس نداء طبقة الويب سوكِت. */
function replayFromStart(sessionId: string): Payload[] {
  const out: Payload[] = [];
  sdk.attachClaudeSDKSession(sessionId, 0, (p) => { out.push(p); });
  return out;
}

const ofKind = (rows: Payload[], kind: string) => rows.filter((p) => p.kind === kind);

/** معرّف فريد لكل اختبار: مخزن الجلسة يعيش عبر الاختبارات في نفس العملية. */
let sidCounter = 0;
const nextSid = () => `b515-session-${++sidCounter}-0000-4000-8000-000000000000`;

beforeEach(() => {
  scriptedMessages = [];
  scriptedFailure = null;
  lastQueryArg = null;
  messageStreamHeld = Promise.resolve();
  releaseMessageStream = () => {};

  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // العلم مرفوع في الإنتاج (‏.env و ecosystem)، فهذه هي الحالة المقيسة.
  process.env.SESSION_REGISTRY_claude = '1';
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b515-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
  // مجلد عمل خالٍ: لا إعدادات مشروع تسمح بأداة فتُسقط مسار طلب الإذن.
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'b515-cwd-'));
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

// ── 1+2. الخطأ الطرفي: مخزَّن، ومُرسَل مرّة واحدة ────────────────────────────

test('B-515: خطأ الجولة الطرفي يُعاد بثّه لمقبس يستأنف (كان يضيع نهائياً)', async () => {
  const sid = nextSid();
  scriptedFailure = new Error('spawn ENOENT: the CLI died mid-run');
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd }, ws);

  const live = ofKind(ws.sent, 'error');
  assert.equal(live.length, 1, 'الخطأ يصل المقبس الحيّ — الإرسال غير مرهون بالتخزين');

  const replayed = ofKind(replayFromStart(sid), 'error');
  assert.equal(
    replayed.length,
    1,
    'وهو مخزَّن: مقبسٌ مات قبل التسليم يستعيده بإعادة البثّ التفاضلية'
  );
  assert.equal(replayed[0].content, live[0].content, 'نفس الحمولة لا نسخة أفقر منها');
  assert.equal(
    typeof replayed[0].sequence,
    'number',
    'مرقَّمة في خطّ الجولة نفسه، فيبقى lastSeq عند العميل دقيقاً'
  );
});

test('B-515: التخزين لا يضاعف الإرسال — الخطأ يصل المقبس الحيّ مرّة واحدة', async () => {
  const sid = nextSid();
  scriptedFailure = new Error('spawn ENOENT: the CLI died mid-run');
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd }, ws);

  assert.equal(
    ofKind(ws.sent, 'error').length,
    1,
    'حمولة واحدة على السلك: bufferThenSend يحلّ محلّ ws.send ولا يُضاف إليه'
  );
});

// ── 3. الاستئناف المفقود: الحمولة تحمل رسالة المستخدم نفسها ──────────────────

test('B-515: `conversation_not_found` قابلة لإعادة البثّ — وهي تحمل نصّ الرسالة', async () => {
  const sid = nextSid();
  scriptedFailure = new Error(`No conversation found with session ID: ${sid}`);
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd }, ws);

  const live = ws.sent.filter((p) => p.code === 'conversation_not_found');
  assert.equal(live.length, 1, 'الإشارة الصريحة تصل المقبس الحيّ');
  assert.equal(live[0].command, PROMPT, 'وتحمل نصّ الرسالة لإعادة إرسالها');

  const replayed = replayFromStart(sid).filter((p) => p.code === 'conversation_not_found');
  assert.equal(replayed.length, 1, 'ولا تضيع بموت المقبس: مخزَّنة كسائر حمولات الجولة');
  assert.equal(replayed[0].command, PROMPT, 'بنصّ الرسالة كاملاً، فزرّ الاستئناف يبقى عاملاً');
});

// ── 3ب. مرفق مرفوض: إشعارٌ لا مصدر ثانيَ له ──────────────────────────────────

test('B-515: رفضُ صورةٍ مرفقة قابل لإعادة البثّ — وإلا أجاب النموذج عن صورة لم يرَها', async () => {
  const sid = nextSid();
  const ws = makeWs();

  await sdk.queryClaudeSDK(
    PROMPT,
    { sessionId: sid, cwd: tmpCwd, images: [{ data: 'ليست صورة أصلاً', name: 'x.png' }] },
    ws
  );

  const live = ws.sent.filter((p) => p.code === 'image_rejected');
  assert.equal(live.length, 1, 'من أرفق الصورة يُخبَر أنها لم تُرسَل');

  const replayed = replayFromStart(sid).filter((p) => p.code === 'image_rejected');
  assert.equal(replayed.length, 1, 'ويبقى الإخبار قائماً بعد موت المقبس');
});

// ── 4. طلب الإذن وإلغاؤه: يُخزَّنان معاً وبالترتيب ───────────────────────────

test('B-515: طلب الإذن — ثم إلغاؤه — يُعادان بثّهما بهذا الترتيب', async () => {
  const sid = nextSid();
  scriptedMessages = [];
  messageStreamHeld = new Promise<void>((resolve) => { releaseMessageStream = resolve; });
  const ws = makeWs();

  const run = sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd }, ws);
  // انتظر إنشاء الجولة حتى يصير canUseTool الإنتاجي في متناول اليد.
  for (let i = 0; i < 100 && !lastQueryArg?.options?.canUseTool; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const canUseTool = lastQueryArg?.options?.canUseTool as
    | ((tool: string, input: unknown, ctx: unknown) => Promise<unknown>)
    | undefined;
  assert.ok(canUseTool, 'الجولة أُنشئت ومعها مُعالِج الإذن');

  const controller = new AbortController();
  const decision = canUseTool!('Bash', { command: 'rm -rf /tmp/x' }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 50));

  const askedLive = ofKind(ws.sent, 'permission_request');
  assert.equal(askedLive.length, 1, 'السؤال يصل المقبس الحيّ');
  const askedReplay = ofKind(replayFromStart(sid), 'permission_request');
  assert.equal(askedReplay.length, 1, 'وهو مخزَّن: سؤالٌ مات مقبسه كان يُجمّد الجولة بلا سؤال يُرى');
  assert.equal(askedReplay[0].requestId, askedLive[0].requestId, 'بنفس المعرّف فيُلغي العميل المكرَّر');

  // إلغاء من الوقت الحقيقي (انقطاع النقل) — المسار الذي يستدعي onCancel.
  controller.abort();
  await decision;
  await new Promise((r) => setTimeout(r, 20));

  const rows = replayFromStart(sid);
  const askedAt = rows.findIndex((p) => p.kind === 'permission_request');
  const cancelledAt = rows.findIndex((p) => p.kind === 'permission_cancelled');
  assert.notEqual(cancelledAt, -1, 'الإلغاء مخزَّن أيضاً — وإلا أحيت إعادةُ البثّ سؤالاً منقضياً');
  assert.ok(cancelledAt > askedAt, 'وبعد سؤاله، فيُلغيه العميل عند إعادة البثّ');
  assert.equal(
    rows[cancelledAt].requestId,
    askedReplay[0].requestId,
    'الإلغاء يشير إلى الطلب نفسه'
  );

  releaseMessageStream();
  await run;
});

// ── 5. عقد الإطفاء: لا شيء يتغيّر حين يكون العلم مطفأً ───────────────────────

test('B-515: بعلم السجل مطفأً يصل الخطأ كما كان — بلا sequence وبلا مخزن', async () => {
  const sid = nextSid();
  delete process.env.SESSION_REGISTRY_claude;
  scriptedFailure = new Error('spawn ENOENT: the CLI died mid-run');
  const ws = makeWs();

  await sdk.queryClaudeSDK(PROMPT, { sessionId: sid, cwd: tmpCwd }, ws);

  const live = ofKind(ws.sent, 'error');
  assert.equal(live.length, 1, 'الفشل يصل صاحبه — التخزين لم يصر شرطاً للإرسال');
  assert.equal(live[0].sequence, undefined, 'ولا يُوسم برقم تسلسلي والعلم مطفأ');
  assert.deepEqual(replayFromStart(sid), [], 'ولا مخزن أصلاً: no-op تامّ كما ينصّ ADR-041');
});
