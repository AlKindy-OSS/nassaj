import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    freePort, healthMismatches, placeExternalPackage, runBootSmoke, smokeEnvironment, sriSha512, throwawayOwner,
    verifyApiLogin, verifyClientServing, waitForHealth,
} from './generation-boot-smoke.mjs';

const SDK = { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.283',
    tarballUrl: 'https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.283.tgz',
    installPath: 'node_modules/@anthropic-ai/claude-agent-sdk' };
const EXPECTED = { serverBuildId: 's'.repeat(64), clientBuildId: 'c'.repeat(64) };

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-smoke-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** An npm-style tarball (`package/` root) and its SRI. */
function npmTarball(dir) {
    const source = path.join(dir, 'pkg-src', 'package');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"@anthropic-ai/claude-agent-sdk","type":"module"}');
    fs.writeFileSync(path.join(source, 'index.js'), 'export const query = () => 1;\n');
    const file = path.join(dir, 'sdk.tgz');
    assert.equal(spawnSync('tar', ['-czf', file, '-C', path.join(dir, 'pkg-src'), 'package']).status, 0);
    const bytes = fs.readFileSync(file);
    return { bytes, integrity: sriSha512(bytes) };
}

function registryFetch(bytes, status = 200) {
    return async (url, init = {}) => {
        if (!String(url).startsWith('https://registry.npmjs.org/')) return fetch(url, { ...init, signal: AbortSignal.timeout(1500) });
        return { ok: status === 200, status, arrayBuffer: async () => bytes };
    };
}

const GENERATION_ID = '9'.repeat(64);
const INDEX_HTML = `<!doctype html><div id="root"></div>
<script type="module" crossorigin src="/assets/generations/${GENERATION_ID}/assets/index-abc.js"></script>\n`;
const APP_JS = 'console.log("app");\n';

/** Health, SPA shell, one generation asset and the two auth endpoints; MODE picks a fault. */
const FAKE_SERVER = `
import http from 'node:http';
import fs from 'node:fs';
const root = new URL('../../', import.meta.url);
const mode = fs.readFileSync(new URL('MODE', root), 'utf8').trim();
if (mode === 'exit') process.exit(3);
const health = () => JSON.stringify({ status: 'ok', service: 'nassaj-server', normalAdmissionReady: true, pid: process.pid,
  sourceVersion: mode === 'wrong-version' ? '0.0.0.1' : '2.4.0.1', serverLoadedOid: '${'a'.repeat(40)}',
  serverLoadedBuildId: '${EXPECTED.serverBuildId}', clientBuildIdServed: '${EXPECTED.clientBuildId}',
  home: process.env.HOME, db: process.env.DATABASE_PATH, leaked: process.env.NASSAJ_SMOKE_SENTINEL ?? null });
const owner = { username: process.env.BOOTSTRAP_OWNER_USERNAME, password: process.env.BOOTSTRAP_OWNER_PASSWORD };
const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
http.createServer((req, res) => {
  if (req.url === '/health') return send(res, 200, 'application/json', health());
  if (req.url === '/login') return send(res, 200, 'text/html; charset=UTF-8',
    fs.readFileSync(new URL('dist/index.html', root), 'utf8') + (mode === 'page-drift' ? 'x' : ''));
  if (req.url === '/assets/generations/${GENERATION_ID}/assets/index-abc.js') return send(res, 200,
    'text/javascript', mode === 'asset-drift' ? 'tampered' : fs.readFileSync(new URL('dist/assets/index-abc.js', root)));
  if (req.url === '/api/auth/login' && req.method === 'POST') {
    let body = ''; req.on('data', chunk => { body += chunk; });
    return req.on('end', () => {
      const given = JSON.parse(body);
      const ok = mode !== 'bad-login' && owner.username && given.username === owner.username && given.password === owner.password;
      send(res, ok ? 200 : 401, 'application/json', JSON.stringify(ok ? { success: true, token: 'tok-' + owner.username } : {}));
    });
  }
  if (req.url === '/api/auth/user' && req.headers.authorization === 'Bearer tok-' + owner.username) {
    return send(res, 200, 'application/json', JSON.stringify({ user: { username: owner.username } }));
  }
  send(res, 404, 'text/plain', 'nope');
}).listen(Number(process.env.SERVER_PORT), process.env.HOST);
`;

/** A fake generation archive whose runtime/node wraps the test's Node. */
function fakeGeneration(dir, mode) {
    const root = path.join(dir, `gen-${mode}`);
    fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist-server', 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'runtime', 'node'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'dist-server', 'server', 'bootstrap.js'), FAKE_SERVER);
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(root, 'MODE'), mode);
    fs.mkdirSync(path.join(root, 'dist', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'index.html'), INDEX_HTML);
    fs.writeFileSync(path.join(root, 'dist', 'assets', 'index-abc.js'), APP_JS);
    const appSha = createHash('sha256').update(APP_JS).digest('hex');
    fs.writeFileSync(path.join(root, 'dist', 'CLIENT_ASSET_MANIFEST.json'), JSON.stringify({ entries: [
        { path: 'assets/index-abc.js', sha256: mode === 'manifest-drift' ? '0'.repeat(64) : appSha }] }));
    const archive = path.join(dir, `gen-${mode}.tar.gz`);
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', root, '.']).status, 0);
    return archive;
}

const PROBE = `const m = await import('@anthropic-ai/claude-agent-sdk');
if (typeof m.query !== 'function') throw new Error('no query');
process.stdout.write(JSON.stringify({ sdk: 'ok' }) + '\\n');`;

function manifestWith(integrity) {
    return { version: '2.4.0.1', source: { commit: 'a'.repeat(40) }, externalPackages: [{ ...SDK, integrity }] };
}

test('the full smoke boots the generation, verifies /health, imports the fetched SDK and cleans up', async t => {
    const dir = scratch(t);
    const { bytes, integrity } = npmTarball(dir);
    process.env.NASSAJ_SMOKE_SENTINEL = 'must-not-leak';
    t.after(() => { delete process.env.NASSAJ_SMOKE_SENTINEL; });
    const result = await runBootSmoke({ archive: fakeGeneration(dir, 'ok'), manifest: manifestWith(integrity),
        expected: EXPECTED, scratchRoot: path.join(dir, 'scratch'), target: 'linux-x64-glibc',
        fetchImpl: registryFetch(bytes), probeSource: PROBE, timeoutMs: 15_000 });
    assert.deepEqual(result.probe, { sdk: 'ok' });
    assert.deepEqual(result.serving, { loginPage: '/login', asset: 'assets/index-abc.js', apiUser: 'ok' });
    assert.deepEqual(result.externalPackages, ['@anthropic-ai/claude-agent-sdk@0.3.283']);
    assert.ok(result.bootMs >= 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'scratch')), [], 'scratch removed');
});

test('a /health that reports another version fails the smoke with the mismatch', async t => {
    const dir = scratch(t);
    const { bytes, integrity } = npmTarball(dir);
    await assert.rejects(runBootSmoke({ archive: fakeGeneration(dir, 'wrong-version'), manifest: manifestWith(integrity),
        expected: EXPECTED, scratchRoot: path.join(dir, 'scratch'), target: 'linux-x64-glibc',
        fetchImpl: registryFetch(bytes), probeSource: PROBE, timeoutMs: 2_000 }),
    /boot_smoke_health_not_verified: sourceVersion: expected "2\.4\.0\.1", got "0\.0\.0\.1"/);
});

test('login page, client asset and API login faults each fail the smoke after /health passes', async t => {
    const dir = scratch(t);
    const { bytes, integrity } = npmTarball(dir);
    const cases = [
        ['page-drift', /boot_smoke_login_page_failed: not dist\/index\.html/],
        ['asset-drift', /boot_smoke_client_asset_failed: .*bytes differ/],
        ['manifest-drift', /boot_smoke_client_asset_failed: assets\/index-abc\.js does not match CLIENT_ASSET_MANIFEST/],
        ['bad-login', /boot_smoke_api_login_failed: HTTP 401/],
    ];
    for (const [mode, expected] of cases) {
        await assert.rejects(runBootSmoke({ archive: fakeGeneration(dir, mode), manifest: manifestWith(integrity),
            expected: EXPECTED, scratchRoot: path.join(dir, `scratch-${mode}`), target: 'linux-x64-glibc',
            fetchImpl: registryFetch(bytes), probeSource: PROBE, timeoutMs: 15_000 }), expected, mode);
    }
});

test('client and API checks refuse missing scripts, escaping paths, wrong types and wrong users', async t => {
    const dir = scratch(t);
    fs.mkdirSync(path.join(dir, 'dist', 'assets'), { recursive: true });
    const respond = routes => async url => {
        const hit = routes[new URL(url).pathname] ?? { status: 404, type: 'text/plain', body: '' };
        return { status: hit.status, headers: { get: () => hit.type }, arrayBuffer: async () => Buffer.from(hit.body) };
    };
    const serve = html => { fs.writeFileSync(path.join(dir, 'dist', 'index.html'), html);
        return { '/login': { status: 200, type: 'text/html', body: html } }; };
    const check = routes => verifyClientServing({ base: 'http://h', generationRoot: dir, fetchImpl: respond(routes) });
    await assert.rejects(check(serve('<p>no script</p>')), /boot_smoke_client_asset_failed: no module script/);
    await assert.rejects(check(serve('<script type="module" src="/assets/../../etc/passwd"></script>')),
        /boot_smoke_client_asset_failed: .*not in dist/);
    await assert.rejects(check({ '/login': { status: 200, type: 'application/json', body: '{}' } }),
        /boot_smoke_login_page_failed: HTTP 200 application\/json/);
    const owner = throwawayOwner();
    assert.match(owner.username, /^smoke-[0-9a-f]{12}$/);
    assert.ok(owner.password.length >= 24);
    const login = { '/api/auth/login': { status: 200, type: 'application/json', body: JSON.stringify({ token: 't' }) } };
    await assert.rejects(verifyApiLogin({ base: 'http://h', owner, fetchImpl: respond({ ...login,
        '/api/auth/user': { status: 200, type: 'application/json', body: JSON.stringify({ user: { username: 'other' } }) } }) }),
    /boot_smoke_api_user_failed: HTTP 200/);
    await assert.rejects(verifyApiLogin({ base: 'http://h', owner, fetchImpl: respond({ '/api/auth/login':
        { status: 200, type: 'application/json', body: 'not json' } }) }), /boot_smoke_api_login_failed/);
});

test('a server that exits during boot fails the smoke immediately', async t => {
    const dir = scratch(t);
    const { bytes, integrity } = npmTarball(dir);
    await assert.rejects(runBootSmoke({ archive: fakeGeneration(dir, 'exit'), manifest: manifestWith(integrity),
        expected: EXPECTED, scratchRoot: path.join(dir, 'scratch'), target: 'linux-x64-glibc',
        fetchImpl: registryFetch(bytes), probeSource: PROBE, timeoutMs: 15_000 }), /boot_smoke_server_exited/);
});

test('external packages: integrity, host, presence and availability are all enforced', async t => {
    const dir = scratch(t);
    const { bytes, integrity } = npmTarball(dir);
    const generationRoot = path.join(dir, 'g');
    fs.mkdirSync(path.join(dir, 'dl'));
    const place = (entry, fetchImpl) => placeExternalPackage({ entry, generationRoot, downloadDir: path.join(dir, 'dl'), fetchImpl });
    await assert.rejects(place({ ...SDK, integrity: sriSha512(Buffer.from('other')) }, registryFetch(bytes)),
        /external_package_integrity_mismatch/);
    await assert.rejects(place({ ...SDK, integrity, tarballUrl: 'https://mirror.example/sdk.tgz' }, registryFetch(bytes)),
        /external_package_host_refused/);
    await assert.rejects(place({ ...SDK, integrity }, registryFetch(bytes, 404)), /external_package_unavailable: .*0\.3\.283/);
    await place({ ...SDK, integrity }, registryFetch(bytes));
    assert.equal(fs.readFileSync(path.join(generationRoot, SDK.installPath, 'index.js'), 'utf8'),
        'export const query = () => 1;\n');
    await assert.rejects(place({ ...SDK, integrity }, registryFetch(bytes)), /excluded_package_shipped/);
});

test('the child environment is built from nothing and keeps all state in scratch', () => {
    process.env.CLAUDE_CONFIG_DIR = '/should/not/leak';
    try {
        const env = smokeEnvironment({ scratch: '/var/tmp/s', port: 4000, databasePath: '/var/tmp/s/data/db' });
        assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
        assert.equal(env.BOOTSTRAP_OWNER_USERNAME, undefined, 'no owner unless one is given');
        const owned = smokeEnvironment({ scratch: '/var/tmp/s', port: 1, databasePath: '/d', owner: { username: 'u', password: 'p' } });
        assert.deepEqual([owned.BOOTSTRAP_OWNER_USERNAME, owned.BOOTSTRAP_OWNER_PASSWORD], ['u', 'p']);
        assert.equal(env.HOME, '/var/tmp/s/home');
        assert.equal(env.SERVER_PORT, '4000');
        assert.equal(env.HOST, '127.0.0.1');
        assert.match(env.JWT_SECRET, /^[0-9a-f]{96}$/);
        assert.ok(Object.values(env).every(value => !value.startsWith('/') || value.startsWith('/var/tmp/s')
            || value === env.PATH));
    } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
    }
});

test('healthMismatches names each wrong field and accepts an exact match', () => {
    const expected = { pid: 7, version: '2.4.0.1', commit: 'a'.repeat(40), ...EXPECTED };
    const good = { status: 'ok', service: 'nassaj-server', normalAdmissionReady: true, pid: 7, sourceVersion: '2.4.0.1',
        serverLoadedOid: 'a'.repeat(40), serverLoadedBuildId: EXPECTED.serverBuildId, clientBuildIdServed: EXPECTED.clientBuildId };
    assert.deepEqual(healthMismatches(good, expected), []);
    assert.deepEqual(healthMismatches({ ...good, pid: 8, status: 'maintenance' }, expected).map(line => line.split(':')[0]),
        ['status', 'pid']);
    assert.deepEqual(healthMismatches(null, expected), ['health body is not an object']);
});

test('waitForHealth retries through errors and times out with the last reason', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNREFUSED');
        return { text: async () => JSON.stringify({ status: 'starting' }) };
    };
    await assert.rejects(waitForHealth({ port: 1, expected: { pid: 1 }, isRunning: () => true, timeoutMs: 120, pollMs: 20,
        fetchImpl }), /boot_smoke_health_not_verified: status: expected "ok"/);
    assert.ok(calls >= 2);
    await assert.rejects(waitForHealth({ port: 1, expected: {}, isRunning: () => false, timeoutMs: 100, fetchImpl }),
        /boot_smoke_server_exited/);
});

test('freePort returns a usable loopback port and sriSha512 matches npm format', async () => {
    const port = await freePort();
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
    assert.equal(sriSha512(Buffer.from('')),
        'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==');
});
