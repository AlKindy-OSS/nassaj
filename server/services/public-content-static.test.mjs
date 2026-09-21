/**
 * T-1798/T-1799/T-1800 — the external public-content plane end to end:
 * atomic publish, rollback, withdrawal, traversal and symlink refusal, bounds,
 * survival of a client generation swap, and the isolation headers.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

import { PublicPageUnavailable, readPublicSiteAsset } from './public-page-manifest.mjs';
import { mountPublicContent, resolveRequestTarget, PUBLIC_CONTENT_CSP } from './public-content-static.js';
import { resolvePublicContentRoot } from './public-content-root.mjs';
import { run } from '../../scripts/public-page-publish.mjs';

const SITE = 'uqud-example';

function fixture(t) {
    const base = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'public-content-'));
    chmodSync(base, 0o700);
    t.after(() => rmSync(base, { recursive: true, force: true }));
    const source = path.join(base, 'src');
    mkdirSync(path.join(source, 'lifetrip', 'brand'), { recursive: true });
    writeFileSync(path.join(source, 'lifetrip', 'index.html'), '<!doctype html><title>v1</title>');
    writeFileSync(path.join(source, 'lifetrip', 'page.css'), 'body{color:#123}');
    writeFileSync(path.join(source, 'lifetrip', 'brand', 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    return { base, source, root: path.join(base, 'content') };
}

const publish = (fx, dir = fx.source) => run(['publish', '--site', SITE, '--dir', dir, '--root', fx.root]);
const unavailable = (fn) => assert.throws(fn, (error) => error instanceof PublicPageUnavailable);

test('publish creates an immutable revision and an atomic pointer', async (t) => {
    const fx = fixture(t);
    const first = await publish(fx);
    assert.equal(first.action, 'published');
    assert.equal(first.epoch, 1);
    assert.match(first.revision, /^[a-f0-9]{64}$/);
    const asset = readPublicSiteAsset(fx.root, SITE, 'lifetrip/index.html');
    assert.equal(asset.bytes.toString(), '<!doctype html><title>v1</title>');
    assert.equal(asset.mime, 'text/html; charset=utf-8');
    assert.equal(readPublicSiteAsset(fx.root, SITE, 'lifetrip/brand/logo.png').mime, 'image/png');

    // Identical input is the same revision; the pointer advances, bytes do not.
    const again = await publish(fx);
    assert.equal(again.revision, first.revision);
    assert.equal(again.epoch, 2);
    assert.equal(readdirSync(path.join(fx.root, 'bundles', SITE)).length, 1);
});

test('a second publish swaps the pointer without touching the old revision', async (t) => {
    const fx = fixture(t);
    const first = await publish(fx);
    writeFileSync(path.join(fx.source, 'lifetrip', 'index.html'), '<!doctype html><title>v2</title>');
    const second = await publish(fx);
    assert.notEqual(second.revision, first.revision);
    assert.equal(readPublicSiteAsset(fx.root, SITE, 'lifetrip/index.html').bytes.toString(), '<!doctype html><title>v2</title>');
    // The superseded revision is still on disk, byte-identical — that is what rollback needs.
    const old = readFileSync(path.join(fx.root, 'bundles', SITE, first.revision, 'lifetrip', 'index.html'));
    assert.equal(old.toString(), '<!doctype html><title>v1</title>');

    const back = await run(['rollback', '--site', SITE, '--to', first.revision, '--root', fx.root]);
    assert.equal(back.revision, first.revision);
    assert.equal(back.epoch, second.epoch + 1);
    assert.equal(readPublicSiteAsset(fx.root, SITE, 'lifetrip/index.html').bytes.toString(), '<!doctype html><title>v1</title>');
});

test('rollback refuses an unknown revision', async (t) => {
    const fx = fixture(t);
    await publish(fx);
    await assert.rejects(run(['rollback', '--site', SITE, '--to', 'f'.repeat(64), '--root', fx.root]));
});

test('withdraw fails the reader closed and restore brings it back', async (t) => {
    const fx = fixture(t);
    await publish(fx);
    await run(['withdraw', '--site', SITE, '--root', fx.root]);
    unavailable(() => readPublicSiteAsset(fx.root, SITE, 'lifetrip/index.html'));
    await run(['restore', '--site', SITE, '--root', fx.root]);
    assert.ok(readPublicSiteAsset(fx.root, SITE, 'lifetrip/index.html').bytes.length > 0);
});

test('traversal, dotfiles, and unknown types never resolve', async (t) => {
    const fx = fixture(t);
    await publish(fx);
    for (const bad of ['../../etc/passwd', 'lifetrip/../../../etc/passwd', '/etc/passwd', '.env',
        'lifetrip/.hidden.html', 'lifetrip/index.php', 'lifetrip/', 'lifetrip/index.html\0.png']) {
        unavailable(() => readPublicSiteAsset(fx.root, SITE, bad));
    }
    // Declared in no manifest: refused even though the name is well formed.
    unavailable(() => readPublicSiteAsset(fx.root, SITE, 'lifetrip/absent.html'));
});

test('a symlink is refused at publish time and at read time', async (t) => {
    const fx = fixture(t);
    symlinkSync('/etc/passwd', path.join(fx.source, 'lifetrip', 'leak.txt'));
    await assert.rejects(publish(fx), /symlink/);
    rmSync(path.join(fx.source, 'lifetrip', 'leak.txt'));

    const published = await publish(fx);
    // Swap a published file for a symlink: O_NOFOLLOW must reject it, not follow it.
    const target = path.join(fx.root, 'bundles', SITE, published.revision, 'lifetrip', 'page.css');
    rmSync(target);
    symlinkSync('/etc/passwd', target);
    unavailable(() => readPublicSiteAsset(fx.root, SITE, 'lifetrip/page.css'));
    // An intermediate directory swapped for a symlink is rejected too.
    const directory = path.join(fx.root, 'bundles', SITE, published.revision, 'lifetrip', 'brand');
    rmSync(directory, { recursive: true });
    symlinkSync('/etc', directory);
    unavailable(() => readPublicSiteAsset(fx.root, SITE, 'lifetrip/brand/logo.png'));
});

test('size and type ceilings are enforced by the publisher', async (t) => {
    const fx = fixture(t);
    const oversize = path.join(fx.base, 'big');
    mkdirSync(oversize, { recursive: true });
    writeFileSync(path.join(oversize, 'index.html'), 'x');
    writeFileSync(path.join(oversize, 'huge.png'), Buffer.alloc(9 * 1024 * 1024, 1));
    await assert.rejects(run(['publish', '--site', SITE, '--dir', oversize, '--root', fx.root]), /size out of bounds/);

    const badType = path.join(fx.base, 'bad');
    mkdirSync(badType, { recursive: true });
    writeFileSync(path.join(badType, 'index.html'), 'x');
    writeFileSync(path.join(badType, 'shell.php'), 'x');
    await assert.rejects(run(['publish', '--site', SITE, '--dir', badType, '--root', fx.root]), /unpublishable/);

    const empty = path.join(fx.base, 'empty');
    mkdirSync(empty, { recursive: true });
    await assert.rejects(run(['publish', '--site', SITE, '--dir', empty, '--root', fx.root]), /no publishable files/);
});

test('content survives a client generation swap and refuses to live inside the app', async (t) => {
    const fx = fixture(t);
    const appRoot = path.join(fx.base, 'app');
    mkdirSync(path.join(appRoot, 'dist'), { recursive: true });
    await publish(fx);

    // Simulate the atomic promote: dist is replaced wholesale.
    renameSync(path.join(appRoot, 'dist'), path.join(appRoot, 'dist.atomic.predeploy-previous-1'));
    mkdirSync(path.join(appRoot, 'dist'), { recursive: true });
    assert.ok(readPublicSiteAsset(fx.root, SITE, 'lifetrip/index.html').bytes.length > 0);

    assert.equal(resolvePublicContentRoot({ env: { NASSAJ_PUBLIC_CONTENT_ROOT: path.join(appRoot, 'dist', 'x') }, appRoot }), null);
    assert.equal(resolvePublicContentRoot({ env: { NASSAJ_PUBLIC_CONTENT_ROOT: 'relative/path' }, appRoot }), null);
    assert.equal(
        resolvePublicContentRoot({ env: {}, appRoot, homedir: '/home/operator' }),
        '/home/operator/.local/share/nassaj-dev/public-content',
    );
});

test('request targets: origin root and reserved names are refused, site roots resolve', () => {
    assert.deepEqual(resolveRequestTarget('/uqud-example/lifetrip/'), { siteId: 'uqud-example', relativePath: 'lifetrip/index.html' });
    // `/<site>` has no trailing slash: a redirect candidate the caller must gate on publication.
    assert.deepEqual(resolveRequestTarget('/uqud-example'), { siteId: 'uqud-example', relativePath: null });
    // `/<site>/` serves that site's own root index.html directly.
    assert.deepEqual(resolveRequestTarget('/uqud-example/'), { siteId: 'uqud-example', relativePath: 'index.html' });
    for (const bad of ['/', '/api/sessions', '/assets/app.js',
        '/UQUD-Example/lifetrip/', '/uqud-example/.git/config', '/uqud-example/lifetrip/app.php']) {
        assert.equal(resolveRequestTarget(bad), null, bad);
    }
});

test('served bytes are sandboxed away from this origin', async (t) => {
    const fx = fixture(t);
    await publish(fx);
    const app = express();
    const mounted = mountPublicContent(app, { dataRoot: fx.root, logger: {} });
    assert.equal(mounted.enabled, true);
    app.use((req, res) => res.status(404).type('text/plain').end('spa-fallback'));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const get = (suffix, init) => fetch(`${origin}${suffix}`, init);

    const page = await get(`/${SITE}/lifetrip/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    const csp = page.headers.get('content-security-policy');
    assert.equal(csp, PUBLIC_CONTENT_CSP);
    assert.match(csp, /^sandbox /);
    assert.ok(!csp.includes('allow-same-origin'), 'sandbox must never grant same-origin');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('service-worker-allowed'), null);
    assert.equal(await page.text(), '<!doctype html><title>v1</title>');

    const png = await get(`/${SITE}/lifetrip/brand/logo.png`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');

    // Everything else falls through to the application, and leaks no existence.
    for (const suffix of [`/${SITE}/`, `/${SITE}/lifetrip/absent.html`, '/api/whatever', '/']) {
        const response = await get(suffix);
        assert.equal(response.status, 404, suffix);
        assert.equal(await response.text(), 'spa-fallback', suffix);
    }
    const worker = await get(`/${SITE}/lifetrip/`, { headers: { 'Service-Worker': 'script' } });
    assert.equal(worker.status, 404);
});

test('a published site root serves at /<site>/ and /<site> redirects to it', async (t) => {
    const fx = fixture(t);
    await publish(fx);
    // A second, root-level site: publishes index.html directly at its bundle root.
    const rootSite = 'uqud-root-example';
    const rootSource = path.join(fx.base, 'root-src');
    mkdirSync(rootSource, { recursive: true });
    writeFileSync(path.join(rootSource, 'index.html'), '<!doctype html><title>root</title>');
    await run(['publish', '--site', rootSite, '--dir', rootSource, '--root', fx.root]);

    const app = express();
    mountPublicContent(app, { dataRoot: fx.root, logger: {} });
    app.use((req, res) => res.status(404).type('text/plain').end('spa-fallback'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const get = (suffix, init) => fetch(`${origin}${suffix}`, { redirect: 'manual', ...init });

    // `/<site>/` serves the root index.html directly.
    const slash = await get(`/${rootSite}/`);
    assert.equal(slash.status, 200);
    assert.equal(await slash.text(), '<!doctype html><title>root</title>');

    // `/<site>` (no trailing slash) is a 308 redirect to `/<site>/`, query preserved.
    const bare = await get(`/${rootSite}?x=1`);
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.get('location'), `/${rootSite}/?x=1`);

    // A site published only under a sub-path has no root index.html: `/<site>` and
    // `/<site>/` both fall through to the SPA rather than confirming the slug exists.
    const unpublishedBare = await get(`/${SITE}`);
    assert.equal(unpublishedBare.status, 404);
    assert.equal(await unpublishedBare.text(), 'spa-fallback');

    // An unknown slug never redirects either.
    const unknown = await get('/uqud-does-not-exist');
    assert.equal(unknown.status, 404);

    // A reserved first segment is never even parsed as a site id.
    const reserved = await get('/api');
    assert.equal(reserved.status, 404);
});
