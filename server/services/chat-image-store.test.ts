import { describe, it, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// The store derives its root from DATABASE_PATH, so it is pointed at a sandbox
// before the module is imported — otherwise the test would write beside the
// live application database.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-image-store-test-'));
const ORIGINAL_DB = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');

const {
  saveChatImages, resolveChatImagePath, getChatImageRoot, setSharpImporterForTesting,
} = await import('./chat-image-store.js');

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('chat-image-store', () => {
  after(async () => {
    if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = ORIGINAL_DB;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('writes the bytes outside /tmp so they survive the query (B-430)', async () => {
    const { bucket, paths } = await saveChatImages([
      { data: `data:image/png;base64,${PNG_BASE64}` },
    ]);

    assert.match(bucket!, /^[0-9a-f]{32}$/);
    assert.equal(paths.length, 1);
    assert.equal(paths[0], path.join(getChatImageRoot(), bucket!, 'image_0.png'));
    assert.ok((await fs.stat(paths[0])).isFile());
  });

  it('falls back to .png for an unknown mime subtype instead of trusting it', async () => {
    const { paths } = await saveChatImages([
      { data: `data:image/x-evil;base64,${PNG_BASE64}` },
    ]);
    assert.equal(path.basename(paths[0]), 'image_0.png');
  });

  it('is a no-op for an empty attachment list', async () => {
    assert.deepEqual(await saveChatImages([]), { bucket: null, paths: [], failures: [] });
  });

  // --- qa-critic veto 1: the WebSocket path must sanitize SVG itself ---

  it('strips script/on* out of a stored SVG instead of trusting the caller', async () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>'
      + '<rect width="10" height="10" onload="alert(2)"/></svg>';
    const { paths, failures } = await saveChatImages([
      { data: `data:image/svg+xml;base64,${Buffer.from(hostile).toString('base64')}` },
    ]);

    assert.equal(failures.length, 0);
    assert.equal(path.extname(paths[0]), '.svg');
    const stored = await fs.readFile(paths[0], 'utf8');
    assert.ok(!/<script/i.test(stored), 'script tag survived into the store');
    assert.ok(!/onload/i.test(stored), 'event handler survived into the store');
  });

  it('rejects an SVG that is not a real SVG once cleaned', async () => {
    const notSvg = Buffer.from('<html><body>nope</body></html>').toString('base64');
    const { bucket, paths, failures } = await saveChatImages([
      { data: `data:image/svg+xml;base64,${notSvg}` },
    ]);
    assert.equal(paths.length, 0);
    assert.equal(bucket, null, 'no bucket should be created when nothing is written');
    assert.equal(failures.length, 1);
  });

  // --- qa-critic veto 2: ceilings the transport cannot bypass ---

  it('refuses an image over the per-image byte ceiling', async () => {
    const huge = Buffer.alloc(6 * 1024 * 1024, 0x41).toString('base64');
    const { paths, failures } = await saveChatImages([{ data: `data:image/png;base64,${huge}` }]);
    assert.equal(paths.length, 0);
    assert.match(failures[0].reason, /exceeds/);
  });

  it('refuses attachments beyond the per-message count ceiling', async () => {
    const many = Array.from({ length: 20 }, () => ({ data: `data:image/png;base64,${PNG_BASE64}` }));
    const { paths, failures } = await saveChatImages(many);
    assert.equal(paths.length, 15);
    assert.equal(failures.length, 5);
    assert.match(failures[0].reason, /15-image limit/);
  });

  // --- partial failure must not cost the healthy images ---

  it('keeps the valid images when a sibling entry is malformed', async () => {
    const { paths, failures } = await saveChatImages([
      { data: `data:image/png;base64,${PNG_BASE64}` },
      { data: 'not-a-data-url' },
      { data: `data:image/png;base64,${PNG_BASE64}` },
    ]);
    assert.equal(paths.length, 2);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].index, 1);
    // Stored names are positional over the ACCEPTED set, so the note the model
    // reads never points at a gap.
    assert.deepEqual(paths.map((p) => path.basename(p)), ['image_0.png', 'image_1.png']);
  });

  it('creates no bucket at all when every image is invalid', async () => {
    const { bucket, paths, failures } = await saveChatImages([
      { data: 'garbage' },
      { data: 'data:image/png;base64,' },
    ]);
    assert.equal(bucket, null);
    assert.equal(paths.length, 0);
    assert.equal(failures.length, 2);
  });

  it('resolves a well-formed bucket/name pair inside the root', () => {
    const bucket = 'a'.repeat(32);
    assert.deepEqual(resolveChatImagePath(bucket, 'image_0.png'), {
      absolutePath: path.join(getChatImageRoot(), bucket, 'image_0.png'),
      mimeType: 'image/png',
    });
  });

  it('refuses traversal, odd buckets and unlisted extensions', () => {
    const bucket = 'a'.repeat(32);
    assert.equal(resolveChatImagePath('../../etc', 'image_0.png'), null);
    assert.equal(resolveChatImagePath(bucket, '../../../etc/passwd'), null);
    assert.equal(resolveChatImagePath(bucket, 'image_0.sh'), null);
    assert.equal(resolveChatImagePath('NOTHEX', 'image_0.png'), null);
    assert.equal(resolveChatImagePath(bucket, 'db.sqlite'), null);
  });
  // T-1667 — the copy at the transcript path is bounded to 1568px on its longest
  // side; the untouched upload survives beside it as image_N.orig.<ext>.
  it('downscales an oversized raster for the model and keeps the original beside it', async () => {
    const sharp = (await import('sharp')).default;
    const big = await sharp({ create: { width: 3200, height: 2000, channels: 3, background: '#4080c0' } }).jpeg().toBuffer();
    const result = await saveChatImages([{ data: `data:image/jpeg;base64,${big.toString('base64')}` }]);
    assert.equal(result.failures.length, 0);
    assert.equal(result.paths.length, 1);
    const modelMeta = await sharp(await fs.readFile(result.paths[0])).metadata();
    assert.equal(modelMeta.width, 1568);
    assert.equal(modelMeta.height, 980);
    const originalPath = result.paths[0].replace(/image_0\.jpeg$/, 'image_0.orig.jpeg');
    const originalMeta = await sharp(await fs.readFile(originalPath)).metadata();
    assert.equal(originalMeta.width, 3200);
    // The original is reachable through the same serve route.
    const bucket = path.basename(path.dirname(result.paths[0]));
    assert.ok(resolveChatImagePath(bucket, 'image_0.orig.jpeg'));
  });

  it('stores a small raster untouched and writes no .orig twin', async () => {
    const sharp = (await import('sharp')).default;
    const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#222' } }).png().toBuffer();
    const result = await saveChatImages([{ data: `data:image/png;base64,${small.toString('base64')}` }]);
    assert.equal(result.failures.length, 0);
    const stored = await fs.readFile(result.paths[0]);
    assert.ok(stored.equals(small), 'small image was re-encoded');
    await assert.rejects(fs.access(result.paths[0].replace(/image_0\.png$/, 'image_0.orig.png')));
  });

  // ADR-174 P1 — sharp is a devDependency (LGPL libvips), so a production tree
  // has none. The store must boot and keep working without it.
  describe('when sharp cannot be loaded', () => {
    afterEach(() => {
      setSharpImporterForTesting();
      mock.restoreAll();
    });

    function failSharpImport() {
      const importer = mock.fn(async () => {
        const error = Object.assign(new Error("Cannot find package 'sharp'"), { code: 'ERR_MODULE_NOT_FOUND' });
        throw error;
      });
      setSharpImporterForTesting(importer);
      return importer;
    }

    it('stores an oversized raster untouched, with no .orig twin', async () => {
      const sharp = (await import('sharp')).default;
      const big = await sharp({ create: { width: 3200, height: 2000, channels: 3, background: '#4080c0' } }).jpeg().toBuffer();
      const warn = mock.method(console, 'warn', () => {});
      failSharpImport();

      const result = await saveChatImages([{ data: `data:image/jpeg;base64,${big.toString('base64')}` }]);

      assert.equal(result.failures.length, 0);
      assert.equal(path.basename(result.paths[0]), 'image_0.jpeg');
      assert.ok((await fs.readFile(result.paths[0])).equals(big), 'original bytes were altered');
      await assert.rejects(fs.access(result.paths[0].replace(/image_0\.jpeg$/, 'image_0.orig.jpeg')));
      assert.equal(warn.mock.callCount(), 1);
    });

    it('attempts the import and warns only once across many messages', async () => {
      const warn = mock.method(console, 'warn', () => {});
      const importer = failSharpImport();

      await saveChatImages([{ data: `data:image/png;base64,${PNG_BASE64}` }]);
      await saveChatImages([
        { data: `data:image/png;base64,${PNG_BASE64}` },
        { data: `data:image/webp;base64,${PNG_BASE64}` },
      ]);

      assert.equal(importer.mock.callCount(), 1);
      assert.equal(warn.mock.callCount(), 1);
      const [message, detail] = warn.mock.calls[0].arguments;
      assert.match(String(message), /sharp unavailable/);
      assert.deepEqual(detail, { code: 'ERR_MODULE_NOT_FOUND' });
    });

    it('never tries sharp for svg/gif', async () => {
      const importer = failSharpImport();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
      await saveChatImages([
        { data: `data:image/svg+xml;base64,${svg.toString('base64')}` },
        { data: `data:image/gif;base64,${PNG_BASE64}` },
      ]);
      assert.equal(importer.mock.callCount(), 0);
    });

    it('still enforces the size ceiling and SVG sanitization', async () => {
      mock.method(console, 'warn', () => {});
      failSharpImport();

      const huge = Buffer.alloc(6 * 1024 * 1024, 0x41).toString('base64');
      const oversized = await saveChatImages([{ data: `data:image/png;base64,${huge}` }]);
      assert.equal(oversized.paths.length, 0);
      assert.match(oversized.failures[0].reason, /exceeds/);

      const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
      const { paths } = await saveChatImages([
        { data: `data:image/svg+xml;base64,${Buffer.from(hostile).toString('base64')}` },
      ]);
      assert.ok(!/<script/i.test(await fs.readFile(paths[0], 'utf8')));
    });

    it('treats a module without a usable export as unavailable', async () => {
      setSharpImporterForTesting(async () => ({ default: null }));
      const result = await saveChatImages([{ data: `data:image/png;base64,${PNG_BASE64}` }]);
      assert.equal(result.failures.length, 0);
      assert.equal(result.paths.length, 1);
    });
  });
});
