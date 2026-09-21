/**
 * auth-status-isolation.test.ts — B-587.
 *
 * بطاقةُ الحساب تسأل «هل أنا موصول؟»، والجواب يجب أن يخصّ **صاحب السؤال**. وكان
 * مزوّدان يجيبان عن المشغّل: `gemini` يقرأ `os.homedir()` مباشرةً، و`cursor`
 * يُطلق `cursor-agent status` بلا بيئةٍ فيرث بيئة الخادم. فكان كلُّ عضوٍ يرى
 * اعتماد المشغّل في منتجٍ متعدّد المستخدمين.
 *
 * والحارسُ هنا يمسك النكوص: يمرّ بمعرِّفَي عضوَين ويؤكّد **اختلاف الشجرة
 * المقروءة**. فمن أضاف مزوّداً ونسي `userId` يسقط عليه اختبارٌ لا مراجعةُ عين.
 *
 * `userId == null` يبقى على بيت المشغّل عمداً — لا احتياطاً صامتاً بل عقداً:
 * `resolveProviderEnv` تُعيد البيئة الأساسية بلا تغيير للفحص المجهول.
 *
 * Runner: node:test + node:assert/strict عبر tsx.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-isolation-b587-'));
const ORIGINAL_DB = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

/** آخرُ بيئةٍ مرّت إلى spawn — الشاهدُ على أن الفحص جرى في شجرة العضو. */
let lastSpawnEnv: NodeJS.ProcessEnv | undefined;

mock.module('cross-spawn', {
  defaultExport: (_cmd: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    lastSpawnEnv = options?.env;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; kill(): void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('Logged in as member@example.com\n'));
      child.emit('close', 0);
    });
    return child;
  },
});

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
initializeDatabase();

const { GeminiProviderAuth } = await import('./gemini/gemini-auth.provider.js');
const { CursorProviderAuth } = await import('./cursor/cursor-auth.provider.js');

type HomeReader = { getGeminiCliHome(userId?: string | number | null): string };
type LoginProbe = { checkCursorLogin(userId?: string | number | null): Promise<unknown> };

const gemini = new GeminiProviderAuth() as unknown as HomeReader;
const cursor = new CursorProviderAuth() as unknown as LoginProbe;

after(() => {
  try { closeConnection(); } catch { /* already closed */ }
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('B-587: gemini status reads each member own tree', () => {
  const first = gemini.getGeminiCliHome(1);
  const second = gemini.getGeminiCliHome(2);

  assert.notEqual(first, second, 'two members must not share one credential tree');
  assert.match(first, /nassaj-users[/\\]1$/, 'member 1 must resolve under their own root');
  assert.match(second, /nassaj-users[/\\]2$/, 'member 2 must resolve under their own root');
});

test('B-587: gemini keeps the operator home for an anonymous probe', () => {
  assert.equal(
    gemini.getGeminiCliHome(null),
    os.homedir(),
    'a null userId is the shared/anonymous contract, not a silent fallback',
  );
  assert.equal(gemini.getGeminiCliHome(), os.homedir(), 'omitted userId behaves as null');
});

test('B-587: cursor probes each member under their own HOME', async () => {
  await cursor.checkCursorLogin(1);
  const first = lastSpawnEnv?.HOME;
  await cursor.checkCursorLogin(2);
  const second = lastSpawnEnv?.HOME;

  assert.ok(first && second, 'the probe must pass an env, never inherit the server one');
  assert.notEqual(first, second, 'cursor-agent must not read one login for every member');
  assert.match(first!, /nassaj-users[/\\]1$/);
  assert.match(second!, /nassaj-users[/\\]2$/);
});

test('B-587: cursor keeps the operator env for an anonymous probe', async () => {
  await cursor.checkCursorLogin(null);
  assert.equal(lastSpawnEnv?.HOME, process.env.HOME, 'null userId keeps the base env');
});

/*
 * B-580 — the agy token reader had no userId parameter at all, so every
 * member's catalog fetch spent the OPERATOR's token: their catalog, their quota.
 * The parameter is positionally required now, which is what stops the next
 * reader from quietly inheriting the operator's tree again.
 */
const { getAntigravityTokenPath } = await import('./antigravity/antigravity-token-reader.js');

test('B-580: the agy token path is per member', () => {
  const first = getAntigravityTokenPath(1);
  const second = getAntigravityTokenPath(2);

  assert.notEqual(first, second, 'two members must not share one agy token');
  assert.match(first, /nassaj-users[/\\]1[/\\]/, 'member 1 resolves under their own root');
  assert.match(second, /nassaj-users[/\\]2[/\\]/, 'member 2 resolves under their own root');
  assert.match(first, /antigravity-oauth-token$/, 'the file itself must not move');
});

test('B-580: a null userId still means the operator, explicitly', () => {
  assert.ok(
    getAntigravityTokenPath(null).startsWith(os.homedir()),
    'null is the stated operator contract — but the caller now has to state it',
  );
});
