import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LLMProvider } from '@/shared/types.js';

import { loadStableHistorySnapshot, resetHistorySnapshotCacheForTests } from '../../services/session-history-light.service.js';

import { VendorSessionsProvider } from './vendor-sessions.provider.js';
import { appendVendorTranscript, appendVendorTranscriptEventIdempotent, appendVendorTranscriptTurn, appendVendorTranscriptTurnIdempotent, vendorTranscriptPath } from './vendor-transcript.js';
import { createVendorReceiptInvocation, readVendorReceiptInvocation, projectVendorHistoryReceipts, readVendorReceipt, vendorReceiptMetadata } from './vendor-receipt-identity.js';

const input = (clientMsgId = 'receipt-1') => ({ userId: 7, clientMsgId, textOnly: true });

for (const provider of ['qwen', 'hermes', 'kimi', 'deepseek', 'glm'] as LLMProvider[]) {
  test(`${provider}: canonical writer, stable cache and owner-only projection in both request orders`, async t => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vendor-receipt-'));
    t.mock.method(os, 'homedir', () => dir);
    try {
      const nativeId = await appendVendorTranscriptTurn(provider, 'session', dir, 'user', 'same text', { receipt: input() });
      assert.ok(nativeId);
      await appendVendorTranscriptTurnIdempotent(provider, 'session', dir, 'user', 'same text', 'event-2', input('receipt-2'));
      const file = vendorTranscriptPath(provider, 'session', dir);
      const beforeReplay = await fsp.readFile(file, 'utf8');
      await appendVendorTranscriptTurnIdempotent(provider, 'session', dir, 'user', 'changed', 'event-2', input('hijack'));
      assert.equal(await fsp.readFile(file, 'utf8'), beforeReplay);
      const adapter = new VendorSessionsProvider({ provider });
      for (const order of [[7, 8], [8, 7]]) {
        resetHistorySnapshotCacheForTests();
        let reads = 0;
        for (const requesterUserId of order) {
          const { result } = await loadStableHistorySnapshot({ sessionId: 'session', requesterUserId,
            source: { provider, projectPath: dir, jsonlPath: file, updatedAt: 'now' }, pageKey: 'all',
            load: async () => { reads++; return adapter.fetchHistory('session', { projectPath: dir }); },
          });
          assert.doesNotMatch(JSON.stringify(result), /receipt-|nassajReceipt|textOnly/);
          const projected = projectVendorHistoryReceipts(result, provider, 'session', requesterUserId);
          assert.deepEqual(projected.messages.map(m => m.clientMsgId), requesterUserId === 7 ? ['receipt-1', 'receipt-2'] : [undefined, undefined]);
          assert.deepEqual(projected.messages.map(m => m.id), [nativeId, 'event-2']);
          assert.doesNotMatch(JSON.stringify(result), /receipt-/);
          assert.doesNotMatch(JSON.stringify(projected), /nassajReceipt|textOnly/);
        }
        assert.equal(reads, 1, 'both requesters share the original native cache');
      }
    } finally { resetHistorySnapshotCacheForTests(); await fsp.rm(dir, { recursive: true, force: true }); }
  });
}

test('B-1078: displayClientMsgId is stripped for vendor and non-vendor providers alike', () => {
  for (const provider of ['kimi', 'cursor'] as const) {
    const result = { messages: [{ id: 'm1', sessionId: 's', timestamp: 'now', provider, kind: 'text' as const, role: 'user' as const,
      content: 'hi', displayClientMsgId: 'injected-display' }], total: 1, hasMore: false, offset: 0, limit: null };
    for (const requester of [7, null]) {
      assert.equal(projectVendorHistoryReceipts(result, provider, 's', requester).messages[0].displayClientMsgId, undefined, `${provider}/${requester}`);
    }
    assert.equal(result.messages[0].displayClientMsgId, 'injected-display', 'shared input is not mutated');
  }
});

test('malformed ownership, identities, tool/assistant spoofing and multipart never grant correlation', () => {
  const metadata = vendorReceiptMetadata('qwen', 's', 'user', input());
  const event = { type: 'message', message: { id: 'native', role: 'user', content: 'text', ...metadata } };
  assert.ok(readVendorReceipt(event, 'qwen', 's'));
  for (const role of ['assistant', 'tool', 'system']) {
    assert.equal(readVendorReceipt({ ...event, message: { ...event.message, role } }, 'qwen', 's'), null);
    assert.deepEqual(vendorReceiptMetadata('qwen', 's', role, input()), {});
  }
  for (const clientMsgId of ['', ' x', 'a'.repeat(129), 'x\n', {}, 4]) {
    assert.deepEqual(vendorReceiptMetadata('qwen', 's', 'user', { ...input(), clientMsgId }), {});
  }
  for (const userId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7']) {
    assert.deepEqual(vendorReceiptMetadata('qwen', 's', 'user', { ...input(), userId }), {});
  }
  for (const key of ['images', 'files', 'attachments', 'parts']) {
    assert.equal(readVendorReceipt({ ...event, message: { ...event.message, [key]: [{}] } }, 'qwen', 's'), null);
    assert.equal(readVendorReceipt({ ...event, [key]: [{}] }, 'qwen', 's'), null);
  }
  assert.equal(readVendorReceipt({ ...event, message: { ...event.message, content: [{ type: 'text', text: 'text' }] } }, 'qwen', 's'), null);
  assert.equal(readVendorReceipt(event, 'hermes', 's'), null);
  assert.equal(readVendorReceipt(event, 'qwen', 'other'), null);
  assert.deepEqual(vendorReceiptMetadata('qwen', 's', 'user', { ...input(), textOnly: false }), {});
});

test('legacy replay remains byte-identical and failed appends grant no native ID', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vendor-receipt-'));
  t.mock.method(os, 'homedir', () => dir);
  try {
    const file = vendorTranscriptPath('qwen', 's', dir);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const legacy = JSON.stringify({ type: 'message', eventId: 'old', message: { role: 'user', content: 'old' } }) + '\n';
    await fsp.writeFile(file, legacy);
    await appendVendorTranscriptTurnIdempotent('qwen', 's', dir, 'user', 'old', 'old', input());
    assert.equal(await fsp.readFile(file, 'utf8'), legacy);
    await fsp.mkdir(vendorTranscriptPath('qwen', 'fail', dir));
    assert.equal(await appendVendorTranscriptTurn('qwen', 'fail', dir, 'user', 'text', { receipt: input() }), null);
    await assert.rejects(appendVendorTranscriptTurnIdempotent('qwen', 'fail', dir, 'user', 'text', 'id', input()));
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('ambiguous repeated receipt IDs fail closed even when split across pages', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vendor-receipt-'));
  t.mock.method(os, 'homedir', () => dir);
  try {
    await appendVendorTranscriptTurnIdempotent('kimi', 's', dir, 'user', 'same', 'a', input());
    await appendVendorTranscriptTurnIdempotent('kimi', 's', dir, 'user', 'same', 'b', input());
    const adapter = new VendorSessionsProvider({ provider: 'kimi' });
    for (const offset of [0, 1]) {
      const result = await adapter.fetchHistory('s', { projectPath: dir, offset, limit: 1 });
      assert.equal(projectVendorHistoryReceipts(result, 'kimi', 's', 7).messages[0].clientMsgId, undefined);
    }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('actual authorized session service preserves participant privacy across cache read orders', async t => {
  const { closeConnection, initializeDatabase, participantsDb, sessionsDb, userDb } = await import('@/modules/database/index.js');
  const { sessionsService } = await import('../../services/sessions.service.js');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vendor-receipt-service-'));
  const previous = process.env.DATABASE_PATH;
  t.mock.method(os, 'homedir', () => dir);
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'fixture.db');
  try {
    await initializeDatabase();
    const owner = userDb.createUser('vendor-owner', 'fixture-hash', 'user').id;
    const participant = userDb.createUser('vendor-participant', 'fixture-hash', 'user').id;
    sessionsDb.createSession('vendor-service', 'kimi', dir);
    participantsDb.recordSpawn('vendor-service', owner);
    participantsDb.recordSpawn('vendor-service', participant);
    await appendVendorTranscriptTurnIdempotent('kimi', 'vendor-service', dir, 'user', 'text', 'native-id', { ...input(), userId: owner });
    for (const order of [[owner, participant], [participant, owner]]) {
      resetHistorySnapshotCacheForTests();
      for (const userId of order) {
        const response = await sessionsService.fetchHistory('vendor-service', userId);
        assert.equal(response.messages[0].clientMsgId, userId === owner ? 'receipt-1' : undefined);
        assert.doesNotMatch(JSON.stringify(response), /nassajReceipt|textOnly/);
      }
    }
    await assert.rejects(sessionsService.fetchHistory('vendor-service', null), { code: 'SESSION_NOT_FOUND' });
  } finally {
    closeConnection(); resetHistorySnapshotCacheForTests();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});


test('raw provider user events cannot spoof receipt ownership through either append API', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vendor-receipt-'));
  t.mock.method(os, 'homedir', () => dir);
  try {
    const event = { type: 'message', message: { id: 'spoof', role: 'user', content: 'text', ...vendorReceiptMetadata('kimi', 's', 'user', input()) } };
    await appendVendorTranscript('kimi', 's', dir, event);
    await appendVendorTranscriptEventIdempotent('kimi', 's', dir, event, 'raw-event');
    const bytes = await fsp.readFile(vendorTranscriptPath('kimi', 's', dir), 'utf8');
    assert.doesNotMatch(bytes, /nassajReceipt|receipt-1/);
    assert.match(JSON.stringify(event), /nassajReceipt/, 'raw object is not mutated');
    for (const id of ['x'.repeat(257), 'x\n', '\u0000']) {
      await assert.rejects(appendVendorTranscriptTurnIdempotent('kimi', 's', dir, 'user', 'text', id, input()));
    }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});


test('invocation eligibility is explicit, complete, owner-bound and cannot be spoofed or serialized', () => {
  const manifest = { version: 1, kind: 'text', imageCount: 0, fileCount: 0 };
  const data = { command: 'complete prompt', options: { receiptPayload: manifest, clientMsgId: 'receipt-id' } };
  const cap = createVendorReceiptInvocation(data, 7, 'receipt-id');
  assert.deepEqual(readVendorReceiptInvocation(cap, data.command, 7), { userId: 7, clientMsgId: 'receipt-id', textOnly: true });
  assert.equal(readVendorReceiptInvocation(structuredClone(cap), data.command, 7), undefined);
  assert.equal(readVendorReceiptInvocation(input(), data.command, 7), undefined);
  for (const receiptPayload of [undefined, null, [], {}, { ...manifest, kind: 'multipart' }, { ...manifest, imageCount: 1 }, { ...manifest, fileCount: 1 }, { ...manifest, extra: true }]) {
    assert.equal(createVendorReceiptInvocation({ ...data, options: { ...data.options, receiptPayload } }, 7, 'receipt-id'), undefined);
  }
  for (const key of ['images', 'files', 'attachments', 'parts', 'content', 'image', 'file', 'multipart']) {
    assert.equal(createVendorReceiptInvocation({ ...data, [key]: [{}] }, 7, 'receipt-id'), undefined);
    assert.equal(createVendorReceiptInvocation({ ...data, options: { ...data.options, [key]: [{}] } }, 7, 'receipt-id'), undefined);
  }
  assert.equal(createVendorReceiptInvocation(data, '7', 'receipt-id'), undefined);
  assert.equal(createVendorReceiptInvocation(data, 7, 'invalid id'), undefined);
});

test('B-1078: image/file messages mint identity when the manifest matches the folded attachment lists', () => {
  // The engine payload the transcript records is a single text string (handleImages
  // appends "[Images provided at the following paths:]"); `images`/`files` are the app
  // attachment lists the manifest counts declare. Shape derived from receipt 1083.
  const manifest = { version: 1, kind: 'text', imageCount: 1, fileCount: 2 };
  const options = { receiptPayload: manifest, clientMsgId: 'receipt-id',
    images: [{ data: 'AA==' }], files: [{ path: '/a.txt', name: 'a.txt' }, { path: '/b.txt', name: 'b.txt' }] };
  const data = { command: 'قلل الهدر هنا برضو', options };
  assert.deepEqual(readVendorReceiptInvocation(createVendorReceiptInvocation(data, 7, 'receipt-id'), data.command, 7),
    { userId: 7, clientMsgId: 'receipt-id', textOnly: true });
  // Text messages stay backward compatible: zero counts with empty/absent arrays.
  assert.ok(createVendorReceiptInvocation({ command: 'hi', options: { receiptPayload: { version: 1, kind: 'text', imageCount: 0, fileCount: 0 },
    clientMsgId: 'receipt-id', images: [] } }, 7, 'receipt-id'));
  // A tampered count that disagrees with the actual attachment list refuses to mint.
  for (const bad of [{ ...manifest, imageCount: 2 }, { ...manifest, fileCount: 1 }, { ...manifest, imageCount: 0, fileCount: 0 }]) {
    assert.equal(createVendorReceiptInvocation({ ...data, options: { ...options, receiptPayload: bad } }, 7, 'receipt-id'), undefined);
  }
  // A non-array attachment field and negative/over-cap counts fail closed.
  assert.equal(createVendorReceiptInvocation({ ...data, options: { ...options, images: 'x' } }, 7, 'receipt-id'), undefined);
  for (const count of [-1, 1.5, 1025]) {
    assert.equal(createVendorReceiptInvocation({ command: 'hi', options: { receiptPayload: { version: 1, kind: 'text', imageCount: count, fileCount: 0 }, clientMsgId: 'receipt-id' } }, 7, 'receipt-id'), undefined);
  }
  // Raw multipart content blocks remain rejected even with a matching count.
  for (const key of ['parts', 'content', 'multipart', 'attachments']) {
    assert.equal(createVendorReceiptInvocation({ ...data, options: { ...options, [key]: [{}] } }, 7, 'receipt-id'), undefined);
  }
  // Attachment arrays on the top-level record (not folded through options) are rejected.
  assert.equal(createVendorReceiptInvocation({ ...data, images: [{ data: 'AA==' }] }, 7, 'receipt-id'), undefined);
});
