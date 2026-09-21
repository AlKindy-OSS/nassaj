/**
 * B-577 — حالة المحادثة حقيقةٌ مشتركة، وإقرارُ رؤيتها شخصيّ.
 *
 * مطلبُ المالك (2026-08-08): «هذه الشارات مرتبطة بالمحادثات ومن غير المهم هي
 * تعمل تحت أي مستخدم، أي مستخدم يجب أن يتمكن من معرفة عدد المحادثات النشطة
 * وحالتها». والعطبُ الذي جاء هذا يستأصله: الحالة كانت في `localStorage` لكل
 * متصفّح، فمن كان مغلقاً لحظة الانتهاء لا يرى شيئاً أبداً — تسع محادثات أنهت
 * عملها وصفر شارات في لقطة المالك.
 *
 * ما يحرسه هذا الملف على قاعدةٍ حقيقية (لا mocks):
 *   1. عضوٌ لم يشهد شيئاً يرى الحكم — وهو جوهر الطلب.
 *   2. فتحُ المحادثة عند عضو **لا يُطفئ** شارة الآخرين.
 *   3. جولةٌ جديدة تُلغي إقرار الجميع بلا كتابةٍ واحدة في جدول القراءات.
 *   4. الرؤية مغلقة: لا يُسرَّب حكمُ محادثةٍ في مشروعٍ لا يراه الطالب.
 *
 * Runner: node:test (npm run test:server).
 */

import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';

import Database from 'better-sqlite3';

import { initializeDatabase } from '@/modules/database/init-db.js';
import { migrateSessionOutcomes } from '@/modules/database/migrations.js';
import { getConnection } from '@/modules/database/connection.js';
import { sessionOutcomesDb } from '@/modules/database/repositories/session-outcomes.db.js';
import {
  applyOutcomePayload,
  markRunEnded,
  markRunStarted,
  markRunVerdictSeen,
  resolveQuestionRequest,
} from '@/modules/websocket/index.js';

const VISIBLE_PATH = '/tmp/nassaj-outcomes-visible';
const PRIVATE_PATH = '/tmp/nassaj-outcomes-private';
const SESSION_A = 'sess-outcome-a';
const SESSION_PRIVATE = 'sess-outcome-private';
const USER_WATCHER = 101;
const USER_OTHER = 102;

before(async () => {
  await initializeDatabase();
});

beforeEach(() => {
  const db = getConnection();
  db.prepare('DELETE FROM session_run_outcomes').run();
  db.prepare('DELETE FROM session_outcome_reads').run();
  db.prepare('DELETE FROM sessions WHERE session_id IN (?, ?)').run(SESSION_A, SESSION_PRIVATE);
  // مفتاحان أجنبيّان: `session_outcome_reads` → `users`، و`sessions` → `projects`.
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash)
     VALUES (?, 'outcome-watcher', 'x'), (?, 'outcome-other', 'x')`
  ).run(USER_WATCHER, USER_OTHER);
  db.prepare(
    `INSERT OR IGNORE INTO projects (project_id, project_path, visibility)
     VALUES ('proj-visible', ?, 'public'), ('proj-private', ?, 'private')`
  ).run(VISIBLE_PATH, PRIVATE_PATH);
  db.prepare(
    `INSERT OR REPLACE INTO sessions (session_id, provider, project_path, isArchived)
     VALUES (?, 'claude', ?, 0), (?, 'claude', ?, 0)`
  ).run(SESSION_A, VISIBLE_PATH, SESSION_PRIVATE, PRIVATE_PATH);
});

test('عضوٌ لم يشهد النهاية يرى الحكم — جوهر مطلب المالك', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'done', 'claude');

  // مستخدمٌ لم يكن متصلاً لحظة الانتهاء، ولم يشغّل الجولة أصلاً.
  const unseen = sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH]);

  assert.equal(unseen.length, 1);
  assert.equal(unseen[0].sessionId, SESSION_A);
  assert.equal(unseen[0].outcome, 'done');
});

test('إقرارُ عضوٍ بالنهاية يُطفئها عالمياً', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'error');

  const outcomeAt = sessionOutcomesDb.getOutcomesForSessions([SESSION_A]).get(SESSION_A)?.outcomeAt;
  assert.ok(outcomeAt);
  sessionOutcomesDb.markOutcomeSeen(SESSION_A, outcomeAt);

  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_WATCHER, [VISIBLE_PATH]).length, 0);
  assert.equal(
    sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH]).length,
    0,
    'الإقرار العالمي لم يتزامن مع عضو آخر',
  );
  const legacyReads = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM session_outcome_reads WHERE session_id = ?')
    .get(SESSION_A) as { n: number };
  assert.ok(legacyReads.n >= 2, 'لم تُكتب قراءات rollback لكل المستخدمين الحاليين');
});

test('جولةٌ جديدة تُلغي الإقرار العالمي وتُظهر الحكم الجديد للجميع', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'done');
  const outcomeAt = sessionOutcomesDb.getOutcomesForSessions([SESSION_A]).get(SESSION_A)?.outcomeAt;
  assert.ok(outcomeAt);
  sessionOutcomesDb.markOutcomeSeen(SESSION_A, outcomeAt);
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_WATCHER, [VISIBLE_PATH]).length, 0);

  sessionOutcomesDb.recordOutcome(SESSION_A, 'error');

  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_WATCHER, [VISIBLE_PATH]).length, 1);
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH]).length, 1);
});

test('الرؤية مغلقة: لا يُسرَّب حكمُ محادثةٍ في مشروعٍ لا يراه الطالب', () => {
  sessionOutcomesDb.recordOutcome(SESSION_PRIVATE, 'done');
  sessionOutcomesDb.recordOutcome(SESSION_A, 'done');

  const unseen = sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH]);

  assert.deepEqual(
    unseen.map((row) => row.sessionId),
    [SESSION_A],
    'ظهر حكمُ جلسةٍ في مشروع لا يراه الطالب',
  );
});

test('بدءُ جولةٍ جديدة يمحو الحكم فتُطفأ الشارة عند الجميع', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'done');
  sessionOutcomesDb.clearOutcome(SESSION_A);

  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH]).length, 0);
});

/**
 * ‏B-585 — «تحديد كغير مقروء»: عضوٌ فتح محادثة زميله بالخطأ فأطفأ شارته عنده،
 * فيُعيدها لنفسه. والحكمُ لا يُمَسّ — فما يراه الآخرون لا يتغيّر بفعلِ غيرهم.
 */
test('إبطالُ الإقرار يُعيد الشارة للجميع', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'done');
  const outcomeAt = sessionOutcomesDb.getOutcomesForSessions([SESSION_A]).get(SESSION_A)?.outcomeAt;
  assert.ok(outcomeAt);
  sessionOutcomesDb.markOutcomeSeen(SESSION_A, outcomeAt);
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_WATCHER, [VISIBLE_PATH]).length, 0);
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH]).length, 0);

  const restored = sessionOutcomesDb.clearOutcomeSeen(SESSION_A);

  assert.equal(restored?.outcome, 'done', 'لم يُرجَع الحكم فلا سبيل لعرضه فوراً');
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_WATCHER, [VISIBLE_PATH]).length, 1);
  assert.equal(
    sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH]).length,
    1,
    'إبطالُ الإقرار العالمي لم يُعد الشارة لعضو آخر',
  );
});

test('إبطالُ إقرارٍ بلا حكمٍ قائم لا يخترع شارة', () => {
  const restored = sessionOutcomesDb.clearOutcomeSeen(SESSION_A);

  assert.equal(restored, null);
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_WATCHER, [VISIBLE_PATH]).length, 0);
});

test('فتح السؤال لا يقرّه ولا يخفيه عن أي عضو', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'question');

  const outcomeAt = sessionOutcomesDb.getOutcomesForSessions([SESSION_A]).get(SESSION_A)?.outcomeAt;
  assert.ok(outcomeAt);
  sessionOutcomesDb.markOutcomeSeen(SESSION_A, outcomeAt);

  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_WATCHER, [VISIBLE_PATH])[0]?.outcome, 'question');
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH])[0]?.outcome, 'question');
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, 'question');
});

test('السؤال لا يزول إلا بإجابة/إلغاء أو بدء جولة', () => {
  markRunStarted(SESSION_A);
  applyOutcomePayload(SESSION_A, { kind: 'permission_request', requestId: 'req-one' });
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, 'question');

  applyOutcomePayload(SESSION_A, { kind: 'permission_cancelled', requestId: 'req-one' });
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcomeState, 'absent');

  applyOutcomePayload(SESSION_A, { kind: 'permission_request', requestId: 'req-two' });
  markRunStarted(SESSION_A);
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcomeState, 'absent');
});

test('سؤالان متوازيان: حسم أحدهما لا يخفي الآخر', () => {
  markRunStarted(SESSION_A);
  applyOutcomePayload(SESSION_A, { kind: 'permission_request', requestId: 'req-a' });
  applyOutcomePayload(SESSION_A, { kind: 'interactive_prompt', requestId: 'req-b' });

  applyOutcomePayload(SESSION_A, { kind: 'permission_cancelled', requestId: 'req-a' });
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, 'question');

  applyOutcomePayload(SESSION_A, { kind: 'permission_cancelled', requestId: 'req-b' });
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, null);
});

test('نجاح resolver للإجابة الفعلية يحسم requestId المحدد ويبث زوال الأخير', () => {
  markRunStarted(SESSION_A);
  applyOutcomePayload(SESSION_A, { kind: 'permission_request', requestId: 'req-answer' });

  assert.equal(resolveQuestionRequest(SESSION_A, 'req-answer'), true);
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, null);
  assert.equal(resolveQuestionRequest(SESSION_A, 'req-answer'), false, 'الحسم المكرر ليس نجاحاً جديداً');
});

test('حسم السؤال بمعرّف بديل يزيله مرة واحدة دون سؤال آخر', () => {
  markRunStarted(SESSION_A);
  applyOutcomePayload(SESSION_A, {
    kind: 'permission_request',
    requestId: 'req-aliased',
    toolUseId: 'tool-aliased',
  });
  applyOutcomePayload(SESSION_A, { kind: 'interactive_prompt', requestId: 'req-other' });

  applyOutcomePayload(SESSION_A, { kind: 'permission_cancelled', toolUseId: 'tool-aliased' });
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, 'question');
  assert.equal(
    resolveQuestionRequest(SESSION_A, 'req-aliased'),
    false,
    'المعرّف البديل الثاني للسؤال المحسوم لا يحسم سؤالاً آخر',
  );

  applyOutcomePayload(SESSION_A, { kind: 'permission_cancelled', requestId: 'req-other' });
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcomeState, 'absent');
});

test('إلغاء بلا requestId يحسم طلباً مجهولاً واحداً ولا يبتلع البقية', () => {
  markRunStarted(SESSION_A);
  applyOutcomePayload(SESSION_A, { kind: 'interactive_prompt' });
  applyOutcomePayload(SESSION_A, { kind: 'interactive_prompt' });

  applyOutcomePayload(SESSION_A, { kind: 'permission_cancelled' });
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, 'question');

  applyOutcomePayload(SESSION_A, { kind: 'permission_cancelled' });
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, null);
});

test('id العام ليس requestId: اختلافه لا يمنع عدّ وإلغاء الطلبات المجهولة', () => {
  markRunStarted(SESSION_A);
  applyOutcomePayload(
    SESSION_A,
    { kind: 'interactive_prompt', id: 'message-a' } as Parameters<typeof applyOutcomePayload>[1],
  );
  applyOutcomePayload(
    SESSION_A,
    { kind: 'permission_request', id: 'message-b' } as Parameters<typeof applyOutcomePayload>[1],
  );

  applyOutcomePayload(
    SESSION_A,
    { kind: 'permission_cancelled', id: 'cancel-x' } as Parameters<typeof applyOutcomePayload>[1],
  );
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcomeState, 'visible');

  applyOutcomePayload(
    SESSION_A,
    { kind: 'permission_cancelled', id: 'cancel-y' } as Parameters<typeof applyOutcomePayload>[1],
  );
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcomeState, 'absent');
});

test('الإلغاء الطرفي لا يتحول إلى خطأ عند خمود العملية', () => {
  markRunStarted(SESSION_A);
  applyOutcomePayload(SESSION_A, { kind: 'permission_request' });
  applyOutcomePayload(SESSION_A, { kind: 'complete', aborted: true });
  markRunEnded(SESSION_A);

  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, null);
});

test('B-726: حكم Codex الناجح يسبق الخمود فلا يستبدله unregister بخطأ', () => {
  markRunStarted(SESSION_A);

  // `turn.completed` arrives before Codex's normalized `complete` frame.
  markRunVerdictSeen(SESSION_A);
  markRunEnded(SESSION_A);
  assert.equal(
    sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome,
    null,
    'خمود العملية بعد حكم النجاح اخترع error كاذباً',
  );

  // The one public completion frame remains authoritative for persistence.
  applyOutcomePayload(SESSION_A, { kind: 'complete', provider: 'codex' });
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, 'done');
});

test('B-726: الخمود الحقيقي بلا أي حكم يبقى error', () => {
  markRunStarted(SESSION_A);
  markRunEnded(SESSION_A);

  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, 'error');
});

test('الإقرار والإبطال يغيّران حمولة البث العالمية للنهاية', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'done');
  const initial = sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A);
  assert.equal(initial.outcome, 'done');
  assert.ok(initial.outcomeAt);

  sessionOutcomesDb.markOutcomeSeen(SESSION_A, initial.outcomeAt);
  assert.deepEqual(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A), {
    projectPath: VISIBLE_PATH,
    outcome: null,
    outcomeAt: initial.outcomeAt,
    outcomeState: 'seen',
  });

  sessionOutcomesDb.clearOutcomeSeen(SESSION_A);
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcomeState, 'visible');
});

test('دلتا null تميز seen عن غياب الصف بعد بدء جولة جديدة', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'done');
  const row = sessionOutcomesDb.getOutcomesForSessions([SESSION_A]).get(SESSION_A);
  assert.ok(row);
  sessionOutcomesDb.markOutcomeSeen(SESSION_A, row.outcomeAt);
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcomeState, 'seen');

  markRunStarted(SESSION_A);
  assert.deepEqual(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A), {
    projectPath: VISIBLE_PATH,
    outcome: null,
    outcomeAt: null,
    outcomeState: 'absent',
  });
});

test('CAS: إقرارٌ قديم لا يخفي حكماً أحدث وصل بالتزامن', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'done');
  const oldOutcomeAt = sessionOutcomesDb.getOutcomesForSessions([SESSION_A]).get(SESSION_A)?.outcomeAt;
  assert.ok(oldOutcomeAt);

  sessionOutcomesDb.recordOutcome(SESSION_A, 'error');
  const current = sessionOutcomesDb.getOutcomesForSessions([SESSION_A]).get(SESSION_A);
  assert.ok(current);
  assert.notEqual(current.outcomeAt, oldOutcomeAt);

  assert.equal(sessionOutcomesDb.markOutcomeSeen(SESSION_A, oldOutcomeAt), false);
  assert.equal(sessionOutcomesDb.getOutcomeForBroadcast(SESSION_A).outcome, 'error');
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH]).length, 1);
});

test('السؤال المعلَّق لا يعمّر أطول من عمليته', () => {
  sessionOutcomesDb.recordOutcome(SESSION_A, 'question');
  sessionOutcomesDb.recordOutcome(SESSION_PRIVATE, 'done');

  const cleared = sessionOutcomesDb.clearStaleQuestionOutcomes();

  assert.equal(cleared, 1);
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [VISIBLE_PATH]).length, 0);
  // ما ليس سؤالاً يبقى: التنظيف لا يبتلع الأحكام السليمة.
  assert.equal(sessionOutcomesDb.getUnseenOutcomes(USER_OTHER, [PRIVATE_PATH]).length, 1);
});

test('الترحيل يعبّئ global_seen_at من قراءة legacy للحكم الحالي فقط', () => {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY);
      CREATE TABLE session_run_outcomes (
        session_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL,
        outcome_at DATETIME NOT NULL,
        provider TEXT
      );
      CREATE TABLE session_outcome_reads (
        user_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        seen_at DATETIME NOT NULL,
        PRIMARY KEY (user_id, session_id)
      );
      INSERT INTO users(id) VALUES (1);
      INSERT INTO session_run_outcomes VALUES
        ('done-current', 'done', '2026-08-10 10:00:00.000', 'claude'),
        ('question-current', 'question', '2026-08-10 10:00:00.000', 'claude'),
        ('done-newer', 'done', '2026-08-10 11:00:00.000', 'claude');
      INSERT INTO session_outcome_reads VALUES
        (1, 'done-current', '2026-08-10 10:00:00.000'),
        (1, 'question-current', '2026-08-10 10:00:00.000'),
        (1, 'done-newer', '2026-08-10 10:00:00.000');
    `);

    migrateSessionOutcomes(legacy);

    const rows = legacy.prepare(
      'SELECT session_id, global_seen_at FROM session_run_outcomes ORDER BY session_id'
    ).all() as Array<{ session_id: string; global_seen_at: string | null }>;
    assert.deepEqual(rows, [
      { session_id: 'done-current', global_seen_at: '2026-08-10 10:00:00.000' },
      { session_id: 'done-newer', global_seen_at: null },
      { session_id: 'question-current', global_seen_at: null },
    ]);
  } finally {
    legacy.close();
  }
});
