/**
 * ADR-227 / T-2107 (qa-critic critical 1): the Codex App Server runs on the
 * member's cloud Codex config. A chat pinned to a local model server must never
 * reach it: /btw (side query), /compact and every short RPC (thread/fork) are
 * refused with LOCAL_ENGINE_SPAWN_UNSUPPORTED before any App Server child exists.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import { acceptFixtureRuntimeCompat, createCodexMachineFixture } from '../shared/tests/codex-release-fixture.js';

const machineRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-local-'));
const machine = createCodexMachineFixture(machineRoot);
await acceptFixtureRuntimeCompat();
process.env.CODEX_PATH = machine.launcher;
after(() => fs.rmSync(machineRoot, { recursive: true, force: true }));

mock.module('./isolation/link-mode-run-gate.js', { namedExports: { assertLinkModeRunAllowed: async () => {} } });
const { callCodexAppServer, spawnCodexSideQuery, startCodexCompaction } = await import('./codex-app-server.js');

const LOCAL_PIN = 'local:0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11:7:0123456789abcdef0123456789abcdef';
const localRow = () => ({ project_path: '/authorized/project', provider: 'codex', engine_provider: LOCAL_PIN });
let spawns = 0;
const options = {
  authorizeImpl: localRow,
  spawnImpl: () => { spawns += 1; throw new Error('must not spawn'); },
  envResolver: () => { spawns += 1; return {}; },
  governanceImpl: () => ({ ok: true, codexHome: '/x' }),
};

test('/btw on a local chat is refused before any App Server child', async () => {
  const errors: Array<[string, string]> = [];
  await spawnCodexSideQuery({ sessionId: 'local-chat', userId: 7, question: 'q' }, {
    onError: (code: string, message: string) => errors.push([code, message]),
  }, options);
  assert.equal(errors[0]?.[0], 'LOCAL_ENGINE_SPAWN_UNSUPPORTED');
  assert.equal(spawns, 0);
});

test('/compact on a local chat is refused before any App Server child', async () => {
  await assert.rejects(startCodexCompaction('local-chat', 7, options), { code: 'LOCAL_ENGINE_SPAWN_UNSUPPORTED' });
  assert.equal(spawns, 0);
});

test('a short App Server RPC (thread/fork) on a local chat is refused before any child', async () => {
  await assert.rejects(callCodexAppServer('local-chat', 7, 'thread/fork', {}, options), { code: 'LOCAL_ENGINE_SPAWN_UNSUPPORTED' });
  assert.equal(spawns, 0);
});
