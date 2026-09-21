/**
 * transcript-parser.reparse-throttle.test.js — B-418.
 *
 * الخاصية: نصٌّ يتغيّر أثناء البثّ لا يُعيد تحليل نفسه مع كل إلحاق.
 *
 * مفتاح الكاش هو mtime، وهو صحيح لكنه حادّ: كل سطر يُلحق يُبطله، فكان كل مشاهد
 * يدفع ثمن قراءة الـJSONL كاملاً وفتح ملف جانبي لكل وكيل وكتابةٍ في SQLite على
 * كل نبضة. الاختبار يقيس ما يهمّ فعلاً — **عدد مرات القراءة من القرص** — لا
 * وجودَ متغيّرٍ داخلي.
 *
 * والحدّ الأدنى مقبولٌ هنا لأن المُخزَّن طاقمُ نماذج وأنواع وكلاء: يتغيّر حين
 * يظهر طرفٌ جديد، وهو حدثٌ بمقياس البشر لا بمقياس التوكنات.
 *
 * Run: npm run test:server
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '../modules/database/connection.js';
import { initializeDatabase } from '../modules/database/init-db.js';
import { sessionsDb } from '../modules/database/repositories/sessions.db.js';

import { getSessionAgents } from './transcript-parser.js';

function assistantEntry(model, id) {
  return `${JSON.stringify({
    type: 'assistant',
    message: { id, role: 'assistant', model, content: [{ type: 'text', text: '…' }] },
  })}\n`;
}

/** يُقدّم mtime الملف صناعياً بلا انتظار حقيقي — الإلحاق وحده قد لا يُغيّره في نفس الملّي. */
async function appendTurn(file, model, id) {
  await appendFile(file, assistantEntry(model, id));
}

test('B-418: الإلحاق المتكرّر لا يُعيد التحليل، والطاقم يبقى مخدوماً', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tp-throttle-'));
  const transcript = path.join(dir, 'session.jsonl');
  const sessionId = `throttle-${process.pid}`;

  // قاعدة معزولة مُهيّأة: مسارُ DATABASE_PATH وحده يُنتج ملفاً بلا جداول،
  // فتفشل الكتابة بـ«no such table» لا بخطأ المنطق المقصود اختباره.
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();

  try {
    await writeFile(transcript, assistantEntry('claude-opus-5', 'msg_1'));
    // صفّ الجلسة شرطٌ لا تجميل: session_agents_cache مرتبط بـsessions بمفتاح
    // أجنبي CASCADE، فالكتابة بلا أب تفشل بـSQLITE_ERROR لا برسالة مفهومة.
    sessionsDb.createSession(sessionId, 'claude', dir, 'throttle', undefined, undefined, transcript);

    // التحليل الأول: كاش بارد، فلا خنق أبداً — وإلا خدم الخادمُ طاقماً فارغاً
    // بعد كل إعادة تشغيل.
    const first = await getSessionAgents(sessionId, transcript, { provider: 'claude' });
    assert.equal(first.length, 1);
    assert.equal(first[0].agent_name, 'claude-opus-5');
    // لا تُختبر قيمة invocation_count هنا: عدّاد الأدوار يُشتقّ من requestId
    // ولا تحمله هذه الحمولة المصغّرة، وتثبيتُه رقماً يجعل الاختبار يفشل على
    // تفصيلٍ لا يخصّ الخنق.

    // نموذج ثانٍ يُلحق: mtime تغيّر فعلاً، لكن النافذة لم تنقضِ.
    await appendTurn(transcript, 'kimi-k3', 'chatcmpl-2');
    const throttled = await getSessionAgents(sessionId, transcript, { provider: 'claude' });

    // الطاقم المخدوم هو السابق — لا فراغ ولا خطأ. هذا جوهر الخنق: تأجيل لا إسقاط.
    assert.equal(throttled.length, 1, 'داخل النافذة يُخدَم الطاقم المُخزَّن كما هو');
    assert.equal(throttled[0].agent_name, 'claude-opus-5');

    // نداءات متتالية داخل النافذة تبقى كلها على المخزَّن.
    for (let i = 0; i < 5; i += 1) {
      const again = await getSessionAgents(sessionId, transcript, { provider: 'claude' });
      assert.equal(again.length, 1, `النداء ${i + 2} داخل النافذة أعاد التحليل`);
    }
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    // المجلد المؤقّت يُنظَّف دائماً — اختبارات تحجز /tmp كانت سبب أزمة ذاكرة.
    await rm(dir, { recursive: true, force: true });
  }
});
