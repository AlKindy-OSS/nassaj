/**
 * T-1315 (الموجة الثانية، قرار المالك 2026-08-17) — «الزرّ يشتغل على كل الأجساد».
 *
 * الفجوة التي يسدّها هذا الاختبار: قبل هذه الموجة كان `readCoordinationLevel`
 * يُحقن في فرع Claude **وحده**، وكل فرع مزوّد آخر يمرّر `data.options` الخام —
 * فالقيمة لا تصل المحرّك أصلاً مهما اختار المستخدم. ذلك انفراطٌ صامت لا يكشفه
 * اختبار Claude، ولا يكشفه فحص الأنواع (الحمولة `unknown`).
 *
 * فيثبت هنا على **كل** مُشعِل في الموزّع:
 *   • المستوى يصل كما هو للمستويات الثلاثة المعروفة.
 *   • المدخل المجهول يفشل مغلقاً إلى `direct` — عند كل فرع لا عند Claude فقط.
 *   • بقية الحمولة تعبر سليمة (لا يبتلع التطبيعُ حقلاً آخر).
 *
 * Run: d=$(mktemp -d); DATABASE_PATH="$d/a.db" npx tsx \
 *   --experimental-test-module-mocks --tsconfig server/tsconfig.json --test \
 *   server/modules/websocket/services/chat-websocket.coordination-all-engines.test.ts
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

const PROJECT_ID = 'coordination-all-engines-fixture';
const PRINCIPAL_ID = 7;
const projectPath = fs.realpathSync(fs.mkdtempSync(
  path.join(process.cwd(), '.coordination-all-engines-fixture-'),
));

after(() => {
  fs.rmSync(projectPath, { recursive: true, force: true });
});

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: (candidate: string) => candidate === projectPath
        ? { project_id: PROJECT_ID, project_path: projectPath }
        : null,
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: (projectId: string, userId: number | null) =>
        projectId === PROJECT_ID && userId === PRINCIPAL_ID,
    },
    participantsDb: { isParticipant: () => false },
    sessionsDb: { getSessionById: () => null },
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    sessionOutcomesDb: {},
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

const writer = { send: () => undefined } as unknown as WebSocketWriter;

/**
 * كل مزوّد له فرعٌ فعلي **يُطلَق اليوم** في الموزّع، مقروناً بنوع الرسالة ومفتاح
 * التبعية التي يستدعيها. ‏`sakana` غير مذكور عمداً: لا فرع له أصلاً — وهذا ما
 * يجعل واصفَه `supported:false` صدقاً لا تحفّظاً.
 */
const ENGINES: Array<{ provider: string; messageType: string; dep: string }> = [
  { provider: 'claude', messageType: 'claude-command', dep: 'queryClaudeSDK' },
  { provider: 'codex', messageType: 'codex-command', dep: 'queryCodex' },
  { provider: 'cursor', messageType: 'cursor-command', dep: 'spawnCursor' },
  { provider: 'antigravity', messageType: 'antigravity-command', dep: 'spawnAntigravity' },
  { provider: 'hermes', messageType: 'hermes-command', dep: 'spawnHermes' },
  { provider: 'opencode', messageType: 'opencode-command', dep: 'spawnOpenCode' },
  // kimi في وضع الدردشة يسلك `spawnKimi` أي **مسار vendor-runtime بعينه** الذي
  // يخدم deepseek/glm أيضاً. فهذا الصفّ هو ما يُبقي قناة `system` المضافة هناك
  // حيّةً ومختبَرة رغم أن صاحبَيها الآخرَين معطَّلان عالمياً (أدناه).
  { provider: 'qwen', messageType: 'qwen-command', dep: 'spawnQwen' },
];

/**
 * ‏deepseek وglm معطَّلان عالمياً (‏T-864 وقرار المالك 2026-07-26 في
 * `shared/disabledProviders.ts`)، فبوّابةُ الرفض تسبق الموزّع ولا يُطلَق لهما
 * مُشعِلٌ أصلاً. توصيلُ المستوى إليهما مبنيٌّ وكامل في `vendor-runtime`، لكن
 * ادّعاءَ أنه «يصل اليوم» كذبٌ يكشفه أول تشغيل — فيُثبَّت الواقع اختباراً بدل
 * أن يُطمَس. رفعُ التعطيل وحده يُحيي المسار، بلا سطر كودٍ إضافي.
 */
const GLOBALLY_DISABLED: Array<{ provider: string; messageType: string; dep: string }> = [
  { provider: 'deepseek', messageType: 'deepseek-command', dep: 'spawnDeepSeek' },
  { provider: 'glm', messageType: 'glm-command', dep: 'spawnGlm' },
];

const DEP_NAMES = [
  'queryClaudeSDK', 'queryCodex', 'spawnCursor', 'spawnAntigravity',
  'spawnHermes', 'spawnOpenCode', 'spawnKimi', 'spawnKimiAgent', 'spawnDeepSeek',
  'spawnGlm', 'spawnQwen',
];

function makeDependencies(target: string, sink: unknown[]) {
  const dependencies: Record<string, unknown> = {
    getSessionProvider: () => null,
    getActiveClaudeSDKSessions: () => [],
  };
  for (const name of DEP_NAMES) {
    dependencies[name] = name === target
      ? async (_command: string, options: unknown) => { sink.push(options); }
      : async () => {};
  }
  return dependencies as never;
}

async function dispatch(engine: { provider: string; messageType: string; dep: string },
  options: Record<string, unknown>, sink: unknown[], outputWriter = writer) {
  await dispatchProviderCommand(
    engine.messageType,
    { type: engine.messageType, command: 'x', options: {
      provider: engine.provider, cwd: projectPath,
      clientMsgId: `coordination-${randomUUID()}`, ...options,
    } } as never,
    outputWriter,
    makeDependencies(engine.dep, sink),
    PRINCIPAL_ID,
  );
}

for (const engine of ENGINES) {
  test(`${engine.provider}: coordination level reaches its launcher`, async () => {
    const sink: unknown[] = [];
    for (const level of ['direct', 'delegate', 'delegate_review']) {
      await dispatch(engine, { coordinationLevel: level }, sink);
    }

    assert.equal(sink.length, 3, `${engine.dep} was never invoked — the branch is unwired`);
    assert.deepEqual(
      sink.map((options) => (options as { coordinationLevel?: unknown }).coordinationLevel),
      ['direct', 'delegate', 'delegate_review'],
    );
  });

  test(`${engine.provider}: unknown level fails closed to direct`, async () => {
    const sink: unknown[] = [];
    await dispatch(engine, { coordinationLevel: 'delegate_review_plus' }, sink);
    await dispatch(engine, {}, sink);

    assert.deepEqual(
      sink.map((options) => (options as { coordinationLevel?: unknown }).coordinationLevel),
      ['direct', 'delegate'],
    );
  });

  test(`${engine.provider}: the rest of the payload survives normalization`, async () => {
    const sink: unknown[] = [];
    await dispatch(engine, {
      coordinationLevel: 'delegate', model: 'm-1', cwd: projectPath,
    }, sink);

    const options = sink[0] as { model?: unknown; cwd?: unknown; coordinationLevel?: unknown };
    assert.equal(options.model, 'm-1');
    assert.equal(options.cwd, projectPath);
    assert.equal(options.coordinationLevel, 'delegate');
  });

  test(`${engine.provider}: a missing workspace never reaches its launcher`, async () => {
    const sink: unknown[] = [];
    const frames: unknown[] = [];
    const missingPath = path.join(projectPath, 'missing');
    const outputWriter = { send: (frame: unknown) => frames.push(frame) } as unknown as WebSocketWriter;

    await dispatch(engine, { coordinationLevel: 'delegate', cwd: missingPath }, sink, outputWriter);

    assert.equal(sink.length, 0);
    assert.equal(
      (frames.at(-1) as { code?: unknown } | undefined)?.code,
      'session_workspace_missing',
    );
  });
}

for (const engine of GLOBALLY_DISABLED) {
  test(`${engine.provider}: globally disabled ⇒ no launcher, so no level to carry`, async () => {
    const sink: unknown[] = [];
    await dispatch(engine, { coordinationLevel: 'delegate_review' }, sink);

    // لا استدعاء أصلاً: الرفض قبل الإقلاع. هذا هو السبب الوحيد، وهو مستقلّ عن
    // مستوى التنسيق تماماً — فلا يُقرأ «الميزة لا تعمل على هذا المزوّد».
    assert.equal(sink.length, 0);
  });
}

/**
 * مسار GLM الحيّ الوحيد اليوم: وضع الوكيل عبر حامل OpenCode (‏GL-8/ADR-062). هنا
 * **يصل** المستوى فعلاً، لأن الحامل يُطلق `spawnOpenCode` وهو مُشعِل موصول.
 */
test('glm agent mode through the OpenCode carrier does carry the level', async () => {
  const previous = process.env.NASSAJ_OPENCODE_CARRIER;
  process.env.NASSAJ_OPENCODE_CARRIER = 'true';
  try {
    const sink: unknown[] = [];
    await dispatchProviderCommand(
      'glm-command',
      {
        type: 'glm-command',
        command: 'x',
        options: {
          provider: 'glm', mode: 'agent', coordinationLevel: 'direct', cwd: projectPath,
          clientMsgId: `coordination-${randomUUID()}`,
        },
      } as never,
      writer,
      makeDependencies('spawnOpenCode', sink),
      PRINCIPAL_ID,
    );

    assert.equal(sink.length, 1);
    const options = sink[0] as { coordinationLevel?: unknown; carrier?: unknown };
    assert.equal(options.coordinationLevel, 'direct');
    assert.equal(options.carrier, true);
  } finally {
    if (previous === undefined) delete process.env.NASSAJ_OPENCODE_CARRIER;
    else process.env.NASSAJ_OPENCODE_CARRIER = previous;
  }
});
