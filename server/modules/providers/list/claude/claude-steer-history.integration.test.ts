/**
 * T-1903 reload: a real Claude transcript read through sessionsService. Both
 * delivery shapes from the A0 spike (mid-turn `queued_command` attachment and
 * a post-tool user line with our uuid) come back as injected rows of the
 * SENDER with the wrapper stripped; a member who TYPED a wrapper look-alike
 * stays an ordinary message; an unknown queued_command stays invisible.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, messageCoordinationDb, participantsDb, sessionsDb } from '@/modules/database/index.js';
import { buildSteerWrapper } from '@/modules/session-steer/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { resetHistorySnapshotCacheForTests } from '../../services/session-history-light.service.js';
import { sessionsService } from '../../services/sessions.service.js';

import {
  applyClaudeSteerInjections, claudeTextPayloadHash, markSteerCandidate, readQueuedSteerPrompt,
} from './claude-receipt-identity.js';

const SID = 'steer-history-0001';
const TURN = '81111111-2222-4333-8444-555555555555';
const U1 = '91111111-2222-4333-8444-555555555551';
const U2 = '91111111-2222-4333-8444-555555555552';
const FOREIGN = '91111111-2222-4333-8444-555555555553';

test('reload marks verified injections only, by ingress identity, never by text', async () => {
  const dir = await mkdtemp('/var/tmp/steer-hist-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  resetHistorySnapshotCacheForTests();
  try {
    const db = getConnection();
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alice', 'h', 'user'), (2, 'bob', 'h', 'user')").run();
    const mid = buildSteerWrapper('bob', 'mid-turn note')!;
    const late = buildSteerWrapper('bob', 'after the tools')!;
    for (const [n, uuid, text, wrapped] of [[1, U1, 'mid-turn note', mid], [2, U2, 'after the tools', late]] as const) {
      assert.equal(messageCoordinationDb.insertSteer({ clientMsgId: `h-${n}`, userId: 2, provider: 'claude', sessionId: SID,
        turnId: TURN, text, uuid, payloadSha256: claudeTextPayloadHash(wrapped)! }), true);
    }
    const lines = [
      { type: 'user', uuid: 'a1111111-2222-4333-8444-555555555555', sessionId: SID, message: { role: 'user', content: 'start' } },
      { type: 'attachment', uuid: 'b1111111-2222-4333-8444-555555555555', sessionId: SID,
        attachment: { type: 'queued_command', prompt: mid, source_uuid: U1 } },
      { type: 'queue-operation', operation: 'remove', sessionId: SID },
      { type: 'attachment', uuid: 'c1111111-2222-4333-8444-555555555555', sessionId: SID,
        attachment: { type: 'queued_command', prompt: 'someone else', source_uuid: FOREIGN } },
      { type: 'assistant', uuid: 'd1111111-2222-4333-8444-555555555555', sessionId: SID,
        message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'ok' }] } },
      { type: 'user', uuid: U2, sessionId: SID, message: { role: 'user', content: late } },
      { type: 'user', uuid: 'e1111111-2222-4333-8444-555555555555', sessionId: SID, message: { role: 'user', content: mid } },
    ];
    const file = path.join(dir, `${SID}.jsonl`);
    await writeFile(file, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`);
    sessionsDb.createSession(SID, 'claude', dir, undefined, undefined, undefined, file);
    participantsDb.recordSpawn(SID, 1);

    const history = await sessionsService.fetchHistory(SID, 1, {});
    const users = history.messages.filter(m => m.kind === 'text' && m.role === 'user');
    assert.deepEqual(users.map(m => [m.content, m.injected ?? false, m.userId ?? null]), [
      ['start', false, users[0].userId ?? null],
      ['mid-turn note', true, 2],
      ['after the tools', true, 2],
      [mid, false, users[3].userId ?? null],
    ]);
    assert.notEqual(users[3].userId, 2, 'the typed look-alike is never attributed to the sender');
    assert.deepEqual([users[1].steerClientMsgId, users[1].deliveryStatus], ['h-1', 'delivered']);
    assert.ok(!history.messages.some(m => m.content === 'someone else'), 'unknown queued_command stays invisible');
  } finally {
    resetHistorySnapshotCacheForTests();
    closeConnection();
    await rm(dir, { recursive: true, force: true });
  }
});

test('stamp unit: uuid+hash must both match; tampered candidate dropped; look-alike untouched', () => {
  const uuid = 'f1111111-2222-4333-8444-555555555555';
  const wrapped = buildSteerWrapper('bob', 'please also check 1')!;
  const rows = [{ clientMsgId: 'steer-1', userId: 2, uuid, payloadSha256: claudeTextPayloadHash(wrapped)!, text: 'please also check 1' }];
  const queued = readQueuedSteerPrompt({ type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: wrapped }], source_uuid: uuid } }, new Set([uuid]))!;
  assert.equal(queued.text, wrapped, 'block-array prompts are joined');
  assert.equal(readQueuedSteerPrompt({ type: 'attachment', attachment: { type: 'queued_command', prompt: wrapped, source_uuid: 'x' } }, new Set([uuid])), null);
  const msg = (id: string, content: string) => ({ id, kind: 'text', role: 'user', content, provider: 'claude', sessionId: SID, timestamp: '' }) as NormalizedMessage;
  const injected = msg(`${uuid}_steer`, queued.text);
  markSteerCandidate(injected, uuid);
  const spoof = msg('u-spoof_text_0', wrapped);
  const tampered = msg('u-t_steer', `${wrapped} `);
  markSteerCandidate(tampered, uuid);
  const out = applyClaudeSteerInjections([spoof, injected, tampered], rows);
  assert.equal(out.length, 2, 'an unproven queued candidate is dropped');
  assert.deepEqual([out[1].injected, out[1].userId, out[1].content, out[1].steerClientMsgId, out[1].deliveryStatus],
    [true, 2, 'please also check 1', 'steer-1', 'delivered']);
  assert.deepEqual([out[0].injected, out[0].userId, out[0].content], [undefined, undefined, wrapped]);
});
