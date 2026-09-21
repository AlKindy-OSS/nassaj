/**
 * Tests for the per-project logo store (T-1403).
 *
 * The dangerous part of this feature is not the upload: it is that the stored
 * bytes are later served same-origin. So the coverage here is the two decisions
 * that keep that safe, plus the id shape that keeps a path a path:
 *
 *  1. The extension comes from the CONTENT, not the declared type — a file that
 *     claims to be a PNG but is not one never reaches disk.
 *  2. An SVG is sanitized before writing: a hostile document is stored stripped
 *     of <script>/on* handlers, or refused outright.
 *  3. A projectId that is not the DB-minted UUID shape is refused before any
 *     path is built, so `../../etc/x` can never name a file.
 *  4. Replacing a logo removes the file stored under the previous extension —
 *     a leftover would still be resolvable by the serving route.
 *
 * Filesystem isolation: HOME is redirected to a per-run temp dir BEFORE the
 * service is imported, because PROJECT_LOGOS_ROOT derives from os.homedir() at
 * module load. The database index is stubbed (node:test module mocks) so the
 * row write never touches a real store.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-project-logo-test-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const LOGOS_DIR = path.join(TMP_HOME, '.nassaj-users', '.project-logos');

after(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

// Captures what the service persisted on the project row.
const savedLogoUrls = new Map<string, string | null>();

const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../database/index.js'),
).href;

mock.module(dbIndexUrl, {
  namedExports: {
    projectsDb: {
      setProjectLogoUrl: (projectId: string, logoUrl: string | null) => {
        savedLogoUrls.set(projectId, logoUrl);
      },
    },
    initializeDatabase: () => {},
    closeConnection: () => {},
    getConnection: () => ({}),
    getDatabasePath: () => ':memory:',
  },
});

const {
  deleteProjectLogo,
  isSafeProjectLogoId,
  saveProjectLogo,
} = await import('../services/project-logo.service.js');

const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngFixture = () => Buffer.concat([PNG_MAGIC, Buffer.alloc(32, 0)]);

const CLEAN_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/></svg>',
  'utf8',
);
const HOSTILE_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>',
  'utf8',
);

test('a real PNG is stored and its public URL carries a cache-busting token', async () => {
  const logoUrl = await saveProjectLogo(PROJECT_ID, pngFixture());

  assert.match(logoUrl, new RegExp(`^/project-logos/${PROJECT_ID}\\.png\\?v=\\d+$`));
  assert.equal(savedLogoUrls.get(PROJECT_ID), logoUrl);
  assert.ok(fs.existsSync(path.join(LOGOS_DIR, `${PROJECT_ID}.png`)));
});

test('replacing a PNG with an SVG removes the file under the old extension', async () => {
  await saveProjectLogo(PROJECT_ID, pngFixture());
  const logoUrl = await saveProjectLogo(PROJECT_ID, CLEAN_SVG);

  assert.match(logoUrl, /\.svg\?v=\d+$/);
  assert.equal(fs.existsSync(path.join(LOGOS_DIR, `${PROJECT_ID}.png`)), false);
  assert.ok(fs.existsSync(path.join(LOGOS_DIR, `${PROJECT_ID}.svg`)));
});

test('a hostile SVG is stored sanitized — no <script>, no on* handler', async () => {
  await saveProjectLogo(PROJECT_ID, HOSTILE_SVG);

  const stored = fs.readFileSync(path.join(LOGOS_DIR, `${PROJECT_ID}.svg`), 'utf8');
  assert.equal(/<script/i.test(stored), false);
  assert.equal(/onload/i.test(stored), false);
});

test('content that is not an allowed image is refused before any disk write', async () => {
  const otherId = '99999999-8888-7777-6666-555555555555';
  await assert.rejects(
    () => saveProjectLogo(otherId, Buffer.from('<html><body>not an image</body></html>', 'utf8')),
    /Unsupported image type/,
  );
  assert.equal(fs.existsSync(path.join(LOGOS_DIR, `${otherId}.png`)), false);
  assert.equal(savedLogoUrls.has(otherId), false);
});

test('bytes that lie about their format (PNG name, HTML content) are refused', async () => {
  await assert.rejects(
    () => saveProjectLogo(PROJECT_ID, Buffer.from('GIF89a-not-really', 'utf8')),
    /Unsupported image type/,
  );
});

test('a projectId outside the minted UUID shape is refused, never used as a path', async () => {
  for (const badId of ['../../etc/passwd', '', 'x'.repeat(40), 'not-a-uuid']) {
    assert.equal(isSafeProjectLogoId(badId), false);
    await assert.rejects(() => saveProjectLogo(badId, pngFixture()), /Project not found/);
    await assert.rejects(() => deleteProjectLogo(badId), /Project not found/);
  }
  assert.equal(isSafeProjectLogoId(PROJECT_ID), true);
});

test('deleting removes every stored extension and clears the row value', async () => {
  await saveProjectLogo(PROJECT_ID, pngFixture());
  await deleteProjectLogo(PROJECT_ID);

  assert.equal(fs.existsSync(path.join(LOGOS_DIR, `${PROJECT_ID}.png`)), false);
  assert.equal(fs.existsSync(path.join(LOGOS_DIR, `${PROJECT_ID}.svg`)), false);
  assert.equal(savedLogoUrls.get(PROJECT_ID), null);
});
