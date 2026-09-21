/**
 * claude-usage.credential-write.test.ts — B-579.
 *
 * يُثبّت الحارسين اللذين يمنعان أن يُخرج نسّاجُ عضواً من اعتماده:
 *
 *  1. **تجديدٌ واحدٌ في الطيران لكل ملف.** تبادلُ توكن التحديث يُدوِّره — الخادم
 *     يُعيد توكناً جديداً ويُبطل سلفه. فطلبان متزامنان (الهيدر والشريط الجانبي
 *     يطلبان الاستهلاك معاً) يتبادلان نفس التوكن مرّتين، فيُبطل الثاني ما ظفر به
 *     الأول ⇒ `invalid_grant` وخروجٌ يوجب `/login` يدوياً.
 *  2. **كتابةٌ ذرّيةٌ مشروطة.** الـCLI يملك هذا الملف ويكتبه استبدالاً ذرّياً؛
 *     فالكتابةُ في المكان كانت تدهس توكناً أحدثَ منه، والمدهوسُ صالحٌ فيصير ما
 *     على القرص مُبطَلاً.
 *
 * الدالّتان خاصّتان — تُبلغان عبر الحقل `as never` عمداً: العقدُ المُختبَر سلوكُ
 * الملف على القرص لا سطحُ الصنف العام.
 *
 * Runner: node:test + node:assert/strict عبر tsx.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-b579-'));
const ORIGINAL_DB = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

/**
 * حقنُ لحظةِ السباق. الخدمة تستورد `readFile` بالاسم من `node:fs/promises`، ورَبْطُ
 * ESM لا يُبدَّل بتعديل `fs.promises` — فالتغليف هنا عند حدود الوحدة، وهو الموضع
 * الوحيد الذي يبلغ المُستورِد. ويُنصَّب قبل استيراد الخدمة كي يلتقطه رَبْطُها.
 */
const realFsPromises = await import('node:fs/promises');
let afterRead: (() => void) | null = null;
mock.module('node:fs/promises', {
  namedExports: {
    ...realFsPromises,
    readFile: async (...args: Parameters<typeof realFsPromises.readFile>) => {
      const result = await realFsPromises.readFile(...args);
      const hook = afterRead;
      afterRead = null;
      hook?.();
      return result;
    },
  },
});

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
initializeDatabase();

const { claudeUsageService } = await import('./claude-usage.service.js');
const service = claudeUsageService as unknown as {
  persistRefreshedCredential(credPath: string, update: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number | null;
    refreshTokenExpiresAt?: number | null;
  }): Promise<void>;
  refreshAccessToken(credPath: string, credential: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
  }): Promise<unknown>;
};

const ORIGINAL_FETCH = globalThis.fetch;

after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  try { closeConnection(); } catch { /* already closed */ }
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Writes a credentials file and returns its path. Fixture tokens, not secrets. */
function makeCredFile(name: string, oauth: Record<string, unknown>): string {
  const p = path.join(sandbox, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify({ keepMe: 'untouched', claudeAiOauth: oauth }, null, 2));
  return p;
}

const readOauth = (p: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(p, 'utf8')).claudeAiOauth;

test('B-579: the write is atomic and leaves no temp file behind', async () => {
  const p = makeCredFile('atomic', { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1 });

  await service.persistRefreshedCredential(p, {
    accessToken: 'new', refreshToken: 'rt-new', expiresAt: 2, refreshTokenExpiresAt: 3,
  });

  const oauth = readOauth(p);
  assert.equal(oauth.accessToken, 'new');
  assert.equal(oauth.refreshToken, 'rt-new');
  assert.equal(oauth.expiresAt, 2);
  assert.equal(oauth.refreshTokenExpiresAt, 3, 'B-578: the link stamp must be written too');
  assert.equal(
    JSON.parse(fs.readFileSync(p, 'utf8')).keepMe,
    'untouched',
    'unrelated fields on the file must survive the rewrite',
  );
  assert.equal(
    fs.readdirSync(sandbox).some((f) => f.includes('.tmp')),
    false,
    'the temp file must be renamed away, never left in the credential tree',
  );
});

test('B-579: a file rotated by the CLI mid-flight is NOT overwritten', async () => {
  const p = makeCredFile('raced', { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1 });

  // Stand in for the provider CLI winning the race: it rewrites the file after
  // we read it but before we rename ours in. Overwriting here would put an
  // ALREADY-INVALIDATED refresh token on disk and lock the member out.
  afterRead = () => {
    const rotated = JSON.stringify({
      claudeAiOauth: { accessToken: 'cli-newer', refreshToken: 'rt-cli', expiresAt: 99 },
    }, null, 2);
    fs.writeFileSync(p, rotated);
    // mtime has 1ms resolution on some filesystems; force a distinct stamp so
    // the guard is exercised rather than accidentally passing on equal times.
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(p, future, future);
  };

  await service.persistRefreshedCredential(p, {
    accessToken: 'ours', refreshToken: 'rt-ours', expiresAt: 2,
  });

  assert.equal(readOauth(p).accessToken, 'cli-newer', "the CLI's newer token must survive");
  assert.equal(
    fs.readdirSync(sandbox).some((f) => f.includes('.tmp')),
    false,
    'a skipped write must not leave a temp file either',
  );
});

test('B-579: concurrent refreshes exchange the rotating token exactly once', async () => {
  const p = makeCredFile('single', { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1 });

  let exchanges = 0;
  globalThis.fetch = (async () => {
    exchanges += 1;
    // Mimic rotation: a NEW refresh token comes back, invalidating the sent one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ok: true,
      json: async () => ({
        access_token: 'fresh', refresh_token: 'rt-rotated', expires_in: 28800,
      }),
    } as unknown as Response;
  }) as typeof fetch;

  const credential = { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1 };
  const [a, b] = await Promise.all([
    service.refreshAccessToken(p, credential),
    service.refreshAccessToken(p, credential),
  ]);

  assert.equal(exchanges, 1, 'a second exchange would invalidate the first result');
  assert.deepEqual(a, b, 'both callers must receive the same credential object');
  assert.equal(readOauth(p).refreshToken, 'rt-rotated', 'the rotated token must reach disk');
});

test('B-579: the in-flight entry clears, so a later refresh still runs', async () => {
  const p = makeCredFile('sequential', { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1 });

  let exchanges = 0;
  globalThis.fetch = (async () => {
    exchanges += 1;
    return {
      ok: true,
      json: async () => ({ access_token: `fresh-${exchanges}`, expires_in: 28800 }),
    } as unknown as Response;
  }) as typeof fetch;

  const credential = { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1 };
  await service.refreshAccessToken(p, credential);
  await service.refreshAccessToken(p, credential);

  assert.equal(exchanges, 2, 'de-duplication must not turn into a permanent cache');
});

test('B-579: a rejected refresh clears the in-flight entry too', async () => {
  const p = makeCredFile('rejects', { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1 });

  let exchanges = 0;
  globalThis.fetch = (async () => {
    exchanges += 1;
    return { ok: false, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch;

  const credential = { accessToken: 'old', refreshToken: 'rt-old', expiresAt: 1 };
  await assert.rejects(() => service.refreshAccessToken(p, credential));
  await assert.rejects(() => service.refreshAccessToken(p, credential));

  assert.equal(exchanges, 2, 'a failed exchange must not wedge the map and block retries');
});
