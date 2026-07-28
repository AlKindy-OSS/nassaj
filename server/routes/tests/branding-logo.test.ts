/**
 * Tests for the branding logo upload hardening (server/routes/settings.js).
 *
 * Security-focused coverage:
 *  1. Magic-byte / content unit check (detectImageExt) — the single source of
 *     truth for "what kind of image is this". Verifies real PNG/JPEG/WEBP
 *     signatures are accepted, that a valid <svg>-rooted document is detected as
 *     'svg', and that spoofed / non-SVG / truncated content is rejected (null).
 *  2. POST /api/settings/branding/logo end-to-end:
 *     - a clean SVG -> 200 and the sanitized markup is written to disk.
 *     - an SVG carrying <script>/onload -> 200 but the STORED file is sanitized
 *       (no <script>, no on* handlers). This is the key XSS-regression guard.
 *     - a file declared image/png whose bytes are NOT a real PNG -> 400.
 *     - non-SVG content with a forged image/svg+xml type -> 400.
 *     - a payload exceeding the 2MB limit -> 413.
 *
 * Framework: node:test (built-in) + node:assert/strict, run via tsx — matching
 * the existing server test suite. The database index is isolated with node:test
 * module mocking (requires --experimental-test-module-mocks) because settings.js
 * imports several db singletons at module load; we stub appConfigDb so the upload
 * path never touches the real key/value store.
 *
 * The route's owner check (requireRole('owner')) reads req.user.role, so the test
 * harness injects a verified owner user via a stand-in middleware. Filesystem
 * isolation: HOME (and USERPROFILE on Windows) is redirected to a per-run temp
 * dir BEFORE settings.js is imported, because BRANDING_ROOT is derived from
 * os.homedir() at module load. The accepting tests therefore write only into
 * that throwaway directory, never the real ~/.nassaj-users.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

// Redirect the home directory to an isolated temp dir so the branding logo is
// written under <tmp>/.nassaj-users/.branding instead of the real home. Must run
// BEFORE importing settings.js (BRANDING_ROOT = os.homedir()/... at load time).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-branding-test-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
const BRANDING_DIR = path.join(TMP_HOME, '.nassaj-users', '.branding');

// Make the run deterministic regardless of the operator's shell environment:
// auth.js resolves its JWT secret at load time (env first, then the db). With
// the env var removed, it always takes the mocked getOrCreateJwtSecret() path.
delete process.env.JWT_SECRET;

// In-memory stand-in for app_config so the route never touches the real store.
const appConfigStore = new Map<string, string>();

const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../modules/database/index.js')
).href;

// Register mocks ONCE. node:test forbids re-mocking the same specifier.
// We provide every named export settings.js destructures from the db index so
// the module loads; only appConfigDb is exercised by these tests.
mock.module(dbIndexUrl, {
  namedExports: {
    // The only repository these tests exercise. Backed by the in-memory map so
    // the upload path never touches the real key/value store.
    appConfigDb: {
      get: (key: string) => appConfigStore.get(key) ?? null,
      set: (key: string, value: string) => {
        appConfigStore.set(key, value);
      },
      // auth.js falls back to this when process.env.JWT_SECRET is unset (we
      // delete it above), so the middleware loads without touching the real db.
      getOrCreateJwtSecret: () =>
        'nassaj-branding-test-jwt-secret-0123456789abcdef',
    },
    // Remaining named exports are stubbed only so settings.js and its transitive
    // imports (auth middleware, notification orchestrator, vapid keys) load.
    initializeDatabase: () => {},
    closeConnection: () => {},
    getConnection: () => ({}),
    getDatabasePath: () => ':memory:',
    apiKeysDb: {},
    auditLogDb: {},
    invitesDb: {},
    credentialsDb: {},
    githubTokensDb: {},
    notificationPreferencesDb: {},
    uiPreferencesDb: {},
    participantsDb: {},
    projectsDb: {},
    sessionAgentsDb: {},
    pushSubscriptionsDb: {},
    scanStateDb: {},
    sessionsDb: {},
    userDb: {},
    vapidKeysDb: {},
  },
});

// Import the router and the magic-byte helper once, after mocks are registered.
const settingsModule = await import('../settings.js');
const settingsRouter = settingsModule.default;
const detectImageExt = settingsModule.detectImageExt as (
  buffer: Buffer | null
) => string | null;

// ---------------------------------------------------------------------------
// Real binary signatures used to build valid/invalid fixtures.
// ---------------------------------------------------------------------------
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function pngFixture(extraBytes = 32): Buffer {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(extraBytes, 0)]);
}
function jpegFixture(extraBytes = 32): Buffer {
  return Buffer.concat([JPEG_MAGIC, Buffer.alloc(extraBytes, 0)]);
}
function webpFixture(extraBytes = 16): Buffer {
  // "RIFF" <4 size bytes> "WEBP" ...
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.alloc(extraBytes, 0),
  ]);
}
// A clean, valid SVG logo (no active content).
const CLEAN_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<rect width="24" height="24" fill="#0a84ff"/></svg>',
  'utf8'
);
// A hostile SVG: inline <script> + onload handler + javascript: href. This must
// be ACCEPTED (200) but stored only in sanitized form.
const MALICIOUS_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 24 24">' +
    '<script>alert(2)</script>' +
    '<a href="javascript:alert(3)"><rect width="24" height="24"/></a>' +
    '</svg>',
  'utf8'
);
// Content that is NOT an svg-rooted document but is declared image/svg+xml.
const FORGED_SVG = Buffer.from(
  '<html><body><svg></svg></body></html>',
  'utf8'
);

// ---------------------------------------------------------------------------
// 1. Unit tests for the magic-byte detector.
// ---------------------------------------------------------------------------
test('detectImageExt accepts a real PNG signature', () => {
  assert.equal(detectImageExt(pngFixture()), 'png');
});

test('detectImageExt accepts a real JPEG signature', () => {
  assert.equal(detectImageExt(jpegFixture()), 'jpg');
});

test('detectImageExt accepts a real WEBP signature', () => {
  assert.equal(detectImageExt(webpFixture()), 'webp');
});

test('detectImageExt detects a valid <svg>-rooted document as svg', () => {
  assert.equal(detectImageExt(CLEAN_SVG), 'svg');
  assert.equal(detectImageExt(MALICIOUS_SVG), 'svg');
});

test('detectImageExt rejects non-svg-rooted content (svg not the root element)', () => {
  // "<svg" appears, but the document root is <html>, so it must NOT be 'svg'.
  assert.equal(detectImageExt(FORGED_SVG), null);
});

test('detectImageExt rejects content with a spoofed/incorrect signature', () => {
  // Bytes that are not any allowed image format.
  const bogus = Buffer.from('this is definitely not an image at all', 'utf8');
  assert.equal(detectImageExt(bogus), null);
});

test('detectImageExt rejects a buffer too short to contain a signature', () => {
  assert.equal(detectImageExt(Buffer.from([0x89, 0x50])), null);
  assert.equal(detectImageExt(Buffer.alloc(0)), null);
  assert.equal(detectImageExt(null), null);
});

test('detectImageExt rejects RIFF that is not WEBP (e.g. WAV/AVI)', () => {
  const riffWave = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WAVE', 'ascii'),
    Buffer.alloc(16, 0),
  ]);
  assert.equal(detectImageExt(riffWave), null);
});

// ---------------------------------------------------------------------------
// 2. End-to-end route tests.
// ---------------------------------------------------------------------------
async function buildServer() {
  appConfigStore.clear();

  const app = express();
  // The real server registers express.json() app-wide; the PUT /branding
  // handler depends on it to read req.body.
  app.use(express.json());
  // Stand-in for authenticateToken: inject a verified owner so requireRole
  // ('owner') passes and the upload handler runs.
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = {
      id: 1,
      username: 'owner',
      role: 'owner',
    };
    next();
  });
  app.use('/api/settings', settingsRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const uploadLogo = async (filename: string, contentType: string, body: Buffer) => {
    const boundary = '----nassajtestboundary' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="logo"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const payload = Buffer.concat([head, body, tail]);

    const res = await fetch(`http://127.0.0.1:${port}/api/settings/branding/logo`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(payload.length),
      },
      body: payload,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { _raw: text };
    }
    return { status: res.status, body: json };
  };

  // Plain JSON request helper for the GET/PUT /branding settings round-trips.
  const requestJson = async (method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: json };
  };

  const close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));

  return { uploadLogo, requestJson, close };
}

// ---------------------------------------------------------------------------
// Splash hide-title setting (branding.splash_hide_title) round-trip.
// ---------------------------------------------------------------------------
test('GET branding defaults splashHideTitle to false', async () => {
  const srv = await buildServer();
  try {
    const { status, body } = await srv.requestJson('GET', '/api/settings/branding');
    assert.equal(status, 200);
    assert.equal(body.splashHideTitle, false);
  } finally {
    await srv.close();
  }
});

test('PUT branding persists splashHideTitle and GET reflects it', async () => {
  const srv = await buildServer();
  try {
    const enabled = await srv.requestJson('PUT', '/api/settings/branding', {
      splashHideTitle: true,
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.splashHideTitle, true);

    const fetched = await srv.requestJson('GET', '/api/settings/branding');
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.splashHideTitle, true);

    const disabled = await srv.requestJson('PUT', '/api/settings/branding', {
      splashHideTitle: false,
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.splashHideTitle, false);
  } finally {
    await srv.close();
  }
});

test('PUT branding ignores a non-boolean splashHideTitle', async () => {
  const srv = await buildServer();
  try {
    const { status, body } = await srv.requestJson('PUT', '/api/settings/branding', {
      splashHideTitle: 'yes',
    });
    assert.equal(status, 200);
    assert.equal(body.splashHideTitle, false, 'non-boolean value must not be persisted');
  } finally {
    await srv.close();
  }
});

test('POST branding/logo rejects a file declaring image/png whose bytes are not a real PNG (400)', async () => {
  const srv = await buildServer();
  try {
    const fakePng = Buffer.from('GIF89a-not-really-a-png', 'utf8');
    const { status } = await srv.uploadLogo('logo.png', 'image/png', fakePng);
    assert.equal(status, 400);
  } finally {
    await srv.close();
  }
});

test('POST branding/logo accepts a clean SVG (200) and stores it', async () => {
  const srv = await buildServer();
  try {
    fs.rmSync(path.join(BRANDING_DIR, 'logo.svg'), { force: true });
    const { status } = await srv.uploadLogo('logo.svg', 'image/svg+xml', CLEAN_SVG);
    assert.equal(status, 200);
    const stored = fs.readFileSync(path.join(BRANDING_DIR, 'logo.svg'), 'utf8');
    assert.match(stored, /^<svg[\s>]/i, 'stored file must still be an <svg> document');
    assert.match(stored, /<rect/i, 'legitimate <rect> content must survive sanitization');
  } finally {
    await srv.close();
  }
});

// The key XSS-regression guard: a hostile SVG is accepted but the persisted file
// must be stripped of all active content. We assert against the bytes on disk —
// the original (unsanitized) buffer must never be what gets written.
test('POST branding/logo sanitizes a hostile SVG before storing it (no script / on*)', async () => {
  const srv = await buildServer();
  try {
    fs.rmSync(path.join(BRANDING_DIR, 'logo.svg'), { force: true });
    const { status } = await srv.uploadLogo('logo.svg', 'image/svg+xml', MALICIOUS_SVG);
    assert.equal(status, 200);

    const stored = fs.readFileSync(path.join(BRANDING_DIR, 'logo.svg'), 'utf8');
    assert.doesNotMatch(stored, /<script/i, 'stored SVG must not contain <script>');
    assert.doesNotMatch(stored, /onload/i, 'stored SVG must not contain onload handler');
    assert.doesNotMatch(stored, /\bon[a-z]+\s*=/i, 'stored SVG must not contain any on* handler');
    assert.doesNotMatch(stored, /javascript:/i, 'stored SVG must not contain javascript: URLs');
    assert.match(stored, /^<svg[\s>]/i, 'sanitized result is still a valid <svg> root');
  } finally {
    await srv.close();
  }
});

// Cache-busting regression guard: a successful upload must return a logoUrl that
// carries a `?v=<version>` token. This is what makes a replaced logo (same
// /branding/logo.<ext> path) resolve to a brand-new URL and bypass the browser /
// Service Worker cache so the new image shows up immediately.
test('POST branding/logo returns a logoUrl with a ?v cache-busting token', async () => {
  const srv = await buildServer();
  try {
    fs.rmSync(path.join(BRANDING_DIR, 'logo.svg'), { force: true });
    const { status, body } = await srv.uploadLogo('logo.svg', 'image/svg+xml', CLEAN_SVG);
    assert.equal(status, 200);
    assert.equal(
      typeof body.logoUrl === 'string' && /^\/branding\/logo\.svg\?v=\d+$/.test(body.logoUrl),
      true,
      `logoUrl must be /branding/logo.svg?v=<digits>, got: ${String(body.logoUrl)}`
    );
  } finally {
    await srv.close();
  }
});

// A second upload must produce a DIFFERENT version token than the first, so the
// URL actually changes and the old cached logo can never be reused.
test('POST branding/logo bumps the ?v token on each upload', async () => {
  const srv = await buildServer();
  try {
    fs.rmSync(path.join(BRANDING_DIR, 'logo.svg'), { force: true });
    const first = await srv.uploadLogo('logo.svg', 'image/svg+xml', CLEAN_SVG);
    // Ensure the wall clock advances so Date.now() differs between uploads.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await srv.uploadLogo('logo.svg', 'image/svg+xml', CLEAN_SVG);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(
      first.body.logoUrl,
      second.body.logoUrl,
      'each upload must yield a fresh versioned URL'
    );
  } finally {
    await srv.close();
  }
});

test('POST branding/logo rejects non-SVG content with a forged image/svg+xml type (400)', async () => {
  const srv = await buildServer();
  try {
    const { status } = await srv.uploadLogo('logo.svg', 'image/svg+xml', FORGED_SVG);
    assert.equal(status, 400);
  } finally {
    await srv.close();
  }
});

test('POST branding/logo rejects a payload exceeding the 2MB limit (413)', async () => {
  const srv = await buildServer();
  try {
    // Valid PNG header but > 2MB total: rejected by the multer size limit before
    // any content inspection.
    const tooBig = Buffer.concat([PNG_MAGIC, Buffer.alloc(2 * 1024 * 1024 + 1024, 0)]);
    const { status } = await srv.uploadLogo('logo.png', 'image/png', tooBig);
    assert.equal(status, 413);
  } finally {
    await srv.close();
  }
});

// Best-effort removal of the isolated temp home created at module load.
process.on('exit', () => {
  try {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors */
  }
});
