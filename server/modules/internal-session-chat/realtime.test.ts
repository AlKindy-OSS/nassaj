import assert from 'node:assert/strict';
import test from 'node:test';

import { internalChatRealtime } from './realtime.js';
import { internalSessionChatDb } from './repository.js';

test('revocation is personal and removes the subscription', () => {
  const original=internalSessionChatDb.activeMember; (internalSessionChatDb as any).activeMember=()=> 'member';
  const frames:string[]=[]; const socket={readyState:1,send:(frame:string)=>frames.push(frame)};
  assert.equal(internalChatRealtime.subscribe('s',9,socket),true);
  internalChatRealtime.revoke('s',9); internalChatRealtime.publishMessage('s',{body:'must-not-deliver'});
  assert.deepEqual(frames.map(frame=>JSON.parse(frame).type),['internal-chat.membership_revoked']);
  (internalSessionChatDb as any).activeMember=original;
});

test('reconnect receives only independent internal frames and personal mention state', () => {
  const original = internalSessionChatDb.activeMember;
  (internalSessionChatDb as any).activeMember = () => 'member';
  const oldFrames: string[] = [], reconnectedFrames: string[] = [], otherFrames: string[] = [];
  const oldSocket = { readyState: 1, send: (frame: string) => oldFrames.push(frame) };
  const reconnectedSocket = { readyState: 1, send: (frame: string) => reconnectedFrames.push(frame) };
  const otherSocket = { readyState: 1, send: (frame: string) => otherFrames.push(frame) };
  try {
    assert.equal(internalChatRealtime.subscribe('s', 9, oldSocket), true);
    internalChatRealtime.unsubscribe(oldSocket);
    assert.equal(internalChatRealtime.subscribe('s', 9, reconnectedSocket), true);
    assert.equal(internalChatRealtime.subscribe('s', 10, otherSocket), true);
    internalChatRealtime.publishMessage('s', { clientMessageId: 'retry-safe', sequence: 4, body: 'internal only' });
    internalChatRealtime.publishMentionState('s', 9, 1, 7);
    assert.deepEqual(oldFrames, [], 'disconnected socket must not receive a replay');
    assert.deepEqual(reconnectedFrames.map(value => JSON.parse(value).type), [
      'internal-chat.message.created', 'internal-chat.mention-state.changed',
    ]);
    assert.deepEqual(otherFrames.map(value => JSON.parse(value).type), ['internal-chat.message.created']);
    const mention = JSON.parse(reconnectedFrames[1]);
    assert.deepEqual(mention, { type: 'internal-chat.mention-state.changed', sessionId: 's', unreadMentionCount: 1, roomVersion: 7 });
    assert.equal(JSON.stringify(reconnectedFrames).includes('provider'), false);
  } finally {
    internalChatRealtime.unsubscribe(reconnectedSocket);
    internalChatRealtime.unsubscribe(otherSocket);
    (internalSessionChatDb as any).activeMember = original;
  }
});
