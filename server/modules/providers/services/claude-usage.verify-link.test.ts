/**
 * claude-usage.verify-link.test.ts — live check behind the settings "connected"
 * badge. A credentials file can look like a full link while Anthropic refuses
 * it; verifyLink must report that as 'rejected', and must NOT turn a transient
 * failure (rate limit, network) into a false "sign in again".
 *
 * Runner: node:test + node:assert/strict via tsx.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-verify-'));
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
// Anonymous checks resolve the operator dir from CLAUDE_CONFIG_DIR: point it at
// the sandbox so no real credential is ever read or rewritten.
process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, '.claude');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const credPath = path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
initializeDatabase();
const { claudeUsageService } = await import('./claude-usage.service.js');

const ORIGINAL_FETCH = globalThis.fetch;

after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  try { closeConnection(); } catch { /* already closed */ }
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let accessCounter = 0;
/** Writes a fresh fixture credential (unique token, so no cached verdict applies). */
function writeCredential(): void {
  accessCounter += 1;
  fs.writeFileSync(credPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: `fixture-access-${accessCounter}`,
      refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3_600_000,
    },
  }));
}

type Reply = { status: number; body?: unknown } | 'network-error';
/** Replaces fetch with a scripted sequence of upstream replies. */
function scriptFetch(replies: Reply[]): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    const reply = replies.shift();
    if (!reply || reply === 'network-error') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  }) as typeof fetch;
  return { calls };
}

beforeEach(() => writeCredential());

test('a usage call that succeeds means the login is valid', async () => {
  scriptFetch([{ status: 200, body: { five_hour: null } }]);
  assert.equal(await claudeUsageService.verifyLink(null), 'valid');
});

test('a refused token whose refresh is refused too is rejected', async () => {
  const { calls } = scriptFetch([{ status: 401 }, { status: 400, body: { error: 'invalid_grant' } }]);
  assert.equal(await claudeUsageService.verifyLink(null), 'rejected');
  assert.equal(calls.length, 2, 'one usage call, one refresh attempt');
});

test('a rate limit is unknown, never rejected', async () => {
  scriptFetch([{ status: 429 }]);
  assert.equal(await claudeUsageService.verifyLink(null), 'unknown');
});

test('a network failure during refresh is unknown, never rejected', async () => {
  scriptFetch([{ status: 401 }, 'network-error']);
  assert.equal(await claudeUsageService.verifyLink(null), 'unknown');
});

test('no credential file is unknown (the on-disk check already says so)', async () => {
  fs.rmSync(credPath);
  const { calls } = scriptFetch([]);
  assert.equal(await claudeUsageService.verifyLink(null), 'unknown');
  assert.equal(calls.length, 0);
});

test('a verdict is reused for the same token and re-checked after re-login', async () => {
  const first = scriptFetch([{ status: 401 }, { status: 400 }]);
  assert.equal(await claudeUsageService.verifyLink(null), 'rejected');
  assert.equal(await claudeUsageService.verifyLink(null), 'rejected');
  assert.equal(first.calls.length, 2, 'second call served from the verdict cache');

  writeCredential();
  const second = scriptFetch([{ status: 200, body: {} }]);
  assert.equal(await claudeUsageService.verifyLink(null), 'valid');
  assert.equal(second.calls.length, 1, 'a new token is checked at once');
});
