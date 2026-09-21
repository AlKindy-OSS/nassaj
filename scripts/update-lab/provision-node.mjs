#!/usr/bin/env node
/**
 * Provision the resettable laboratory node for the update laboratory
 * (WI-0 / ADR-156).
 *
 * The node is a full production-shaped install of Nassaj — built artefacts under
 * `dist-server/`, started by pm2 — that lives entirely inside
 * `.artifacts/update-lab/node/` and can be reset to zero in seconds. It is
 * isolated from the live install on every axis that matters:
 *
 *   - its own port (never 3004) and its own SQLite database,
 *   - its own `PM2_HOME`, so the pm2 process `nassaj-lab` and the `pm2 save`
 *     that `safe-restart.sh` performs belong to a private pm2 daemon and can
 *     never reach the live `nassaj-dev` process or its resurrection list,
 *   - its own `WF_BASE`, so the restart gate scans laboratory transcripts only,
 *   - `TMPDIR=/var/tmp`, because the updater refuses a tmpfs candidate root,
 *   - a GitHub-shaped `origin` that a fetch-only ssh shim resolves to the local
 *     bare fixture, so no scenario can reach the network.
 *
 * Usage:
 *   node scripts/update-lab/provision-node.mjs create [--port 3104] [--force] [--skip-build]
 *   node scripts/update-lab/provision-node.mjs start|stop|status
 *   node scripts/update-lab/provision-node.mjs snapshot [--name base]
 *   node scripts/update-lab/provision-node.mjs restore  [--name base]
 *   node scripts/update-lab/provision-node.mjs destroy
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    FIXTURE_META, FIXTURE_REPO, LAB_RELEASE_SOURCE, LAB_REMOTE_URL, LAB_TMPDIR,
    NODE_APP, NODE_DATA, NODE_LOGS, NODE_META, NODE_ROOT, NODE_SNAPSHOTS, PRISTINE_MODULES, SSH_SHIM,
    assertLabSafety, fail, findFreePort, git, log, mustGit, mustRun, parseArgs, readJson, run, writeJson, writeSshShim,
} from './lab-common.mjs';

const PM2_HOME = path.join(NODE_ROOT, 'pm2');
const WF_BASE = path.join(NODE_ROOT, 'workflows');
const ECOSYSTEM = path.join(NODE_ROOT, 'ecosystem.lab.config.cjs');
const PROC_NAME = 'nassaj-lab';
const NODE_BIN = '/usr/bin/node';
const NPM_BIN = '/usr/bin/npm';
const PM2_BIN = '/usr/bin/pm2';
/** Deadline for any pm2 client call; see the comment in `pm2()` below. */
const PM2_CALL_TIMEOUT_MS = 20_000;

/** Environment shared by the node process and every governed child it spawns. */
function labEnvironment(meta) {
    return {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        SERVER_PORT: String(meta.port),
        DATABASE_PATH: path.join(NODE_DATA, 'auth.db'),
        JWT_SECRET: meta.jwtSecret,
        BOOTSTRAP_OWNER_USERNAME: meta.ownerUsername,
        BOOTSTRAP_OWNER_PASSWORD: meta.ownerPassword,
        TMPDIR: LAB_TMPDIR,
        NASSAJ_RELEASE_SOURCE: LAB_RELEASE_SOURCE,
        NASSAJ_UPDATE_REMOTE: 'origin',
        NASSAJ_UPDATE_BRANCH: 'main',
        // The governed git environment composes this command with its own ssh
        // options (resolveGovernedSshCommand, 462fcabd8). core.sshCommand alone
        // would now suffice; riding here too keeps every child on the shim.
        GIT_SSH_COMMAND: SSH_SHIM,
        // safe-restart.sh knobs: the lab process, the lab health port, and a
        // laboratory-only transcript root so the gate never inspects the live
        // coordinator's sessions.
        PROC_NAME,
        NASSAJ_PROCESS_NAME: PROC_NAME,
        PM2_HOME,
        WF_BASE,
        HEALTH_URL: `http://127.0.0.1:${meta.port}/health`,
        HEALTH_PORT: String(meta.port),
        WARM_PUBLIC_ORIGIN: `http://127.0.0.1:${meta.port}`,
        ECOSYSTEM,
    };
}

function requireMeta() {
    const meta = readJson(NODE_META, null);
    if (!meta) fail(`no laboratory node yet; run: node scripts/update-lab/provision-node.mjs create`);
    return meta;
}

function pm2(args, meta) {
    // A hard deadline: `pm2 jlist` against a PM2_HOME whose daemon was killed —
    // or removed by `restore` under a daemon that outlived it — blocks forever
    // waiting for an RPC socket nobody answers, and hangs the whole scenario
    // batch at "resetting the laboratory node to zero".
    return run(PM2_BIN, args, {
        env: { ...labEnvironment(meta), PM2_HOME }, cwd: NODE_APP,
        timeout: PM2_CALL_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
}

/**
 * Block until every pid has exited, or the deadline passes. `restore` deletes
 * PM2_HOME immediately after `stop`, and a daemon still alive at that moment
 * recreates the socket files it is about to lose — the state that makes the
 * NEXT `pm2 jlist` hang. Synchronous on purpose: every caller here is.
 */
function awaitExit(pids, deadlineMs = 10_000) {
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const until = Date.now() + deadlineMs;
    const idle = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < until && pids.some(alive)) Atomics.wait(idle, 0, 0, 200);
    for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** Read the pid of the laboratory pm2 daemon currently recorded in PM2_HOME. */
function labDaemonPid() {
    try {
        const pid = Number(fs.readFileSync(path.join(PM2_HOME, 'pm2.pid'), 'utf8').trim());
        return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
    } catch {
        return 0;
    }
}

/** Write the node's `.env` (gitignored, so the worktree stays clean). */
function writeEnvFile(meta) {
    const lines = Object.entries(labEnvironment(meta)).map(([key, value]) => `${key}=${value}`);
    fs.writeFileSync(path.join(NODE_APP, '.env'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

function writeEcosystem(meta) {
    const environment = labEnvironment(meta);
    const body = `// Generated by scripts/update-lab/provision-node.mjs — laboratory node only.\n`
        + `module.exports = {\n  apps: [{\n`
        + `    name: ${JSON.stringify(PROC_NAME)},\n`
        + `    script: 'dist-server/server/index.js',\n`
        + `    cwd: ${JSON.stringify(NODE_APP)},\n`
        + `    interpreter: ${JSON.stringify(NODE_BIN)},\n`
        + `    instances: 1,\n    exec_mode: 'fork',\n    autorestart: true,\n    max_restarts: 5,\n`
        + `    out_file: ${JSON.stringify(path.join(NODE_LOGS, 'out.log'))},\n`
        + `    error_file: ${JSON.stringify(path.join(NODE_LOGS, 'err.log'))},\n`
        + `    env: ${JSON.stringify(environment, null, 6)},\n  }],\n};\n`;
    fs.writeFileSync(ECOSYSTEM, body, { mode: 0o600 });
}

function create(options) {
    const fixture = readJson(FIXTURE_META, null);
    if (!fixture) fail('no fixture yet; run scripts/update-lab/create-fixture-repo.mjs first');
    if (fs.existsSync(NODE_APP) && options.force !== true) fail(`${NODE_APP} exists; pass --force to rebuild it`);
    if (fs.existsSync(NODE_ROOT) && options.force === true) {
        stop({ quiet: true });
        fs.rmSync(NODE_APP, { recursive: true, force: true });
        fs.rmSync(NODE_DATA, { recursive: true, force: true });
    }
    for (const directory of [NODE_ROOT, NODE_DATA, NODE_LOGS, NODE_SNAPSHOTS, WF_BASE, PM2_HOME]) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    return provision(fixture, options);
}

async function provision(fixture, options) {
    const port = Number(options.port || 0) || await findFreePort(3104);
    assertLabSafety({ port });
    const meta = {
        schema: 'nassaj-update-lab-node/v1',
        createdAt: new Date().toISOString(),
        port,
        procName: PROC_NAME,
        appRoot: NODE_APP,
        dataRoot: NODE_DATA,
        pm2Home: PM2_HOME,
        ecosystem: ECOSYSTEM,
        baseCommit: fixture.baseCommit,
        baseVersion: fixture.baseVersion,
        jwtSecret: crypto.randomBytes(32).toString('hex'),
        ownerUsername: 'labowner',
        ownerPassword: `Lab-${crypto.randomBytes(18).toString('base64url')}`,
    };

    log(`cloning the laboratory node at ${fixture.baseCommit.slice(0, 8)} (behind ${fixture.latest.tag})`);
    mustGit(['clone', '--local', '--no-checkout', '--quiet', FIXTURE_REPO, NODE_APP], NODE_ROOT);
    mustGit(['checkout', '-B', 'main', fixture.baseCommit, '--'], NODE_APP);

    // A GitHub-shaped remote served by the local fetch-only ssh shim. The shim
    // is wired through the repository-LOCAL config, which survives the updater's
    // GIT_CONFIG_GLOBAL=/dev/null neutralization.
    const shim = writeSshShim(FIXTURE_REPO);
    mustGit(['remote', 'set-url', 'origin', LAB_REMOTE_URL], NODE_APP);
    mustGit(['config', 'core.sshCommand', `env LAB_FIXTURE_REPO=${FIXTURE_REPO} ${shim}`], NODE_APP);
    mustGit(['config', 'user.email', 'update-lab@localhost'], NODE_APP);
    mustGit(['config', 'user.name', 'Nassaj Update Lab'], NODE_APP);
    // The node must not carry the fixture's release tag locally: discovery and
    // the updater fetch it explicitly, exactly as a real node does.
    for (const ref of mustGit(['for-each-ref', '--format=%(refname)', 'refs/tags'], NODE_APP).split('\n').filter(Boolean)) {
        git(['update-ref', '-d', ref], NODE_APP);
    }

    writeJson(NODE_META, meta);
    writeEnvFile(meta);
    writeEcosystem(meta);

    if (options['skip-install'] !== true) {
        log('installing dependencies (npm ci, TMPDIR=/var/tmp) — this is the slow step');
        const install = run(NPM_BIN, ['ci', '--include=dev', '--no-audit', '--no-fund'], {
            cwd: NODE_APP, env: { TMPDIR: LAB_TMPDIR, HUSKY: '0', NODE_ENV: 'development' }, stdio: 'inherit',
        });
        if (install.code !== 0) fail('npm ci failed in the laboratory node');
        // A REAL copy, never `cp -al`: scripts/patch-codex-sdk-image-only.mjs
        // refuses any build whose @openai/codex-sdk entry has nlink !== 1
        // (`CODEX_IMAGE_ONLY_PATCH_UNSAFE_FILE`), so a hard-linked
        // node_modules makes `npm run build:server` fail on the node.
        fs.rmSync(PRISTINE_MODULES, { recursive: true, force: true });
        mustRun('cp', ['-a', path.join(NODE_APP, 'node_modules'), PRISTINE_MODULES]);
    }
    if (options['skip-build'] !== true) {
        // The atomic builders exchange a staged generation with the LIVE
        // directory, so both live directories must exist before the very first
        // build of a fresh node (client-build-atomic.mjs:384).
        // `dist/assets` too: mergeLegacyAssets walks the LIVE asset inventory
        // before promoting (client-build-atomic.mjs:148-152), so an empty
        // `dist/` is not enough for the first build of a fresh node.
        for (const directory of ['dist/assets', 'dist-server']) {
            fs.mkdirSync(path.join(NODE_APP, directory), { recursive: true });
        }
        log('building the laboratory node (client + server)');
        const build = run(NPM_BIN, ['run', 'build'], {
            cwd: NODE_APP, env: { ...labEnvironment(meta), PATH: process.env.PATH, HOME: process.env.HOME, HUSKY: '0' }, stdio: 'inherit',
        });
        if (build.code !== 0) fail('the laboratory node build failed');
    }
    const status = git(['status', '--porcelain=v1', '--untracked-files=all'], NODE_APP).stdout.trim();
    if (status) log(`WARNING: the node worktree is not clean after provisioning:\n${status}`);
    // The zero point every scenario restores from.
    if (options['skip-snapshot'] !== true) snapshot({ name: 'base' });
    log(`laboratory node ready at ${NODE_APP} (port ${port}, pm2 ${PROC_NAME} in ${PM2_HOME})`);
    return meta;
}

function start() {
    const meta = requireMeta();
    const list = pm2(['jlist'], meta);
    const apps = (() => { try { return JSON.parse(list.stdout); } catch { return []; } })();
    if (apps.some((app) => app.name === PROC_NAME)) {
        log(`${PROC_NAME} is already registered in the laboratory pm2 daemon; use restore to reset it`);
    } else {
        const started = pm2(['start', ECOSYSTEM], meta);
        if (started.code !== 0) fail(`pm2 start failed:\n${started.stdout}\n${started.stderr}`);
    }
    log(`started ${PROC_NAME} on http://127.0.0.1:${meta.port}`);
}

/**
 * Stop the laboratory node WITHOUT issuing a pm2 lifecycle command: the private
 * daemon and its child are laboratory processes, addressed by pid, so no pm2
 * stop/delete/restart ever leaves this file.
 */
function stop({ quiet = false } = {}) {
    const daemonPids = new Set();
    if (labDaemonPid()) daemonPids.add(labDaemonPid());
    const pids = [];
    try {
        const dump = JSON.parse(fs.readFileSync(path.join(PM2_HOME, 'dump.pm2'), 'utf8'));
        for (const app of dump) if (Number.isSafeInteger(app?.pid)) pids.push(app.pid);
    } catch { /* no dump yet */ }
    const meta = readJson(NODE_META, null);
    if (meta) {
        const list = pm2(['jlist'], meta);
        try {
            for (const app of JSON.parse(list.stdout)) {
                if (app?.name === PROC_NAME && Number.isSafeInteger(app?.pid) && app.pid > 0) pids.push(app.pid);
            }
        } catch { /* daemon not running */ }
    }
    // `pm2 jlist` SPAWNS a daemon when none is listening, so the pid read before
    // the call is not necessarily the one now holding PM2_HOME. Re-reading it
    // here is what stops a fresh God Daemon being orphaned by every scenario —
    // five of them had accumulated, and the sixth hung `restore` outright.
    if (labDaemonPid()) daemonPids.add(labDaemonPid());
    for (const pid of [...new Set(pids)]) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    for (const pid of daemonPids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    awaitExit([...new Set(pids), ...daemonPids]);
    if (!quiet) {
        log(`stopped the laboratory node (pids ${[...new Set(pids)].join(',') || 'none'},`
            + ` daemon ${[...daemonPids].join(',') || 'none'})`);
    }
}

function status() {
    const meta = requireMeta();
    const list = pm2(['jlist'], meta);
    let apps = [];
    try { apps = JSON.parse(list.stdout); } catch { /* daemon down */ }
    const app = apps.find((entry) => entry.name === PROC_NAME);
    const head = git(['rev-parse', '--short', 'HEAD'], NODE_APP).stdout.trim();
    const version = (() => { try { return JSON.parse(fs.readFileSync(path.join(NODE_APP, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })();
    const dirty = git(['status', '--porcelain=v1', '--untracked-files=all'], NODE_APP).stdout.trim();
    log(`node ${NODE_APP}\n  head=${head} version=${version} port=${meta.port}`
        + `\n  pm2=${app ? `${app.pm2_env?.status} pid=${app.pid}` : 'not running'}`
        + `\n  worktree=${dirty ? `dirty (${dirty.split('\n').length} entries)` : 'clean'}`);
}

function snapshot(options) {
    requireMeta();
    const name = typeof options.name === 'string' ? options.name : 'base';
    stop({ quiet: true });
    const file = path.join(NODE_SNAPSHOTS, `${name}.tar`);
    fs.mkdirSync(NODE_SNAPSHOTS, { recursive: true });
    log(`snapshotting the node into ${file} (node_modules excluded; restore replaces it from the pristine copy)`);
    mustRun('tar', ['--warning=no-file-changed', '-cf', file, '--exclude=./app/node_modules', '--exclude=./pm2', '-C', NODE_ROOT, './app', './data', './node.json', './ecosystem.lab.config.cjs']);
    log(`snapshot ${name} written (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MiB)`);
}

function restore(options) {
    const name = typeof options.name === 'string' ? options.name : 'base';
    const file = path.join(NODE_SNAPSHOTS, `${name}.tar`);
    if (!fs.existsSync(file)) fail(`snapshot ${name} does not exist (${file})`);
    stop({ quiet: true });
    fs.rmSync(NODE_APP, { recursive: true, force: true });
    fs.rmSync(NODE_DATA, { recursive: true, force: true });
    fs.rmSync(PM2_HOME, { recursive: true, force: true });
    mustRun('tar', ['-xf', file, '-C', NODE_ROOT]);
    if (!fs.existsSync(path.join(NODE_APP, 'node_modules'))) {
        if (!fs.existsSync(PRISTINE_MODULES)) fail('the pristine node_modules copy is missing; re-run create');
        mustRun('cp', ['-a', PRISTINE_MODULES, path.join(NODE_APP, 'node_modules')]);
    }
    fs.mkdirSync(PM2_HOME, { recursive: true, mode: 0o700 });
    log(`restored the laboratory node from snapshot ${name}`);
}

function destroy() {
    stop({ quiet: true });
    fs.rmSync(NODE_ROOT, { recursive: true, force: true });
    log('laboratory node destroyed');
}

async function main() {
    const { options, positional } = parseArgs(process.argv.slice(2));
    const command = positional[0] || 'status';
    assertLabSafety();
    switch (command) {
        case 'create': await create(options); break;
        case 'start': start(); break;
        case 'stop': stop(options); break;
        case 'status': status(); break;
        case 'snapshot': snapshot(options); break;
        case 'restore': restore(options); break;
        case 'destroy': destroy(); break;
        default: fail(`unknown command ${command}`);
    }
}

export { labEnvironment, PM2_HOME, PROC_NAME, ECOSYSTEM, WF_BASE };

if (import.meta.url === `file://${process.argv[1]}`) await main();
