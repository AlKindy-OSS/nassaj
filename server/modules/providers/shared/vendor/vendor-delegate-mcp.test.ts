/**
 * vendor-delegate-mcp.test.ts — isolation guarantees for the in-process
 * vendor-delegate MCP tool (ADR-037, B-DEL-5/6).
 *
 * This is the adversarial-review surface for the "delegate one subtask to a
 * vendor mid-run" path. With NO network (fetch is stubbed) and against the real
 * source it asserts:
 *   - buildVendorDelegateMcp(userId) returns a FRESH per-spawn MCP server (two
 *     calls yield two distinct instances — no module-level/global server that
 *     could leak one user's key into another's run).
 *   - the delegate_to_vendor tool gates on ENGINE_PROVIDERS membership (unknown
 *     provider → tool_result error, no fetch).
 *   - with no stored per-user key it returns a tool_result error and never calls
 *     fetch (no half-attempt, no leak).
 *   - it authenticates with the SPAWNING user's own key (captured in the closure)
 *     via an x-api-key header to the vendor's Anthropic-compatible endpoint, and
 *     a different userId uses that other user's key.
 *   - it NEVER reads or writes any ANTHROPIC_ / CLAUDE_ prefixed process.env var
 *     on any path (membership reject, no-key, or success).
 *
 * Runner: node:test + node:assert/strict.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildVendorDelegateMcp } from '@/modules/providers/shared/vendor/vendor-delegate-mcp.js';
import { PROVIDER_ANTHROPIC_ENDPOINT } from '@/services/isolation/provider-anthropic-endpoints.js';
import {
  _resetProviderSecretsServerKeyCache,
  setProviderKey,
} from '@/services/isolation/provider-secrets-store.js';

/** Sandboxes os.homedir + a deterministic server key for the secrets store. */
function withSandbox(): { restore: () => void } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-delegate-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDir;

  const originalKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  _resetProviderSecretsServerKeyCache();

  return {
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

/** Pulls the delegate_to_vendor handler out of a built MCP server config. */
function delegateHandler(
  server: ReturnType<typeof buildVendorDelegateMcp>,
): (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }> {
  const instance = (server as unknown as {
    instance: { _registeredTools: Record<string, { handler: (a: unknown) => unknown }> };
  }).instance;
  const entry = instance._registeredTools.delegate_to_vendor;
  assert.ok(entry, 'delegate_to_vendor must be registered');
  return (args) => Promise.resolve(entry.handler(args)) as Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  }>;
}

/** Installs a fetch stub for the duration of one test; returns the call log. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>): {
  calls: Array<{ url: string; init: RequestInit }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return impl(url, init);
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Snapshots every ANTHROPIC_ / CLAUDE_ prefixed process.env key + value. */
function anthropicEnvSnapshot(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_')) {
      snap[key] = process.env[key];
    }
  }
  return snap;
}

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

// ── per-spawn construction ────────────────────────────────────────────────────

test('build: returns a fresh per-spawn vendor-delegate server (no global instance)', () => {
  const a = buildVendorDelegateMcp('1');
  const b = buildVendorDelegateMcp('2');
  assert.equal((a as unknown as { type: string }).type, 'sdk');
  assert.equal((a as unknown as { name: string }).name, 'vendor-delegate');
  // Distinct objects per call — proves nothing is memoized at module scope.
  assert.notEqual(a, b);
  assert.notEqual(
    (a as unknown as { instance: unknown }).instance,
    (b as unknown as { instance: unknown }).instance,
  );
});

// ── membership gate ───────────────────────────────────────────────────────────

test('tool: an unknown provider is rejected as a tool_result error and makes no network call', async () => {
  const f = stubFetch(async () => jsonResponse({ content: [] }));
  try {
    const handle = delegateHandler(buildVendorDelegateMcp('1'));
    const result = await handle({ provider: 'openai', prompt: 'hi' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown vendor provider/);
    assert.equal(f.calls.length, 0, 'no fetch for an unknown provider');
  } finally {
    f.restore();
  }
});

// ── no-key path ───────────────────────────────────────────────────────────────

test('tool: an engine provider with no stored key errors and makes no network call', async () => {
  const sandbox = withSandbox();
  const f = stubFetch(async () => jsonResponse({ content: [] }));
  try {
    const handle = delegateHandler(buildVendorDelegateMcp('1'));
    const result = await handle({ provider: 'kimi', prompt: 'hi' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No API key configured for kimi/);
    assert.equal(f.calls.length, 0, 'no fetch without a key');
  } finally {
    f.restore();
    sandbox.restore();
  }
});

// ── per-user key + endpoint ───────────────────────────────────────────────────

test('tool: authenticates with the SPAWNING user key via x-api-key to the vendor endpoint', async () => {
  const sandbox = withSandbox();
  const f = stubFetch(async () => jsonResponse({ content: [{ type: 'text', text: 'vendor says hi' }] }));
  try {
    setProviderKey('7', 'deepseek', 'sk-user7-deepseek');
    const handle = delegateHandler(buildVendorDelegateMcp('7'));
    const result = await handle({ provider: 'deepseek', prompt: 'hello' });

    assert.equal(result.isError ?? false, false);
    assert.equal(result.content[0].text, 'vendor says hi');
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, `${PROVIDER_ANTHROPIC_ENDPOINT.deepseek}/v1/messages`);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'sk-user7-deepseek');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    // The vendor key must NOT travel as an ANTHROPIC_AUTH_TOKEN/Authorization-bearer
    // env credential — only the transient x-api-key header.
    assert.equal(headers.Authorization, undefined);
  } finally {
    f.restore();
    sandbox.restore();
  }
});

test('tool: per-user closure — user A server uses A key, user B server uses B key', async () => {
  const sandbox = withSandbox();
  const f = stubFetch(async () => jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
  try {
    setProviderKey('1', 'glm', 'sk-A-glm');
    setProviderKey('2', 'glm', 'sk-B-glm');
    const handleA = delegateHandler(buildVendorDelegateMcp('1'));
    const handleB = delegateHandler(buildVendorDelegateMcp('2'));

    await handleA({ provider: 'glm', prompt: 'a' });
    await handleB({ provider: 'glm', prompt: 'b' });

    assert.equal((f.calls[0].init.headers as Record<string, string>)['x-api-key'], 'sk-A-glm');
    assert.equal((f.calls[1].init.headers as Record<string, string>)['x-api-key'], 'sk-B-glm');
  } finally {
    f.restore();
    sandbox.restore();
  }
});

// ── iron rule: process.env never touched ──────────────────────────────────────

test('tool: never reads/writes ANTHROPIC_*/CLAUDE_* process.env on any path', async () => {
  const sandbox = withSandbox();
  const f = stubFetch(async () => jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
  try {
    setProviderKey('9', 'kimi', 'sk-user9-kimi');
    const before = anthropicEnvSnapshot();

    const handle = delegateHandler(buildVendorDelegateMcp('9'));
    // membership reject, no-key (different provider), and a success — all paths.
    await handle({ provider: 'nope', prompt: 'x' });
    await handle({ provider: 'glm', prompt: 'x' }); // user 9 has no glm key
    await handle({ provider: 'kimi', prompt: 'x' }); // success

    assert.deepEqual(anthropicEnvSnapshot(), before, 'no ANTHROPIC_*/CLAUDE_* env mutation');
  } finally {
    f.restore();
    sandbox.restore();
  }
});

// ── non-2xx from vendor is surfaced generically ───────────────────────────────

test('tool: a non-2xx vendor response is surfaced as a generic tool_result error', async () => {
  const sandbox = withSandbox();
  const f = stubFetch(async () => jsonResponse({ error: 'boom' }, 502));
  try {
    setProviderKey('3', 'kimi', 'sk-user3-kimi');
    const handle = delegateHandler(buildVendorDelegateMcp('3'));
    const result = await handle({ provider: 'kimi', prompt: 'hi' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Vendor kimi request failed with status 502/);
    // The raw vendor body is not echoed back to the model.
    assert.doesNotMatch(result.content[0].text, /boom/);
  } finally {
    f.restore();
    sandbox.restore();
  }
});

// ── iron rule: STATIC source guard ────────────────────────────────────────────
// vendor-delegate-mcp.js is deliberately excluded from SEAM_FILES in
// iron-rule-guard.test.ts because it imports the SDK's MCP wrapper helpers
// (@anthropic-ai/...). That exclusion means the static SEAM assertions do NOT
// cover this file, so the "it never touches the Claude engine env" claim lived in
// a doc comment only. These tests re-impose that boundary statically against the
// real source, so any future edit that starts reading/writing an ANTHROPIC_*/
// CLAUDE_* env var, the engine-redirect credentials, or sdkOptions.env fails here
// — the missing positive guard from the adversarial review (finding #3).

/** Reads the module source with // and block comments stripped. */
function readDelegateSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, 'vendor-delegate-mcp.js');
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('static: source never reads/writes an ANTHROPIC_*/CLAUDE_* env var', () => {
  const code = readDelegateSource();
  // Match real env access only — process.env.ANTHROPIC_X, process.env['CLAUDE_X'],
  // or destructuring off process.env — NOT bare identifiers like the imported
  // PROVIDER_ANTHROPIC_ENDPOINT constant (which is why this file is out of SEAM_FILES
  // and needs a precise check rather than the SEAM substring scan).
  const dotAccess = code.match(/process\s*\.\s*env\s*\.\s*(?:ANTHROPIC|CLAUDE)_[A-Z_]+/g) ?? [];
  const bracketAccess =
    code.match(/process\s*\.\s*env\s*\[\s*['"`](?:ANTHROPIC|CLAUDE)_[A-Z_]+['"`]\s*\]/g) ?? [];
  assert.deepEqual(dotAccess, [], `must not access process.env.ANTHROPIC_*/CLAUDE_*: ${dotAccess.join(', ')}`);
  assert.deepEqual(
    bracketAccess,
    [],
    `must not access process.env['ANTHROPIC_*'/'CLAUDE_*']: ${bracketAccess.join(', ')}`,
  );
  // Defence in depth: the file must touch no process.env at all.
  assert.equal(/process\s*\.\s*env/.test(code), false, 'must not reference process.env');
});

test('static: source never sets the engine-redirect credentials (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)', () => {
  const code = readDelegateSource();
  // The two vars that would re-point the Claude engine. PROVIDER_ANTHROPIC_ENDPOINT
  // (the constant) does not contain either literal, so this stays a clean check.
  assert.equal(code.includes('ANTHROPIC_BASE_URL'), false, 'must not reference ANTHROPIC_BASE_URL');
  assert.equal(code.includes('ANTHROPIC_AUTH_TOKEN'), false, 'must not reference ANTHROPIC_AUTH_TOKEN');
});

test('static: source never reads sdkOptions.env / options.env (cannot reach the spawn env)', () => {
  const code = readDelegateSource();
  assert.equal(/sdkOptions\s*\.\s*env/.test(code), false, 'must not reference sdkOptions.env');
  assert.equal(/options\s*\.\s*env/.test(code), false, 'must not reference options.env');
});

test('static: source does not route through claude-sdk.js', () => {
  const code = readDelegateSource();
  assert.equal(/claude-sdk/.test(code), false, 'must not import or reference claude-sdk');
});
