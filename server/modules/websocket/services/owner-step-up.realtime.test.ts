/**
 * ADR-H20 S6 on the realtime side, with the real database: an owner's
 * no-click SSO session cannot start or continue an agent turn, nor open the
 * shell or terminal, without this browser's passkey step-up (N2); and a
 * forced sign-out of a browser (back channel / re-check) closes its sockets
 * with 4401 while running turns keep going (B-1327).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before } from 'node:test';

import { initializeDatabase, ssoDeviceSessionsDb } from '@/modules/database/index.js';
import { registerTokenSessionSocket } from '@/modules/account-wallet/index.js';

// eslint-disable-next-line boundaries/no-unknown -- the test drives the shared ADR-H20 services directly.
import { endSsoDeviceSession } from '../../../services/sso-device-session.service.js';
// eslint-disable-next-line boundaries/no-unknown -- the test drives the shared ADR-H20 services directly.
import { OWNER_PRIVILEGED_CHAT_MESSAGES } from '../../../services/owner-privileged-actions.js';

import { WebSocketWriter } from './websocket-writer.service.js';
import { ownerStepUpChatRefusal } from './chat-websocket.service.js';
import {
  closeWebSocketForIdentityRevocation,
  OWNER_STEP_UP_CLOSE_CODE,
  refuseOwnerTerminalWithoutStepUp,
} from './websocket-server.service.js';
import { listUserOwnedRuns } from './user-run-revocation.service.js';

const HOUR_MS = 60 * 60_000;

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'Use the isolated node test runner');
  await initializeDatabase();
});


function bind(userId: number, { ownerTier, privilegedUntil = null as number | null }: { ownerTier: boolean; privilegedUntil?: number | null }) {
  const refreshSid = crypto.randomBytes(16).toString('base64url');
  ssoDeviceSessionsDb.bind({
    refreshSid, userId, issuer: 'https://idp.example', idpSid: `V1_${refreshSid}`, loginHint: null, ownerTier,
    privilegedUntil, nowMs: Date.now(), pruneAfter: Date.now() + 30 * 24 * HOUR_MS,
  });
  return refreshSid;
}

test('N2: every turn-starting chat message is refused for an owner tier without a grant; nothing else is', () => {
  const sid = bind(1, { ownerTier: true });
  const owner = { role: 'owner', tokenSid: sid };
  for (const type of OWNER_PRIVILEGED_CHAT_MESSAGES) {
    const refusal = ownerStepUpChatRefusal(type, { type, clientMsgId: 'c-1', btwId: 'b-1' } as never, owner);
    assert.ok(refusal, type);
    const payload = refusal.payload as Record<string, unknown>;
    assert.equal(payload.code, 'owner_step_up_required', type);
    if (type === 'btw-query' || type === 'btw-fork') {
      assert.equal(refusal.unicast, true);
      assert.equal(payload.btwId, 'b-1');
    } else {
      assert.equal(refusal.unicast, false);
      assert.equal(payload.notStarted, true, 'the turn never started');
      assert.equal(payload.success, false);
    }
  }
  for (const type of ['abort-session', 'check-session-status', 'get-active-sessions', 'cursor-abort']) {
    assert.equal(ownerStepUpChatRefusal(type, { type } as never, owner), null, `${type} stays open`);
  }
});

test('N2: a live grant, a member, or a password owner session dispatches normally', () => {
  const granted = bind(1, { ownerTier: true, privilegedUntil: Date.now() + HOUR_MS });
  assert.equal(ownerStepUpChatRefusal('claude-command', { type: 'claude-command' } as never, { role: 'owner', tokenSid: granted }), null);
  const member = bind(2, { ownerTier: false });
  assert.equal(ownerStepUpChatRefusal('claude-command', { type: 'claude-command' } as never, { role: 'user', tokenSid: member }), null);
  assert.equal(ownerStepUpChatRefusal('claude-command', { type: 'claude-command' } as never,
    { role: 'owner', tokenSid: 'not-bound-password-session' }), null);
  assert.equal(ownerStepUpChatRefusal('claude-command', { type: 'claude-command' } as never, undefined), null);
});

test('N2: /shell and /terminal close with the final 4403 for an owner tier without a grant; /ws is not refused', () => {
  const sid = bind(1, { ownerTier: true });
  for (const pathname of ['/shell', '/terminal']) {
    const closes: Array<[number, string]> = [];
    assert.equal(refuseOwnerTerminalWithoutStepUp({ close: (c, r) => closes.push([c, r]) }, pathname,
      { role: 'owner', tokenSid: sid }), true);
    assert.deepEqual(closes, [[OWNER_STEP_UP_CLOSE_CODE, 'owner_step_up_required']]);
  }
  assert.equal(OWNER_STEP_UP_CLOSE_CODE, 4403);
  assert.equal(refuseOwnerTerminalWithoutStepUp({ close: () => assert.fail('no close') }, '/ws',
    { role: 'owner', tokenSid: sid }), false);
  const granted = bind(1, { ownerTier: true, privilegedUntil: Date.now() + HOUR_MS });
  assert.equal(refuseOwnerTerminalWithoutStepUp({ close: () => assert.fail('no close') }, '/shell',
    { role: 'owner', tokenSid: granted }), false);
});

test('a forced sign-out (back channel / re-check) closes that browser\'s sockets with 4401; running turns survive', () => {
  const sid = bind(41, { ownerTier: false });
  const closes: Array<[number, string]> = [];
  const socket = { close: (code: number, reason: string) => closes.push([code, reason]) };
  registerTokenSessionSocket(sid, () => closeWebSocketForIdentityRevocation(socket as never));
  const writer = new WebSocketWriter({ readyState: 1, send: () => undefined } as never, 41);
  writer.bindRevocableRun('turn-41', 'claude');

  const closed = endSsoDeviceSession({ userId: 41, refreshSid: sid });

  assert.equal(closed, 1);
  assert.deepEqual(closes, [[4401, 'identity_revoked']]);
  const runs = listUserOwnedRuns(41, {} as never);
  assert.deepEqual(runs.map((run) => run.sessionId), ['turn-41'], 'the running turn is still registered');
  assert.equal(runs[0].isCurrent(), true, 'and still current: nothing aborted it');
  assert.equal(writer.isRunOutputRevoked(), false, 'its output is not fenced');
});
