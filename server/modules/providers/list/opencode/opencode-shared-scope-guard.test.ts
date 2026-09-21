/**
 * T-1043 — «حظر اشتقاق الاعتماد إلى ملف جسد مشترك» (شرط legal-compliance-advisor ١، ADR-076).
 *
 * اختبار القبول منصوص في البند حرفياً: مفتاح glm لعضو + سياسة opencode=shared
 * ⇒ ملف المُشغّل لم يُكتَب. الاختبار يقيس الملف على القرص، لا استدعاء الحارس —
 * لأن العطل الذي يمنعه ليس رميَ خطأ بل بايتات تصل ملفاً يقرؤه الفريق.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';


import { _resetProviderSharingCache } from '@/services/provider-sharing.js';
import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

import { OpenCodeCredentialsWriter } from './opencode-credentials.writer.js';

/** يضبط سياسة المشاركة في app_config كما تفعل واجهة المشغّل. */
function setSharingPolicy(policy: Record<string, 'shared' | 'isolated'>): void {
  getConnection()
    .prepare("INSERT INTO app_config (key, value) VALUES ('provider_sharing', ?) "
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(JSON.stringify(policy));
  _resetProviderSharingCache();
}

async function withSandbox(run: (dataHome: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1043-'));
  const prevXdg = process.env.XDG_DATA_HOME;
  const prevDb = process.env.DATABASE_PATH;
  closeConnection();
  process.env.XDG_DATA_HOME = dir;
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await run(dir);
  } finally {
    closeConnection();
    _resetProviderSharingCache();
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('T-1043: مفتاح عضو + opencode مشترك ⇒ ملف المُشغّل لم يُكتَب', async () => {
  await withSandbox(async (dataHome) => {
    setSharingPolicy({ opencode: 'shared' });
    const operatorAuth = path.join(dataHome, 'opencode', 'auth.json');

    await assert.rejects(
      () => new OpenCodeCredentialsWriter().setApiKey(7, 'sk-member-secret', 'glm'),
      (error: { code?: string; statusCode?: number }) => {
        assert.equal(error.code, 'CREDENTIAL_SHARED_SCOPE_REFUSED');
        assert.equal(error.statusCode, 409);
        return true;
      },
    );

    // الحكم الحقيقي: القرص. الرمي وحده لا يثبت أن شيئاً لم يُكتب قبله.
    assert.equal(fs.existsSync(operatorAuth), false, 'ملف المُشغّل لم يُنشأ');
  });
});

test('T-1043: نفس الكتابة تنجح متى كان opencode معزولاً', async () => {
  await withSandbox(async () => {
    setSharingPolicy({ opencode: 'isolated' });

    const result = await new OpenCodeCredentialsWriter().setApiKey(7, 'sk-member-secret', 'glm');

    assert.equal(result.configured, true);
  });
});

test('T-1043: كتابة المُشغّل نفسه (بلا هوية عضو) تبقى مسموحة في الوضع المشترك', async () => {
  await withSandbox(async (dataHome) => {
    setSharingPolicy({ opencode: 'shared' });

    // هذه هي الكتابة المقصودة على نطاق المشغّل — الحارس يمنع تسريب مفتاح فرد،
    // لا يمنع المشغّل من ضبط مفتاح مؤسسة بقصد.
    const result = await new OpenCodeCredentialsWriter().setApiKey(null, 'sk-operator', 'glm');

    assert.equal(result.configured, true);
    assert.equal(fs.existsSync(path.join(dataHome, 'opencode', 'auth.json')), true);
  });
});

test('T-1043: مفتاح كُتب تحت العزل يصير غير مرئي بعد التحوّل إلى المشاركة (B-462)', async () => {
  await withSandbox(async (dataHome) => {
    setSharingPolicy({ opencode: 'isolated' });
    const writer = new OpenCodeCredentialsWriter();
    await writer.setApiKey(7, 'sk-legacy', 'glm');
    assert.equal(await writer.isConfigured(7, 'glm'), true, 'مرئي تحت العزل');

    setSharingPolicy({ opencode: 'shared' });

    // السلوك القائم — سابقٌ لحارس T-1043 ولا يُحدثه: حلّ المسار نفسه يتبع
    // السياسة، فبعد التحوّل تشير القراءة إلى دليل المُشغّل لا إلى دليل العضو،
    // فيغيب المفتاح عن صاحبه. لا تسريب (الـspawn يقرأ دليل المُشغّل أيضاً) لكنه
    // يترك سرّاً يتيماً على القرص لا تبلغه الواجهة. مسجَّل B-462.
    assert.equal(
      await writer.isConfigured(7, 'glm'),
      false,
      'يغيب عن صاحبه بعد التحوّل — وهذا ما يوثّقه B-462',
    );
    assert.equal(
      fs.existsSync(path.join(dataHome, 'opencode', 'auth.json')),
      false,
      'ولم يُنسخ إلى ملف المُشغّل — لا تسريب',
    );
  });
});
