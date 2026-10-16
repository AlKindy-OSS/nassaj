// B-1657 / T-2040: the enforced frame-src header reaches the HTML app shell.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { ENFORCED_FRAME_POLICY, enforceFrameSrcPolicy } from './frame-src-csp.js';

const INDEX_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

async function withServer(app, run) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        return await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('the enforced policy is exactly the frame-src directive', () => {
    assert.equal(ENFORCED_FRAME_POLICY, "frame-src 'self' blob:");
    assert.doesNotMatch(ENFORCED_FRAME_POLICY, /child-src|default-src|https?:|\*/);
});

test('static index.html and the SPA fallback carry the enforced header', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'frame-src-csp-'));
    try {
        await writeFile(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
        const app = express();
        app.use(enforceFrameSrcPolicy);
        app.use(express.static(root));
        app.get('*', (_req, res) => res.sendFile(path.join(root, 'index.html')));
        await withServer(app, async (base) => {
            for (const route of ['/', '/index.html', '/session/abc']) {
                const response = await fetch(base + route);
                assert.equal(response.status, 200, route);
                assert.match(response.headers.get('content-type') ?? '', /text\/html/, route);
                assert.equal(response.headers.get('content-security-policy'), ENFORCED_FRAME_POLICY, route);
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a route that sets its own stricter CSP replaces the frame policy', async () => {
    const app = express();
    app.use(enforceFrameSrcPolicy);
    app.get('/raw', (_req, res) => {
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.send('x');
    });
    await withServer(app, async (base) => {
        const response = await fetch(`${base}/raw`);
        assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    });
});

test('index.js mounts the enforced policy after Report-Only and before every route and static mount', () => {
    const source = fs.readFileSync(INDEX_JS, 'utf8');
    const mount = source.indexOf('app.use(enforceFrameSrcPolicy);');
    assert.ok(mount > 0, 'enforceFrameSrcPolicy is mounted');
    assert.equal(source.indexOf('app.use(enforceFrameSrcPolicy);', mount + 1), -1, 'mounted once');
    const reportOnly = source.indexOf("res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY_POLICY)");
    assert.ok(reportOnly > 0 && reportOnly < mount, 'Report-Only policy kept and set first');
    assert.ok(mount < source.indexOf("app.get('/health'"), 'before /health');
    assert.ok(mount < source.indexOf('express.static('), 'before the first express.static');
});
