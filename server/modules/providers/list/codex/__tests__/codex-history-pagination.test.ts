import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(
  process.env.TMPDIR || path.join(process.cwd(), '.artifacts'), 'nassaj-codex-history-',
));
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
// Start an empty fixture, preventing the connection layer's legacy DB import.
fs.writeFileSync(process.env.DATABASE_PATH, '');

const { appConfigDb, closeConnection, getConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { CodexSessionsProvider } = await import('../codex-sessions.provider.js');
const { applyMessageCoordination } = await import('../../../services/sessions.service.js');
await initializeDatabase();

after(() => {
  closeConnection();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function user(message: string) {
  return { type: 'event_msg', payload: { type: 'user_message', message } };
}

function assistant(message: string) {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message }] },
  };
}

function attestedUser(content: Array<Record<string, unknown>>, kinds: string[], id: string) {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      id,
      role: 'user',
      content,
      internal_chat_message_metadata_passthrough: {
        turn_id: `turn-${id}`,
        content_item_kinds: kinds,
      },
    },
  };
}

function spawnAgent(callId: string, taskName: string) {
  return {
    type: 'response_item',
    payload: {
      type: 'function_call',
      id: `fc_${callId}`,
      name: 'spawn_agent',
      namespace: 'collaboration',
      arguments: JSON.stringify({ task_name: taskName }),
      call_id: callId,
    },
  };
}

describe('Codex history pagination', () => {
  it('preserves image prompt whitespace for exact authenticated ingress attribution', async () => {
    const sessionId = 'image-authorship-whitespace';
    const filePath = path.join(sandbox, `${sessionId}.jsonl`);
    const prompt = '  Who sent this message? \n\n';
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const payload = (withImage: boolean) => ({
      type: 'response_item', timestamp: '2026-09-05T22:17:29.000Z',
      payload: { type: 'message', role: 'user', content: [
        ...(withImage ? [
          { type: 'input_text', text: '<image name=[Image #1] path="/tmp/removed.png">' },
          { type: 'input_image', image_url: image },
          { type: 'input_text', text: '</image>' },
        ] : []),
        { type: 'input_text', text: prompt },
      ] },
    });
    fs.writeFileSync(filePath, `${[payload(true), assistant('reply'), payload(false)]
      .map((event) => JSON.stringify(event)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);
    const history = await new CodexSessionsProvider().fetchHistory(sessionId);
    const users = history.messages.filter((message) => message.role === 'user');
    assert.deepEqual(users.map((message) => message.content), [prompt, prompt]);
    assert.deepEqual(users[0].images, [image]);
    const ingress = {
      clientMsgId: 'accepted-message', sessionId, userId: 1, provider: 'codex',
      canonicalContent: prompt, contentHash: '', coordinationLevel: 'delegate' as const,
      createdAt: '2026-09-05T22:17:26.000Z',
    };
    for (const message of users) {
      const attributed = { ...message };
      applyMessageCoordination([attributed], [ingress]);
      assert.equal(attributed.userId, 1);
      for (const candidate of [
        { ...ingress, canonicalContent: prompt.trim() },
        { ...ingress, provider: 'claude' },
      ]) {
        const unmatched = { ...message };
        applyMessageCoordination([unmatched], [candidate]);
        assert.equal(unmatched.userId, undefined);
      }
      const conflicting = { ...message, userId: 2 };
      applyMessageCoordination([conflicting], [ingress]);
      assert.equal(conflicting.userId, 2);
      assert.equal(conflicting.coordinationLevel, undefined);
      const machine = { ...message, originKind: 'coordinator' as const };
      applyMessageCoordination([machine], [ingress]);
      assert.equal(machine.userId, undefined);
      assert.equal(machine.coordinationLevel, undefined);
    }
  });

  it('retains native text-only user records without requiring the legacy user_message echo', async () => {
    const sessionId = 'native-text-only-session';
    const filePath = path.join(sandbox, 'native-text-only.jsonl');
    const nativeUser = (text: string) => ({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    const rows = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '<recommended_plugins>catalog</recommended_plugins>' },
        { type: 'input_text', text: '# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS>' },
        { type: 'input_text', text: '<environment_context>workspace</environment_context>' },
      ] } },
      nativeUser('first prompt'), assistant('answer'),
      nativeUser('same request'), assistant('second answer'), nativeUser('same request'),
      nativeUser('legacy echo'), user('legacy echo'),
      { timestamp: '2026-09-05T00:00:00Z', ...nativeUser('repeated later') },
      { timestamp: '2026-09-05T00:00:03Z', ...user('repeated later') },
      nativeUser('<environment_context>quoted by the user</environment_context>'),
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);
    const history = await new CodexSessionsProvider().fetchHistory(sessionId);
    assert.deepEqual(history.messages.filter((row) => row.role === 'user').map((row) => row.content),
      ['first prompt', 'same request', 'same request', 'legacy echo', 'repeated later', 'repeated later',
        '<environment_context>quoted by the user</environment_context>']);
  });

  it('hides an attested resumed environment singleton while preserving literal malformed and complete mixed user content', async () => {
    const sessionId = 'resumed-environment-context-session';
    const filePath = path.join(sandbox, `${sessionId}.jsonl`);
    const environment = '<environment_context>workspace</environment_context>';
    const image = 'data:image/png;base64,YQ==';
    const rows = [
      attestedUser([{ type: 'input_text', text: 'prior prompt' }], ['user.text'], 'prior-user'),
      assistant('prior answer'),
      attestedUser(
        [{ type: 'input_text', text: environment }],
        ['environments.environment_context'],
        'resumed-environment',
      ),
      attestedUser([{ type: 'input_text', text: 'current prompt' }], ['user.text'], 'current-user'),
      attestedUser([{ type: 'input_text', text: environment }], [], 'literal-user'),
      attestedUser(
        [{ type: 'input_text', text: environment }, { type: 'input_text', text: 'malformed tail' }],
        ['environments.environment_context'],
        'malformed-user',
      ),
      attestedUser(
        [
          { type: 'input_text', text: environment },
          { type: 'input_text', text: 'mixed tail' },
          { type: 'input_image', image_url: image },
        ],
        ['environments.environment_context', 'user.text', 'user.image'],
        'mixed-user',
      ),
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const history = await new CodexSessionsProvider().fetchHistory(sessionId);
    const users = history.messages.filter((row) => row.role === 'user');

    assert.deepEqual(users.map((row) => row.content), [
      'prior prompt',
      'current prompt',
      environment,
      `${environment}\nmalformed tail`,
      `${environment}\nmixed tail`,
    ]);
    assert.deepEqual(users.at(-1)?.images, [image]);
  });

  it('preserves literal image tags and whitespace in text without an input_image attachment', async () => {
    const sessionId = 'literal-image-tags-session';
    const filePath = path.join(sandbox, 'literal-image-tags.jsonl');
    const text = '  Explain this markup:\n<image>\nexample\n</image>\n  ';
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);
    const history = await new CodexSessionsProvider().fetchHistory(sessionId);
    assert.equal(history.messages[0]?.content, text);
  });

  it('preserves the SDK assistant item id as the durable history identity', async () => {
    const sessionId = 'durable-assistant-id-session';
    const filePath = path.join(sandbox, 'durable-assistant-id-rollout.jsonl');
    fs.writeFileSync(filePath, `${JSON.stringify({
      timestamp: '2026-08-17T10:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg_fixture_sdk_attested_1',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'durable' }],
      },
    })}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const history = await new CodexSessionsProvider().fetchHistory(sessionId);
    assert.equal(history.messages[0]?.id, 'msg_fixture_sdk_attested_1');
    assert.equal(history.messages[0]?.isFinalAnswer, true);
  });

  it('hydrates embedded input_image data URLs without duplicating Codex user echoes', async () => {
    const sessionId = 'embedded-image-session';
    const filePath = path.join(sandbox, 'embedded-image-rollout.jsonl');
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const timestamp = '2026-08-17T10:00:00.000Z';
    const rows = [
      {
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1] path="/tmp/removed.png">' },
            { type: 'input_image', image_url: image },
            { type: 'input_text', text: '</image>' },
            { type: 'input_text', text: '  افحص هذه الصورة \n' },
          ],
        },
      },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: '  افحص هذه الصورة \n' } },
      assistant('تم'),
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const history = await new CodexSessionsProvider().fetchHistory(sessionId);
    const userRows = history.messages.filter((message) => message.role === 'user');

    assert.equal(userRows.length, 1, 'response_item + event_msg describe one user turn');
    assert.equal(userRows[0].content, '  افحص هذه الصورة \n');
    assert.deepEqual(userRows[0].images, [image]);
  });

  it('uses the response_item text fallback and rejects active SVG image data', async () => {
    const sessionId = 'embedded-image-fallback-session';
    const filePath = path.join(sandbox, 'embedded-image-fallback-rollout.jsonl');
    const safeImage = 'data:image/jpeg;base64,/9j/4AAQ';
    const activeSvg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;
    const rows = [
      {
        timestamp: '2026-08-17T10:01:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1] path="/tmp/removed.jpeg">' },
            { type: 'input_image', image_url: activeSvg },
            ...Array.from({ length: 16 }, () => ({ type: 'input_image', image_url: safeImage })),
            { type: 'input_text', text: '</image>' },
            { type: 'input_text', text: 'fallback text' },
          ],
        },
      },
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const history = await new CodexSessionsProvider().fetchHistory(sessionId);

    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].content, 'fallback text');
    assert.deepEqual(history.messages[0].images, Array.from({ length: 15 }, () => safeImage));
    assert.equal(
      history.messages[0].imagesOmitted,
      2,
      'only the rejected SVG and the 16th valid image count as omitted',
    );
  });

  it('keeps an image-only user turn even when Codex emits no visible user_message echo', async () => {
    const sessionId = 'embedded-image-only-session';
    const filePath = path.join(sandbox, 'embedded-image-only-rollout.jsonl');
    const image = 'data:image/webp;base64,UklGRg==';
    const row = {
      timestamp: '2026-08-17T10:02:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<image name=[Image #1] path="/tmp/removed.webp">' },
          { type: 'input_image', image_url: image },
          { type: 'input_text', text: '</image>' },
        ],
      },
    };
    fs.writeFileSync(filePath, `${JSON.stringify(row)}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const history = await new CodexSessionsProvider().fetchHistory(sessionId);

    assert.equal(history.messages.length, 1);
    assert.equal(history.messages[0].content, '');
    assert.deepEqual(history.messages[0].images, [image]);
  });

  it('re-validates embedded images at the public normalization boundary', () => {
    const safeImage = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    const provider = new CodexSessionsProvider();
    const [message] = provider.normalizeMessage({
      type: 'user',
      message: {
        role: 'user',
        content: 'hello',
        images: [safeImage, 'https://example.test/tracker.png', 'data:image/svg+xml;base64,PHN2Zy8+'],
      },
    }, 'normalize-image-session');

    assert.deepEqual(message.images, [safeImage]);
  });

  it('accepts the exact data URL limit, rejects +1, and enforces the per-message total', () => {
    const prefix = 'data:image/png;base64,';
    const exact = prefix + 'A'.repeat((7 * 1024 * 1024) - prefix.length);
    const over = `${exact}A`;
    const provider = new CodexSessionsProvider();

    const [atLimit] = provider.normalizeMessage({
      type: 'user',
      message: { role: 'user', content: 'exact', images: [exact] },
    }, 'exact-image-session');
    const [overLimit] = provider.normalizeMessage({
      type: 'user',
      message: { role: 'user', content: 'over', images: [over] },
    }, 'over-image-session');
    const [messageTotal] = provider.normalizeMessage({
      type: 'user',
      message: { role: 'user', content: 'total', images: [exact, exact, exact] },
    }, 'total-image-session');

    assert.equal((atLimit.images as string[])[0].length, 7 * 1024 * 1024);
    assert.equal(atLimit.imagesOmitted, undefined);
    assert.equal(overLimit.images, undefined);
    assert.equal(overLimit.imagesOmitted, 1);
    assert.equal((messageTotal.images as string[]).length, 2);
    assert.equal(messageTotal.imagesOmitted, 1);
  });

  it('caps accumulated history image data and evicts oldest images while retaining newest', async () => {
    const sessionId = 'embedded-image-request-cap-session';
    const filePath = path.join(sandbox, 'embedded-image-request-cap-rollout.jsonl');
    const prefix = 'data:image/png;base64,';
    const image = prefix + 'A'.repeat((7 * 1024 * 1024) - prefix.length);
    const file = fs.openSync(filePath, 'w');
    try {
      for (let index = 0; index < 5; index += 1) {
        const timestamp = `2026-08-17T10:10:0${index}.000Z`;
        const response = {
          timestamp,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_image', image_url: image },
              { type: 'input_text', text: `turn ${index}` },
            ],
          },
        };
        const echo = {
          timestamp,
          type: 'event_msg',
          payload: { type: 'user_message', message: `turn ${index}` },
        };
        fs.writeSync(file, `${JSON.stringify(response)}\n${JSON.stringify(echo)}\n`);
      }
    } finally {
      fs.closeSync(file);
    }
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const history = await new CodexSessionsProvider().fetchHistory(sessionId);
    const userRows = history.messages.filter((message) => message.role === 'user');
    const retainedChars = userRows.reduce(
      (total, message) => total + (Array.isArray(message.images)
        ? message.images.reduce((sum: number, candidate: unknown) => sum + String(candidate).length, 0)
        : 0),
      0,
    );

    assert.ok(retainedChars <= 32 * 1024 * 1024);
    assert.equal(userRows[0].images, undefined, 'oldest image must be evicted first');
    assert.equal(userRows[0].imagesOmitted, 1);
    assert.deepEqual(userRows.at(-1)?.images, [image], 'newest image must survive eviction');
  });

  it('does not deduplicate a same-text event when another JSONL record intervenes', async () => {
    const sessionId = 'embedded-image-non-adjacent-session';
    const filePath = path.join(sandbox, 'embedded-image-non-adjacent-rollout.jsonl');
    const timestamp = '2026-08-17T10:20:00.000Z';
    const rows = [
      {
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_text', text: 'same text' },
          ],
        },
      },
      { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {} } },
      { timestamp, type: 'event_msg', payload: { type: 'user_message', message: 'same text' } },
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const history = await new CodexSessionsProvider().fetchHistory(sessionId);

    assert.equal(history.messages.filter((message) => message.role === 'user').length, 2);
  });

  it('returns latest context occupancy and keeps cumulative coordinator usage separate', async () => {
    const sessionId = 'token-usage-session';
    const filePath = path.join(sandbox, 'token-usage-rollout.jsonl');
    const rows = [
      {
        timestamp: '2026-09-13T10:00:00.000Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-token-usage', model: 'gpt-5.6-sol' },
      },
      {
        timestamp: '2026-09-13T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 400000,
            last_token_usage: { input_tokens: 900, output_tokens: 100, total_tokens: 1000 },
            total_token_usage: { input_tokens: 9000, output_tokens: 1000, total_tokens: 10000 },
          },
        },
      },
      user('latest prompt'),
      assistant('latest answer'),
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const history = await new CodexSessionsProvider().fetchHistory(sessionId);

    assert.ok(history.tokenUsage?.cacheSnapshot);
    const { cacheSnapshot, contextSnapshot, ...usage } = history.tokenUsage;
    assert.ok(Number.isFinite(Date.parse(cacheSnapshot.receivedAt)));
    assert.deepEqual({ ...cacheSnapshot, receivedAt: null }, {
      version: 1, provider: 'codex', sessionId, modelId: 'gpt-5.6-sol', scope: 'last_request',
      source: 'codex.token_count', transport: 'history', observedAt: '2026-09-13T10:00:01.000Z', receivedAt: null,
      eventId: null, sequence: null, inputTokens: 900, cacheReadTokens: null, cacheWriteTokens: null,
    });
    assert.deepEqual(contextSnapshot, {
      version: 1, provider: 'codex', sessionId, modelId: 'gpt-5.6-sol', usedTokens: 1000,
      windowTokens: 400000, usageKind: 'native_reported_context', source: 'codex.token_count',
      observedAt: '2026-09-13T10:00:01.000Z', nativeCompactTokens: null, proposedCompactTokens: null, newSessionTokens: null,
    });
    assert.deepEqual(usage, {
      used: 1000,
      total: 400000,
      totalReported: true,
      inputTokens: 900,
      outputTokens: 100,
      breakdown: { input: 900, output: 100 },
      cumulativeUsed: 10000,
      cumulativeInputTokens: 9000,
      cumulativeOutputTokens: 1000,
      cumulativeReported: true,
    });
  });

  it('keeps the newest growing context then invalidates it on compaction', async () => {
    const sessionId = 'token-growth-compaction-session';
    const filePath = path.join(sandbox, `${sessionId}.jsonl`);
    const token = (timestamp: string, total: number) => ({
      timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
        model_context_window: 400000,
        last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: total },
      } },
    });
    const rows = [
      { timestamp: '2026-09-13T10:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
      token('2026-09-13T10:00:01.000Z', 1000),
      token('2026-09-13T10:00:02.000Z', 2400),
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);
    const provider = new CodexSessionsProvider();
    assert.equal((await provider.fetchHistory(sessionId)).tokenUsage?.contextSnapshot?.usedTokens, 2400);

    fs.appendFileSync(filePath, `${JSON.stringify({
      timestamp: '2026-09-13T10:00:03.000Z', type: 'event_msg', payload: { type: 'context_compacted' },
    })}\n`);
    assert.equal((await provider.fetchHistory(sessionId)).tokenUsage, null);
  });

  it('does not revive invalidated usage from a delayed pre-boundary token row', async () => {
    const sessionId = 'token-late-history-session';
    const filePath = path.join(sandbox, `${sessionId}.jsonl`);
    const rows = [
      { timestamp: '2026-09-13T10:00:00.000Z', type: 'turn_context', payload: { model: 'model-a' } },
      { timestamp: '2026-09-13T10:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
        model_context_window: 1000, last_token_usage: { total_tokens: 800 },
      } } },
      { timestamp: '2026-09-13T10:00:05.000Z', type: 'turn_context', payload: { model: 'model-b' } },
      // Appended later but provider-observed before the model boundary.
      { timestamp: '2026-09-13T10:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: {
        model_context_window: 1000, last_token_usage: { total_tokens: 900 },
      } } },
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);
    assert.equal((await new CodexSessionsProvider().fetchHistory(sessionId)).tokenUsage, null);
  });

  it('restores Codex subagent requests as Task rows on reloaded history', async () => {
    const sessionId = 'codex-subagent-history-session';
    const filePath = path.join(sandbox, 'codex-subagent-history-rollout.jsonl');
    const rows = [
      {
        timestamp: '2026-08-18T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, session_id: sessionId, cwd: '/workspace/demo' },
      },
      user('راجع هذا التغيير'),
      {
        timestamp: '2026-08-18T10:00:01.000Z',
        ...spawnAgent('spawn-1', 'qa_critic'),
      },
      {
        timestamp: '2026-08-18T10:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          kind: 'started',
          event_id: 'spawn-1',
          agent_thread_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          agent_path: '/root/qa_critic',
        },
      },
      {
        timestamp: '2026-08-18T10:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          id: 'agent-msg-1',
          author: '/root/qa_critic',
          content: [{
            type: 'output_text',
            text: 'Message Type: FINAL_ANSWER\nSender: /root/qa_critic\nPayload:\nوجدت مشكلة اختبار واحدة.',
          }],
        },
      },
      assistant('تمت المراجعة'),
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const changesBeforeRead = getConnection().prepare('SELECT total_changes() AS count').get() as { count: number };
    const history = await new CodexSessionsProvider().fetchHistory(sessionId);
    const changesAfterRead = getConnection().prepare('SELECT total_changes() AS count').get() as { count: number };
    const taskRow = history.messages.find((message) => message.kind === 'tool_use' && message.toolName === 'Task');

    assert.ok(taskRow, 'spawn_agent must survive reload as a Task row');
    assert.equal(taskRow?.toolId, 'spawn-1');
    assert.match(String(taskRow?.toolInput), /Qa Critic/);
    assert.equal(taskRow?.toolResult?.content, 'وجدت مشكلة اختبار واحدة.');
    assert.equal(
      changesAfterRead.count,
      changesBeforeRead.count,
      'history reconstruction must be read-only and must not mutate review lifecycle state',
    );
  });

  it('pages by stable cursors and starts each page at its human prompt', async () => {
    const sessionId = 'pagination-session';
    const filePath = path.join(sandbox, 'rollout.jsonl');
    const rows = [
      user('first prompt'),
      ...Array.from({ length: 25 }, (_, index) => assistant(`first ${index}`)),
      user('second prompt'),
      ...Array.from({ length: 25 }, (_, index) => assistant(`second ${index}`)),
    ];
    fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);

    const provider = new CodexSessionsProvider();
    const latest = await provider.fetchHistory(sessionId, { limit: 20 });
    assert.equal(latest.messages[0]?.content, 'second prompt');
    assert.equal(latest.messages.length, 26);
    assert.equal(latest.hasMore, true);
    assert.equal(typeof latest.nextCursor, 'string');

    const earlier = await provider.fetchHistory(sessionId, {
      limit: 20,
      cursor: latest.nextCursor ?? undefined,
    });
    assert.equal(earlier.messages[0]?.content, 'first prompt');
    assert.equal(earlier.messages.length, 26);
    assert.equal(earlier.hasMore, false);
    assert.equal(earlier.nextCursor, null);
    assert.equal(
      earlier.messages.some((message) => latest.messages.some((other) => other.id === message.id)),
      false,
    );
  });

  it('rejects a correctly signed version-one cursor after bootstrap filtering changes pagination', async () => {
    const sessionId = 'stale-v1-cursor-session';
    const filePath = path.join(sandbox, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, `${JSON.stringify(user('prompt'))}\n`);
    sessionsDb.createSession(sessionId, 'codex', '/workspace/demo', undefined, undefined, undefined, filePath);
    const body = Buffer.from(JSON.stringify({
      v: 1,
      sessionId,
      beforeId: 'old-before',
      snapshotTailId: 'old-tail',
      totalAtSnapshot: 1,
    }), 'utf8').toString('base64url');
    const signature = createHmac('sha256', appConfigDb.getOrCreateJwtSecret()).update(body).digest('base64url');

    await assert.rejects(
      new CodexSessionsProvider().fetchHistory(sessionId, { limit: 20, cursor: `${body}.${signature}` }),
      (error: any) => error?.code === 'CURSOR_STALE' && error?.statusCode === 409,
    );
  });
});
