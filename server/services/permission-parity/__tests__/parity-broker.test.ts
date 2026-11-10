/**
 * parity-broker.test — ADR-226 §2 (M3): the shared fd-3 broker core and the shared permission
 * table. Stage 0 (item 7) measured a local model server reusing one callID inside ONE session
 * for two legitimate calls, so a key may be decided again once its previous call settled; a
 * concurrent duplicate is denied. dsh keeps one decision per callId (dsh-parity-broker.js).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createParityBroker as createDshBroker } from '@/services/permission-parity/dsh-parity-broker.js';
import { argumentHash, createParityBroker } from '@/services/permission-parity/parity-broker.js';
import {
  cancelAllParityPermissions, cancelParityPermissionsForRun, isParityPermissionPending, requestParityPermission, resolveParityPermission,
} from '@/services/permission-parity/parity-permissions.js';
import { requestDshPermission, resolveDshPermission } from '@/modules/providers/list/dsh/dsh-permissions.js';

type Row = Record<string, any>;
const HELLO = { type: 'hello', nonce: 'n', pluginDigest: 'd', protocol: 'p' };
let seq = 0;

function broker(over: Row = {}) {
  const incidents: Row[] = [];
  const kills: number[] = [];
  const posts: Row[] = [];
  const engine = over.engine ?? { decideTool: async ({ tool }: Row) => ({ decision: tool === 'ask' ? 'ask' : tool === 'no' ? 'deny' : 'allow',
    claude: { tool_name: 'Bash', tool_input: {} }, reason: tool === 'no' ? 'denied by rule' : undefined }),
  hooks: { postToolUse: async (call: Row) => { posts.push(call); return { block: false, additionalContext: [`ctx:${call.tool_name}`] }; } } };
  const instance = createParityBroker({ engine, kill: () => kills.push(1), onIncident: (i: Row) => incidents.push(i),
    helloPolicy: { nonce: 'n', pluginDigest: 'd', protocol: 'p' }, ...over });
  return { instance, incidents, kills, posts };
}
const pre = (b: Row, sessionID: string, callID: string, tool = 'bash', args: Row = { command: 'echo x' }, extra: Row = {}) =>
  b.receive({ type: 'pre', id: `r${(seq += 1)}`, sessionID, callID, tool, args, ...extra });
const post = (b: Row, sessionID: string, callID: string, extra: Row = {}) =>
  b.receive({ type: 'post', id: `r${(seq += 1)}`, sessionID, callID, output: 'ok', ...extra });

describe('ADR-226 parity broker core', () => {
  it('hello: the per-turn nonce, digest and protocol; a second hello is refused; calls before it are denied', async () => {
    const { instance, kills } = broker();
    assert.equal((await pre(instance, 's', 'c0')).decision, 'deny');
    assert.equal((await instance.receive({ ...HELLO, id: 1 })).ok, true);
    assert.equal(await instance.handshake, true);
    assert.equal((await instance.receive({ ...HELLO, id: 2 })).ok, false);
    assert.equal(instance.state.refusal, 'parity_hello_refused');
    assert.equal(kills.length, 1);
    for (const field of ['nonce', 'pluginDigest', 'protocol']) {
      const other = broker();
      assert.equal((await other.instance.receive({ ...HELLO, [field]: 'wrong' })).ok, false, field);
      assert.equal(await other.instance.handshake, false);
      assert.equal(other.kills.length, 1);
    }
    const unset = broker({ helloPolicy: {} });
    assert.equal((await unset.instance.receive(HELLO)).ok, false, 'no expected value: refused, never open');
  });

  it('stage 0 item 7: one session may reuse a callID once the previous call settled; concurrent duplicates are denied', async () => {
    const { instance, incidents } = broker();
    await instance.receive(HELLO);
    assert.equal((await pre(instance, 's1', 'call_fixed')).decision, 'allow');
    assert.equal((await pre(instance, 's1', 'call_fixed')).decision, 'deny', 'the first call has not settled');
    assert.equal(incidents.filter((i) => i.code === 'parity_call_replayed').length, 1);
    await post(instance, 's1', 'call_fixed');
    assert.equal((await pre(instance, 's1', 'call_fixed')).decision, 'allow', 'settled: the id may be reused');
    assert.equal((await pre(instance, 's1', 'deny_id', 'no')).decision, 'deny');
    assert.equal((await pre(instance, 's1', 'deny_id')).decision, 'allow', 'a deny settles at once');
    // OpenCode fires no tool.execute.after when the body throws: its stdout result settles the call.
    assert.equal((await pre(instance, 's1', 'thrown', 'bash', { command: 'false' })).decision, 'allow');
    instance.toolResult({ sessionID: 's1', callID: 'thrown', input: { command: 'false' }, status: 'error' });
    assert.equal((await pre(instance, 's1', 'thrown', 'bash', { command: 'false' })).decision, 'allow', 'settled by its result');
  });

  it('the decision is the engine\'s; ask goes to the member and only approve allows', async () => {
    const answers = ['approve', 'reject'];
    const cards: Row[] = [];
    const { instance } = broker({ askMember: async (card: Row) => { cards.push(card); return answers.shift(); } });
    await instance.receive(HELLO);
    assert.equal((await pre(instance, 's', 'a1', 'ask')).decision, 'allow');
    assert.equal((await pre(instance, 's', 'a2', 'ask')).decision, 'deny');
    assert.equal(cards[0].sessionID, 's');
    assert.deepEqual(cards[0].args, { command: 'echo x' }, 'H2: the card carries the harness arguments');
    const silent = broker();
    await silent.instance.receive(HELLO);
    assert.equal((await pre(silent.instance, 's', 'a3', 'ask')).decision, 'deny', 'no askMember: deny');
    assert.equal((await pre(silent.instance, 's', 'n1', 'no')).reason, 'denied by rule');
  });

  it('the argument hash is checked when the plugin sends one; args that are not plain JSON are denied', async () => {
    const { instance } = broker();
    await instance.receive(HELLO);
    const args = { command: 'echo h' };
    assert.equal((await pre(instance, 's', 'h1', 'bash', args, { hash: argumentHash(args) })).decision, 'allow');
    assert.equal((await pre(instance, 's', 'h2', 'bash', args, { hash: 'other' })).decision, 'deny');
    assert.equal((await pre(instance, 's', 'h3', 'bash', { n: Number.NaN })).decision, 'deny');
  });

  it('post: PostToolUse for every Claude call of a multi-call decision', async () => {
    const engine = { decideTool: async () => ({ decision: 'allow', claude: { tool_name: 'Edit', tool_input: { file_path: '/a' } },
      claudeCalls: [{ tool_name: 'Edit', tool_input: { file_path: '/a' } }, { tool_name: 'Edit', tool_input: { file_path: '/b' } }] }),
    hooks: { postToolUse: async (call: Row) => ({ block: call.tool_input.file_path === '/b', reason: 'blocked b', additionalContext: [call.tool_input.file_path] }) } };
    const { instance } = broker({ engine });
    await instance.receive(HELLO);
    await pre(instance, 's', 'p1', 'apply_patch', { patchText: 'x' });
    const reply = await post(instance, 's', 'p1');
    assert.deepEqual([reply.block, reply.reason, reply.additionalContext], [true, 'blocked b', ['/a', '/b']]);
  });

  it('toolResult (strictFailures): a part with no decision, or a denied call that completed, kills; a denied failure does not', async () => {
    const { instance, kills } = broker({ strictFailures: true });
    await instance.receive(HELLO);
    const args = { command: 'echo r' };
    await pre(instance, 'main', 'ok1', 'bash', args);
    assert.equal(instance.toolResult({ sessionID: 'main', callID: 'ok1', input: args, status: 'completed' }), true);
    await pre(instance, 'main', 'den1', 'no', args);
    instance.toolResult({ sessionID: 'main', callID: 'den1', input: args, status: 'error' });
    assert.equal(kills.length, 0);
    instance.toolResult({ sessionID: 'main', callID: 'ok1', input: { command: 'echo other' }, status: 'completed' });
    assert.equal(kills.length, 1, 'hash differs from the allowed args');
    const fresh = broker({ strictFailures: true });
    await fresh.instance.receive(HELLO);
    fresh.instance.toolResult({ sessionID: 'main', callID: 'never', input: {}, status: 'error' });
    assert.equal(fresh.instance.state.killCode, 'parity_undecided_result', 'the hook never fired for it');
    const done = broker({ strictFailures: true });
    await done.instance.receive(HELLO);
    await pre(done.instance, 'main', 'den2', 'no', args);
    done.instance.toolResult({ sessionID: 'main', callID: 'den2', input: args, status: 'completed' });
    assert.equal(done.kills.length, 1, 'a denied call cannot complete');
  });

  it('dsh keeps one decision per callId and the mandatory hash (wrapper options)', async () => {
    const incidents: Row[] = [];
    const engine = { decideTool: async () => ({ decision: 'allow', claude: { tool_name: 'Bash', tool_input: {} } }) };
    const dsh = createDshBroker({ engine, kill: () => {}, onIncident: (i: Row) => incidents.push(i), askMember: async () => 'reject' });
    await dsh.receive({ type: 'hello', protocol: 2, probes: { P1: { ok: true }, P2: { ok: true } }, tools: [] });
    const args = { command: 'ls', description: 'd' };
    const frame = (id: string) => ({ type: 'pre', id, callId: 'same', tool: 'bash', args, hash: argumentHash(args) });
    assert.equal((await dsh.receive(frame('1'))).decision, 'allow');
    await dsh.receive({ type: 'post', id: '2', callId: 'same', hash: argumentHash(args), output: '' });
    assert.equal((await dsh.receive(frame('3'))).decision, 'deny', 'dsh: never reused');
    assert.equal((await dsh.receive({ type: 'pre', id: '4', callId: 'nohash', tool: 'bash', args })).decision, 'deny', 'dsh: hash required');
  });
});

describe('ADR-226 shared permission table', () => {
  const writer = () => {
    const frames: Row[] = [];
    return { frames, send: (m: Row) => frames.push(m) };
  };

  it('a request carries its provider; the object-form answer settles it once, owner only', async () => {
    const w = writer();
    const asked = requestParityPermission({ provider: 'opencode', runId: 'r1', ownerUserId: 7, sessionId: 's', toolName: 'Bash', input: {}, writer: w });
    const card = w.frames[0];
    assert.equal(card.kind, 'permission_request');
    assert.equal(card.provider, 'opencode');
    assert.match(card.requestId, /^opencode-perm-/);
    assert.equal(resolveParityPermission({ requestId: card.requestId, allow: true, requesterUserId: 8 }), false, 'foreign answer');
    assert.equal(resolveParityPermission({ requestId: card.requestId, allow: true, requesterUserId: 7 }), true);
    assert.equal(await asked, 'allow');
    assert.equal(resolveParityPermission(card.requestId, { allow: true }), false, 'once only');
  });

  it('M11: an answer with updatedInput rejects; rememberEntry is allow-once', async () => {
    const w = writer();
    const asked = requestParityPermission({ provider: 'opencode', runId: 'r2', ownerUserId: 7, sessionId: 's', toolName: 'Bash', input: {}, writer: w });
    resolveParityPermission({ requestId: w.frames[0].requestId, allow: true, updatedInput: { command: 'other' } });
    assert.equal(await asked, 'reject');
    const again = requestParityPermission({ provider: 'opencode', runId: 'r2', ownerUserId: 7, sessionId: 's', toolName: 'Bash', input: {}, writer: w });
    resolveParityPermission(w.frames[1].requestId, { allow: true, rememberEntry: 'Bash(x:*)' } as Row);
    assert.equal(await again, 'allow');
  });

  it('dsh questions live in the same table, keep the ACP outcome and ignore updatedInput', async () => {
    const w = writer();
    const options = [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }];
    const asked = requestDshPermission({ runId: 'r3', ownerUserId: 7, sessionId: 's', toolName: 'bash', input: {}, options, writer: w });
    assert.equal(w.frames[0].provider, 'dsh');
    assert.equal(resolveParityPermission({ requestId: w.frames[0].requestId, allow: true, updatedInput: { x: 1 } }), true);
    assert.deepEqual(await asked, { outcome: 'selected', optionId: 'allow-once' });
    const second = requestDshPermission({ runId: 'r3', ownerUserId: 7, sessionId: 's', toolName: 'bash', input: {}, options, writer: w });
    assert.equal(resolveDshPermission(w.frames[1].requestId, { allow: false }), true);
    assert.deepEqual(await second, { outcome: 'selected', optionId: 'reject-once' });
  });

  it('timeout, run cancel and drain cancel settle without approving', async () => {
    const w = writer();
    assert.equal(await requestParityPermission({ provider: 'opencode', runId: 'r4', ownerUserId: 7, sessionId: 's', toolName: 'Bash', input: {}, writer: w, timeoutMs: 5 }), 'timeout');
    const byRun = requestParityPermission({ provider: 'opencode', runId: 'r5', ownerUserId: 7, sessionId: 's', toolName: 'Bash', input: {}, writer: w });
    const id = w.frames.filter((f) => f.kind === 'permission_request').at(-1).requestId;
    assert.equal(isParityPermissionPending(id), true);
    cancelParityPermissionsForRun('r5');
    assert.equal(await byRun, 'cancel');
    const byDrain = requestParityPermission({ provider: 'opencode', runId: 'r6', ownerUserId: 7, sessionId: 's', toolName: 'Bash', input: {}, writer: w });
    assert.equal(cancelAllParityPermissions(), 1);
    assert.equal(await byDrain, 'cancel');
    assert.ok(w.frames.some((f) => f.kind === 'permission_cancelled' && f.reason === 'timeout'));
  });

  it('a closed socket rejects at once', async () => {
    const w = { ...writer(), ws: { readyState: 3, once() {}, off() {} } };
    assert.equal(await requestParityPermission({ provider: 'opencode', runId: 'r7', ownerUserId: 7, sessionId: 's', toolName: 'Bash', input: {}, writer: w }), 'offline');
  });
});
