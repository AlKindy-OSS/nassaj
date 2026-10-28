/**
 * ADR-219 tests 2, 3, 4, 7, 9, 12, 13 — the in-process PreToolUse routing, fed
 * the REAL CLI 2.1.306 hook inputs (fixtures/peer-relay.real.json): SendMessage
 * and ListAgents in bypassPermissions, and a subagent call carrying agent_id.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildPeerRelayHookMatcher, decidePeerToolUse, PEER_HOOK_MATCHER, type PeerHookDependencies } from '../peer-hook.js';
import { classifyRecipient } from '../peer-recipient.js';
import type { PeerSendRequest } from '../peer-relay.service.js';
import { createPeerRunState, createPeerDeliveryTurn, type PeerRunState } from '../peer-run.js';
import { formatSessionList } from '../peer-relay.service.js';

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../__fixtures__/peer-relay.real.json'), 'utf8'));
const [listAgentsInput, sendMessageInput] = fixture.preToolUseInputs as Array<Record<string, unknown>>;
const subagentInput = fixture.subagentPreToolUseInput as Record<string, unknown>;
const REAL_AGENT_ID = subagentInput.agent_id as string;

type Harness = { deps: PeerHookDependencies; sends: PeerSendRequest[]; audits: string[] };

function harness(overrides: Partial<PeerHookDependencies> = {}): Harness {
  const sends: PeerSendRequest[] = [];
  const audits: string[] = [];
  const deps: PeerHookDependencies = {
    isKnownAgent: (_sid, value) => value === 'af6f1f72c47f9b6ff',
    agentOriginHop: () => 0,
    listOwnSessions: (userId) => (userId === 7 ? [{ sessionId: 's-1', title: 'demo' }, { sessionId: 's-2', title: 'notes' }] : []),
    formatSessionList,
    enqueue: (request) => {
      sends.push(request);
      return { status: 'queued', id: 'pm_1', text: 'SUCCESS (not an error): queued' };
    },
    audit: (action) => { audits.push(action); },
    ...overrides,
  };
  return { deps, sends, audits };
}

function relayRun(extra: Partial<Parameters<typeof createPeerRunState>[0]> = {}): PeerRunState {
  return createPeerRunState({ activeMemberCount: 3, userId: 7, sessionId: null, permissionMode: 'bypassPermissions', ...extra });
}

const reasonOf = (decision: unknown): string | null =>
  (decision as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? null;

test('D1: one member ⇒ native (no-op); more ⇒ relay', () => {
  const native = createPeerRunState({ activeMemberCount: 1, userId: 7, sessionId: null, permissionMode: 'default' });
  assert.equal(native.relayMode, 'native');
  assert.deepEqual(decidePeerToolUse(native, sendMessageInput, harness().deps), {});
  assert.deepEqual(decidePeerToolUse(native, listAgentsInput, harness().deps), {});
  assert.equal(relayRun().relayMode, 'relay');
  assert.ok(PEER_HOOK_MATCHER.split('|').includes('SendMessage') && PEER_HOOK_MATCHER.split('|').includes('Workflow'));
});

test('test 2: a real bypass-mode session SendMessage is intercepted, queued, and stated as success', () => {
  const h = harness();
  const decision = decidePeerToolUse(relayRun(), sendMessageInput, h.deps);
  assert.match(reasonOf(decision) ?? '', /^SUCCESS \(not an error\)/u);
  assert.equal(h.sends.length, 1);
  const [send] = h.sends;
  assert.equal(send!.targetSessionId, 's-1');
  assert.equal(send!.message, 'hello');
  assert.equal(send!.senderSessionId, 'redacted-session', 'sender id from the hook input session_id');
  assert.equal(send!.hop, 1);
  assert.equal(send!.run.userId, 7, 'identity from the run entry, never from the input');
});

test('test 7: ListAgents returns only the caller user\'s sessions, no cwd, pid or socket', () => {
  const text = reasonOf(decidePeerToolUse(relayRun(), listAgentsInput, harness().deps))!;
  assert.match(text, /nassaj:s-1 — demo/u);
  assert.match(text, /nassaj:s-2 — notes/u);
  assert.ok(!/\/redacted|cwd|pid|\.sock/u.test(text), text);
  const other = reasonOf(decidePeerToolUse(relayRun({ userId: 9 }), listAgentsInput, harness().deps))!;
  assert.ok(!other.includes('s-1'), 'another user sees none of user 7\'s sessions');
});

test('tests 3/9: subagent recipients pass untouched (registry match, unregistered agentId audited)', () => {
  const h = harness();
  const toKnown = { ...sendMessageInput, tool_input: { to: 'af6f1f72c47f9b6ff', message: 'continue' } };
  assert.deepEqual(decidePeerToolUse(relayRun(), toKnown, h.deps), {});
  assert.deepEqual(decidePeerToolUse(relayRun(), { ...toKnown, tool_input: { to: 'main', message: 'x' } }, h.deps), {});
  // Born-then-send race / post-restart gap: the real agent id is not in the registry yet.
  const toNew = { ...sendMessageInput, tool_input: { to: REAL_AGENT_ID, message: 'next' } };
  assert.deepEqual(decidePeerToolUse(relayRun(), toNew, h.deps), {});
  assert.deepEqual(h.audits, ['peer_relay_unregistered_agent_send']);
  assert.equal(h.sends.length, 0);
});

test('test 9: an unresolved session-shaped address is denied (fail closed)', () => {
  const h = harness();
  for (const to of ['nobody-here', 'uds:/run/user/1000/cc-socks/123.sock', 'ghost [zz-9]']) {
    const reason = reasonOf(decidePeerToolUse(relayRun(), { ...sendMessageInput, tool_input: { to, message: 'x' } }, h.deps));
    assert.match(reason ?? '', /^refused:/u, to);
  }
  assert.equal(h.sends.length, 0);
  const ctx = { isKnownAgent: () => false, listedSessions: () => [{ sessionId: 's-2', title: 'notes' }] };
  assert.deepEqual(classifyRecipient('notes', ctx), { kind: 'relay', target: { sessionId: 's-2' } });
  assert.deepEqual(classifyRecipient('notes [s-2]', ctx), { kind: 'relay', target: { sessionId: 's-2' } });
});

test('structured messages to a session and empty bodies are refused', () => {
  const h = harness();
  const structured = { ...sendMessageInput, tool_input: { to: 'nassaj:s-1', message: { type: 'shutdown_response' } } };
  assert.match(reasonOf(decidePeerToolUse(relayRun(), structured, h.deps)) ?? '', /structured/u);
  const empty = { ...sendMessageInput, tool_input: { to: 'nassaj:s-1', message: '   ' } };
  assert.match(reasonOf(decidePeerToolUse(relayRun(), empty, h.deps)) ?? '', /empty/u);
  assert.equal(h.sends.length, 0);
});

test('tests 4/12: scheduling tools are denied in a peer-woken run, subagent calls (agent_id) included', () => {
  const delivery = createPeerDeliveryTurn({ peerMessageId: 'pm', chainId: 'pc', hop: 1, ref: 'R', fromMode: 'bypass', wrapped: 'w', onResult: () => undefined });
  const woken = relayRun({ delivery });
  for (const tool of ['CronCreate', 'ScheduleWakeup', 'RemoteTrigger', 'Workflow']) {
    const main = reasonOf(decidePeerToolUse(woken, { ...sendMessageInput, tool_name: tool, tool_input: {} }, harness().deps));
    assert.match(main ?? '', /not available/u, tool);
    const sub = reasonOf(decidePeerToolUse(woken, { ...subagentInput, tool_name: tool, tool_input: {} }, harness().deps));
    assert.match(sub ?? '', /not available/u, `${tool} from a subagent`);
    // A human run may schedule.
    assert.deepEqual(decidePeerToolUse(relayRun(), { ...subagentInput, tool_name: tool, tool_input: {} }, harness().deps), {});
  }
  assert.deepEqual(delivery.disallowedTools, ['CronCreate', 'ScheduleWakeup', 'RemoteTrigger', 'Workflow']);
  assert.equal(delivery.maxBudgetUsd, 1.5);
});

test('test 13: a subagent in a peerHop=4 run is refused; an agent born at originHop=4 stays refused in a human run', () => {
  const atCap = relayRun({ delivery: createPeerDeliveryTurn({ peerMessageId: 'pm', chainId: 'pc', hop: 4, ref: 'R', fromMode: 'bypass',
    wrapped: 'w', onResult: () => undefined }) });
  const subSend = { ...subagentInput, tool_name: 'SendMessage', tool_input: { to: 'nassaj:s-1', message: 'x' } };
  const h = harness();
  assert.match(reasonOf(decidePeerToolUse(atCap, subSend, h.deps)) ?? '', /hop limit/u);
  const born4 = harness({ agentOriginHop: (_sid, agentId) => (agentId === REAL_AGENT_ID ? 4 : 0) });
  assert.match(reasonOf(decidePeerToolUse(relayRun(), subSend, born4.deps)) ?? '', /hop limit/u);
  // The same agent born at 4 is also barred from scheduling in a human run.
  assert.match(reasonOf(decidePeerToolUse(relayRun(), { ...subSend, tool_name: 'ScheduleWakeup' }, born4.deps)) ?? '', /not available/u);
  // At hop 3 the send passes with hop 4.
  const hop3 = relayRun({ delivery: createPeerDeliveryTurn({ peerMessageId: 'pm', chainId: 'pc', hop: 3, ref: 'R', fromMode: 'bypass',
    wrapped: 'w', onResult: () => undefined }) });
  decidePeerToolUse(hop3, subSend, h.deps);
  assert.equal(h.sends.at(-1)?.hop, 4);
  assert.equal(h.sends.at(-1)?.senderAgentId, REAL_AGENT_ID);
  assert.equal(h.sends.at(-1)?.run.chainId, 'pc', 'the chain continues');
});

test('CLI version gate: an unverified CLI gets "relay unavailable" and nothing is queued', () => {
  const run = relayRun();
  run.cliVersion = '2.1.999';
  const h = harness();
  assert.equal(reasonOf(decidePeerToolUse(run, sendMessageInput, h.deps)), 'relay unavailable: unverified CLI');
  assert.equal(h.sends.length, 0);
});

test('the SDK callback never throws: a routing failure fails closed', async () => {
  const exploding = harness({ listOwnSessions: () => { throw new Error('db gone'); },
    enqueue: () => { throw new Error('db gone'); } });
  const matcher = buildPeerRelayHookMatcher(relayRun(), exploding.deps);
  assert.equal(matcher.matcher, PEER_HOOK_MATCHER);
  const [hook] = matcher.hooks;
  assert.match(reasonOf(await hook!(sendMessageInput)) ?? '', /^relay unavailable/u);
  assert.match(reasonOf(await hook!(listAgentsInput)) ?? '', /^relay unavailable/u, 'never SUCCESS on a failure');
  assert.deepEqual(await hook!({ ...subagentInput, tool_name: 'Bash' }), {});
});
