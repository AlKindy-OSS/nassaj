/**
 * نسبة الاستهلاك إلى مستخدم داخل المحادثة الواحدة (`usage-attribution.ts`).
 *
 * الحادثة التي وُلد منها هذا الملف مقيسة على الإنتاج (2026-07-31)، وأرقامها
 * أدناه **منقولة من قاعدة الإنتاج ومن السجلّ الفعلي** لا مؤلَّفة:
 *
 *   المحادثة  155a0ecd…  على مفتاح كيمي واحد يتقاسمه مستخدمان.
 *   ‏Nawras ‏(user 1، مالك) — خمس مطالبات، 23:09:45 … 23:40:15.
 *   ‏Jazari ‏(user 2، مشارك) — مطالبتان،  23:46:33 و23:50:37.
 *   وآخر طلب كيمي في المحادثة كان 23:41:57 — أي **قبل دخول Jazari بخمس دقائق**.
 *
 * كان نسّاج يعرض لـJazari ‏$2.49 من كيمي واستهلاكه الحقيقي **صفر**، لأن النطاق
 * كان على مستوى المحادثة: من يشارك يُحمَّل مجموعها كاملاً. والاختبار الأول
 * أدناه هو هذه الحادثة حرفياً، فلا يمكن أن تعود دون أن يحمرّ.
 *
 * ولأن المُستخرِج يُغذّى سطراً سطراً، تُختبر النسبة عبر `ClaudeUsageAccumulator`
 * نفسه لا عبر المرشِّح وحده: المرشِّح صحيحٌ ومعطَّلٌ في مكان الاستدعاء عطبٌ
 * كامل، وهو بالضبط نمط «الحارس الأمني كودٌ ميّت».
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';

import { buildSessionAttribution } from './usage-attribution.js';
import { ClaudeUsageAccumulator } from './usage-extractors.js';

const SESSION = '00000001-0000-4000-8000-000000000001';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'usage-attribution-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
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

function seedSession(sessionId: string): void {
  sessionsDb.createSession(sessionId, 'kimi', `/tmp/proj-${sessionId}`);
}

function addParticipant(sessionId: string, userId: number, role: 'owner' | 'participant'): void {
  getConnection()
    .prepare('INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, ?)')
    .run(sessionId, userId, role);
}

function addPrompt(sessionId: string, userId: number, createdAt: string): void {
  getConnection()
    .prepare('INSERT INTO message_authors (session_id, user_id, content_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, userId, `h-${createdAt}-${userId}`, createdAt);
}

/** سطر `assistant` بشكل سجلّ كلود الحقيقي (كيمي يمرّ بنفس الصيغة). */
function assistantLine(timestamp: string, id: string, outputTokens: number): unknown {
  return {
    type: 'assistant',
    timestamp,
    requestId: `req-${id}`,
    message: {
      id,
      model: 'kimi-k3',
      usage: {
        input_tokens: 1000,
        output_tokens: outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

const outputFor = (accumulator: ClaudeUsageAccumulator): number =>
  accumulator.result('kimi').perModel.reduce((sum, entry) => sum + entry.totals.output, 0);

test('الحادثة: مشارك دخل بعد انتهاء الإنفاق لا يُحمَّل منه شيئاً', async () => {
  await withIsolatedDatabase(() => {
    const nawras = userDb.createUser('Nawras', 'hash', 'user');
    const jazari = userDb.createUser('Jazari', 'hash', 'user');

    seedSession(SESSION);
    addParticipant(SESSION, nawras.id, 'owner');
    addParticipant(SESSION, jazari.id, 'participant');

    // مطالبات Nawras الخمس، ثم مطالبتا Jazari بعد آخر طلب كيمي.
    for (const at of [
      '2026-07-30T23:09:45.785Z',
      '2026-07-30T23:10:46.630Z',
      '2026-07-30T23:11:19.245Z',
      '2026-07-30T23:13:33.075Z',
      '2026-07-30T23:40:15.491Z',
    ]) {
      addPrompt(SESSION, nawras.id, at);
    }
    addPrompt(SESSION, jazari.id, '2026-07-30T23:46:33.423Z');
    addPrompt(SESSION, jazari.id, '2026-07-30T23:50:37.252Z');

    // كل الاستهلاك وقع بين 23:09:53 و23:41:57 — قبل دخول Jazari.
    const usage = [
      assistantLine('2026-07-30T23:09:53.417Z', 'm1', 720),
      assistantLine('2026-07-30T23:13:56.743Z', 'm2', 449),
      assistantLine('2026-07-30T23:41:57.208Z', 'm3', 313),
    ];

    const forNawras = new ClaudeUsageAccumulator(
      undefined,
      buildSessionAttribution(SESSION, nawras.id) ?? undefined,
    );
    const forJazari = new ClaudeUsageAccumulator(
      undefined,
      buildSessionAttribution(SESSION, jazari.id) ?? undefined,
    );
    for (const line of usage) {
      forNawras.addEntry(line);
      forJazari.addEntry(line);
    }

    assert.equal(outputFor(forNawras), 720 + 449 + 313);
    // الرقم الذي كان يُعرض $2.49 وحقيقته صفر.
    assert.equal(outputFor(forJazari), 0);
    assert.deepEqual(forJazari.result('kimi').perModel, []);
  });
});

test('لا ازدواج: مجموع المنسوب لكل المستخدمين = مجموع المحادثة، لا أكثر', async () => {
  await withIsolatedDatabase(() => {
    const a = userDb.createUser('a', 'hash', 'user');
    const b = userDb.createUser('b', 'hash', 'user');

    seedSession('s-shared');
    addParticipant('s-shared', a.id, 'owner');
    addParticipant('s-shared', b.id, 'participant');
    addPrompt('s-shared', a.id, '2026-07-30T10:00:00.000Z');
    addPrompt('s-shared', b.id, '2026-07-30T12:00:00.000Z');

    const usage = [
      assistantLine('2026-07-30T10:00:05.000Z', 'x1', 100), // ← a
      assistantLine('2026-07-30T11:59:59.000Z', 'x2', 200), // ← a (قبل مطالبة b بثانية)
      assistantLine('2026-07-30T12:00:01.000Z', 'x3', 400), // ← b
    ];

    const totals = [a.id, b.id].map((id) => {
      const accumulator = new ClaudeUsageAccumulator(
        undefined,
        buildSessionAttribution('s-shared', id) ?? undefined,
      );
      for (const line of usage) {
        accumulator.addEntry(line);
      }
      return outputFor(accumulator);
    });

    assert.deepEqual(totals, [300, 400]);
    // القسمة تامّة: لا توكن يُحسب مرّتين ولا توكن يسقط.
    assert.equal(totals[0] + totals[1], 700);
  });
});

test('ما قبل أول مطالبة مسجَّلة يذهب للمالك لا إلى العدم', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('owner', 'hash', 'user');
    const guest = userDb.createUser('guest', 'hash', 'user');

    seedSession('s-legacy');
    addParticipant('s-legacy', owner.id, 'owner');
    addParticipant('s-legacy', guest.id, 'participant');
    addPrompt('s-legacy', guest.id, '2026-07-30T15:00:00.000Z');

    const early = assistantLine('2026-07-30T09:00:00.000Z', 'e1', 500);

    const forOwner = new ClaudeUsageAccumulator(
      undefined,
      buildSessionAttribution('s-legacy', owner.id) ?? undefined,
    );
    const forGuest = new ClaudeUsageAccumulator(
      undefined,
      buildSessionAttribution('s-legacy', guest.id) ?? undefined,
    );
    forOwner.addEntry(early);
    forGuest.addEntry(early);

    assert.equal(outputFor(forOwner), 500);
    assert.equal(outputFor(forGuest), 0);
  });
});

test('محادثة بلا صفوف مؤلِّفين (قُيدت من الطرفية) تُنسب كاملةً للمالك', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('owner', 'hash', 'user');
    const other = userDb.createUser('other', 'hash', 'user');

    seedSession('s-cli');
    addParticipant('s-cli', owner.id, 'owner');

    const line = assistantLine('2026-07-30T09:00:00.000Z', 'c1', 42);

    const forOwner = new ClaudeUsageAccumulator(
      undefined,
      buildSessionAttribution('s-cli', owner.id) ?? undefined,
    );
    const forOther = new ClaudeUsageAccumulator(
      undefined,
      buildSessionAttribution('s-cli', other.id) ?? undefined,
    );
    forOwner.addEntry(line);
    forOther.addEntry(line);

    assert.equal(outputFor(forOwner), 42);
    assert.equal(outputFor(forOther), 0);
  });
});

test('غياب هوية المستخدم = لا نسبة (تُحسب المحادثة كاملةً) لا نسبة فارغة', async () => {
  await withIsolatedDatabase(() => {
    seedSession('s-anon');
    assert.equal(buildSessionAttribution('s-anon', null), null);
    assert.equal(buildSessionAttribution('s-anon', Number.NaN), null);
    assert.equal(buildSessionAttribution('s-anon', 1.5), null);
  });
});

test('النسبة تسبق إزالة التكرار: سطر لغير المستخدم لا يبتلع دوراً حقيقياً', async () => {
  await withIsolatedDatabase(() => {
    const a = userDb.createUser('a', 'hash', 'user');
    const b = userDb.createUser('b', 'hash', 'user');

    seedSession('s-dupe');
    addParticipant('s-dupe', a.id, 'owner');
    addParticipant('s-dupe', b.id, 'participant');
    addPrompt('s-dupe', a.id, '2026-07-30T10:00:00.000Z');
    addPrompt('s-dupe', b.id, '2026-07-30T11:00:00.000Z');

    // كلود يكرّر السطر لكل كتلة محتوى، والأخير يحمل المخرجات الكاملة.
    const forB = new ClaudeUsageAccumulator(
      undefined,
      buildSessionAttribution('s-dupe', b.id) ?? undefined,
    );
    forB.addEntry(assistantLine('2026-07-30T10:30:00.000Z', 'dup', 5)); // ← a، يُرفض
    forB.addEntry(assistantLine('2026-07-30T11:30:00.000Z', 'dup', 5)); // ← b
    forB.addEntry(assistantLine('2026-07-30T11:30:01.000Z', 'dup', 535)); // ← b، الكامل

    assert.equal(outputFor(forB), 535);
  });
});
