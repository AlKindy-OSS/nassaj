/**
 * vendor-key-fanout.writers.test.ts — ADR-200 S6, the harness side:
 *   - each writer's `readApiKey` reads the API-key field only (never the Claude
 *     OAuth token, the Codex `tokens` or an OpenCode login), from the same file
 *     its write and delete touch;
 *   - G2 (adopted ≠ foreign): a key the migration adopted shows as `adopted` in
 *     the link-mode status, a key save may replace it, and a switch to
 *     subscription keeps it unless the user confirms.
 * Real writers and the real credential inventory over files inside the
 * hermetic sandbox (B-1544); userId null keeps the writers on the pinned dirs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

// B-1544: must stay the first app-side import; it pins every config dir into the sandbox.
import { assertInsideSandbox, removeSandbox, sandboxClaudeDir, sandboxRoot } from '../tests/helpers/hermetic-sandbox.js';

process.env.XDG_DATA_HOME = path.join(sandboxRoot, 'xdg-data');

const { ClaudeCredentialsWriter } = await import('../list/claude/claude-credentials.writer.js');
const { CodexCredentialsWriter } = await import('../list/codex/codex-credentials.writer.js');
const { OpenCodeCredentialsWriter } = await import('../list/opencode/opencode-credentials.writer.js');
const { readHarnessCredentialInventory } = await import('./harness-credential-inventory.js');
const { createHarnessLinkModeService } = await import('./harness-link-mode.service.js');
type LinkModeDeps = import('./harness-link-mode.service.js').LinkModeDeps;
type LinkModeRecord = import('./harness-link-mode.policy.js').LinkModeRecord;

const KEY = 'sk' + '-ant-api03-WRITER-READ-0001';
const NEW_KEY = 'sk' + '-ant-api03-WRITER-NEW-0002';
const OAUTH = 'sk' + '-ant-oat01-WRITER-OAUTH-DO-NOT-READ';
const OPENAI_KEY = 'sk' + '-proj-WRITER-OPENAI-0003';
const fp = (value: string, version = 1) => `fp${version}:${value}`;

const claudeSettings = assertInsideSandbox(path.join(sandboxClaudeDir, 'settings.json'));
const codexAuth = assertInsideSandbox(path.join(process.env.CODEX_HOME!, 'auth.json'));
const openCodeAuth = assertInsideSandbox(path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json'));

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

after(() => removeSandbox());

beforeEach(() => {
  for (const file of [claudeSettings, codexAuth, openCodeAuth, path.join(sandboxClaudeDir, '.credentials.json')]) {
    fs.rmSync(assertInsideSandbox(file), { force: true });
  }
});

test('the Claude writer reads ANTHROPIC_API_KEY only, never the OAuth token', async () => {
  const writer = new ClaudeCredentialsWriter();
  writeJson(claudeSettings, { env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH } });
  assert.equal(await writer.readApiKey(null), null);
  writeJson(claudeSettings, { env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: KEY } });
  assert.equal(await writer.readApiKey(null), KEY);
  await assert.rejects(writer.readApiKey(null, 'other'), (error: unknown) => (error as { code?: string }).code === 'INVALID_CREDENTIAL_TARGET');
});

test('the Codex writer reads OPENAI_API_KEY only and fails closed on an unreadable file', async () => {
  const writer = new CodexCredentialsWriter();
  writeJson(codexAuth, { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { refresh_token: 'rt' } });
  assert.equal(await writer.readApiKey(null), null);
  writeJson(codexAuth, { auth_mode: 'apikey', OPENAI_API_KEY: OPENAI_KEY, tokens: { refresh_token: 'rt' } });
  assert.equal(await writer.readApiKey(null), OPENAI_KEY);
  fs.writeFileSync(codexAuth, '{not json');
  await assert.rejects(writer.readApiKey(null), (error: unknown) => (error as { code?: string }).code === 'CODEX_AUTH_UNREADABLE');
});

test('the OpenCode writer reads an api record only; a login reads as no key', async () => {
  const writer = new OpenCodeCredentialsWriter();
  writeJson(openCodeAuth, { anthropic: { type: 'oauth', refresh: 'r', access: 'a' }, openai: { type: 'api', key: OPENAI_KEY } });
  assert.equal(await writer.readApiKey(null, 'anthropic'), null);
  assert.equal(await writer.readApiKey(null, 'openai'), OPENAI_KEY);
  assert.equal(await writer.readApiKey(null, 'openrouter'), null);
});

/** A link-mode service over the real Claude inventory, with an adopted ledger entry for KEY. */
function linkModeWithAdopted(adoptedValue: string | null) {
  const records = new Map<string, LinkModeRecord>();
  const log: string[] = [];
  const writer = new ClaudeCredentialsWriter();
  const deps: LinkModeDeps = {
    isEnabled: () => true,
    readInventory: readHarnessCredentialInventory,
    readRecordState: (_owner, harness) => {
      const record = records.get(harness);
      return record ? { state: 'ok', record } : { state: 'absent' };
    },
    writeRecord: (_owner, harness, record) => { records.set(harness, record); },
    treeOwner: () => null,
    fingerprint: fp,
    keyVersion: 1,
    readCanonicalKey: () => KEY,
    resolveWriter: () => ({
      setApiKey: async (userId, key) => { log.push('set'); return writer.setApiKey(userId, key); },
      deleteApiKey: async (userId) => { log.push('delete'); return writer.deleteApiKey(userId); },
    }),
    countGrantees: () => 0,
    adoptedProjection: () => (adoptedValue ? { fp: fp(adoptedValue), keyVersion: 1 } : null),
    audit: () => {},
    now: () => new Date('2026-10-09T00:00:00Z'),
  };
  return { service: createHarnessLinkModeService(deps), records, log };
}

test('G2: an adopted key is reported as adopted, not foreign', async () => {
  writeJson(claudeSettings, { env: { ANTHROPIC_API_KEY: KEY } });
  const { service } = linkModeWithAdopted(KEY);
  const status = await service.getStatus(null, 'claude');
  assert.ok('credentials' in status);
  assert.equal(status.credentials.key, 'adopted');

  const { service: noLedger } = linkModeWithAdopted(null);
  const foreign = await noLedger.getStatus(null, 'claude');
  assert.ok('credentials' in foreign);
  assert.equal(foreign.credentials.key, 'foreign', 'without the ledger entry the same key stays foreign');
});

test('G2: a save may replace an adopted key without the foreign-key confirm', async () => {
  writeJson(claudeSettings, { env: { ANTHROPIC_API_KEY: KEY } });
  const { service } = linkModeWithAdopted(KEY);
  const writer = new ClaudeCredentialsWriter();
  await service.guardKeyWrite(null, 'claude', NEW_KEY, { origin: 'company_route' }, () => writer.setApiKey(null, NEW_KEY));
  assert.equal(await writer.readApiKey(null), NEW_KEY);
});

test('G2: a switch to subscription keeps an adopted key unless the user confirms', async () => {
  writeJson(claudeSettings, { env: { ANTHROPIC_API_KEY: KEY } });
  const { service, log } = linkModeWithAdopted(KEY);
  const kept = await service.switchMode(null, 'claude', { mode: 'subscription', confirm: true });
  assert.equal(kept.outcome, 'adopted_credential');
  assert.deepEqual(log, []);
  assert.equal(await new ClaudeCredentialsWriter().readApiKey(null), KEY);

  const removed = await service.switchMode(null, 'claude', { mode: 'subscription', confirm: true, removeForeignKey: true });
  assert.equal(removed.outcome, 'foreign_key_removed');
  assert.deepEqual(log, ['delete']);
  assert.equal(await new ClaudeCredentialsWriter().readApiKey(null), null);
});
