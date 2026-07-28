/**
 * Stored-XSS hardening tests for GET /api/plugins/:name/assets/*
 * (server/routes/plugins.js).
 *
 * B-162 (medium), same class as B-158 on the project raw-bytes endpoint:
 * a plugin ships arbitrary files, and the asset route streamed them with a
 * `mime.lookup` Content-Type and NOTHING else. An installed (or compromised)
 * plugin containing `evil.svg` / `evil.html` therefore became an ACTIVE document
 * on the app's own origin the moment it was navigated to directly — the script
 * inside it runs with the deployment's cookies/localStorage (owner session
 * theft). Two headers close it, mirroring the B-158 fix in server/index.js:
 *   - `X-Content-Type-Options: nosniff` on EVERY asset response, so a declared
 *     inert type can never be re-sniffed into an active one from its bytes.
 *   - `Content-Disposition: attachment` for exactly the types a browser renders
 *     as a DOCUMENT (SVG/HTML/XHTML/XML), so a direct navigation downloads
 *     instead of executing.
 *
 * The negative assertion matters as much as the positive one: attachment must
 * NOT be set for inert types (png/js/css). Content-Disposition is ignored for
 * subresource loads, but blanket-attaching would still be a behavioural change
 * we do not want, and the tests pin the boundary of the renderable set.
 *
 * B-159 (symlink escape) is NOT re-tested here: this route delegates path
 * resolution to `resolvePluginAssetPath`, which already canonicalizes with
 * `fs.realpathSync` and rejects anything landing outside the plugin dir; the
 * route streams that returned real path, so there is no lexical-vs-real gap to
 * exploit. This file mocks the resolver and so deliberately does not cover it.
 *
 * Framework: node:test + node:assert/strict via tsx, matching the server suite
 * and plugins.role-gate.test.ts. The plugin loader / process manager / database
 * index are isolated with node:test module mocking (needs
 * --experimental-test-module-mocks); the served files are real bytes in a temp
 * dir so `fs.statSync` + `fs.createReadStream` in the handler run for real.
 *
 * Run:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test "server/routes/plugins.asset-xss.test.ts"
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

// auth.js resolves its JWT secret at load time (env first, then db). Removing the
// env var forces the deterministic mocked-db path.
delete process.env.JWT_SECRET;

// Real on-disk plugin dir: the handler stats and streams whatever the resolver
// returns, so the fixtures must actually exist.
const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-plugin-assets-'));
after(() => fs.rmSync(assetsDir, { recursive: true, force: true }));

const SVG_PAYLOAD = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
const FIXTURES: Record<string, string> = {
  'evil.svg': SVG_PAYLOAD,
  'evil.html': '<html><body><script>alert(1)</script></body></html>',
  'evil.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
  'evil.xml': '<?xml version="1.0"?><root/>',
  'icon.png': 'not-really-a-png',
  'entry.js': 'export default {};',
  'style.css': 'body{}',
  'notes.txt': 'plain',
  'blob.bin': 'bytes',
};
for (const [name, body] of Object.entries(FIXTURES)) {
  fs.writeFileSync(path.join(assetsDir, name), body);
}

const loaderUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../utils/plugin-loader.js')
).href;
const procMgrUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../utils/plugin-process-manager.js')
).href;
const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../modules/database/index.js')
).href;

// Resolver stand-in: reproduces the contract of the real
// resolvePluginAssetPath — a canonical absolute path inside the plugin dir, or
// null — without touching git/scanPlugins.
mock.module(loaderUrl, {
  namedExports: {
    scanPlugins: () => [],
    getPluginsConfig: () => ({}),
    getPluginsDir: () => assetsDir,
    savePluginsConfig: () => {},
    getPluginDir: () => assetsDir,
    resolvePluginAssetPath: (_name: string, assetPath: string) => {
      const resolved = path.resolve(assetsDir, assetPath);
      if (!resolved.startsWith(assetsDir + path.sep)) return null;
      if (!fs.existsSync(resolved)) return null;
      return fs.realpathSync(resolved);
    },
    installPluginFromGit: async () => ({ name: 'demo' }),
    updatePluginFromGit: async () => ({ name: 'demo' }),
    uninstallPlugin: async () => {},
  },
});

mock.module(procMgrUrl, {
  namedExports: {
    startPluginServer: async () => 12345,
    stopPluginServer: async () => {},
    getPluginPort: () => null,
    isPluginRunning: () => false,
  },
});

mock.module(dbIndexUrl, {
  namedExports: {
    appConfigDb: {
      getOrCreateJwtSecret: () => 'nassaj-plugins-test-jwt-secret-0123456789abcd',
    },
    auditLogDb: { record: () => {} },
    userDb: {},
    initializeDatabase: () => {},
    closeConnection: () => {},
    getConnection: () => ({}),
    getDatabasePath: () => ':memory:',
  },
});

// Import the router AFTER the mocks are registered.
const { default: pluginsRouter } = await import('./plugins.js');

async function buildServer() {
  const app = express();
  app.use(express.json());
  // Stand-in for authenticateToken (server/index.js mounts it before the router).
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = { id: 1, username: 'u', role: 'user' };
    next();
  });
  app.use('/api/plugins', pluginsRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const getAsset = async (assetPath: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins/demo/assets/${assetPath}`);
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      nosniff: res.headers.get('x-content-type-options'),
      disposition: res.headers.get('content-disposition'),
      body: await res.text(),
    };
  };

  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { getAsset, close };
}

// Types a browser renders as an ACTIVE document when navigated to directly:
// serving them inline from the app origin is the stored-XSS vector.
const RENDERABLE = ['evil.svg', 'evil.html', 'evil.xhtml', 'evil.xml'] as const;
// Inert types: nosniff still required, but they must keep their inline
// disposition (they are loaded as subresources by the plugin runtime).
const INERT = ['icon.png', 'entry.js', 'style.css', 'notes.txt', 'blob.bin'] as const;

for (const fixture of RENDERABLE) {
  test(`asset "${fixture}" is forced to download (no active document on our origin)`, async () => {
    const srv = await buildServer();
    try {
      const res = await srv.getAsset(fixture);
      assert.equal(res.status, 200, 'the asset must still be served');
      assert.equal(
        res.nosniff,
        'nosniff',
        `${fixture} must carry X-Content-Type-Options: nosniff`
      );
      assert.equal(
        res.disposition,
        'attachment',
        `${fixture} renders as a document — it must be served with Content-Disposition: attachment, ` +
          `otherwise direct navigation executes its embedded script on the app origin (B-162)`
      );
    } finally {
      await srv.close();
    }
  });
}

for (const fixture of INERT) {
  test(`asset "${fixture}" keeps inline delivery but is still nosniff-protected`, async () => {
    const srv = await buildServer();
    try {
      const res = await srv.getAsset(fixture);
      assert.equal(res.status, 200, 'the asset must still be served');
      assert.equal(
        res.nosniff,
        'nosniff',
        `${fixture} must carry X-Content-Type-Options: nosniff so its bytes can never be ` +
          `re-sniffed into an active type`
      );
      assert.equal(
        res.disposition,
        null,
        `${fixture} is inert — forcing a download would break plugin subresource loading`
      );
    } finally {
      await srv.close();
    }
  });
}

test('the SVG payload is still delivered byte-for-byte (hardening is header-only)', async () => {
  const srv = await buildServer();
  try {
    const res = await srv.getAsset('evil.svg');
    assert.equal(res.status, 200);
    assert.match(String(res.contentType), /^image\/svg\+xml/);
    assert.equal(res.body, SVG_PAYLOAD, 'the fix must not rewrite or truncate asset bytes');
  } finally {
    await srv.close();
  }
});

test('an unresolvable asset path is 404 (resolver contract unchanged)', async () => {
  const srv = await buildServer();
  try {
    const res = await srv.getAsset('does-not-exist.svg');
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});
