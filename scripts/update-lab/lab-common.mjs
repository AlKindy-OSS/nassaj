/**
 * Shared helpers for the git-checkout-v2 update laboratory (WI-0 / ADR-156).
 *
 * Every path produced here lives under `.artifacts/update-lab/`, which is
 * gitignored, disk-backed and never shared with the live `nassaj-dev` install.
 * Nothing in this module may touch a production node, a remote, or pm2.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The laboratory tree. By default the gitignored `.artifacts/update-lab/`;
 * `NASSAJ_UPDATE_LAB_ROOT` moves it to another absolute, disk-backed path (for
 * example under /var/tmp) so fixtures, nodes and their node_modules stay out of
 * the working copy. tmpfs is refused: `npm ci` and the builds run inside it.
 */
function resolveLabRoot(value) {
    if (!value) return path.join(REPO_ROOT, '.artifacts', 'update-lab');
    const resolved = path.resolve(value);
    if (!path.isAbsolute(value)) throw new Error('NASSAJ_UPDATE_LAB_ROOT must be an absolute path');
    if (/^\/(?:tmp|dev\/shm)(?:\/|$)/.test(resolved)) {
        throw new Error('NASSAJ_UPDATE_LAB_ROOT must be disk-backed; /tmp and /dev/shm are tmpfs');
    }
    return resolved;
}

export const LAB_ROOT = resolveLabRoot(process.env.NASSAJ_UPDATE_LAB_ROOT);
export const FIXTURE_ROOT = path.join(LAB_ROOT, 'fixture');
export const FIXTURE_REPO = path.join(FIXTURE_ROOT, 'nassaj-fixture.git');
export const FIXTURE_META = path.join(FIXTURE_ROOT, 'fixture.json');
export const NODE_ROOT = path.join(LAB_ROOT, 'node');
export const NODE_APP = path.join(NODE_ROOT, 'app');
export const NODE_DATA = path.join(NODE_ROOT, 'data');
export const NODE_META = path.join(NODE_ROOT, 'node.json');
export const NODE_LOGS = path.join(NODE_ROOT, 'logs');
export const NODE_SNAPSHOTS = path.join(NODE_ROOT, 'snapshots');
export const PRISTINE_MODULES = path.join(NODE_ROOT, 'node_modules.pristine');
/**
 * The shim's file name is free. Since 462fcabd8 the updater's governed
 * environment (`resolveGovernedSshCommand` in source-updater.js) composes
 * whichever command git itself would choose — GIT_SSH_COMMAND, then GIT_SSH,
 * then the repository's core.sshCommand — and only appends BatchMode=yes,
 * StrictHostKeyChecking=yes and ConnectTimeout=10; the shim reads its LAST
 * argument, so those options pass through harmlessly. It keeps the name `ssh`
 * only so existing lab trees and logs stay recognisable.
 */
export const SSH_SHIM = path.join(LAB_ROOT, 'shim-bin', 'ssh');
export const RESULTS_ROOT = path.join(LAB_ROOT, 'results');

/**
 * The laboratory remote is GitHub-SHAPED on purpose: `defaultGitCheckoutProbe`
 * and `normalizeGitHubRemote` accept only `https://github.com/o/r` or
 * `git@github.com:o/r`, so a bare `file://` remote is rejected as
 * `unsafe_remote` before any scenario can run. The SSH shim below makes this
 * URL resolve to the local bare fixture with no network and no credentials.
 */
export const LAB_REMOTE_URL = 'git@github.com:your-org/nassaj-update-lab.git';
export const LAB_RELEASE_SOURCE = 'git@github.com:your-org/nassaj-update-lab';

/** Disk-backed TMPDIR: the updater refuses a tmpfs candidate root or TMPDIR. */
export const LAB_TMPDIR = '/var/tmp';

export function log(message) {
    process.stdout.write(`[update-lab] ${message}\n`);
}

export function fail(message) {
    process.stderr.write(`[update-lab] ERROR: ${message}\n`);
    process.exit(1);
}

/** Run a command, returning `{ code, stdout, stderr }` without throwing. */
export function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options,
        env: { ...process.env, TMPDIR: LAB_TMPDIR, ...(options.env || {}) },
    });
    return {
        code: result.status ?? -1,
        signal: result.signal || null,
        stdout: (result.stdout || '').toString(),
        stderr: (result.stderr || '').toString(),
    };
}

/** Run a command and abort the script when it fails. */
export function mustRun(command, args, options = {}) {
    const result = run(command, args, options);
    if (result.code !== 0) {
        fail(`${command} ${args.join(' ')} failed (${result.code}${result.signal ? `/${result.signal}` : ''})\n${result.stdout}\n${result.stderr}`);
    }
    return result.stdout.trim();
}

/** Run git inside `cwd` with a neutralized system/global configuration. */
export function git(args, cwd, options = {}) {
    return run('git', args, {
        cwd,
        ...options,
        env: {
            GIT_TERMINAL_PROMPT: '0',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_OPTIONAL_LOCKS: '0',
            ...(options.env || {}),
        },
    });
}

export function mustGit(args, cwd, options = {}) {
    const result = git(args, cwd, options);
    if (result.code !== 0) {
        fail(`git ${args.join(' ')} (cwd=${cwd}) failed (${result.code})\n${result.stdout}\n${result.stderr}`);
    }
    return result.stdout.trim();
}

export function readJson(file, fallback = null) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Parse `--key value` / `--flag` pairs plus positional arguments. */
export function parseArgs(argv) {
    const options = {};
    const positional = [];
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) { positional.push(token); continue; }
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) { options[key] = true; continue; }
        options[key] = next;
        index += 1;
    }
    return { options, positional };
}

/**
 * Refuse to run anywhere near the live install. The laboratory owns exactly one
 * tree (`.artifacts/update-lab/`) and one port range, never port 3004 and never
 * the pm2 process `nassaj-dev`.
 */
export function assertLabSafety({ port } = {}) {
    if (port !== undefined && Number(port) === 3004) fail('port 3004 belongs to the live nassaj-dev install; choose another');
    if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) fail(`${REPO_ROOT} is not a git working copy`);
}

/** Pick a free TCP port in the laboratory range, never 3004. */
export async function findFreePort(preferred = 3104) {
    const net = await import('node:net');
    for (let candidate = preferred; candidate < preferred + 40; candidate += 1) {
        if (candidate === 3004) continue;
        const free = await new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => server.close(() => resolve(true)));
            server.listen(candidate, '127.0.0.1');
        });
        if (free) return candidate;
    }
    fail('no free laboratory port found');
    return 0;
}

/**
 * Write the fake-ssh shim. Git is told (through the node's LOCAL repo config,
 * which survives GIT_CONFIG_GLOBAL=/dev/null) to use this script as its ssh
 * client, so `git@github.com:...` fetches are served by `git-upload-pack`
 * against the local bare fixture. Read-only: `git-receive-pack` is refused, so
 * no scenario can ever push anywhere.
 */
export function writeSshShim(fixtureRepo = FIXTURE_REPO) {
    fs.mkdirSync(path.dirname(SSH_SHIM), { recursive: true });
    fs.writeFileSync(SSH_SHIM, [
        '#!/bin/sh',
        '# Laboratory ssh shim (WI-0/ADR-156): serve the local bare fixture for a',
        '# GitHub-shaped remote URL. No network, no credentials, fetch only.',
        `FIXTURE=\${LAB_FIXTURE_REPO:-${fixtureRepo}}`,
        'for argument in "$@"; do last="$argument"; done',
        'case "$last" in',
        '  git-upload-pack*) exec git-upload-pack "$FIXTURE" ;;',
        '  *) echo "lab-ssh-shim: refused remote command: $last" >&2; exit 128 ;;',
        'esac',
        '',
    ].join('\n'), { mode: 0o700 });
    return SSH_SHIM;
}
