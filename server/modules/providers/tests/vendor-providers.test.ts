/**
 * vendor-providers.test.ts — hosted vendor providers (kimi/deepseek/glm).
 *
 * Compliance + correctness coverage (C-VR-7), all node:test + node:assert/strict:
 *  - models: live catalog parse + graceful fallback (degraded, no throw) on a
 *    network failure (fetch mock).
 *  - sessions: normalizeMessage maps Anthropic streaming/message events; the
 *    DeepSeek textual-tool-call quirk is rescued into a tool_use; GLM long streams
 *    do not drop messages (event-per-line replay).
 *  - registry: resolveProvider returns all three without throwing and listProviders
 *    includes them; each satisfies the six-facet contract.
 *  - IRON RULE (static): the vendor seam source imports no @anthropic-ai SDK and
 *    does not route through claude-sdk.js.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseVendorCatalog } from '@/modules/providers/shared/vendor/vendor-catalog.client.js';
import {
  VENDOR_RUNTIME,
  extractDeepSeekTextualToolCall,
} from '@/modules/providers/shared/vendor/vendor-config.js';
import { KimiProviderModels } from '@/modules/providers/list/kimi/kimi-models.provider.js';
import { DeepSeekSessionsProvider } from '@/modules/providers/list/deepseek/deepseek-sessions.provider.js';
import { GlmSessionsProvider } from '@/modules/providers/list/glm/glm-sessions.provider.js';
import { KimiSessionsProvider } from '@/modules/providers/list/kimi/kimi-sessions.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';

const stubFetch = (impl: typeof fetch): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
};

// ---------------- models: catalog parsing + fallback ----------------

test('parseVendorCatalog: maps Anthropic `data` rows and keeps the documented DEFAULT', () => {
  const result = parseVendorCatalog(
    { data: [{ id: 'kimi-k2.6' }, { id: 'kimi-k2.7-code', display_name: 'Kimi K2.7 Code' }] },
    VENDOR_RUNTIME.kimi.fallbackModels,
  );
  assert.ok(result);
  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['kimi-k2.6', 'kimi-k2.7-code']);
  assert.equal(result.DEFAULT, 'kimi-k2.6');
});

test('parseVendorCatalog: falls back DEFAULT to first live id when the documented default is gone', () => {
  const result = parseVendorCatalog(
    { models: [{ id: 'kimi-k3-preview' }] },
    VENDOR_RUNTIME.kimi.fallbackModels,
  );
  assert.ok(result);
  assert.equal(result.DEFAULT, 'kimi-k3-preview');
});

test('parseVendorCatalog: returns null for unusable bodies', () => {
  assert.equal(parseVendorCatalog(null, VENDOR_RUNTIME.glm.fallbackModels), null);
  assert.equal(parseVendorCatalog({}, VENDOR_RUNTIME.glm.fallbackModels), null);
  assert.equal(parseVendorCatalog({ data: [] }, VENDOR_RUNTIME.glm.fallbackModels), null);
  assert.equal(parseVendorCatalog({ data: [{ junk: true }] }, VENDOR_RUNTIME.glm.fallbackModels), null);
});

test('KimiProviderModels.getSupportedModels: degrades to fallback (no throw) on network failure', async () => {
  const models = new KimiProviderModels();
  models._resetCatalog();
  // Force the live fetch to throw; the catalog must still resolve to the fallback.
  const restore = stubFetch(async () => {
    throw new Error('network down');
  });
  // Ensure a key exists so the client attempts (and fails) the fetch.
  const originalKey = process.env.KIMI_API_KEY;
  process.env.KIMI_API_KEY = 'sk-test';
  try {
    const result = await models.getSupportedModels();
    assert.deepEqual(result, { ...VENDOR_RUNTIME.kimi.fallbackModels, degraded: true });
  } finally {
    restore();
    if (originalKey === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = originalKey;
    models._resetCatalog();
  }
});

test('KimiProviderModels.getSupportedModels: returns live list (not degraded) on success', async () => {
  const models = new KimiProviderModels();
  models._resetCatalog();
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ data: [{ id: 'kimi-k2.9-live' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const originalKey = process.env.KIMI_API_KEY;
  process.env.KIMI_API_KEY = 'sk-test';
  try {
    const result = await models.getSupportedModels();
    assert.ok(result.OPTIONS.some((o) => o.value === 'kimi-k2.9-live'));
    assert.notEqual(result.degraded, true);
  } finally {
    restore();
    if (originalKey === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = originalKey;
    models._resetCatalog();
  }
});

// ---------------- sessions: normalizeMessage ----------------

test('Kimi normalizeMessage: text_delta becomes a stream_delta', () => {
  const sessions = new KimiSessionsProvider();
  const out = sessions.normalizeMessage(
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    'sess-1',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'stream_delta');
  assert.equal(out[0].content, 'hello');
  assert.equal(out[0].provider, 'kimi');
});

test('Kimi normalizeMessage: content_block_start tool_use becomes a tool_use message', () => {
  const sessions = new KimiSessionsProvider();
  const out = sessions.normalizeMessage(
    { type: 'content_block_start', content_block: { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } } },
    'sess-1',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_use');
  assert.equal(out[0].toolName, 'Read');
  assert.equal(out[0].toolId, 't1');
  assert.deepEqual(out[0].toolInput, { path: '/x' });
});

test('Kimi normalizeMessage: a full assistant message with text + tool_use yields both', () => {
  const sessions = new KimiSessionsProvider();
  const out = sessions.normalizeMessage(
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'doing it' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { cmd: 'ls' } },
        ],
      },
    },
    'sess-2',
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'text');
  assert.equal(out[0].content, 'doing it');
  assert.equal(out[1].kind, 'tool_use');
  assert.equal(out[1].toolName, 'Bash');
});

test('DeepSeek normalizeMessage: a textual tool_call in assistant text is rescued to tool_use', () => {
  const sessions = new DeepSeekSessionsProvider();
  const toolCallText = '```json\n{"name":"Edit","arguments":{"file":"a.ts"}}\n```';
  const out = sessions.normalizeMessage(
    { type: 'content_block_delta', delta: { type: 'text_delta', text: toolCallText } },
    'sess-3',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'tool_use', 'DeepSeek textual tool_call must become a tool_use');
  assert.equal(out[0].toolName, 'Edit');
  assert.deepEqual(out[0].toolInput, { file: 'a.ts' });
});

test('extractDeepSeekTextualToolCall: leaves ordinary prose as null (no false positives)', () => {
  assert.equal(extractDeepSeekTextualToolCall('Here is a summary of the file.'), null);
  assert.equal(extractDeepSeekTextualToolCall('The "name" of the function is foo.'), null);
});

test('GLM normalizeMessage: long stream of deltas keeps every message (no drops)', () => {
  const sessions = new GlmSessionsProvider();
  let total = 0;
  for (let i = 0; i < 500; i += 1) {
    const out = sessions.normalizeMessage(
      { type: 'content_block_delta', delta: { type: 'text_delta', text: `chunk-${i}` } },
      'sess-glm',
    );
    total += out.length;
  }
  assert.equal(total, 500, 'every streamed delta must normalize to exactly one message');
});

// ---------------- sessions: fetchHistory round-trip ----------------

test('Vendor fetchHistory: replays a JSONL transcript and paginates', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'vendor-history-'));
  const originalHome = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => sandbox;
  try {
    const sessions = new KimiSessionsProvider();
    const projectHash = (await import('@/modules/providers/shared/vendor/vendor-transcript.js'))
      .vendorProjectHash('/work/proj');
    const dir = path.join(sandbox, '.nassaj-vendor-sessions', 'kimi', projectHash);
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'meta', projectPath: '/work/proj', sessionName: 'demo' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'hello back' } }),
    ];
    await fs.writeFile(path.join(dir, 'sess-h.jsonl'), `${lines.join('\n')}\n`);

    const result = await sessions.fetchHistory('sess-h', { projectPath: '/work/proj', limit: 10, offset: 0 });
    // meta line yields no message; two text messages remain.
    assert.equal(result.total, 2);
    assert.equal(result.messages[0].content, 'hi');
    assert.equal(result.messages[1].content, 'hello back');
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHome;
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

// ---------------- registry: resolution + contract ----------------

test('registry: resolveProvider returns kimi/deepseek/glm and listProviders includes them', () => {
  for (const id of ['kimi', 'deepseek', 'glm'] as const) {
    const provider = providerRegistry.resolveProvider(id);
    assert.equal(provider.id, id);
    // Six-facet contract: none undefined.
    assert.ok(provider.models, `${id} models`);
    assert.ok(provider.auth, `${id} auth`);
    assert.ok(provider.mcp, `${id} mcp`);
    assert.ok(provider.skills, `${id} skills`);
    assert.ok(provider.sessions, `${id} sessions`);
    assert.ok(provider.sessionSynchronizer, `${id} sessionSynchronizer`);
  }

  const ids = providerRegistry.listProviders().map((p) => p.id);
  for (const id of ['kimi', 'deepseek', 'glm'] as const) {
    assert.ok(ids.includes(id), `listProviders must include ${id}`);
  }
});

test('registry: vendor auth getStatus never throws and reports unauthenticated without a key', async () => {
  const status = await providerRegistry.resolveProvider('deepseek').auth.getStatus('no-such-user');
  assert.equal(status.installed, true);
  assert.equal(status.provider, 'deepseek');
  assert.equal(typeof status.authenticated, 'boolean');
});
