/**
 * ADR-227 "Codex and DSH bodies" / T-2107 — acceptance in the owner's terms, at
 * the real Codex spawn chokepoint (queryCodex): "with the Codex local switch on
 * and my own local server registered, a Codex chat on a local model runs on that
 * server and never carries a ChatGPT/OpenAI credential; with the switch off,
 * nothing changes for Codex".
 *
 * Real database, real local-model rows, real run path; only @openai/codex-sdk is
 * mocked at the module boundary (no real CLI, no network): the test reads the
 * options handed to `new Codex()` and the thread. The real-CLI no-leak proof is
 * services/isolation/codex-local-engine.header-echo.test.ts.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it, mock } from 'node:test';

import { acceptFixtureRuntimeCompat, createCodexMachineFixture } from '@/shared/tests/codex-release-fixture.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-local-'));
const ORIGINAL = { ...process.env };
const sandboxHome = path.join(sandbox, 'home');
const sandboxCwd = path.join(sandbox, 'project');
fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
fs.mkdirSync(sandboxCwd, { recursive: true });
fs.writeFileSync(path.join(sandboxHome, '.claude', 'AGENTS.md'), '# AGENTS.md — neutral nassaj governance\n');
process.env.HOME = sandboxHome;
// The proven CLI version (codex-local-proven-versions.json) on the machine fixture.
const codexMachine = createCodexMachineFixture(path.join(sandbox, 'codex-machine'), '0.166.0');
await acceptFixtureRuntimeCompat();
process.env.CODEX_PATH = codexMachine.launcher;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
// Inherited OpenAI credentials that must never reach a local run (dummies).
process.env.OPENAI_API_KEY = ['sk', 'DUMMY', 'T2107', 'ENV', 'OPENAI'].join('-');
process.env.CODEX_API_KEY = ['sk', 'DUMMY', 'T2107', 'ENV', 'CODEX'].join('-');

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(this: unknown, ...callArgs: unknown[]) {
  const timer = (realSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(...callArgs);
  timer.unref();
  return timer;
} as unknown as typeof globalThis.setInterval;

type CtorOptions = { env?: Record<string, string | undefined>; config?: Record<string, unknown> };
type ThreadOptions = { model?: string };
const constructions: CtorOptions[] = [];
const threads: Array<{ kind: 'start' | 'resume'; options: ThreadOptions }> = [];

class FakeThread {
  constructor(private readonly threadId: string | null) {}

  async runStreamed(): Promise<{ events: AsyncGenerator<unknown, void, unknown> }> {
    const id = this.threadId;
    async function* events(): AsyncGenerator<unknown, void, unknown> {
      if (id) yield { type: 'thread.started', thread_id: id };
      // codex-cli 0.166.0 emits this item for every model it has no catalog entry for.
      yield { type: 'item.completed', item: { id: 'item_0', type: 'error', message: METADATA_NOTICE } };
    }
    return { events: events() };
  }
}

let nextThreadId: string | null = null;
const METADATA_NOTICE = 'Model metadata for `gpt-oss-20b` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.';
class FakeCodex {
  constructor(options: CtorOptions) { constructions.push(options); }

  startThread(options: ThreadOptions): FakeThread {
    threads.push({ kind: 'start', options });
    return new FakeThread(nextThreadId);
  }

  resumeThread(_id: string, options: ThreadOptions): FakeThread {
    threads.push({ kind: 'resume', options });
    return new FakeThread(null);
  }
}
mock.module('@openai/codex-sdk', { namedExports: { Codex: FakeCodex } });

const database = await import('@/modules/database/index.js');
const { _resetProviderSecretsServerKeyCache, setLocalModelSecret } = await import('@/services/isolation/provider-secrets-store.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const { queryCodex } = await import('@/openai-codex.js');
globalThis.setInterval = realSetInterval;

await database.initializeDatabase();
_resetProviderSecretsServerKeyCache();
database.appConfigDb.set('local_models.enabled', 'true');
database.appConfigDb.set('local_models.consent_version', '1');

after(() => {
  database.closeConnection();
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL)) delete process.env[key];
  Object.assign(process.env, ORIGINAL);
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const owner = database.userDb.createUser('codex-local-owner', 'hash', 'user');
const SERVER_KEY = ['local', 'server', 'key', 'T2107'].join('-');
const serverId = crypto.randomUUID();
const server = {
  id: serverId, ownerId: owner.id, providerId: `nassaj_local_${serverId.replaceAll('-', '')}`, name: 'Home box',
  baseUrl: 'http://127.0.0.1:18080/v1', runtime: 'llamacpp', models: [{ id: 'gpt-oss-20b', contextWindow: 32768 }],
};
database.localModelServersDb.save(server);
database.localModelServersDb.setVerifiedAddresses(server, ['127.0.0.1']);
setLocalModelSecret(owner.id, serverId, SERVER_KEY);
const LOCAL_MODEL = `${server.providerId}/gpt-oss-20b`;

/** A member Codex home holding a ChatGPT login, as on a real node (dummy token). */
const memberHome = userConfigDir(owner.id, '.codex');
fs.mkdirSync(memberHome, { recursive: true });
fs.writeFileSync(path.join(memberHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'DUMMY-CHATGPT-T2107' } }));

function makeWs(userId: number) {
  const sent: string[] = [];
  return { userId, sent, send: (message: unknown) => sent.push(typeof message === 'string' ? message : JSON.stringify(message)) };
}

/** One spawn; returns the ctor options (or null when none was built) and the frames. */
async function spawn(options: Record<string, unknown>) {
  const before = constructions.length;
  const ws = makeWs(owner.id);
  await queryCodex('ping', { cwd: sandboxCwd, ...options }, ws);
  return { opts: constructions.length > before ? constructions.at(-1)! : null, ws, thread: threads.at(-1) };
}

const setSwitch = (on: boolean) => database.appConfigDb.set('local_models.codex_enabled', on ? 'true' : 'false');

describe('Codex on my local model server (T-2107)', () => {
  it('switch on: a new chat runs on my server with only its key, never my ChatGPT login or OpenAI keys', async () => {
    setSwitch(true);
    nextThreadId = crypto.randomUUID();
    const { opts, thread } = await spawn({ model: LOCAL_MODEL });
    assert.ok(opts?.env && opts.config, 'Codex was constructed');
    assert.equal(opts.config.model_provider, 'nassaj_local');
    assert.equal(opts.config['model_providers.nassaj_local.base_url'], 'http://127.0.0.1:18080/v1');
    assert.equal(opts.config['model_providers.nassaj_local.env_key'], 'NASSAJ_LOCAL_API_KEY');
    assert.equal(opts.config['features.apps'], false);
    assert.equal(opts.config.model_context_window, 32768);
    assert.equal(opts.env.NASSAJ_LOCAL_API_KEY, SERVER_KEY);
    assert.equal(opts.env.OPENAI_API_KEY, undefined);
    assert.equal(opts.env.CODEX_API_KEY, undefined);
    assert.notEqual(opts.env.CODEX_HOME, memberHome, 'never the member home that holds the login');
    assert.equal(fs.existsSync(path.join(opts.env.CODEX_HOME!, 'auth.json')), false);
    assert.equal(fs.realpathSync(path.join(opts.env.CODEX_HOME!, 'sessions')), fs.realpathSync(path.join(memberHome, 'sessions')));
    assert.equal(thread?.options.model, 'gpt-oss-20b', 'the CLI gets the bare model id');
    const pin = database.sessionsDb.getSessionEnginePin(nextThreadId)?.engine ?? '';
    assert.match(pin, new RegExp(`^local:${serverId}:${owner.id}:[0-9a-f]{32}$`), 'the chat is pinned to my server');
  });

  it('a local chat resumes on its server; re-picking a cloud model on it is refused', async () => {
    setSwitch(true);
    const pinned = nextThreadId!;
    const resumed = await spawn({ sessionId: pinned, model: LOCAL_MODEL });
    assert.equal(resumed.thread?.kind, 'resume');
    assert.equal(resumed.opts?.env?.NASSAJ_LOCAL_API_KEY, SERVER_KEY);
    const { providerModelsService } = await import('@/modules/providers/index.js');
    await providerModelsService.changeActiveModel('codex', { sessionId: pinned, model: 'gpt-5.5' });
    const moved = await spawn({ sessionId: pinned, model: 'gpt-5.5' });
    assert.equal(moved.opts, null, 'no Codex child on the cloud');
    assert.ok(moved.ws.sent.some((frame) => frame.includes('pinned to a different engine')));
  });

  it('a cloud chat asking for a local model is refused, never moved', async () => {
    setSwitch(true);
    const cloudId = crypto.randomUUID();
    nextThreadId = cloudId;
    await spawn({ model: 'gpt-5.5' });
    assert.equal(database.sessionsDb.getSessionEnginePin(cloudId)?.engine ?? null, null, 'a cloud chat gets no pin');
    // B-167: an existing chat's model comes from its own store; the re-pick is the move.
    const { providerModelsService } = await import('@/modules/providers/index.js');
    await providerModelsService.changeActiveModel('codex', { sessionId: cloudId, model: LOCAL_MODEL });
    const { opts, ws } = await spawn({ sessionId: cloudId, model: LOCAL_MODEL });
    assert.equal(opts, null, 'no Codex child');
    assert.ok(ws.sent.some((frame) => frame.includes('Refusing to run elsewhere')), 'typed refusal reached the user');
  });

  it('switch off: a local model is refused (no fallback) and a cloud chat is exactly as before', async () => {
    setSwitch(false);
    const refused = await spawn({ model: LOCAL_MODEL });
    assert.equal(refused.opts, null);
    assert.ok(refused.ws.sent.some((frame) => frame.includes('Codex on local model servers is turned off')));
    nextThreadId = null;
    const cloud = await spawn({ model: 'gpt-5.5' });
    assert.ok(cloud.opts?.env && cloud.opts.config);
    assert.equal(cloud.opts.env.CODEX_HOME, memberHome);
    assert.equal(cloud.opts.env.NASSAJ_LOCAL_API_KEY, undefined);
    assert.equal('model_provider' in cloud.opts.config, false);
    assert.equal('features.apps' in cloud.opts.config, false);
    assert.equal(cloud.thread?.options.model, 'gpt-5.5');
  });
});

describe('the service gate in a cloud Codex chat (B-1790)', () => {
  it('a cloud chat whose service gate cannot be trusted is refused, and my config is left alone', async () => {
    const hooks = path.join(memberHome, 'hooks.json');
    const config = path.join(memberHome, 'config.toml');
    // The dist form, so the refusal comes from the lookup the fixture CLI cannot answer.
    const command = 'f=/x/hooks/service-gate.js; n=/usr/bin/node; [ -r "$f" ] && [ -x "$n" ] || { echo "service-gate: engine $f or $n '
      + 'missing; shell call blocked fail-closed" >&2; exit 2; }; exec "$n" "$f" --harness codex # nassaj-service-gate';
    fs.writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }));
    fs.writeFileSync(config, 'personality = "pragmatic"\n');
    try {
      nextThreadId = null;
      const { opts, ws } = await spawn({ model: 'gpt-5.5' });
      assert.equal(opts, null, 'no Codex child without the gate');
      assert.ok(ws.sent.some((frame) => frame.includes('service guard could not be enabled') && frame.includes('hooks.json')),
        'typed refusal naming the file reached the user');
      assert.equal(fs.readFileSync(config, 'utf8'), 'personality = "pragmatic"\n');
    } finally {
      fs.rmSync(hooks, { force: true });
      fs.rmSync(config, { force: true });
    }
  });
});

describe('the CLI model-metadata notice (T-2107 qa high 7)', () => {
  it('a local chat consumes it as a log line before the event pipeline; a cloud chat does not', async () => {
    const logged: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => { logged.push(String(args[0])); };
    try {
      setSwitch(true);
      nextThreadId = crypto.randomUUID();
      await spawn({ model: LOCAL_MODEL });
      assert.equal(logged.filter((line) => line.includes('no catalog metadata')).length, 1, 'local: logged once');
      nextThreadId = crypto.randomUUID();
      await spawn({ model: 'gpt-5.5' });
      assert.equal(logged.filter((line) => line.includes('no catalog metadata')).length, 1, 'cloud: untouched');
    } finally {
      console.info = original;
    }
  });

  it('only the exact CLI notice matches', async () => {
    const { isModelMetadataNotice } = await import('@/services/isolation/codex-local-run.js');
    const item = (type: string, message: unknown) => ({ type: 'item.completed', item: { type, message } });
    assert.equal(isModelMetadataNotice(item('error', METADATA_NOTICE)), true);
    assert.equal(isModelMetadataNotice(item('error', 'unexpected status 401 Unauthorized')), false);
    assert.equal(isModelMetadataNotice(item('agent_message', METADATA_NOTICE)), false);
    assert.equal(isModelMetadataNotice({ type: 'error', message: METADATA_NOTICE }), false);
  });
});
