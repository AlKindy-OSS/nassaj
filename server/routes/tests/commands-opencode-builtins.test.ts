/**
 * OC-19 — filtering Claude-only built-in slash commands for opencode sessions
 * (server/routes/commands.js: builtInsForProvider / resolveDynamicBuiltIns).
 *
 * An opencode session must NOT be shown Claude-Code-specific built-ins that do
 * nothing through `opencode run` (/memory, /compact, /hooks, …). The four
 * provider-aware handlers (/help, /models, /cost, /status) stay universal.
 * Codex additionally exposes only its natively wired /compact action.
 *
 * commands.js statically imports getClaudeBuiltInCommands from claude-sdk.js, so we
 * mock that module (registered before the import) to avoid loading the Claude SDK.
 * opencode never triggers the probe, so the mock is only there to keep the import
 * light — its return value is irrelevant here.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const claudeSdkUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../claude-sdk.js')
).href;

mock.module(claudeSdkUrl, {
  namedExports: {
    // Never invoked for non-Claude providers; present so the import resolves.
    getClaudeBuiltInCommands: async () => null,
  },
});

const commandsModule = await import('../commands.js');
const {
  builtInsForProvider,
  builtInCommands,
  CLAUDE_ONLY_BUILTINS,
  resolveDynamicBuiltIns,
  _resetDynamicBuiltInsForTests,
} = commandsModule as unknown as {
  builtInsForProvider: (provider: string) => Array<{ name: string }>;
  builtInCommands: Array<{ name: string }>;
  CLAUDE_ONLY_BUILTINS: Set<string>;
  resolveDynamicBuiltIns: (
    provider: string,
    context: Record<string, unknown>
  ) => Promise<Array<{ name: string }>>;
  _resetDynamicBuiltInsForTests: () => void;
};

const UNIVERSAL = ['/help', '/models', '/cost', '/status'];
const CONTEXT = { userId: 1, cwd: '/tmp' };

test.beforeEach(() => _resetDynamicBuiltInsForTests());

test('opencode: every Claude-only built-in is filtered out', () => {
  const names = new Set(builtInsForProvider('opencode').map((c) => c.name));
  for (const claudeOnly of CLAUDE_ONLY_BUILTINS) {
    assert.ok(
      !names.has(claudeOnly),
      `opencode must not be shown Claude-only built-in ${claudeOnly}`
    );
  }
});

test('opencode: the provider-aware universal built-ins are kept', () => {
  const names = new Set(builtInsForProvider('opencode').map((c) => c.name));
  for (const universal of UNIVERSAL) {
    assert.ok(names.has(universal), `opencode must still see ${universal}`);
  }
  // The kept set is exactly the static list minus the Claude-only set.
  assert.equal(
    builtInsForProvider('opencode').length,
    builtInCommands.length - CLAUDE_ONLY_BUILTINS.size
  );
});

test('opencode filtered list preserves the original command objects (shape intact)', () => {
  for (const cmd of builtInsForProvider('opencode')) {
    const original = builtInCommands.find((c) => c.name === cmd.name);
    assert.deepEqual(cmd, original, `${cmd.name} must be the unmodified object`);
  }
});

test('codex: exposes only implemented web commands and native compact', () => {
  const commands = builtInsForProvider('codex');
  assert.deepEqual(
    commands.map((command) => command.name),
    [
      '/help', '/models', '/cost', '/status', '/compact', '/model', '/usage',
      '/mcp', '/skills', '/hooks', '/apps', '/rename', '/goal',
    ],
  );
  const compact = commands.find((command) => command.name === '/compact') as {
    metadata?: { hasHandler?: boolean };
  } | undefined;
  assert.equal(compact?.metadata?.hasHandler, true);
});

test('other non-Claude harnesses receive portable commands only', () => {
  assert.deepEqual(
    builtInsForProvider('gemini').map((command) => command.name),
    UNIVERSAL,
  );
});

test('Claude alone keeps the full Claude command registry unchanged', () => {
  assert.deepEqual(builtInsForProvider('claude'), builtInCommands);
});

test('resolveDynamicBuiltIns(opencode) returns the filtered list and never probes', async () => {
  const list = await resolveDynamicBuiltIns('opencode', CONTEXT);
  const names = new Set(list.map((c) => c.name));
  assert.ok(!names.has('/memory'), 'no /memory for opencode');
  assert.ok(!names.has('/compact'), 'no /compact for opencode');
  assert.ok(names.has('/models'), '/models stays for opencode');
  assert.deepEqual(list, builtInsForProvider('opencode'));
});

test('sanity: no Claude-only name accidentally listed among UNIVERSAL keepers', () => {
  for (const keep of UNIVERSAL) {
    assert.ok(
      !CLAUDE_ONLY_BUILTINS.has(keep),
      `${keep} must not be in the Claude-only set`
    );
  }
});
