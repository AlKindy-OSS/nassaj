/**
 * حرّاس انحدار لثلاثة عيوب رفعتها مراجعة نقدية على السجلّ الدائم، وأُعيد
 * إنتاجها جميعاً على أسطر سجلّات حقيقية قبل إصلاحها.
 *
 * تجتمع الثلاثة على معنى واحد: **رقمٌ دائم خاطئ أسوأ من لا رقم**. السجلّ
 * يُكتب مرّة ويُقرأ شهوراً، ولا مصدر يُراجَع به بعد أن يكنس المزوّد سجلّاته.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';

import {
  costLedgerService,
  localDay,
  PATH_PROJECT_ID_PREFIX,
  startCostLedgerScheduler,
  stopCostLedgerScheduler,
} from './cost-ledger.service.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const localNoon = (year: number, month: number, date: number): Date =>
  new Date(year, month - 1, date, 12, 0, 0, 0);

type Harness = { root: string; workspace: string };

async function withLedger(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temp = await mkdtemp(path.join(tmpdir(), 'ledger-regress-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temp, 'auth.db');
  await initializeDatabase();
  costLedgerService._resetCaches();

  const harness: Harness = {
    root: path.join(temp, 'claude', 'projects'),
    workspace: path.join(temp, 'workspace'),
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

async function restamp(fixture: string, when: Date, cwd: string): Promise<string> {
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

test('كنسُ ملف الأمّ لا يُضاعف إنفاق وكلائه الفرعيين في السجلّ', async () => {
  await withLedger(async ({ root, workspace }) => {
    const projectDir = path.join(root, '-tmp-workspace');
    await mkdir(path.join(projectDir, 'session-a', 'subagents'), { recursive: true });
    const day = localNoon(2026, 3, 10);

    const parent = path.join(projectDir, 'session-a.jsonl');
    await writeFile(parent, await restamp('claude-parent.jsonl', day, workspace));
    await writeFile(
      path.join(projectDir, 'session-a', 'subagents', 'agent-1.jsonl'),
      await restamp('claude-subagent.jsonl', day, workspace),
    );

    await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    const before = costLedgerService.getProjectTotal(projectIdFor(workspace));
    assert.ok(before.totalUsd > 0);

    // كلود يكنس ملف الأمّ بعد نحو شهر، ويبقى مجلّد الوكلاء.
    await rm(parent);
    await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });

    // صفوف الأمّ باقية (ديمومة) وهي **تحوي أصلاً** استهلاك الوكلاء، فابتلاع
    // المجلّد اليتيم مصدراً مستقلّاً كان يحسبه مرّتين إلى الأبد.
    const after = costLedgerService.getProjectTotal(projectIdFor(workspace));
    assert.equal(after.totalUsd, before.totalUsd);
  });
});

test('مجلّد وكلاء يتيم لم تُمسح أمّه قطّ يُحتسب — لا يسقط صامتاً', async () => {
  await withLedger(async ({ root, workspace }) => {
    const projectDir = path.join(root, '-tmp-workspace');
    await mkdir(path.join(projectDir, 'session-b', 'subagents'), { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-b', 'subagents', 'agent-1.jsonl'),
      await restamp('claude-subagent.jsonl', localNoon(2026, 3, 10), workspace),
    );

    // لا ملف أمّ ولا علامة مائية له: المجلّد هو السجلّ الوحيد لهذا الإنفاق.
    await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    assert.ok(costLedgerService.getProjectTotal(projectIdFor(workspace)).totalUsd > 0);
  });
});

test('إعادة كتابة سجلّ أقصر لا تمحو أيام إنفاق مضت', async () => {
  await withLedger(async ({ root, workspace }) => {
    const projectDir = path.join(root, '-tmp-workspace');
    await mkdir(projectDir, { recursive: true });
    const transcript = path.join(projectDir, 'session-c.jsonl');

    const dayOne = localNoon(2026, 3, 10);
    const dayTwo = localNoon(2026, 3, 11);
    await writeFile(
      transcript,
      (await restamp('claude-parent.jsonl', dayOne, workspace)) +
        (await restamp('claude-parent.jsonl', dayTwo, workspace)),
    );

    await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    const before = costLedgerService.getProjectTotal(projectIdFor(workspace));
    assert.equal(before.activeDays, 2);

    // ضغطٌ/تدوير يُبقي اليوم الأخير وحده — الحجم والطابع يتغيّران فيُعاد القراءة.
    await writeFile(transcript, await restamp('claude-parent.jsonl', dayTwo, workspace));
    await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'], force: true });

    const after = costLedgerService.getProjectTotal(projectIdFor(workspace));
    // اليوم الأول يبقى مسجَّلاً: الحذف محصور بأيام القراءة الجديدة.
    assert.equal(after.activeDays, 2, 'يوم الإنفاق الأول لم يُمحَ');
    assert.ok(after.totalUsd >= before.totalUsd * 0.99);
  });
});

test('مشروع لم يُمسح قطّ يُعلَن «غير مقيس» لا «$0.00 مكتمل»', async () => {
  await withLedger(async () => {
    const total = costLedgerService.getProjectTotal('project-never-scanned');
    assert.equal(total.totalUsd, 0);
    assert.equal(total.conversations, 0);
    // الفارق الذي يمنع رقماً مُلفَّقاً: صفرٌ بلا قياس ليس صفر إنفاق.
    assert.equal(total.measured, false);
    assert.equal(total.complete, false);
    assert.equal(total.firstDay, null);
  });
});

test('مشروع مقيس فعلاً يُعلَن مقيساً', async () => {
  await withLedger(async ({ root, workspace }) => {
    const projectDir = path.join(root, '-tmp-workspace');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-d.jsonl'),
      await restamp('claude-parent.jsonl', localNoon(2026, 3, 10), workspace),
    );

    await costLedgerService.scan({ claudeRoots: [root], harnesses: ['claude'] });
    const total = costLedgerService.getProjectTotal(projectIdFor(workspace));
    assert.equal(total.measured, true);
    assert.ok(total.totalUsd > 0);
    assert.equal(total.firstDay, localDay(localNoon(2026, 3, 10).getTime()));
  });
});

test('طلب `force` أثناء مسحٍ جارٍ يُصطفّ ولا يُبتلع في وعد المسح العادي', async () => {
  await withLedger(async ({ root, workspace }) => {
    const projectDir = path.join(root, '-tmp-workspace');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, 'session-e.jsonl'),
      await restamp('claude-parent.jsonl', localNoon(2026, 3, 10), workspace),
    );

    const options = { claudeRoots: [root], harnesses: ['claude'] as const };
    // مسحان متزامنان: الأول عاديّ والثاني قسريّ. الدمج كان يُعيد للثاني وعدَ
    // الأول، فيعود بتقرير مسحٍ تزايديّ ويبدو أنّ القسر جرى وهو لم يجرِ.
    const [plain, forced] = await Promise.all([
      costLedgerService.scan({ ...options }),
      costLedgerService.scan({ ...options, force: true }),
    ]);

    assert.ok(plain.scanned > 0, 'المسح العادي قرأ المصدر أول مرّة');
    // القسريّ أعاد قراءة المصدر رغم أنّ العلامة المائية صارت مطابقة.
    assert.ok(forced.scanned > 0, 'المسح القسري أعاد القراءة فعلاً');
    assert.notEqual(plain, forced, 'ليس الوعد نفسه');

    // ولا يُضاعف: إعادة القراءة استبدالٌ للمصدر لا إضافة إليه.
    const total = costLedgerService.getProjectTotal(projectIdFor(workspace));
    const again = await costLedgerService.scan({ ...options, force: true });
    assert.ok(again.scanned > 0);
    assert.equal(costLedgerService.getProjectTotal(projectIdFor(workspace)).totalUsd, total.totalUsd);
  });
});

test('المجدوِل يُشغّل ويُوقف بلا تسريب مؤقّت', () => {
  // لا يرمي، ويقبل الاستدعاء المتكرّر (hot-reload / double-init).
  startCostLedgerScheduler();
  startCostLedgerScheduler();
  stopCostLedgerScheduler();
  stopCostLedgerScheduler();
});
