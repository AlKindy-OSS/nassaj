/**
 * The argv and live stream contract of spawnOpenCode.
 *
 *  • B-1753 / ADR-226: opencode 1.19.5 declares `--file` as an ARRAY option, so a prompt
 *    placed after `--file <path>` would be swallowed as a second file. Since ADR-226 the
 *    prompt goes over stdin (after the parity plugin's hello), so argv carries no message
 *    at all. The argv is parsed here with yargs under opencode's own `run` declaration and
 *    parser configuration (`populate--`), as its handler does.
 *  • B-1754: on a context-overflow error opencode compacts and retries forever. The
 *    launcher must stop the child at the first overflow frame and emit one error.
 *  • B-1751: live assistant frames carry the launched `--model` when the event has none.
 *  • B-1755: a local model whose window cannot hold the fixed base prompt is refused
 *    before spawn with one error; an unknown or large enough window launches.
 *  • ADR-LOCAL-INSTR-TIER-001 (S4): a local turn runs under the separate local config
 *    dir, never disables OpenCode's CLAUDE.md fallback (C1), refuses with its own code
 *    when the slim instructions are unavailable, carries a GLM turn's L1 plus only the
 *    local permission block (task allow-list, webfetch deny — owner 2026-11-13), and
 *    counts the output reserve, a working margin and a resumed session's stored
 *    history against the window (I8).
 */
// B-1544: must stay the first app-side import (HOME, DATABASE_PATH, harness roots).
import { removeSandbox } from './modules/providers/tests/helpers/hermetic-sandbox.js';
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after, beforeEach, mock } from 'node:test';

import Database from 'better-sqlite3';
import yargs from 'yargs';

import { fakeOpenCodeParityRuntime, fakeOpenCodePermissionParity } from './shared/__tests__/fake-opencode-parity.js';

const url = (relativePath: string) => new URL(relativePath, import.meta.url).href;
const MODEL = 'opencode/test-model';
const OVERFLOW_TEXT = 'request (40213 tokens) exceeds the available context size (32768 tokens)';

type FakeChild = EventEmitter & {
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number;
  exitCode: number | null; signalCode: string | null; kills: string[]; kill: (signal?: string) => boolean;
};
let spawned: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
let resolvedModel = MODEL;
let localWindow: number | null = null;
const LOCAL_MODEL = 'nassaj_local_1/qwen3-8b';
// The size of the live per-user governance copy the real overflow ran with (B-1754).
const GOVERNANCE_FILE = path.join(process.env.TMPDIR || os.tmpdir(), `b1755-agents-${process.pid}.md`);
writeFileSync(GOVERNANCE_FILE, 'g'.repeat(40_931));
// The slim local32 copy (S3 content at nassaj-core 3d0af49: 15,150 bytes).
const LOCAL_GOVERNANCE_FILE = path.join(process.env.TMPDIR || os.tmpdir(), `local32-agents-${process.pid}.md`);
writeFileSync(LOCAL_GOVERNANCE_FILE, 'l'.repeat(15_150));
const LOCAL_CONFIG_HOME = '/fake/users/7/.config-local';
let localTierError: (Error & { code?: string }) | null = null;
let localOutputReserve = 4096;
// A resumed session's opencode.db (B-1755 / I8): last assistant usage is the fill.
const DB_DIR = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ls-db-'));
const SESSION_DB = path.join(DB_DIR, 'opencode.db');
let sessionDbPath = '/nonexistent/opencode.db';
function seedSessionFill(input: number) {
  const db = new Database(SESSION_DB);
  db.exec('CREATE TABLE IF NOT EXISTS message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); DELETE FROM message;');
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 'ses-ls', 1, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 'ses-ls', 2, JSON.stringify({
    role: 'assistant', providerID: 'glm', modelID: 'glm-5.2', tokens: { input, cache: { read: 0 } },
  }));
  db.close();
  sessionDbPath = SESSION_DB;
}
let child: FakeChild | null = null;

const spawnFake = (_cmd: string, args: string[], opts: { env?: Record<string, string | undefined> } = {}) => {
  const created = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 0,
    exitCode: null, signalCode: null, kills: [] as string[],
  }) as FakeChild;
  created.kill = (signal = 'SIGTERM') => {
    created.kills.push(signal);
    created.signalCode = signal;
    setImmediate(() => created.emit('close', null));
    return true;
  };
  child = created;
  spawned.push({ args, env: opts.env ?? {} });
  return created;
};

/** Mirrors the live branches of the real normalizer that this suite depends on. */
const fakeNormalize = (_provider: string, raw: Record<string, any>, sessionId: string | null) => {
  if (raw.type === 'text') return [{ id: raw.id, kind: 'stream_delta', content: raw.part.text, sessionId, provider: 'opencode' }];
  if (raw.type === 'step_finish') return [{ id: raw.id, kind: 'stream_end', sessionId, provider: 'opencode' }];
  if (raw.type === 'session.compacted') return [];
  if (raw.type === 'error') {
    const content = String(raw.error?.data?.message ?? raw.error?.message ?? 'error');
    return [{
      id: raw.id, kind: 'error', content, sessionId, provider: 'opencode',
      ...(/exceeds?[^.]*context/u.test(content) ? { code: 'provider_context_overflow' } : {}),
    }];
  }
  return [];
};

// The real guard, loaded under a distinct URL before shared/utils is mocked.
const realGuard = await import(`${url('./services/isolation/opencode-baseurl-guard.js')}?real`);
mock.module(url('./services/isolation/opencode-baseurl-guard.js'), { namedExports: realGuard });
const realLocal = await import(`${url('./services/isolation/local-model-config.js')}?real`);
mock.module('child_process', { namedExports: { spawn: spawnFake } });
mock.module('cross-spawn', { defaultExport: spawnFake });
mock.module(url('./modules/database/index.js'), {
  namedExports: {
    messageAuthorsDb: { recordUserMessage: () => undefined },
    participantsDb: { recordSpawn: () => undefined },
    sessionsDb: { getSessionEnginePin: () => null, setSessionEnginePin: () => undefined },
    auditLogDb: { record: () => undefined },
  },
});
mock.module(url('./modules/providers/services/sessions.service.js'), {
  namedExports: { sessionsService: { normalizeMessage: fakeNormalize } },
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
  namedExports: { providerSecretsService: { getQwenProfile: () => null, getOwnVendorKey: () => null } },
});
mock.module(url('./modules/providers/list/opencode/opencode-redaction-secrets.js'), {
  namedExports: { collectOpenCodeTurnSecrets: () => [] },
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
mock.module(url('./services/isolation/resolve-provider-env.js'), {
  namedExports: { resolveProviderEnv: () => ({ PATH: '/usr/bin', XDG_CONFIG_HOME: '/nonexistent-launch-stream', XDG_DATA_HOME: '/nonexistent-launch-stream-data' }) },
});
mock.module(url('./services/provider-run-presence.js'), {
  namedExports: { beginProviderRun: () => ({ end: () => undefined, rekey: () => undefined, setPid: () => undefined }) },
});
mock.module(url('./modules/providers/harness-update/spawn-admission.js'), {
  namedExports: { refuseSpawnIfHarnessUpdating: () => false },
});
mock.module(url('./modules/providers/list/opencode/opencode-home.js'), {
  namedExports: {
    resolveOpenCodeDatabasePathForUser: () => sessionDbPath,
    isOpenCodeSessionOnlyOnGrantTree: () => false,
  },
});
mock.module(url('./services/isolation/local-model-config.js'), {
  namedExports: {
    assertLocalModelAvailable: () => undefined,
    authorizedLocalModelServers: () => [],
    isLocalModel: (model: unknown) => typeof model === 'string' && model.startsWith('nassaj_local_'),
    localModelsEnabled: () => true,
    localModelContextWindow: () => localWindow,
    localModelOutputReserve: () => localOutputReserve,
    LOCAL_MIN_WORKING_MARGIN_TOKENS: realLocal.LOCAL_MIN_WORKING_MARGIN_TOKENS,
    checkLocalModelContextFit: realLocal.checkLocalModelContextFit,
    estimatePromptTokens: realLocal.estimatePromptTokens,
    LOCAL_MODEL_CONTEXT_EXCEEDED: realLocal.LOCAL_MODEL_CONTEXT_EXCEEDED,
  },
});
mock.module(url('./services/isolation/local-model-timeout.js'), { namedExports: { watchLocalModelProgress: () => null } });
mock.module(url('./services/isolation/provision-user-dirs.js'), {
  namedExports: { provisionUserDirs: () => undefined, userConfigDir: () => '/fake/config' },
});
mock.module(url('./services/isolation/opencode-config-material.js'), { namedExports: { materializeOpenCodeConfig: () => true } });
mock.module(url('./modules/providers/list/opencode/opencode-local-tier.js'), {
  namedExports: {
    prepareOpenCodeLocalTier: () => {
      if (localTierError) throw localTierError;
      return { configHome: LOCAL_CONFIG_HOME, governance: { ok: true, governancePath: LOCAL_GOVERNANCE_FILE } };
    },
  },
});
mock.module(url('./modules/providers/list/opencode/opencode-governance.js'), {
  namedExports: { ensureOpenCodeGovernance: () => ({ ok: true, governancePath: GOVERNANCE_FILE }), OPENCODE_GOVERNANCE_MISSING_MESSAGE: 'governance missing' },
});
// ADR-226: the parity launch (Claude's mode, L1, engine) and the fd-3 runtime are not under test here.
const realPermissions = await import(url('./modules/providers/list/opencode/opencode-run-permissions.js'));
mock.module(url('./modules/providers/list/opencode/opencode-run-permissions.js'), {
  namedExports: { ...realPermissions, resolveOpenCodePermissionParity: fakeOpenCodePermissionParity },
});
mock.module(url('./modules/providers/list/opencode/opencode-parity-runtime.js'), { namedExports: fakeOpenCodeParityRuntime });
const { spawnOpenCode } = await import('./opencode-cli.js');

after(() => {
  mock.restoreAll();
  removeSandbox();
});

beforeEach(() => {
  spawned = []; child = null; resolvedModel = MODEL; localWindow = null;
  localTierError = null; localOutputReserve = 4096; sessionDbPath = '/nonexistent/opencode.db';
});

const PNG = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`;

async function launch(prompt: string, options: Record<string, unknown> = {}) {
  const frames: Array<Record<string, any>> = [];
  const ws = { userId: 7, send: (frame: Record<string, any>) => { frames.push(frame); }, setSessionId: () => undefined };
  const run = spawnOpenCode(prompt, { cwd: process.cwd(), sessionId: 'ses-ls', ...options }, ws as never)
    .then(() => null, (error: unknown) => error);
  for (let i = 0; i < 20 && spawned.length === 0 && frames.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { frames, run };
}

/** opencode 1.19.5 `run [message..]` declaration, under its `populate--` parser config. */
function parseLikeOpenCode(argv: string[]) {
  let parsed: Record<string, any> = {};
  yargs(argv)
    .parserConfiguration({ 'populate--': true })
    .command('run [message..]', 'run', (y) => y
      .positional('message', { type: 'string', array: true, default: [] })
      .option('session', { alias: ['s'], type: 'string' })
      .option('model', { alias: ['m'], type: 'string' })
      .option('agent', { type: 'string' })
      .option('format', { type: 'string' })
      .option('file', { alias: ['f'], type: 'string', array: true })
      .option('dangerously-skip-permissions', { type: 'boolean' }), (args) => { parsed = args; })
    .exitProcess(false)
    .fail((message) => { throw new Error(message); })
    .parse();
  return {
    message: [...(parsed.message ?? []), ...(parsed['--'] ?? [])].join(' '),
    files: parsed.file ?? [],
  };
}

/** What the child read on stdin (ADR-226: the prompt goes there, after the plugin's hello). */
const stdinText = async (fake: FakeChild) => {
  let text = '';
  fake.stdin.setEncoding('utf8');
  for await (const chunk of fake.stdin) text += chunk;
  return text;
};

test('B-1753 / ADR-226: an image attachment is a file; the prompt goes over stdin, never into argv', async () => {
  const { run } = await launch('describe this picture', { images: [{ data: PNG }] });
  assert.equal(spawned.length, 1);
  const parsed = parseLikeOpenCode(spawned[0].args);
  assert.equal(parsed.files.length, 1, `files: ${JSON.stringify(parsed.files)}`);
  assert.match(parsed.files[0], /image_0\.png$/);
  assert.equal(parsed.message, '', `argv message: ${parsed.message}`);
  assert.ok((await stdinText(child as FakeChild)).includes('describe this picture'));
  child?.emit('close', 0);
  await run;
});

test('B-1753 / ADR-226: a prompt that starts with a dash is never an option (it is not in argv)', async () => {
  const { run } = await launch('-m is a flag?', { images: [{ data: PNG }] });
  const parsed = parseLikeOpenCode(spawned[0].args);
  assert.equal(parsed.message, '');
  assert.equal(parsed.files.length, 1);
  assert.ok((await stdinText(child as FakeChild)).includes('-m is a flag?'));
  child?.emit('close', 0);
  await run;
});

const line = (event: object) => `${JSON.stringify({ sessionID: 'ses-ls', ...event })}\n`;
const overflowError = (id: string) => line({ type: 'error', id, error: { name: 'APIError', data: { message: OVERFLOW_TEXT } } });

test('B-1754: a context overflow stops the child at once with exactly one clear error', { timeout: 3000 }, async () => {
  const { frames, run } = await launch('hello');
  const fake = child as FakeChild;
  fake.stdout.write(overflowError('e1'));
  // What opencode does next on its own: compact, retry, overflow again (forever).
  fake.stdout.write(line({ type: 'session.compacted', id: 'c1' }));
  fake.stdout.write(overflowError('e2'));
  fake.stdout.write(line({ type: 'session.compacted', id: 'c2' }));
  fake.stdout.write(overflowError('e3'));
  fake.stderr.write('Error: compaction failed, retrying\n');
  const started = Date.now();
  const outcome = await run;
  assert.ok(Date.now() - started < 1000, 'the run ends quickly');
  assert.ok(fake.kills.length >= 1, 'the child is killed');
  const overflow = frames.filter((frame) => frame.kind === 'error' && frame.code === 'provider_context_overflow');
  assert.equal(overflow.length, 1, `overflow frames: ${JSON.stringify(overflow)}`);
  const errors = frames.filter((frame) => frame.kind === 'error');
  assert.equal(errors.length, 1, `error frames: ${JSON.stringify(errors)}`);
  assert.match(String(overflow[0].content), /سياق/u, 'plain local-context message');
  assert.ok(!String(overflow[0].content).includes('40213'), 'not the raw provider text');
  const complete = frames.filter((frame) => frame.kind === 'complete');
  assert.equal(complete.length, 1);
  assert.notEqual(complete[0].exitCode, 0);
  assert.ok(outcome instanceof Error);
  assert.equal((outcome as Error & { providerErrorCode?: string }).providerErrorCode, 'provider_context_overflow');
});

test('B-1751: live assistant frames carry the launched model', async () => {
  const { frames, run } = await launch('hello');
  const fake = child as FakeChild;
  fake.stdout.write(line({ type: 'text', id: 't1', part: { type: 'text', text: 'hi there' } }));
  fake.stdout.write(line({ type: 'step_finish', id: 's1' }));
  await new Promise((resolve) => setImmediate(resolve));
  fake.emit('close', 0);
  await run;
  const delta = frames.find((frame) => frame.kind === 'stream_delta');
  const end = frames.find((frame) => frame.kind === 'stream_end');
  assert.equal(delta?.model, MODEL);
  assert.equal(end?.model, MODEL);
});

test('B-1755: a local window smaller than the base prompt is refused before spawn', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  localWindow = 8192;
  const { frames, run } = await launch('hello');
  const outcome = await run;
  assert.equal(spawned.length, 0, 'never spawned');
  assert.ok(outcome instanceof Error);
  const errors = frames.filter((frame) => frame.kind === 'error');
  assert.equal(errors.length, 1, `error frames: ${JSON.stringify(errors)}`);
  assert.equal(errors[0].code, 'LOCAL_MODEL_CONTEXT_EXCEEDED');
  assert.match(String(errors[0].content), /8,?192/u, 'names the window');
  assert.match(String(errors[0].content), /سياق/u);
});

for (const window of [null, 131_072]) {
  test(`B-1755: a local model with window ${window} launches`, { timeout: 3000 }, async () => {
    resolvedModel = LOCAL_MODEL;
    localWindow = window;
    const { frames, run } = await launch('hello');
    assert.equal(spawned.length, 1, `frames: ${JSON.stringify(frames)}`);
    assert.ok(!frames.some((frame) => frame.code === 'LOCAL_MODEL_CONTEXT_EXCEEDED'));
    child?.emit('close', 0);
    await run;
  });
}

test('S4: a local turn runs under the local config dir and keeps the CLAUDE.md fallback (C1)', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  const { frames, run } = await launch('hello');
  assert.equal(spawned.length, 1, `frames: ${JSON.stringify(frames)}`);
  assert.equal(spawned[0].env.XDG_CONFIG_HOME, LOCAL_CONFIG_HOME);
  assert.ok(!('OPENCODE_DISABLE_CLAUDE_CODE_PROMPT' in spawned[0].env), 'C1: never set');
  child?.emit('close', 0);
  await run;
});

test('S4: unavailable slim instructions refuse the turn with their own code', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  localTierError = Object.assign(new Error('تعليمات نسّاج المختصرة غير متاحة (local instructions unavailable).'), {
    code: 'local_instructions_unavailable',
  });
  const { frames, run } = await launch('hello');
  const outcome = await run;
  assert.equal(spawned.length, 0, 'never spawned');
  assert.ok(outcome instanceof Error);
  const errors = frames.filter((frame) => frame.kind === 'error');
  assert.equal(errors.length, 1, `error frames: ${JSON.stringify(errors)}`);
  assert.equal(errors[0].code, 'local_instructions_unavailable');
  assert.equal(errors[0].content, localTierError.message);
});

test('S4 I1 / ADR-226 + owner 2026-11-13: a local turn carries the GLM L1 plus only the local block, same plugin', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  const local = await launch('hello');
  child?.emit('close', 0);
  await local.run;
  resolvedModel = 'glm/glm-5.2';
  const glm = await launch('hello');
  for (let i = 0; i < 100 && spawned.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  child?.emit('close', 0);
  await glm.run;
  assert.equal(spawned.length, 2);
  const [a, b] = spawned.map((entry) => entry.env);
  // ADR-226: L2 lives in the per-turn engine (server side); the child gets L1 and the plugin.
  assert.equal(b.OPENCODE_PERMISSION, '{"*":"allow"}', 'a GLM turn L1 is unchanged');
  const localL1 = JSON.parse(a.OPENCODE_PERMISSION ?? '{}');
  assert.deepEqual(Object.keys(localL1), ['*', 'task', 'webfetch'], 'the local block comes LAST');
  assert.equal(localL1['*'], 'allow');
  assert.equal(localL1.webfetch, 'deny', 'the local coordinator has no webfetch');
  assert.deepEqual(localL1.task, {
    '*': 'deny', researcher: 'allow', 'backend-dev': 'allow', devops: 'allow', scribe: 'allow', 'qa-critic': 'allow',
  });
  const pluginOf = (env: NodeJS.ProcessEnv) => JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}').plugin?.[0];
  assert.ok(pluginOf(a));
  assert.equal(pluginOf(a), pluginOf(b));
});

test('owner 2026-11-13: a bypass local turn still denies webfetch in L1; a bypass GLM turn does not', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  const local = await launch('hello', { permissionMode: 'bypassPermissions' });
  child?.emit('close', 0);
  await local.run;
  resolvedModel = 'glm/glm-5.2';
  const glm = await launch('hello', { permissionMode: 'bypassPermissions' });
  for (let i = 0; i < 100 && spawned.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  child?.emit('close', 0);
  await glm.run;
  assert.equal(spawned.length, 2);
  assert.equal(JSON.parse(spawned[0].env.OPENCODE_PERMISSION ?? '{}').webfetch, 'deny');
  assert.ok(!('webfetch' in JSON.parse(spawned[1].env.OPENCODE_PERMISSION ?? '{}')));
  assert.ok(!spawned[0].args.includes('--dangerously-skip-permissions'), 'never the skip flag');
});

test('S4 I8: a 16K window is refused once the output reserve and working margin count', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  localWindow = 16_384;
  const { frames, run } = await launch('hello');
  await run;
  assert.equal(spawned.length, 0, 'never spawned');
  const errors = frames.filter((frame) => frame.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'LOCAL_MODEL_CONTEXT_EXCEEDED');
  assert.match(String(errors[0].content), /16,?384/u);
});

test('S4 I8: a 32K window with the slim tier launches', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  localWindow = 32_768;
  const { frames, run } = await launch('hello');
  assert.equal(spawned.length, 1, `frames: ${JSON.stringify(frames)}`);
  child?.emit('close', 0);
  await run;
});

test('S4 I8: resuming a session whose stored history exceeds the local window is refused clearly', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  localWindow = 32_768;
  seedSessionFill(30_000);
  const { frames, run } = await launch('hello');
  await run;
  assert.equal(spawned.length, 0, 'never spawned');
  const errors = frames.filter((frame) => frame.kind === 'error');
  assert.equal(errors.length, 1, `error frames: ${JSON.stringify(errors)}`);
  assert.equal(errors[0].code, 'LOCAL_MODEL_CONTEXT_EXCEEDED');
  assert.match(String(errors[0].content), /30,?000/u, 'names the stored size');
  assert.match(String(errors[0].content), /محادثة جديدة/u, 'tells the user what to do');
});

test('S4 I8: resuming a small session on the local model launches', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  localWindow = 32_768;
  seedSessionFill(5_000);
  const { frames, run } = await launch('hello');
  assert.equal(spawned.length, 1, `frames: ${JSON.stringify(frames)}`);
  child?.emit('close', 0);
  await run;
});

test('S4 round 1: missing agent cards refuse the turn with their own code', { timeout: 3000 }, async () => {
  resolvedModel = LOCAL_MODEL;
  localTierError = Object.assign(new Error('بطاقات الوكلاء غير متاحة (Local-model agent cards are unavailable.)'), {
    code: 'local_agent_cards_unavailable',
  });
  const { frames, run } = await launch('hello');
  await run;
  assert.equal(spawned.length, 0, 'never spawned');
  const errors = frames.filter((frame) => frame.kind === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'local_agent_cards_unavailable');
  assert.equal(errors[0].content, localTierError.message);
});
