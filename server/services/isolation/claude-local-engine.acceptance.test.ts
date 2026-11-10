/**
 * T-2098 stage 3a / ADR-227 — acceptance test in the owner's terms: "my Claude
 * chat runs on the local model server I registered, and nothing of it reaches
 * Anthropic".
 *
 * Real database, real local-model service, real run profile, real guard; no
 * mocks. Bootstrap mirrors local-models.isolation.test.ts: sandboxed $HOME and a
 * throwaway DB opened before any project module is imported.
 *
 * The local servers are loopback / private literals, so DNS resolution answers
 * from the literal itself and no packet leaves the host.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-claude-local-acceptance-'));
const ORIGINAL = {
  HOME: process.env.HOME,
  DATABASE_PATH: process.env.DATABASE_PATH,
  NASSAJ_PROVIDER_SECRETS_KEY: process.env.NASSAJ_PROVIDER_SECRETS_KEY,
};
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const database = await import('@/modules/database/index.js');
const { getConnection } = database;
const { _resetProviderSecretsServerKeyCache, setLocalModelSecret } = await import('./provider-secrets-store.js');
const { resolveClaudeRunProfileOrThrow } = await import('./resolve-claude-run-profile.js');
const { assertClaudeSpawnEnvAllowed } = await import('./claude-spawn-env-guard.js');

await database.initializeDatabase();
_resetProviderSecretsServerKeyCache();
database.appConfigDb.set('local_models.enabled', 'true');
database.appConfigDb.set('local_models.consent_version', '1');
// ADR-227: the Claude local path has its own default-off switch.
database.appConfigDb.set('local_models.claude_enabled', 'true');

after(() => {
  database.closeConnection();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const owner = database.userDb.createUser('local-claude-owner', 'hash', 'user');
const stranger = database.userDb.createUser('local-claude-stranger', 'hash', 'user');

// Built at runtime so the source carries no token-shaped literal for the export leak scan.
const SERVER_KEY = ['sk', 'local', 'server', 'key', 'not', 'anthropic'].join('-');
const FAKE_OAUTH = ['sk', 'ant', 'oat01', 'FAKE', 'must', 'never', 'leave'].join('-');
const WINDOW = 32768;

/** A member's own Claude tree holding a claude.ai login, as on a real node. */
function claudeTree(name: string): string {
  const configDir = path.join(sandbox, name, '.claude');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: FAKE_OAUTH, refreshToken: 'r', expiresAt: Date.now() + 3_600_000 },
  }));
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'claude-opus-5' } }));
  return configDir;
}

type ServerInput = { name: string; baseUrl: string; runtime: 'llamacpp' | 'ollama' | 'vllm';
  models: Array<{ id: string; contextWindow?: number }>; apiKey?: string };

/** Registers a server the way the local-models service stores it (row + encrypted key). */
function registerServer(ownerId: number, input: ServerInput, id: string = crypto.randomUUID()) {
  const server = {
    id, ownerId, providerId: `nassaj_local_${id.replaceAll('-', '')}`, name: input.name,
    baseUrl: input.baseUrl, runtime: input.runtime, models: input.models,
  };
  database.localModelServersDb.save(server);
  // ADR-227 / T-2098: stands in for the member's passed connection test.
  database.localModelServersDb.setVerifiedAddresses(server, [new URL(input.baseUrl).hostname]);
  if (input.apiKey) setLocalModelSecret(ownerId, id, input.apiKey);
  return server;
}

const ownerTree = claudeTree('owner');
const strangerTree = claudeTree('stranger');

const keyed = registerServer(owner.id, {
  name: 'Fedora llama-swap',
  baseUrl: 'http://127.0.0.1:18080/v1',
  runtime: 'llamacpp',
  models: [
    { id: 'gpt-oss-20b', contextWindow: WINDOW },
    { id: 'tiny-window', contextWindow: 16384 },
    { id: 'no-window' },
    { id: 'claude-impostor', contextWindow: WINDOW },
  ],
  apiKey: SERVER_KEY,
});
const keyless = registerServer(owner.id, {
  name: 'LAN box', baseUrl: 'http://10.20.30.40:8080/v1', runtime: 'ollama',
  models: [{ id: 'qwen3.6-35b', contextWindow: WINDOW }],
});
const publicServer = registerServer(owner.id, {
  name: 'Rented GPU', baseUrl: 'https://8.8.8.8:8443/v1', runtime: 'vllm',
  models: [{ id: 'gemma-4-26b', contextWindow: WINDOW }],
});

const modelOf = (server: { providerId: string }, id: string): string => `${server.providerId}/${id}`;

function seedSession(sessionId: string): void {
  getConnection().prepare(
    "INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, 'claude', NULL, '/var/tmp/x.jsonl')",
  ).run(sessionId);
}

type Profile = Awaited<ReturnType<typeof resolveClaudeRunProfileOrThrow>>;

function run(input: {
  userId?: number; configDir?: string; requestedModel?: string | null;
  sessionId?: string | null; clientEngine?: string | null;
}): Promise<Profile> {
  return resolveClaudeRunProfileOrThrow({
    userId: input.userId ?? owner.id,
    sessionId: input.sessionId ?? null,
    clientEngine: input.clientEngine ?? null,
    requestedModel: input.requestedModel ?? null,
    baseEnv: { HOME: sandboxHome, CLAUDE_CONFIG_DIR: input.configDir ?? ownerTree, PATH: process.env.PATH },
    envAlreadyIsolated: true,
    requireKnownResumePin: Boolean(input.sessionId),
    failOnAmbiguous: Boolean(input.sessionId),
    cwd: sandbox,
    // The installed-CLI proof gate has its own test (claude-local-cli-proof.test.ts).
    localEngineDeps: { cliVersionProven: async () => true },
  });
}

const refusedWith = (reason: string) => (error: Error & { code?: string; reason?: string }) => {
  assert.equal(error.code, 'ENGINE_PROVIDER_UNAVAILABLE', error.message);
  assert.equal(error.reason, reason, error.message);
  return true;
};

describe('my Claude chat runs on my registered local model server', () => {
  it('routes to my server origin only, with my server key and no Anthropic login', async () => {
    const profile = await run({ requestedModel: modelOf(keyed, 'gpt-oss-20b') });
    const env = profile.env;
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18080', 'origin, without /v1');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, SERVER_KEY);
    assert.equal(env.ANTHROPIC_API_KEY, '');
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
      assert.equal(env[key], 'gpt-oss-20b', key);
    }
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(WINDOW));
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096');
    assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.deepEqual([...(profile.engineOrigins ?? [])], ['http://127.0.0.1:18080']);
    assert.equal(profile.local?.model, 'gpt-oss-20b');

    // The CLI runs on a derived config dir that holds no claude.ai login.
    assert.notEqual(env.CLAUDE_CONFIG_DIR, ownerTree);
    assert.equal(fs.existsSync(path.join(env.CLAUDE_CONFIG_DIR!, '.credentials.json')), false);
    const derivedSettings = fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8');
    assert.ok(!derivedSettings.includes('claude-opus-5'), 'a user-scope model override cannot redirect the run');
    assert.ok(!JSON.stringify(env).includes(FAKE_OAUTH));
    assert.equal(env.HOME, sandboxHome, 'HOME is untouched, so managed hooks still resolve');
  });

  it('a server without a key gets a fixed placeholder token, never my Anthropic login', async () => {
    const profile = await run({ requestedModel: modelOf(keyless, 'qwen3.6-35b') });
    assert.equal(profile.env.ANTHROPIC_AUTH_TOKEN, 'nassaj-local-no-key');
    assert.equal(profile.env.ANTHROPIC_BASE_URL, 'http://10.20.30.40:8080');
  });

  it('the routing guard admits my exact server origin and nothing next to it', async () => {
    const profile = await run({ requestedModel: modelOf(keyed, 'gpt-oss-20b') });
    const ctx = { engineHosts: profile.engineHosts, engineOrigins: profile.engineOrigins, cwd: sandbox };
    await assertClaudeSpawnEnvAllowed(profile.env, ctx);
    await assert.rejects(
      assertClaudeSpawnEnvAllowed({ ...profile.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:18081' }, ctx),
      (error: Error & { code?: string }) => error.code === 'ANTHROPIC_BASE_URL_NOT_ALLOWED',
    );
  });
});

describe('what is refused, never run elsewhere', () => {
  it('another member cannot run my server', async () => {
    await assert.rejects(
      run({ userId: stranger.id, configDir: strangerTree, requestedModel: modelOf(keyed, 'gpt-oss-20b') }),
      refusedWith('server_not_found'),
    );
  });

  it('a server on a public address is refused even over https', async () => {
    await assert.rejects(run({ requestedModel: modelOf(publicServer, 'gemma-4-26b') }), refusedWith('address_not_private'));
  });

  it('an unknown context window, a window too small for Claude Code, or a claude-* id is refused', async () => {
    await assert.rejects(run({ requestedModel: modelOf(keyed, 'no-window') }), refusedWith('context_unknown'));
    await assert.rejects(run({ requestedModel: modelOf(keyed, 'tiny-window') }), refusedWith('context_too_small'));
    await assert.rejects(run({ requestedModel: modelOf(keyed, 'claude-impostor') }), refusedWith('model_id_reserved'));
  });
});

describe('a local chat stays local, an Anthropic chat stays on Anthropic', () => {
  it('a session pinned to my server resumes there, and never on Anthropic', async () => {
    const first = await run({ requestedModel: modelOf(keyed, 'gpt-oss-20b') });
    seedSession('local-chat');
    // What claude-sdk records after the first spawn (ADR-088 server verdict).
    database.sessionsDb.setSessionEnginePin('local-chat', first.effectiveEngine!, 'server_verdict');

    const resumed = await run({ sessionId: 'local-chat' });
    assert.equal(resumed.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18080');
    assert.equal(resumed.env.ANTHROPIC_MODEL, 'gpt-oss-20b');

    await assert.rejects(run({ sessionId: 'local-chat', requestedModel: 'claude-opus-5' }), refusedWith('pin_conflict'));
    await assert.rejects(
      run({ sessionId: 'local-chat', requestedModel: modelOf(keyless, 'qwen3.6-35b') }),
      refusedWith('pin_conflict'),
    );
    await assert.rejects(
      run({ userId: stranger.id, configDir: strangerTree, sessionId: 'local-chat' }),
      refusedWith('owner_mismatch'),
    );
  });

  it('changing the server address or deleting it stops the pinned chat', async () => {
    const movingInput: ServerInput = {
      name: 'Moving box', baseUrl: 'http://192.168.8.137:8080/v1', runtime: 'llamacpp',
      models: [{ id: 'gpt-oss-20b', contextWindow: WINDOW }],
    };
    const moving = registerServer(owner.id, movingInput);
    const first = await run({ requestedModel: modelOf(moving, 'gpt-oss-20b') });
    seedSession('moving-chat');
    database.sessionsDb.setSessionEnginePin('moving-chat', first.effectiveEngine!, 'server_verdict');

    registerServer(owner.id, { ...movingInput, baseUrl: 'http://192.168.8.138:8080/v1' }, moving.id);
    await assert.rejects(run({ sessionId: 'moving-chat' }), refusedWith('origin_changed'));

    database.localModelServersDb.remove(moving.id, owner.id);
    await assert.rejects(run({ sessionId: 'moving-chat' }), refusedWith('server_not_found'));
  });

  it('a chat pinned to Anthropic never moves to my local server', async () => {
    seedSession('anthropic-chat');
    database.sessionsDb.setSessionEnginePin('anthropic-chat', 'anthropic', 'server_verdict');
    await assert.rejects(
      run({ sessionId: 'anthropic-chat', requestedModel: modelOf(keyed, 'gpt-oss-20b') }),
      refusedWith('pin_conflict'),
    );
  });
});

describe('the Claude local path is off by default', () => {
  it('with OpenCode local models on but the Claude switch absent, a local model id is refused, never run elsewhere',
    async () => {
      database.appConfigDb.set('local_models.claude_enabled', 'false');
      try {
        await assert.rejects(run({ requestedModel: modelOf(keyed, 'gpt-oss-20b') }), refusedWith('feature_disabled'));
      } finally {
        database.appConfigDb.set('local_models.claude_enabled', 'true');
      }
    });
});
