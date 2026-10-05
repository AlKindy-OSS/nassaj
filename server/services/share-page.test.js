import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { buildSharePageCsp, createSharePageRouter, parsePublicOrigin, publicAssetCors } from './share-page.js';

const ID = 'abcdefghij0123456789';

function fixture(t, publicOrigin, { withPage = true } = {}) {
  const root = mkdtempSync(path.join('/var/tmp', 'share-page-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'dist'));
  if (withPage) writeFileSync(path.join(root, 'dist', 'share.html'), '<!doctype html><title>share</title>');
  const app = express();
  app.use((_req, res, next) => { res.setHeader('Content-Security-Policy-Report-Only', "default-src 'self'"); next(); });
  app.use('/assets', publicAssetCors);
  app.use(createSharePageRouter({ appRoot: root, publicOrigin }));
  app.get('/assets/x.js', (_req, res) => res.type('js').send('1'));
  app.get('*', (_req, res) => res.send('SPA'));
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.closeAllConnections(); server.close(); });
    resolve(`http://127.0.0.1:${server.address().port}`);
  }));
}

test('parsePublicOrigin accepts only a bare http(s) origin', () => {
  assert.equal(parsePublicOrigin('https://nassaj.example'), 'https://nassaj.example');
  assert.equal(parsePublicOrigin(' https://nassaj.example/ '), 'https://nassaj.example');
  assert.equal(parsePublicOrigin('http://127.0.0.1:3004'), 'http://127.0.0.1:3004');
  for (const bad of [undefined, '', '   ', 'nassaj.example', 'ftp://x.example', 'https://x.example/path',
    'https://x.example/?q=1', 'https://u:p@x.example', 'javascript:alert(1)', 'https://x.example#h']) {
    assert.equal(parsePublicOrigin(bad), null, String(bad));
  }
});

test('CSP matches the approved policy exactly', () => {
  assert.equal(buildSharePageCsp('https://n.example'), [
    'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
    "default-src 'none'",
    'script-src https://n.example/assets/',
    "style-src https://n.example/assets/ 'unsafe-inline'",
    'font-src https://n.example/assets/',
    'img-src data:',
    'connect-src https://n.example/api/session-shares/',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; '));
  assert.ok(!buildSharePageCsp('https://n.example').includes('allow-same-origin'));
});

test('serves the page with isolation headers and no COOP', async (t) => {
  const base = await fixture(t, 'https://n.example');
  const response = await fetch(`${base}/s/${ID}`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<!doctype html><title>share</title>');
  assert.equal(response.headers.get('content-security-policy'), buildSharePageCsp('https://n.example'));
  assert.equal(response.headers.get('content-security-policy-report-only'), null);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex,nofollow,noarchive');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cross-origin-opener-policy'), null);
  assert.equal((await fetch(`${base}/s/${ID}/`)).status, 200);
});

test('unset or invalid public origin yields 404, never the SPA', async (t) => {
  for (const origin of [undefined, '', 'not-an-origin']) {
    const base = await fixture(t, origin);
    const response = await fetch(`${base}/s/${ID}`);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-security-policy'), null);
    assert.notEqual(await response.text(), 'SPA');
  }
});

test('rejects malformed ids and sub-paths; share.html itself is never served', async (t) => {
  const base = await fixture(t, 'https://n.example');
  for (const bad of ['/s', '/s/', '/s/short', `/s/${ID}/more`, `/s/${ID}%2f..`, '/s/has.dot0123456789', '/share.html']) {
    assert.equal((await fetch(`${base}${bad}`)).status, 404, bad);
  }
  assert.equal((await fetch(`${base}/other`)).status, 200, 'unrelated routes fall through');
});

test('missing build output is a 404', async (t) => {
  const base = await fixture(t, 'https://n.example', { withPage: false });
  assert.equal((await fetch(`${base}/s/${ID}`)).status, 404);
});

test('assets answer with ACAO * for GET', async (t) => {
  const base = await fixture(t, 'https://n.example');
  const response = await fetch(`${base}/assets/x.js`, { headers: { Origin: 'null' } });
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('server/index.js mounts the viewer before static mounts and the SPA fallback', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const at = (needle) => {
    const index = source.indexOf(needle);
    assert.ok(index > 0, `missing: ${needle}`);
    return index;
  };
  const cors = at("app.use('/assets', publicAssetCors);");
  const router = at('app.use(createSharePageRouter(');
  assert.ok(cors < at("app.use('/assets/generations'"));
  assert.ok(router < at("app.use('/assets/generations'"));
  assert.ok(router < at("app.use(express.static(path.join(APP_ROOT, 'dist')"));
  assert.ok(router < at('app.get(\'*\''));
  assert.match(source, /publicOrigin: process\.env\.NASSAJ_PUBLIC_ORIGIN \}\)\);/);
});

test('public/sw.js does not intercept /s/', () => {
  const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
  assert.match(source, /url\.pathname\.startsWith\('\/s\/'\)\) return;/);
  assert.ok(source.indexOf("startsWith('/s/')") < source.indexOf('event.respondWith'));
});
