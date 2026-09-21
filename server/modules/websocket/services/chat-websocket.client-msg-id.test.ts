/**
 * chat-websocket.client-msg-id.test.ts — T-1295.
 *
 * صدى `clientMsgId` على حمولات **الرفض قبل الإقلاع** الصادرة من طبقة الـWS.
 *
 * لماذا يهمّ: العميل يكتب رسالته في صندوق الصادر قبل الإرسال ويحذفها عند أوّل
 * دليل قبول. حمولةُ رفضٍ بلا صدى الهوية تترك الإدخال معلَّقاً **إلى الأبد** —
 * الرسالة رُفضت ولن يصل عنها حكمٌ آخر أبداً، فلا بطاقة ولا أفعال ولا علم لصاحبها.
 * والصدى هو الرابط الوحيد المسموح: الربط بـ«أحدث معلَّق لهذه الجلسة» تخمينٌ قد
 * يُصيب تشغيلاً آخر.
 *
 * ويحرس كذلك **التدهور الرشيق**: عميلٌ لا يرسل الحقل يُنتج حمولةً مطابقةً حرفياً
 * لما كانت عليه — لا حقل زائد ولا `undefined`.
 *
 * Runner: Node built-in test runner with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getProjectPath: () => ({ project_id: 'test-project' }),
      isProjectVisibleToUser: () => true,
    },
    sessionsDb: { getSessionById: () => null },
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    userDb: { getUserById: () => null, getFirstUser: () => null },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

type SentPayload = {
  kind?: string;
  success?: boolean;
  clientMsgId?: string;
};

function makeWriter() {
  const sent: SentPayload[] = [];
  const writer = {
    send: (payload: unknown) => { sent.push(payload as SentPayload); },
  } as unknown as WebSocketWriter;
  return { writer, sent };
}

function makeDependencies() {
  const calls: string[] = [];
  const spawn = (name: string) => async () => { calls.push(name); };
  return {
    calls,
    dependencies: {
      queryClaudeSDK: spawn('claude'),
      spawnCursor: spawn('cursor'),
      queryCodex: spawn('codex'),
      spawnGemini: spawn('gemini'),
      spawnAntigravity: spawn('antigravity'),
      spawnHermes: spawn('hermes'),
      spawnKimi: spawn('kimi'),
      spawnDeepSeek: spawn('deepseek'),
      spawnGlm: spawn('glm'),
      spawnOpenCode: spawn('opencode'),
      getSessionProvider: () => null,
      getActiveClaudeSDKSessions: () => [],
    } as never,
  };
}

test('رفضُ مزوّد مُعطَّل يصدى بـclientMsgId فلا يبقى الإدخال معلَّقاً', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies } = makeDependencies();

  await dispatchProviderCommand(
    'deepseek-command',
    { type: 'deepseek-command', command: 'مرحبا', options: { clientMsgId: 'cmid_abc' } } as never,
    writer,
    dependencies,
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'complete');
  assert.equal(sent[0].success, false);
  assert.equal(sent[0].clientMsgId, 'cmid_abc');
});

test('بلا clientMsgId: الحمولة بلا الحقل أصلاً (تدهور رشيق لا `undefined`)', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies } = makeDependencies();

  await dispatchProviderCommand(
    'deepseek-command',
    { type: 'deepseek-command', command: 'مرحبا', options: {} } as never,
    writer,
    dependencies,
  );

  assert.equal(sent.length, 1);
  assert.ok(!('clientMsgId' in sent[0]), 'لا يُحقن الحقل حين لا يرسله العميل');
});

test('قيمة غير نصّية تُهمَل ولا تُنسخ إلى الحمولة', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies } = makeDependencies();

  await dispatchProviderCommand(
    'deepseek-command',
    { type: 'deepseek-command', command: 'x', options: { clientMsgId: { evil: true } } } as never,
    writer,
    dependencies,
  );

  assert.equal(sent.length, 1);
  assert.ok(!('clientMsgId' in sent[0]));
});

test('مزوّد مُفعَّل: لا رفض ولا حمولة — الأمر يمضي إلى محرّكه', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies, calls } = makeDependencies();

  await dispatchProviderCommand(
    'claude-command',
    { type: 'claude-command', command: 'مرحبا', options: { clientMsgId: 'cmid_abc' } } as never,
    writer,
    dependencies,
  );

  assert.deepEqual(calls, ['claude']);
  assert.equal(sent.length, 0);
});
