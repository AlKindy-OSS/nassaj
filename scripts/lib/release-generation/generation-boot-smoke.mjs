/**
 * Boot smoke for a built generation (ADR-174 §9.2 steps 0 and 5, §16 P1.12b).
 *
 * Extracts the archive into a disk scratch directory, places every external
 * package from the npm registry with its pinned integrity (the node-side fetch
 * of §6.2: no install scripts, files unmodified), then:
 *   1. runs a probe with the bundled Node that imports the Claude Agent SDK and
 *      its peers from the generation and loads every bundled native module;
 *   2. starts the server with the bundled Node on a temp database and a free
 *      port, in a clean environment whose HOME/XDG/state all live in scratch,
 *      and requires /health to report the expected version, commit and build
 *      ids from the same pid;
 *   3. requires the login page to be the generation's dist/index.html, its
 *      module script to be served byte-identical to the dist file (and its
 *      CLIENT_ASSET_MANIFEST entry), and an authenticated API round trip:
 *      the throwaway owner (random name and password, created by the app's
 *      own first-run bootstrap on the empty temp database) logs in and
 *      reads /api/auth/user;
 *   4. stops the whole process group and removes the scratch directory.
 * The environment is built from nothing, so the smoke can never reach the
 * operator's database, provider logins or live control root.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { NPM_REGISTRY_ORIGIN } from './release-manifest.mjs';

const HEALTH_LIMIT = 64 * 1024;
const PAGE_LIMIT = 1024 * 1024;
const ASSET_LIMIT = 32 * 1024 * 1024;
const MODULE_SCRIPT = /<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[^"?#]+)"/;
const GENERATION_PREFIX = /^\/assets\/generations\/[0-9a-f]{64}\//;
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';

/** Probe run by the bundled Node inside the generation (cwd = generation root). */
export const RUNTIME_PROBE_SOURCE = `
const sdk = await import('@anthropic-ai/claude-agent-sdk');
if (typeof sdk.query !== 'function') throw new Error('claude_sdk_query_missing');
for (const peer of ['@anthropic-ai/sdk', '@modelcontextprotocol/sdk/server/mcp.js', 'zod']) await import(peer);
const { createRequire } = await import('node:module');
const require = createRequire(process.cwd() + '/package.json');
const Database = require('better-sqlite3');
if (new Database(':memory:').prepare('select 1 as v').get().v !== 1) throw new Error('sqlite_probe_failed');
await require('argon2').hash('probe');
require('bcrypt').hashSync('probe', 4);
require('node-pty');
const { rgPath } = require('@vscode/ripgrep');
const rg = (await import('node:child_process')).spawnSync(rgPath, ['--version'], { encoding: 'utf8' });
if (rg.status !== 0) throw new Error('ripgrep_probe_failed');
process.stdout.write(JSON.stringify({ sdk: 'ok', natives: 'ok', node: process.version }) + '\\n');
`;

/**
 * sha512 SRI of bytes, as npm lockfiles record it.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function sriSha512(bytes) {
    return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/**
 * A throwaway first owner for the temp database: random name and password,
 * never a real credential, gone with the scratch directory.
 * @returns {{username: string, password: string}}
 */
export function throwawayOwner() {
    return { username: `smoke-${randomBytes(6).toString('hex')}`, password: randomBytes(24).toString('base64url') };
}

/**
 * The complete child environment: nothing is inherited from the caller.
 * @param {{scratch: string, port: number, databasePath: string, owner?: {username: string, password: string}}} input
 * @returns {Record<string, string>}
 */
export function smokeEnvironment({ scratch, port, databasePath, owner }) {
    const home = path.join(scratch, 'home');
    const bootstrap = owner ? { BOOTSTRAP_OWNER_USERNAME: owner.username, BOOTSTRAP_OWNER_PASSWORD: owner.password } : {};
    return {
        ...bootstrap,
        PATH: SYSTEM_PATH,
        HOME: home,
        LANG: 'C.UTF-8',
        TMPDIR: path.join(scratch, 'tmp'),
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        SERVER_PORT: String(port),
        DATABASE_PATH: databasePath,
        JWT_SECRET: randomBytes(48).toString('hex'),
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_DATA_HOME: path.join(home, '.local', 'share'),
        XDG_STATE_HOME: path.join(home, '.local', 'state'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_RUNTIME_DIR: path.join(scratch, 'run'),
    };
}

/**
 * List every way a /health body differs from the expected identity.
 * @param {unknown} health parsed /health JSON
 * @param {{pid: number, version: string, commit: string, serverBuildId: string, clientBuildId: string}} expected
 * @returns {string[]} mismatch descriptions (empty = verified)
 */
export function healthMismatches(health, expected) {
    const want = {
        status: 'ok', service: 'nassaj-server', normalAdmissionReady: true, pid: expected.pid,
        sourceVersion: expected.version, serverLoadedOid: expected.commit,
        serverLoadedBuildId: expected.serverBuildId, clientBuildIdServed: expected.clientBuildId,
    };
    if (!health || typeof health !== 'object') return ['health body is not an object'];
    return Object.entries(want)
        .filter(([key, value]) => health[key] !== value)
        .map(([key, value]) => `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(health[key])}`);
}

/** A free loopback TCP port (released before return; the race is tolerated). */
export function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function runChecked(run, command, args, options, code) {
    const result = run(command, args, { encoding: 'utf8', ...options });
    if (result.status !== 0) throw new Error(`${code}: ${(result.stderr || result.error?.message || '').trim().slice(-2000)}`);
    return result;
}

/**
 * Extract the generation archive (modes kept, owner not).
 * @param {string} archive
 * @param {string} destination created by this call
 * @param {typeof spawnSync} [run]
 */
export function extractGeneration(archive, destination, run = spawnSync) {
    fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
    runChecked(run, 'tar', ['-xzpf', archive, '-C', destination, '--no-same-owner'], {}, 'generation_extract_failed');
}

/**
 * Fetch one external package from the npm registry, check integrity, and
 * unpack it unmodified at its install path (which must not exist yet).
 * @param {object} input
 * @param {{name: string, version: string, integrity: string, tarballUrl: string, installPath: string}} input.entry
 * @param {string} input.generationRoot
 * @param {string} input.downloadDir
 * @param {typeof fetch} [input.fetchImpl]
 * @param {typeof spawnSync} [input.run]
 */
export async function placeExternalPackage({ entry, generationRoot, downloadDir, fetchImpl = fetch, run = spawnSync }) {
    if (!entry.tarballUrl.startsWith(`${NPM_REGISTRY_ORIGIN}/`)) throw new Error(`external_package_host_refused: ${entry.name}`);
    const destination = path.join(generationRoot, ...entry.installPath.split('/'));
    if (fs.existsSync(destination)) throw new Error(`excluded_package_shipped: ${entry.installPath} exists in the generation`);
    const response = await fetchImpl(entry.tarballUrl, { redirect: 'error' });
    if (!response.ok) throw new Error(`external_package_unavailable: ${entry.name}@${entry.version} (HTTP ${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sriSha512(bytes) !== entry.integrity) throw new Error(`external_package_integrity_mismatch: ${entry.name}@${entry.version}`);
    const tarball = path.join(downloadDir, `${entry.name.replace('/', '__')}-${entry.version}.tgz`);
    fs.writeFileSync(tarball, bytes, { flag: 'wx', mode: 0o600 });
    fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
    runChecked(run, 'tar', ['-xzf', tarball, '-C', destination, '--strip-components=1', '--no-same-owner'], {},
        'external_package_extract_failed');
}

async function readHealth(port, fetchImpl) {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`,
        { redirect: 'error', signal: AbortSignal.timeout(1500) });
    const text = await response.text();
    if (text.length > HEALTH_LIMIT) throw new Error('health response exceeds limit');
    return JSON.parse(text);
}

/**
 * Poll /health until it matches `expected` or the deadline passes.
 * @returns {Promise<{health: object, elapsedMs: number}>}
 */
export async function waitForHealth({ port, expected, isRunning, timeoutMs, fetchImpl = fetch, pollMs = 200 }) {
    const started = Date.now();
    let last = ['no response yet'];
    while (Date.now() - started < timeoutMs) {
        if (!isRunning()) throw new Error(`boot_smoke_server_exited: last /health check: ${last.join('; ')}`);
        try {
            const health = await readHealth(port, fetchImpl);
            last = healthMismatches(health, expected);
            if (last.length === 0) return { health, elapsedMs: Date.now() - started };
        } catch (error) {
            last = [String(error?.message || error)];
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new Error(`boot_smoke_health_not_verified: ${last.join('; ')}`);
}

async function fetchLimited(fetchImpl, url, init, limit) {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(5000), ...init });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(`boot_smoke_response_oversize: ${url}`);
    return { status: response.status, type: response.headers?.get?.('content-type') ?? '', bytes };
}

const smokeFail = (check, detail) => { throw new Error(`boot_smoke_${check}_failed: ${detail}`); };

/**
 * Login page and one static client asset, both tied to the generation's dist.
 * @returns {Promise<{loginPage: string, asset: string}>}
 */
export async function verifyClientServing({ base, generationRoot, fetchImpl = fetch }) {
    const dist = path.join(generationRoot, 'dist');
    const page = await fetchLimited(fetchImpl, `${base}/login`, {}, PAGE_LIMIT);
    if (page.status !== 200 || !page.type.startsWith('text/html')) smokeFail('login_page', `HTTP ${page.status} ${page.type}`);
    if (!page.bytes.equals(fs.readFileSync(path.join(dist, 'index.html')))) smokeFail('login_page', 'not dist/index.html');
    const src = MODULE_SCRIPT.exec(page.bytes.toString('utf8'))?.[1] ?? smokeFail('client_asset', 'no module script');
    // /assets/generations/<id>/<path under dist> or /assets/<file> (client-publication-static.js).
    const relative = src.replace(GENERATION_PREFIX, '/').slice(1);
    const file = path.join(dist, ...relative.split('/'));
    if (relative.split('/').includes('..') || !fs.existsSync(file)) smokeFail('client_asset', `${relative} not in dist`);
    const asset = await fetchLimited(fetchImpl, `${base}${src}`, {}, ASSET_LIMIT);
    const digest = createHash('sha256').update(asset.bytes).digest('hex');
    const onDisk = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (asset.status !== 200 || digest !== onDisk) smokeFail('client_asset', `${src} HTTP ${asset.status}, bytes differ`);
    const manifestFile = path.join(dist, 'CLIENT_ASSET_MANIFEST.json');
    if (fs.existsSync(manifestFile)) {
        const entry = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).entries?.find(item => item.path === relative);
        if (entry?.sha256 !== digest) smokeFail('client_asset', `${relative} does not match CLIENT_ASSET_MANIFEST`);
    }
    return { loginPage: '/login', asset: relative };
}

/**
 * Authenticated API round trip with the throwaway owner.
 * @returns {Promise<{apiUser: string}>}
 */
export async function verifyApiLogin({ base, owner, fetchImpl = fetch }) {
    const json = response => { try { return JSON.parse(response.bytes.toString('utf8')); } catch { return null; } };
    const login = await fetchLimited(fetchImpl, `${base}/api/auth/login`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(owner) }, HEALTH_LIMIT);
    const token = json(login)?.token;
    if (login.status !== 200 || typeof token !== 'string' || !token) smokeFail('api_login', `HTTP ${login.status}`);
    const me = await fetchLimited(fetchImpl, `${base}/api/auth/user`, { headers: { authorization: `Bearer ${token}` } },
        HEALTH_LIMIT);
    const username = json(me)?.user?.username;
    if (me.status !== 200 || username !== owner.username) smokeFail('api_user', `HTTP ${me.status}`);
    return { apiUser: 'ok' };
}

function startServer(generationRoot, env, logFile) {
    const log = fs.openSync(logFile, 'a', 0o600);
    try {
        return spawn(path.join(generationRoot, 'runtime', 'node'), ['dist-server/server/bootstrap.js'],
            { cwd: generationRoot, env, detached: true, stdio: ['ignore', log, log] });
    } finally {
        fs.closeSync(log);
    }
}

async function stopProcessGroup(child, exited) {
    if (exited()) return;
    const signalGroup = signal => { try { process.kill(-child.pid, signal); } catch { /* group already gone */ } };
    signalGroup('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (!exited() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    signalGroup('SIGKILL');
}

function prepareScratch(scratchRoot) {
    fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    const scratch = fs.mkdtempSync(path.join(scratchRoot, 'boot-smoke-'));
    for (const directory of ['home', 'tmp', 'run', 'data', 'downloads']) {
        fs.mkdirSync(path.join(scratch, directory), { mode: 0o700 });
    }
    return scratch;
}

/**
 * The server resolves its update control root from a git common dir (source
 * mode) or the retired release-layout-v2 contract; the attested layout (§5.3,
 * Phase 2) is not implemented yet. Until then the smoke gives the scratch
 * copy an empty git repository so the server boots in source mode.
 */
function sourceModeAccommodation(generationRoot, run) {
    runChecked(run, 'git', ['init', '-q', generationRoot], {}, 'boot_smoke_git_init_failed');
}

function runProbe(generationRoot, env, source) {
    const result = runChecked(spawnSync, path.join(generationRoot, 'runtime', 'node'),
        ['--input-type=module', '-e', source], { cwd: generationRoot, env, timeout: 120_000 },
        'boot_smoke_runtime_probe_failed');
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

async function bootAndVerify({ generationRoot, scratch, manifest, expected, timeoutMs, fetchImpl }) {
    const port = await freePort();
    const owner = throwawayOwner();
    const env = smokeEnvironment({ scratch, port, databasePath: path.join(scratch, 'data', 'nassaj.db'), owner });
    const logFile = path.join(scratch, 'server.log');
    const child = startServer(generationRoot, env, logFile);
    let exited = false;
    child.once('exit', () => { exited = true; });
    try {
        const verified = await waitForHealth({ port, isRunning: () => !exited, timeoutMs, fetchImpl,
            expected: { ...expected, pid: child.pid, version: manifest.version, commit: manifest.source.commit } });
        const base = `http://127.0.0.1:${port}`;
        const client = await verifyClientServing({ base, generationRoot, fetchImpl });
        const api = await verifyApiLogin({ base, owner, fetchImpl });
        return { bootMs: verified.elapsedMs, port, serving: { ...client, ...api } };
    } catch (error) {
        const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-3000) : '';
        throw new Error(`${error.message}\n--- server log tail ---\n${tail}`);
    } finally {
        await stopProcessGroup(child, () => exited);
    }
}

/**
 * Run the full boot smoke and clean up.
 * @param {object} input
 * @param {string} input.archive generation archive
 * @param {object} input.manifest validated release manifest
 * @param {{serverBuildId: string, clientBuildId: string}} input.expected build ids from the build
 * @param {string} input.scratchRoot disk directory for scratch (never tmpfs)
 * @param {string} input.target release target
 * @param {boolean} [input.keep] keep the scratch directory for diagnosis
 * @param {number} [input.timeoutMs] boot deadline
 * @param {typeof fetch} [input.fetchImpl]
 * @param {string} [input.probeSource] module source run by the bundled Node before boot
 * @returns {Promise<{bootMs: number, probe: object, externalPackages: string[], serving: object,
 *   scratch: string|null}>}
 */
export async function runBootSmoke({ archive, manifest, expected, scratchRoot, target, keep = false,
    timeoutMs = 90_000, fetchImpl = fetch, probeSource = RUNTIME_PROBE_SOURCE }) {
    const scratch = prepareScratch(scratchRoot);
    const generationRoot = path.join(scratch, 'generation');
    try {
        extractGeneration(archive, generationRoot);
        const external = manifest.externalPackages.filter(entry => entry.target === undefined || entry.target === target);
        for (const entry of external) {
            await placeExternalPackage({ entry, generationRoot, downloadDir: path.join(scratch, 'downloads'), fetchImpl });
        }
        const probeEnv = smokeEnvironment({ scratch, port: 0, databasePath: path.join(scratch, 'data', 'probe.db') });
        const probe = runProbe(generationRoot, probeEnv, probeSource);
        sourceModeAccommodation(generationRoot, spawnSync);
        const boot = await bootAndVerify({ generationRoot, scratch, manifest, expected, timeoutMs, fetchImpl });
        return { bootMs: boot.bootMs, probe, externalPackages: external.map(entry => `${entry.name}@${entry.version}`),
            serving: boot.serving, scratch: keep ? scratch : null };
    } finally {
        if (!keep) fs.rmSync(scratch, { recursive: true, force: true });
    }
}
