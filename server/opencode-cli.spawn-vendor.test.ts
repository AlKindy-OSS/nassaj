/**
 * ADR-200 S8 — spawnOpenCode on a `moonshot/*` or `deepseek/*` RESOLVED model.
 *
 *  • NASSAJ_OPENCODE_SPAWN_VENDORS on (B-1575): a carrier run — governance, GL-3 file check, loopback guard,
 *    sanitization, project-config switch, and the inline-config check bound to
 *    this vendor's origin all run (the REAL guard module, wrapped to count);
 *  • only the selected vendor's key is in the child env, inherited copies of
 *    either variable are gone, and no ANTHROPIC_* variable is set;
 *  • the key is the SENDER's own slot: a grant holder without a key gets
 *    `missing_key` (the grantor's key is never read), with no key in any frame;
 *  • flag off: the legacy opencode path, byte for byte (no key read, no guard);
 *  • B-1551 M1: the env and the token read use the sender's OWN data dir
 *    (honorGrants:false); a session only in the grantor's dir is refused;
 *  • B-1551 M2: case variants and models.dev aliases launch the canonical id.
 */
// B-1544: must stay the first app-side import (HOME, DATABASE_PATH, harness roots).
import { removeSandbox } from './modules/providers/tests/helpers/hermetic-sandbox.js';
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test, { after, beforeEach, mock } from 'node:test';

const url = (relativePath: string) => new URL(relativePath, import.meta.url).href;
const MOONSHOT_KEY = ['ms', 'live-secret-ABCDEFGHIJ0123456789'].join('-');
const DEEPSEEK_KEY = ['ds', 'live-secret-ZYXWVUTSRQ9876543210'].join('-');
const GRANTOR_KEY = ['ms', 'grantor-secret-0123456789ABCD'].join('-');
const FLAG = 'NASSAJ_OPENCODE_SPAWN_VENDORS';

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; kill: () => boolean };
let spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
let child: FakeChild | null = null;
let resolvedModel = 'moonshot/kimi-k2.6';
let ownKeys: Record<string, string> = {};
let keyReads: Array<{ userId: unknown; slot: string }> = [];
let inheritedEnv: Record<string, string> = {};
const guardCalls: Record<string, number> = {};
let governanceCalls = 0;
let audits: Array<{ action: string; options: { userId?: number; metadata?: Record<string, unknown> } }> = [];
let envOptions: Array<unknown> = [];
let dbPathOptions: Array<unknown> = [];
let sessionOnGrantTree = false;

const spawnFake = (_cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
  const created = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 0, kill: () => true,
  }) as FakeChild;
  child = created;
  spawned.push({ args, env: opts.env });
  return created;
};

// The real guard, loaded under a distinct URL before the mock replaces it.
const realGuard = await import(`${url('./services/isolation/opencode-baseurl-guard.js')}?real`);
const counted = (name: string) => (...args: unknown[]) => {
  guardCalls[name] = (guardCalls[name] ?? 0) + 1;
  return (realGuard as Record<string, (...a: unknown[]) => unknown>)[name](...args);
};

mock.module('child_process', { namedExports: { spawn: spawnFake } });
mock.module('cross-spawn', { defaultExport: spawnFake });
mock.module(url('./modules/database/index.js'), {
  namedExports: {
    messageAuthorsDb: { recordUserMessage: () => undefined },
    participantsDb: { recordSpawn: () => undefined },
    sessionsDb: { getSessionEnginePin: () => null, setSessionEnginePin: () => undefined },
    auditLogDb: { record: (action: string, options: never) => { audits.push({ action, options }); } },
  },
});
mock.module(url('./modules/providers/services/sessions.service.js'), {
  namedExports: { sessionsService: { normalizeMessage: () => [] } },
});
mock.module(url('./modules/providers/services/turn-timing.service.js'), {
  namedExports: {
    createTurnTimer: () => ({ markModelActivity: () => undefined, startedAt: () => new Date().toISOString() }),
    settleTurnTiming: () => ({}),
  },
});
mock.module(url('./modules/providers/services/provider-auth.service.js'), {
  namedExports: { providerAuthService: { isProviderInstalled: async () => true } },
});
mock.module(url('./modules/providers/services/provider-models.service.js'), {
  namedExports: { providerModelsService: { resolveResumeModel: async () => resolvedModel } },
});
mock.module(url('./modules/providers/services/provider-secrets.service.js'), {
  namedExports: {
    providerSecretsService: {
      getQwenProfile: () => null,
      getOwnVendorKey: (userId: unknown, slot: string) => {
        keyReads.push({ userId, slot });
        return ownKeys[`${userId}:${slot}`] ?? null;
      },
    },
  },
});
mock.module(url('./modules/providers/list/opencode/opencode-redaction-secrets.js'), {
  namedExports: { collectOpenCodeTurnSecrets: () => [MOONSHOT_KEY, DEEPSEEK_KEY, GRANTOR_KEY] },
});
mock.module(url('./services/notification-orchestrator.js'), {
  namedExports: { notifyRunFailed: () => undefined, notifyRunStopped: () => undefined },
});
mock.module(url('./shared/utils.js'), {
  namedExports: {
    createNormalizedMessage: (payload: object) => payload,
    stampCoordinatorId: (payload: object) => payload,
    resolveOpenCodeBinaryPath: () => '/fake/opencode',
  },
});
mock.module(url('./shared/cwd-check.js'), {
  namedExports: { checkCwdExists: async () => ({ ok: true }), buildCwdMissingPayload: () => ({}) },
});
mock.module(url('./shared/spawn-error.js'), {
  namedExports: { mapSpawnError: (error: Error) => ({ code: 'spawn_error', fallbackMessage: error.message }) },
});
mock.module(url('./services/isolation/provision-user-dirs.js'), {
  namedExports: { provisionUserDirs: () => undefined, userConfigDir: () => '/fake/config' },
});
mock.module(url('./services/isolation/resolve-provider-env.js'), {
  // XDG_CONFIG_HOME points at a missing dir: the GL-3 file check sees no file.
  namedExports: {
    resolveProviderEnv: (...args: unknown[]) => {
      // B-1707 also asks for the sender's Claude env (permission parity); only the
      // OpenCode child env is under test here.
      if (args[1] === 'opencode') envOptions.push(args[4]);
      return { PATH: '/usr/bin', XDG_CONFIG_HOME: '/nonexistent-s8', ...inheritedEnv };
    },
  },
});
mock.module(url('./services/provider-run-presence.js'), {
  namedExports: { beginProviderRun: () => ({ end: () => undefined, rekey: () => undefined, setPid: () => undefined }) },
});
mock.module(url('./modules/providers/harness-update/spawn-admission.js'), {
  namedExports: { refuseSpawnIfHarnessUpdating: () => false },
});
mock.module(url('./services/isolation/provider-cage-wiring.js'), {
  namedExports: { resolveCagedLaunch: ({ cmd, args }: { cmd: string; args: string[] }) => ({ cmd, args }) },
});
mock.module(url('./services/isolation/opencode-baseurl-guard.js'), {
  namedExports: {
    ...realGuard,
    assertOpenCodeBaseUrlAllowed: counted('assertOpenCodeBaseUrlAllowed'),
    assertOpenCodeProjectConfigAllowed: counted('assertOpenCodeProjectConfigAllowed'),
    assertOpenCodeCarrierServerLocal: counted('assertOpenCodeCarrierServerLocal'),
    assertOpenCodeInlineConfigAllowed: counted('assertOpenCodeInlineConfigAllowed'),
  },
});
mock.module(url('./modules/providers/list/opencode/opencode-home.js'), {
  namedExports: {
    resolveOpenCodeDatabasePathForUser: (_userId: unknown, options: unknown) => {
      dbPathOptions.push(options);
      return '/nonexistent/opencode.db';
    },
    isOpenCodeSessionOnlyOnGrantTree: () => sessionOnGrantTree,
  },
});
mock.module(url('./services/isolation/local-model-config.js'), {
  namedExports: {
    assertLocalModelAvailable: () => undefined,
    authorizedLocalModelServers: () => [],
    isLocalModel: () => false,
    localModelsEnabled: () => false,
  },
});
mock.module(url('./services/isolation/local-model-timeout.js'), { namedExports: { watchLocalModelProgress: () => null } });
mock.module(url('./services/isolation/opencode-config-material.js'), { namedExports: { materializeOpenCodeConfig: () => true } });
mock.module(url('./modules/providers/list/opencode/opencode-governance.js'), {
  namedExports: { ensureOpenCodeGovernance: () => { governanceCalls += 1; return { ok: true }; } },
});

const { spawnOpenCode, isOpenCodeCarrierRun } = await import('./opencode-cli.js');
const ORIGINAL_FLAG = process.env[FLAG];
const ORIGINAL_CARRIER = process.env.NASSAJ_OPENCODE_CARRIER;
// B-1575: the cells also need unified keys on, so the suite runs at that flag's
// default (unset) whatever the parent process carries.
const ORIGINAL_UNIFIED = process.env.NASSAJ_UNIFIED_VENDOR_KEYS;
after(() => {
  mock.restoreAll();
  if (ORIGINAL_FLAG === undefined) delete process.env[FLAG];
  else process.env[FLAG] = ORIGINAL_FLAG;
  if (ORIGINAL_CARRIER !== undefined) process.env.NASSAJ_OPENCODE_CARRIER = ORIGINAL_CARRIER;
  if (ORIGINAL_UNIFIED !== undefined) process.env.NASSAJ_UNIFIED_VENDOR_KEYS = ORIGINAL_UNIFIED;
  removeSandbox();
});

beforeEach(() => {
  spawned = []; child = null; keyReads = []; governanceCalls = 0; audits = [];
  envOptions = []; dbPathOptions = []; sessionOnGrantTree = false;
  for (const name of Object.keys(guardCalls)) delete guardCalls[name];
  resolvedModel = 'moonshot/kimi-k2.6';
  ownKeys = { '7:kimi': MOONSHOT_KEY, '7:deepseek': DEEPSEEK_KEY, '1:kimi': GRANTOR_KEY };
  inheritedEnv = {};
  process.env[FLAG] = 'true';
  delete process.env.NASSAJ_UNIFIED_VENDOR_KEYS;
  delete process.env.NASSAJ_OPENCODE_CARRIER;
});

async function launch(userId: number | null = 7) {
  const frames: Array<Record<string, unknown>> = [];
  const ws = { userId, send: (frame: Record<string, unknown>) => { frames.push(frame); }, setSessionId: () => undefined };
  const run = spawnOpenCode('hello', { cwd: process.cwd(), sessionId: 'ses-s8' }, ws as never)
    .then(() => null, (error: unknown) => error);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { frames, run };
}

async function finish(run: Promise<unknown>) {
  child?.emit('close', 0);
  await run;
}

const FULL_CHAIN = [
  'assertOpenCodeBaseUrlAllowed', 'assertOpenCodeCarrierServerLocal',
  'assertOpenCodeProjectConfigAllowed', 'assertOpenCodeInlineConfigAllowed',
];

for (const [model, keyEnv, otherEnv, key, host] of [
  ['moonshot/kimi-k2.6', 'NASSAJ_MOONSHOT_API_KEY', 'NASSAJ_DEEPSEEK_API_KEY', MOONSHOT_KEY, 'https://api.moonshot.ai/v1'],
  ['deepseek/deepseek-v4-pro', 'NASSAJ_DEEPSEEK_API_KEY', 'NASSAJ_MOONSHOT_API_KEY', DEEPSEEK_KEY, 'https://api.deepseek.com/v1'],
] as const) {
  test(`${model}: the guard chain runs and only this vendor's key reaches the child`, async () => {
    resolvedModel = model;
    inheritedEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: 'owner-oauth', ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
      [otherEnv]: 'inherited-other', [keyEnv]: 'inherited-stale', NASSAJ_QWEN_PLAN_API_KEY: 'inherited-qwen',
    };
    const { run } = await launch();
    assert.equal(spawned.length, 1);
    const { env, args } = spawned[0];
    for (const name of FULL_CHAIN) assert.equal(guardCalls[name], 1, name);
    assert.equal(governanceCalls, 1, 'governance gate ran');
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
    assert.equal(env[keyEnv], key);
    assert.equal(env[otherEnv], undefined, 'the other vendor key is absent');
    assert.equal(env.NASSAJ_QWEN_PLAN_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'sanitized');
    assert.ok(!Object.keys(env).some((name) => name.startsWith('ANTHROPIC_')), 'iron rule: no ANTHROPIC_* in the child');
    const config = JSON.parse(String(env.OPENCODE_CONFIG_CONTENT));
    const providerId = model.split('/')[0];
    assert.deepEqual(Object.keys(config.provider), [providerId]);
    assert.equal(config.provider[providerId].options.baseURL, host);
    assert.ok(!String(env.OPENCODE_CONFIG_CONTENT).includes(key));
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', model]);
    assert.deepEqual(keyReads, [{ userId: 7, slot: providerId === 'moonshot' ? 'kimi' : 'deepseek' }]);
    assert.deepEqual(audits, [{
      action: 'spawn_vendor_execution_allowed',
      options: { userId: 7, metadata: { engine: 'opencode', vendor: providerId, model } },
    }], 'M3: one allowed row, no key');
    await finish(run);
  });
}

test('a grant holder without an own key gets missing_key; the grantor key is never read', async () => {
  const { frames, run } = await launch(8);
  assert.ok((await run) instanceof Error);
  assert.equal(spawned.length, 0, 'never spawned');
  assert.deepEqual(keyReads, [{ userId: 8, slot: 'kimi' }], 'only the sender slot is read');
  const error = frames.find((frame) => frame.kind === 'error');
  assert.equal(error?.code, 'missing_key');
  assert.ok(String(error?.content).length > 0);
  assert.ok(!JSON.stringify(frames).includes(GRANTOR_KEY));
  assert.ok(!JSON.stringify(frames).includes(MOONSHOT_KEY));
  assert.deepEqual(audits, [{
    action: 'spawn_vendor_execution_rejected',
    options: { userId: 8, metadata: { engine: 'opencode', vendor: 'moonshot', model: 'moonshot/kimi-k2.6', code: 'missing_key' } },
  }], 'M3: one rejected row with the code, no key');
});

test('a grant holder with an own key spends their own key', async () => {
  ownKeys['8:kimi'] = ['ms', 'holder-own-secret-0123456789'].join('-');
  const { run } = await launch(8);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].env.NASSAJ_MOONSHOT_API_KEY, ownKeys['8:kimi']);
  await finish(run);
});

test('an unauthenticated turn and a subscription token are refused before spawn', async () => {
  let attempt = await launch(null);
  assert.ok((await attempt.run) instanceof Error);
  assert.equal(attempt.frames.find((frame) => frame.kind === 'error')?.code, 'missing_key');
  ownKeys['7:kimi'] = ['sk', 'ant', 'oat01', 'abcdefghijklmnop'].join('-');
  attempt = await launch(7);
  assert.ok((await attempt.run) instanceof Error);
  assert.equal(attempt.frames.find((frame) => frame.kind === 'error')?.code, 'subscription_token_refused');
  assert.ok(!JSON.stringify(attempt.frames).includes(ownKeys['7:kimi']));
  assert.equal(spawned.length, 0);
});

test('flag off: the legacy opencode path, no key read and no guard', async () => {
  delete process.env[FLAG];
  for (const model of ['moonshot/kimi-k2.6', 'deepseek/deepseek-v4-pro']) {
    resolvedModel = model;
    spawned = [];
    const { run } = await launch();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].env.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(spawned[0].env.NASSAJ_DEEPSEEK_API_KEY, undefined);
    await finish(run);
  }
  assert.deepEqual(keyReads, []);
  assert.deepEqual(guardCalls, {});
  assert.deepEqual(audits, [], 'flag off: no spawn-vendor audit row');
});

test('B-1551 M1: a spawn-vendor turn runs and reads tokens on the sender\'s own data dir', async () => {
  const { run } = await launch();
  assert.equal(spawned.length, 1);
  assert.deepEqual(envOptions, [{ honorGrants: false }], 'child env built with grants off');
  await finish(run);
  assert.deepEqual(dbPathOptions, [{ honorGrants: false }], 'token totals from the own opencode.db');
});

test('B-1551 M1: flag off keeps the grant-honoring env and token read', async () => {
  delete process.env[FLAG];
  const { run } = await launch();
  assert.deepEqual(envOptions, [undefined]);
  await finish(run);
  assert.deepEqual(dbPathOptions, [{ honorGrants: true }]);
});

test('B-1551 M1: resuming a conversation stored only in the grantor\'s dir is refused before spawn', async () => {
  sessionOnGrantTree = true;
  const { frames, run } = await launch();
  assert.ok((await run) instanceof Error);
  assert.equal(spawned.length, 0, 'never spawned');
  const error = frames.find((frame) => frame.kind === 'error');
  assert.equal(error?.code, 'session_on_grant_tree');
  assert.ok(String(error?.content).length > 0);
  assert.ok(!JSON.stringify(frames).includes(MOONSHOT_KEY));
  assert.equal(audits[0]?.action, 'spawn_vendor_execution_rejected');
  assert.equal(audits[0]?.options.metadata?.code, 'session_on_grant_tree');
});

for (const [given, launched, providerId, host] of [
  ['MoonshotAI/Kimi-K2.6', 'moonshot/kimi-k2.6', 'moonshot', 'https://api.moonshot.ai/v1'],
  ['DEEPSEEK/deepseek-v4-pro', 'deepseek/deepseek-v4-pro', 'deepseek', 'https://api.deepseek.com/v1'],
  ['moonshotai-cn/kimi-k3', 'moonshot-cn/kimi-k3', 'moonshot-cn', 'https://api.moonshot.cn/v1'],
] as const) {
  test(`B-1551 M2: ${given} launches as ${launched} under the full guard chain`, async () => {
    resolvedModel = given;
    const { run } = await launch();
    assert.equal(spawned.length, 1);
    const { env, args } = spawned[0];
    for (const name of FULL_CHAIN) assert.equal(guardCalls[name], 1, name);
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', launched]);
    const config = JSON.parse(String(env.OPENCODE_CONFIG_CONTENT));
    assert.deepEqual(Object.keys(config.provider), [providerId]);
    assert.equal(config.provider[providerId].options.baseURL, host);
    assert.deepEqual(envOptions, [{ honorGrants: false }]);
    assert.equal(audits[0]?.options.metadata?.model, launched, 'audit records the canonical id');
    assert.equal(audits[0]?.options.metadata?.vendor, providerId);
    await finish(run);
  });
}

test('isOpenCodeCarrierRun covers the moonshot/ and deepseek/ prefixes only under the flag', () => {
  for (const model of ['moonshot/kimi-k2.6', 'deepseek/deepseek-v4-pro']) {
    assert.equal(isOpenCodeCarrierRun({}, { [FLAG]: 'on' }, model), true, model);
    assert.equal(isOpenCodeCarrierRun({ model }, { [FLAG]: 'on' }, undefined), true, model);
    assert.equal(isOpenCodeCarrierRun({}, {}, model), false, model);
  }
  assert.equal(isOpenCodeCarrierRun({}, { [FLAG]: 'on' }, 'anthropic/claude-sonnet'), false);
});

test('B-1575: the unified kill switch keeps a spawn-vendor model on the legacy path', async () => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  const { run } = await launch();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(spawned[0].env.NASSAJ_MOONSHOT_API_KEY, undefined);
  await finish(run);
  assert.deepEqual(keyReads, []);
});
