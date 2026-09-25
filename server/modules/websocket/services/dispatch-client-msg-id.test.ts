/**
 * B-553/م1 — صدى هوية الجولة يصل من **كل** مزوّد، لا من claude وحده.
 *
 * العلّة المقيسة (مراجعة qa-critic 2026-08-07 على لقطة المالك): `clientMsgId`
 * كان يُصدَّى في `claude-sdk.js` فقط. وتسعة مزوّدات تبعث
 * `session_created`/`complete` عاريةً — فحدّ صندوق الصادر عندها لا يُقبل ولا
 * يفشل أبداً: يبقى الإدخال معلَّقاً اثنتي عشرة ساعة، وإن أُرسل من محادثة جديدة
 * بقي يتيماً (`sessionId: null`) فظهر على **كل** شاشة محادثة جديدة.
 *
 * ما يحرسه هذا الملف:
 *   1. كل مزوّد يُطلق من `dispatchProviderCommand` تصل حمولاتُه الحاسمة موسومة،
 *      وإن لم يضع الوسم بنفسه.
 *   2. أول البثّ يحمل هوية الجولة كي يقيس العميل أول استجابة بدقة؛ أحداث الأدوات
 *      لا تُوسم.
 *   3. من وضع وسمه بنفسه (claude) لا يُدهس: الموجود أدقّ من المفروض.
 *   4. بلا `clientMsgId` من العميل لا يظهر الحقل إطلاقاً — تدهور رشيق.
 *   5. **جولتان متزامنتان على مقبس واحد لا تختلط هويتاهما** — وهو سبب اختيار
 *      لفّةٍ لكل جولة بدل معرّفٍ مخزَّن على الكاتب.
 *
 * Runner: node:test (npm run test:server).
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: { getProjectPath: () => ({ project_id: 'test-project' }) },
    sessionsDb: { getSessionById: () => null },
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    sessionOutcomesDb: {},
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

type Payload = Record<string, unknown>;

/** كاتبٌ صوريّ بواجهة `WebSocketWriter` التي تستعملها طبقة التوزيع. */
function fakeWriter() {
  const sent: Payload[] = [];
  const writer = {
    sessionId: null as string | null,
    userId: 2,
    isWebSocketWriter: true,
    send(payload: unknown) {
      sent.push(payload as Payload);
    },
    setSessionId(id: string) {
      this.sessionId = id;
    },
    getSessionId() {
      return this.sessionId;
    },
  };
  return { writer, sent };
}

/**
 * تبعيّات صوريّة: كل `spawn*` يبعث حمولات المزوّد الحقيقية **كما هي في شفرته**
 * — عاريةً من `clientMsgId` تماماً كالإنتاج (تُحقّق من `openai-codex.js:737`،
 * `gemini-cli.js:508`، `cursor-cli.js:248`، `kimi-agent-cli.js:495`،
 * `hermes-cli.js:170`، `opencode-cli.js:343`، `agy-cli.js:1143`).
 */
function fakeDependencies(emit: (writer: { send(p: unknown): void }) => void) {
  const spawn = async (_command: string, _options: unknown, writer: { send(p: unknown): void }) => {
    emit(writer);
  };
  return {
    spawnCursor: spawn,
    spawnGemini: spawn,
    spawnAntigravity: spawn,
    spawnHermes: spawn,
    spawnKimi: spawn,
    spawnKimiAgent: spawn,
    spawnDeepSeek: spawn,
    spawnOpenCode: spawn,
    spawnGlm: spawn,
    spawnQwen: spawn,
    queryCodex: spawn,
    spawnClaude: spawn,
    queryClaudeSDK: spawn,
    getSessionProvider: () => null,
  } as never;
}

const CMID = 'cmid_test_1';

const MESSAGE_TYPES: ReadonlyArray<[string, string]> = [
  ['claude-command', 'claude'],
  ['cursor-command', 'cursor'],
  ['codex-command', 'codex'],
  ['antigravity-command', 'antigravity'],
  ['hermes-command', 'hermes'],
  ['kimi-command', 'kimi'],
  ['qwen-command', 'qwen'],
  ['opencode-command', 'opencode'],
];

/** معطَّلان عالمياً (`shared/disabledProviders.ts`): مسارهما الرفضُ قبل الإقلاع. */
const DISABLED_MESSAGE_TYPES: ReadonlyArray<[string, string]> = [
  ['deepseek-command', 'deepseek'],
  ['gemini-command', 'gemini'],
];

test('كل مسار بثّ يُصدي هوية الجولة على أول stream delta وعلى حكمه النهائي', async () => {
  for (const [messageType, provider] of MESSAGE_TYPES) {
    const { writer, sent } = fakeWriter();
    await dispatchProviderCommand(
      messageType,
      { command: 'مرحبا', options: { clientMsgId: CMID } } as never,
      writer as never,
      fakeDependencies((w) => {
        w.send({ kind: 'session_created', newSessionId: 's-1', sessionId: 's-1', provider });
        w.send({ kind: 'stream_delta', content: 'أول جزء', sessionId: 's-1', provider });
        w.send({ kind: 'complete', exitCode: 0, sessionId: 's-1', provider });
      }),
    );

    assert.equal(sent.length, 3, `${provider}: عدد الحمولات ${sent.length} — المسار لم يبلغ المزوّد؟`);
    for (const payload of sent) {
      assert.equal(
        payload.clientMsgId,
        CMID,
        `${provider}: حمولة ${String(payload.kind)} بلا صدى ⇒ إدخالٌ معلَّق إلى الأبد`,
      );
    }
  }
});

test('طبقة dispatch لا تختلق قياساً عاماً؛ الحقيقة الدائمة مسؤولية Claude/Codex', async () => {
  for (const [messageType, provider] of MESSAGE_TYPES) {
    const { writer, sent } = fakeWriter();
    await dispatchProviderCommand(
      messageType,
      { command: 'قياس', options: { clientMsgId: CMID, model: `${provider}-model` } } as never,
      writer as never,
      fakeDependencies((w) => {
        w.send({ kind: 'session_created', sessionId: 's-1', provider, model: `${provider}-model` });
        w.send({ kind: 'stream_delta', content: 'نص نهائي', sessionId: 's-1', provider });
        w.send({ kind: 'complete', exitCode: 0, success: true, sessionId: 's-1', provider });
      }),
    );
    const done = sent.at(-1)!;
    assert.equal(done.responseTurnMetric, undefined, `${provider}: dispatch اختلق حقيقة غير محفوظة`);
    assert.equal(done.responseTurnDurationTotalMs, undefined);
    assert.equal(done.responseToMessageId, undefined);
    assert.equal(done.model, undefined, `${provider}: نُسب نموذج من إطار سابق بلا دليل نهائي`);
  }
});

test('لا ينسب كل harness نموذجاً عند غياب اسم صريح من الـ harness', async () => {
  for (const [messageType, provider] of MESSAGE_TYPES) {
    const { writer, sent } = fakeWriter();
    await dispatchProviderCommand(
      messageType,
      { command: 'اسم النموذج', options: { clientMsgId: CMID, model: `${provider}-selected` } } as never,
      writer as never,
      fakeDependencies((w) => {
        // لا يحمل أي إطار صادر من الـ harness اسماً للنموذج. قيمة المنتقي
        // ليست دليلاً على المجيب الحقيقي ولا يجوز إظهارها في الرد.
        w.send({ kind: 'text', role: 'assistant', content: 'رد', sessionId: 's-1', provider });
        w.send({
          kind: 'complete', exitCode: 0, success: true, sessionId: 's-1', provider,
          turnStatus: 'completed',
          turnStartedAt: '2000-01-01T00:00:00.000Z',
          turnCompletedAt: '2000-01-01T00:00:01.000Z',
        });
      }),
    );
    assert.equal(sent.at(-1)?.model, undefined, `${provider}: نُسب اختيار الواجهة إلى الـ harness`);
  }
});

test('يمرر اسم النموذج فقط عندما يعلنه الـ harness صراحةً', async () => {
  const { writer, sent } = fakeWriter();
  await dispatchProviderCommand(
    'claude-command',
    { command: 'اسم النموذج', options: { clientMsgId: CMID, model: 'picker-only' } } as never,
    writer as never,
    fakeDependencies((w) => {
      w.send({ kind: 'stream_delta', content: 'رد', sessionId: 's-1', provider: 'claude' });
      w.send({ kind: 'complete', exitCode: 0, success: true, sessionId: 's-1', provider: 'claude', model: 'claude-opus-5' });
    }),
  );
  assert.equal(sent.at(-1)?.model, 'claude-opus-5');
});

test('لا قياس في دور فاشل أو دور بلا رد مساعد، ولا يُدهس توثيق الموفّر', async () => {
  const { writer, sent } = fakeWriter();
  await dispatchProviderCommand(
    'cursor-command',
    { command: 'x', options: { clientMsgId: CMID } } as never,
    writer as never,
    fakeDependencies((w) => {
      w.send({ kind: 'tool_use', sessionId: 's-tools' });
      w.send({ kind: 'complete', exitCode: 0, sessionId: 's-tools' });
      w.send({ kind: 'stream_delta', content: 'لكن فشل', sessionId: 's-failed' });
      w.send({ kind: 'complete', exitCode: 1, success: false, sessionId: 's-failed' });
      w.send({ kind: 'complete', exitCode: 0, sessionId: 's-owned', turnStatus: 'completed', turnStartedAt: '2000-01-01T00:00:00.000Z', turnCompletedAt: '2000-01-01T00:00:01.000Z' });
    }),
  );
  assert.equal(sent[1].turnStatus, undefined);
  assert.equal(sent[3].turnStatus, undefined);
  assert.equal(sent[4].turnStartedAt, '2000-01-01T00:00:00.000Z');
});

/**
 * الرفضُ قبل الإقلاع حكمٌ نهائي كغيره: رسالةٌ لن يصلها شيءٌ بعده أبداً. ولولا
 * الصدى لبقي إدخالها معلَّقاً اثنتي عشرة ساعة على مزوّدٍ لا يعمل أصلاً.
 */
test('المزوّد المعطَّل عالمياً: حمولة الرفض تحمل الهوية', async () => {
  for (const [messageType, provider] of DISABLED_MESSAGE_TYPES) {
    const { writer, sent } = fakeWriter();
    await dispatchProviderCommand(
      messageType,
      { command: 'x', options: { clientMsgId: CMID } } as never,
      writer as never,
      fakeDependencies(() => {
        throw new Error(`${provider}: المزوّد المعطَّل يجب ألّا يُطلَق`);
      }),
    );

    assert.equal(sent.length, 1, `${provider}: حمولة الرفض وحدها متوقَّعة`);
    assert.equal(sent[0].kind, 'complete');
    assert.equal(sent[0].success, false);
    assert.equal(sent[0].clientMsgId, CMID);
  }
});

test('كل stream_delta يحمل هوية الجولة لربط زمن الاستجابة، وtool_result وحده لا يُوسم', async () => {
  const { writer, sent } = fakeWriter();
  await dispatchProviderCommand(
    'cursor-command',
    { command: 'x', options: { clientMsgId: CMID } } as never,
    writer as never,
    fakeDependencies((w) => {
      w.send({ kind: 'stream_delta', content: 'جزء', sessionId: 's-1' });
      w.send({ kind: 'tool_use', toolName: 'Read', sessionId: 's-1' });
      w.send({ kind: 'tool_result', content: 'محتوى الملف', sessionId: 's-1' });
      w.send({ kind: 'error', code: 'spawn_failed', sessionId: 's-1' });
    }),
  );

  assert.equal(sent[0].clientMsgId, CMID, 'أول البث بلا رابط دقيق ⇒ زمن استجابة مخمّن');
  assert.equal(sent[1].clientMsgId, CMID, 'نداء الأداة نشاط نموذج صالح لبداية الاستجابة');
  assert.equal(sent[2].clientMsgId, undefined, 'نتيجة الأداة ليست استجابة النموذج');
  assert.equal(sent[3].clientMsgId, CMID, 'الخطأ الطرفي بلا صدى ⇒ لا بطاقة ولا حذف');
});

test('Codex: agent_message أو thinking أو tool قبل stream_delta يحمل هوية الجولة', async () => {
  const { writer, sent } = fakeWriter();
  await dispatchProviderCommand(
    'codex-command',
    { command: 'نفّذ المهمة', options: { clientMsgId: CMID } } as never,
    writer as never,
    fakeDependencies((w) => {
      // هذه هي الأشكال بعد تحويل item.* في openai-codex.js وتطبيعها في
      // CodexSessionsProvider؛ لا يرسل Codex stream_delta بالضرورة.
      w.send({ kind: 'text', role: 'assistant', content: 'سأبدأ', sessionId: 'codex-1' });
      w.send({ kind: 'thinking', content: 'أفكّر', sessionId: 'codex-1' });
      w.send({ kind: 'tool_use', toolName: 'Bash', sessionId: 'codex-1' });
      w.send({ kind: 'tool_result', content: 'لا توسَم', sessionId: 'codex-1' });
      w.send({ kind: 'text', role: 'user', content: 'لا توسَم', sessionId: 'codex-1' });
    }),
  );

  assert.equal(sent[0].clientMsgId, CMID, 'agent_message المطبع كنص مساعد هو أول نشاط موثوق');
  assert.equal(sent[1].clientMsgId, CMID, 'thinking نشاط نموذج موثوق');
  assert.equal(sent[2].clientMsgId, CMID, 'tool_use قرار نموذج موثوق');
  assert.equal(sent[3].clientMsgId, undefined, 'tool_result لا يبدأ مؤقت الاستجابة');
  assert.equal(sent[4].clientMsgId, undefined, 'صدى المستخدم لا يبدأ مؤقت الاستجابة');
});

test('وسمُ المزوّد بنفسه لا يُدهس — الموجود أدقّ من المفروض', async () => {
  const { writer, sent } = fakeWriter();
  await dispatchProviderCommand(
    'claude-command',
    { command: 'x', options: { clientMsgId: CMID } } as never,
    writer as never,
    fakeDependencies((w) => {
      w.send({ kind: 'complete', sessionId: 's-1', clientMsgId: 'cmid_من_المزوّد' });
    }),
  );

  assert.equal(sent[0].clientMsgId, 'cmid_من_المزوّد');
});

test('بلا هوية من العميل لا يظهر الحقل إطلاقاً — تدهور رشيق', async () => {
  const { writer, sent } = fakeWriter();
  await dispatchProviderCommand(
    'cursor-command',
    { command: 'x', options: {} } as never,
    writer as never,
    fakeDependencies((w) => {
      w.send({ kind: 'complete', sessionId: 's-1' });
    }),
  );

  assert.equal('clientMsgId' in sent[0], false);
});

/**
 * سبب اختيار لفّةٍ لكل جولة بدل معرّفٍ مخزَّن على الكاتب: المقبس الواحد يشغّل
 * محادثتين، فمعرّفٌ واحد كان سيُذيّل حكمَ هذه بهوية تلك — فيُحذف إدخال رسالةٍ
 * لم تصل. وهذا فقدانُ كلامٍ لا مجرّد بطاقة عالقة.
 */
test('جولتان على مقبس واحد: كل حكم بهويته هو', async () => {
  const { writer, sent } = fakeWriter();

  const first = dispatchProviderCommand(
    'cursor-command',
    { command: 'أولى', options: { clientMsgId: 'cmid_A' } } as never,
    writer as never,
    fakeDependencies((w) => {
      w.send({ kind: 'complete', sessionId: 's-A' });
    }),
  );
  const second = dispatchProviderCommand(
    'codex-command',
    { command: 'ثانية', options: { clientMsgId: 'cmid_B' } } as never,
    writer as never,
    fakeDependencies((w) => {
      w.send({ kind: 'complete', sessionId: 's-B' });
    }),
  );
  await Promise.all([first, second]);

  const bySession = new Map(sent.map((p) => [p.sessionId, p.clientMsgId]));
  assert.equal(bySession.get('s-A'), 'cmid_A');
  assert.equal(bySession.get('s-B'), 'cmid_B');
});
