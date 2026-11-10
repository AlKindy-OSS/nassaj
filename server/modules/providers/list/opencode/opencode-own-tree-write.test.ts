/**
 * T-1043 بعد ADR-152 A1 (T-2083) — مفتاح opencode يُكتب دائماً في شجرة صاحبه.
 *
 * شرط legal-compliance-advisor ١ (ADR-076) كان: مفتاح عضو + opencode مشترك ⇒ ملف
 * المُشغّل لم يُكتَب. أُلغيت سياسة المشاركة، فصار الشرط أقوى: كل كتابة تذهب إلى
 * شجرة الطالب نفسه، أيّاً كان دوره، ولا كتابة تصل ملف المُشغّل. والحكم هو القرص،
 * لا قيمة الإرجاع.
 *
 * T-1043 after ADR-152 A1: every opencode key write lands in the requester's own
 * tree, whatever their role; nothing reaches the operator's auth.json.
 */

// B-1771: FIRST import. Run ad hoc with the operator HOME, this test wrote into
// the real home (member tree or provider state); the sandbox moves HOME first.
import '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { userConfigDir } from '@/services/isolation/provision-user-dirs.js';

import { OpenCodeCredentialsWriter } from './opencode-credentials.writer.js';

async function withSandbox(run: (operatorDataHome: string) => Promise<void>): Promise<void> {
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
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ownAuth = (userId: number) => path.join(userConfigDir(userId, path.join('.local', 'share', 'opencode')), 'auth.json');

test('T-1043 / ADR-152 A1: مفتاح عضو يُكتب في شجرته وملف المُشغّل لم يُكتَب', async () => {
  await withSandbox(async (operatorDataHome) => {
    const result = await new OpenCodeCredentialsWriter().setApiKey(7, 'sk-member-secret', 'glm');

    assert.equal(result.configured, true);
    assert.equal(JSON.parse(fs.readFileSync(ownAuth(7), 'utf8')).glm.key, 'sk-member-secret');
    assert.equal(fs.existsSync(path.join(operatorDataHome, 'opencode', 'auth.json')), false, 'ملف المُشغّل لم يُنشأ');
  });
});

test('ADR-152 A1 condition 2: لا رفض 409 بحسب الدور ولا سياسة — المفتاح يُكتب ويُقرأ ويُحذف في الشجرة نفسها', async () => {
  await withSandbox(async (operatorDataHome) => {
    const writer = new OpenCodeCredentialsWriter();
    await writer.setApiKey(8, 'sk-own', 'glm');
    assert.equal(await writer.isConfigured(8, 'glm'), true);
    await writer.deleteApiKey(8, 'glm');
    assert.equal(await writer.isConfigured(8, 'glm'), false);
    assert.equal(fs.existsSync(path.join(operatorDataHome, 'opencode', 'auth.json')), false);
  });
});

test('ADR-152 A1 condition 2: two writers never share a file (an admin\'s key is the admin\'s alone)', async () => {
  await withSandbox(async (operatorDataHome) => {
    const writer = new OpenCodeCredentialsWriter();
    await writer.setApiKey(21, 'sk-admin', 'glm');
    await writer.setApiKey(22, 'sk-member', 'glm');

    assert.equal(JSON.parse(fs.readFileSync(ownAuth(21), 'utf8')).glm.key, 'sk-admin');
    assert.equal(JSON.parse(fs.readFileSync(ownAuth(22), 'utf8')).glm.key, 'sk-member');
    assert.equal(fs.existsSync(path.join(operatorDataHome, 'opencode', 'auth.json')), false);
  });
});
