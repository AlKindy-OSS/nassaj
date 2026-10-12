/**
 * link-mode-run-gate.test.ts — B-1546 (ADR-200 S4, G1 veto): the link mode is
 * enforced on the RUN paths, not only in the status display.
 *
 * Real database, real sharing policy, real credential grants, real encrypted
 * link-mode records and real credential files in each member's tree. Only the
 * child process itself is a spy, so "no spawn" is observed directly:
 *   - Claude: resolveClaudeRunProfileOrThrow and the Turn Supervisor SDK adapter;
 *   - Codex: the Turn Supervisor CLI adapter and the App Server compaction spawn.
 *
 * Matrix: api_key + key → runs; api_key + key deleted (OAuth kept, C2) →
 * LINK_MODE_KEY_MISSING with no spawn; subscription → runs; grantee under a
 * grantor in api_key without a key → refused; shared tree reads the operator
 * record (G1 H-1); flag off → legacy behaviour. No credential reaches an error.
 *
 * B-1547: a record that exists but cannot be read (tampered ciphertext, wrong
 * server key, corrupt keys.json, invalid payload) refuses with
 * LINK_MODE_RECORD_UNREADABLE instead of falling back to the derived default.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME, CLAUDE_CONFIG_DIR, DATABASE_PATH.
import { assertInsideSandbox, removeSandbox, sandboxClaudeDir, sandboxHome } from './helpers/hermetic-sandbox.js';

const FLAG = 'NASSAJ_UNIFIED_VENDOR_KEYS';
const ANTHROPIC_KEY = 'sk' + '-ant-api03-RUNGATE-DO-NOT-LEAK';
const OPENAI_KEY = 'sk' + '-proj-RUNGATE-DO-NOT-LEAK';
const OAUTH_REFRESH = 'rt-RUNGATE-OAUTH-DO-NOT-LEAK';
const SECRETS = [ANTHROPIC_KEY, OPENAI_KEY, OAUTH_REFRESH];

const SERVER_KEY = Buffer.alloc(32, 9);
process.env.NASSAJ_PROVIDER_SECRETS_KEY = SERVER_KEY.toString('base64');
for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) {
  delete process.env[name];
}

const { initializeDatabase, closeConnection, userDb, credentialGrantsDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('@/services/provider-sharing.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { resolveClaudeRunProfileOrThrow } = await import('@/services/isolation/resolve-claude-run-profile.js');
const { providerSecretsService } = await import('@/modules/providers/services/provider-secrets.service.js');
// eslint-disable-next-line boundaries/dependencies -- the real voice-key writer, to prove it refuses a corrupt store (B-1547 M1)
const { setTranscriptionKey, deleteTranscriptionKey } = await import('@/modules/voice/voice-transcription.service.js');
// eslint-disable-next-line boundaries/dependencies -- the real Turn Supervisor run path under test
const { createClaudeSdkTurnAdapter } = await import('@/modules/turn-supervisor/adapters/claude-sdk-adapter.js');
// eslint-disable-next-line boundaries/dependencies -- the real Turn Supervisor run path under test
const { createCodexCliAdapter } = await import('@/modules/turn-supervisor/adapters/codex-cli-adapter.js');
const { setCodexRuntimeEvaluatorForTests } = await import('@/shared/codex-runtime-compat.js');
// eslint-disable-next-line boundaries/no-unknown -- the real App Server spawn path under test
const { startCodexCompaction } = await import('@/services/codex-app-server.js');

await initializeDatabase();
// The SDK adapter resolves the harness path before the (spied) query; a stub that is never executed.
const claudeStub = assertInsideSandbox(path.join(sandboxHome, '.local', 'bin', 'claude'));
fs.mkdirSync(path.dirname(claudeStub), { recursive: true });
fs.writeFileSync(claudeStub, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
setCodexRuntimeEvaluatorForTests(async () => ({ compatible: true, version: '0.156.0', reason: null, checks: {} }));

const owner = userDb.createUser('rungate-owner', 'hash', 'user') as { id: number };
const grantor = userDb.createUser('rungate-grantor', 'hash', 'user') as { id: number };
const grantee = userDb.createUser('rungate-grantee', 'hash', 'user') as { id: number };
credentialGrantsDb.grant(grantor.id, grantee.id, 'claude');
credentialGrantsDb.grant(grantor.id, grantee.id, 'codex');

type Harness = 'claude' | 'codex';
type Mode = 'subscription' | 'api_key';

function writeJson(file: string, value: unknown): void {
  const target = assertInsideSandbox(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

const claudeDirOf = (id: number | null) => (id === null ? sandboxClaudeDir : userConfigDir(id, '.claude'));
const codexDirOf = (id: number) => userConfigDir(id, '.codex');

/** A Claude tree with the OAuth login, plus the managed key when asked. */
function claudeTree(id: number | null, withKey: boolean): void {
  const dir = claudeDirOf(id);
  writeJson(path.join(dir, '.credentials.json'), { claudeAiOauth: { accessToken: 'at', refreshToken: OAUTH_REFRESH } });
  writeJson(path.join(dir, 'settings.json'), { env: withKey ? { ANTHROPIC_API_KEY: ANTHROPIC_KEY } : {} });
}

/** A Codex tree: the key in apikey mode, or the C2 state after a key delete (chatgpt, tokens kept). */
function codexTree(id: number, withKey: boolean): void {
  const tokens = { id_token: 'id', access_token: 'at', refresh_token: OAUTH_REFRESH, account_id: 'acc' };
  writeJson(path.join(codexDirOf(id), 'auth.json'), withKey
    ? { auth_mode: 'apikey', OPENAI_API_KEY: OPENAI_KEY, tokens }
    : { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens });
}

function setMode(id: number | null, harness: Harness, mode: Mode): void {
  store.setLinkModeRecord(id, harness, {
    v: 1, mode, source: 'user', updatedAt: new Date(0).toISOString(), projection: null, subscriptionFp: null,
  });
}

function assertNoSecret(error: unknown): void {
  const err = error as Error & { cause?: unknown; details?: unknown };
  const text = [err.message, JSON.stringify(err.details ?? null), String((err.cause as Error | undefined)?.message ?? ''),
    JSON.stringify((err.cause as { details?: unknown } | undefined)?.details ?? null)].join('\n');
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, 'no credential in the refusal');
}

const isKeyMissing = (error: unknown): boolean => {
  assertNoSecret(error);
  return (error as { code?: string }).code === 'LINK_MODE_KEY_MISSING';
};
/** A Turn Supervisor refusal: typed adapter error whose cause carries the link-mode code. */
const isAdapterKeyMissing = (error: unknown): boolean => {
  assertNoSecret(error);
  const err = error as { code?: string; cause?: { code?: string } };
  return err.code === 'provider_unavailable' && err.cause?.code === 'LINK_MODE_KEY_MISSING';
};

// ---------------------------------------------------------------- run paths
const spawns = { claude: 0, codex: 0, appServer: 0 };

async function* claudeResult(): AsyncIterable<never> {
  yield {
    type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  } as never;
}

const claudeAdapter = createClaudeSdkTurnAdapter({
  enabled: () => true,
  resolveEnvironment: (_userId, baseEnv) => ({ ...baseEnv }),
  queryFactory: () => { spawns.claude += 1; return claudeResult(); },
});

const machineIdentity = Object.freeze({
  executablePath: '/machine/releases/0.156.0/bin/codex', pathDirs: Object.freeze(['/machine/releases/0.156.0/codex-path']),
}) as never;
const codexAdapter = createCodexCliAdapter({
  governanceProbe: () => true,
  executableProbe: async () => true,
  acquireIdentity: () => machineIdentity,
  assertUnchanged: () => {},
  resolveEnv: () => ({ PATH: '/usr/bin' }),
  spawnCapture: async () => {
    spawns.codex += 1;
    return {
      code: 0,
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
      stderr: '',
    };
  },
});

const turn = (provider: Harness, userId: number) => ({
  provider, userId, model: 'm', prompt: 'p', persist: false as const, writer: { capture() {} },
});

const runClaudeProfile = (userId: number) => resolveClaudeRunProfileOrThrow({ userId });
const runClaudeTurn = (userId: number) => claudeAdapter.invoke(turn('claude', userId) as never);
const runCodexTurn = (userId: number) => codexAdapter.invoke(turn('codex', userId) as never);
/** The App Server compaction spawn, behind an injected session check and a spy spawn. */
const runCodexCompaction = (userId: number) => startCodexCompaction('rungate-session', userId, {
  authorizeImpl: () => ({ provider: 'codex', project_id: 1, project_path: '/var/tmp' }),
  spawnImpl: () => { spawns.appServer += 1; throw new Error('spawn reached'); },
});

beforeEach(() => {
  process.env[FLAG] = '1';
  _resetProviderSharingCache();
  setProviderSharingConfig({ claude: 'isolated', codex: 'isolated' });
  spawns.claude = 0;
  spawns.codex = 0;
  spawns.appServer = 0;
});

after(() => {
  process.env[FLAG] = '0';
  closeConnection();
  removeSandbox();
});

describe('B-1546: Claude run paths', () => {
  it('api_key with the key present runs', async () => {
    claudeTree(owner.id, true);
    setMode(owner.id, 'claude', 'api_key');
    const profile = await runClaudeProfile(owner.id);
    assert.equal(profile.env.CLAUDE_CONFIG_DIR, claudeDirOf(owner.id));
    await runClaudeTurn(owner.id);
    assert.equal(spawns.claude, 1);
  });

  it('api_key after the key is deleted (OAuth kept) is refused with no spawn', async () => {
    claudeTree(owner.id, false);
    setMode(owner.id, 'claude', 'api_key');
    await assert.rejects(runClaudeProfile(owner.id), isKeyMissing);
    await assert.rejects(runClaudeTurn(owner.id), isAdapterKeyMissing);
    assert.equal(spawns.claude, 0, 'the SDK child was never created');
  });

  it('subscription mode runs on the OAuth login', async () => {
    claudeTree(owner.id, false);
    setMode(owner.id, 'claude', 'subscription');
    await runClaudeProfile(owner.id);
    await runClaudeTurn(owner.id);
    assert.equal(spawns.claude, 1);
  });

  it('a grantee under a grantor in api_key without a key is refused', async () => {
    claudeTree(grantor.id, false);
    setMode(grantor.id, 'claude', 'api_key');
    await assert.rejects(runClaudeProfile(grantee.id), isKeyMissing);
    await assert.rejects(runClaudeTurn(grantee.id), isAdapterKeyMissing);
    assert.equal(spawns.claude, 0);
  });

  it('a terminal launch (grants off) reads the caller own tree, not the grantor', async () => {
    claudeTree(grantor.id, false);
    setMode(grantor.id, 'claude', 'api_key');
    claudeTree(grantee.id, false);
    setMode(grantee.id, 'claude', 'subscription');
    const profile = await resolveClaudeRunProfileOrThrow({ userId: grantee.id, honorGrants: false });
    assert.ok(profile.env);
  });

  it('G1 H-1: on a shared tree the operator record governs every member', async () => {
    setProviderSharingConfig({ claude: 'shared' });
    claudeTree(null, false);
    setMode(null, 'claude', 'api_key');
    await assert.rejects(runClaudeProfile(owner.id), isKeyMissing);
    setMode(null, 'claude', 'subscription');
    await runClaudeProfile(owner.id);
  });

  it('the run path never persists a derived record', async () => {
    const fresh = userDb.createUser('rungate-fresh', 'hash', 'user') as { id: number };
    claudeTree(fresh.id, true);
    await runClaudeProfile(fresh.id);
    assert.equal(store.getLinkModeRecord(fresh.id, 'claude'), null);
  });

  it('flag off: legacy behaviour, the same state runs', async () => {
    claudeTree(owner.id, false);
    setMode(owner.id, 'claude', 'api_key');
    process.env[FLAG] = '0';
    await runClaudeProfile(owner.id);
    await runClaudeTurn(owner.id);
    assert.equal(spawns.claude, 1);
  });
});

describe('B-1546: Codex run paths', () => {
  it('api_key with the key present runs', async () => {
    codexTree(owner.id, true);
    setMode(owner.id, 'codex', 'api_key');
    await runCodexTurn(owner.id);
    assert.equal(spawns.codex, 1);
  });

  it('api_key after the key is deleted (auth_mode back to chatgpt) is refused with no spawn', async () => {
    codexTree(owner.id, false);
    setMode(owner.id, 'codex', 'api_key');
    await assert.rejects(runCodexTurn(owner.id), isAdapterKeyMissing);
    await assert.rejects(runCodexCompaction(owner.id), isKeyMissing);
    assert.deepEqual([spawns.codex, spawns.appServer], [0, 0]);
  });

  it('subscription mode runs on the ChatGPT login', async () => {
    codexTree(owner.id, false);
    setMode(owner.id, 'codex', 'subscription');
    await runCodexTurn(owner.id);
    assert.equal(spawns.codex, 1);
  });

  it('a grantee under a grantor in api_key without a key is refused', async () => {
    codexTree(grantor.id, false);
    setMode(grantor.id, 'codex', 'api_key');
    await assert.rejects(runCodexTurn(grantee.id), isAdapterKeyMissing);
    await assert.rejects(runCodexCompaction(grantee.id), isKeyMissing);
    assert.deepEqual([spawns.codex, spawns.appServer], [0, 0]);
  });

  it('flag off: legacy behaviour, the same state runs', async () => {
    codexTree(owner.id, false);
    setMode(owner.id, 'codex', 'api_key');
    process.env[FLAG] = '0';
    await runCodexTurn(owner.id);
    assert.equal(spawns.codex, 1);
  });
});

// ---------------------------------------------------------------- B-1547
const keysFileOf = (id: number) => assertInsideSandbox(
  path.join(sandboxHome, '.nassaj-users', String(id), '.provider-secrets', 'keys.json'));

/** A valid `v1:iv:tag:ct` envelope under the test server key, for a crafted payload. */
function envelope(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SERVER_KEY, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function patchEntry(id: number, harness: Harness, value: string): void {
  const file = keysFileOf(id);
  const keys = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  keys[`linkmode:${harness}`] = value;
  fs.writeFileSync(file, JSON.stringify(keys));
}

const flipLast = (value: string) => value.replace(/.$/u, (c) => (c === 'A' ? 'B' : 'A'));

/** Each case leaves `id`'s record for `harness` present but unreadable; returns a restore step. */
const UNREADABLE_CASES: Array<{
  name: string; store?: true; corrupt: (id: number, harness: Harness) => () => void;
}> = [
  { name: 'tampered ciphertext', corrupt: (id, harness) => {
    const keys = JSON.parse(fs.readFileSync(keysFileOf(id), 'utf8')) as Record<string, string>;
    patchEntry(id, harness, flipLast(keys[`linkmode:${harness}`]));
    return () => {};
  } },
  { name: 'wrong server key', corrupt: () => {
    process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
    store._resetProviderSecretsServerKeyCache();
    return () => {
      process.env.NASSAJ_PROVIDER_SECRETS_KEY = SERVER_KEY.toString('base64');
      store._resetProviderSecretsServerKeyCache();
    };
  } },
  { name: 'corrupt keys.json', store: true, corrupt: (id) => {
    fs.writeFileSync(keysFileOf(id), '{"linkmode:');
    return () => fs.rmSync(keysFileOf(id), { force: true });
  } },
  { name: 'invalid JSON payload', corrupt: (id, harness) => { patchEntry(id, harness, envelope('{mode:')); return () => {}; } },
  { name: 'payload that is not a link-mode record', corrupt: (id, harness) => {
    patchEntry(id, harness, envelope(JSON.stringify({ mode: 'free', source: 'user' })));
    return () => {};
  } },
];

const isUnreadable = (error: unknown): boolean => {
  assertNoSecret(error);
  const err = error as { code?: string; details?: unknown; message?: string };
  assert.equal(/decrypt|cipher|auth tag|JSON|keys\.json/iu.test(err.message ?? ''), false, 'no read cause in the message');
  return err.code === 'LINK_MODE_RECORD_UNREADABLE';
};
const isAdapterUnreadable = (error: unknown): boolean => {
  const err = error as { code?: string; cause?: unknown };
  return err.code === 'provider_unavailable' && isUnreadable(err.cause);
};

/** api_key record over a subscription-only tree: the D6 state a fail-open gate would let run. */
function unreadableSetup(id: number, harness: Harness, corrupt: (id: number, harness: Harness) => () => void): () => void {
  if (harness === 'claude') claudeTree(id, false); else codexTree(id, false);
  setMode(id, harness, 'api_key');
  return corrupt(id, harness);
}

describe('B-1547: an unreadable link-mode record refuses the run', () => {
  for (const { name, store: wholeStore, corrupt } of UNREADABLE_CASES) {
    // M2: a corrupt keys file asks for operator repair; a bad entry asks for a new link mode.
    const detailsFor = (provider: Harness) => (wholeStore ? { provider, operatorRepair: true } : { provider });
    it(`claude: ${name}`, async () => {
      const restore = unreadableSetup(owner.id, 'claude', corrupt);
      try {
        await assert.rejects(runClaudeProfile(owner.id), (error) => {
          assert.deepEqual((error as { details?: unknown }).details, detailsFor('claude'));
          assert.equal((error as Error).message.includes('operator repair'), wholeStore === true);
          return isUnreadable(error);
        });
        await assert.rejects(runClaudeTurn(owner.id), isAdapterUnreadable);
        assert.equal(spawns.claude, 0);
      } finally { restore(); }
    });

    it(`codex: ${name}`, async () => {
      const restore = unreadableSetup(owner.id, 'codex', corrupt);
      try {
        await assert.rejects(runCodexTurn(owner.id), isAdapterUnreadable);
        await assert.rejects(runCodexCompaction(owner.id), (error) => {
          assert.deepEqual((error as { details?: unknown }).details, detailsFor('codex'));
          return isUnreadable(error);
        });
        assert.deepEqual([spawns.codex, spawns.appServer], [0, 0]);
      } finally { restore(); }
    });
  }

  it('a grantee under a grantor whose record is unreadable is refused (D6)', async () => {
    const restoreClaude = unreadableSetup(grantor.id, 'claude', UNREADABLE_CASES[0].corrupt);
    const restoreCodex = unreadableSetup(grantor.id, 'codex', UNREADABLE_CASES[0].corrupt);
    try {
      await assert.rejects(runClaudeProfile(grantee.id), isUnreadable);
      await assert.rejects(runCodexTurn(grantee.id), isAdapterUnreadable);
      assert.deepEqual([spawns.claude, spawns.codex], [0, 0]);
    } finally { restoreClaude(); restoreCodex(); }
  });

  it('absent record: the derived default still applies and is not persisted', async () => {
    const fresh = userDb.createUser('rungate-absent', 'hash', 'user') as { id: number };
    claudeTree(fresh.id, false);
    codexTree(fresh.id, false);
    assert.deepEqual(store.readLinkModeRecordState(fresh.id, 'claude'), { state: 'absent' });
    await runClaudeProfile(fresh.id);
    await runClaudeTurn(fresh.id);
    await runCodexTurn(fresh.id);
    assert.deepEqual([spawns.claude, spawns.codex], [1, 1]);
    assert.deepEqual(store.readLinkModeRecordState(fresh.id, 'codex'), { state: 'absent' });
  });

  it('a readable record is unchanged: subscription runs, api_key without a key is KEY_MISSING', async () => {
    claudeTree(owner.id, false);
    setMode(owner.id, 'claude', 'subscription');
    await runClaudeTurn(owner.id);
    assert.equal(spawns.claude, 1);
    setMode(owner.id, 'claude', 'api_key');
    await assert.rejects(runClaudeProfile(owner.id), isKeyMissing);
  });

  it('flag off: an unreadable record does not block legacy runs', async () => {
    const restore = unreadableSetup(owner.id, 'codex', UNREADABLE_CASES[0].corrupt);
    try {
      process.env[FLAG] = '0';
      await runCodexTurn(owner.id);
      assert.equal(spawns.codex, 1);
    } finally { restore(); }
  });

  it('M1: a corrupt keys file refuses every secret write, keeps its bytes, and the run stays refused', async () => {
    const restore = unreadableSetup(owner.id, 'claude', UNREADABLE_CASES[2].corrupt);
    try {
      const file = keysFileOf(owner.id);
      const before = fs.readFileSync(file);
      const isStoreRefusal = (error: unknown): boolean => {
        const err = error as { code?: string; statusCode?: number; message?: string };
        assert.equal(err.message, 'The credential store needs operator repair.');
        return err.code === 'PROVIDER_SECRETS_STORE_UNREADABLE';
      };
      const writes: Array<[string, () => unknown]> = [
        ['vendor key', () => providerSecretsService.setKey(owner.id, 'kimi', 'sk' + '-kimi-B1547')],
        ['vendor key delete', () => providerSecretsService.deleteKey(owner.id, 'kimi')],
        ['voice key', () => setTranscriptionKey('user', owner.id, 'voice-B1547')],
        ['voice key delete', () => deleteTranscriptionKey('user', owner.id)],
        ['connector secret', () => store.setNamespacedSecret(owner.id, 'connector', 'canva', 'conn-B1547')],
        ['connector delete', () => store.deleteNamespacedSecret(owner.id, 'connector', 'canva')],
        ['local-model secret', () => store.setLocalModelSecret(owner.id, 'srv1', 'lm-B1547')],
        ['local-model delete', () => store.deleteLocalModelSecret(owner.id, 'srv1')],
        ['canonical key', () => store.setCanonicalVendorKey(owner.id, 'anthropic', 'sk' + '-ant-api03-B1547')],
        ['canonical key delete', () => store.deleteCanonicalVendorKey(owner.id, 'anthropic')],
        ['link mode', () => setMode(owner.id, 'claude', 'subscription')],
      ];
      for (const [label, write] of writes) {
        assert.throws(write, isStoreRefusal, label);
        assert.deepEqual(fs.readFileSync(file), before, `${label}: bytes unchanged`);
      }
      await assert.rejects(runClaudeProfile(owner.id), isUnreadable);
      assert.equal(spawns.claude, 0);
    } finally { restore(); }
  });
});
