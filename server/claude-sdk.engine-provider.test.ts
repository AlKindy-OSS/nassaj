/**
 * claude-sdk.engine-provider.test.ts — B-222: an engine that cannot be honoured
 * must FAIL VISIBLY; it must never fall back to official Anthropic.
 *
 * The bug: applyClaudeEngineProviderEnv returns "nothing injected" both when NO
 * engine was requested and when an engine WAS requested but could not be
 * honoured (no per-user key / not an eligible engine). The call sites treated
 * the two identically and ran on, so a chat the user had pinned to a vendor
 * engine silently sent its payload to api.anthropic.com. Nobody could tell —
 * which is why no Kimi/GLM token was ever spent through this path.
 *
 * These tests drive the REAL call site (spawnClaudeSideQuery, claude-sdk.js) with
 * only the Agent SDK `query` module-mocked, so they observe exactly what the
 * spawned run would have been handed:
 *
 *   1. engine requested, no key     → onError + the run is NEVER constructed.
 *   2. engine requested, key stored → the run is pointed at the engine endpoint.
 *   3. no engine requested          → official path, byte-for-byte unchanged.
 *
 * Runner: node:test with --experimental-test-module-mocks (npm run test:server).
 * The SDK mock MUST be registered before the module-under-test is imported.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock, beforeEach, afterEach } from 'node:test';

type SdkMessage = Record<string, unknown>;

let scriptedMessages: SdkMessage[] = [];
let lastQueryArg: { prompt?: unknown; options?: Record<string, unknown> } | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: { prompt?: unknown; options?: Record<string, unknown> }) => {
      lastQueryArg = arg;
      const messages = scriptedMessages;
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) {
            yield m;
          }
        },
        interrupt: async () => {},
        supportedCommands: async () => [],
        supportedModels: async () => [],
      };
    },
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

const sdk = (await import('./claude-sdk.js')) as unknown as {
  spawnClaudeSideQuery: (
    params: Record<string, unknown>,
    callbacks: {
      onChunk?: (text: string) => void;
      onError?: (code: string, message: string) => void;
      onComplete?: () => void;
    }
  ) => Promise<void>;
};

const secrets = (await import('./services/isolation/provider-secrets-store.js')) as unknown as {
  setProviderKey: (userId: string, provider: string, key: string) => unknown;
  _resetProviderSecretsServerKeyCache: () => void;
};

const LIVE_SID = 'live-session-uuid-2222';
const USER_ID = '42';

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'API_TIMEOUT_MS',
  'CLAUDE_CONFIG_DIR',
  'NASSAJ_PROVIDER_CAGE',
  'NASSAJ_PROVIDER_SECRETS_KEY',
] as const;

let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';
let sandboxHome = '';
let originalHomedir: () => string;

/** A run that ends immediately — we only care about what `query` was handed. */
const OK_RESULT: SdkMessage[] = [
  { type: 'result', session_id: 'fork-1', subtype: 'success', is_error: false, result: 'ok' },
];

beforeEach(() => {
  scriptedMessages = OK_RESULT;
  lastQueryArg = null;

  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
  }
  // Hermetic: no inherited routing/token, cage OFF, empty claude config dir so
  // the settings-env guard reads nothing instead of the operator's real ~/.claude.
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.API_TIMEOUT_MS;
  delete process.env.NASSAJ_PROVIDER_CAGE;
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;

  // Sandbox the per-user encrypted secrets store onto a throwaway home.
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-home-'));
  originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => sandboxHome;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  secrets._resetProviderSecretsServerKeyCache();
});

afterEach(() => {
  (os as unknown as { homedir: () => string }).homedir = originalHomedir;
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  secrets._resetProviderSecretsServerKeyCache();
  for (const dir of [tmpConfigDir, sandboxHome]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  }
});

async function runSideQuery(params: Record<string, unknown>) {
  const errors: Array<{ code: string; message: string }> = [];
  let completed = false;
  await sdk.spawnClaudeSideQuery(
    { sessionId: LIVE_SID, question: 'hi', userId: USER_ID, cwd: process.cwd(), ...params },
    {
      onChunk: () => {},
      onError: (code, message) => errors.push({ code, message }),
      onComplete: () => {
        completed = true;
      },
    }
  );
  return { errors, completed, options: (lastQueryArg?.options ?? null) as Record<string, unknown> | null };
}

// ── 1. Engine requested, no key: visible failure, nothing runs ────────────────

test('B-222: an engine with NO stored key fails visibly — the run is never constructed', async () => {
  const { errors, completed } = await runSideQuery({ engineProvider: 'glm' });

  assert.equal(
    lastQueryArg,
    null,
    'a run whose engine cannot be honoured must NOT be constructed (it would have gone to official Anthropic)'
  );
  assert.equal(errors.length, 1, 'exactly one terminal error is surfaced to the user');
  assert.equal(completed, false, 'the run does not report success');
  assert.match(
    errors[0].message,
    /GLM/i,
    'the message names the engine the user chose, so the failure is actionable'
  );
});

test('B-222: the silent-fallback env is never produced — no official-Anthropic run for a keyless engine', async () => {
  await runSideQuery({ engineProvider: 'kimi' });
  assert.equal(lastQueryArg, null, 'no query at all — not one pointed at api.anthropic.com');
});

test('B-222: an id that is not an eligible engine fails visibly instead of running on Anthropic', async () => {
  const { errors } = await runSideQuery({ engineProvider: 'deepseek' });
  assert.equal(lastQueryArg, null, 'an ineligible engine never silently downgrades to the official path');
  assert.equal(errors.length, 1);
});

// ── 2. Engine requested with a key: the run really goes to the engine ─────────

test('B-222: an engine WITH a stored key routes the run to that engine endpoint', async () => {
  secrets.setProviderKey(USER_ID, 'glm', 'sk-glm-test-key');

  const { errors, options } = await runSideQuery({ engineProvider: 'glm' });

  assert.deepEqual(errors, [], 'no error when the engine can be honoured');
  assert.ok(options, 'the run was constructed');
  const env = (options!.env ?? {}) as Record<string, string>;
  assert.equal(
    env.ANTHROPIC_BASE_URL,
    'https://api.z.ai/api/anthropic',
    'the SDK is pointed at the GLM Anthropic-compatible endpoint'
  );
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-glm-test-key', 'the per-user engine key is the auth token');
});

test('B-222/z.ai: a long-stream timeout is applied for engine runs and stays overridable', async () => {
  secrets.setProviderKey(USER_ID, 'glm', 'sk-glm-test-key');

  const injected = await runSideQuery({ engineProvider: 'glm' });
  const env = (injected.options?.env ?? {}) as Record<string, string>;
  assert.equal(env.API_TIMEOUT_MS, '3000000', 'z.ai long-stream default is applied when unset');

  // Operator override wins: an inherited value is never clobbered.
  process.env.API_TIMEOUT_MS = '600000';
  const overridden = await runSideQuery({ engineProvider: 'glm' });
  const env2 = (overridden.options?.env ?? {}) as Record<string, string>;
  assert.equal(env2.API_TIMEOUT_MS, '600000', 'an operator-set API_TIMEOUT_MS is preserved');
});

// ── 3. No engine requested: the official path is untouched ────────────────────

test('B-222: NO engine requested ⇒ the official Claude path runs exactly as before', async () => {
  const { errors, completed, options } = await runSideQuery({});

  assert.deepEqual(errors, [], 'the official path never errors on account of the engine seam');
  assert.equal(completed, true, 'the run completes normally');
  assert.ok(options, 'the run was constructed');
  const env = (options!.env ?? {}) as Record<string, string>;
  assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'no base URL is injected on the official path');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, 'no engine token is injected on the official path');
  assert.equal(env.API_TIMEOUT_MS, undefined, 'no engine timeout is injected on the official path');
});
