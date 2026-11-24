/** T-2094: generic ACP session client (lifecycle, suppression, permission policy). */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  createAcpSessionClient,
  createAutoAllowPermissionPolicy,
  isAcpAuthRequired,
  normalizeSessionUpdate,
} from './acp-session-client.js';

/** A scripted agent: `handle(method, params, msg)` answers each request. */
function scripted(handle: (m: string, p: any, send: (x: any) => void) => any, policy?: any) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const seen: any[] = [];
  const send = (x: any) => fromAgent.write(`${JSON.stringify({ jsonrpc: '2.0', ...x })}\n`);
  toAgent.on('data', (b) => {
    for (const line of String(b).split('\n').filter(Boolean)) {
      const msg = JSON.parse(line);
      seen.push(msg);
      if (msg.method === undefined) continue;
      const answer = handle(msg.method, msg.params, send);
      if (msg.id !== undefined && answer !== undefined) send({ id: msg.id, ...answer });
    }
  });
  const client = createAcpSessionClient({ input: fromAgent, output: toAgent, permissionPolicy: policy });
  return { client, seen, send };
}

const chunk = (sessionId: string, text: string) => ({
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
});

test('initialize refuses a protocol version other than 1', async () => {
  const s = scripted(() => ({ result: { protocolVersion: 2 } }));
  await assert.rejects(s.client.initialize(), (e: any) => e.code === 'acp_protocol_unsupported');
  const t = scripted(() => ({ result: { protocolVersion: 1, authMethods: [] } }));
  assert.equal((await t.client.initialize()).protocolVersion, 1);
  assert.deepEqual(t.seen[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
});

test('QA 1-b: every update between resume start and prompt is suppressed, then chunks stream', async () => {
  const s = scripted((method, params, send) => {
    if (method === 'session/resume') {
      send(chunk(params.sessionId, 'OLD REPLY'));
      return { result: {} };
    }
    if (method === 'session/prompt') {
      send(chunk(params.sessionId, 'new '));
      send(chunk(params.sessionId, 'reply'));
      return { result: { stopReason: 'end_turn' } };
    }
    return { result: {} };
  });
  await s.client.openExistingSession({ sessionId: 'S', cwd: '/w' });
  const events: any[] = [];
  const stop = await s.client.prompt({ sessionId: 'S', text: 'hi', onEvent: (e: any) => events.push(e) });
  assert.equal(stop, 'end_turn');
  assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'new reply');
  assert.deepEqual(s.seen.find((m) => m.method === 'session/prompt').params.prompt, [{ type: 'text', text: 'hi' }]);
});

test('resume failure falls back to session/load (also suppressed); auth errors are not swallowed', async () => {
  const s = scripted((method, params, send) => {
    if (method === 'session/resume') return { error: { code: -32601, message: 'Method not found' } };
    if (method === 'session/load') { send(chunk(params.sessionId, 'OLD')); return { result: null }; }
    if (method === 'session/prompt') return { result: { stopReason: 'end_turn' } };
    return { result: {} };
  });
  const r = await s.client.openExistingSession({ sessionId: 'S', cwd: '/w' });
  assert.equal(r.method, 'session/load');
  const events: any[] = [];
  await s.client.prompt({ sessionId: 'S', text: 'x', onEvent: (e: any) => events.push(e) });
  assert.deepEqual(events, []);
  const a = scripted(() => ({ error: { code: -32000, message: 'Authentication required' } }));
  await assert.rejects(a.client.openExistingSession({ sessionId: 'S', cwd: '/w' }), (e: any) => isAcpAuthRequired(e));
  assert.equal(a.seen.filter((m) => m.method === 'session/load').length, 0);
});

test('withAuth: authenticate once with the resolved method, retry once, never without a method', async () => {
  let authed = false;
  const s = scripted((method, params) => {
    if (method === 'authenticate') { authed = true; return { result: {} }; }
    if (method === 'session/new') return authed ? { result: { sessionId: 'N' } } : { error: { code: -32000, message: 'Authentication required' } };
    return { result: {} };
  });
  const r = await s.client.withAuth(() => s.client.newSession({ cwd: '/w' }), () => 'oauth-personal');
  assert.equal(r.sessionId, 'N');
  assert.deepEqual(s.seen.filter((m) => m.method === 'authenticate').map((m) => m.params), [{ methodId: 'oauth-personal' }]);
  const t = scripted(() => ({ error: { code: -32000, message: 'Authentication required' } }));
  await assert.rejects(t.client.withAuth(() => t.client.newSession({ cwd: '/w' }), () => null), (e: any) => isAcpAuthRequired(e));
  assert.equal(t.seen.filter((m) => m.method === 'authenticate').length, 0, 'no method → no authenticate (no browser)');
});

test('owner decision: permissions auto-allowed (allow_always, else allow_once); questions routed apart', () => {
  const questions: any[] = [];
  const policy = createAutoAllowPermissionPolicy({
    isQuestion: (toolCall: any) => String(toolCall?.toolCallId).startsWith('interaction_'),
    onQuestion: (params: any) => { questions.push(params); return { outcome: { outcome: 'cancelled' } }; },
  });
  const opts = (...kinds: string[]) => kinds.map((kind, i) => ({ optionId: `o${i}`, kind }));
  assert.deepEqual(policy({ toolCall: { toolCallId: 't' }, options: opts('allow_once', 'allow_always', 'reject_once') }),
    { outcome: { outcome: 'selected', optionId: 'o1' } });
  assert.deepEqual(policy({ toolCall: { toolCallId: 't' }, options: opts('reject_once', 'allow_once') }),
    { outcome: { outcome: 'selected', optionId: 'o1' } });
  assert.deepEqual(policy({ toolCall: { toolCallId: 't' }, options: opts('reject_once') }), { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(policy({ toolCall: { toolCallId: 'interaction_9' }, options: opts('allow_once') }), { outcome: { outcome: 'cancelled' } });
  assert.equal(questions.length, 1);
});

test('inbound request_permission goes through the injected policy', async () => {
  const s = scripted((method, params, send) => {
    if (method === 'session/prompt') {
      send({ id: 900, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCall: { toolCallId: 't' }, options: [{ optionId: 'a', kind: 'allow_once' }] } });
      return undefined;
    }
    return { result: {} };
  }, () => ({ outcome: { outcome: 'selected', optionId: 'a' } }));
  const done = s.client.prompt({ sessionId: 'S', text: 'x', onEvent() {} });
  await new Promise((r) => setTimeout(r, 20));
  const answer = s.seen.find((m) => m.id === 900);
  assert.deepEqual(answer.result, { outcome: { outcome: 'selected', optionId: 'a' } });
  s.send({ id: s.seen.find((m) => m.method === 'session/prompt').id, result: { stopReason: 'end_turn' } });
  assert.equal(await done, 'end_turn');
});

test('cancel is a notification; normalizer maps updates to neutral events', () => {
  const s = scripted(() => ({ result: {} }));
  s.client.cancel('S');
  assert.equal(normalizeSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }).type, 'text');
  assert.equal(normalizeSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'a' } }).type, 'thought');
  assert.equal(normalizeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'x' }).type, 'tool');
  assert.equal(normalizeSessionUpdate({ sessionUpdate: 'plan', entries: [] }).type, 'plan');
  assert.equal(normalizeSessionUpdate(null).type, 'other');
});
