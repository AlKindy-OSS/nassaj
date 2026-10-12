// upgrade-path-leaves-node.mjs — the sandbox node of the "candidate leaves" leg (ADR-204 S0).
//
// Installs the candidate as the committed, running generation of a git-checkout
// node inside the gate sandbox, the way a fleet node runs it:
//   - a clone on branch main at the candidate commit, `origin` on the gate's
//     credential-free GitHub SSH URL served by the local transport shim;
//   - node_modules copied (never hard-linked: the codex patch check refuses a
//     shared inode) from the installed candidate tree;
//   - dist-server and dist built by the candidate's OWN release builders
//     (buildServerReleaseCandidate / buildClientReleaseCandidate), exactly the
//     builders its updater runs for the next release;
//   - config/node.env and the PM2 ecosystem written by the candidate's OWN
//     installer (`generateEcosystem` of scripts/install-node.mjs);
//   - a private PM2 daemon (its own PM2_HOME) that runs the candidate under a
//     unique app name.
// Shims first on PATH: `npm ci` copies the installed candidate node_modules
// (lockfile must be byte-identical), `npm ls` is the real npm, anything else is
// refused; `pm2` refuses any PM2_HOME but the sandbox's; `ssh` refuses all.
// Nothing outside the sandbox is written (one short PM2_HOME under /var/tmp is
// the only exception, when the sandbox path is too long for a unix socket).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync,
    rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { NEUTRAL_GIT_ENV, git } from './upgrade-path-gate-git.mjs';

const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const PM2_TIMEOUT_MS = 60 * 1000;
const PM2_KILL_TIMEOUT_MS = 20 * 1000;
// sun_path is 108 bytes on Linux; keep a margin for pm2's own socket names.
const MAX_SOCKET_PATH = 100;
/** Ports the gate never binds: the live service and the server's default. */
const RESERVED_PORTS = new Set([3001, 3004]);

/** Thrown with a bounded code the report prints (never a path or free text). */
export class LeavesError extends Error {
    constructor(code, detail) {
        super(detail ? `${code}: ${detail}` : code);
        this.code = code;
        this.detail = detail ? String(detail).slice(0, 600) : null;
    }
}

/** Single-quote a value for /bin/sh. */
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** Create the leg's private directory tree (0700) inside the sandbox. */
export function leavesLayout(sandbox) {
    const root = path.join(sandbox, 'leaves');
    mkdirSync(root, { mode: 0o700 });
    const layout = { sandbox, root, node: path.join(sandbox, 'leaves-node'), pm2HomeOutside: false };
    for (const name of ['bin', 'home', 'tmp', 'run', 'data', 'logs', 'install']) {
        layout[name] = path.join(root, name);
        mkdirSync(layout[name], { mode: 0o700 });
    }
    layout.pm2Home = path.join(root, 'pm2');
    if (path.join(layout.pm2Home, 'pub.sock').length > MAX_SOCKET_PATH) {
        layout.pm2Home = mkdtempSync('/var/tmp/nassaj-gate-pm2-');
        layout.pm2HomeOutside = true;
    } else {
        mkdirSync(layout.pm2Home, { mode: 0o700 });
    }
    chmodSync(layout.pm2Home, 0o700);
    layout.database = path.join(layout.data, 'db.sqlite');
    return layout;
}

/** Absolute path of an executable on the operator's PATH, ignoring the sandbox. */
export function resolveExecutable(name, { sandbox, envPath = process.env.PATH || SYSTEM_PATH } = {}) {
    for (const directory of envPath.split(':')) {
        if (!directory || !path.isAbsolute(directory) || (sandbox && directory.startsWith(sandbox))) continue;
        const candidate = path.join(directory, name);
        try {
            if (statSync(candidate).isFile()) return candidate;
        } catch { /* not here */ }
    }
    return null;
}

/** The npm shim: `ci` copies the installed candidate's modules, `ls` is real npm, nothing else. */
export function npmShimScript({ candidateRoot, npmPath }) {
    const modules = shQuote(path.join(candidateRoot, 'node_modules'));
    const lock = shQuote(path.join(candidateRoot, 'package-lock.json'));
    return `#!/bin/sh
# upgrade-path gate npm (candidate-leaves): never reaches a registry.
case "$1" in
  ci)
    cmp -s package-lock.json ${lock} || { echo "upgrade-path gate npm: lockfile differs from the installed candidate" >&2; exit 1; }
    rm -rf node_modules && exec cp -a ${modules} node_modules ;;
  ls) exec ${shQuote(npmPath)} "$@" ;;
esac
echo "upgrade-path gate npm refused: $1" >&2
exit 1
`;
}

/** The pm2 wrapper: refuses any daemon but the sandbox's own. */
export function pm2ShimScript({ pm2Home, pm2Path }) {
    return `#!/bin/sh
# upgrade-path gate pm2 (candidate-leaves): only the sandbox daemon is reachable.
[ "$PM2_HOME" = ${shQuote(pm2Home)} ] || { echo "upgrade-path gate pm2 refused: foreign PM2_HOME" >&2; exit 97; }
exec ${shQuote(pm2Path)} "$@"
`;
}

/** Write the PATH shims of the leg (npm, pm2, ssh). */
export function writeLeavesShims(layout, { candidateRoot, npmPath, pm2Path }) {
    writeFileSync(path.join(layout.bin, 'npm'), npmShimScript({ candidateRoot, npmPath }), { mode: 0o700 });
    writeFileSync(path.join(layout.bin, 'pm2'), pm2ShimScript({ pm2Home: layout.pm2Home, pm2Path }), { mode: 0o700 });
    writeFileSync(path.join(layout.bin, 'ssh'), '#!/bin/sh\necho "upgrade-path gate: network ssh refused" >&2\nexit 255\n',
        { mode: 0o700 });
}

/** A free loopback port that is never a reserved live port. */
export async function sandboxPort(pickPort) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const port = await pickPort();
        if (!RESERVED_PORTS.has(port)) return port;
    }
    throw new LeavesError('candidate_leaves_port_unavailable');
}

/**
 * Every variable whose absence makes the server, safe-restart.sh or an update
 * script fall back to the LIVE port 3004 (or 3001), all pointed at the sandbox:
 * safe-restart.sh's live-session probe, its B-790 post-restart health check and
 * its cache warm-up, the preview/OID health probes, and the server's own
 * self-address (PORT). Without them the sandbox restart would be verified by,
 * and send requests to, the live service.
 */
export function sandboxPortEnvironment(port) {
    if (!Number.isInteger(port) || RESERVED_PORTS.has(port)) throw new LeavesError('candidate_leaves_port_reserved');
    const origin = `http://127.0.0.1:${port}`;
    return {
        SERVER_PORT: String(port), PORT: String(port), HEALTH_PORT: String(port), NASSAJ_PORT: String(port),
        NASSAJ_PM2_HEALTH_PORT: String(port),
        HEALTH_URL: `${origin}/health`, NASSAJ_PREVIEW_HEALTH_URL: `${origin}/health`,
        NASSAJ_ADOPTED_LIVE_PRIVATE_HEALTH_URL: `${origin}/health`,
        WARM_PUBLIC_ORIGIN: origin, SHOTS_BASE_URL: origin, NASSAJ_CLIENT_BUILD_SMOKE_URL: origin,
    };
}

/**
 * The complete environment of the sandbox PM2 daemon and server: built from
 * nothing, so no operator secret, database, provider login or live path leaks,
 * and no default can reach the live port (sandboxPortEnvironment).
 */
export function leavesEnvironment(layout, { owner, port }) {
    const home = layout.home;
    return {
        PATH: `${layout.bin}:${path.dirname(process.execPath)}:${SYSTEM_PATH}`,
        HOME: home, LANG: 'C.UTF-8', TMPDIR: layout.tmp, NODE_ENV: 'production',
        HOST: '127.0.0.1', ...sandboxPortEnvironment(port), DATABASE_PATH: layout.database,
        JWT_SECRET: randomBytes(48).toString('hex'), PM2_HOME: layout.pm2Home,
        BOOTSTRAP_OWNER_USERNAME: owner.username, BOOTSTRAP_OWNER_PASSWORD: owner.password,
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
        XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_RUNTIME_DIR: layout.run,
        GIT_CONFIG_NOSYSTEM: NEUTRAL_GIT_ENV.GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT: '0',
    };
}

/** The build environment the updater gives its candidate builders (dependencyEnvironment). */
function buildEnvironment(layout) {
    return { PATH: `${path.dirname(process.execPath)}:${SYSTEM_PATH}`, HOME: layout.home, TMPDIR: layout.tmp,
        LANG: 'C.UTF-8', HUSKY: '0', NODE_ENV: 'production' };
}

/** Run a module program with the node's own code (cwd = the node) and return its last JSON line. */
function runNodeProgram(layout, { program, args, label, env }) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', program, ...args], {
        cwd: layout.node, env, encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024 * 1024,
    });
    writeFileSync(path.join(layout.logs, `${label}.log`), `${run.stdout || ''}${run.stderr || ''}`, { mode: 0o600 });
    if (run.status !== 0) {
        throw new LeavesError(`candidate_leaves_${label.replace(/-/g, '_')}_failed`,
            `exit ${run.status ?? run.signal}; log leaves/logs/${label}.log`);
    }
    try {
        return JSON.parse(String(run.stdout).trim().split('\n').at(-1));
    } catch {
        throw new LeavesError(`candidate_leaves_${label.replace(/-/g, '_')}_output_invalid`);
    }
}

const INSTALL_BUILD_PROGRAM = `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [installRoot, releaseCommit, version] = process.argv.slice(1);
const load = (file) => import(pathToFileURL(path.join(process.cwd(), 'scripts', file)).href);
const common = { sourceRoot: process.cwd(), candidateRoot: installRoot, releaseCommit, version };
const server = await (await load('server-build-atomic.mjs'))
    .buildServerReleaseCandidate({ ...common, outputRoot: path.join(installRoot, 'server') });
const client = await (await load('client-build-atomic.mjs'))
    .buildClientReleaseCandidate({ ...common, outputRoot: path.join(installRoot, 'client') });
process.stdout.write(JSON.stringify({ serverBuildId: server.buildId, clientBuildId: client.buildId }) + '\\n');
`;

/** Build dist-server and dist with the candidate's own release builders and place them. */
function installGenerations(layout, { commit, version }) {
    const built = runNodeProgram(layout, { program: INSTALL_BUILD_PROGRAM, args: [layout.install, commit, version],
        label: 'install-build', env: buildEnvironment(layout) });
    renameSync(path.join(layout.install, 'server'), path.join(layout.node, 'dist-server'));
    renameSync(path.join(layout.install, 'client'), path.join(layout.node, 'dist'));
    return built;
}

const ECOSYSTEM_PROGRAM = `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [port, databasePath, processName] = process.argv.slice(1);
const { generateEcosystem } = await import(pathToFileURL(path.join(process.cwd(), 'scripts', 'install-node.mjs')).href);
const result = generateEcosystem({ appRoot: process.cwd(), configDir: path.join(process.cwd(), 'config'),
    node: 'upgrade-gate', port, databasePath, processName });
process.stdout.write(JSON.stringify(result) + '\\n');
`;

/** Write config/node.env and the ecosystem with the candidate's own installer. */
function configureNode(layout, { port, processName, releaseSource }) {
    const config = path.join(layout.node, 'config');
    mkdirSync(config, { mode: 0o700 });
    // node.env wins in the generated ecosystem, so the sandbox port survives any
    // env the restart path rebuilds (safe-restart.sh --update-env paths).
    const ports = Object.entries(sandboxPortEnvironment(port)).map(([key, value]) => `${key}=${value}\n`).join('');
    writeFileSync(path.join(config, 'node.env'), `NASSAJ_RELEASE_SOURCE=${releaseSource}\nTMPDIR=${layout.tmp}\n${ports}`,
        { mode: 0o600 });
    return runNodeProgram(layout, { program: ECOSYSTEM_PROGRAM, args: [String(port), layout.database, processName],
        label: 'ecosystem', env: buildEnvironment(layout) });
}

/**
 * Prepare the installed candidate node: clone, modules, generations, config.
 * @returns {{ecosystem:string, processName:string, built:object}}
 */
export function prepareLeavesNode(layout, { cloneNode, sandbox, bare, candidateRoot, candidateCommit, candidateVersion,
    port, releaseSource }) {
    cloneNode({ sandbox, bare, name: path.basename(layout.node), commit: candidateCommit, seed: false });
    const copy = spawnSync('cp', ['-a', path.join(candidateRoot, 'node_modules'), path.join(layout.node, 'node_modules')],
        { encoding: 'utf8' });
    if (copy.status !== 0) throw new LeavesError('candidate_leaves_modules_copy_failed', copy.stderr);
    const built = installGenerations(layout, { commit: candidateCommit, version: candidateVersion });
    const dirty = git(layout.node, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (dirty) throw new LeavesError('candidate_leaves_install_dirty', dirty.split('\n').slice(0, 3).join(' '));
    const processName = `nassaj-upgrade-gate-${randomBytes(4).toString('hex')}`;
    const ecosystem = configureNode(layout, { port, processName, releaseSource });
    return { ecosystem: ecosystem.path, processName, built };
}

/** Run the sandbox pm2 (through the wrapper) with the leg's environment. */
export function pm2(layout, env, args, timeout = PM2_TIMEOUT_MS) {
    return spawnSync(path.join(layout.bin, 'pm2'), args, { cwd: layout.node, env, encoding: 'utf8',
        timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
}

/** The sandbox app's pm2 record ({pid, status, restarts}) or null. */
export function pm2App(layout, env, processName) {
    const run = pm2(layout, env, ['jlist']);
    if (run.status !== 0) return null;
    let apps;
    try { apps = JSON.parse(run.stdout); } catch { return null; }
    const app = Array.isArray(apps) ? apps.find((entry) => entry?.name === processName) : null;
    return app ? { pid: app.pid, status: app.pm2_env?.status ?? null, restarts: app.pm2_env?.restart_time ?? null } : null;
}

/** Start the node under the sandbox daemon. */
export function startNode(layout, env, ecosystem) {
    const run = pm2(layout, env, ['start', ecosystem]);
    if (run.status !== 0) throw new LeavesError('candidate_leaves_pm2_start_failed', (run.stderr || '').slice(-400));
}

/** This process and its ancestors: never reaped, whatever their command line says. */
function ancestry(procRoot) {
    const chain = new Set();
    for (let pid = process.pid; pid > 1 && !chain.has(pid);) {
        chain.add(pid);
        try {
            const stat = readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
            pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        } catch { break; }
    }
    return chain;
}

/**
 * The pids (own uid, not this process or an ancestor) whose command line or cwd
 * names the sandbox (node, leaves/tmp|home|install, ...) or the PM2_HOME.
 */
export function sandboxProcesses(layout, procRoot = '/proc') {
    const marks = [layout.sandbox || layout.node, layout.pm2Home];
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const own = ancestry(procRoot);
    const found = [];
    for (const entry of readdirSync(procRoot)) {
        if (!/^\d+$/.test(entry) || own.has(Number(entry))) continue;
        try {
            if (uid !== null && statSync(path.join(procRoot, entry)).uid !== uid) continue;
            const cmdline = readFileSync(path.join(procRoot, entry, 'cmdline'), 'utf8').replace(/\0/g, ' ');
            let cwd = '';
            try { cwd = readlinkSync(path.join(procRoot, entry, 'cwd')); } catch { cwd = ''; }
            if (marks.some((mark) => cmdline.includes(mark) || cwd === mark || cwd.startsWith(`${mark}/`))) {
                found.push(Number(entry));
            }
        } catch { /* exited meanwhile */ }
    }
    return found;
}

/**
 * Stop the sandbox daemon and every process it left (the app runs with a 24 h
 * drain kill_timeout, so `pm2 kill` alone may not return): SIGKILL whatever
 * still names the sandbox, then report what survived.
 * @returns {{survivors:number[]}}
 */
export function stopLeavesHost(layout, env) {
    if (env) pm2(layout, env, ['kill'], PM2_KILL_TIMEOUT_MS);
    for (let round = 0; round < 3; round += 1) {
        const pids = sandboxProcesses(layout);
        if (!pids.length) break;
        for (const pid of pids) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    const survivors = sandboxProcesses(layout);
    if (layout.pm2HomeOutside && !survivors.length && existsSync(layout.pm2Home)) {
        rmSync(layout.pm2Home, { recursive: true, force: true });
    }
    return { survivors };
}

/**
 * Prove the running sandbox server would hand safe-restart.sh the sandbox port:
 * the server spawns it with its own process.env, so its /proc environ is what
 * the restart's probes, B-790 health check and warm-up read. Only the port keys
 * are read; nothing else (secrets) leaves /proc.
 */
export function assertSandboxRestartEnvironment(pid, port, procRoot = '/proc') {
    const expected = sandboxPortEnvironment(port);
    let environ;
    try {
        environ = readFileSync(path.join(procRoot, String(pid), 'environ'), 'utf8').split('\0');
    } catch {
        throw new LeavesError('candidate_leaves_environment_unreadable');
    }
    const actual = Object.fromEntries(environ.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
        .filter(([key]) => Object.hasOwn(expected, key)));
    const wrong = Object.keys(expected).filter((key) => actual[key] !== expected[key]);
    if (wrong.length) throw new LeavesError('candidate_leaves_live_port_leak', `server env ${wrong.join(',')} not the sandbox port`);
}

/** The sandbox restart log must never name a live port (qa CRITICAL 1). */
export function assertRestartLogSandboxed(layout) {
    let log = '';
    try { log = readFileSync(path.join(layout.data, 'last-restart.log'), 'utf8'); } catch { log = ''; }
    if (/:300[14]\b/.test(log)) throw new LeavesError('candidate_leaves_live_port_named', 'last-restart.log names :3001/:3004');
    return log;
}

/** The exact shell command that stops this leg's sandbox by hand (printed at leg start). */
export function recoveryCommand(layout) {
    return `PM2_HOME=${shQuote(layout.pm2Home)} ${shQuote(path.join(layout.bin, 'pm2'))} kill; `
        + `pgrep -af ${shQuote(layout.sandbox || layout.node)}`;
}

/**
 * While the leg runs, SIGINT/SIGTERM tear the sandbox down synchronously (pm2
 * kill through the wrapper, then SIGKILL of survivors) and exit 128+signal, so
 * an interrupted gate leaves no daemon behind. Returns the uninstaller.
 */
export function installLeavesSignalGuard(layout, getEnv) {
    const handlers = {};
    for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15]]) {
        handlers[signal] = () => {
            try { stopLeavesHost(layout, getEnv()); } finally { process.exit(128 + number); }
        };
        process.once(signal, handlers[signal]);
    }
    return () => { for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler); };
}

/** The last bytes of the sandbox app's pm2 logs (for a failed leg's detail). */
export function pm2LogTail(layout, bytes = 1500) {
    const logs = path.join(layout.pm2Home, 'logs');
    let text = '';
    try {
        for (const file of readdirSync(logs).sort()) text += readFileSync(path.join(logs, file), 'utf8').slice(-bytes);
    } catch { /* no logs yet */ }
    return text.slice(-bytes);
}
