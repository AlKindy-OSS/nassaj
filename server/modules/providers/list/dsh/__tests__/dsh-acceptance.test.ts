/**
 * dsh-acceptance.test — T-2086 S1, ADR-224: the DeepSeek Harness (dsh) body,
 * acceptance first (TDD). Written BEFORE the provider exists; every scenario is
 * red until S2 lands.
 *
 * The S1 gate (NASSAJ_TEST_DSH_ACCEPTANCE) was removed in S3: the suite runs in
 * `npm run test:server`. Owner decision 2026-11-07: dsh runs under exactly Claude's
 * restrictions, so turns are sent in full access (Claude's bypassPermissions) and a
 * sandbox managed-settings dir stands in for the host's /etc/claude-code.
 *
 * The real binary is replaced by fake-dsh-acp-agent.mjs (ACP shapes recorded from
 * real @deepseek-ai/dsh@0.2.2-rc.1, fixtures/dsh-acp-recording.json), reached
 * through the harness registry's DSH_PATH operator override. The fake writes a
 * LAUNCH LEDGER (launches.jsonl: argv, env, PATH lookups) and the outbound LLM
 * request dsh would send (llm-requests.jsonl), so each scenario is asserted on
 * what really crossed the process boundary.
 *
 * Scenarios, in the owner's terms:
 *   1. no DeepSeek key → "link your key" (deepseek slot), zero spawns
 *   2. own key → streamed reply; escalation asks via Nassaj; approve runs,
 *      reject blocks, a client disconnect rejects the pending question
 *   3. refresh → history from Nassaj's transcript (no session/load); the next
 *      message resumes the same dsh session and the model sees earlier turns
 *   4. spawn env is exactly the allow-list; claude/codex not on the tool's PATH
 *   5. governance file cannot be healed → refused (governance_missing), no spawn
 *   6. a second turn on a running session → session busy
 *   7. no dsh_session_log / dsh_plugin_packages, telemetry off, official origin —
 *      even over a hostile user layer and a tampered Nassaj layer file
 *
 * Runner: TMPDIR=/var/tmp \
 *   npx tsx --tsconfig server/tsconfig.json --test \
 *   server/modules/providers/list/dsh/__tests__/dsh-acceptance.test.ts
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DSH_LLM_ROW, DSH_PUBLIC_BASE_URL, DSH_TELEMETRY_ROW, DSH_UPLOAD_ROWS, readPatchLayer,
} from './dsh-patch-layer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const DEADLINE_MS = Number(process.env.NASSAJ_TEST_DEADLINE_MS || 20000);

/** The exact spawn environment ADR-224 allows (values checked separately). */
const ENV_ALLOW_LIST = ['DEEPSEEK_API_KEY', 'DSH_AGENTS_HOME', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'HOME', 'LANG',
  'PATH', 'TERM', 'TMPDIR'];
/** Operator variables planted in the server env; none may reach the child. */
const HOSTILE_SERVER_ENV: Record<string, string> = {
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/exfiltrate',
  // Built at runtime so the source carries no token-shaped literal for the export leak scan.
  DEEPSEEK_API_KEY: ['sk', 'operator', 'deepseek', 'must', 'not', 'leak'].join('-'),
  ANTHROPIC_API_KEY: 'sk-ant-operator',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/anthropic',
  CLAUDE_CONFIG_DIR: '/operator/.claude',
  XDG_CONFIG_HOME: '/operator/.config',
  XDG_DATA_HOME: '/operator/.local/share',
  NODE_OPTIONS: '--require /operator/preload.js',
  JWT_SECRET: 'operator-jwt-secret',
};

type Frame = Record<string, any>;
type Row = Record<string, any>;

// ---- sandbox state (filled in before()) ----------------------------------------
let sandbox = '';
let launchDir = '';
let workspace = '';
let outside = '';
const saved: Record<string, string | undefined> = {};
let mod: Record<string, any> = {};
/** The S2 runtime module (variable specifier: it does not exist yet at S1). */
const DSH_RUNTIME_MODULE = '@/modules/providers/list/dsh/dsh-acp-runtime.js';
let runtimeLoadError: Error | null = null;
/** The S2 runtime export `name`, or a failure naming what is missing. */
function runtime(name: string): (...args: any[]) => any {
  const value = mod[name];
  if (typeof value !== 'function') {
    assert.fail(`${DSH_RUNTIME_MODULE} must export ${name}()`
      + (runtimeLoadError ? ` (module not loadable: ${runtimeLoadError.message.split('\n')[0]})` : ''));
  }
  return value;
}

/** The only Claude mode dsh can honour; every turn below sends it unless a case says otherwise. */
const FULL = Object.freeze({ permissionMode: 'bypassPermissions' });
let managedDir = '';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(probe: () => T | undefined | null | false, label: string): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > DEADLINE_MS) assert.fail(`timed out waiting for ${label}`);
    await sleep(10);
  }
}
const within = <T>(promise: Promise<T>, label: string): Promise<T> => Promise.race([
  promise,
  sleep(DEADLINE_MS).then(() => assert.fail(`timed out waiting for ${label}`)),
]);

/** Rows the fake dsh wrote to `<launchDir>/<kind>.jsonl`. */
function ledger(kind: 'launches' | 'llm-requests' | 'permissions' | 'traffic' | 'grandchildren'): Row[] {
  try {
    return fs.readFileSync(path.join(launchDir, `${kind}.jsonl`), 'utf8').trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
const launchesFor = (home: string) => ledger('launches').filter((row) => row.env?.HOME === home);
const lastLlmRequestFor = (home: string): Row | undefined => {
  const ids = new Set(launchesFor(home).map((row) => row.launchId));
  return ledger('llm-requests').filter((row) => ids.has(row.launchId)).at(-1);
};

/** A chat socket writer in the shape the launchers receive (ws.send / ws.userId / raw ws.ws). */
function makeWriter(userId: number) {
  const raw = Object.assign(new EventEmitter(), { readyState: 1, userId, send() {} });
  const frames: Frame[] = [];
  return {
    userId, ws: raw, frames, sessionId: null as string | null,
    send(message: Frame) { frames.push(message); },
    setSessionId(id: string) { this.sessionId = id; },
    disconnect() { raw.readyState = 3; raw.emit('close'); },
  };
}
const assistantText = (frames: Frame[]) => frames
  .filter((f) => (f.kind === 'stream_delta' || f.kind === 'text') && f.role !== 'user' && typeof f.content === 'string')
  .map((f) => f.content).join('');
const completeFrame = (frames: Frame[]) => frames.find((f) => f.kind === 'complete');
const createdSessionId = (frames: Frame[]): string => {
  const frame = frames.find((f) => f.kind === 'session_created');
  assert.ok(frame?.newSessionId, `no session_created frame: ${JSON.stringify(frames)}`);
  return frame.newSessionId;
};

let seq = 0;
async function newMember(withKey: boolean) {
  const user = mod.userDb.createUser(`dsh-${(seq += 1)}-${crypto.randomUUID().slice(0, 6)}`, 'hash', 'user');
  const key = `sk-member-${user.id}-${crypto.randomUUID().slice(0, 8)}`;
  if (withKey) mod.setProviderKey(user.id, 'deepseek', key);
  return { id: Number(user.id), key, home: mod.userConfigDir(user.id, '') as string };
}
/** Runs one complete turn and returns its frames. */
async function turn(member: { id: number }, command: string, options: Record<string, unknown> = {}) {
  const writer = makeWriter(member.id);
  await within(runtime('spawnDsh')(command, { cwd: workspace, ...FULL, ...options }, writer), `turn "${command}"`);
  return writer.frames;
}

describe('dsh provider — T-2086 acceptance (ADR-224)', () => {
  before(async () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-dsh-acceptance-'));
    const home = path.join(sandbox, 'operator-home');
    launchDir = path.join(sandbox, 'launch-ledger');
    workspace = path.join(sandbox, 'workspace');
    outside = path.join(sandbox, 'outside');
    for (const dir of [home, launchDir, workspace, outside, path.join(home, '.claude'), path.join(sandbox, 'bin')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // The neutral governance source the gate copies into <HOME>/.dsh/AGENTS.md.
    fs.writeFileSync(path.join(home, '.claude', 'AGENTS.md'), '# AGENTS.md — dsh acceptance governance\n');
    // The fake binary, resolved through the registry's operator override. The
    // shim carries the ledger path in code: the child env is itself under test.
    const shim = path.join(sandbox, 'bin', 'dsh');
    fs.writeFileSync(shim, `#!${process.execPath}\nglobalThis.__DSH_FAKE__ = ${JSON.stringify({ launchDir })};\n`
      + `import(${JSON.stringify(pathToFileURL(path.join(here, 'fake-dsh-acp-agent.mjs')).href)});\n`, { mode: 0o755 });

    const env: Record<string, string> = {
      HOME: home, DATABASE_PATH: path.join(sandbox, 'db.sqlite'), DSH_PATH: shim,
      NASSAJ_PROVIDER_SECRETS_KEY: crypto.randomBytes(32).toString('base64'), ...HOSTILE_SERVER_ENV,
    };
    for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
    assert.equal(os.homedir(), home);

    const database = await import('@/modules/database/index.js');
    await database.initializeDatabase();
    mod = {
      ...database,
      ...(await import('@/services/isolation/provider-secrets-store.js')),
      ...(await import('@/services/isolation/provision-user-dirs.js')),
      ...(await import('@/services/isolation/credential-gate.js')),
      ...(await import('@/services/isolation/known-providers.js')),
      ...(await import('@/services/isolation/resolve-provider-env.js')),
      ...(await import('@/shared/harness-binaries.js')),
      // The module under construction (S2); its absence fails each scenario on its own.
      ...(await import(DSH_RUNTIME_MODULE).catch((error: Error) => {
        runtimeLoadError = error;
        return {};
      })),
      providerRegistry: (await import('@/modules/providers/provider.registry.js')).providerRegistry,
    };
    // A runtime whose Claude settings come from the sandbox, never the host's /etc/claude-code.
    managedDir = path.join(sandbox, 'managed');
    fs.mkdirSync(managedDir, { recursive: true });
    if (typeof mod.createDshRuntime === 'function') Object.assign(mod, mod.createDshRuntime({ managedSettingsDir: managedDir }));
  });

  after(async () => {
    await mod.stopDshProcesses?.();
    mod.closeConnection?.();
    mod._resetProviderSecretsServerKeyCache?.();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  describe('unit: the seams dsh plugs into', () => {
    it('dsh is a governed provider whose credential unit is own("deepseek")', async () => {
      assert.ok(mod.KNOWN_PROVIDERS.includes('dsh'), 'KNOWN_PROVIDERS lacks dsh');
      const requirement = mod.CREDENTIAL_PREDICATES.dsh?.({ actor: 1, mode: 'chat', model: null, engine: null,
        honorGrants: true });
      assert.equal(requirement?.unit, 'deepseek');
      assert.equal(requirement?.own, true, 'a grant must never admit a dsh turn');
      const keyed = await newMember(true);
      const bare = await newMember(false);
      assert.equal(requirement.linked(keyed.id), true);
      assert.equal(requirement.linked(bare.id), false);
    });

    it('dsh is HOME-steered: no inherited XDG_* base dir reaches its env', async () => {
      const member = await newMember(true);
      const env = mod.resolveProviderEnv(member.id, 'dsh', { ...process.env }, 'agent');
      assert.equal(env.HOME, member.home);
      for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
        assert.equal(env[name], undefined, `${name} leaked`);
      }
    });

    it('the harness registry resolves dsh, with DSH_PATH as the operator override', () => {
      assert.equal(mod.toHarnessBinaryId('dsh'), 'dsh');
      assert.equal(mod.HARNESS_BINARY_SPECS.dsh?.overrideEnv, 'DSH_PATH');
      assert.equal(mod.resolveHarnessBinary('dsh'), process.env.DSH_PATH);
    });
  });

  describe('1. a member without a DeepSeek key', () => {
    it('is told to link his key (deepseek slot) at admission, even under a deepseek grant', async () => {
      const member = await newMember(false);
      const owner = await newMember(true);
      mod.credentialGrantsDb.grant(owner.id, member.id, 'deepseek');
      let payload: Row | null = null;
      try {
        mod.admitCredentialTurn({ actor: member.id, provider: 'dsh' });
      } catch (error) {
        payload = mod.credentialNotLinkedPayload(error);
      }
      assert.ok(payload, 'admission must refuse with CREDENTIAL_NOT_LINKED');
      assert.equal(payload.provider, 'deepseek');
      assert.equal(payload.settingsAnchor, 'agents/deepseek');
      assert.ok(payload.actions.includes('link_own'));
    });

    it('is refused by the launcher itself and nothing is spawned', async () => {
      const member = await newMember(false);
      const frames = await turn(member, 'hello');
      const refusal = frames.find((f) => f.code === 'CREDENTIAL_NOT_LINKED');
      assert.ok(refusal, `no CREDENTIAL_NOT_LINKED frame: ${JSON.stringify(frames)}`);
      assert.equal(refusal.credential?.settingsAnchor, 'agents/deepseek');
      assert.equal(launchesFor(member.home).length, 0, 'the launch ledger shows a spawn');
    });
  });

  describe('2–4. a member with his own key', () => {
    let member: Awaited<ReturnType<typeof newMember>>;
    let sessionId = '';

    /** Starts an escalating turn and returns once Nassaj asks the member. */
    async function escalation(target: string) {
      const writer = makeWriter(member.id);
      // Claude's default mode asks before a write (T-2089: the parity engine decides; the card is Nassaj's).
      const run = runtime('spawnDsh')(`[escalate] ${target}`, { cwd: workspace, sessionId, permissionMode: 'default' }, writer);
      const ask = await waitFor(() => writer.frames.find((f) => f.kind === 'permission_request'), 'permission_request');
      assert.equal(ask.toolName, 'Write');
      assert.equal(ask.input?.file_path, target);
      return { writer, run, requestId: ask.requestId as string };
    }
    const permissionFor = (target: string) => waitFor(
      () => ledger('permissions').find((row) => row.target === target), `dsh's permission answer for ${target}`);

    before(async () => { member = await newMember(true); });

    it('2a. gets a streamed reply on the chosen model, paid with his own key', async () => {
      const frames = await turn(member, 'hello', { model: 'deepseek-v4-pro' });
      sessionId = createdSessionId(frames);
      const streamed = frames.filter((f) => (f.kind === 'stream_delta' || f.kind === 'text') && f.role !== 'user');
      assert.ok(streamed.length >= 2, 'the reply must stream in pieces');
      assert.match(assistantText(frames), /Hello from fake DeepSeek: hello/);
      assert.equal(completeFrame(frames)?.exitCode, 0);
      const request = lastLlmRequestFor(member.home);
      assert.equal(request?.model, 'deepseek-v4-pro');
      assert.equal(request?.headers['x-api-key'], member.key);
    });

    it('2b. an escalation outside the workspace asks via Nassaj; approve executes', async () => {
      const target = path.join(outside, 'approved.txt');
      const { run, requestId } = await escalation(target);
      assert.equal(runtime('resolveDshPermission')(requestId, { allow: true }), true);
      await within(run, 'approved turn');
      assert.equal((await permissionFor(target)).decision, 'allow');
      assert.ok(fs.existsSync(target), 'the approved write did not happen');
    });

    it('2c. reject blocks the operation', async () => {
      const target = path.join(outside, 'rejected.txt');
      const { run, requestId } = await escalation(target);
      assert.equal(runtime('resolveDshPermission')(requestId, { allow: false }), true);
      await within(run, 'rejected turn');
      assert.equal((await permissionFor(target)).decision, 'deny');
      assert.equal(fs.existsSync(target), false, 'a rejected write happened');
    });

    it('2d. a pending question is rejected when the member\'s client disconnects', async () => {
      const target = path.join(outside, 'disconnected.txt');
      const { writer, run, requestId } = await escalation(target);
      writer.disconnect();
      assert.equal((await permissionFor(target)).decision, 'deny');
      await within(run, 'disconnected turn');
      assert.equal(fs.existsSync(target), false, 'the write ran after the client left');
      assert.equal(runtime('resolveDshPermission')(requestId, { allow: true }), false, 'a settled question re-opened');
    });

    it('3. after a refresh, history comes from Nassaj and the next message resumes the dsh session', async () => {
      const history = await mod.providerRegistry.resolveHistorySessions('dsh')
        .fetchHistory(sessionId, { projectPath: workspace, limit: null });
      const texts = history.messages.map((m: Row) => JSON.stringify(m.content ?? m.text ?? ''));
      assert.ok(texts.some((t: string) => t.includes('hello')), 'the member\'s first message is missing');
      assert.ok(texts.some((t: string) => t.includes('Hello from fake DeepSeek')), 'the first reply is missing');
      const traffic = ledger('traffic');
      assert.equal(traffic.filter((row) => row.msg?.method === 'session/load').length, 0, 'dsh has no session/load');

      await runtime('stopDshProcesses')();
      const frames = await turn(member, 'after refresh', { sessionId });
      assert.equal(completeFrame(frames)?.exitCode, 0);
      const mine = new Set(launchesFor(member.home).map((row) => row.launchId));
      const resumes = ledger('traffic').filter((row) => mine.has(row.launchId) && row.msg?.method === 'session/resume');
      assert.ok(resumes.length >= 1, 'the next message did not resume');
      const dshSessions = new Set(ledger('llm-requests').filter((row) => mine.has(row.launchId)).map((row) => row.sessionId));
      assert.equal(dshSessions.size, 1, `the member's turns ran on ${dshSessions.size} dsh sessions`);
      for (const row of resumes) assert.ok(dshSessions.has(row.msg.params.sessionId), 'resumed another dsh session');
      const request = lastLlmRequestFor(member.home);
      const sent = JSON.stringify(request?.messages);
      assert.ok(sent.includes('hello') && sent.includes('after refresh'), 'earlier turns did not reach the model');
    });

    it('4. the spawn env is exactly the allow-list and other harnesses are out of reach', () => {
      const launches = launchesFor(member.home);
      assert.ok(launches.length >= 1);
      for (const { env, resolvable } of launches) {
        assert.deepEqual(Object.keys(env).sort(), ENV_ALLOW_LIST);
        assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin');
        assert.equal(env.HOME, member.home);
        assert.equal(env.TMPDIR, path.join(member.home, '.tmp'));
        assert.equal(env.DSH_HOME, path.join(member.home, '.dsh'));
        assert.equal(env.DSH_AGENTS_HOME, path.join(member.home, '.agents'));
        assert.equal(env.DEEPSEEK_API_KEY, member.key);
        assert.equal(env.DSH_TELEMETRY_DISABLED, '1');
        assert.ok(env.LANG && env.TERM, 'LANG and TERM must be set');
        assert.deepEqual(resolvable, { claude: false, codex: false });
      }
      const governance = path.join(member.home, '.dsh', 'AGENTS.md');
      assert.equal(fs.readFileSync(governance, 'utf8'),
        fs.readFileSync(path.join(os.homedir(), '.claude', 'AGENTS.md'), 'utf8'), 'governance copy missing or drifted');
    });
  });

  describe('5. governance', () => {
    it('a governance file that cannot be healed refuses the turn and spawns nothing', async () => {
      const member = await newMember(true);
      // A directory where <DSH_HOME>/AGENTS.md belongs: the single self-heal write fails.
      fs.mkdirSync(path.join(member.home, '.dsh', 'AGENTS.md'), { recursive: true });
      const frames = await turn(member, 'hello');
      assert.ok(frames.some((f) => f.code === 'governance_missing'), JSON.stringify(frames));
      assert.equal(launchesFor(member.home).length, 0, 'the launch ledger shows a spawn');
    });
  });

  describe('6. one turn at a time', () => {
    it('a second message on a running session is answered "session busy"', async () => {
      const member = await newMember(true);
      const sessionId = createdSessionId(await turn(member, 'warm up'));
      const first = makeWriter(member.id);
      const running = runtime('spawnDsh')('[slow] long question', { cwd: workspace, sessionId, ...FULL }, first);
      await waitFor(() => lastLlmRequestFor(member.home)?.messages?.some(
        (m: Row) => JSON.stringify(m.content).includes('[slow]')), 'the slow turn to reach dsh');
      const second = await turn(member, 'second question', { sessionId });
      assert.ok(second.some((f) => f.code === 'session_busy'), JSON.stringify(second));
      await within(running, 'the slow turn');
      const asked = ledger('llm-requests').some((r) => JSON.stringify(r.messages).includes('second question'));
      assert.equal(asked, false, 'the busy message reached the model');
    });
  });

  describe('8. settings, cancel and process cleanup', () => {
    it('reasoning effort is one of off/low/high/max; anything else is refused before spawn', async () => {
      const member = await newMember(true);
      const refused = await turn(member, 'hello', { reasoningEffort: 'medium' });
      assert.ok(refused.find((f) => f.code === 'dsh_effort_unsupported')?.notStarted, JSON.stringify(refused));
      assert.equal(launchesFor(member.home).length, 0);
      const frames = await turn(member, 'think hard', { reasoningEffort: 'max' });
      assert.equal(completeFrame(frames)?.exitCode, 0, JSON.stringify(frames));
      assert.equal(lastLlmRequestFor(member.home)?.reasoningEffort, 'max');
      assert.equal(completeFrame(await turn(member, 'think less', { effort: 'low' }))?.exitCode, 0);
      assert.equal(lastLlmRequestFor(member.home)?.reasoningEffort, 'low', 'the `effort` key is honoured too');
    });

    it('a model outside ["deepseek-official", <offered model>] is refused', async () => {
      const member = await newMember(true);
      const frames = await turn(member, 'hello', { model: 'claude-opus-4' });
      assert.ok(frames.some((f) => f.code === 'dsh_model_unavailable'), JSON.stringify(frames));
      assert.equal(completeFrame(frames)?.exitCode, 1);
      assert.equal(lastLlmRequestFor(member.home), undefined, 'the prompt reached the model');
    });

    it('a malformed resume id is refused before spawn', async () => {
      const member = await newMember(true);
      const frames = await turn(member, 'hello', { sessionId: '../../etc/passwd' });
      assert.ok(frames.find((f) => f.code === 'dsh_session_id_invalid')?.notStarted, JSON.stringify(frames));
      assert.equal(launchesFor(member.home).length, 0);
    });

    it('cancel stops the running turn and frees the session', async () => {
      const member = await newMember(true);
      const sessionId = createdSessionId(await turn(member, 'warm up'));
      const writer = makeWriter(member.id);
      const running = runtime('spawnDsh')('[slow] cancel me', { cwd: workspace, sessionId, ...FULL }, writer);
      await waitFor(() => lastLlmRequestFor(member.home)?.messages?.some(
        (m: Row) => JSON.stringify(m.content).includes('cancel me')), 'the slow turn to reach dsh');
      assert.equal(runtime('abortDshSession')(sessionId), true);
      await within(running, 'the cancelled turn');
      assert.equal(completeFrame(writer.frames)?.aborted, true, JSON.stringify(writer.frames));
      assert.equal(runtime('isDshSessionActive')(sessionId), false);
      assert.equal(completeFrame(await turn(member, 'after cancel', { sessionId }))?.exitCode, 0);
    });

    it('a process the turn left behind dies with the turn', async () => {
      const member = await newMember(true);
      const frames = await turn(member, '[grandchild] leave a process');
      assert.equal(completeFrame(frames)?.exitCode, 0, JSON.stringify(frames));
      const [{ pid }] = ledger('grandchildren').filter((row) => launchesFor(member.home).some((l) => l.launchId === row.launchId));
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      await waitFor(() => !alive(), `grandchild ${pid} to be killed`);
    });
  });

  describe('9. exactly Claude\'s restrictions', () => {
    const writeJson = (file: string, value: unknown) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
    };
    const claudeSettings = (member: { home: string }) => path.join(member.home, '.claude', 'settings.json');
    const refusedBeforeSpawn = (frames: Frame[], code: string, member: { home: string }) => {
      assert.ok(frames.find((f) => f.kind === 'complete' && f.code === code)?.notStarted, JSON.stringify(frames));
      assert.equal(launchesFor(member.home).length, 0, 'the launch ledger shows a spawn');
    };

    const ranTurn = (frames: Frame[], member: { home: string }) => {
      assert.equal(completeFrame(frames)?.exitCode, 0, JSON.stringify(frames));
      assert.ok(launchesFor(member.home).length > 0, 'nothing was spawned');
    };

    for (const permissionMode of ['plan', 'default', 'acceptEdits', 'bypassPermissions']) {
      it(`Claude's "${permissionMode}" mode runs, decided call by call by the parity engine (T-2089)`, async () => {
        const member = await newMember(true);
        ranTurn(await turn(member, 'hello', { permissionMode }), member);
      });
    }

    // ADR-226 C2 (owner-visible, §8.1): dontAsk and auto were refused before spawn (qa I3); they now
    // run under the engine's §3 rules (dontAsk: every ask is denied; auto: decided as default).
    for (const permissionMode of ['dontAsk', 'auto']) {
      it(`ADR-226 C2: Claude's "${permissionMode}" mode runs under the engine's rules (was refused)`, async () => {
        const member = await newMember(true);
        ranTurn(await turn(member, 'hello', { permissionMode }), member);
      });
    }

    it('ADR-226 C2: under dontAsk a call that would ask is denied, with no card', async () => {
      const member = await newMember(true);
      const writer = makeWriter(member.id);
      const target = path.join(outside, `dontask-${member.id}.txt`);
      await within(runtime('spawnDsh')(`[escalate] ${target}`, { cwd: workspace, permissionMode: 'dontAsk' }, writer), 'dontAsk turn');
      assert.equal(writer.frames.some((f) => f.kind === 'permission_request'), false, JSON.stringify(writer.frames));
      assert.equal(fs.existsSync(target), false);
    });

    it('ADR-227 / T-2108: with the DSH local switch off (default), a local model id is refused before spawn', async () => {
      const member = await newMember(true);
      const writer = makeWriter(member.id);
      const model = 'nassaj_local_5d0b8a512c3e4f6a9b7c1e2d3f4a5b6c/local-test-model';
      await within(mod.spawnDsh('hello', { cwd: workspace, model }, writer), 'refused turn');
      refusedBeforeSpawn(writer.frames, 'ENGINE_PROVIDER_UNAVAILABLE', member);
    });

    it('ADR-226 C1: a member whose Claude env cannot be built is refused before spawn (was: managed-only rules)', async () => {
      const member = await newMember(true);
      const own = mod.createDshRuntime({ managedSettingsDir: managedDir,
        claudeEnv: () => { throw new Error('no Claude env'); } });
      const writer = makeWriter(member.id);
      await within(own.spawnDsh('hello', { cwd: workspace }, writer), 'refused turn');
      refusedBeforeSpawn(writer.frames, 'PERMISSION_EFFECTIVE_POLICY_REQUIRED', member);
    });

    it('no explicit mode, and full access disabled by Claude\'s settings, run under Claude\'s default (a write asks)', async () => {
      const member = await newMember(true);
      ranTurn(await turn(member, 'hello', { permissionMode: undefined }), member);
      const other = await newMember(true);
      writeJson(claudeSettings(other), { permissions: { disableBypassPermissionsMode: 'disable' } });
      const writer = makeWriter(other.id);
      const target = path.join(outside, `bypass-off-${other.id}.txt`);
      const run = runtime('spawnDsh')(`[escalate] ${target}`, { cwd: workspace, ...FULL }, writer);
      const ask = await waitFor(() => writer.frames.find((f) => f.kind === 'permission_request'), 'permission_request');
      assert.equal(runtime('resolveDshPermission')(ask.requestId, { allow: false }), true);
      await within(run, 'bypass-disabled turn');
      assert.equal(fs.existsSync(target), false);
    });

    it('a Claude deny rule is enforced on the call; full access does not lift it', async () => {
      const member = await newMember(true);
      writeJson(claudeSettings(member), { permissions: { deny: [`Edit(/${outside}/**)`, 'Bash(rm -rf *)'] } });
      const target = path.join(outside, `denied-${member.id}.txt`);
      ranTurn(await turn(member, `[escalate] ${target}`), member);
      assert.equal(fs.existsSync(target), false, 'a denied write happened');
      assert.equal(ledger('permissions').find((row) => row.target === target)?.decision, 'deny');
    });

    it('a deny/ask rule the engine cannot enforce still refuses the turn (rule or disallowed tool)', async () => {
      const member = await newMember(true);
      writeJson(claudeSettings(member), { permissions: { deny: ['FancyTool(x)'] } });
      refusedBeforeSpawn(await turn(member, 'hello'), 'dsh_permission_rule_unsupported', member);
      const other = await newMember(true);
      refusedBeforeSpawn(await turn(other, 'hello', { toolsSettings: { disallowedTools: ['Fancy(x)'] } }),
        'dsh_permission_rule_unsupported', other);
      const supported = await newMember(true);
      ranTurn(await turn(supported, 'hello', { toolsSettings: { disallowedTools: ['WebFetch'] } }), supported);
    });

    it('a managed command guard hook runs under Nassaj; a non-command hook type refuses the turn', async () => {
      const managed = path.join(managedDir, 'managed-settings.json');
      try {
        writeJson(managed, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] } });
        const member = await newMember(true);
        ranTurn(await turn(member, 'hello'), member);
        writeJson(managed, { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: 'is it safe?' }] }] } });
        const other = await newMember(true);
        refusedBeforeSpawn(await turn(other, 'hello'), 'dsh_claude_hooks_unsupported', other);
      } finally {
        fs.rmSync(managed, { force: true });
      }
    });

    it('Claude\'s sandbox enabled refuses the turn (no matching dsh layer; never unsandboxed)', async () => {
      const member = await newMember(true);
      writeJson(claudeSettings(member), { sandbox: { enabled: true } });
      refusedBeforeSpawn(await turn(member, 'hello'), 'dsh_claude_sandbox_unsupported', member);
    });

    it('a failed policy handshake stops the turn before any prompt reaches DeepSeek', async () => {
      const member = await newMember(true);
      const override = path.join(launchDir, 'hello-override.json');
      fs.writeFileSync(override, JSON.stringify({ type: 'hello', shapeError: 'ctx.events._hooks is not an object', inventory: null, tools: [] }));
      try {
        const frames = await turn(member, 'hello');
        assert.ok(frames.some((f) => f.kind === 'error' && f.code === 'dsh_cap_channel'), JSON.stringify(frames));
        assert.equal(lastLlmRequestFor(member.home), undefined, 'a prompt reached DeepSeek');
      } finally {
        fs.rmSync(override, { force: true });
      }
    });

    it('hooks read a Claude-format transcript mirror of the turn, keyed by dsh\'s session id', async () => {
      const managed = path.join(managedDir, 'managed-settings.json');
      const seen = path.join(sandbox, 'transcript-paths.txt');
      try {
        writeJson(managed, { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command',
          command: `cat >> ${seen}; echo >> ${seen}` }] }] } });
        const member = await newMember(true);
        const target = path.join(outside, `mirror-${member.id}.txt`);
        const frames = await turn(member, `[escalate] ${target}`);
        const sessionId = createdSessionId(frames);
        const file = JSON.parse(fs.readFileSync(seen, 'utf8').trim().split('\n').at(-1)!).transcript_path;
        assert.ok(file.endsWith(`${sessionId}.jsonl`), file);
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(lines[0].type, 'user');
        assert.equal(lines[0].sessionId, sessionId);
        assert.match(JSON.stringify(lines[0].message.content), /escalate/);
        assert.ok(lines.some((line) => line.message.content.some((block: Row) => block.type === 'tool_use' && block.name === 'Write')));
      } finally {
        fs.rmSync(managed, { force: true });
      }
    });

    it('a blocking UserPromptSubmit hook sends nothing to DeepSeek; its context is appended to the prompt', async () => {
      const managed = path.join(managedDir, 'managed-settings.json');
      try {
        writeJson(managed, { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo halted-by-guard >&2; exit 2' }] }] } });
        const blocked = await newMember(true);
        const frames = await turn(blocked, 'hello');
        assert.equal(launchesFor(blocked.home).length, 0);
        assert.ok(JSON.stringify(frames).includes('halted-by-guard'));
        writeJson(managed, { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo context-from-hook' }] }] } });
        const member = await newMember(true);
        ranTurn(await turn(member, 'hello'), member);
        const user = lastLlmRequestFor(member.home)?.messages?.find((m: Row) => m.role === 'user');
        assert.match(JSON.stringify(user), /context-from-hook/);
      } finally {
        fs.rmSync(managed, { force: true });
      }
    });

    describe('hooks from Claude plugins (qa round 2)', () => {
      /** Installs plugin `id` in the member's Claude tree and enables it in his settings. */
      const installPlugin = (member: { home: string }, id: string, files: Record<string, unknown>) => {
        const installPath = path.join(member.home, '.claude', 'plugins', 'cache', 'm', id.split('@')[0], '1.0.0');
        for (const [rel, value] of Object.entries(files)) writeJson(path.join(installPath, rel), value);
        writeJson(path.join(member.home, '.claude', 'plugins', 'installed_plugins.json'),
          { version: 2, plugins: { [id]: [{ scope: 'user', installPath, version: '1.0.0' }] } });
        writeJson(claudeSettings(member), { enabledPlugins: { [id]: true } });
      };

      it('an enabled plugin whose hooks.json guards tools runs; its guard is enforced by Nassaj', async () => {
        const member = await newMember(true);
        const target = path.join(outside, `plugin-guard-${member.id}.txt`);
        installPlugin(member, 'guard@m', { 'hooks/hooks.json': { hooks: { PreToolUse: [{ matcher: 'Write',
          hooks: [{ type: 'command', command: 'echo plugin-guard-says-no >&2; exit 2' }] }] } } });
        ranTurn(await turn(member, `[escalate] ${target}`), member);
        assert.equal(fs.existsSync(target), false, 'the plugin guard did not stop the write');
      });

      it('an enabled plugin whose manifest declares command hooks (inline or by path) runs', async () => {
        const inline = await newMember(true);
        installPlugin(inline, 'inline@m', { '.claude-plugin/plugin.json': { name: 'inline',
          hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] } } });
        ranTurn(await turn(inline, 'hello'), inline);
        const byPath = await newMember(true);
        installPlugin(byPath, 'bypath@m', { '.claude-plugin/plugin.json': { name: 'bypath', hooks: './extra/h.json' },
          'extra/h.json': { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'exit 0' }] }] } } });
        ranTurn(await turn(byPath, 'hello'), byPath);
      });

      it('an enabled plugin that cannot be found on disk is not proven free of hooks: refused', async () => {
        const member = await newMember(true);
        writeJson(claudeSettings(member), { enabledPlugins: { 'ghost@m': true } });
        refusedBeforeSpawn(await turn(member, 'hello'), 'dsh_claude_hooks_unsupported', member);
      });

      it('an enabled plugin proven free of blocking hooks runs; a disabled one is ignored', async () => {
        const member = await newMember(true);
        installPlugin(member, 'skills@m', { '.claude-plugin/plugin.json': { name: 'skills' },
          'hooks/hooks.json': { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } } });
        assert.equal(completeFrame(await turn(member, 'plugin without guards'))?.exitCode, 0);
        const off = await newMember(true);
        writeJson(claudeSettings(off), { enabledPlugins: { 'ghost@m': false } });
        assert.equal(completeFrame(await turn(off, 'disabled plugin'))?.exitCode, 0);
      });

      it('a malformed hooks value counts as a hook, never as none', async () => {
        for (const hooks of [{ PreToolUse: { matcher: 'Bash' } }, { Stop: 'node guard.js' }, 'node guard.js']) {
          const member = await newMember(true);
          writeJson(claudeSettings(member), { hooks });
          refusedBeforeSpawn(await turn(member, 'hello'), 'dsh_claude_hooks_unsupported', member);
        }
      });
    });

    it('a Task/Agent deny rule, like parity enforce, denies dsh subagent calls through the engine (T-2091: one layer)', async () => {
      const member = await newMember(true);
      writeJson(claudeSettings(member), { permissions: { deny: ['Task'] } });
      assert.equal(completeFrame(await turn(member, 'no subagents'))?.exitCode, 0);
      const { argv } = launchesFor(member.home).at(-1)!;
      assert.equal(argv.filter((arg: string) => arg === '--patch').length, 1, JSON.stringify(argv));
      const { resolveDshPermissionParity } = await import('@/modules/providers/list/dsh/dsh-permission-parity.js');
      const subagent = { description: 'd', prompt: 'p' };
      const denyRule = resolveDshPermissionParity(FULL, { userId: member.id, cwd: workspace }, { managedSettingsDir: managedDir })
        .createEngine({ home: member.home, sessionId: 's', transcriptPath: '/dev/null' });
      assert.equal((await denyRule.decideTool({ callId: 'c', tool: 'subagent', args: subagent })).decision, 'deny');
      const enforced = await newMember(true);
      const parity = { permissionMode: undefined, permissionExecution: { mode: 'enforce', effectivePolicy: { profileId: 'full_delegation' } } };
      const frames = await turn(enforced, 'parity', parity);
      assert.equal(completeFrame(frames)?.exitCode, 0, JSON.stringify(frames));
      const engine = resolveDshPermissionParity(parity, { userId: enforced.id, cwd: workspace }, { managedSettingsDir: managedDir })
        .createEngine({ home: enforced.home, sessionId: 's', transcriptPath: '/dev/null' });
      assert.equal((await engine.decideTool({ callId: 'c', tool: 'subagent', args: subagent })).decision, 'deny');
    });

    it('invalid tool JSON from the model fails the turn visibly, with no silent retry (T-2089)', async () => {
      const member = await newMember(true);
      const before = ledger('llm-requests').length;
      const frames = await turn(member, 'go [malformed-args]');
      const error = frames.find((f) => f.kind === 'error');
      assert.match(String(error?.content), /tool input is invalid JSON/);
      assert.equal(completeFrame(frames)?.success, false);
      assert.equal(ledger('llm-requests').length - before, 1, 'the prompt was retried');
    });

    it('a coordination level other than direct is refused (no mechanical cell for dsh)', async () => {
      const member = await newMember(true);
      refusedBeforeSpawn(await turn(member, 'hello', { coordinationLevel: 'delegate' }), 'dsh_coordination_unsupported', member);
    });
  });

  describe('10. shared writing (ADR-173)', () => {
    it('another member continuing a dsh session is refused and the starter\'s home is untouched', async () => {
      const starter = await newMember(true);
      const sessionId = createdSessionId(await turn(starter, 'mine'));
      const sessions = path.join(starter.home, '.dsh', 'sessions');
      const before = fs.readdirSync(sessions).map((name) => [name, fs.statSync(path.join(sessions, name)).mtimeMs]);
      const other = await newMember(true);
      const frames = await turn(other, 'continue it', { sessionId });
      assert.ok(frames.find((f) => f.code === 'dsh_shared_session_unsupported')?.notStarted, JSON.stringify(frames));
      assert.equal(launchesFor(other.home).length, 0);
      assert.equal(launchesFor(starter.home).length, 1);
      assert.deepEqual(fs.readdirSync(sessions).map((name) => [name, fs.statSync(path.join(sessions, name)).mtimeMs]), before);
      assert.equal(completeFrame(await turn(starter, 'still mine', { sessionId }))?.exitCode, 0);
    });
  });

  describe('7. what leaves the machine', () => {
    const assertClean = (request: Row | undefined, label: string) => {
      assert.ok(request, `${label}: no outbound request`);
      for (const field of ['dsh_session_log', 'dsh_plugin_packages']) {
        assert.equal(request.bodyKeys.includes(field), false, `${label}: ${field} was sent`);
      }
      assert.equal(request.telemetryExport, false, `${label}: telemetry exported`);
      assert.equal(request.origin, DSH_PUBLIC_BASE_URL, `${label}: request left for ${request.origin}`);
    };

    it('the Nassaj layer wins over a hostile user layer, and a tampered layer file does not survive', async () => {
      const member = await newMember(true);
      const hostile = fs.readFileSync(path.join(fixtures, 'hostile-cordis.patch.yml'), 'utf8');
      for (const file of [path.join(member.home, '.dsh', 'profiles', 'nassaj-acp', 'cordis.patch.yml'),
        path.join(member.home, '.dsh', 'cordis.patch.yml')]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, hostile);
      }
      const sessionId = createdSessionId(await turn(member, 'privacy check'));
      assertClean(lastLlmRequestFor(member.home), 'first launch');

      const { argv, env } = launchesFor(member.home).at(-1)!;
      assert.equal(env.DSH_TELEMETRY_DISABLED, '1');
      const patchIndex = argv.lastIndexOf('--patch');
      assert.ok(patchIndex >= 0, `no --patch layer in argv ${JSON.stringify(argv)}`);
      const layerFile = argv[patchIndex + 1];
      const layer = new Map(readPatchLayer(layerFile).map((entry: Row) => [entry.id, entry]));
      for (const id of [...DSH_UPLOAD_ROWS, DSH_TELEMETRY_ROW]) assert.equal(layer.get(id)?.disabled, true, id);
      assert.equal(layer.get(DSH_LLM_ROW)?.baseURL, DSH_PUBLIC_BASE_URL);

      // A turn can write anywhere in its own tree, so a layer file kept there must be
      // rewritten (or re-verified) before every launch. A file outside the member's
      // tree is never touched here: it may be a shipped asset.
      const relative = path.relative(member.home, path.resolve(layerFile));
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        try { fs.writeFileSync(layerFile, hostile); } catch { /* read-only: the turn cannot either */ }
      }
      await runtime('stopDshProcesses')();
      await turn(member, 'second privacy check', { sessionId });
      assertClean(lastLlmRequestFor(member.home), 'after tampering');
    });
  });
});
