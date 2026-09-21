import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { before, after } from 'node:test';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { initializeDatabase, closeConnection, sessionsDb, userDb, messageCoordinationDb, participantsDb } from '@/modules/database/index.js';

import { CodexSessionsProvider } from '../codex-sessions.provider.js';
import { projectCodexHistoryIdentities as projectWithReader, copyCodexHistoryIdentities, createCodexReceiptCollector, codexHistoryIdentity } from '../codex-receipt-identity.js';
import { codexReceiptPayloadHash } from '../codex-receipt-proof.js';
import { sessionsService } from '../../../services/sessions.service.js';
import { projectLightHistory } from '../../../services/session-history-light.service.js';

// The test owns the database dependency, just as the production session service does.
const projectCodexHistoryIdentities = (result: Parameters<typeof projectWithReader>[0], sessionId: string, userId: number | null,
  lease: Parameters<typeof projectWithReader>[3] = undefined, read = messageCoordinationDb.readCodexVerdicts) =>
  projectWithReader(result, sessionId, userId, lease, read);

const image = 'data:image/png;base64,YQ==';
let owner: number, other: number, counter = 0;
before(async () => { await initializeDatabase(); owner = userDb.createUser('codex-receipt-owner', 'hash', 'user').id; other = userDb.createUser('codex-receipt-other', 'hash', 'user').id; });
after(closeConnection);
async function fixture(withImage = false, duplicate = false, imageOnly = false, resumedContext = false) {
  const session = `codex-identity-${++counter}`, file = path.join((process.env.NASSAJ_TEST_TMP ?? process.env.TMPDIR)!, `${session}.jsonl`);
  const prompt = imageOnly ? '' : 'same request';
  const raw = { type: 'response_item', payload: { type: 'message', role: 'user', id: 'native-human',
    internal_chat_message_metadata_passthrough: { turn_id: 'turn-native' },
    content: [...(prompt ? [{ type: 'input_text', text: prompt }] : []), ...(withImage ? [{ type: 'input_image', image_url: image }] : [])] } };
  const environment = { type: 'response_item', payload: { type: 'message', role: 'user', id: 'native-environment',
    internal_chat_message_metadata_passthrough: {
      turn_id: 'turn-native', content_item_kinds: ['environments.environment_context'],
    }, content: [{ type: 'input_text', text: '<environment_context>workspace</environment_context>' }] } };
  await writeFile(file, [...(resumedContext ? [environment] : []), raw, ...(duplicate ? [raw] : [])]
    .map(row => JSON.stringify(row)).join('\n') + '\n');
  sessionsDb.createSession(session, 'codex', '/fixture', undefined, undefined, undefined, file);
  const clientMsgId = `client-${counter}`;
  const imageDigest = createHash('sha256').update(Buffer.from(image.slice(image.indexOf(',') + 1), 'base64')).digest('hex');
  messageCoordinationDb.claim({ sessionId: session, clientMsgId, userId: owner, provider: 'codex', canonicalContent: prompt, coordinationLevel: 'direct',
    ...(withImage ? { attachmentFingerprint: createHash('sha256').update(JSON.stringify([imageDigest])).digest('hex') } : {}) });
  const proof = { version: 'codex_user_v1', userMessageId: 'native-human', turnId: 'turn-native', payloadSha256: codexReceiptPayloadHash(prompt, withImage ? [image] : []) };
  const verdict = { kind: 'complete', sessionId: session, provider: 'codex', clientMsgId, codexUserProof: proof };
  messageCoordinationDb.recordVerdict({ sessionId: session, userId: owner, provider: 'codex', clientMsgId }, 'terminal', verdict);
  return { session, clientMsgId, proof, verdict, result: await new CodexSessionsProvider().fetchHistory(session) };
}
test('native identity reconciles while preserving display ID and private cache isolation', async () => {
  const f = await fixture(), before = JSON.stringify(f.result), id = f.result.messages[0].id;
  assert.ok(id.startsWith('codex-history-'));
  assert.equal(projectCodexHistoryIdentities(f.result, f.session, owner).messages[0].clientMsgId, f.clientMsgId);
  assert.equal(projectCodexHistoryIdentities(f.result, f.session, other).messages[0].clientMsgId, undefined);
  assert.equal(projectCodexHistoryIdentities(f.result, 'different', owner).messages[0].clientMsgId, undefined);
  assert.equal(JSON.stringify(f.result), before);
  assert.equal(JSON.stringify(projectCodexHistoryIdentities(f.result, f.session, owner)).includes('native-human'), false);
  const cloned = copyCodexHistoryIdentities(f.result, structuredClone(f.result));
  assert.equal(projectCodexHistoryIdentities(cloned, f.session, owner).messages[0].clientMsgId, f.clientMsgId);
  // B-1078: only the Claude owner projection may set displayClientMsgId; a cached/normalizer value is stripped.
  for (const row of cloned.messages) row.displayClientMsgId = 'injected-display';
  assert.ok([owner, other, null].every(requester => projectCodexHistoryIdentities(cloned, f.session, requester).messages
    .every(row => row.displayClientMsgId === undefined)));
});
test('resumed environment singleton does not create a duplicate and the human receipt still reconciles', async () => {
  const f = await fixture(false, false, false, true);
  const projected = projectCodexHistoryIdentities(f.result, f.session, owner);

  assert.equal(projected.messages.length, 1);
  assert.equal(projected.messages[0]?.content, 'same request');
  assert.equal(projected.messages[0]?.clientMsgId, f.clientMsgId);
});
test('text plus image only reconciles in the complete final DTO, never omitted/deferred/changed media', async () => {
  const f = await fixture(true);
  assert.equal(projectCodexHistoryIdentities(f.result, f.session, owner).messages[0].clientMsgId, f.clientMsgId);
  const light = copyCodexHistoryIdentities(f.result, projectLightHistory(f.result));
  assert.equal(projectCodexHistoryIdentities(light, f.session, owner).messages[0].clientMsgId, undefined);
  for (const fields of [{ images: [], imagesOmitted: 1 }, { images: ['data:image/png;base64,Yg=='] }, { content: 'truncated' }]) {
    const altered = copyCodexHistoryIdentities(f.result, { ...f.result, messages: [{ ...f.result.messages[0], ...fields }] });
    assert.equal(projectCodexHistoryIdentities(altered, f.session, owner).messages[0].clientMsgId, undefined);
  }
});
test('excluded /btw or paginated-away messages and duplicate native records cannot reconcile', async () => {
  const f = await fixture();
  const filtered = copyCodexHistoryIdentities(f.result, { ...f.result, messages: [] });
  assert.deepEqual(projectCodexHistoryIdentities(filtered, f.session, owner).messages, []);
  const duplicate = await fixture(false, true);
  assert.ok(projectCodexHistoryIdentities(duplicate.result, duplicate.session, owner).messages.every(row => !row.clientMsgId));
});
test('two owned receipts targeting one native row and unsuccessful/missing writes fail closed', async () => {
  const f = await fixture();
  const read = () => [{ clientMsgId: f.clientMsgId, verdictJson: JSON.stringify(f.verdict) }, { clientMsgId: 'other-client', verdictJson: JSON.stringify({ ...f.verdict, clientMsgId: 'other-client' }) }];
  assert.equal(projectCodexHistoryIdentities(f.result, f.session, owner, undefined, read).messages[0].clientMsgId, undefined);
  for (const patch of [{ kind: 'error' }, { notStarted: true }, { success: false }, { codexUserProof: undefined }]) {
    const invalid = () => [{ clientMsgId: f.clientMsgId, verdictJson: JSON.stringify({ ...f.verdict, ...patch }) }];
    assert.equal(projectCodexHistoryIdentities(f.result, f.session, owner, undefined, invalid).messages[0].clientMsgId, undefined);
  }
  assert.equal(projectCodexHistoryIdentities(f.result, f.session, owner, undefined, () => []).messages[0].clientMsgId, undefined);
});
test('image-only ingress reconciles only from an exact unique native image and durable proof', async () => {
  const exact = await fixture(true, false, true);
  assert.equal(exact.result.messages[0].content, '');
  assert.deepEqual(exact.result.messages[0].images, [image]);
  assert.equal(projectCodexHistoryIdentities(exact.result, exact.session, owner).messages[0].clientMsgId, exact.clientMsgId);
  const changed = copyCodexHistoryIdentities(exact.result, { ...exact.result, messages: [{
    ...exact.result.messages[0], images: ['data:image/png;base64,Yg=='],
  }] });
  assert.equal(projectCodexHistoryIdentities(changed, exact.session, owner).messages[0].clientMsgId, undefined);
  const duplicate = await fixture(true, true, true);
  assert.ok(projectCodexHistoryIdentities(duplicate.result, duplicate.session, owner).messages.every(row => !row.clientMsgId));
  assert.equal(messageCoordinationDb.claim({ sessionId: 'blank', clientMsgId: 'blank', userId: owner, provider: 'codex', canonicalContent: '', coordinationLevel: 'direct' }).action, 'fingerprint_mismatch');
});

 test('actual authorized history service carries private cache identity through light then full hydration', async () => {
  const f = await fixture(true);
  participantsDb.recordSpawn(f.session, owner); participantsDb.recordSpawn(f.session, other);
  const prior = process.env.NASSAJ_LIGHT_HISTORY_ENABLED; process.env.NASSAJ_LIGHT_HISTORY_ENABLED = '1';
  try {
    const light = await sessionsService.fetchHistory(f.session, owner, { limit: 20, payloadMode: 'light' });
    assert.equal(light.messages[0].clientMsgId, undefined);
    const full = await sessionsService.fetchHistory(f.session, owner, { limit: 20, payloadMode: 'full', revision: light.revision });
    assert.equal(full.messages[0].clientMsgId, f.clientMsgId);
    assert.deepEqual(full.messages[0].images, [image]);
    const foreign = await sessionsService.fetchHistory(f.session, other, { limit: 20, payloadMode: 'full' });
    assert.equal(foreign.messages[0].clientMsgId, undefined);
  } finally { if (prior === undefined) delete process.env.NASSAJ_LIGHT_HISTORY_ENABLED; else process.env.NASSAJ_LIGHT_HISTORY_ENABLED = prior; }
});


for (const reason of ['reject', 'identifier-limit'] as const) {
  test(`collector clears retained evidence and stops all reads after ${reason}`, t => {
    const raw = {}, laterRaw = {};
    const payload = { id: 'bounded-native-fixture', content: [{ type: 'input_text', text: 'fixture' }],
      internal_chat_message_metadata_passthrough: { turn_id: 'bounded-turn' } };
    let retainedCounts: Map<string, number> | undefined;
    let retainedCandidates: unknown[] | undefined;
    const mapSet = Map.prototype.set, arrayPush = Array.prototype.push;
    const mapSpy = t.mock.method(Map.prototype, 'set', function (this: Map<string, number>, key: string, value: number) {
      if (key === payload.id) retainedCounts = this;
      return mapSet.call(this, key, value);
    });
    Array.prototype.push = function (this: unknown[], ...items: any[]) {
      if (items[0]?.raw === raw) retainedCandidates = this;
      return arrayPush.apply(this, items);
    };
    const collector = createCodexReceiptCollector();
    try { collector.observe({ payload }); collector.associate(payload, raw); }
    finally { mapSpy.mock.restore(); Array.prototype.push = arrayPush; }
    assert.ok(retainedCounts); assert.ok(retainedCandidates);
    assert.equal(retainedCounts.size, 1); assert.equal(retainedCandidates.length, 1);
    if (reason === 'reject') collector.reject();
    else {
      // Controlled boundary: the real map contains two short IDs, not 100001 allocations.
      Object.defineProperty(retainedCounts, 'size', { configurable: true, get: () => 100001 });
      collector.observe({ payload: { id: 'boundary-crossing' } });
      delete (retainedCounts as any).size;
    }
    assert.equal(retainedCounts.size, 0); assert.equal(retainedCandidates.length, 0);
    const unreadable = new Proxy({}, { get() { assert.fail('invalid collector must not inspect another payload'); } });
    collector.observe(unreadable); collector.associate(unreadable, laterRaw);
    collector.reject(); collector.finish();
    const display = { id: 'display-fixture', sessionId: 'fixture-session', provider: 'codex',
      role: 'user', kind: 'text', content: 'fixture' } as const;
    assert.equal(codexHistoryIdentity(raw, display), null);
    assert.equal(codexHistoryIdentity(laterRaw, display), null);
    assert.equal(retainedCounts.size, 0); assert.equal(retainedCandidates.length, 0);
  });
}
