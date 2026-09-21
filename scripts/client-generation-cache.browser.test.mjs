import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const oldWorker = readFileSync(new URL('./fixtures/client-sw-v8.js', import.meta.url), 'utf8');
const newWorker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const a1 = `/assets/generations/${'a'.repeat(64)}/`;
const a2 = `/assets/generations/${'b'.repeat(64)}/`;
const svg = width => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1"></svg>`;

test('real old SW + immutable HTTP image cache migrate without forced reload; rollback retains lazy generation', async () => {
  let generation = 'legacy';
  let worker = oldWorker;
  let brandingTitle = 'مساحة الاختبار الخاصة';
  const requests = [];
  const server = createServer((request, response) => {
    const path = request.url.split('?')[0]; requests.push(path);
    const prefix = generation === 'legacy' ? '/' : generation === 'a1' ? a1 : a2;
    response.setHeader('Cache-Control', path === '/' || path === '/version.json' || path === '/sw.js' || path === '/manifest.json' ? 'no-store' : 'public, max-age=31536000, immutable');
    if (path === '/sw.js') { response.setHeader('Content-Type', 'application/javascript'); return response.end(worker); }
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); return response.end(`<link rel="manifest" href="/manifest.json"><img id="image" src="${prefix}fixed.svg"><script>window.generation=${JSON.stringify(generation)};window.lazy=()=>import('${prefix}lazy.js')</script>`); }
    if (path.endsWith('manifest.json')) { response.setHeader('Content-Type', 'application/manifest+json'); return response.end(JSON.stringify({ name: brandingTitle, start_url: '/', icons: [{src:`${prefix}fixed.svg`}] })); }
    if (path.endsWith('fixed.svg')) { response.setHeader('Content-Type', 'image/svg+xml'); return response.end(svg(path.startsWith(a2) ? 3 : path.startsWith(a1) ? 2 : 1)); }
    if (path.endsWith('lazy.js')) { response.setHeader('Content-Type', 'application/javascript'); return response.end(`export const generation=${JSON.stringify(path.startsWith(a2) ? 'a2' : 'a1')}`); }
    if (path === '/version.json') { response.setHeader('Content-Type', 'application/json'); return response.end(JSON.stringify({ generation })); }
    response.statusCode = 404; response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }); await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.reload();
    assert.equal(await page.locator('#image').evaluate(image => image.naturalWidth), 1);
    const oldImageRequests = requests.filter(path => path === '/fixed.svg').length;
    await page.reload();
    assert.equal(requests.filter(path => path === '/fixed.svg').length, oldImageRequests, 'old immutable HTTP response really reused');
    assert.ok(await page.evaluate(async () => Boolean(await caches.match('/manifest.json'))), 'old SW manifest cached');
    generation = 'a1';
    await page.reload();
    assert.equal(await page.locator('#image').evaluate(image => image.naturalWidth), 2, 'old worker can serve fresh generation URLs');
    assert.equal(await page.evaluate(async () => (await (await fetch(document.querySelector('link[rel=manifest]').href)).json()).name), brandingTitle);
    worker = newWorker;
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
    await page.waitForFunction(async () => !(await caches.keys()).includes('claude-ui-v8'));
    assert.equal(await page.evaluate(() => window.generation), 'a1', 'worker update never reloads page');
    generation = 'a2';
    await page.reload();
    assert.equal(await page.locator('#image').evaluate(image => image.naturalWidth), 3);
    assert.equal(await page.evaluate(async () => (await (await fetch(document.querySelector('link[rel=manifest]').href)).json()).name), brandingTitle);
    brandingTitle = 'اسم مخصص جديد';
    const manifest = await page.evaluate(async () => {
      const response = await fetch(document.querySelector('link[rel=manifest]').href);
      return { body: await response.json(), cache: response.headers.get('Cache-Control') };
    });
    assert.equal(manifest.body.name, brandingTitle, 'branding changes without build or navigation');
    assert.equal(manifest.cache, 'no-store');
    assert.equal(manifest.body.icons[0].src, `${a2}fixed.svg`);
    generation = 'a1';
    assert.equal(await page.evaluate(async () => (await window.lazy()).generation), 'a2', 'A2 lazy module remains available after A1 rollback');
    assert.equal(await page.evaluate(async () => (await (await fetch('/version.json')).json()).generation), 'a1');
    await context.setOffline(true);
    await page.reload();
    assert.equal(await page.locator('h1').textContent(), 'Offline');
    await context.setOffline(false);
    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
