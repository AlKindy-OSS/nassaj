/**
 * ADR-227 "DSH local corrector" / T-2108 — acceptance in the owner's terms, through
 * the real runtime (createDshRuntime), the real database, the real launch seam,
 * the real corrector and the real generated layer. Only the dsh binary is the
 * recorded fake (fake-dsh-acp-agent.mjs), which on a local turn really calls the
 * corrector as dsh does; "my local server" is an in-test HTTP server.
 *
 *   (2) my server sees only its own key: no DeepSeek key (I have none), no turn
 *       token, nothing in DSH's env, argv or files carries the server key;
 *   (3) a wrong token is 401, another path or method 404 (seen from DSH's side);
 *   (4) after a turn ends or is cancelled: no open port, no layer file;
 *   (5) a resume stays on the same server and model (the server records the model;
 *       a resume naming any model, or none, runs locally on it); a cloud chat
 *       never moves to a local server;
 *   (6) switch off, or a dsh version without the proof: a clear refusal, no spawn;
 *       plus: the chat is pinned, the policy handshake is still required, and a
 *       member without a DeepSeek key is admitted for a local model only.
 * (1) a real turn on my real server is dsh-local-engine.real-server.test.ts; (7)
 * byte-identity is dsh-local-corrector.test.ts; the sealed no-leak proof against
 * the real dsh is dsh-local-engine.header-echo.test.ts.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEADLINE_MS = 20000;
const SERVER_KEY = 'LOCAL-SERVER-KEY-T2108-ACC';
const LOCAL_ENV = ['DSH_AGENTS_HOME', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'HOME', 'LANG', 'NASSAJ_DSH_LOCAL_TOKEN', 'PATH', 'TERM', 'TMPDIR'];

type Frame = Record<string, any>;
type Row = Record<string, any>;
let sandbox = '';
let launchDir = '';
let workspace = '';
let managedDir = '';
let mod: Record<string, any> = {};
let rt: Record<string, any> = {};
const saved: Record<string, string | undefined> = {};
const seen: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
let upstreamPort = 0;
let upstreamServer: http.Server | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const within = <T>(promise: Promise<T>, label: string): Promise<T> => Promise.race([
  promise, sleep(DEADLINE_MS).then(() => assert.fail(`timed out waiting for ${label}`)),
]);
function ledger(kind: string): Row[] {
  try {
    return fs.readFileSync(path.join(launchDir, `${kind}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
const launchesFor = (home: string) => ledger('launches').filter((row) => row.env?.HOME === home);
const localCallsFor = (home: string) => {
  const ids = new Set(launchesFor(home).map((row) => row.launchId));
  return ledger('local-calls').filter((row) => ids.has(row.launchId));
};
function makeWriter(userId: number) {
  const raw = Object.assign(new EventEmitter(), { readyState: 1, userId, send() {} });
  const frames: Frame[] = [];
  return { userId, ws: raw, frames, send(message: Frame) { frames.push(message); }, setSessionId() {} };
}
const complete = (frames: Frame[]) => frames.find((f) => f.kind === 'complete');
const createdSession = (frames: Frame[]) => frames.find((f) => f.kind === 'session_created')?.newSessionId as string;
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}
const portOf = (baseURL: string) => Number(new URL(baseURL).port);

/** "My local model server": records each request, streams a tool_use block start WITHOUT input. */
async function startUpstream() {
  upstreamServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'read' } })}\n\n`
        + `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'مرحبا' } })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => upstreamServer!.listen(0, '127.0.0.1', () => resolve()));
  upstreamPort = (upstreamServer.address() as net.AddressInfo).port;
}

let seq = 0;
async function newMember(withKey: boolean) {
  const user = mod.userDb.createUser(`dshl-${(seq += 1)}-${crypto.randomUUID().slice(0, 6)}`, 'hash', 'user');
  if (withKey) mod.setProviderKey(user.id, 'deepseek', `sk-member-${user.id}-deepseek`);
  return { id: Number(user.id), home: mod.userConfigDir(user.id, '') as string };
}
function registerServer(ownerId: number, models = [{ id: 'qwen3:30b', contextWindow: 32768 }]) {
  const id = crypto.randomUUID();
  const server = { id, ownerId, providerId: `nassaj_local_${id.replaceAll('-', '')}`, name: 'box', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    runtime: 'llamacpp', models };
  mod.localModelServersDb.save(server);
  mod.localModelServersDb.setVerifiedAddresses(server, ['127.0.0.1']);
  mod.setLocalModelSecret(ownerId, id, SERVER_KEY);
  return server;
}
async function turn(runtime: Record<string, any>, member: { id: number }, command: string, options: Record<string, unknown> = {}) {
  const writer = makeWriter(member.id);
  await within(runtime.spawnDsh(command, { cwd: workspace, permissionMode: 'bypassPermissions', ...options }, writer), command);
  return writer.frames;
}
const switchDsh = (on: boolean) => mod.appConfigDb.set('local_models.dsh_enabled', on ? 'true' : 'false');
const refusedWith = (frames: Frame[], text: RegExp) => {
  const done = complete(frames);
  assert.equal(done?.notStarted, true, JSON.stringify(frames));
  assert.equal(done?.code, 'ENGINE_PROVIDER_UNAVAILABLE', JSON.stringify(frames));
  assert.match(String(done?.error), text);
};

describe('DeepSeek Harness on my local model server — T-2108 acceptance', () => {
  before(async () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-dsh-local-'));
    const home = path.join(sandbox, 'operator-home');
    launchDir = path.join(sandbox, 'ledger');
    workspace = path.join(sandbox, 'workspace');
    managedDir = path.join(sandbox, 'managed');
    for (const dir of [home, launchDir, workspace, managedDir, path.join(home, '.claude'), path.join(sandbox, 'bin')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'AGENTS.md'), '# governance\n');
    const shim = path.join(sandbox, 'bin', 'dsh');
    fs.writeFileSync(shim, `#!${process.execPath}\nglobalThis.__DSH_FAKE__ = ${JSON.stringify({ launchDir })};\n`
      + `import(${JSON.stringify(pathToFileURL(path.join(here, 'fake-dsh-acp-agent.mjs')).href)});\n`, { mode: 0o755 });
    const env: Record<string, string> = {
      HOME: home, DATABASE_PATH: path.join(sandbox, 'db.sqlite'), DSH_PATH: shim,
      NASSAJ_PROVIDER_SECRETS_KEY: crypto.randomBytes(32).toString('base64'),
      DEEPSEEK_API_KEY: ['sk', 'operator', 'must', 'not', 'leak'].join('-'),
    };
    for (const [key, value] of Object.entries(env)) { saved[key] = process.env[key]; process.env[key] = value; }
    const database = await import('@/modules/database/index.js');
    await database.initializeDatabase();
    mod = {
      ...database,
      ...(await import('@/services/isolation/provider-secrets-store.js')),
      ...(await import('@/services/isolation/provision-user-dirs.js')),
      ...(await import('@/services/isolation/credential-gate.js')),
      ...(await import('@/services/isolation/local-engine-pin.js')),
      ...(await import('@/modules/providers/list/dsh/dsh-acp-runtime.js')),
      ...(await import('@/modules/providers/list/dsh/dsh-transcript.js')),
    };
    mod._resetProviderSecretsServerKeyCache();
    mod.appConfigDb.set('local_models.enabled', 'true');
    mod.appConfigDb.set('local_models.consent_version', '1');
    await startUpstream();
    // The fake dsh is no dsh package, so its version is unproven; the version gate has its own case.
    rt = mod.createDshRuntime({ managedSettingsDir: managedDir, localDeps: { isVersionProven: () => true } });
  });

  after(async () => {
    await rt.stopDshProcesses?.();
    upstreamServer?.closeAllConnections();
    upstreamServer?.close();
    mod.closeConnection?.();
    mod._resetProviderSecretsServerKeyCache?.();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('(6) switch off: a clear refusal, nothing spawned', async () => {
    switchDsh(false);
    const member = await newMember(false);
    const server = registerServer(member.id);
    refusedWith(await turn(rt, member, 'hello', { model: `${server.providerId}/qwen3:30b` }), /turned off/u);
    assert.equal(launchesFor(member.home).length, 0);
  });

  it('(6) a dsh version without the local proof: a clear refusal, nothing spawned', async () => {
    switchDsh(true);
    const member = await newMember(false);
    const server = registerServer(member.id);
    const unproven = mod.createDshRuntime({ managedSettingsDir: managedDir });
    refusedWith(await turn(unproven, member, 'hello', { model: `${server.providerId}/qwen3:30b` }), /not passed the local-server credential proof/u);
    assert.equal(launchesFor(member.home).length, 0);
  });

  describe('with the switch on, on my own server, without any DeepSeek key', () => {
    let member: Awaited<ReturnType<typeof newMember>>;
    let server: ReturnType<typeof registerServer>;
    let sessionId = '';
    let frames: Frame[] = [];

    before(async () => {
      switchDsh(true);
      member = await newMember(false);
      // The chat's model is NOT the server's first one: a resume must never fall back to models[0].
      server = registerServer(member.id, [{ id: 'gpt-oss-20b', contextWindow: 32768 }, { id: 'qwen3:30b', contextWindow: 32768 }]);
      seen.length = 0;
      frames = await turn(rt, member, 'hello [probe]', { model: `${server.providerId}/qwen3:30b` });
      sessionId = createdSession(frames);
    });

    it('the turn runs and the chat is pinned to my server', () => {
      assert.equal(complete(frames)?.exitCode, 0, JSON.stringify(frames));
      assert.ok(sessionId);
      const pin = mod.sessionsDb.getSessionEnginePin(sessionId)?.engine;
      assert.deepEqual(mod.parseLocalEnginePin(pin), { serverId: server.id, ownerId: member.id, originDigest: mod.parseLocalEnginePin(pin).originDigest });
    });

    it('(2) header echo: my server saw only its own key, never the token or a DeepSeek key', () => {
      assert.equal(seen.length, 1);
      assert.equal(seen[0].headers.authorization, `Bearer ${SERVER_KEY}`);
      assert.equal(seen[0].headers['x-api-key'], undefined);
      const token = launchesFor(member.home)[0].env.NASSAJ_DSH_LOCAL_TOKEN;
      assert.ok(!JSON.stringify(seen[0]).includes(token), 'no token upstream');
      assert.ok(!JSON.stringify(seen[0]).includes('sk-'), 'no DeepSeek key upstream');
      assert.match(seen[0].body, /"model":"qwen3:30b"/u);
    });

    it('(2) DSH gets no key: exact local env, no DeepSeek key, no server key in env, argv or its files', () => {
      const launch = launchesFor(member.home)[0];
      assert.deepEqual(Object.keys(launch.env).filter((k) => k !== 'PWD' && k !== 'SHLVL' && k !== '_').sort(), LOCAL_ENV);
      assert.notEqual(launch.env.NASSAJ_DSH_LOCAL_TOKEN, SERVER_KEY);
      assert.equal(Buffer.from(launch.env.NASSAJ_DSH_LOCAL_TOKEN, 'hex').length, 32);
      assert.ok(launch.patchTexts[0]?.includes('NASSAJ_DSH_LOCAL_TOKEN'), 'the generated layer was read');
      assert.ok(!JSON.stringify(launch).includes(SERVER_KEY), 'server key in env, argv or the layer');
      assert.ok(!launch.patchTexts[0].includes(launch.env.NASSAJ_DSH_LOCAL_TOKEN), 'the token is not in the layer');
      // DSH's own trees (DSH_HOME, DSH_AGENTS_HOME, TMPDIR) and the layer it was given.
      for (const dir of [launch.env.DSH_HOME, launch.env.DSH_AGENTS_HOME, launch.env.TMPDIR]) {
        const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
        for (const file of files) assert.ok(!fs.readFileSync(path.join(file.parentPath, file.name), 'utf8').includes(SERVER_KEY), file.name);
      }
    });

    it('the corrector fixed the missing tool_use input, and DSH asked for the bare model id', () => {
      const call = localCallsFor(member.home)[0];
      assert.equal(call.status, 200);
      assert.match(call.body, /"content_block":\{"type":"tool_use","id":"t1","name":"read","input":\{\}\}/u);
      assert.match(call.body, /مرحبا/u);
      assert.equal(call.model, 'qwen3:30b');
    });

    it('(3) seen from DSH: a wrong token is 401, another method or path is 404', () => {
      assert.deepEqual(localCallsFor(member.home)[0].probes, { wrongToken: 401, otherMethod: 404, otherPath: 404 });
    });

    it('(4) after the turn: no open port and no layer file', async () => {
      const call = localCallsFor(member.home)[0];
      assert.equal(await portOpen(portOf(call.baseURL)), false);
      const argv: string[] = launchesFor(member.home)[0].argv;
      const layer = argv[argv.indexOf('--patch') + 1];
      assert.ok(path.isAbsolute(layer) && !layer.startsWith(member.home), 'the layer lives outside my tree');
      assert.equal(fs.existsSync(layer), false);
      assert.equal(fs.existsSync(path.dirname(layer)), false);
    });

    it('the transcript books the turn to my local model (qualified id)', () => {
      const root = path.join(os.homedir(), '.nassaj-vendor-sessions', 'dsh');
      const files = fs.readdirSync(root, { recursive: true }).map(String).filter((f) => f.includes(sessionId));
      assert.ok(files.length > 0);
      assert.ok(fs.readFileSync(path.join(root, files[0]), 'utf8').includes(`${server.providerId}/qwen3:30b`));
    });

    it('qa HIGH 4: the chat\'s qualified model is recorded with its owner in the transcript', async () => {
      assert.deepEqual(await mod.readDshSessionRecord(sessionId, workspace),
        { ownerUserId: String(member.id), model: `${server.providerId}/qwen3:30b` });
    });

    it('(5) a resume with no model stays on the same server, pin and recorded model', async () => {
      const pin = mod.sessionsDb.getSessionEnginePin(sessionId)?.engine;
      const before = seen.length;
      const again = await turn(rt, member, 'again', { sessionId });
      assert.equal(complete(again)?.exitCode, 0, JSON.stringify(again));
      assert.equal(seen.length, before + 1);
      assert.equal(seen.at(-1)?.headers.authorization, `Bearer ${SERVER_KEY}`);
      assert.match(String(seen.at(-1)?.body), /"model":"qwen3:30b"/u, 'the recorded model, not models[0]');
      assert.equal(mod.sessionsDb.getSessionEnginePin(sessionId)?.engine, pin);
    });

    it('(5) a resume naming a DeepSeek model runs locally on the recorded model', async () => {
      const pin = mod.sessionsDb.getSessionEnginePin(sessionId)?.engine;
      const before = seen.length;
      const again = await turn(rt, member, 'still local', { sessionId, model: 'deepseek-v4-pro' });
      assert.equal(complete(again)?.exitCode, 0, JSON.stringify(again));
      assert.equal(seen.length, before + 1, 'it ran on my server');
      assert.match(String(seen.at(-1)?.body), /"model":"qwen3:30b"/u);
      assert.equal(mod.sessionsDb.getSessionEnginePin(sessionId)?.engine, pin);
    });

    it('qa round 2: a resume naming another model of my server still runs on the recorded model', async () => {
      const before = seen.length;
      const again = await turn(rt, member, 'still mine', { sessionId, model: `${server.providerId}/gpt-oss-20b` });
      assert.equal(complete(again)?.exitCode, 0, JSON.stringify(again));
      assert.equal(seen.length, before + 1, 'it ran on my server');
      assert.match(String(seen.at(-1)?.body), /"model":"qwen3:30b"/u, 'the client-sent local id is ignored');
    });

    it('(4) a cancelled turn also leaves no port and no layer', async () => {
      const writer = makeWriter(member.id);
      const callsBefore = localCallsFor(member.home).length;
      const running = rt.spawnDsh('[slow] cancel me', { cwd: workspace, sessionId, permissionMode: 'bypassPermissions' }, writer);
      const started = Date.now();
      while (localCallsFor(member.home).length <= callsBefore) {
        if (Date.now() - started > DEADLINE_MS) assert.fail('no local call');
        await sleep(10);
      }
      assert.equal(rt.abortDshSession(sessionId), true);
      await within(running, 'cancelled turn');
      const call = localCallsFor(member.home).at(-1)!;
      assert.equal(await portOpen(portOf(call.baseURL)), false);
      const argv: string[] = launchesFor(member.home).at(-1).argv;
      assert.equal(fs.existsSync(argv[argv.indexOf('--patch') + 1]), false);
    });
  });

  it('(5) a cloud chat never moves to my local server', async () => {
    switchDsh(true);
    const member = await newMember(true);
    const server = registerServer(member.id);
    const cloud = await turn(rt, member, 'cloud hello');
    const cloudSession = createdSession(cloud);
    assert.ok(cloudSession, JSON.stringify(cloud));
    const launches = launchesFor(member.home).length;
    refusedWith(await turn(rt, member, 'move', { sessionId: cloudSession, model: `${server.providerId}/qwen3:30b` }), /pinned to a different engine/u);
    assert.equal(launchesFor(member.home).length, launches);
  });

  it('another member\'s server is refused (shared rule)', async () => {
    switchDsh(true);
    const owner = await newMember(false);
    const stranger = await newMember(false);
    const theirs = registerServer(stranger.id);
    refusedWith(await turn(rt, owner, 'hello', { model: `${theirs.providerId}/qwen3:30b` }), /not registered to your account/u);
  });

  it('qa condition 1: without the policy handshake the local turn is stopped, and nothing is left open', async () => {
    switchDsh(true);
    const member = await newMember(false);
    const server = registerServer(member.id);
    fs.writeFileSync(path.join(launchDir, 'hello-override.json'), JSON.stringify({ type: 'hello', protocol: 1 }));
    try {
      const frames = await turn(rt, member, 'hello', { model: `${server.providerId}/qwen3:30b` });
      assert.ok(frames.some((f) => f.kind === 'error' && f.code === 'dsh_cap_channel'), JSON.stringify(frames));
      assert.equal(localCallsFor(member.home).length, 0, 'nothing reached my server');
      const argv: string[] = launchesFor(member.home)[0].argv;
      assert.equal(fs.existsSync(argv[argv.indexOf('--patch') + 1]), false);
    } finally {
      fs.rmSync(path.join(launchDir, 'hello-override.json'), { force: true });
    }
  });

  it('qa condition 7: a failed local turn logs its stderr with the token redacted', async () => {
    switchDsh(true);
    const member = await newMember(false);
    const server = registerServer(member.id);
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(JSON.stringify(args)); };
    try {
      const frames = await turn(rt, member, '[leak-stderr]', { model: `${server.providerId}/qwen3:30b` });
      assert.equal(complete(frames)?.exitCode, 1);
    } finally {
      console.error = original;
    }
    const token = launchesFor(member.home)[0].env.NASSAJ_DSH_LOCAL_TOKEN;
    const line = logged.find((entry) => entry.includes('[dsh] turn failed')) ?? '';
    assert.match(line, /token=\[key\]/u);
    assert.ok(!logged.join('\n').includes(token), 'the token is never logged');
    assert.ok(!line.includes('undefined'), 'no stray redaction of the word undefined');
  });

  it('qa condition 4: a prompt blocked by a hook opens no corrector and writes no layer', async () => {
    switchDsh(true);
    const member = await newMember(false);
    const server = registerServer(member.id);
    fs.writeFileSync(path.join(managedDir, 'managed-settings.json'), JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo blocked >&2; exit 2' }] }] } }));
    try {
      const frames = await turn(rt, member, 'blocked', { model: `${server.providerId}/qwen3:30b` });
      assert.equal(complete(frames)?.code, 'dsh_prompt_blocked', JSON.stringify(frames));
      assert.equal(launchesFor(member.home).length, 0);
      const root = path.join(os.homedir(), '.nassaj-dsh-local-runs');
      assert.deepEqual(fs.existsSync(root) ? fs.readdirSync(root) : [], []);
    } finally {
      fs.rmSync(path.join(managedDir, 'managed-settings.json'), { force: true });
    }
  });

  it('qa HIGH 4: a local-pinned chat with no recorded model is refused (model_not_found), never models[0]', async () => {
    switchDsh(true);
    const member = await newMember(false);
    const server = registerServer(member.id);
    const created = createdSession(await turn(rt, member, 'pin me', { model: `${server.providerId}/qwen3:30b` }));
    const root = path.join(os.homedir(), '.nassaj-vendor-sessions', 'dsh');
    const file = path.join(root, fs.readdirSync(root, { recursive: true }).map(String).find((f) => f.includes(created) && f.endsWith('.jsonl'))!);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/,"model":"[^"]*"/u, ''));
    const launches = launchesFor(member.home).length;
    for (const model of [undefined, 'deepseek-v4-pro', `${server.providerId}/qwen3:30b`]) {
      const frames = await turn(rt, member, 'resume', { sessionId: created, ...(model ? { model } : {}) });
      refusedWith(frames, /not listed on that local model server/u);
      assert.equal(complete(frames)?.reason, 'model_not_found');
    }
    assert.equal(launchesFor(member.home).length, launches);
  });

  it('admission: a member without a DeepSeek key is admitted for a local model or a local-pinned chat only', async () => {
    const member = await newMember(false);
    const server = registerServer(member.id);
    assert.doesNotThrow(() => mod.admitCredentialTurn({ actor: member.id, provider: 'dsh', model: `${server.providerId}/qwen3:30b` }));
    assert.throws(() => mod.admitCredentialTurn({ actor: member.id, provider: 'dsh', model: 'deepseek-v4-pro' }),
      (error: Error & { code?: string }) => error.code === 'CREDENTIAL_NOT_LINKED');
    const frames = await turn(rt, member, 'pin me', { model: `${server.providerId}/qwen3:30b` });
    const pinned = createdSession(frames);
    assert.doesNotThrow(() => mod.admitCredentialTurn({ actor: member.id, provider: 'dsh', sessionId: pinned }));
  });
});
