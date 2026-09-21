import assert from 'node:assert/strict';
import test from 'node:test';

import type { FetchHistoryResult } from '@/shared/types.js';

import { createVendorReceiptInvocation } from '../../shared/vendor/vendor-receipt-identity.js';
import { projectLightHistory } from '../../services/session-history-light.service.js';

import { claudeTextPayloadHash, createClaudeReceiptPrompt, createClaudeRawIdentityCollector,
  copyClaudeHistoryReceipts, projectClaudeHistoryReceipts, isTrustedClaudeActivity } from './claude-receipt-identity.js';
import { ClaudeSessionsProvider } from './claude-sessions.provider.js';


const uuid = '21111111-2222-4333-8444-555555555555';
const sid = 'test-session';
const raw = (content: unknown = 'hello') => ({ type: 'user', uuid, sessionId: sid, message: { role: 'user', content } });
const provider = new ClaudeSessionsProvider();
function history(records = [raw()], page?: number): FetchHistoryResult {
  const collector = createClaudeRawIdentityCollector(sid);
  for (const record of records) collector.observe(record, JSON.stringify(record).length);
  const messages = records.flatMap(record => provider.normalizeMessage(record, sid));
  const result = { messages: page === undefined ? messages : messages.slice(0, page), total: messages.length, hasMore: false, offset: 0, limit: null };
  return collector.attach(result, r => provider.normalizeMessage(r, sid));
}
const receipt = (patch = {}) => ({ uuid, payloadSha256: claudeTextPayloadHash('hello')!, clientMsgId: 'client-1',
  acceptedAt: '2026-09-06T00:00:00Z', lifecycleStatus: 'terminal', verdictJson: '{"kind":"complete","exitCode":0}', ...patch });
const capability = () => createVendorReceiptInvocation({ command: 'hello', options: {
  clientMsgId: 'client-1', receiptPayload: { version: 1, kind: 'text', imageCount: 0, fileCount: 0 },
} }, 1, 'client-1');

test('versioned framed payload preserves text order and fails closed for images, unknown blocks and bounds', () => {
  assert.equal(claudeTextPayloadHash('hello'), claudeTextPayloadHash([{ type: 'text', text: 'hello' }]));
  assert.notEqual(claudeTextPayloadHash([{ type: 'text', text: 'a' }, { type: 'text', text: 'bc' }]), claudeTextPayloadHash([{ type: 'text', text: 'ab' }, { type: 'text', text: 'c' }]));
  for (const content of ['', [], [{ type: 'image', source: { type: 'base64', data: 'AA==' } }],
    [{ type: 'text', text: 'x', unknown: 1 }], 'x'.repeat(1024 * 1024 + 1), Array(65).fill({ type: 'text', text: 'x' })]) assert.equal(claudeTextPayloadHash(content), null);
});

test('constructor-only fallback may consume once; cross-generator fallback after yield never resends', async () => {
  const bindings: unknown[] = [];
  const prompt = createClaudeReceiptPrompt({ capability: capability(), command: 'hello', content: 'hello',
    userId: 1, sessionId: null, release: Promise.resolve() }, input => { bindings.push(input); return true; });
  prompt.make(); // constructor failure without consuming
  const stream = prompt.make();
  const first = await stream.next();
  assert.match(first.value!.uuid!, /^[0-9a-f-]{36}$/);
  assert.equal(bindings.length, 1);
  assert.equal(prompt.wasConsumed(), true);
  await assert.rejects(prompt.make().next(), /ALREADY_DISPATCHED/);
  assert.equal(bindings.length, 1);
  await stream.next();
});

test('binding conflict blocks yield; missing completeness capability and ephemeral runs never bind', async () => {
  const input = { capability: capability(), command: 'hello', content: 'hello', userId: 1, sessionId: sid, release: Promise.resolve() };
  await assert.rejects(createClaudeReceiptPrompt(input, () => false).make().next(), /BINDING_CONFLICT/);
  for (const patch of [{ capability: undefined }, { persistSession: false }, { userId: 2 }, { content: [{ type: 'image' }] }]) {
    const stream = createClaudeReceiptPrompt({ ...input, ...patch }, () => { throw Error('must not bind'); }).make();
    assert.equal((await stream.next()).value!.uuid, undefined); await stream.next();
  }
});

test('raw trusted model excludes auth synthetic, replay, sidechains and error events', () => {
  const event = { type: 'assistant', message: { role: 'assistant', model: 'claude-real' } };
  assert.equal(isTrustedClaudeActivity(event), true);
  for (const patch of [{ isReplay: true }, { isSidechain: true }, { error: 'authentication_failed' },
    { message: { role: 'assistant', model: '<synthetic>' } }, { parent_tool_use_id: 'tool' }]) assert.equal(isTrustedClaudeActivity({ ...event, ...patch }), false);
  assert.equal(isTrustedClaudeActivity({ type: 'stream_event', event: { type: 'message_start', message: event.message } }), true);
});

test('owner-only fresh cache projection in both orders and after late acceptance preserves shared bytes', () => {
  const source = history(); const original = JSON.stringify(source);
  let accepted = false;
  const read = (owner: number) => owner === 1 ? [receipt({ acceptedAt: accepted ? 'accepted' : null })] : [];
  const cached = copyClaudeHistoryReceipts(source, structuredClone(source));
  for (const owner of [1, 2, 2, 1]) assert.equal(projectClaudeHistoryReceipts(cached, sid, owner, read).messages[0].clientMsgId, undefined);
  accepted = true;
  for (const owner of [1, 2, 2, 1]) assert.equal(projectClaudeHistoryReceipts(cached, sid, owner, read).messages[0].clientMsgId, owner === 1 ? 'client-1' : undefined);
  assert.equal(JSON.stringify(source), original); assert.equal(JSON.stringify(cached), original);
});

test('persisted user before auth failure, terminal errors, corrupt verdict and mismatched payload never prune', () => {
  for (const patch of [{ acceptedAt: null }, { lifecycleStatus: 'started' }, { verdictJson: '{"kind":"error"}' },
    { verdictJson: '{"kind":"complete","success":false,"exitCode":0}' }, { verdictJson: 'broken' }, { payloadSha256: '0'.repeat(64) }]) {
    assert.equal(projectClaudeHistoryReceipts(history(), sid, 1, () => [receipt(patch)]).messages[0].clientMsgId, undefined);
  }
  assert.equal(projectClaudeHistoryReceipts(history(), sid, 1, () => { throw Error('DB missing'); }).messages[0].clientMsgId, undefined);
});

test('duplicate UUID including foreign-session/tool records, fork, replay, synthetic and multipart are unresolved', () => {
  const variants = [
    [raw(), raw()], [raw(), { ...raw(), type: 'tool', sessionId: 'foreign' }],
    [{ ...raw(), sessionId: 'fork' }], [{ ...raw(), isReplay: true }], [{ ...raw(), isMeta: true }],
    [{ ...raw(), shouldQuery: false }], [{ ...raw(), origin: { kind: 'coordinator' } }],
    [raw([{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', data: 'AA==' } }])],
  ];
  for (const records of variants) assert.ok(projectClaudeHistoryReceipts(history(records), sid, 1, () => [receipt()]).messages.every(message => !message.clientMsgId));
});

test('every normalized text block must be present on the returned page; no prefix ID matching', () => {
  const record = raw([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]);
  const read = () => [receipt({ payloadSha256: claudeTextPayloadHash(record.message.content) })];
  assert.ok(projectClaudeHistoryReceipts(history([record], 1), sid, 1, read).messages.every(message => !message.clientMsgId));
  const full = projectClaudeHistoryReceipts(history([record]), sid, 1, read);
  assert.equal(full.messages[0].clientMsgId, 'client-1'); assert.equal(full.messages[1].clientMsgId, undefined);
});

test('captured SDK 0.3.152 / CLI 2.1.152 raw new/resume/image auth failures preserve UUID without acceptance', async () => {
  const fs = await import('node:fs/promises');
  const fixture = JSON.parse(await fs.readFile(new URL('./__tests__/__fixtures__/claude-sdk-uuid-auth-failure.json', import.meta.url), 'utf8'));
  for (const user of fixture.records.filter((row: { type: string }) => row.type === 'user')) {
    const collector = createClaudeRawIdentityCollector(user.sessionId);
    for (const row of fixture.records) collector.observe(row, JSON.stringify(row).length);
    const messages = fixture.records.flatMap((row: unknown) => provider.normalizeMessage(row, user.sessionId));
    const result = collector.attach({ messages, total: messages.length, hasMore: false, offset: 0, limit: null },
      row => provider.normalizeMessage(row, user.sessionId));
    const read = () => [receipt({ uuid: user.uuid, payloadSha256: claudeTextPayloadHash(user.message.content), acceptedAt: null })];
    assert.ok(projectClaudeHistoryReceipts(result, user.sessionId, 1, read).messages.every(row => !row.clientMsgId));
    if (Array.isArray(user.message.content)) {
      assert.equal(claudeTextPayloadHash(user.message.content), null, 'image cannot be silently discarded for correlation');
      assert.ok(provider.normalizeMessage(user, user.sessionId).every(row => !row.images), 'actual adapter drops image: scope stays text-only');
    }
  }
  assert.ok(fixture.records.filter((row: { type: string }) => row.type === 'assistant').every((row: Record<string, unknown>) => !isTrustedClaudeActivity(row)));
});

test('identical prompts with distinct exact UUIDs correlate independently; incomplete raw snapshots never prune', () => {
  const second = { ...raw(), uuid: '31111111-2222-4333-8444-555555555555' };
  const rows = [receipt(), receipt({ uuid: second.uuid, clientMsgId: 'client-2' })];
  assert.deepEqual(projectClaudeHistoryReceipts(history([raw(), second]), sid, 1, () => rows).messages.map(m => m.clientMsgId), ['client-1', 'client-2']);
  for (const invalidator of [(c: ReturnType<typeof createClaudeRawIdentityCollector>) => c.reject(),
    (c: ReturnType<typeof createClaudeRawIdentityCollector>) => c.observe({}, 33 * 1024 * 1024)]) {
    const collector = createClaudeRawIdentityCollector(sid); collector.observe(raw(), 100); invalidator(collector);
    const messages = provider.normalizeMessage(raw(), sid);
    const result = collector.attach({ messages, total: 1, hasMore: false, offset: 0, limit: null }, r => provider.normalizeMessage(r, sid));
    assert.equal(projectClaudeHistoryReceipts(result, sid, 1, () => rows).messages[0].clientMsgId, undefined);
  }
});

// ---------------- B-1078: displayClientMsgId (render pairing) vs clientMsgId (outbox deletion proof) ----------------

const fields = (result: FetchHistoryResult, index = 0) => ({
  display: result.messages[index].displayClientMsgId, prune: result.messages[index].clientMsgId,
});

test('B-1078: bound receipt still claimed or started with null acceptedAt pairs for display only', () => {
  for (const lifecycleStatus of ['claimed', 'started']) {
    const read = () => [receipt({ acceptedAt: null, lifecycleStatus, verdictJson: null })];
    assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, 1, read)), { display: 'client-1', prune: undefined });
  }
  const accepted = () => [receipt({ lifecycleStatus: 'started', verdictJson: null })];
  assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, 1, accepted)), { display: 'client-1', prune: undefined });
});

test('B-1078: terminal error verdicts keep the display pairing but never the deletion proof', () => {
  for (const verdictJson of ['{"kind":"error"}', '{"kind":"complete","success":false,"exitCode":0}',
    '{"kind":"complete","isError":true,"exitCode":0}', '{"kind":"complete","exitCode":1}', 'broken', null]) {
    const read = () => [receipt({ verdictJson })];
    assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, 1, read)), { display: 'client-1', prune: undefined }, String(verdictJson));
  }
});

test('B-1078: terminal success carries both fields on the same row', () => {
  assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, 1, () => [receipt()])), { display: 'client-1', prune: 'client-1' });
});

test('B-1078: another member of a multi-member session sees neither field for the same transcript uuid', () => {
  const read = (owner: number) => owner === 1 ? [receipt()] : [];
  assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, 2, read)), { display: undefined, prune: undefined });
  const foreign = (owner: number) => owner === 2 ? [receipt({ payloadSha256: '0'.repeat(64), clientMsgId: 'client-2' })] : [receipt()];
  assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, 2, foreign)), { display: undefined, prune: undefined });
});

test('B-1078: requester null, unregistered history, DB failure and hash mismatch expose neither field', () => {
  const none = { display: undefined, prune: undefined };
  assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, null, () => [receipt()])), none);
  const plain = history(); const unregistered = { ...plain, messages: plain.messages.map(m => ({ ...m })) };
  assert.deepEqual(fields(projectClaudeHistoryReceipts(unregistered, sid, 1, () => [receipt()])), none);
  assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, 1, () => { throw Error('DB missing'); })), none);
  for (const status of ['claimed', 'terminal']) {
    const read = () => [receipt({ payloadSha256: claudeTextPayloadHash('hello ')!, lifecycleStatus: status })];
    assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, 1, read)), none);
  }
  const twoReceipts = () => [receipt(), receipt({ clientMsgId: 'client-9', acceptedAt: null, lifecycleStatus: 'claimed' })];
  assert.deepEqual(fields(projectClaudeHistoryReceipts(history(), sid, 1, twoReceipts)), none);
});

test('B-1078: duplicate uuid in the transcript and duplicate messageId on the page expose neither field', () => {
  const claimed = () => [receipt({ acceptedAt: null, lifecycleStatus: 'claimed', verdictJson: null })];
  for (const read of [claimed, () => [receipt()]]) {
    assert.ok(projectClaudeHistoryReceipts(history([raw(), raw()]), sid, 1, read).messages
      .every(m => m.displayClientMsgId === undefined && m.clientMsgId === undefined));
    const page = history(); page.messages.push({ ...page.messages[0] });
    assert.ok(projectClaudeHistoryReceipts(page, sid, 1, read).messages
      .every(m => m.displayClientMsgId === undefined && m.clientMsgId === undefined));
  }
});

test('B-1078: successive requesters on one cached result never leak each other\'s fields', () => {
  const source = history(); const original = JSON.stringify(source);
  const cached = copyClaudeHistoryReceipts(source, structuredClone(source));
  const read = (owner: number) => owner === 1 ? [receipt({ acceptedAt: null, lifecycleStatus: 'claimed', verdictJson: null })]
    : owner === 2 ? [receipt({ clientMsgId: 'client-2' })] : [];
  const expected: Record<number, object> = { 1: { display: 'client-1', prune: undefined },
    2: { display: 'client-2', prune: 'client-2' }, 3: { display: undefined, prune: undefined } };
  for (const owner of [1, 2, 3, 1, 3, 2]) assert.deepEqual(fields(projectClaudeHistoryReceipts(cached, sid, owner, read)), expected[owner], `owner ${owner}`);
  assert.equal(JSON.stringify(cached), original); assert.equal(JSON.stringify(source), original);
});

test('B-1078: display pairing survives the default light projection', () => {
  const read = () => [receipt({ acceptedAt: null, lifecycleStatus: 'claimed', verdictJson: null })];
  const light = projectLightHistory(projectClaudeHistoryReceipts(history(), sid, 1, read));
  assert.deepEqual(fields(light), { display: 'client-1', prune: undefined });
  assert.deepEqual(fields(projectLightHistory(projectClaudeHistoryReceipts(history(), sid, 1, () => [receipt()]))), { display: 'client-1', prune: 'client-1' });
});

test('B-1078: values injected by the normalizer or the cache are stripped from every row', () => {
  const poisoned = (result: FetchHistoryResult) => {
    for (const m of result.messages) { m.displayClientMsgId = 'injected-display'; m.clientMsgId = 'injected-prune'; }
    result.messages.push({ ...result.messages[0], id: 'assistant-row', role: 'assistant' });
    return result;
  };
  const none = (result: FetchHistoryResult) => result.messages.every(m => m.displayClientMsgId === undefined && m.clientMsgId === undefined);
  assert.ok(none(projectClaudeHistoryReceipts(poisoned(history()), sid, null, () => [receipt()])));
  assert.ok(none(projectClaudeHistoryReceipts(poisoned(history()), sid, 2, () => [])));
  assert.ok(none(projectClaudeHistoryReceipts(poisoned(history()), sid, 1, () => [receipt({ payloadSha256: '0'.repeat(64) })])));
  const source = history(); const cached = copyClaudeHistoryReceipts(source, poisoned(structuredClone(source)));
  const owned = projectClaudeHistoryReceipts(cached, sid, 1, () => [receipt({ acceptedAt: null, lifecycleStatus: 'claimed' })]);
  assert.deepEqual(fields(owned), { display: 'client-1', prune: undefined });
  assert.deepEqual(fields(owned, 1), { display: undefined, prune: undefined });
});

test('B-1078: production-derived mid-turn receipt pairs the trailing-space transcript row', async () => {
  const fs = await import('node:fs/promises');
  const fixture = JSON.parse(await fs.readFile(new URL('./__tests__/__fixtures__/claude-b1078-midturn-receipt.json', import.meta.url), 'utf8'));
  const { record, terminalReceipt, requesterUserId } = fixture;
  assert.ok(record.message.content.endsWith(' '), 'fixture keeps the trailing space');
  assert.equal(claudeTextPayloadHash(record.message.content), terminalReceipt.payloadSha256);
  const load = () => {
    const collector = createClaudeRawIdentityCollector(record.sessionId);
    collector.observe(record, JSON.stringify(record).length);
    const messages = provider.normalizeMessage(record, record.sessionId);
    return collector.attach({ messages, total: messages.length, hasMore: false, offset: 0, limit: null },
      row => provider.normalizeMessage(row, record.sessionId));
  };
  const project = (state: object, requester: number | null = requesterUserId) =>
    fields(projectLightHistory(projectClaudeHistoryReceipts(load(), record.sessionId, requester,
      owner => owner === requesterUserId ? [{ ...terminalReceipt, ...state }] : [])));
  const cmid = terminalReceipt.clientMsgId;
  assert.deepEqual(project(fixture.claimedReceipt), { display: cmid, prune: undefined });
  assert.deepEqual(project(fixture.startedReceipt), { display: cmid, prune: undefined });
  assert.deepEqual(project({}), { display: cmid, prune: cmid });
  assert.deepEqual(project({}, requesterUserId + 1), { display: undefined, prune: undefined });
  assert.deepEqual(project({}, null), { display: undefined, prune: undefined });
  assert.deepEqual(project({ payloadSha256: claudeTextPayloadHash(record.message.content.trimEnd()) }), { display: undefined, prune: undefined });
});

test('B-1078: an image-bearing message binds identity and pairs its folded transcript row', async () => {
  const fs = await import('node:fs/promises');
  const fixture = JSON.parse(await fs.readFile(new URL('./__tests__/__fixtures__/claude-b1078-image-receipt.json', import.meta.url), 'utf8'));
  const { record, terminalReceipt, requesterUserId, receiptPayloadManifest } = fixture;
  const content: string = record.message.content;
  assert.ok(content.includes('[Images provided at the following paths:]'), 'fixture folds the image into text');
  for (const key of ['images', 'files', 'attachments']) assert.equal(record.message[key], undefined);
  // The engine receives the folded STRING, so the write and read sides hash the same bytes.
  assert.equal(claudeTextPayloadHash(content), terminalReceipt.payloadSha256);

  // WRITE side: the capability now mints for an image message and binding occurs.
  const command = 'قلل الهدر هنا برضو';
  const capability = createVendorReceiptInvocation({ command, options: {
    clientMsgId: terminalReceipt.clientMsgId, receiptPayload: receiptPayloadManifest, images: [{ data: 'AA==' }],
  } }, requesterUserId, terminalReceipt.clientMsgId);
  assert.ok(capability, 'image message mints a receipt capability');
  const bindings: Array<{ clientMsgId: string; payloadSha256: string }> = [];
  const stream = createClaudeReceiptPrompt({ capability, command, content, userId: requesterUserId,
    sessionId: record.sessionId, release: Promise.resolve() },
    input => { bindings.push(input as { clientMsgId: string; payloadSha256: string }); return true; }).make();
  const first = await stream.next();
  assert.equal(first.value!.message.content, content, 'the yielded prompt is the exact folded string');
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].clientMsgId, terminalReceipt.clientMsgId);
  assert.equal(bindings[0].payloadSha256, terminalReceipt.payloadSha256);
  await stream.next();

  // READ side: the folded-string transcript row correlates and receives displayClientMsgId.
  const load = () => {
    const collector = createClaudeRawIdentityCollector(record.sessionId);
    collector.observe(record, JSON.stringify(record).length);
    const messages = provider.normalizeMessage(record, record.sessionId);
    return collector.attach({ messages, total: messages.length, hasMore: false, offset: 0, limit: null },
      row => provider.normalizeMessage(row, record.sessionId));
  };
  const project = (state: object, requester: number | null = requesterUserId) =>
    fields(projectLightHistory(projectClaudeHistoryReceipts(load(), record.sessionId, requester,
      owner => owner === requesterUserId ? [{ ...terminalReceipt, ...state }] : [])));
  const cmid = terminalReceipt.clientMsgId;
  assert.deepEqual(project(fixture.claimedReceipt), { display: cmid, prune: undefined });
  assert.deepEqual(project(fixture.startedReceipt), { display: cmid, prune: undefined });
  assert.deepEqual(project({}), { display: cmid, prune: cmid });
  assert.deepEqual(project({}, requesterUserId + 1), { display: undefined, prune: undefined });
  assert.deepEqual(project({}, null), { display: undefined, prune: undefined });
});
