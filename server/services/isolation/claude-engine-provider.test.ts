/**
 * claude-engine-provider.test.ts — isolation guarantees for the "Claude engine on
 * a vendor endpoint" path (ADR-037, B-ENG-1..4).
 *
 * These tests are the adversarial-review surface for the engine path. They assert,
 * with no network and against the real source:
 *   - applyClaudeEngineProviderEnv injects BOTH ANTHROPIC_BASE_URL and
 *     ANTHROPIC_AUTH_TOKEN or NEITHER (no half-injection), only for an engine
 *     provider with a stored per-user key, and mutates only the passed env —
 *     never process.env.
 *   - assertAnthropicBaseUrlAllowed fails closed: it rejects an unparseable
 *     *_BASE_URL and any unknown host, accepts the official host, accepts an
 *     engine host only when passed via ctx, honors the Bedrock/Vertex and
 *     operator-list escape hatches, and vets ctx.extraValues (settings.json) too.
 *   - collectSettingsBaseUrls reads the settings.json channel Claude Code reads
 *     and degrades to [] on a missing/corrupt file.
 *
 * Runner: node:test + node:assert/strict.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyClaudeEngineProviderEnv,
  applyClaudeEngineProviderEnvOrThrow,
} from '@/services/isolation/apply-claude-engine-provider-env.js';
import { assertAnthropicBaseUrlAllowed } from '@/services/isolation/anthropic-base-url-guard.js';
import { collectSettingsBaseUrls } from '@/services/isolation/collect-settings-base-urls.js';
import {
  ELIGIBLE_ENGINE_PROVIDERS,
  ENGINE_PROVIDERS,
  OFFICIAL_ANTHROPIC_HOSTS,
  PROVIDER_ANTHROPIC_ENDPOINT,
} from '@/services/isolation/provider-anthropic-endpoints.js';
import {
  _resetProviderSecretsServerKeyCache,
  setProviderKey,
} from '@/services/isolation/provider-secrets-store.js';

/** Sandboxes os.homedir + a deterministic server key for the secrets store. */
function withSandbox(): { homeDir: string; restore: () => void } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-engine-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDir;

  const originalKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  _resetProviderSecretsServerKeyCache();

  return {
    homeDir,
    restore: () => {
      (os as unknown as { homedir: () => string }).homedir = originalHomedir;
      if (originalKey === undefined) {
        delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
      } else {
        process.env.NASSAJ_PROVIDER_SECRETS_KEY = originalKey;
      }
      _resetProviderSecretsServerKeyCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

// ── B-ENG-1: constants ────────────────────────────────────────────────────────

test('endpoints: every engine provider has an Anthropic-compatible URL and the sets agree', () => {
  assert.deepEqual([...ENGINE_PROVIDERS].sort(), ['deepseek', 'glm', 'kimi']);
  for (const provider of ENGINE_PROVIDERS) {
    const url = PROVIDER_ANTHROPIC_ENDPOINT[provider as 'kimi' | 'deepseek' | 'glm'];
    assert.ok(typeof url === 'string' && url.startsWith('https://'), `${provider} endpoint`);
    // Parseable; not the official host (these are deliberately vendor hosts).
    const host = new URL(url).hostname;
    assert.ok(!OFFICIAL_ANTHROPIC_HOSTS.has(host));
  }
});

test('eligibility: the ENGINE axis is its own list, and it is a subset of the endpoint map', () => {
  // B-218/ADR-073: "which bodies are selectable" (DISABLED_PROVIDERS) and "which
  // engines may drive the Claude body" are different questions. glm is disabled
  // as a BODY yet is a first-class ENGINE; deepseek keeps its endpoint declared
  // but is NOT eligible (widening that is an owner decision, not a side effect).
  assert.deepEqual([...ELIGIBLE_ENGINE_PROVIDERS].sort(), ['glm', 'kimi']);
  for (const provider of ELIGIBLE_ENGINE_PROVIDERS) {
    assert.ok(ENGINE_PROVIDERS.has(provider), `${provider} must have an endpoint`);
  }
});

// ── B-ENG-2: applyClaudeEngineProviderEnv ─────────────────────────────────────

test('apply: NO engine requested is its own verdict and injects nothing', () => {
  const env: NodeJS.ProcessEnv = {};
  for (const unset of [undefined, null, '', '   ']) {
    assert.deepEqual(applyClaudeEngineProviderEnv(env, '1', unset), { status: 'none' });
  }
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('apply: a requested id that is not an eligible engine is REFUSED, never treated as "no engine"', () => {
  // B-222: the old shape returned null for both cases, so the caller ran on
  // official Anthropic. These must be distinguishable verdicts.
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(applyClaudeEngineProviderEnv(env, '1', 'claude'), {
    status: 'unavailable', provider: 'claude', reason: 'not_an_engine',
  });
  assert.deepEqual(applyClaudeEngineProviderEnv(env, '1', 'gemini'), {
    status: 'unavailable', provider: 'gemini', reason: 'not_an_engine',
  });
  // Has an endpoint, but is not eligible to drive the body (owner decision).
  assert.deepEqual(applyClaudeEngineProviderEnv(env, '1', 'deepseek'), {
    status: 'unavailable', provider: 'deepseek', reason: 'not_eligible',
  });
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('apply: engine provider WITHOUT a stored key injects NOTHING (no half-injection) and is unavailable', () => {
  const sandbox = withSandbox();
  try {
    const env: NodeJS.ProcessEnv = {};
    const verdict = applyClaudeEngineProviderEnv(env, '1', 'kimi');
    assert.deepEqual(verdict, { status: 'unavailable', provider: 'kimi', reason: 'missing_key' });
    // Critical: neither value set when the key is absent.
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  } finally {
    sandbox.restore();
  }
});

test('apply: engine provider WITH a key injects BOTH base URL and token, returns the host set', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('42', 'glm', 'sk-glm-key');
    const env: NodeJS.ProcessEnv = {};
    const verdict = applyClaudeEngineProviderEnv(env, '42', 'glm');
    assert.equal(verdict.status, 'applied');
    assert.deepEqual([...(verdict as { hosts: Set<string> }).hosts], ['api.z.ai']);
    assert.equal(env.ANTHROPIC_BASE_URL, PROVIDER_ANTHROPIC_ENDPOINT.glm);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-glm-key');
  } finally {
    sandbox.restore();
  }
});

test('applyOrThrow: the call-site helper throws on an unhonourable engine and returns null only for the official path', () => {
  const sandbox = withSandbox();
  try {
    // Official path: no engine asked for ⇒ null ⇒ caller proceeds unchanged.
    const official: NodeJS.ProcessEnv = {};
    assert.equal(applyClaudeEngineProviderEnvOrThrow(official, '1', undefined), null);
    assert.equal(official.ANTHROPIC_BASE_URL, undefined);

    // Engine asked for but no key ⇒ throws with a code the caller can classify.
    const refused: NodeJS.ProcessEnv = {};
    assert.throws(
      () => applyClaudeEngineProviderEnvOrThrow(refused, '1', 'glm'),
      (error: NodeJS.ErrnoException) =>
        error.code === 'ENGINE_PROVIDER_UNAVAILABLE' && /GLM/.test(error.message),
    );
    assert.equal(refused.ANTHROPIC_BASE_URL, undefined, 'a refused engine leaves the env clean');

    // Honourable engine ⇒ the host set for the guard.
    setProviderKey('1', 'kimi', 'sk-kimi-key');
    const applied: NodeJS.ProcessEnv = {};
    const hosts = applyClaudeEngineProviderEnvOrThrow(applied, '1', 'kimi');
    assert.deepEqual([...(hosts as Set<string>)], ['api.moonshot.ai']);
  } finally {
    sandbox.restore();
  }
});

test('apply: never reads or writes process.env (operates only on the passed env)', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('42', 'kimi', 'sk-kimi-key');
    const beforeBase = process.env.ANTHROPIC_BASE_URL;
    const beforeTok = process.env.ANTHROPIC_AUTH_TOKEN;
    const env: NodeJS.ProcessEnv = {};
    applyClaudeEngineProviderEnv(env, '42', 'kimi');
    assert.equal(process.env.ANTHROPIC_BASE_URL, beforeBase);
    assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, beforeTok);
    // The injection landed on the passed object, not the global.
    assert.equal(env.ANTHROPIC_BASE_URL, PROVIDER_ANTHROPIC_ENDPOINT.kimi);
  } finally {
    sandbox.restore();
  }
});

test('apply: per-user key — user A engine env carries only user A token', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('1', 'glm', 'sk-user1-glm');
    setProviderKey('2', 'glm', 'sk-user2-glm');
    const envA: NodeJS.ProcessEnv = {};
    const envB: NodeJS.ProcessEnv = {};
    applyClaudeEngineProviderEnv(envA, '1', 'glm');
    applyClaudeEngineProviderEnv(envB, '2', 'glm');
    assert.equal(envA.ANTHROPIC_AUTH_TOKEN, 'sk-user1-glm');
    assert.equal(envB.ANTHROPIC_AUTH_TOKEN, 'sk-user2-glm');
  } finally {
    sandbox.restore();
  }
});

// ── B-ENG-3: assertAnthropicBaseUrlAllowed (fail-closed guard) ────────────────

test('guard: official Anthropic host passes', () => {
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
  );
});

test('guard: an unknown host on any *_BASE_URL throws (fail-closed, no engine ctx)', () => {
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://evil.example.com' }),
    /disallowed host/,
  );
  // Any key suffixed _BASE_URL is scanned, not just ANTHROPIC_BASE_URL.
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ SOME_OTHER_BASE_URL: 'https://evil.example.com' }),
    /disallowed host/,
  );
});

test('guard: an UNPARSEABLE *_BASE_URL is rejected', () => {
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'not a url' }),
    /not a parseable URL/,
  );
});

test('guard: an engine host passes ONLY when supplied via ctx.engineProviderHosts', () => {
  const env = { ANTHROPIC_BASE_URL: PROVIDER_ANTHROPIC_ENDPOINT.kimi };
  // Without ctx: the vendor host is not official → rejected.
  assert.throws(() => assertAnthropicBaseUrlAllowed(env), /disallowed host/);
  // With ctx authorizing exactly that host: allowed.
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed(env, { engineProviderHosts: new Set(['api.moonshot.ai']) }),
  );
});

test('guard: escape hatch — Bedrock/Vertex flag skips host validation', () => {
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({
      ANTHROPIC_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      CLAUDE_CODE_USE_BEDROCK: '1',
    }),
  );
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({
      ANTHROPIC_BASE_URL: 'https://us-east5-aiplatform.googleapis.com',
      CLAUDE_CODE_USE_VERTEX: 'true',
    }),
  );
  // A falsy flag does NOT open the hatch.
  assert.throws(
    () =>
      assertAnthropicBaseUrlAllowed({
        ANTHROPIC_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com',
        CLAUDE_CODE_USE_BEDROCK: '0',
      }),
    /disallowed host/,
  );
});

test('guard: escape hatch — NASSAJ_ALLOWED_ANTHROPIC_HOSTS allow-list admits a proxy host', () => {
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({
      ANTHROPIC_BASE_URL: 'https://proxy.internal.example',
      NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'proxy.internal.example, other.host',
    }),
  );
});

test('guard: operator proxy (manual ANTHROPIC_BASE_URL, NO engine engaged) is admitted via the allow-list, across env AND settings.json', () => {
  // Regression for the adversarial-review finding: an operator that points
  // ANTHROPIC_BASE_URL at a company proxy/gateway (a common Claude Code setup,
  // no engine provider engaged → no engineProviderHosts ctx) must NOT be broken
  // by the fail-closed guard once they declare the host in
  // NASSAJ_ALLOWED_ANTHROPIC_HOSTS — the documented .env.example upgrade path.
  const env = {
    ANTHROPIC_BASE_URL: 'https://litellm.corp.example',
    NASSAJ_ALLOWED_ANTHROPIC_HOSTS: 'litellm.corp.example',
  };
  assert.doesNotThrow(() => assertAnthropicBaseUrlAllowed(env));
  // Same host arriving via the settings.json channel (ctx.extraValues) is also
  // admitted by the same allow-list — no engine ctx needed.
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed(env, { extraValues: ['https://litellm.corp.example'] }),
  );
  // Sanity: drop the allow-list and the very same proxy is refused (still fail-closed).
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({ ANTHROPIC_BASE_URL: 'https://litellm.corp.example' }),
    /disallowed host/,
  );
});

test('guard: ctx.extraValues (settings.json) are vetted with the same host logic', () => {
  // Official extra value passes.
  assert.doesNotThrow(() =>
    assertAnthropicBaseUrlAllowed({}, { extraValues: ['https://api.anthropic.com'] }),
  );
  // A rogue extra value is rejected even when the env itself is clean.
  assert.throws(
    () => assertAnthropicBaseUrlAllowed({}, { extraValues: ['https://evil.example.com'] }),
    /disallowed host/,
  );
});

test('guard: end-to-end — engine env produced by apply passes its own host set', () => {
  const sandbox = withSandbox();
  try {
    setProviderKey('7', 'glm', 'sk-glm');
    const env: NodeJS.ProcessEnv = { ...{}, FOO: 'bar' };
    const hosts = applyClaudeEngineProviderEnvOrThrow(env, '7', 'glm');
    assert.ok(hosts instanceof Set);
    assert.doesNotThrow(() =>
      assertAnthropicBaseUrlAllowed(env, { engineProviderHosts: hosts as Set<string> }),
    );
  } finally {
    sandbox.restore();
  }
});

// ── B-ENG-3b: collectSettingsBaseUrls ─────────────────────────────────────────

test('collect: returns *_BASE_URL values from settings.env, [] when absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-settings-'));
  try {
    // No settings.json yet → degrade-safe [].
    assert.deepEqual(await collectSettingsBaseUrls({ CLAUDE_CONFIG_DIR: dir }), []);

    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
          NOT_A_BASE: 'ignored',
          OTHER_BASE_URL: 'https://x.example',
        },
      }),
    );
    const values = (await collectSettingsBaseUrls({ CLAUDE_CONFIG_DIR: dir })).sort();
    assert.deepEqual(values, ['https://api.anthropic.com', 'https://x.example']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collect: a corrupt settings.json degrades to [] (never throws)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-settings-bad-'));
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is : not json');
    assert.deepEqual(await collectSettingsBaseUrls({ CLAUDE_CONFIG_DIR: dir }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
