/**
 * ADR-227 / T-2098 stage 3a — the local-engine pin value: one string in
 * sessions.engine_provider carrying (local, server id, owner id, origin digest).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_ENGINE,
  formatLocalEnginePin,
  isLocalEngineValue,
  localOriginDigest,
  parseLocalEnginePin,
} from './local-engine-pin.js';

const serverId = '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11';

test('format and parse round-trip the triple plus the origin digest', () => {
  const pin = formatLocalEnginePin({ serverId, ownerId: 7, origin: 'http://192.168.8.137:8080' });
  assert.match(pin, /^local:0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11:7:[0-9a-f]{32}$/u);
  assert.deepEqual(parseLocalEnginePin(pin), {
    serverId, ownerId: 7, originDigest: localOriginDigest('http://192.168.8.137:8080'),
  });
});

test('the origin digest follows the normalized origin, so a moved server is detectable', () => {
  assert.equal(localOriginDigest('http://127.1:8080'), localOriginDigest('http://127.0.0.1:8080/'));
  assert.notEqual(localOriginDigest('http://192.168.8.137:8080'), localOriginDigest('http://192.168.8.138:8080'));
  assert.notEqual(localOriginDigest('http://192.168.8.137:8080'), localOriginDigest('http://192.168.8.137:8081'));
  assert.throws(() => localOriginDigest('http://192.168.8.137:8080/v1'));
});

test('anything that is not an exact local pin parses to null — never a guess', () => {
  for (const value of [null, '', 'local', 'anthropic', 'glm', `local:${serverId}:0:${'a'.repeat(32)}`,
    `local:${serverId}:7:${'A'.repeat(32)}`, `local:${serverId}:7:${'a'.repeat(31)}`, `local:../x:7:${'a'.repeat(32)}`,
    `local:${serverId}:7:${'a'.repeat(32)}:extra`, ` local:${serverId}:7:${'a'.repeat(32)}`]) {
    assert.equal(parseLocalEnginePin(value), null, String(value));
  }
});

test('isLocalEngineValue recognizes a pin and the bare engine id only', () => {
  assert.equal(LOCAL_ENGINE, 'local');
  assert.equal(isLocalEngineValue('local'), true);
  assert.equal(isLocalEngineValue(formatLocalEnginePin({ serverId, ownerId: 3, origin: 'http://[::1]:8080' })), true);
  assert.equal(isLocalEngineValue('anthropic'), false);
  assert.equal(isLocalEngineValue('localx'), false);
  assert.equal(isLocalEngineValue(null), false);
});

test('localEngineSpawnRefusal refuses a local conversation or model at an engine-unaware site', async () => {
  const { localEngineSpawnRefusal, LOCAL_ENGINE_SPAWN_UNSUPPORTED } = await import('./local-engine-pin.js');
  const pin = formatLocalEnginePin({ serverId, ownerId: 7, origin: 'http://127.0.0.1:18080' });
  const byPin = localEngineSpawnRefusal({ storedEngine: pin, site: 'background task' });
  assert.equal(byPin?.code, LOCAL_ENGINE_SPAWN_UNSUPPORTED);
  assert.match(byPin?.message ?? '', /background task/u);
  assert.equal(localEngineSpawnRefusal({ model: 'nassaj_local_abc/gpt-oss-20b', site: 'x' })?.code, LOCAL_ENGINE_SPAWN_UNSUPPORTED);
  assert.equal(localEngineSpawnRefusal({ storedEngine: 'anthropic', model: 'haiku', site: 'x' }), null);
  assert.equal(localEngineSpawnRefusal({ storedEngine: null, model: null, site: 'x' }), null);
  assert.equal(localEngineSpawnRefusal({ storedEngine: 'local', site: 'x' })?.code, LOCAL_ENGINE_SPAWN_UNSUPPORTED,
    'any local engine value refuses, fail-closed');
});
