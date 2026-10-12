/**
 * shell-websocket.codex-link-mode.test.ts — B-1548 (ADR-200 S4, G1 r2): the
 * Codex interactive terminal (`codex`, `codex resume …`) passes the link-mode
 * run gate before any PTY spawns, on the member's OWN tree.
 *
 * Real database, real encrypted link-mode records and real Codex credential
 * files in the member's tree, resolved through the real per-user env seam;
 * only node-pty (native) is mocked so "no spawn" is observed directly.
 *
 * Matrix: api_key + no key → LINK_MODE_KEY_MISSING, no PTY; api_key + key →
 * spawned; subscription → spawned; corrupt record → LINK_MODE_RECORD_UNREADABLE,
 * no PTY; plain shell and `codex login` → ungated; flag off → unchanged.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, it, mock } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME, CLAUDE_CONFIG_DIR, DATABASE_PATH.
// eslint-disable-next-line boundaries/dependencies -- the shared hermetic test sandbox
import { assertInsideSandbox, removeSandbox, sandboxHome, sandboxRoot } from '@/modules/providers/tests/helpers/hermetic-sandbox.js';

const FLAG = 'NASSAJ_UNIFIED_VENDOR_KEYS';
const OPENAI_KEY = 'sk' + '-proj-B1548-DO-NOT-LEAK';
const OAUTH_REFRESH = 'rt-B1548-OAUTH-DO-NOT-LEAK';
process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.OPENAI_API_KEY;

const spawnCalls: { shell: string; args: string[] }[] = [];
mock.module('node-pty', {
  defaultExport: {
    spawn: (shell: string, args: string[]) => {
      spawnCalls.push({ shell, args });
      return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
    },
  },
});

const { installFakeHarnessOverrides } = await import('@/shared/__tests__/harness-binary-fixtures.js');
const { acceptFixtureRuntimeCompat, createCodexMachineFixture } = await import('@/shared/tests/codex-release-fixture.js');
const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('@/services/provider-sharing.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { handleShellConnection } = await import('./shell-websocket.service.js');

const stubDir = assertInsideSandbox(path.join(sandboxRoot, 'harness-stubs'));
fs.mkdirSync(stubDir, { recursive: true });
const restoreHarnessOverrides = installFakeHarnessOverrides(stubDir);
const codexMachine = createCodexMachineFixture(assertInsideSandbox(path.join(sandboxRoot, 'codex-machine')));
await acceptFixtureRuntimeCompat();
process.env.CODEX_PATH = codexMachine.launcher;

await initializeDatabase();
const member = userDb.createUser('b1548-member', 'hash', 'user') as { id: number };
const PROJECT_PATH = process.cwd();

type Mode = 'subscription' | 'api_key';

/** The member's Codex tree: the key in apikey mode, or the state after a key delete (chatgpt, tokens kept). */
function codexTree(withKey: boolean): void {
  const file = assertInsideSandbox(path.join(userConfigDir(member.id, '.codex'), 'auth.json'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tokens = { id_token: 'id', access_token: 'at', refresh_token: OAUTH_REFRESH, account_id: 'acc' };
  fs.writeFileSync(file, JSON.stringify(withKey
    ? { auth_mode: 'apikey', OPENAI_API_KEY: OPENAI_KEY, tokens }
    : { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens }));
}

function setMode(mode: Mode): void {
  store.setLinkModeRecord(member.id, 'codex', {
    v: 1, mode, source: 'user', updatedAt: new Date(0).toISOString(), projection: null, subscriptionFp: null,
  });
}

function makeFakeWs() {
  const sent: Record<string, unknown>[] = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    readyState: 1,
    sent,
    send(data: string) { sent.push(JSON.parse(data)); },
    close() {},
    on(event: string, cb: (arg: unknown) => void) { (listeners[event] ||= []).push(cb); },
    emit(event: string, arg: unknown) { (listeners[event] || []).forEach((cb) => cb(arg)); },
  };
}

const deps = {
  acquireWriterLease: () => ({ release() {} }),
  getSessionById: () => null,
  stripAnsiSequences: (s: string) => s,
  normalizeDetectedUrl: () => null,
  extractUrlsFromText: () => [],
  shouldAutoOpenUrlFromOutput: () => false,
} as unknown as Parameters<typeof handleShellConnection>[2];

/** Opens one terminal and waits until it either spawned a PTY or sent an error frame. */
async function openTerminal(overrides: Record<string, unknown>): Promise<{ spawned: boolean; error?: Record<string, unknown> }> {
  spawnCalls.length = 0;
  const ws = makeFakeWs();
  handleShellConnection(ws as never, { user: { id: member.id, role: 'user' } } as never, deps);
  ws.emit('message', JSON.stringify({
    type: 'init', projectPath: PROJECT_PATH, provider: 'codex', sessionId: null, hasSession: false,
    initialCommand: null, isPlainShell: false, cols: 80, rows: 24, forceRestart: true, ...overrides,
  }));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const error = ws.sent.find((frame) => frame.type === 'error');
    if (spawnCalls.length > 0 || error) {
      for (const secret of [OPENAI_KEY, OAUTH_REFRESH]) {
        assert.equal(JSON.stringify(ws.sent).includes(secret), false, 'no credential reaches the socket');
      }
      return { spawned: spawnCalls.length > 0, error };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('terminal neither spawned nor refused');
}

const RESUME = { hasSession: true, sessionId: '11111111-2222-7333-8444-555555555555' };

beforeEach(() => {
  process.env[FLAG] = '1';
  _resetProviderSharingCache();
  setProviderSharingConfig({ codex: 'isolated' });
});

after(() => {
  process.env[FLAG] = '0';
  restoreHarnessOverrides();
  closeConnection();
  removeSandbox();
});

describe('B-1548: Codex interactive terminal behind the link-mode run gate', () => {
  it('api_key without a key refuses `codex` and `codex resume` with no PTY', async () => {
    codexTree(false);
    setMode('api_key');
    for (const overrides of [{}, RESUME]) {
      const result = await openTerminal(overrides);
      assert.equal(result.spawned, false, 'no PTY spawned');
      assert.equal(result.error?.code, 'LINK_MODE_KEY_MISSING');
    }
  });

  it('api_key with the key present spawns the terminal', async () => {
    codexTree(true);
    setMode('api_key');
    assert.deepEqual(await openTerminal({}), { spawned: true, error: undefined });
    assert.deepEqual(await openTerminal(RESUME), { spawned: true, error: undefined });
  });

  it('subscription spawns the terminal', async () => {
    codexTree(false);
    setMode('subscription');
    assert.equal((await openTerminal({})).spawned, true);
  });

  it('an unreadable record refuses with LINK_MODE_RECORD_UNREADABLE and no PTY', async () => {
    codexTree(false);
    const keysFile = assertInsideSandbox(
      path.join(sandboxHome, '.nassaj-users', String(member.id), '.provider-secrets', 'keys.json'));
    const saved = fs.readFileSync(keysFile);
    fs.writeFileSync(keysFile, '{not json');
    try {
      const result = await openTerminal({});
      assert.equal(result.spawned, false);
      assert.equal(result.error?.code, 'LINK_MODE_RECORD_UNREADABLE');
    } finally {
      fs.writeFileSync(keysFile, saved);
    }
  });

  it('a plain shell and `codex login` stay ungated', async () => {
    codexTree(false);
    setMode('api_key');
    assert.equal((await openTerminal({ isPlainShell: true })).spawned, true, 'plain shell');
    assert.equal((await openTerminal({ initialCommand: 'codex login --device-auth' })).spawned, true, 'codex login');
  });

  it('flag off leaves the terminal unchanged', async () => {
    codexTree(false);
    setMode('api_key');
    process.env[FLAG] = '0';
    assert.equal((await openTerminal({})).spawned, true);
  });
});
