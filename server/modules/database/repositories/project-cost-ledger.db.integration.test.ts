/**
 * اختبارات مستودع السجلّ الدائم على قاعدة حقيقية (لا mock): الخصائص المُختبَرة
 * هنا خصائص SQL — الاستبدال، والتجميع، وجسر المسار — ولا يُثبتها إلا محرّك
 * القاعدة نفسه.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  projectCostLedgerDb,
  type LedgerRowInput,
} from '@/modules/database/repositories/project-cost-ledger.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-cost-ledger-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const row = (overrides: Partial<LedgerRowInput> = {}): LedgerRowInput => ({
  projectId: 'project-1',
  projectPath: '/home/dev/workspace/demo',
  day: '2026-03-10',
  vendor: 'anthropic',
  model: 'claude-opus-5',
  harness: 'claude',
  costUsd: 2.5,
  priced: true,
  assumed: false,
  tokens: { input: 100, output: 200, cacheWrite5m: 300, cacheWrite1h: 0, cacheRead: 400 },
  requests: 3,
  pricesAsOf: '2026-07-28',
  ...overrides,
});

const scope = { projectId: 'project-1', projectPath: '/home/dev/workspace/demo' };

test('writing the same source twice replaces its rows instead of accumulating them', async () => {
  await withIsolatedDatabase(() => {
    const watermark = { sourceKey: '/transcripts/a.jsonl', provider: 'claude', mtimeMs: 10, sizeBytes: 50 };

    projectCostLedgerDb.replaceSource(watermark, [row()]);
    assert.equal(projectCostLedgerDb.getTotals(scope).totalUsd, 2.5);

    // نفس المصدر بنفس القيمة عشر مرّات: الإجمالي هو هو. لو كان التحديث جمعاً
    // لصار 25$ — وهذا بالضبط التضخّم الذي تمنعه بنية المفتاح.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      projectCostLedgerDb.replaceSource(watermark, [row()]);
    }
    assert.equal(projectCostLedgerDb.getTotals(scope).totalUsd, 2.5);

    // وإعادة حساب أرخص (سعر تغيّر مثلاً) تستبدل ولا تُضاف.
    projectCostLedgerDb.replaceSource(watermark, [row({ costUsd: 1 })]);
    assert.equal(projectCostLedgerDb.getTotals(scope).totalUsd, 1);
  });
});

test('two sources contributing to the same day are summed, and rescanning one leaves the other intact', async () => {
  await withIsolatedDatabase(() => {
    projectCostLedgerDb.replaceSource(
      { sourceKey: '/transcripts/a.jsonl', provider: 'claude', mtimeMs: 10, sizeBytes: 50 },
      [row({ costUsd: 2 })],
    );
    projectCostLedgerDb.replaceSource(
      { sourceKey: '/transcripts/b.jsonl', provider: 'claude', mtimeMs: 11, sizeBytes: 60 },
      [row({ costUsd: 3 })],
    );

    const daily = projectCostLedgerDb.getDaily(scope);
    assert.equal(daily.length, 1);
    assert.equal(daily[0].totalUsd, 5);
    assert.equal(daily[0].conversations, 2);

    // المسح التزايدي يُعيد قراءة ملف واحد؛ استبداله يجب ألّا يمسّ جاره.
    projectCostLedgerDb.replaceSource(
      { sourceKey: '/transcripts/a.jsonl', provider: 'claude', mtimeMs: 20, sizeBytes: 55 },
      [row({ costUsd: 4 })],
    );
    assert.equal(projectCostLedgerDb.getTotals(scope).totalUsd, 7);
  });
});

test('an unpriced model is recorded as unpriced, not as zero spend', async () => {
  await withIsolatedDatabase(() => {
    projectCostLedgerDb.replaceSource(
      { sourceKey: '/transcripts/a.jsonl', provider: 'claude', mtimeMs: 1, sizeBytes: 1 },
      [row(), row({ model: 'mystery-model-9', costUsd: 0, priced: false })],
    );

    const totals = projectCostLedgerDb.getTotals(scope);
    assert.equal(totals.totalUsd, 2.5);
    // الرقم يبقى معروضاً لكنه **جزئي**، والنموذج الناقص مسمّى لا مطموس.
    assert.equal(totals.complete, false);
    assert.deepEqual(totals.unpricedModels, ['mystery-model-9']);
  });
});

test('history survives a project being re-registered under a new id, through its path', async () => {
  await withIsolatedDatabase(() => {
    projectCostLedgerDb.replaceSource(
      { sourceKey: '/transcripts/a.jsonl', provider: 'claude', mtimeMs: 1, sizeBytes: 1 },
      [row({ projectId: 'old-uuid' })],
    );

    // المشروع حُذف صفّه ثم أُعيد تسجيله بمُعرِّف جديد؛ المسار هو الجسر.
    const rebound = projectCostLedgerDb.getTotals({
      projectId: 'brand-new-uuid',
      projectPath: '/home/dev/workspace/demo',
    });
    assert.equal(rebound.totalUsd, 2.5);

    // ومشروعٌ آخر لا يلتقط تاريخ جاره.
    const stranger = projectCostLedgerDb.getTotals({ projectId: 'other', projectPath: '/home/dev/workspace/other' });
    assert.equal(stranger.totalUsd, 0);
    assert.equal(stranger.conversations, 0);
  });
});

test('the watermark is written with the rows, in the same transaction', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(projectCostLedgerDb.getSourceWatermark('/transcripts/a.jsonl'), null);

    projectCostLedgerDb.replaceSource(
      { sourceKey: '/transcripts/a.jsonl', provider: 'claude', mtimeMs: 1234, sizeBytes: 99 },
      [row()],
    );

    const mark = projectCostLedgerDb.getSourceWatermark('/transcripts/a.jsonl');
    assert.equal(mark?.mtimeMs, 1234);
    assert.equal(mark?.sizeBytes, 99);

    const byProvider = projectCostLedgerDb.getSourceWatermarks('claude');
    assert.equal(byProvider.size, 1);
    assert.equal(projectCostLedgerDb.getSourceWatermarks('codex').size, 0);
  });
});

test('day range filters the curve while the vendor and model groupings stay lifetime', async () => {
  await withIsolatedDatabase(() => {
    projectCostLedgerDb.replaceSource(
      { sourceKey: '/transcripts/a.jsonl', provider: 'claude', mtimeMs: 1, sizeBytes: 1 },
      [
        row({ day: '2026-03-09', costUsd: 1 }),
        row({ day: '2026-03-10', costUsd: 2 }),
        row({ day: '2026-03-11', costUsd: 4, model: 'claude-sonnet-4-6' }),
      ],
    );

    const windowed = projectCostLedgerDb.getDaily(scope, { since: '2026-03-10', until: '2026-03-10' });
    assert.deepEqual(
      windowed.map((entry) => entry.totalUsd),
      [2],
    );

    assert.equal(projectCostLedgerDb.getTotals(scope).totalUsd, 7);
    assert.equal(projectCostLedgerDb.getTotals(scope).days, 3);

    const byVendor = projectCostLedgerDb.getVendorTotals(scope);
    assert.deepEqual(byVendor.map((entry) => entry.key), ['anthropic']);
    assert.equal(byVendor[0].totalUsd, 7);

    const byModel = projectCostLedgerDb.getModelTotals(scope);
    assert.deepEqual(byModel.map((entry) => entry.key), ['claude-sonnet-4-6', 'claude-opus-5']);
  });
});

test('the ledger has no delete path: rows outlive the source file by construction', async () => {
  await withIsolatedDatabase(() => {
    projectCostLedgerDb.replaceSource(
      { sourceKey: '/transcripts/gone.jsonl', provider: 'claude', mtimeMs: 1, sizeBytes: 1 },
      [row()],
    );

    // لا دالّة حذف بمشروع ولا بيوم في المستودع — والصفوف تبقى في القاعدة.
    const remaining = getConnection()
      .prepare('SELECT COUNT(*) AS total FROM project_cost_daily')
      .get() as { total: number };
    assert.equal(remaining.total, 1);
    assert.equal(
      Object.keys(projectCostLedgerDb).some((name) => name.toLowerCase().includes('delete')),
      false,
    );
  });
});
