import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyWebSocketClient } from './websocket-auth.service.js';

const trustedOrigin = 'https://nassaj.example.test';

function dependencies(rejections: string[] = []) {
  return {
    isPlatform: false,
    canAcceptApplications: () => true,
    authenticateWebSocket: () => null,
    authenticateDeviceWebSocket: () => ({
      id: 7,
      username: 'owner',
      authenticationKind: 'device_session',
      deviceSessionId: 'device_test',
      slotId: 'slot_test',
      deviceGeneration: 1,
    }),
    jwtSecret: 'unused-for-device-cookie',
    recordRejection: ({ reason }: { reason: string }) => { rejections.push(reason); },
    clientIp: () => '127.0.0.1',
    isTrustedOrigin: (request: { headers: { origin?: string } }) => (
      request.headers.origin === trustedOrigin
    ),
  };
}

function info(origin?: string) {
  return {
    req: {
      url: '/ws',
      headers: {
        cookie: '__Host-nassaj_device=device-secret',
        host: 'nassaj.example.test',
        ...(origin === undefined ? {} : { origin }),
      },
    },
  };
}

test('device-cookie websocket accepts only the trusted explicit Origin', () => {
  const request = info(trustedOrigin);
  assert.equal(verifyWebSocketClient(request as never, dependencies() as never), true);
  assert.equal((request.req as { user?: { authenticationKind?: string } }).user?.authenticationKind, 'device_session');
});

test('device-cookie websocket rejects missing and foreign Origin before authentication', () => {
  for (const origin of [undefined, 'https://foreign.example']) {
    const rejections: string[] = [];
    let authenticated = false;
    const deps: any = dependencies(rejections);
    deps.authenticateDeviceWebSocket = () => {
      authenticated = true;
      return { id: 7 };
    };
    assert.equal(verifyWebSocketClient(info(origin) as never, deps as never), false);
    assert.equal(authenticated, false);
    assert.deepEqual(rejections, ['origin_rejected']);
  }
});

test('disabled wallet ignores a stale device cookie and preserves bearer websocket auth', () => {
  const request = {
    req: {
      url: '/ws?token=legacy-token',
      headers: { cookie: '__Host-nassaj_device=stale-device-cookie', host: 'nassaj.example.test' },
    },
  };
  const deps: any = dependencies();
  deps.deviceSessionsEnabled = () => false;
  deps.authenticateWebSocket = (token: string) => token === 'legacy-token'
    ? { id: 7, username: 'owner', authenticationKind: 'session' }
    : null;
  assert.equal(verifyWebSocketClient(request as never, deps), true);
  assert.equal((request.req as { user?: { authenticationKind?: string } }).user?.authenticationKind, 'session');
});
