import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
    assertNoUntrackedTrace, deriveReleaseSource, fetchGitHubHostKeys, generateEcosystem, installNode,
    installPm2Entry, prepareServedClientGeneration, probeEnvironment, probeGitHubSsh, readRemoteUrl,
    seedFirstBuildDirectories, setRemoteSsh, sshConfigBlock, verifyReleaseFetch, writeKnownHosts,
    writeNodeEnv, writeReleaseSourceLock, writeSshConfig,
} from './install-node.mjs';
import { resolveReleaseSource } from '../server/services/release-source-config.js';
import { createClientAssetManifest, validateClientAssetManifest, verifyAssetClosure } from './lib/client-publication-artifacts.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const SOURCE_ROOT = path.resolve(new URL('..', import.meta.url).pathname);

/** Every key GitHub publishes, shaped exactly as `api.github.com/meta` returns them. */
const META_KEYS = [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT',
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt',
];

function temporaryDirectory(t, prefix) {
    const root = mkdtempSync(path.join(TEMP, prefix));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

/** A node tree with exactly the tracked files the installer reads. */
function fixtureAppRoot(t) {
    const root = temporaryDirectory(t, 'nassaj-install-node-');
    mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    for (const file of [
        'scripts/pm2-entry.mjs', 'scripts/nassaj-release-launcher.mjs', 'ecosystem.config.example.cjs',
        'scripts/lib/pm2-install-layout.cjs',
    ]) {
        copyFileSync(path.join(SOURCE_ROOT, file), path.join(root, file));
    }
    writeFileSync(path.join(root, '.gitignore'), '/config/\ndist/\ndist-server/\n');
    return root;
}

/** The minimal sealed-store shape the release entry needs: current -> releases/<generation>. */
function sealedDeployRoot(t) {
    const root = temporaryDirectory(t, 'nassaj-deploy-sealed-');
    mkdirSync(path.join(root, 'releases', 'gen-1'), { recursive: true });
    writeFileSync(path.join(root, 'releases', 'gen-1', 'runtime-generation.json'), '{}\n');
    symlinkSync(path.join('releases', 'gen-1'), path.join(root, 'current'));
    return root;
}

/** Load a generated ecosystem as `pm2 start` would, without leaking its env writes. */
function loadEcosystem(file) {
    const load = createRequire(file);
    const saved = { ...process.env };
    try {
        for (const key of Object.keys(load.cache)) delete load.cache[key];
        return load(file).apps[0];
    } finally {
        for (const key of ['NASSAJ_INSTALL_LAYOUT', 'NASSAJ_DEPLOY_ROOT']) {
            if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
    }
}

/** A `fetch` that never leaves the process. */
function fakeFetch(body, { ok = true, status = 200 } = {}) {
    return async () => ({ ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
}

/**
 * A `spawnSync` driven by an ordered list of matchers, so a test states the exact
 * command sequence it expects rather than pattern-matching loosely.
 */
function fakeSpawn(handlers) {
    const calls = [];
    const spawn = (command, args, options) => {
        calls.push({ command, args, options });
        const handler = handlers.find((entry) => entry.match(command, args));
        if (!handler) throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        return { status: handler.status ?? 0, stdout: handler.stdout ?? '', stderr: handler.stderr ?? '' };
    };
    spawn.calls = calls;
    return spawn;
}

const gitArgs = (args, ...expected) => expected.every((token, index) => args[index + 2] === token);

test('the release source is derived from origin, in either supported URL shape (ADR-156 هـ.2)', () => {
    for (const url of [
        'git@github.com:your-org/nassaj-dev.git',
        'https://github.com/your-org/nassaj-dev',
        'https://github.com/your-org/nassaj-dev.git',
    ]) {
        const source = deriveReleaseSource(url);
        assert.equal(source.identity, 'github.com/your-org/nassaj-dev');
        assert.equal(source.sshUrl, 'git@github.com:your-org/nassaj-dev.git');
    }
});

test('a credentialed or non-GitHub remote is refused rather than written raw (ADR-156 هـ.2.2)', () => {
    for (const url of ['https://user:token@github.com/your-org/nassaj-dev', 'https://gitlab.com/a/b', 'origin']) {
        assert.throws(() => deriveReleaseSource(url), (error) => error.code === 'remote_not_derivable');
    }
});

test('a missing remote stops with one action instead of guessing (B-1053)', () => {
    const spawn = fakeSpawn([{ match: (c, a) => c === 'git' && gitArgs(a, 'remote', 'get-url'), status: 2, stderr: 'no such remote' }]);
    assert.throws(() => readRemoteUrl({ appRoot: '/nowhere', spawn }), (error) => {
        assert.equal(error.code, 'remote_absent');
        assert.match(error.action, /remote add origin git@github\.com/);
        return true;
    });
});

test('origin is moved onto SSH, and an already-SSH remote is left untouched', () => {
    const https = fakeSpawn([
        { match: (c, a) => gitArgs(a, 'remote', 'get-url'), stdout: 'https://github.com/your-org/nassaj-dev' },
        { match: (c, a) => gitArgs(a, 'remote', 'set-url'), status: 0 },
    ]);
    const moved = setRemoteSsh({ appRoot: '/n', sshUrl: 'git@github.com:your-org/nassaj-dev.git', spawn: https });
    assert.equal(moved.changed, true);
    assert.equal(https.calls.length, 2);

    const already = fakeSpawn([
        { match: (c, a) => gitArgs(a, 'remote', 'get-url'), stdout: 'git@github.com:your-org/nassaj-dev.git' },
    ]);
    assert.equal(setRemoteSsh({ appRoot: '/n', sshUrl: 'git@github.com:your-org/nassaj-dev.git', spawn: already }).changed, false);
    assert.equal(already.calls.length, 1);
});

test('host keys come from the GitHub meta document, never from a constant in the tree (ADR-156 ك.2)', async () => {
    const keys = await fetchGitHubHostKeys({ fetch: fakeFetch({ ssh_keys: META_KEYS }) });
    assert.deepEqual(keys, META_KEYS);
    assert.equal(readFileSync(path.join(SOURCE_ROOT, 'scripts/install-node.mjs'), 'utf8').includes(META_KEYS[0]), false);
});

test('a partial or unreadable meta document fails closed', async () => {
    await assert.rejects(fetchGitHubHostKeys({ fetch: fakeFetch({ ssh_keys: META_KEYS.slice(0, 2) }) }),
        (error) => error.code === 'host_keys_incomplete');
    await assert.rejects(fetchGitHubHostKeys({ fetch: fakeFetch('not json') }),
        (error) => error.code === 'host_keys_invalid');
    await assert.rejects(fetchGitHubHostKeys({ fetch: fakeFetch({}, { ok: false, status: 503 }) }),
        (error) => error.code === 'host_keys_unreachable');
});

test('known_hosts keeps foreign hosts, replaces stale github entries and adds the 443 alias', (t) => {
    const home = temporaryDirectory(t, 'nassaj-known-hosts-');
    const file = path.join(home, 'known_hosts');
    writeFileSync(file, [
        'gitlab.com ssh-ed25519 AAAAkeep',
        'github.com ssh-rsa AAAAstale',
        '[ssh.github.com]:443 ssh-rsa AAAAstale',
        '|1|hashed|entry ssh-ed25519 AAAAhashed',
    ].join('\n'));

    const result = writeKnownHosts({ knownHostsPath: file, keys: META_KEYS });
    const written = readFileSync(file, 'utf8');
    assert.equal(result.replaced, 2);
    assert.equal(result.hashedEntries, 1);
    assert.match(written, /^gitlab\.com ssh-ed25519 AAAAkeep$/m);
    assert.match(written, /^\|1\|hashed\|entry /m);
    assert.equal(written.includes('AAAAstale'), false);
    for (const key of META_KEYS) {
        assert.equal(written.includes(`github.com ${key}`), true);
        assert.equal(written.includes(`[ssh.github.com]:443 ${key}`), true);
    }
});

test('the probe falls back to ssh.github.com:443 only when port 22 is actually blocked', () => {
    const blocked = fakeSpawn([
        { match: (c, a) => c === 'ssh' && a.at(-1) === 'git@github.com', status: 255, stderr: 'ssh: connect to host github.com port 22: Connection timed out' },
        { match: (c, a) => c === 'ssh' && a.at(-1) === 'git@ssh.github.com', status: 1, stderr: "Hi node! You've successfully authenticated, but GitHub does not provide shell access." },
    ]);
    const fallback = probeGitHubSsh({ spawn: blocked });
    assert.equal(fallback.port, 443);
    assert.equal(fallback.outcome, 'authenticated');
    assert.equal(blocked.calls[1].args.includes('443'), true);

    const open = fakeSpawn([
        { match: (c, a) => c === 'ssh' && a.at(-1) === 'git@github.com', status: 1, stderr: "Hi node! You've successfully authenticated" },
    ]);
    assert.equal(probeGitHubSsh({ spawn: open }).port, 22);
    assert.equal(open.calls.length, 1, 'a working port 22 must not be probed on 443');
});

test('a missing key is reported as a key problem, not as a blocked port', () => {
    const spawn = fakeSpawn([
        { match: (c) => c === 'ssh', status: 255, stderr: 'git@github.com: Permission denied (publickey).' },
    ]);
    const probe = probeGitHubSsh({ spawn });
    assert.equal(probe.outcome, 'key_missing');
    assert.equal(spawn.calls.length, 1, 'a missing key is just as missing on 443');
});

test('the ssh config stanza is written first and is replaced, not duplicated, on a re-run', (t) => {
    const home = temporaryDirectory(t, 'nassaj-ssh-config-');
    const file = path.join(home, 'config');
    writeFileSync(file, 'Host internal\n    User builder\n');

    writeSshConfig({ sshConfigPath: file });
    let text = readFileSync(file, 'utf8');
    assert.equal(text.indexOf('Host github.com') < text.indexOf('Host internal'), true);
    assert.match(text, /Hostname ssh\.github\.com\n {4}Port 443/);
    assert.match(text, /Host internal/);

    writeSshConfig({ sshConfigPath: file });
    text = readFileSync(file, 'utf8');
    assert.equal(text.split('Host github.com').length - 1, 1);
    assert.equal(text.includes(sshConfigBlock().trim()), true);
});

test('the fetch probe runs under the updater environment, with no token and no richer credential (ADR-156 م-1)', () => {
    const environment = probeEnvironment({ GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', NASSAJ_UPDATE_REMOTE: 'origin', SSH_AUTH_SOCK: '/run/agent' },
        { knownHostsPath: '/home/service/.ssh/known_hosts' });
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.NASSAJ_UPDATE_REMOTE, undefined);
    assert.equal(environment.SSH_AUTH_SOCK, '/run/agent', 'the node\'s own agent is what the fetch will use');
    assert.equal(environment.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.match(environment.GIT_SSH_COMMAND, /BatchMode=yes/);
    assert.match(environment.GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/);
    assert.match(environment.GIT_SSH_COMMAND, /UserKnownHostsFile=\/home\/service\/\.ssh\/known_hosts/);
});

test('ls-remote proves the credential-free fetch, and a missing key yields the deploy-key instruction (B-1053)', () => {
    const ok = fakeSpawn([{ match: (c, a) => gitArgs(a, 'ls-remote'), stdout: 'abc\tHEAD' }]);
    assert.equal(verifyReleaseFetch({ appRoot: '/n', sshUrl: 'git@github.com:your-org/nassaj-dev.git', spawn: ok, env: {} }).ok, true);
    assert.equal(ok.calls[0].args.includes('--heads'), false, 'HEAD alone answers reachability');

    const denied = fakeSpawn([{ match: (c, a) => gitArgs(a, 'ls-remote'), status: 128, stderr: 'git@github.com: Permission denied (publickey).' }]);
    assert.throws(() => verifyReleaseFetch({ appRoot: '/n', sshUrl: 'git@github.com:your-org/nassaj-dev.git', spawn: denied, env: {} }), (error) => {
        assert.equal(error.code, 'release_fetch_key_missing');
        assert.match(error.action, /deploy key with write access OFF/);
        return true;
    });
});

test('node.env and the TOFU pin agree, and the boot reader accepts that pair (ADR-156 هـ.3)', (t) => {
    const configDir = temporaryDirectory(t, 'nassaj-node-config-');
    const written = writeNodeEnv({
        configDir,
        values: { NASSAJ_RELEASE_SOURCE: 'git@github.com:your-org/nassaj-dev.git', TMPDIR: '/var/tmp' },
    });
    assert.match(readFileSync(written.path, 'utf8'), /^NASSAJ_RELEASE_SOURCE=git@github\.com:your-org\/nassaj-dev\.git$/m);

    const lock = writeReleaseSourceLock({
        configDir, identity: 'github.com/your-org/nassaj-dev',
        repositoryUrl: 'git@github.com:your-org/nassaj-dev.git', confirmedBy: 'svc@node',
    });
    assert.equal(lock.changed, true);

    const resolved = resolveReleaseSource(
        { NASSAJ_RELEASE_SOURCE: 'git@github.com:your-org/nassaj-dev.git' }, { lockPath: lock.path });
    assert.equal(resolved.pinnedIdentity, 'github.com/your-org/nassaj-dev');
});

test('a pin that contradicts the environment fails the boot closed, with no silent winner (ADR-156 هـ.3)', (t) => {
    const configDir = temporaryDirectory(t, 'nassaj-lock-mismatch-');
    const lock = writeReleaseSourceLock({
        configDir, identity: 'github.com/your-org/nassaj-dev',
        repositoryUrl: 'git@github.com:your-org/nassaj-dev.git', confirmedBy: 'svc@node',
    });
    assert.throws(
        () => resolveReleaseSource({ NASSAJ_RELEASE_SOURCE: 'https://github.com/AlKindy-OSS/nassaj' }, { lockPath: lock.path }),
        (error) => {
            assert.equal(error.message, 'release_source_lock_mismatch');
            assert.equal(error.pinnedIdentity, 'github.com/your-org/nassaj-dev');
            assert.equal(error.configuredIdentity, 'github.com/alkindy-oss/nassaj');
            return true;
        });
});

test('a corrupt pin is not treated as an absent pin', (t) => {
    const configDir = temporaryDirectory(t, 'nassaj-lock-corrupt-');
    const lockPath = path.join(configDir, 'release-source.lock.json');
    writeFileSync(lockPath, '{"schema":"nassaj-release-source-lock/v1","identity":"github.com/a/b"}');
    assert.throws(() => resolveReleaseSource({ NASSAJ_RELEASE_SOURCE: 'https://github.com/a/b' }, { lockPath }),
        /release_source_lock_invalid/);
    assert.equal(resolveReleaseSource({}, { lockPath: path.join(configDir, 'absent.json') }).pinnedIdentity, undefined);
});

test('re-pinning the same identity is idempotent; a different identity is refused (ADR-156 هـ.2.4)', (t) => {
    const configDir = temporaryDirectory(t, 'nassaj-lock-tofu-');
    const args = {
        configDir, identity: 'github.com/your-org/nassaj-dev',
        repositoryUrl: 'git@github.com:your-org/nassaj-dev.git', confirmedBy: 'svc@node',
    };
    writeReleaseSourceLock(args);
    assert.equal(writeReleaseSourceLock(args).changed, false);
    assert.throws(() => writeReleaseSourceLock({ ...args, identity: 'github.com/other/repo' }),
        (error) => error.code === 'release_source_lock_conflict');
});

test('the release entry is never placed onto a deploy root with no sealed store (qa-critic C3)', (t) => {
    const appRoot = fixtureAppRoot(t);
    const deployRoot = temporaryDirectory(t, 'nassaj-deploy-bare-');
    assert.throws(() => installPm2Entry({ appRoot, deployRoot }), (error) => {
        assert.equal(error.code, 'release_layout_absent');
        assert.match(error.action, /Omit --release-layout/);
        return true;
    });
    assert.equal(existsOrNull(path.join(deployRoot, 'launcher', 'pm2-entry.mjs')), null);
});

test('the pm2 entry is installed beside the launcher it was reviewed against (memo item 4)', (t) => {
    const appRoot = fixtureAppRoot(t);
    const deployRoot = sealedDeployRoot(t);
    const result = installPm2Entry({ appRoot, deployRoot });
    assert.equal(result.changed, true);
    for (const name of ['pm2-entry.mjs', 'nassaj-release-launcher.mjs']) {
        assert.deepEqual(
            readFileSync(path.join(deployRoot, 'launcher', name)),
            readFileSync(path.join(appRoot, 'scripts', name)));
    }
    assert.equal(installPm2Entry({ appRoot, deployRoot }).changed, false);
});

test('a git checkout boots its own built server from its own tree (qa-critic C3)', (t) => {
    const appRoot = fixtureAppRoot(t);
    const configDir = path.join(appRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    writeNodeEnv({ configDir, values: { NASSAJ_RELEASE_SOURCE: 'git@github.com:your-org/nassaj-dev.git' } });
    const previous = process.env.NASSAJ_DEPLOY_ROOT;
    // A stale release root in the operator's shell must not leak into a git node.
    process.env.NASSAJ_DEPLOY_ROOT = '/opt/stale-release';
    t.after(() => { if (previous === undefined) delete process.env.NASSAJ_DEPLOY_ROOT; else process.env.NASSAJ_DEPLOY_ROOT = previous; });
    const generated = generateEcosystem({
        appRoot, configDir, node: 'fleet-node', port: '3011',
        databasePath: '/opt/nassaj/data/store.db', processName: 'nassaj-trav',
    });
    assert.equal(generated.path, path.join(configDir, 'ecosystem.fleet-node.config.cjs'));
    assert.equal(generated.layout, 'git-checkout-v2');

    const app = loadEcosystem(generated.path);
    assert.equal(app.name, 'nassaj-trav');
    assert.equal(app.args, '--port 3011');
    assert.equal(app.script, path.join(appRoot, 'dist-server', 'server', 'index.js'));
    assert.equal(app.cwd, appRoot, 'pm2 cwd is the app root, not config/ (doctor service-account check)');
    assert.equal(app.env.NASSAJ_INSTALL_LAYOUT, 'git-checkout-v2');
    assert.equal(app.env.NASSAJ_DEPLOY_ROOT, undefined);
    assert.equal(app.env.PROC_NAME, 'nassaj-trav');
    assert.equal(app.env.NASSAJ_PROCESS_NAME, 'nassaj-trav');
    assert.equal(app.env.NASSAJ_RELEASE_SOURCE, 'git@github.com:your-org/nassaj-dev.git');
    assert.equal(app.env.DATABASE_PATH, '/opt/nassaj/data/store.db');
    assert.equal(app.env.TMPDIR, '/var/tmp');
    assert.equal(app.treekill, false, 'the drain contract stays owned by the tracked example');
    assert.equal(app.kill_timeout, 86400000);
});

test('the release layout keeps the release-borne entry behind its explicit flag', (t) => {
    const appRoot = fixtureAppRoot(t);
    const configDir = path.join(appRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    const generated = generateEcosystem({
        appRoot, configDir, layout: 'artifact-runtime-v2', deployRoot: '/opt/nassaj', node: 'sealed',
    });
    const app = loadEcosystem(generated.path);
    assert.equal(app.script, '/opt/nassaj/launcher/pm2-entry.mjs');
    assert.equal(app.cwd, undefined);
    assert.equal(app.env.NASSAJ_DEPLOY_ROOT, '/opt/nassaj');
    assert.equal(app.env.NASSAJ_INSTALL_LAYOUT, 'artifact-runtime-v2');
    assert.throws(() => generateEcosystem({ appRoot, configDir, layout: 'artifact-runtime-v2', node: 'sealed' }),
        (error) => error.code === 'deploy_root_invalid');
    assert.throws(() => generateEcosystem({ appRoot, configDir, layout: 'tarball', node: 'x' }), /Unknown install layout/);
});

test('a generated file that points PM2 elsewhere is refused before it is reported', (t) => {
    const appRoot = fixtureAppRoot(t);
    const configDir = path.join(appRoot, 'config');
    mkdirSync(configDir, { recursive: true });
    // The pre-C3 example: every layout inherited the sealed-release entry.
    writeFileSync(path.join(appRoot, 'ecosystem.config.example.cjs'),
        "module.exports = { apps: [{ name: 'n', script: '/opt/n/launcher/pm2-entry.mjs', env: {} }] };\n");
    assert.throws(() => generateEcosystem({ appRoot, configDir, node: 'drift' }), (error) => {
        assert.equal(error.code, 'ecosystem_entry_mismatch');
        assert.match(error.message, /dist-server\/server\/index\.js/);
        return true;
    });
});

test('an unsafe node or process name never reaches the generated file', (t) => {
    const appRoot = fixtureAppRoot(t);
    const configDir = path.join(appRoot, 'config');
    for (const node of ['../escape', 'Node Name', '']) {
        assert.throws(() => generateEcosystem({ appRoot, configDir, deployRoot: '/opt/n', node }),
            (error) => error.code === 'node_name_invalid');
    }
    assert.throws(() => generateEcosystem({ appRoot, configDir, deployRoot: '/opt/n', node: 'ok', processName: 'a b' }),
        (error) => error.code === 'process_name_invalid');
});

test('the first build on a fresh install finds the directories it refuses to create (B-1060)', (t) => {
    const appRoot = fixtureAppRoot(t);
    assert.deepEqual(seedFirstBuildDirectories({ appRoot }).created, ['dist', 'dist/assets', 'dist-server']);
    assert.deepEqual(seedFirstBuildDirectories({ appRoot }).created, []);
});

/** A candidate-built dist: index.html referencing a generation, sealed by the shared manifest contract. */
function sealDist(appRoot, build = 'c'.repeat(64), source = 'a'.repeat(40)) {
    const dist = path.join(appRoot, 'dist');
    mkdirSync(path.join(dist, 'assets'), { recursive: true });
    writeFileSync(path.join(dist, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: source, buildId: build, generationId: build }));
    writeFileSync(path.join(dist, 'index.html'), `<script src="/assets/generations/${build}/assets/app.js"></script>`);
    writeFileSync(path.join(dist, 'assets', 'app.js'), `console.log('${build}')`);
    createClientAssetManifest(dist, { generationId: build, sourceOid: source, buildId: build }, verifyAssetClosure);
    return build;
}

test('the installer prepares the served-generation archive a candidate dist requires (B-1293)', (t) => {
    const appRoot = fixtureAppRoot(t);
    const generationId = sealDist(appRoot);
    const served = path.join(appRoot, '.nassaj-local-preview', 'client-assets', 'generations', generationId);

    const first = prepareServedClientGeneration({ appRoot });
    assert.equal(first.prepared, true);
    assert.equal(first.generationId, generationId);
    assert.equal(first.destination, served);
    // The served copy is a valid sealed generation the static middleware can serve.
    assert.equal(validateClientAssetManifest(served, {}, verifyAssetClosure).manifest.generationId, generationId);

    // Idempotent: a second run revalidates and returns the same path without throwing or recopying.
    assert.deepEqual(prepareServedClientGeneration({ appRoot }), first);
});

test('preparing the served archive is a no-op when dist carries no sealed manifest (B-1293)', (t) => {
    const appRoot = fixtureAppRoot(t);
    mkdirSync(path.join(appRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(appRoot, 'dist', 'index.html'), '<!doctype html>');
    assert.deepEqual(prepareServedClientGeneration({ appRoot }), { prepared: false, reason: 'no_sealed_dist' });
});

test('the installer refuses to leave an untracked file in the install root (B-1050)', () => {
    const spawn = fakeSpawn([{ match: (c, a) => a.includes('check-ignore'), stdout: 'config/node.env\n' }]);
    assert.throws(() => assertNoUntrackedTrace({
        appRoot: '/app', spawn, paths: ['/app/config/node.env', '/app/ecosystem.node.config.cjs'],
    }), (error) => {
        assert.equal(error.code, 'install_root_polluted');
        assert.match(error.message, /ecosystem\.node\.config\.cjs/);
        return true;
    });
});

test('a full install runs every step in order and never derives the source silently (WI-16)', async (t) => {
    const appRoot = fixtureAppRoot(t);
    const dataRoot = temporaryDirectory(t, 'nassaj-data-full-');
    const homeDir = temporaryDirectory(t, 'nassaj-home-');
    const spawn = fakeSpawn([
        { match: (c, a) => c === 'git' && gitArgs(a, 'remote', 'get-url'), stdout: 'https://github.com/your-org/nassaj-dev' },
        { match: (c, a) => c === 'git' && gitArgs(a, 'remote', 'set-url') },
        { match: (c, a) => c === 'git' && gitArgs(a, 'ls-remote'), stdout: 'abc\tHEAD' },
        { match: (c, a) => c === 'git' && a.includes('check-ignore'), stdout: ['config/node.env', 'config/release-source.lock.json', 'config/ecosystem.demo.config.cjs', 'dist', 'dist-server'].join('\n') },
        { match: (c) => c === 'ssh', status: 1, stderr: "Hi node! You've successfully authenticated" },
        { match: (c) => c === process.execPath, stdout: 'update pre-flight: 10 checks, 0 blockers' },
    ]);

    const confirmed = [];
    const result = await installNode({
        appRoot, homeDir, node: 'demo', port: '3004', processName: 'nassaj-dev',
        databasePath: path.join(dataRoot, 'store.db'),
        env: { USER: 'svc' }, spawn, fetch: fakeFetch({ ssh_keys: META_KEYS }),
        now: () => '2026-09-11T00:00:00.000Z',
        confirm: async (request) => { confirmed.push(request); return true; },
        output: { write: () => {} },
    });

    assert.deepEqual(confirmed.map((entry) => entry.identity), ['github.com/your-org/nassaj-dev']);
    assert.deepEqual(result.steps.map((entry) => entry.step), [
        'derive-release-source', 'host-keys', 'ssh-probe', 'remote', 'release-fetch',
        'node-env', 'release-source-lock', 'ecosystem', 'first-build-seed', 'client-archive',
        'install-root', 'update-preflight',
    ]);
    assert.match(result.preflight.stdout, /update pre-flight/);
    assert.equal(JSON.parse(readFileSync(result.lock.path, 'utf8')).confirmedBy.startsWith('svc@'), true);
    assert.match(readFileSync(path.join(homeDir, '.ssh/known_hosts'), 'utf8'), /^github\.com ssh-ed25519 /m);
    assert.equal(result.entry, null, 'a git checkout places no release entry');
    assert.equal(result.ecosystem.script, path.join(appRoot, 'dist-server', 'server', 'index.js'));
    assert.equal(result.ecosystem.cwd, appRoot);
});

test('the release layout is refused before any write when no sealed store exists (qa-critic C3)', async (t) => {
    const appRoot = fixtureAppRoot(t);
    const homeDir = temporaryDirectory(t, 'nassaj-home-release-');
    const deployRoot = temporaryDirectory(t, 'nassaj-deploy-unsealed-');
    await assert.rejects(installNode({
        appRoot, layout: 'artifact-runtime-v2', deployRoot, homeDir, node: 'sealed', env: {},
        spawn: fakeSpawn([]), fetch: fakeFetch({ ssh_keys: META_KEYS }), confirm: async () => true,
        output: { write: () => {} },
    }), (error) => error.code === 'release_layout_absent');
    assert.equal(existsOrNull(path.join(appRoot, 'config', 'node.env')), null);
    assert.equal(existsOrNull(path.join(homeDir, '.ssh', 'known_hosts')), null);
});

test('a blocked port 22 stops the install until the operator authorizes the ssh config (ADR-156 ك.2)', async (t) => {
    const appRoot = fixtureAppRoot(t);
    const homeDir = temporaryDirectory(t, 'nassaj-home-blocked-');
    const spawn = fakeSpawn([
        { match: (c, a) => c === 'git' && gitArgs(a, 'remote', 'get-url'), stdout: 'git@github.com:your-org/nassaj-dev.git' },
        { match: (c, a) => c === 'ssh' && a.at(-1) === 'git@github.com', status: 255, stderr: 'connect to host github.com port 22: Connection timed out' },
        { match: (c, a) => c === 'ssh' && a.at(-1) === 'git@ssh.github.com', status: 1, stderr: "Hi node! You've successfully authenticated" },
    ]);
    const options = {
        appRoot, deployRoot: '/opt/nassaj', homeDir, node: 'trav', env: {}, spawn,
        fetch: fakeFetch({ ssh_keys: META_KEYS }), confirm: async () => true, output: { write: () => {} },
    };
    await assert.rejects(installNode(options), (error) => {
        assert.equal(error.code, 'ssh_config_required');
        assert.match(error.message, /Hostname ssh\.github\.com/);
        return true;
    });

    assert.equal(existsOrNull(path.join(homeDir, '.ssh/config')), null, 'the stanza is never written unasked');

    // With the explicit opt-in the same install writes the stanza and continues.
    const deployRoot = temporaryDirectory(t, 'nassaj-deploy-443-');
    const allowed = fakeSpawn([
        { match: (c, a) => c === 'git' && gitArgs(a, 'remote', 'get-url'), stdout: 'git@github.com:your-org/nassaj-dev.git' },
        { match: (c, a) => c === 'ssh' && a.at(-1) === 'git@github.com', status: 255, stderr: 'connect to host github.com port 22: Connection timed out' },
        { match: (c, a) => c === 'ssh' && a.at(-1) === 'git@ssh.github.com', status: 1, stderr: "Hi node! You've successfully authenticated" },
        { match: (c, a) => c === 'git' && gitArgs(a, 'ls-remote'), stdout: 'abc\tHEAD' },
        { match: (c, a) => c === 'git' && a.includes('check-ignore'), stdout: ['config/node.env', 'config/release-source.lock.json', 'config/ecosystem.trav.config.cjs', 'dist', 'dist-server'].join('\n') },
        { match: (c) => c === process.execPath, stdout: 'update pre-flight: ok' },
    ]);
    const result = await installNode({ ...options, spawn: allowed, deployRoot, writeSshConfigAllowed: true });
    assert.equal(result.steps.some((entry) => entry.step === 'ssh-config'), true);
    assert.match(readFileSync(path.join(homeDir, '.ssh/config'), 'utf8'), /Host github\.com/);
});

test('an un-confirmed release source is never written on a non-interactive run (ADR-156 هـ.2.1)', async (t) => {
    const appRoot = fixtureAppRoot(t);
    const homeDir = temporaryDirectory(t, 'nassaj-home-unconfirmed-');
    const spawn = fakeSpawn([
        { match: (c, a) => c === 'git' && gitArgs(a, 'remote', 'get-url'), stdout: 'git@github.com:your-org/nassaj-dev.git' },
    ]);
    await assert.rejects(installNode({
        appRoot, deployRoot: '/opt/nassaj', homeDir, node: 'trav', env: {}, spawn,
        fetch: fakeFetch({ ssh_keys: META_KEYS }), output: { write: () => {} },
        // The real confirmation prompt, with a non-TTY stdin standing in for a script.
    }), (error) => error.code === 'release_source_unconfirmed');
    assert.equal(existsOrNull(path.join(appRoot, 'config', 'node.env')), null);
});

function existsOrNull(file) {
    try { return readFileSync(file, 'utf8'); } catch { return null; }
}
