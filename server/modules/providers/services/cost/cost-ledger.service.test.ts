/**
 * اختبارات ماسح السجلّ الدائم — على أسطر سجلّات **حقيقية** من
 * `__fixtures__/` لا على أشكال مُخترعة: أُعيد ختمها بطوابع الاختبار وحدها
 * وبقيت حمولات الاستهلاك كما كتبها المزوّد (درس fixtures المصطنعة).
 *
 * الخصائص الثلاث المُثبَتة هنا هي التي تُبنى عليها الميزة كلّها:
 *   1. **تقسيم الأيام** — محادثة على يومين تُنتج صفَّي يومين لا صفّاً واحداً.
 *   2. **عدم التضخّم** — مسحٌ ثانٍ (وثالث بـforce) لا يغيّر الإجمالي بمقدار ذرّة.
 *   3. **البقاء** — حذف السجلّ من القرص لا يمحو ما سُجّل، وهو سبب وجود الجدول.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectCostLedgerDb } from '@/modules/database/index.js';

import { costLedgerService, localDay, PATH_PROJECT_ID_PREFIX } from './cost-ledger.service.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/** منتصف نهار محلّي: يوم لا يلتبس بحدوده مهما كانت منطقة الخادم. */
const localNoon = (year: number, month: number, date: number): Date =>
  new Date(year, month - 1, date, 12, 0, 0, 0);

const DAY_ONE = localNoon(2026, 3, 10);
const DAY_TWO = localNoon(2026, 3, 11);

type Harness = { root: string; workspace: string; cleanup: () => Promise<void> };

async function withLedger(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temp = await mkdtemp(path.join(tmpdir(), 'cost-ledger-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(temp, 'auth.db');
  await initializeDatabase();
  costLedgerService._resetCaches();

  const harness: Harness = {
    root: path.join(temp, 'claude', 'projects'),
    workspace: path.join(temp, 'workspace'),
    cleanup: async () => {},
  };
  await mkdir(harness.root, { recursive: true });

  try {
    await runTest(harness);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temp, { recursive: true, force: true });
  }
}

/** يقرأ أسطر سجلّ حقيقي ويُعيد ختمها بطابع اليوم المطلوب مع حقن `cwd`. */
async function restampClaudeFixture(fixture: string, when: Date, cwd: string): Promise<string> {
  const raw = await readFile(path.join(FIXTURES, fixture), 'utf8');
  return `${raw
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      entry.timestamp = when.toISOString();
      entry.cwd = cwd;
      return JSON.stringify(entry);
    })
    .join('\n')}\n`;
}

const projectIdFor = (workspace: string): string => `${PATH_PROJECT_ID_PREFIX}${workspace}`;

test('a conversation spanning two days produces one ledger row per day', async () => {
  await withLedger(async ({ root, workspace }) => {
    const projectDir = path.join(root, '-tmp-workspace');
    await mkdir(projectDir, { recursive: true });

    // نفس أسطر الاستهلاك الحقيقية، نصفها في يوم ونصفها في اليوم التالي.
    const transcript = path.join(projectDir, 'session-a.jsonl');
    await writeFile(
      transcript,
      (await restampClaudeFixture('claude-parent.jsonl', DAY_ONE, workspace)) +
        (await restampClaudeFixture('claude-parent.jsonl', DAY_TWO, workspace)),
    );

    const report = await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    assert.equal(report.scanned, 1);
    assert.equal(report.unattributed, 0);

    const daily = costLedgerService.getProjectDaily(projectIdFor(workspace));
    assert.deepEqual(
      daily.map((row) => row.day),
      [localDay(DAY_ONE.getTime()), localDay(DAY_TWO.getTime())],
    );
    // يوم واحد لا يبتلع اليومين: لكلٍّ كلفته، وكلتاهما موجبة.
    assert.ok(daily[0].costUsd > 0);
    assert.ok(daily[1].costUsd > 0);
    assert.equal(daily[0].costUsd, daily[0].totalUsd);
  });
});

test('rescanning never inflates: the total is identical after a second and a forced third scan', async () => {
  await withLedger(async ({ root, workspace }) => {
    const projectDir = path.join(root, '-tmp-workspace');
    await mkdir(projectDir, { recursive: true });
    const transcript = path.join(projectDir, 'session-a.jsonl');
    await writeFile(transcript, await restampClaudeFixture('claude-parent.jsonl', DAY_ONE, workspace));

    // ووكيل فرعي بجانبها: ملفه منفصل، وكلفته جزء من نفس المحادثة.
    const subagentDir = path.join(projectDir, 'session-a', 'subagents');
    await mkdir(subagentDir, { recursive: true });
    await writeFile(
      path.join(subagentDir, 'agent-1.jsonl'),
      await restampClaudeFixture('claude-subagent.jsonl', DAY_ONE, workspace),
    );

    const first = await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    const baseline = costLedgerService.getProjectTotal(projectIdFor(workspace));
    assert.equal(first.scanned, 1);
    assert.ok(baseline.totalUsd > 0);

    const second = await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    // العلامة المائية تمنع فتح ملف لم يتغيّر أصلاً.
    assert.equal(second.scanned, 0);
    assert.equal(second.skippedUnchanged, 1);
    assert.equal(costLedgerService.getProjectTotal(projectIdFor(workspace)).totalUsd, baseline.totalUsd);

    // وحتى حين يُعاد فتح الملف فعلاً (force) تبقى القيمة هي هي: الكتابة
    // استبدالٌ لا جمع. لو كانت `cost = cost + x` لتضاعف الرقم هنا.
    const third = await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'], force: true });
    assert.equal(third.scanned, 1);
    assert.equal(costLedgerService.getProjectTotal(projectIdFor(workspace)).totalUsd, baseline.totalUsd);
  });
});

test('the ledger survives the deletion of the transcript it was derived from', async () => {
  await withLedger(async ({ root, workspace }) => {
    const projectDir = path.join(root, '-tmp-workspace');
    await mkdir(projectDir, { recursive: true });
    const transcript = path.join(projectDir, 'session-a.jsonl');
    await writeFile(transcript, await restampClaudeFixture('claude-parent.jsonl', DAY_ONE, workspace));

    await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    const baseline = costLedgerService.getProjectTotal(projectIdFor(workspace));
    assert.ok(baseline.totalUsd > 0);

    // كنس الاحتفاظ لدى كلود: السجلّ يختفي من القرص بعد ~30 يوماً.
    await rm(transcript);

    const after = await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'], force: true });
    assert.equal(after.scanned, 0);

    const survived = costLedgerService.getProjectTotal(projectIdFor(workspace));
    assert.equal(survived.totalUsd, baseline.totalUsd);
    assert.equal(survived.firstDay, localDay(DAY_ONE.getTime()));
  });
});

test('subagent transcripts whose parent was pruned are still counted, not silently dropped', async () => {
  await withLedger(async ({ root, workspace }) => {
    const projectDir = path.join(root, '-tmp-workspace');
    // مجلّد جلسة بلا ملف أمّ — الشكل الذي يتركه كنس الاحتفاظ لدى كلود، وهو
    // موجود فعلاً على هذا الجهاز (مجلّد واحد بسبعة سجلّات وكلاء بلا أمّ).
    const orphanDir = path.join(projectDir, 'pruned-session', 'subagents');
    await mkdir(orphanDir, { recursive: true });
    await writeFile(
      path.join(orphanDir, 'agent-1.jsonl'),
      await restampClaudeFixture('claude-subagent.jsonl', DAY_ONE, workspace),
    );

    const report = await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    assert.equal(report.scanned, 1);

    const total = costLedgerService.getProjectTotal(projectIdFor(workspace));
    assert.ok(total.totalUsd > 0, 'orphaned subagent spend must reach the ledger');

    // وهو تزايدي كبقيّة السجلّات: لا يُعاد فتحه ما لم يتغيّر.
    const second = await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    assert.equal(second.skippedUnchanged, 1);
    assert.equal(costLedgerService.getProjectTotal(projectIdFor(workspace)).totalUsd, total.totalUsd);
  });
});

test('codex day attribution subtracts the cumulative baseline instead of double counting', async () => {
  await withLedger(async ({ workspace }) => {
    const temp = await mkdtemp(path.join(tmpdir(), 'codex-home-'));
    const sessionsDir = path.join(temp, 'sessions', '2026', '03', '10');
    await mkdir(sessionsDir, { recursive: true });

    const raw = await readFile(path.join(FIXTURES, 'codex-rollout.jsonl'), 'utf8');
    const lines = raw
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    // أول سطر يحمل مجلّد العمل كما يفعل `session_meta` الحقيقي.
    const meta = { timestamp: DAY_ONE.toISOString(), type: 'session_meta', payload: { cwd: workspace, model: 'gpt-5.6-sol' } };
    // نصف أحداث العدّاد في اليوم الأول والنصف الثاني في اليوم التالي.
    const restamped = lines.map((entry, index) => {
      entry.timestamp = (index < 3 ? DAY_ONE : DAY_TWO).toISOString();
      return JSON.stringify(entry);
    });

    const rollout = path.join(sessionsDir, 'rollout-test.jsonl');
    await writeFile(rollout, `${JSON.stringify(meta)}\n${restamped.join('\n')}\n`);

    try {
      const report = await costLedgerService.scan({ codexHomes: [temp], harnesses: ['codex'] });
      assert.equal(report.scanned, 1);
      assert.equal(report.unattributed, 0);

      const daily = costLedgerService.getProjectDaily(projectIdFor(workspace));
      assert.equal(daily.length, 2);

      // العدّاد تراكمي: مجموع اليومين يساوي آخر عدّاد لا ضعفه.
      const wholeRun = costLedgerService.getProjectTotal(projectIdFor(workspace));
      const summed = daily.reduce((accumulator, row) => accumulator + row.costUsd, 0);
      assert.ok(Math.abs(wholeRun.totalUsd - summed) < 1e-9);
      // اليوم الثاني حصّة (فرقُ العدّاد) لا كل تاريخ المحادثة.
      assert.ok(daily[1].costUsd < wholeRun.totalUsd);

      // وإعادة المسح لا تُضاعف هنا أيضاً.
      await costLedgerService.scan({ codexHomes: [temp], harnesses: ['codex'], force: true });
      assert.equal(costLedgerService.getProjectTotal(projectIdFor(workspace)).totalUsd, wholeRun.totalUsd);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

test('a transcript with no resolvable project is reported, not attributed to a guess', async () => {
  await withLedger(async ({ root }) => {
    const projectDir = path.join(root, '-tmp-unknown');
    await mkdir(projectDir, { recursive: true });

    const raw = await readFile(path.join(FIXTURES, 'claude-parent.jsonl'), 'utf8');
    // بلا `cwd` وبلا صفّ جلسة: لا سبيل لمعرفة مشروعه.
    await writeFile(path.join(projectDir, 'orphan.jsonl'), raw);

    const report = await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    assert.equal(report.unattributed, 1);
    assert.equal(report.rowsWritten, 0);
    // ولا علامة مائية له: يُعاد النظر فيه حين يُعرف مشروعه لاحقاً.
    assert.equal(projectCostLedgerDb.getSourceWatermark(path.join(projectDir, 'orphan.jsonl')), null);
  });
});

test('known unattributable spend is declared as a gap rather than silently omitted', async () => {
  await withLedger(async ({ root }) => {
    const report = await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    const harnesses = report.gaps.map((gap) => gap.harness);
    assert.ok(harnesses.includes('hermes'));
    for (const gap of report.gaps) {
      assert.ok(gap.reason.length > 20, 'a gap must carry a written reason, not a flag');
    }
  });
});
