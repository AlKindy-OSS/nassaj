/**
 * ADR-227 "DSH local corrector" / T-2108 — header-echo against the REAL DeepSeek
 * Harness (the permanent no-leak proof, like the Claude and Codex bodies'): a DSH
 * chat on my local model server sends my server only its own key, never a DeepSeek
 * key, never the turn token, and contacts nothing but my server.
 *
 * The real dsh `acp` profile runs with the real Nassaj policy plugin (fd 3, real
 * parity broker) under the production local sequence (dsh-local-turn.js: the
 * corrector, the generated layer, the exact env, the DSH_PATH semantic check)
 * inside a loopback-only network namespace that routes EVERY destination to `lo`,
 * where a recorder logs each connect and DNS attempt. Dummy DeepSeek keys are
 * planted where dsh looks for credentials: <DSH_HOME>/.credentials.yaml,
 * <DSH_HOME>/.env and <cwd>/.env. "My server" streams llama.cpp's shape (tool_use
 * block starts without `input`): the turn writes hello.txt ("مرحبا") and reads it
 * back, which only works through the corrector's fix.
 *
 * Skipped when dsh, an unprivileged network namespace or python3 with AF_PACKET is
 * unavailable, except under NASSAJ_TEST_RELEASE_GATE=1 (the proof run by
 * `node scripts/prove-local-engine.mjs dsh`), where a skip fails.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertRecorderCatches, netnsAvailable, packetRecorderAvailable, recordInNetns, type Attempt,
} from './netns-recorder.fixture-helper.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'dsh-local-header-echo.fixture.mjs');
// Built at runtime so the source carries no token-shaped literal for the export leak scan.
const DUMMY_STORE = ['sk', 'DUMMY', 'T2108', 'STORE'].join('-');
const DUMMY_HOME_ENV = ['sk', 'DUMMY', 'T2108', 'HOMEENV'].join('-');
const DUMMY_CWD_ENV = ['sk', 'DUMMY', 'T2108', 'CWDENV'].join('-');
const SERVER_KEY = 'LOCAL-SERVER-KEY-T2108';
const ECHO_PORT = 18290;
const MODEL = 'qwen3:30b';
const LOCAL_ENV = ['DSH_AGENTS_HOME', 'DSH_HOME', 'DSH_TELEMETRY_DISABLED', 'HOME', 'LANG', 'NASSAJ_DSH_LOCAL_TOKEN', 'PATH', 'TERM', 'TMPDIR'];

/** The dsh entry under test: NASSAJ_TEST_DSH_BIN (…/@deepseek-ai/dsh/lib/bin.js), or null. */
function findDsh(): string | null {
  const pinned = process.env.NASSAJ_TEST_DSH_BIN;
  return pinned && fs.existsSync(pinned) ? fs.realpathSync(pinned) : null;
}

const DSH_BIN = findDsh();
const SKIP = !DSH_BIN ? 'NASSAJ_TEST_DSH_BIN (a dsh lib/bin.js) not set'
  : !netnsAvailable() ? 'unshare -rn unavailable' : !packetRecorderAvailable() ? 'python3 with AF_PACKET unavailable' : false;

test('release gate: the DSH header-echo proof actually ran', { skip: process.env.NASSAJ_TEST_RELEASE_GATE !== '1' }, () => {
  assert.equal(SKIP, false, `release gate: header-echo would be skipped (${SKIP})`);
});

const roots: string[] = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

type Request = { method: string; path: string; authorization: string; xApiKey: boolean; leakedHeaders: string[];
  bodyHasDummy: boolean; bodyHasToken: boolean; model: string | null };
type Result = { requests: Request[]; attempts: Attempt[]; handshake?: boolean; hello?: string | null; correctorPort?: number;
  envHasKey?: boolean; envKeys?: string[]; layerLeft?: boolean; tokenInStderr?: boolean; stopReason?: string | null;
  modelOffered?: boolean; failed?: string; stderrTail?: string };

/** A throwaway member tree with dummy DeepSeek keys where dsh reads credentials. */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't2108-echo-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  for (const dir of [path.join(home, '.dsh'), path.join(home, '.agents'), path.join(home, '.tmp'), cwd, path.join(root, 'managed'),
    path.join(root, 'claude-home')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.dsh', '.credentials.yaml'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${DUMMY_STORE}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.dsh', '.env'), `DEEPSEEK_API_KEY=${DUMMY_HOME_ENV}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(cwd, '.env'), `DEEPSEEK_API_KEY=${DUMMY_CWD_ENV}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.dsh', 'AGENTS.md'), '# governance\n');
  return { root, home, cwd };
}

/** Runs one production local turn under the recorder. */
function runRecorded(tag: string, serverKey: string | null): Result {
  const sb = makeSandbox();
  const specPath = path.join(sb.root, `spec-${tag}.json`);
  fs.writeFileSync(specPath, JSON.stringify({
    dshBin: DSH_BIN, cwd: sb.cwd, home: sb.home, work: sb.root, echoPort: ECHO_PORT, serverKey, model: MODEL,
    dummies: [DUMMY_STORE, DUMMY_HOME_ENV, DUMMY_CWD_ENV],
  }), { mode: 0o600 });
  const run = recordInNetns(sb.root, tag, [process.execPath, '--import', 'tsx', HARNESS, specPath]);
  assert.equal(run.status, 0, `harness failed in ${tag}`);
  return { ...JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}'), attempts: run.attempts };
}

/** The proof: a full write-then-read turn, only my key, nothing else contacted. */
function assertSealed(result: Result, expectedAuth: 'engine' | 'none'): void {
  assert.equal(result.failed, undefined, `turn failed: ${result.failed}`);
  assert.equal(result.handshake, true, `policy handshake: ${result.stderrTail}`);
  assert.equal(result.stopReason, 'end_turn', JSON.stringify(result));
  assert.equal(result.hello, 'مرحبا', 'hello.txt written through the corrector fix');
  assert.ok(result.requests.length >= 3, 'write, read and answer reached my server');
  for (const request of result.requests) {
    assert.equal(`${request.method} ${request.path.split('?')[0]}`, 'POST /v1/messages');
    assert.equal(request.authorization, expectedAuth, 'only my key (or none)');
    assert.equal(request.xApiKey, false, 'no x-api-key upstream');
    assert.deepEqual(request.leakedHeaders, [], 'no dummy key or token in any header');
    assert.equal(request.bodyHasDummy, false, 'no dummy key in any body');
    assert.equal(request.bodyHasToken, false, 'no token in any body');
    assert.equal(request.model, MODEL, 'the bare local model id');
  }
  const allowed = new Set([`127.0.0.1:${ECHO_PORT}`, `127.0.0.1:${result.correctorPort}`]);
  const stray = result.attempts.filter((a) => !(a.proto === 'tcp' && allowed.has(`${a.dst}:${a.port}`)));
  assert.deepEqual(stray, [], 'nothing but my server and the corrector was contacted, no DNS');
  assert.deepEqual(result.envKeys, LOCAL_ENV, 'the exact local env: no DeepSeek key');
  assert.equal(result.envHasKey, false, 'my server key is not in the DSH env or argv');
  assert.equal(result.layerLeft, false, 'the layer is removed at turn end');
  assert.equal(result.tokenInStderr, false);
}

test('recorder control: a dial and a DNS query to the outside world are both caught', { skip: SKIP }, () => {
  assertRecorderCatches(makeSandbox().root, 'api.deepseek.com');
});

test('a server with a key: only its key, never a DeepSeek key or the token, nothing else contacted', { skip: SKIP, timeout: 180_000 }, () => {
  const result = runRecorded('key', SERVER_KEY);
  assertSealed(result, 'engine');
  assert.equal(result.modelOffered, true, 'dsh offers the local model id in its picker');
});

test('a server without a key: no Authorization at all, nothing else contacted', { skip: SKIP, timeout: 180_000 }, () => {
  assertSealed(runRecorded('nokey', null), 'none');
});
