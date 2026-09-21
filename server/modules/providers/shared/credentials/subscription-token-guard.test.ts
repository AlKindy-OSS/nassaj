/**
 * subscription-token-guard.test — B-1252.
 *
 * Commit 102f68298 stated the rule (a personal `claude setup-token` token only
 * ever belongs in Claude's own settings.json) but enforced it in the UI alone;
 * every server writer still accepted the token from any client that skipped the
 * screen. These tests pin the enforcement where it now lives, on all three
 * write surfaces that could receive it, and pin the two properties that make a
 * refusal safe: nothing is written, and the error carries no piece of the token.
 *
 * Hermetic: userId=null for the file writers (operator dir pinned to a sandbox,
 * no DB), a throwaway DB + sandboxed $HOME for the encrypted vendor store.
 * Runner: node:test + node:assert.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-subscription-token-guard-'));
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
const ORIGINAL = {
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  DATABASE_PATH: process.env.DATABASE_PATH,
  SECRETS_KEY: process.env.NASSAJ_PROVIDER_SECRETS_KEY,
};
process.env.HOME = sandboxHome;
process.env.XDG_DATA_HOME = path.join(sandbox, 'xdg');
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { assertNotClaudeSubscriptionToken, isClaudeSubscriptionToken } =
  await import('./subscription-token-guard.js');
const { OpenCodeCredentialsWriter } =
  await import('@/modules/providers/list/opencode/opencode-credentials.writer.js');
const { CodexCredentialsWriter } =
  await import('@/modules/providers/list/codex/codex-credentials.writer.js');
const { providerSecretsService } =
  await import('@/modules/providers/services/provider-secrets.service.js');
const { initializeDatabase, closeConnection, userDb } =
  await import('@/modules/database/index.js');
const { hasProviderKey } = await import('@/services/isolation/provider-secrets-store.js');

await initializeDatabase();
const member = userDb.createUser('member-a', 'hash', 'user');

/** A realistic-shaped subscription token. Its parts must never reach an error. */
const SUBSCRIPTION_TOKEN = 'sk-ant-oat01-ZZTOPSECRETMATERIALZZ-DO-NOT-LEAK';
/** The distinctive middle of the token — the substring an error must not echo. */
const TOKEN_BODY = 'ZZTOPSECRETMATERIALZZ-DO-NOT-LEAK';
const ORDINARY_KEY = 'sk-or-v1-an-ordinary-api-key';

const openCodeAuthPath = path.join(sandbox, 'xdg', 'opencode', 'auth.json');
const openCodeWriter = new OpenCodeCredentialsWriter();

after(() => {
  closeConnection();
  for (const [key, value] of Object.entries({
    HOME: ORIGINAL.HOME,
    XDG_DATA_HOME: ORIGINAL.XDG_DATA_HOME,
    DATABASE_PATH: ORIGINAL.DATABASE_PATH,
    NASSAJ_PROVIDER_SECRETS_KEY: ORIGINAL.SECRETS_KEY,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Runs `fn`, asserting it rejects with the stable 400 and leaks nothing. */
async function assertRefused(fn: () => Promise<unknown> | unknown): Promise<void> {
  // Sync throws (the guard itself, the vendor service) and rejected promises
  // (the async writers) are the same refusal — catch both shapes.
  let error: unknown = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error, 'the write must be refused, not accepted');
  const appError = error as Error & { code?: string; statusCode?: number };
  assert.equal(appError.code, 'SUBSCRIPTION_TOKEN_FORBIDDEN_TARGET');
  assert.equal(appError.statusCode, 400);
  const serialized = `${appError.message} ${JSON.stringify(appError)}`;
  assert.ok(!serialized.includes(TOKEN_BODY), 'error must not echo the token');
  assert.ok(!serialized.includes(SUBSCRIPTION_TOKEN), 'error must not echo the token');
}

describe('the guard itself', () => {
  it('recognises the token by its trimmed prefix only', () => {
    assert.equal(isClaudeSubscriptionToken(SUBSCRIPTION_TOKEN), true);
    assert.equal(isClaudeSubscriptionToken(`  ${SUBSCRIPTION_TOKEN}\n`), true);
    assert.equal(isClaudeSubscriptionToken(ORDINARY_KEY), false);
    assert.equal(isClaudeSubscriptionToken('sk-ant-api03-an-ordinary-anthropic-key'), false);
    assert.equal(isClaudeSubscriptionToken(undefined), false);
  });

  it('refuses with a 400 whose message names no part of the value', async () => {
    await assertRefused(() => {
      assertNotClaudeSubscriptionToken(SUBSCRIPTION_TOKEN, 'somewhere');
      return undefined;
    });
  });

  it('is a no-op for an ordinary key', () => {
    assert.doesNotThrow(() => assertNotClaudeSubscriptionToken(ORDINARY_KEY, 'somewhere'));
  });
});

describe('opencode writer', () => {
  beforeEach(() => {
    fs.rmSync(path.join(sandbox, 'xdg', 'opencode'), { recursive: true, force: true });
  });

  it('refuses the token and leaves auth.json untouched (never created)', async () => {
    await assertRefused(() => openCodeWriter.setApiKey(null, SUBSCRIPTION_TOKEN, 'anthropic'));
    assert.equal(fs.existsSync(openCodeAuthPath), false, 'no file created by a refused write');
  });

  it('refuses it for every target, not just anthropic', async () => {
    for (const target of ['openai', 'openrouter', 'glm']) {
      await assertRefused(() => openCodeWriter.setApiKey(null, SUBSCRIPTION_TOKEN, target));
    }
    assert.equal(fs.existsSync(openCodeAuthPath), false);
  });

  it('leaves an existing auth.json byte-identical when it refuses', async () => {
    await openCodeWriter.setApiKey(null, ORDINARY_KEY, 'openai');
    const before = fs.readFileSync(openCodeAuthPath);
    await assertRefused(() => openCodeWriter.setApiKey(null, SUBSCRIPTION_TOKEN, 'anthropic'));
    assert.ok(fs.readFileSync(openCodeAuthPath).equals(before));
  });

  it('still accepts an ordinary API key', async () => {
    const result = await openCodeWriter.setApiKey(null, ORDINARY_KEY);
    assert.deepEqual(result, { provider: 'opencode', configured: true });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(openCodeAuthPath, 'utf8')).anthropic,
      { type: 'api', key: ORDINARY_KEY },
    );
  });
});

describe('codex writer', () => {
  it('refuses the token before the login CLI is ever spawned', async () => {
    let spawned = 0;
    const writer = new CodexCredentialsWriter(((...args: unknown[]) => {
      spawned += 1;
      throw new Error(`the CLI must not be reached: ${args.length} args`);
    }) as never);
    await assertRefused(() => writer.setApiKey(null, SUBSCRIPTION_TOKEN));
    assert.equal(spawned, 0, 'no process — the token never reaches a child stdin');
  });
});

describe('vendor secrets store', () => {
  it('refuses the token for a hosted vendor key and stores nothing', async () => {
    await assertRefused(() => providerSecretsService.setKey(member.id, 'kimi', SUBSCRIPTION_TOKEN));
    assert.equal(hasProviderKey(member.id, 'kimi'), false);
  });

  it('still accepts an ordinary vendor API key', () => {
    const result = providerSecretsService.setKey(member.id, 'kimi', ORDINARY_KEY);
    assert.equal(result.configured, true);
    assert.equal(hasProviderKey(member.id, 'kimi'), true);
  });
});
