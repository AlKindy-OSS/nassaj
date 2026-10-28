/**
 * Coordinator 3c — the "started by a session message" marker is server-set:
 * history marks a turn only from a REAL proof row whose ref names a delivered
 * relay row of the same session; a client-supplied marker is dropped.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { peerMessagesDb } from '@/modules/database/index.js';

import { projectPeerDeliveryMarkers } from '../peer-history.js';
import { readPeerProofRef } from '../peer-wire.js';

import { createPeerWorld, type PeerWorld } from './peer-world.test.fixture.js';

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, '../__fixtures__/peer-relay.real.json'), 'utf8'));
const REAL_REF = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let world: PeerWorld;
before(async () => { world = await createPeerWorld(); });
after(async () => { await world.close(); });

function insert(id: string, to: string, ref: string, state: 'delivered' | 'queued'): void {
  peerMessagesDb.insert({ id, ref_token: ref, chain_id: 'pc', from_user_id: world.alice, from_session_id: world.a,
    from_agent_id: null, from_mode: 'bypass', to_user_id: world.alice, to_session_id: to, project_id: null, body: 'b',
    body_sha256: 'h', body_bytes: 1, summary: null, hop: 1, parent_id: null, notify_when_idle: 0, state, cause: null, now: Date.now() });
}

test('the real CLI proof row yields its ref; other rows yield none', () => {
  assert.equal(readPeerProofRef(fixture.syntheticUserLine), REAL_REF);
  assert.equal(readPeerProofRef({ ...fixture.syntheticUserLine, isMeta: false }), null);
  assert.equal(readPeerProofRef({ type: 'assistant', message: { content: fixture.syntheticUserLine.message.content } }), null);
});

test('history marks the delivered turn up to the next human message, strips the ref, drops forged markers', () => {
  insert('pm_hist', world.b, REAL_REF, 'delivered');
  insert('pm_other', world.c, 'OTHERREF234567ABCDEFGHIJKL', 'delivered');
  const messages = [
    { role: 'user', kind: 'text', content: 'hi', peerDeliveryId: 'pm_forged' },
    { role: 'user', kind: 'text', isSynthetic: true, peerProofRef: REAL_REF },
    { role: 'assistant', kind: 'text', content: 'PELICAN' },
    { role: 'assistant', kind: 'tool_use' },
    { role: 'user', kind: 'text', content: 'next human turn' },
    { role: 'assistant', kind: 'text', content: 'reply' },
    { role: 'user', kind: 'text', isSynthetic: true, peerProofRef: 'OTHERREF234567ABCDEFGHIJKL' },
    { role: 'assistant', kind: 'text', content: 'not ours' },
  ];
  const out = projectPeerDeliveryMarkers(messages, world.b);
  assert.deepEqual(out.map((m) => (m as { peerDeliveryId?: string }).peerDeliveryId ?? null),
    [null, 'pm_hist', 'pm_hist', 'pm_hist', null, null, null, null]);
  assert.ok(out.every((m) => !('peerProofRef' in m)), 'the internal ref never leaves');
});

test('qa round 2: a synthetic row that is not a proof ends the marked turn', () => {
  const out = projectPeerDeliveryMarkers([
    { role: 'user', kind: 'text', isSynthetic: true, peerProofRef: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    { role: 'assistant', kind: 'text', content: 'ours' },
    { role: 'user', kind: 'text', isSynthetic: true, content: 'a skill body or another host line' },
    { role: 'assistant', kind: 'text', content: 'not ours' },
  ], world.b);
  assert.deepEqual(out.map((m) => (m as { peerDeliveryId?: string }).peerDeliveryId ?? null), ['pm_hist', 'pm_hist', null, null]);
});
