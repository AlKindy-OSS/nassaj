/**
 * T-2103 / T-2107 acceptance: "A turn that ran on my local model server never
 * counts against any cloud provider's quota, usage, or spend (Anthropic,
 * OpenAI/Codex, DeepSeek), whichever body ran it."
 *
 * The signal is the session's engine pin `local:<serverId>:<ownerId>:<digest>`
 * (ADR-227), never the body name and never the model name: a local server may
 * serve a model under a cloud vendor's name, so every transcript here names a
 * priced cloud model on purpose. A control session without the pin proves the
 * same transcript is otherwise billed.
 */

// FIRST import — HOME becomes a /var/tmp sandbox before any provider root is computed.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { costLedgerService, PATH_PROJECT_ID_PREFIX } from '@/modules/providers/services/cost/cost-ledger.service.js';
import { sessionCostService } from '@/modules/providers/services/cost/session-cost.service.js';
import {
  subscriptionConfigService,
  type ProviderAuthProbe,
} from '@/modules/providers/services/cost/subscription-config.service.js';

import {
  claudeHeaderLine,
  claudeProjectsRoot,
  codexHeaderLine,
  codexSessionsRoot,
} from './__tests__/bound-transcripts.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const LOCAL_PIN = `local:srv-1:1:${'a'.repeat(32)}`;
const CLOUD_VENDORS = ['anthropic', 'openai', 'deepseek'];
const NOW = (): Date => new Date('2026-07-28T12:00:00.000Z');
const ROOT_THREAD = '00000000-0000-4000-8000-0000000710c1';
const CHILD_THREAD = '00000000-0000-4000-8000-0000000710c2';
const CONTROL_THREAD = '00000000-0000-4000-8000-0000000710c3';

const probeAll: ProviderAuthProbe = async () => ({ installed: true, authenticated: true, method: 'credentials_file' });

type Env = { root: string; workspace: string; userId: number; claudeDir: string; codexDir: string };

async function withEnv(run: (env: Env) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const root = await mkdtemp('/var/tmp/local-engine-accounting-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  subscriptionConfigService._resetCaches();
  sessionCostService._resetCache();
  costLedgerService._resetCaches();
  const env: Env = {
    root,
    workspace: path.join(root, 'workspace'),
    userId: userDb.createUser('local-user', 'hash', 'owner').id,
    claudeDir: path.join(claudeProjectsRoot(), path.basename(root)),
    codexDir: path.join(codexSessionsRoot(), path.basename(root)),
  };
  await Promise.all([mkdir(env.claudeDir, { recursive: true }), mkdir(env.codexDir, { recursive: true })]);
  try {
    await run(env);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await Promise.all([env.claudeDir, env.codexDir, root].map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

/** Real Claude usage lines, re-stamped to NOW, served under a priced DeepSeek name. */
async function claudeTranscript(env: Env, sessionId: string): Promise<string> {
  const raw = await readFile(path.join(FIXTURES, 'claude-parent.jsonl'), 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim().startsWith('{')).map((line) => {
    const entry = JSON.parse(line) as Record<string, unknown>;
    entry.timestamp = NOW().toISOString();
    entry.cwd = env.workspace;
    entry.sessionId = sessionId;
    return JSON.stringify(entry).replaceAll('"claude-opus-5"', '"deepseek-v4-flash"');
  });
  const target = path.join(env.claudeDir, `${sessionId}.jsonl`);
  await writeFile(target, claudeHeaderLine(sessionId) + lines.join('\n') + '\n');
  await utimes(target, NOW(), NOW());
  return target;
}

/** A Codex rollout under a priced OpenAI model name. */
async function codexRollout(env: Env, threadId: string, header: { sessionId?: string; parentThreadId?: string } = {}) {
  const target = path.join(env.codexDir, `rollout-2026-07-28T12-00-00-${threadId}.jsonl`);
  const body = [
    JSON.stringify({ timestamp: NOW().toISOString(), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    JSON.stringify({ timestamp: NOW().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 40_000, cached_input_tokens: 0, output_tokens: 2_000 },
      last_token_usage: { input_tokens: 40_000, cached_input_tokens: 0, output_tokens: 2_000 },
    } } }),
  ].join('\n');
  await writeFile(target, codexHeaderLine(threadId, { ...header, cwd: env.workspace, timestamp: NOW().toISOString() })
    + body + '\n');
  await utimes(target, NOW(), NOW());
  return target;
}

function addSession(env: Env, sessionId: string, provider: string, jsonlPath: string, pin: string | null): void {
  sessionsDb.createSession(sessionId, provider, env.workspace, undefined, undefined, undefined, jsonlPath);
  participantsDb.recordSpawn(sessionId, env.userId);
  if (pin) sessionsDb.setSessionEnginePin(sessionId, pin, 'server_verdict');
}

test('a local-pinned Claude chat costs nothing and joins no cloud subscription', async () => {
  await withEnv(async (env) => {
    addSession(env, 'claude-local', 'claude', await claudeTranscript(env, 'claude-local'), LOCAL_PIN);
    addSession(env, 'claude-cloud', 'claude', await claudeTranscript(env, 'claude-cloud'), null);

    const local = await sessionCostService.getSessionCost('claude-local', env.userId, { probeAuth: probeAll });
    const cloud = await sessionCostService.getSessionCost('claude-cloud', env.userId, { probeAuth: probeAll });
    assert.ok(cloud.totalUsd > 0, 'control: the same transcript off the local pin is billed');
    assert.equal(local.totalUsd, 0);
    assert.deepEqual(local.unpricedModels, []);
    assert.equal(local.perModel.length, 1);
    assert.equal(local.perModel[0].costUsd, 0);
    assert.equal(local.perModel[0].requests, cloud.perModel[0].requests, 'usage is kept, only its bucket moves');

    const cards = await sessionCostService.getSubscriptionCosts(env.userId, { probeAuth: probeAll, now: NOW });
    assert.equal(cards.some((card) => card.provider === 'local'), false, 'local is not a subscription');
    const deepseek = cards.find((card) => card.provider === 'deepseek');
    assert.ok(deepseek, 'the control session still reaches DeepSeek');
    assert.equal(deepseek.sessions, 1, 'only the control session counts against DeepSeek');
  });
});

test('a local-pinned Codex chat costs nothing and does not count against OpenAI', async () => {
  await withEnv(async (env) => {
    addSession(env, ROOT_THREAD, 'codex', await codexRollout(env, ROOT_THREAD), LOCAL_PIN);

    const cost = await sessionCostService.getSessionCost(ROOT_THREAD, env.userId, { probeAuth: probeAll });
    assert.equal(cost.totalUsd, 0);
    assert.deepEqual(cost.unpricedModels, []);

    const cards = await sessionCostService.getSubscriptionCosts(env.userId, { probeAuth: probeAll, now: NOW });
    const openai = cards.find((card) => card.provider === 'openai');
    assert.equal(openai?.totalUsd ?? 0, 0);
    assert.equal(openai?.sessions ?? 0, 0);
    assert.equal(cards.some((card) => card.provider === 'local'), false);
  });
});

test('the project spend ledger books local turns under a zero-cost local bucket, children included', async () => {
  await withEnv(async (env) => {
    addSession(env, 'claude-local', 'claude', await claudeTranscript(env, 'claude-local'), LOCAL_PIN);
    addSession(env, ROOT_THREAD, 'codex', await codexRollout(env, ROOT_THREAD), LOCAL_PIN);
    // A Codex child thread has no sessions row of its own: its engine is its parent's.
    await codexRollout(env, CHILD_THREAD, { sessionId: ROOT_THREAD, parentThreadId: ROOT_THREAD });

    await costLedgerService.scan({
      claudeRoots: [path.dirname(env.claudeDir)],
      codexHomes: [path.dirname(codexSessionsRoot())],
      harnesses: ['claude', 'codex'],
      force: true,
    });

    const stats = costLedgerService.getProjectStats(`${PATH_PROJECT_ID_PREFIX}${env.workspace}`);
    assert.ok(stats.byVendor.length > 0, 'local usage is still recorded');
    assert.deepEqual([...new Set(stats.byVendor.map((row) => row.vendor))], ['local']);
    assert.ok(stats.byVendor.every((row) => !CLOUD_VENDORS.includes(row.vendor) && row.totalUsd === 0));
    assert.equal(stats.total.totalUsd, 0);
    assert.equal(stats.total.complete, true, 'a local turn is priced at zero, not unpriced');
    assert.equal(stats.byVendor.reduce((sum, row) => sum + row.conversations, 0), 3);
  });
});

test('control: an unpinned Codex rollout is still booked to OpenAI in the ledger', async () => {
  await withEnv(async (env) => {
    addSession(env, CONTROL_THREAD, 'codex', await codexRollout(env, CONTROL_THREAD), null);
    await costLedgerService.scan({ codexHomes: [path.dirname(codexSessionsRoot())], harnesses: ['codex'], force: true });
    const stats = costLedgerService.getProjectStats(`${PATH_PROJECT_ID_PREFIX}${env.workspace}`);
    assert.deepEqual([...new Set(stats.byVendor.map((row) => row.vendor))], ['openai']);
    assert.ok(stats.total.totalUsd > 0);
  });
});
