/**
 * اختبارات طبقة خدمة الكلفة على **سجلّات حقيقية**: كل ملف هنا نسخة من
 * `__fixtures__` المقتطعة حرفياً من سجلّات هذا الجهاز، لا سطور مُلفَّقة. الدرس
 * مدفوع الثمن في هذا المستودع: اختبار أخضر على fixture مصطنع لا يقول شيئاً عن
 * الإنتاج.
 *
 * والمقصود اختباره هنا هو **ما أضافته الخدمة** لا ما يفعله المحرّك: حلّ المسار،
 * الصدق حين لا قياس، الكاش وإبطاله، نافذة الدورة، وتخطّي الملفات الباردة.
 *
 * قاعدة زمنية: كل `now` مُحقَّن ومبنيّ بمُنشئ `Date` المحلّي، وكل mtime يُثبَّت
 * بـ`utimes` إلى لحظة معلومة — فلا يعتمد أي تأكيد على ساعة الجهاز الحقيقية.
 */

import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  closeConnection,
  conversationUsageSnapshotsDb,
  getConnection,
  initializeDatabase,
  participantsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { PRICES_AS_OF } from '@/modules/providers/services/cost/model-pricing.js';
import { sessionCostService } from '@/modules/providers/services/cost/session-cost.service.js';
import { ingestConversationUsage } from '@/modules/providers/services/cost/usage-ingestion.service.js';
import {
  subscriptionConfigService,
  type ProviderAuthProbe,
} from '@/modules/providers/services/cost/subscription-config.service.js';
import { _resetProviderSharingCache, setProviderSharingConfig } from '@/services/provider-sharing.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/** كلفة `claude-parent.jsonl` كاملةً بأسعار الجدول (محسوبة من الـfixture). */
const CLAUDE_PARENT_USD = 4 * 5e-6 + 1061 * 25e-6 + 48985 * 10e-6 + 48140 * 0.5e-6;
/** كلفة `codex-rollout.jsonl`: آخر عدّاد تراكمي، والمدخلات غير المخبّأة بالفرق. */
const CODEX_ROLLOUT_USD = 19374 * 5e-6 + 671 * 30e-6 + 46336 * 0.5e-6;

const near = (actual: number, expected: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} ≠ ${expected}`);
};

// ---------------------------------------------------------------------------
// بيئة اختبار: قاعدة مؤقّتة + شجرة سجلّات مؤقّتة
// ---------------------------------------------------------------------------

type Environment = {
  root: string;
  userId: number;
  /** ينسخ fixture إلى مسار سجلّ، ويُثبّت زمن تعديله. */
  addTranscript(name: string, fixture: string, mtime: Date): Promise<string>;
  /** يُنشئ صفّ جلسة (وينسب المستخدم مشاركاً كما يفعل مسار التشغيل). */
  addSession(sessionId: string, provider: string, jsonlPath: string | null, options?: { participant?: boolean }): void;
};

async function withEnvironment(run: (environment: Environment) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-cost-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'auth.db');
  await initializeDatabase();
  subscriptionConfigService._resetCaches();
  sessionCostService._resetCache();
  _resetProviderSharingCache();

  const userId = userDb.createUser('cost-user', 'hash', 'owner').id;

  const environment: Environment = {
    root,
    userId,
    async addTranscript(name, fixture, mtime) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(FIXTURES, fixture), target);
      await utimes(target, mtime, mtime);
      return target;
    },
    addSession(sessionId, provider, jsonlPath, options = {}) {
      sessionsDb.createSession(sessionId, provider, path.join(root, 'workspace'), undefined, undefined, undefined, jsonlPath);
      if (options.participant !== false) {
        participantsDb.recordSpawn(sessionId, userId);
      }
    },
  };

  try {
    await run(environment);
  } finally {
    subscriptionConfigService._resetCaches();
    sessionCostService._resetCache();
    _resetProviderSharingCache();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const probeOf = (method: string | null): ProviderAuthProbe => async () => ({
  installed: true,
  authenticated: method !== null,
  method,
});

/** فحص يقتصر على مزوّدات بعينها — كي لا تحشو اللوحةَ عشرةُ مزوّدات مُدّعاة. */
const probeOnly = (providers: string[], method = 'credentials_file'): ProviderAuthProbe => async (provider) =>
  providers.includes(provider)
    ? { installed: true, authenticated: true, method }
    : { installed: false, authenticated: false, method: null };

const SUBSCRIPTION_PROBE = probeOf('credentials_file');
const CLAUDE_ONLY_PROBE = probeOnly(['claude']);

// ---------------------------------------------------------------------------
// كلفة محادثة واحدة
// ---------------------------------------------------------------------------

test('كلفة محادثة كلود: أرقام المحرّك نفسها داخل مظروف العقد', async () => {
  await withEnvironment(async (environment) => {
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: 'tool_result',
        toolResult: { agentId: 'cost-worker', totalDurationMs: 55_000 },
      })}\n`,
      { flag: 'a' },
    );
    environment.addSession('sess-1', 'claude', transcript);

    const cost = await sessionCostService.getSessionCost('sess-1', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });

    assert.equal(cost.available, true);
    assert.equal(cost.reason, undefined);
    assert.equal(cost.provider, 'claude');
    assert.equal(cost.sessionId, 'sess-1');
    assert.equal(cost.pricesAsOf, PRICES_AS_OF);
    assert.equal(cost.complete, true);
    assert.deepEqual(cost.unpricedModels, []);
    assert.equal(cost.workDurationMs, 55_000);
    near(cost.totalUsd, CLAUDE_PARENT_USD, 'كلفة المحادثة');

    assert.equal(cost.perModel.length, 1);
    assert.equal(cost.perModel[0].model, 'claude-opus-5');
    assert.equal(cost.perModel[0].requests, 2);
    assert.deepEqual(cost.perModel[0].tokens, {
      input: 4,
      output: 1061,
      cacheWrite5m: 0,
      cacheWrite1h: 48985,
      cacheRead: 48140,
    });
  });
});

test('ledger reader لا يخدم الواجهة إلا عند العلم الصريح ويقرأ snapshot المنشأ', async () => {
  await withEnvironment(async (environment) => {
    const writer = process.env.USAGE_INGEST_WRITER;
    const reader = process.env.CONVERSATION_SNAPSHOT_READER;
    try {
      const transcript = await environment.addTranscript(
        'ledger-claude.jsonl',
        'claude-parent.jsonl',
        new Date('2026-08-17T10:00:00.000Z'),
      );
      environment.addSession('ledger-claude', 'claude', transcript);
      process.env.USAGE_INGEST_WRITER = 'on';
      process.env.CONVERSATION_SNAPSHOT_READER = 'ledger';
      await ingestConversationUsage({
        sessionId: 'ledger-claude', provider: 'claude', transcriptPath: transcript,
      });

      const cost = await sessionCostService.getSessionCost('ledger-claude', environment.userId, {
        probeAuth: SUBSCRIPTION_PROBE,
      });

      assert.equal(cost.available, true);
      assert.equal(cost.snapshotStatus, 'fresh');
      assert.equal(cost.snapshotAsOf !== null, true);
      assert.equal(cost.perModel[0].tokens.output, 1061);
    } finally {
      if (writer === undefined) delete process.env.USAGE_INGEST_WRITER;
      else process.env.USAGE_INGEST_WRITER = writer;
      if (reader === undefined) delete process.env.CONVERSATION_SNAPSHOT_READER;
      else process.env.CONVERSATION_SNAPSHOT_READER = reader;
    }
  });
});

test('summary GET never writes usage facts even when the background writer flag is on', async () => {
  await withEnvironment(async (environment) => {
    const writer = process.env.USAGE_INGEST_WRITER;
    const reader = process.env.CONVERSATION_SNAPSHOT_READER;
    try {
      const transcript = await environment.addTranscript(
        'read-only-claude.jsonl', 'claude-parent.jsonl', new Date('2026-08-17T10:00:00.000Z'),
      );
      environment.addSession('read-only-claude', 'claude', transcript);
      process.env.USAGE_INGEST_WRITER = 'on';
      process.env.CONVERSATION_SNAPSHOT_READER = 'legacy';
      await sessionCostService.getSessionCost('read-only-claude', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
      const count = (table: string): number => (getConnection()
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      assert.equal(count('usage_request_events'), 0);
      assert.equal(count('conversation_usage_snapshots'), 0);
      assert.equal(count('usage_source_checkpoints'), 0);
    } finally {
      if (writer === undefined) delete process.env.USAGE_INGEST_WRITER; else process.env.USAGE_INGEST_WRITER = writer;
      if (reader === undefined) delete process.env.CONVERSATION_SNAPSHOT_READER; else process.env.CONVERSATION_SNAPSHOT_READER = reader;
    }
  });
});

test('ledger with writer off never resolves manifests or writes for missing/stale snapshots', async () => {
  await withEnvironment(async (environment) => {
    const writer = process.env.USAGE_INGEST_WRITER;
    const reader = process.env.CONVERSATION_SNAPSHOT_READER;
    try {
      const rollout = await environment.addTranscript(
        'bounded/rollout-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
        'codex-rollout.jsonl',
        new Date('2026-08-17T10:00:00.000Z'),
      );
      environment.addSession('ledger-off-codex', 'codex', rollout);
      // A large adjacent child set makes accidental manifest traversal visible
      // through the explicit seam, without a flaky wall-clock assertion.
      const children = path.join(path.dirname(rollout), 'subagents');
      await mkdir(children, { recursive: true });
      await Promise.all(Array.from({ length: 128 }, (_, index) => writeFile(
        path.join(children, `rollout-${String(index).padStart(3, '0')}.jsonl`),
        '{"type":"event_msg"}\n',
      )));

      process.env.USAGE_INGEST_WRITER = 'off';
      process.env.CONVERSATION_SNAPSHOT_READER = 'ledger';
      let manifestResolutions = 0;
      const deps = {
        probeAuth: SUBSCRIPTION_PROBE,
        afterCodexManifest: () => {
          manifestResolutions += 1;
          throw new Error('ledger GET must not resolve a Codex manifest');
        },
      };
      const usageState = (): string => JSON.stringify(Object.fromEntries([
        'usage_source_checkpoints',
        'usage_request_events',
        'usage_request_occurrences',
        'usage_duration_events',
        'usage_source_links',
        'conversation_usage_snapshots',
      ].map((table) => [table, getConnection().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));

      const beforeMissing = usageState();
      const missing = await sessionCostService.getSessionCost('ledger-off-codex', environment.userId, deps);
      assert.equal(missing.available, false);
      assert.equal(usageState(), beforeMissing, 'missing snapshot GET is read-only');
      assert.equal(manifestResolutions, 0);

      assert.equal(conversationUsageSnapshotsDb.upsertCas({
        sessionId: 'ledger-off-codex',
        attributionKind: 'coordinator',
        attributionId: '',
        attributionScope: 'conversation',
        provider: 'codex',
        harness: 'codex',
        generation: 7,
        snapshotStatus: 'stale',
        asOf: '2026-08-17T10:00:00.000Z',
        measured: true,
        ingestComplete: false,
        pricingComplete: true,
        requestCount: 1,
        outputMaxCount: 1,
        inputTokens: 10,
        outputTokens: 2,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 3,
        reportedWorkDurationMs: 25,
        breakdown: {
          schemaVersion: 1,
          perModel: [{
            model: 'gpt-5.6-sol', requests: 1,
            tokens: { input: 10, output: 2, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 3 },
          }],
          unpricedModels: [], assumedModels: [], subagentRequests: 0, pricesAsOf: PRICES_AS_OF,
        },
      }, null), true);
      const beforeStale = usageState();
      const stale = await sessionCostService.getSessionCost('ledger-off-codex', environment.userId, deps);
      assert.equal(stale.available, true);
      assert.equal(stale.snapshotStatus, 'stale');
      assert.equal(usageState(), beforeStale, 'stale snapshot GET is read-only');
      assert.equal(manifestResolutions, 0, 'bounded ledger path never touches the 128-child manifest tree');
    } finally {
      if (writer === undefined) delete process.env.USAGE_INGEST_WRITER; else process.env.USAGE_INGEST_WRITER = writer;
      if (reader === undefined) delete process.env.CONVERSATION_SNAPSHOT_READER; else process.env.CONVERSATION_SNAPSHOT_READER = reader;
    }
  });
});

test('كلفة محادثة كودكس تُقرأ من ملف الـrollout بمُستخرِجه هو', async () => {
  await withEnvironment(async (environment) => {
    const rollout = await environment.addTranscript(
      'rollout-2026-07-26.jsonl',
      'codex-rollout.jsonl',
      new Date('2026-07-26T05:00:00.000Z'),
    );
    environment.addSession('codex-1', 'codex', rollout);

    const cost = await sessionCostService.getSessionCost('codex-1', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });

    assert.equal(cost.available, true);
    assert.equal(cost.perModel.length, 1);
    assert.equal(cost.perModel[0].model, 'gpt-5.6-sol');
    // العدّاد تراكمي: القيمة الأخيرة وحدها، لا مجموع الأحداث الأربعة.
    assert.deepEqual(cost.perModel[0].tokens, {
      input: 19374,
      output: 671,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 46336,
    });
    near(cost.totalUsd, CODEX_ROLLOUT_USD, 'كلفة محادثة كودكس');
  });
});

test('كلفة كودكس تعرض تفصيل كل دور مع إجمالي متّسق', async () => {
  await withEnvironment(async (environment) => {
    const rollout = path.join(environment.root, 'codex-turns.jsonl');
    const turn = (timestamp: string, id: string, totalInput: number, totalCached: number, totalOutput: number,
      lastInput: number, lastCached: number, lastOutput: number) => [
      JSON.stringify({ timestamp, type: 'response_item', payload: {
        type: 'message', role: 'assistant', phase: 'final_answer', id, content: [{ type: 'output_text', text: 'تم' }],
      } }),
      JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: totalInput, cached_input_tokens: totalCached, output_tokens: totalOutput },
        last_token_usage: { input_tokens: lastInput, cached_input_tokens: lastCached, output_tokens: lastOutput },
      } } }),
    ].join('\n');
    await writeFile(rollout, [
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      turn('2026-09-01T00:00:01.000Z', 'msg-first', 100, 20, 10, 100, 20, 10),
      JSON.stringify({ timestamp: '2026-09-01T00:00:30.000Z', type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'سؤال تالٍ' }],
      } }),
      turn('2026-09-01T00:01:01.000Z', 'msg-second', 300, 70, 35, 200, 50, 25),
    ].join('\n'));
    environment.addSession('codex-turns', 'codex', rollout);

    const cost = await sessionCostService.getSessionCost('codex-turns', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });
    assert.deepEqual(cost.turns?.map((turn) => turn.assistantMessageId), ['msg-first', 'msg-second']);
    assert.deepEqual(cost.turns?.map((turn) => turn.tokens.output), [10, 25]);
    assert.equal(cost.turns?.reduce((sum, turn) => sum + turn.tokens.input, 0), cost.perModel[0].tokens.input);
    assert.equal(cost.turns?.reduce((sum, turn) => sum + turn.tokens.output, 0), cost.perModel[0].tokens.output);
    near(cost.turns?.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0) ?? 0, cost.totalUsd,
      'مجموع كلفة الأدوار');
  });
});

test('كلفة كودكس تجمع المنسّق والأبناء المرتبطين وتعدّ كل spawn مرة واحدة', async () => {
  await withEnvironment(async (environment) => {
    const timestamp = new Date('2026-08-10T06:10:00.000Z');
    const root = await environment.addTranscript(
      'rollouts/rollout-root-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
      'codex-linked-root.jsonl',
      timestamp,
    );
    const uiChild = await environment.addTranscript(
      'rollouts/rollout-child-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl',
      'codex-linked-ui.jsonl',
      timestamp,
    );
    await environment.addTranscript(
      'rollouts/rollout-child-cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl',
      'codex-linked-front.jsonl',
      timestamp,
    );
    environment.addSession('codex-linked', 'codex', root);

    const cost = await sessionCostService.getSessionCost('codex-linked', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });

    assert.equal(cost.available, true);
    assert.equal(cost.subagentRequests, 2);
    assert.equal(cost.perModel.length, 1);
    assert.equal(cost.perModel[0].requests, 3);
    assert.deepEqual(cost.perModel[0].tokens, {
      input: 150,
      output: 17,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 30,
    });

    const changedChild = (await readFile(uiChild, 'utf8')).replace('"input_tokens":50', '"input_tokens":60');
    await writeFile(uiChild, changedChild);
    await utimes(uiChild, new Date('2026-08-10T06:11:00.000Z'), new Date('2026-08-10T06:11:00.000Z'));
    const refreshed = await sessionCostService.getSessionCost('codex-linked', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });
    assert.equal(refreshed.perModel[0].tokens.input, 160, 'تغيير rollout الابن يبطل كاش المحادثة');
  });
});

test('كلفة كودكس تنسب دور الابن إلى جواب الأم حين لا توجد response metrics', async () => {
  await withEnvironment(async (environment) => {
    const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const childId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const root = path.join(environment.root, `rollout-root-${rootId}.jsonl`);
    const child = path.join(environment.root, `rollout-child-${childId}.jsonl`);
    const token = (input: number, output: number) => JSON.stringify({ type: 'event_msg', payload: {
      type: 'token_count', info: {
        total_token_usage: { input_tokens: input, output_tokens: output },
        last_token_usage: { input_tokens: input, output_tokens: output },
      },
    } });
    await writeFile(root, [
      JSON.stringify({ type: 'session_meta', payload: { id: rootId, session_id: rootId, thread_source: 'user' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({ timestamp: '2026-09-03T00:00:01.000Z', type: 'event_msg', payload: {
        type: 'sub_agent_activity', kind: 'started', agent_thread_id: childId, agent_path: '/root/child',
      } }),
      JSON.stringify({ timestamp: '2026-09-03T00:00:10.000Z', type: 'response_item', payload: {
        type: 'message', role: 'assistant', phase: 'final_answer', id: 'msg-root', content: [{ type: 'output_text', text: 'جواب الأم' }],
      } }),
      JSON.stringify({ timestamp: '2026-09-03T00:00:11.000Z', ...JSON.parse(token(100, 10)) }),
    ].join('\n'));
    await writeFile(child, [
      JSON.stringify({ type: 'session_meta', payload: {
        id: childId, session_id: rootId, parent_thread_id: rootId, thread_source: 'subagent', agent_path: '/root/child', source: { subagent: true },
      } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({ timestamp: '2026-09-03T00:00:05.000Z', type: 'response_item', payload: {
        type: 'message', role: 'assistant', phase: 'final_answer', id: 'msg-child', content: [{ type: 'output_text', text: 'جواب الابن' }],
      } }),
      JSON.stringify({ timestamp: '2026-09-03T00:00:06.000Z', ...JSON.parse(token(50, 5)) }),
    ].join('\n'));
    environment.addSession('codex-parent-child-turns', 'codex', root);

    const cost = await sessionCostService.getSessionCost('codex-parent-child-turns', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });
    assert.deepEqual(cost.turns?.map((turn) => turn.assistantMessageId), ['msg-root']);
    assert.equal(cost.turns?.[0]?.tokens.output, 15);
    assert.equal(cost.turns?.[0]?.tokens.input, cost.perModel[0].tokens.input);
    assert.equal(cost.turns?.[0]?.tokens.output, cost.perModel[0].tokens.output);
  });
});

test('رابط كودكس الصريح غير المحلول يجعل snapshot ناقصاً ولا يخلط ذلك باكتمال التسعير', async () => {
  await withEnvironment(async (environment) => {
    const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const missingId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const root = path.join(environment.root, `rollout-root-${rootId}.jsonl`);
    await writeFile(root, [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: rootId, session_id: rootId, thread_source: 'user', model: 'gpt-5.2-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'sub_agent_activity', kind: 'started', agent_thread_id: missingId, agent_path: '/root/missing' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } },
      }),
    ].join('\n'));
    environment.addSession('codex-incomplete', 'codex', root);

    const cost = await sessionCostService.getSessionCost('codex-incomplete', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });

    assert.equal(cost.available, true);
    assert.equal(cost.snapshotStatus, 'incomplete');
    assert.equal(cost.snapshotAsOf !== null, true);
    assert.match(cost.snapshotReason ?? '', /could not be resolved/i);
    assert.equal(cost.complete, true, 'complete يصف التسعير فقط');
  });
});

test('نمو rollout بعد manifest وقبل signature لا يُعاد تأطيره كبصمة fresh', async () => {
  await withEnvironment(async (environment) => {
    const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const lateId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const root = path.join(environment.root, `rollout-race-${rootId}.jsonl`);
    await writeFile(root, [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: rootId, session_id: rootId, thread_source: 'user', model: 'gpt-5.2-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } },
      }),
    ].join('\n'));
    environment.addSession('codex-manifest-race', 'codex', root);

    const cost = await sessionCostService.getSessionCost('codex-manifest-race', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
      afterCodexManifest: async () => {
        await writeFile(root, `${await readFile(root, 'utf8')}\n${JSON.stringify({
          type: 'event_msg',
          payload: { type: 'sub_agent_activity', kind: 'started', agent_thread_id: lateId, agent_path: '/root/late' },
        })}\n`);
      },
    });

    assert.equal(cost.available, true);
    assert.equal(cost.snapshotStatus, 'incomplete');
    assert.match(cost.snapshotReason ?? '', /changed while|changed/i);
  });
});

test('بصمة كودكس العميقة تشمل الابن رقم 129 وتبطل الكاش عند تغيّره', async () => {
  await withEnvironment(async (environment) => {
    const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const childId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const rollouts = path.join(environment.root, 'rollouts');
    const root = path.join(rollouts, `rollout-root-${rootId}.jsonl`);
    const timestamp = new Date('2026-08-10T06:10:00.000Z');
    const rootLines = [JSON.stringify({
      type: 'session_meta', payload: { id: rootId, session_id: rootId, thread_source: 'user' },
    })];

    await mkdir(rollouts, { recursive: true });
    for (let index = 1; index <= 129; index += 1) {
      const id = childId(index);
      rootLines.push(JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity', kind: 'started', agent_thread_id: id, agent_path: `/root/worker-${index}`,
        },
      }));
      const child = path.join(rollouts, `rollout-child-${id}.jsonl`);
      await writeFile(child, `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id, session_id: rootId, parent_thread_id: rootId, thread_source: 'subagent',
          agent_path: `/root/worker-${index}`, source: { subagent: true },
        },
      })}\n${JSON.stringify({
        type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } },
      })}\n`);
      await utimes(child, timestamp, timestamp);
    }
    rootLines.push(JSON.stringify({
      type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } },
    }));
    await writeFile(root, `${rootLines.join('\n')}\n`);
    await utimes(root, timestamp, timestamp);
    environment.addSession('codex-129', 'codex', root);

    const first = await sessionCostService.getSessionCost('codex-129', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    assert.equal(first.available, true);
    assert.equal(first.perModel[0].requests, 130);
    assert.equal(first.perModel[0].tokens.input, 130);

    const finalChild = path.join(rollouts, `rollout-child-${childId(129)}.jsonl`);
    const changed = (await readFile(finalChild, 'utf8')).replace('"input_tokens":1', '"input_tokens":2');
    await writeFile(finalChild, changed);
    const newer = new Date('2026-08-10T06:11:00.000Z');
    await utimes(finalChild, newer, newer);

    const refreshed = await sessionCostService.getSessionCost('codex-129', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    assert.equal(refreshed.perModel[0].tokens.input, 131, 'الابن رقم 129 ضمن بصمة الكاش العميقة');
  });
});

test('مزوّد لا يحفظ استهلاكه: لا رقم ولا صفر — سببٌ مكتوب', async () => {
  await withEnvironment(async (environment) => {
    const transcript = await environment.addTranscript('agy.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('agy-1', 'antigravity', transcript);

    const cost = await sessionCostService.getSessionCost('agy-1', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });

    assert.equal(cost.available, false);
    assert.match(cost.reason ?? '', /token/i);
    assert.equal(cost.totalUsd, 0);
    assert.equal(cost.complete, false);
    assert.deepEqual(cost.perModel, []);
    // السجلّ موجود ومقروء — الامتناع سببه المزوّد لا الملف.
    assert.ok((await stat(transcript)).isFile());
  });
});

test('محادثة غير مفهرسة أو بلا سجلّ على القرص تعود بلا رقم ولا استثناء', async () => {
  await withEnvironment(async (environment) => {
    const unknown = await sessionCostService.getSessionCost('does-not-exist', environment.userId, {
      probeAuth: SUBSCRIPTION_PROBE,
    });
    assert.equal(unknown.available, false);
    assert.equal(unknown.totalUsd, 0);
    assert.ok((unknown.reason ?? '').length > 0);

    // صفّ يشير إلى ملف مُزال — نفس الصدق. المستخدم null كي لا يُهيَّأ جذر معزول.
    environment.addSession('gone-1', 'claude', path.join(environment.root, 'gone.jsonl'));
    const gone = await sessionCostService.getSessionCost('gone-1', null, { probeAuth: SUBSCRIPTION_PROBE });
    assert.equal(gone.available, false);
    assert.match(gone.reason ?? '', /disk/i);
    assert.equal(gone.provider, 'claude');
  });
});

test('metered يتبع طريقة المصادقة القائمة، وعند الشكّ يبقى «قيمة مكافئة»', async () => {
  await withEnvironment(async (environment) => {
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('sess-1', 'claude', transcript);

    const subscription = await sessionCostService.getSessionCost('sess-1', environment.userId, {
      probeAuth: probeOf('credentials_file'),
    });
    assert.equal(subscription.metered, false, 'اشتراك ⇒ قيمة مكافئة لا فاتورة');

    const apiKey = await sessionCostService.getSessionCost('sess-1', environment.userId, {
      probeAuth: probeOf('api_key'),
    });
    assert.equal(apiKey.metered, true, 'مفتاح API ⇒ مال مقيس');

    const broken = await sessionCostService.getSessionCost('sess-1', environment.userId, {
      probeAuth: async () => {
        throw new Error('probe exploded');
      },
    });
    assert.equal(broken.metered, false, 'فشل الفحص لا يُنتج ادّعاء فاتورة');
    // والكلفة نفسها لا تتأثّر بطريقة المصادقة.
    near(broken.totalUsd, CLAUDE_PARENT_USD, 'الكلفة مستقلّة عن metered');
  });
});

// ---------------------------------------------------------------------------
// الكاش
// ---------------------------------------------------------------------------

test('ملف بنفس البصمة لا يُقرأ ثانية، وأي تغيّر في زمنه يُبطل المخبَّأ', async () => {
  await withEnvironment(async (environment) => {
    const frozen = new Date('2026-07-28T12:00:00.000Z');
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', frozen);
    environment.addSession('sess-1', 'claude', transcript);

    const first = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    near(first.totalUsd, CLAUDE_PARENT_USD, 'القراءة الأولى');

    // محتوى مختلف بنفس **عدد البايتات** ونفس زمن التعديل: 172 ⇒ 999. لو قُرئ
    // الملف ثانية لظهر رقم آخر — فبقاء الرقم هو الدليل على أن الكاش خدم.
    const mutated = (await readFile(transcript, 'utf8')).replaceAll('"output_tokens": 172', '"output_tokens": 999');
    await writeFile(transcript, mutated);
    await utimes(transcript, frozen, frozen);

    const cached = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    near(cached.totalUsd, CLAUDE_PARENT_USD, 'نفس البصمة ⇒ نفس الرقم من الكاش');

    // تحريك زمن التعديل وحده (والمحتوى كما هو) يُسقط المفتاح فيُعاد القياس.
    const later = new Date('2026-07-28T12:01:00.000Z');
    await utimes(transcript, later, later);

    const refreshed = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    assert.ok(refreshed.totalUsd > cached.totalUsd, 'بصمة جديدة ⇒ قراءة جديدة');
    assert.equal(refreshed.perModel[0].tokens.output, 999 + 889);
  });
});

test('كتابة وكيل فرعي داخل ملف قائم تُبطل المخبَّأ رغم ثبات ملف الأمّ', async () => {
  await withEnvironment(async (environment) => {
    const frozen = new Date('2026-07-28T12:00:00.000Z');
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', frozen);
    environment.addSession('sess-1', 'claude', transcript);

    // مجلّد الوكلاء يُنشأ سلفاً بملف فارغ: بعد ذلك لا يتغيّر زمن المجلّد ولا
    // زمن ملف الأمّ، فلا يكشف الكتابةَ إلا مشيُ الشجرة. وزمن ملف الوكيل مُثبَّت
    // يدوياً لأن دقّة طوابع الملفات خشنة (4ms هنا)، فكتابتان متلاحقتان قد
    // تحملان نفس الطابع ويصير الاختبار رهن سرعة الجهاز.
    const agentFile = path.join(environment.root, 'sess', 'subagents', 'agent-a42e68ee5814334bd.jsonl');
    await mkdir(path.dirname(agentFile), { recursive: true });
    await writeFile(agentFile, '');
    const agentCreated = new Date('2026-07-28T12:00:01.000Z');
    await utimes(agentFile, agentCreated, agentCreated);

    const before = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    assert.deepEqual(before.perModel.map((entry) => entry.model), ['claude-opus-5']);

    await copyFile(path.join(FIXTURES, 'claude-subagent.jsonl'), agentFile);
    const agentWritten = new Date('2026-07-28T12:05:00.000Z');
    await utimes(agentFile, agentWritten, agentWritten);

    const after = await sessionCostService.getSessionCost('sess-1', environment.userId, { probeAuth: SUBSCRIPTION_PROBE });
    assert.deepEqual(after.perModel.map((entry) => entry.model).sort(), ['claude-opus-4-8', 'claude-opus-5']);
    assert.ok(after.totalUsd > before.totalUsd, 'استهلاك الوكيل يدخل المجموع');
    assert.equal(after.subagentRequests, 1);
  });
});

// ---------------------------------------------------------------------------
// الاشتراكات والدورة
// ---------------------------------------------------------------------------

/** 28 يوليو 2026 بالتوقيت المحلّي — مع يوم بداية 20 تصير الدورة [07-20, 08-20). */
const NOW_IN_CYCLE = () => new Date(2026, 6, 28, 18, 0, 0);

test('الدورة تحسب ما كُتب داخلها فقط — لا محادثةً كاملة نسبةً لتاريخ فتحها', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { anchorDay: 20, plan: 'Max 20x' }, environment.userId);

    // داخل الدورة: أسطره في 2026-07-28.
    const recent = await environment.addTranscript('recent.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('recent-1', 'claude', recent);

    // قبل الدورة محتوىً (‏2026-07-10) وإن كان الملف مكتوباً حديثاً — الترشيح
    // بطابع كل سطر لا بزمن الملف.
    const older = await environment.addTranscript('older.jsonl', 'claude-subagent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('older-1', 'claude', older);

    const [subscription] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });

    // مفتاح البطاقة هو **المورّد** لا الجسم: الاشتراك يُشترى من أنثروبيك،
    // و«claude» اسم الأداة التي شغّلته. (تصحيح المالك: GLM كان يظهر بطاقةً
    // فارغة بينما إنفاقه مدفون تحت بطاقة الحامل.)
    assert.equal(subscription.provider, 'anthropic');
    assert.equal(subscription.displayName, 'Claude');
    assert.equal(subscription.plan, 'Max 20x');
    assert.equal(subscription.anchorDay, 20);
    assert.equal(subscription.available, true);
    assert.equal(subscription.metered, false);
    assert.equal(subscription.sessions, 1, 'محادثة واحدة ساهمت داخل الدورة');
    near(subscription.totalUsd, CLAUDE_PARENT_USD, 'مجموع الدورة');
    assert.equal(subscription.complete, true);

    const start = new Date(subscription.cycleStart);
    const end = new Date(subscription.cycleEnd);
    assert.deepEqual([start.getFullYear(), start.getMonth() + 1, start.getDate()], [2026, 7, 20]);
    assert.deepEqual([end.getFullYear(), end.getMonth() + 1, end.getDate()], [2026, 8, 20]);
  });
});

test('ملف لم يُكتب فيه شيء منذ بداية الدورة لا يُفتح أصلاً', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { anchorDay: 20 }, environment.userId);

    // محتواه داخل الدورة تماماً، لكن زمن تعديله قبلها: لا سطر يمكن أن يكون
    // كُتب داخل النافذة، فيُتخطّى بـstat وحده. لو قُرئ لأضاف كلفته للمجموع.
    const cold = await environment.addTranscript('cold.jsonl', 'claude-parent.jsonl', new Date('2026-07-05T12:00:00.000Z'));
    environment.addSession('cold-1', 'claude', cold);

    const [subscription] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });

    assert.equal(subscription.sessions, 0);
    assert.equal(subscription.totalUsd, 0);
  });
});

test('سجلّ اختفى من القرص يُخفض «مكتمل» بدل أن يمرّ صامتاً', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { anchorDay: 20 }, environment.userId);

    const recent = await environment.addTranscript('recent.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('recent-1', 'claude', recent);
    environment.addSession('vanished-1', 'claude', path.join(environment.root, 'vanished.jsonl'));

    const [subscription] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });

    assert.equal(subscription.sessions, 1);
    near(subscription.totalUsd, CLAUDE_PARENT_USD, 'ما أمكن قياسه يبقى ظاهراً');
    assert.equal(subscription.complete, false, 'ناقصٌ يُقال ناقصاً');
  });
});

test('العزل يحصر المجموع في محادثات صاحب الاشتراك؛ والمشترك يجمعها كلّها', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { anchorDay: 20 }, environment.userId);

    const mine = await environment.addTranscript('mine.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('mine-1', 'claude', mine);

    // محادثة لا يشارك فيها هذا المستخدم — اعتماد غيره تحت العزل.
    const theirs = await environment.addTranscript('theirs.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('theirs-1', 'claude', theirs, { participant: false });

    const [isolated] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });
    assert.equal(isolated.sessions, 1, 'المعزول يرى اشتراكه هو');
    near(isolated.totalUsd, CLAUDE_PARENT_USD, 'مجموع المعزول');

    // اشتراك واحد للجميع ⇒ المجموع واحد لا يُقسَّم على المستخدمين.
    setProviderSharingConfig({ claude: 'shared' });
    sessionCostService._resetCache();

    const [shared] = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });
    assert.equal(shared.sessions, 2);
    near(shared.totalUsd, CLAUDE_PARENT_USD * 2, 'مجموع المشترك');
  });
});

test('مزوّد مُكتشَف بلا قياس يظهر في اللوحة بسببه، لا بصفر', async () => {
  await withEnvironment(async (environment) => {
    const subscriptions = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: async (provider) =>
        provider === 'gemini'
          ? { installed: true, authenticated: true, method: 'credentials_file' }
          : { installed: false, authenticated: false, method: null },
      now: NOW_IN_CYCLE,
    });

    assert.equal(subscriptions.length, 1);
    const [gemini] = subscriptions;
    assert.equal(gemini.provider, 'google');
    assert.equal(gemini.available, false);
    assert.ok((gemini.reason ?? '').length > 0);
    assert.equal(gemini.sessions, 0);
    assert.equal(gemini.complete, false);
    // ومع ذلك تبقى دورته معروضة كي تُضبط من الإعدادات.
    assert.ok(gemini.cycleStart < gemini.cycleEnd);
  });
});

test('المخفيّ لا يُحسب ولا يظهر في الاشتراكات', async () => {
  await withEnvironment(async (environment) => {
    subscriptionConfigService.update('claude', { hidden: true }, environment.userId);
    const transcript = await environment.addTranscript('sess.jsonl', 'claude-parent.jsonl', new Date('2026-07-28T12:00:00.000Z'));
    environment.addSession('sess-1', 'claude', transcript);

    const subscriptions = await sessionCostService.getSubscriptionCosts(environment.userId, {
      probeAuth: CLAUDE_ONLY_PROBE,
      now: NOW_IN_CYCLE,
    });

    assert.deepEqual(subscriptions, []);
  });
});
