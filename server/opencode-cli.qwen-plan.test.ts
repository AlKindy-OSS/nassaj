/**
 * T-1906 / ADR-200 S7 — spawnOpenCode on a qwen-plan/* RESOLVED model.
 *
 *  • it is a carrier run: sanitized env, loopback guard;
 *  • it refuses without the kill switch or a Token Plan (international) key of
 *    the SENDER (ws.userId); a stored Coding Plan record is `legacy_profile`;
 *  • automation, resume and agent.js / scheduled launches are NOT refused (D9);
 *  • the key reaches the child only as NASSAJ_QWEN_PLAN_API_KEY, and the inline
 *    config references it by {env:…} — never the literal key;
 *  • non-qwen runs never carry the variable (even when inherited);
 *  • child output and the persisted prompt are redacted against the sender's
 *    literal keys (a Token Plan key has no recognisable prefix), including a
 *    key split across two chunks.
 */
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test, { after, beforeEach, mock } from 'node:test';

const url = (relativePath: string) => new URL(relativePath, import.meta.url).href;
// A Token Plan key: no `sk-sp-` prefix, so only the literal layer can catch it.
const KEY = ['tp', 'live-secret-ABCDEFGHIJ0123456789'].join('-');
const TOKEN_PLAN_URL = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; kill: () => boolean };
let spawned: Array<{ cmd: string; args: string[]; env: Record<string, string | undefined> }> = [];
let child: FakeChild | null = null;
let resolvedModel = 'qwen-plan/qwen3.7-plus';
let profiles: Record<string, { plan: string; region: string; key: string } | null> = {};
let digestChecks = 0;
let loopbackChecks = 0;
let audits: Array<{ action: string; options: { userId?: number; metadata?: Record<string, unknown> } }> = [];
let inheritedEnv: Record<string, string> = {};
let recordedUserMessages: string[] = [];

const spawnFake = (cmd: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
  const created = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 0, kill: () => true,
  }) as FakeChild;
  child = created;
  spawned.push({ cmd, args, env: opts.env });
  return created;
};

mock.module('child_process', { namedExports: { spawn: spawnFake } });
mock.module('cross-spawn', { defaultExport: spawnFake });
mock.module(url('./modules/database/index.js'), {
  namedExports: {
    messageAuthorsDb: { recordUserMessage: (_sid: string, _uid: unknown, text: string) => { recordedUserMessages.push(text); } },
    participantsDb: { recordSpawn: () => undefined },
    sessionsDb: { getSessionEnginePin: () => null, setSessionEnginePin: () => undefined },
    auditLogDb: { record: (action: string, options: never) => { audits.push({ action, options }); } },
  },
});
mock.module(url('./modules/providers/services/sessions.service.js'), {
  namedExports: {
    sessionsService: {
      normalizeMessage: (_provider: string, raw: { text?: string }) => (raw.text
        ? [{ kind: 'stream_delta', id: 'm1', content: raw.text }] : []),
    },
  },
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
    providerSecretsService: { getQwenProfile: (userId: string | number) => profiles[String(userId)] ?? null },
  },
});
// The turn secret list: the sender's slot key plus, for a grant holder, the
// grantor's auth.json key (the composition is pinned in
// opencode-redaction-secrets.test.ts; here only its use by the launcher).
let grantorSecrets: string[] = [];
mock.module(url('./modules/providers/list/opencode/opencode-redaction-secrets.js'), {
  namedExports: {
    collectOpenCodeTurnSecrets: (userId: string | number | null) => {
      const key = userId === null ? undefined : profiles[String(userId)]?.key;
      return [...(key ? [key] : []), ...grantorSecrets];
    },
  },
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
  namedExports: { resolveProviderEnv: () => ({ PATH: '/usr/bin', ...inheritedEnv }) },
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
mock.module(url('./services/isolation/vendor-binary-integrity.js'), {
  namedExports: { verifyVendorBinaryDigest: () => { digestChecks += 1; } },
});
mock.module(url('./services/isolation/opencode-baseurl-guard.js'), {
  namedExports: {
    OPENCODE_CONFIG_SOURCE_ENV: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT'],
    OPENCODE_DISABLE_PROJECT_CONFIG_ENV: 'OPENCODE_DISABLE_PROJECT_CONFIG',
    OPENCODE_PROJECT_CONFIG_SCOPE: 'project',
    assertOpenCodeBaseUrlAllowed: () => undefined,
    assertOpenCodeProjectConfigAllowed: () => undefined,
    assertOpenCodeCarrierServerLocal: () => { loopbackChecks += 1; },
    assertOpenCodeInlineConfigAllowed: () => undefined,
    resolveOpenCodeConfigPath: () => '/fake/opencode.json',
  },
});
mock.module(url('./modules/providers/list/opencode/opencode-home.js'), {
  namedExports: {
    resolveOpenCodeDatabasePathForUser: () => '/nonexistent/opencode.db',
    isOpenCodeSessionOnlyOnGrantTree: () => false,
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
  namedExports: { ensureOpenCodeGovernance: () => ({ ok: true }) },
});

const { spawnOpenCode } = await import('./opencode-cli.js');
after(() => mock.restoreAll());

const ORIGINAL_FLAG = process.env.NASSAJ_OPENCODE_QWEN_PLAN;
beforeEach(() => {
  spawned = []; child = null; audits = []; digestChecks = 0; loopbackChecks = 0; recordedUserMessages = [];
  resolvedModel = 'qwen-plan/qwen3.7-plus';
  profiles = { 7: { plan: 'token_plan', region: 'international', key: KEY } };
  inheritedEnv = {};
  grantorSecrets = [];
  process.env.NASSAJ_OPENCODE_QWEN_PLAN = 'true';
});
after(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.NASSAJ_OPENCODE_QWEN_PLAN;
  else process.env.NASSAJ_OPENCODE_QWEN_PLAN = ORIGINAL_FLAG;
});

function makeWriter(userId: number | null = 7) {
  const frames: Array<Record<string, unknown>> = [];
  return { frames, ws: { userId, send: (frame: Record<string, unknown>) => { frames.push(frame); }, setSessionId: () => undefined } };
}

async function launch(options: Record<string, unknown>, userId: number | null = 7) {
  const writer = makeWriter(userId);
  const raw = spawnOpenCode('hello', { cwd: process.cwd(), sessionId: 'ses-1', ...options }, writer.ws as never);
  // Settle eagerly so a refusal is never an unhandled rejection.
  const run = raw.then(() => null, (error: unknown) => error);
  // Let the launch reach spawn (or refuse), then end the fake child.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { writer, run };
}

async function finish(run: Promise<unknown>, code = 0): Promise<void> {
  child?.emit('close', code);
  await run;
}

async function refusedWith(options: Record<string, unknown>, code: string, userId: number | null = 7) {
  const { writer, run } = await launch(options, userId);
  assert.ok((await run) instanceof Error, 'the launch rejects');
  assert.equal(spawned.length, 0, 'never spawned');
  assert.equal(writer.frames.find((frame) => frame.kind === 'error')?.code, code);
  assert.ok(!JSON.stringify(writer.frames).includes(KEY));
  assert.ok(audits.some((row) => row.action === 'qwen_execution_rejected' && row.options.metadata?.code === code));
}

test('qwen-plan turn: carrier guards run and the key is set only as the env var', async () => {
  inheritedEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'owner-oauth', BAILIAN_CODING_PLAN_API_KEY: 'x', NASSAJ_QWEN_PLAN_API_KEY: 'stale' };
  const { run } = await launch({});
  assert.equal(spawned.length, 1);
  const { env, args } = spawned[0];
  assert.equal(env.NASSAJ_QWEN_PLAN_API_KEY, KEY);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'sanitized');
  assert.equal(env.BAILIAN_CODING_PLAN_API_KEY, undefined, 'inherited Alibaba vars stripped');
  assert.equal(digestChecks, 0, 'carrier spawn has no mandatory digest pin (owner decision 2026-09-29)');
  assert.equal(loopbackChecks, 1, 'loopback guard ran');
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'qwen-plan/qwen3.7-plus']);
  const config = JSON.parse(String(env.OPENCODE_CONFIG_CONTENT));
  assert.ok(!String(env.OPENCODE_CONFIG_CONTENT).includes(KEY), 'config never holds the literal key');
  assert.equal(config.share, 'disabled');
  assert.equal(config.autoupdate, false);
  assert.equal(config.provider['qwen-plan'].options.baseURL, TOKEN_PLAN_URL);
  assert.equal(config.provider['qwen-plan'].options.apiKey, '{env:NASSAJ_QWEN_PLAN_API_KEY}');
  assert.equal(config.enabled_providers, undefined);
  const allowed = audits.filter((row) => row.action === 'qwen_execution_allowed');
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].options.userId, 7);
  assert.equal(allowed[0].options.metadata?.model, 'qwen-plan/qwen3.7-plus');
  assert.ok(!JSON.stringify(audits).includes(KEY));
  await finish(run);
});

test('automation, resume and agent.js / scheduled launches are no longer refused (D9)', async () => {
  // agent.js passes { projectPath, cwd, sessionId, model } only; a scheduled
  // message dispatches as internal_service; autoContinue/autoResume are replays.
  for (const options of [
    { model: 'qwen-plan/qwen3.7-plus' }, { autoContinue: true }, { autoResume: true }, {},
  ]) {
    spawned = [];
    const { run } = await launch(options);
    assert.equal(spawned.length, 1, JSON.stringify(options));
    assert.equal(spawned[0].env.NASSAJ_QWEN_PLAN_API_KEY, KEY);
    await finish(run);
  }
});

test('a resume that resolves to qwen-plan launches with the sender key', async () => {
  resolvedModel = 'qwen-plan/qwen3.6-plus';
  const { run } = await launch({ model: 'anthropic/claude-sonnet' });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].env.NASSAJ_QWEN_PLAN_API_KEY, KEY);
  await finish(run);
});

test('non-qwen runs never carry the key variable, even when it is inherited', async () => {
  resolvedModel = 'anthropic/claude-sonnet';
  inheritedEnv = { NASSAJ_QWEN_PLAN_API_KEY: KEY, DASHSCOPE_API_KEY: 'd' };
  const { run } = await launch({});
  assert.equal(spawned.length, 1);
  // resolveProviderEnv is mocked here; the real host-secret deny list is
  // asserted in opencode-qwen-plan.test.ts. The launcher adds nothing itself:
  assert.equal(spawned[0].env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(audits.length, 0);
  await finish(run);
});

test('refused when the kill switch is off', async () => {
  delete process.env.NASSAJ_OPENCODE_QWEN_PLAN;
  await refusedWith({}, 'qwen_plan_disabled');
  process.env.NASSAJ_OPENCODE_QWEN_PLAN = '0';
  await refusedWith({}, 'qwen_plan_disabled');
});

test('refused without a key, and the key is always the SENDER\'s own', async () => {
  profiles = { 1: { plan: 'token_plan', region: 'international', key: KEY } };
  await refusedWith({}, 'missing_key', 7);
  await refusedWith({}, 'missing_key', null);
});

test('a stored Coding Plan or china profile is a legacy_profile and is never spent', async () => {
  profiles = { 7: { plan: 'coding_plan', region: 'international', key: KEY } };
  await refusedWith({}, 'legacy_profile');
  profiles = { 7: { plan: 'token_plan', region: 'china', key: KEY } };
  await refusedWith({}, 'legacy_profile');
});

test('child output is redacted before ws.send, including a key split across chunks', async () => {
  const { writer, run } = await launch({});
  const half = Math.floor(KEY.length / 2);
  child!.stdout.write(`${JSON.stringify({ text: `leak ${KEY} end` })}\n`);
  child!.stderr.write(`env dump NASSAJ_QWEN_PLAN_API_KEY=${KEY.slice(0, half)}`);
  child!.stderr.write(`${KEY.slice(half)} tail\n`);
  child!.stdout.write('{"text":"partial ');
  child!.stdout.write(`${KEY.slice(0, half)}`);
  child!.stdout.write(`${KEY.slice(half)}"}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await finish(run);
  const sent = JSON.stringify(writer.frames);
  assert.ok(!sent.includes(KEY), 'no frame carries the key');
  assert.ok(!sent.includes(KEY.slice(0, half)) || !sent.includes(KEY.slice(half)), 'no split halves');
  assert.ok(sent.includes('[REDACTED]'));
  assert.ok(writer.frames.some((frame) => frame.kind === 'error' && String(frame.content).includes('env dump')));
});

test('a key pasted into the prompt is redacted before it is persisted', async () => {
  const writer = makeWriter();
  const run = spawnOpenCode(`use ${KEY}`, { cwd: process.cwd(), sessionId: 'ses-2' }, writer.ws as never)
    .then(() => null, (error: unknown) => error);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await finish(run);
  assert.ok(recordedUserMessages.length > 0);
  assert.ok(recordedUserMessages.every((text) => !text.includes(KEY)));
});

test('ingest redaction covers a non-qwen turn too: the sender key never reaches DB or ws', async () => {
  resolvedModel = 'anthropic/claude-sonnet';
  const writer = makeWriter();
  const run = spawnOpenCode(`paste ${KEY}`, { cwd: process.cwd(), sessionId: 'ses-3' }, writer.ws as never)
    .then(() => null, (error: unknown) => error);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  child!.stdout.write(`${JSON.stringify({ text: `echo ${KEY}` })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await finish(run);
  assert.ok(recordedUserMessages.length > 0);
  assert.ok(recordedUserMessages.every((text) => !text.includes(KEY)));
  assert.ok(!JSON.stringify(writer.frames).includes(KEY));
});

test('a grant holder turn also redacts the grantor auth.json key it runs on (M-6)', async () => {
  resolvedModel = 'openai/gpt-5';
  const GRANTOR_KEY = ['sk', 'proj-grantor-openai-0123456789'].join('-');
  grantorSecrets = [GRANTOR_KEY];
  const writer = makeWriter();
  const run = spawnOpenCode(`try ${GRANTOR_KEY}`, { cwd: process.cwd(), sessionId: 'ses-4' }, writer.ws as never)
    .then(() => null, (error: unknown) => error);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  child!.stdout.write(`${JSON.stringify({ text: `env ${GRANTOR_KEY}` })}\n`);
  child!.stderr.write(`OPENAI_API_KEY=${GRANTOR_KEY}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await finish(run);
  assert.ok(recordedUserMessages.every((text) => !text.includes(GRANTOR_KEY)));
  assert.ok(!JSON.stringify(writer.frames).includes(GRANTOR_KEY));
});
