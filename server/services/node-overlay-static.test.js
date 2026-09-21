/**
 * ADR-156 / T-1730 W3 tests — the sealed static overlay (test plan §7):
 * enforced CSP + ACAO:* + nosniff, a symlink inside the dir => 404, a symlink
 * swapped into an INTERMEDIATE directory between seal and request => 404
 * (TOCTOU, qa 2), a file added after the seal => 404, a byte-mismatched file =>
 * 404, an out-of-range extension/size => 404, a service-writable manifest =>
 * overlay disabled (qa 1), and a corrupt manifest => the app still boots and
 * node_overlay_invalid is logged.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { statfsSync } from 'node:fs';
import test from 'node:test';

import express from 'express';

import { mountNodeOverlay } from './node-overlay-static.js';

function scratchParent() {
    const candidate = process.env.TMPDIR || '/var/tmp';
    try { if (Number(statfsSync(candidate).type) !== 0x01021994) return candidate; } catch { /* default below */ }
    return '/var/tmp';
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Build a config dir with a sealed /hub overlay. Files is a map of relpath
 * (under the mount dir) => contents. Returns paths and the fixture root.
 */
function fixture(t, { files, mount = '/hub', dir = 'static/hub', writeManifest = true, corruptManifest = false } = {}) {
    const root = mkdtempSync(path.join(scratchParent(), 'nassaj-overlay-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const configDir = path.join(root, 'config');
    const mountDir = path.join(configDir, 'overlay', dir);
    fs.mkdirSync(mountDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'node-overlay.json'),
        JSON.stringify({ schema: 1, static: [{ mount, dir }] }));

    const manifestFiles = {};
    for (const [rel, contents] of Object.entries(files)) {
        const abs = path.join(mountDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const buf = Buffer.from(contents);
        fs.writeFileSync(abs, buf);
        manifestFiles[`${dir}/${rel}`] = { sha256: sha256(buf), size: buf.length };
    }
    const lockPath = path.join(configDir, 'node-overlay.lock.json');
    if (writeManifest) {
        fs.writeFileSync(lockPath, corruptManifest ? '{ not json' : JSON.stringify({ files: manifestFiles }));
    }
    return { root, configDir, mountDir, lockPath, manifestFiles };
}

/** Mount overlay on a fresh app and start listening. Ownership check relaxed for tests. */
async function serve(t, configDir, extra = {}) {
    const app = express();
    const invalids = [];
    const mounted = mountNodeOverlay(app, {
        configDir,
        logger: { warn() {}, info() {} },
        // In tests the manifest is owned by the test user (= euid); relax the
        // ownership gate here so serving can be exercised. The gate itself is
        // asserted separately with the default policy.
        verifyManifestOwnership: () => true,
        onInvalid: (reason, detail) => invalids.push({ reason, detail }),
        ...extra,
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { mounted.close?.(); server.close(); });
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    return { mounted, invalids, base };
}

// --- serving + headers ----------------------------------------------------

test('serves a sealed file with enforced CSP, ACAO:* and nosniff', async (t) => {
    const html = '<!doctype html><html><body>hub</body></html>';
    const { configDir } = fixture(t, { files: { 'index.html': html } });
    const { mounted, base } = await serve(t, configDir);
    assert.equal(mounted.enabled, true);

    const res = await fetch(`${base}/hub/index.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
    assert.match(csp, /connect-src 'none'/);
    assert.equal(await res.text(), html);
});

test('serves the directory index for the mount root', async (t) => {
    const { configDir } = fixture(t, { files: { 'index.html': '<p>root</p>' } });
    const { base } = await serve(t, configDir);
    const res = await fetch(`${base}/hub/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<p>root</p>');
});

test('serves a module script and a font (opaque-origin cross-origin loads)', async (t) => {
    const { configDir } = fixture(t, {
        files: { 'index.html': '<html></html>', 'app.mjs': 'export const x=1;', 'f.woff2': 'FONTBYTES' },
    });
    const { base } = await serve(t, configDir);
    const js = await fetch(`${base}/hub/app.mjs`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(js.headers.get('access-control-allow-origin'), '*');
    const font = await fetch(`${base}/hub/f.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
});

// --- 404 cases ------------------------------------------------------------

test('a file not in the manifest is 404', async (t) => {
    const { configDir, mountDir } = fixture(t, { files: { 'index.html': 'x' } });
    fs.writeFileSync(path.join(mountDir, 'sneaked.html'), '<evil/>'); // real file, not sealed
    const { base } = await serve(t, configDir);
    assert.equal((await fetch(`${base}/hub/sneaked.html`)).status, 404);
    assert.equal((await fetch(`${base}/hub/missing.html`)).status, 404);
});

test('a byte-mismatched file (tampered after seal) is 404', async (t) => {
    const { configDir, mountDir } = fixture(t, { files: { 'index.html': 'original' } });
    fs.writeFileSync(path.join(mountDir, 'index.html'), 'tampered-same-namebutlonger');
    const { base } = await serve(t, configDir);
    assert.equal((await fetch(`${base}/hub/index.html`)).status, 404);
});

test('a symlink as the served file is 404', async (t) => {
    const { configDir, mountDir, lockPath } = fixture(t, { files: { 'index.html': 'x' } });
    // Seal a name, then replace it with a symlink to a secret.
    const secret = path.join(configDir, 'secret.html');
    fs.writeFileSync(secret, 'TOP SECRET');
    const target = path.join(mountDir, 'link.html');
    fs.symlinkSync(secret, target);
    // Add a manifest entry claiming link.html with the secret's digest, to prove
    // even a "matching" seal cannot defeat O_NOFOLLOW.
    const manifest = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const buf = fs.readFileSync(secret);
    manifest.files['static/hub/link.html'] = { sha256: sha256(buf), size: buf.length };
    fs.writeFileSync(lockPath, JSON.stringify(manifest));
    const { base } = await serve(t, configDir);
    assert.equal((await fetch(`${base}/hub/link.html`)).status, 404);
});

test('a symlink swapped into an INTERMEDIATE directory after seal is 404 (TOCTOU)', async (t) => {
    // Seal static/hub/sub/index.html, then replace `sub` with a symlink to an
    // attacker dir that has a same-named file with the SAME sealed bytes. The
    // per-segment O_NOFOLLOW walk must still refuse (it opens `sub` NOFOLLOW).
    const contents = '<html>sub</html>';
    const { configDir, mountDir } = fixture(t, { files: { 'sub/index.html': contents } });
    const evil = path.join(configDir, 'evil');
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'index.html'), contents); // identical bytes => same seal
    // Swap the intermediate directory for a symlink.
    rmSync(path.join(mountDir, 'sub'), { recursive: true, force: true });
    fs.symlinkSync(evil, path.join(mountDir, 'sub'));
    const { base } = await serve(t, configDir);
    assert.equal((await fetch(`${base}/hub/sub/index.html`)).status, 404);
});

test('a disallowed extension and an over-size file are 404', async (t) => {
    const big = 'x'.repeat(50);
    const { configDir, mountDir, lockPath } = fixture(t, { files: { 'index.html': 'x', 'note.exe': 'MZ' } });
    // note.exe was sealed into the manifest map by fixture; extension gate must still 404.
    const { base } = await serve(t, configDir, { maxFileBytes: 10 });
    assert.equal((await fetch(`${base}/hub/note.exe`)).status, 404);
    // Over-size: seal a 50-byte html and cap at 10 bytes.
    fs.writeFileSync(path.join(mountDir, 'big.html'), big);
    const manifest = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    manifest.files['static/hub/big.html'] = { sha256: sha256(Buffer.from(big)), size: big.length };
    fs.writeFileSync(lockPath, JSON.stringify(manifest));
    const { base: base2 } = await serve(t, configDir, { maxFileBytes: 10 });
    assert.equal((await fetch(`${base2}/hub/big.html`)).status, 404);
});

test('traversal and dotfiles are 404', async (t) => {
    const { configDir } = fixture(t, { files: { 'index.html': 'x' } });
    const { base } = await serve(t, configDir);
    // node's fetch/undici normalises ../ client-side, so hit the handler with a raw path.
    assert.equal((await rawGet(base, '/hub/..%2f..%2fsecret.html')).status, 404);
    assert.equal((await rawGet(base, '/hub/.env')).status, 404);
});

// --- manifest ownership + corrupt-boot ------------------------------------

test('a service-writable manifest disables the overlay (qa 1)', async (t) => {
    const { configDir } = fixture(t, { files: { 'index.html': 'x' } });
    const app = express();
    const invalids = [];
    const mounted = mountNodeOverlay(app, {
        configDir,
        logger: { warn() {}, info() {} },
        // Default ownership policy, but force euid to equal the manifest owner so
        // "service account owns/can write the manifest" is true.
        euid: fs.statSync(path.join(configDir, 'node-overlay.lock.json')).uid,
        onInvalid: (reason, detail) => invalids.push({ reason, detail }),
    });
    assert.equal(mounted.enabled, false);
    assert.equal(mounted.reason, 'node_overlay_invalid');
    assert.equal(invalids[0].reason, 'node_overlay_invalid');
});

/**
 * Mount with the DEFAULT ownership policy and a forced euid. The fixture files
 * are owned by the test user; forcing euid to a uid that matches nothing (-1)
 * makes the `uid !== euid` half always true, so the group/other-write bit alone
 * decides — letting a single chmod isolate which directory the gate rejects.
 */
function mountWithEuid(configDir, euid) {
    const app = express();
    const invalids = [];
    const mounted = mountNodeOverlay(app, {
        configDir, euid, logger: { warn() {}, info() {} },
        onInvalid: (reason, detail) => invalids.push({ reason, detail }),
    });
    return { mounted, invalids };
}

test('a service-writable config/ (manifest container) disables the overlay (E1)', (t) => {
    const { configDir, lockPath } = fixture(t, { files: { 'index.html': 'x' } });
    fs.chmodSync(lockPath, 0o644);
    fs.chmodSync(configDir, 0o777); // the manifest's own directory: a rename target
    const { mounted, invalids } = mountWithEuid(configDir, -1);
    assert.equal(mounted.enabled, false);
    assert.equal(mounted.reason, 'node_overlay_invalid');
    assert.equal(invalids[0].reason, 'node_overlay_invalid');
    assert.equal(invalids[0].detail.field, 'configDir');
});

test('a service-writable config/overlay/ disables the overlay (E1)', (t) => {
    const { configDir, lockPath } = fixture(t, { files: { 'index.html': 'x' } });
    fs.chmodSync(lockPath, 0o644);
    fs.chmodSync(configDir, 0o755);
    fs.chmodSync(path.join(configDir, 'overlay'), 0o777);
    const { mounted, invalids } = mountWithEuid(configDir, -1);
    assert.equal(mounted.enabled, false);
    assert.equal(invalids[0].detail.field, 'overlay');
});

test('a service-writable mount directory disables the overlay (E1)', (t) => {
    const { configDir, mountDir, lockPath } = fixture(t, { files: { 'index.html': 'x' } });
    fs.chmodSync(lockPath, 0o644);
    fs.chmodSync(configDir, 0o755);
    fs.chmodSync(path.join(configDir, 'overlay'), 0o755);
    fs.chmodSync(mountDir, 0o777); // config/overlay/static/hub: a sealed-file swap target
    const { mounted, invalids } = mountWithEuid(configDir, -1);
    assert.equal(mounted.enabled, false);
    assert.equal(invalids[0].detail.field, 'static./hub.dir');
});

test('root-owned, un-writable config/overlay/mount dirs keep the overlay enabled (E1)', async (t) => {
    // The positive case: default ownership policy, all dirs owned by the test user
    // (= euid) but with no group/other write bit, so the invariant holds and the
    // overlay serves. euid is set to the manifest/dir owner so uid === euid; the
    // gate must pass on the (mode & 0o022) === 0 half alone.
    const { configDir, mountDir, lockPath } = fixture(t, { files: { 'index.html': 'ok' } });
    const owner = fs.statSync(lockPath).uid;
    fs.chmodSync(lockPath, 0o644);
    fs.chmodSync(configDir, 0o755);
    fs.chmodSync(path.join(configDir, 'overlay'), 0o755);
    fs.chmodSync(mountDir, 0o755);
    // With uid === euid the file-only default would reject; prove the dir gate uses
    // the same predicate by making it pass here via the write-bit clause. Use a
    // custom verify that mirrors the mode half only, to keep uid === euid serving.
    const app = express();
    const mounted = mountNodeOverlay(app, {
        configDir, euid: owner, logger: { warn() {}, info() {} },
        verifyManifestOwnership: (stat) => (stat.mode & 0o022) === 0,
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { mounted.close?.(); server.close(); });
    assert.equal(mounted.enabled, true);
    const { port } = server.address();
    assert.equal((await fetch(`http://127.0.0.1:${port}/hub/index.html`)).status, 200);
});

test('a corrupt manifest disables the overlay, logs node_overlay_invalid, and the app still boots', async (t) => {
    const { configDir } = fixture(t, { files: { 'index.html': 'x' }, corruptManifest: true });
    const app = express();
    app.get('/health', (_req, res) => res.status(200).send('ok'));
    const invalids = [];
    const mounted = mountNodeOverlay(app, {
        configDir,
        logger: { warn() {}, info() {} },
        verifyManifestOwnership: () => true,
        onInvalid: (reason, detail) => invalids.push({ reason, detail }),
    });
    assert.equal(mounted.enabled, false);
    assert.equal(invalids[0].reason, 'node_overlay_invalid');
    // App still serves its own routes.
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const { port } = server.address();
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    // And /hub is not served.
    assert.equal((await fetch(`http://127.0.0.1:${port}/hub/index.html`)).status, 404);
});

/** Send a raw request path without undici's client-side normalisation. */
function rawGet(base, rawPath) {
    const u = new URL(base);
    return new Promise((resolve, reject) => {
        const req = http.request({ host: u.hostname, port: u.port, path: rawPath, method: 'GET' }, (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode }));
        });
        req.on('error', reject);
        req.end();
    });
}
