#!/usr/bin/env node
/**
 * Full node installer for a `git clone` installation (ADR-156 هـ/ك, WI-16, T-1731).
 *
 * This finishes, in one reviewed pass, the setup that was performed by hand on
 * a fleet node across two consecutive upgrades and seven manual
 * interventions (B-1050…B-1057). Each step closes a named failure:
 *
 *   1. `origin` on SSH + a `ls-remote` probe under the *fetch* environment
 *      (B-1053: a credential-free fetch against a private HTTPS remote).
 *   2. GitHub's three published host keys written at install time from
 *      `https://api.github.com/meta` — never a digest pinned in this file, which
 *      would turn a key rotation into a silently disabled updater — plus the
 *      `ssh.github.com:443` fallback when port 22 is blocked (ADR-156 ك.2).
 *   3. `NASSAJ_RELEASE_SOURCE` derived from `origin` **with operator
 *      confirmation**, normalized, written to `config/node.env` and pinned TOFU
 *      in `config/release-source.lock.json` (B-1052; ADR-156 هـ.2).
 *   4. A generated ecosystem file whose PM2 entry matches the install layout
 *      (`scripts/lib/pm2-install-layout.cjs`). A git checkout runs its own
 *      `dist-server/server/index.js` with cwd = the app root; only
 *      `--release-layout` places the release-borne `pm2-entry.mjs` beside the
 *      launcher, and only onto a sealed release store that already exists —
 *      that entry boots nothing else (qa-critic C3).
 *   5. `dist/assets` and `dist-server` seeded so the first build on a fresh
 *      install does not fail (B-1060).
 *
 * Every byte of node state it writes lands under `config/` or `.artifacts/`,
 * both gitignored: a writer in the install root turns the *next* update into a
 * `dirty_worktree` refusal (B-1050), which is the bug this installer exists to
 * avoid re-creating.
 *
 * Usage:
 *   node scripts/install-node.mjs --node <name> \
 *        [--port 3004] [--database-path <file>] [--process-name nassaj-dev] \
 *        [--yes] [--write-ssh-config] [--release-layout --deploy-root <path>]
 *
 * مثبّت العقدة الكامل لتثبيت git (ADR-156، WI-16): ريموت SSH متحقَّق منه ببيئة
 * السحب نفسها، والبصمات الثلاث المنشورة وقت التثبيت، ومصدر الإصدار بتأكيد
 * المشغّل وتثبيت TOFU، ومدخل pm2 المشحون، وبذرة أول بناء — بلا أثر في الجذر.
 */

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync,
    openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { normalizeGitHubRepositoryIdentity, RELEASE_SOURCE_LOCK_SCHEMA } from '../server/services/release-source-config.js';
import { releaseGitEnvironment } from '../server/services/source-updater.js';

import { prepareClientPublicationAssets } from './lib/client-publication-archive.mjs';
import { verifyAssetClosure } from './lib/client-publication-artifacts.mjs';
import pm2InstallLayout from './lib/pm2-install-layout.cjs';

const { GIT_CHECKOUT_LAYOUT, RELEASE_LAYOUT, expectedPm2Entry, resolveInstallLayout } = pm2InstallLayout;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** GitHub publishes its current host keys here; read at install time, never pinned. */
export const GITHUB_META_URL = 'https://api.github.com/meta';
/** The three key types ADR-156 ك.2 requires; a partial answer is not an answer. */
export const REQUIRED_HOST_KEY_TYPES = Object.freeze(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa']);
/** `known_hosts` lines this installer owns; everything else in the file is left alone. */
const MANAGED_HOSTS = Object.freeze(['github.com', 'ssh.github.com', '[ssh.github.com]:443']);
const SSH_CONFIG_BEGIN = '# BEGIN nassaj node installer (ADR-156 WI-16)';
const SSH_CONFIG_END = '# END nassaj node installer (ADR-156 WI-16)';
const SAFE_NODE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SAFE_PROCESS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * The ONLY keys `--import-live-env` may write to config/node.env (ADR-156 §3.4,
 * C2): non-secret, non-privileged, and matching the server's boot allowlist
 * (`TMPDIR` alone). HOST, PORT, WEBAUTHN_*, NODE_OPTIONS and NASSAJ_RELEASE_SOURCE
 * are deliberately NOT importable — importing a live HOST/PORT/JWT would evict
 * users or drop passkeys (the ecosystem-file import was reversed direction).
 */
export const LIVE_ENV_IMPORT_ALLOWLIST = Object.freeze(['TMPDIR']);
/** Secret-shaped keys are never even OFFERED for acceptance; they stay in .env. */
const SECRET_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|WEBAUTHN|JWT|API_?KEY/i;
const isSecretKey = (key) => SECRET_KEY_PATTERN.test(key);
/** `api.github.com/meta` is a few KiB; anything larger is not the document we asked for. */
const MAX_META_BYTES = 1024 * 1024;

/** A step failure carries the single code the operator report is keyed on. */
export class NodeInstallError extends Error {
    constructor(code, message, action) {
        super(message);
        this.name = 'NodeInstallError';
        this.code = code;
        this.action = action;
    }
}

function syncDirectory(directory) {
    const fd = openSync(directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Durable replace-in-place: a half-written node.env is a node that will not boot. */
export function writeFileAtomic(file, contents, mode = 0o600) {
    const directory = path.dirname(file);
    mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
    const fd = openSync(temporary, 'wx', mode);
    try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    try {
        renameSync(temporary, file);
        syncDirectory(directory);
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
    return file;
}

/**
 * The environment the updater's own fetch will run under, plus exactly the two
 * SSH options ADR-156 mandates — `BatchMode` so a missing key fails instead of
 * hanging on a prompt, and `StrictHostKeyChecking=yes` against the known_hosts
 * file this installer just wrote. Both are *stricter* than the updater's
 * defaults; nothing here makes the probe succeed where the fetch would not,
 * which is the false green behind B-1053.
 */
export function probeEnvironment(env = process.env, { knownHostsPath } = {}) {
    const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
    if (knownHostsPath) options.push('-o', `UserKnownHostsFile=${knownHostsPath}`);
    return { ...releaseGitEnvironment(env), GIT_SSH_COMMAND: ['ssh', ...options].join(' ') };
}

function git(spawn, appRoot, args, env) {
    const result = spawn('git', ['-C', appRoot, ...args], { encoding: 'utf8', env, timeout: 60000 });
    return {
        status: result.status,
        stdout: (result.stdout || '').trim(),
        stderr: (result.stderr || '').trim(),
    };
}

/** Read the configured update remote; a node without one is not a git-checkout install. */
export function readRemoteUrl({ appRoot = ROOT, remote = 'origin', spawn = nodeSpawnSync } = {}) {
    const result = git(spawn, appRoot, ['remote', 'get-url', remote], process.env);
    if (result.status !== 0 || !result.stdout) {
        throw new NodeInstallError('remote_absent', `The '${remote}' remote is not configured in ${appRoot}.`,
            `Add it: git -C ${appRoot} remote add ${remote} git@github.com:<owner>/<repo>.git`);
    }
    return result.stdout;
}

/**
 * Derive the release-source identity from `origin` — the installer is the only
 * place this derivation is allowed (ADR-156 هـ.1): deriving it inside the server
 * would not take effect until a restart *and* would empty the `remote_mismatch`
 * guard of meaning, since the guard exists to compare the remote against an
 * authority established elsewhere.
 */
export function deriveReleaseSource(remoteUrl) {
    const parsed = normalizeGitHubRepositoryIdentity(remoteUrl);
    if (!parsed) {
        throw new NodeInstallError('remote_not_derivable',
            `'${remoteUrl}' is not a credential-free GitHub repository URL.`,
            'Point the remote at git@github.com:<owner>/<repo>.git, then re-run.');
    }
    return {
        owner: parsed.owner,
        repo: parsed.repo,
        identity: parsed.identity,
        sshUrl: `git@github.com:${parsed.owner}/${parsed.repo}.git`,
        httpsUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
    };
}

/** Put the update remote on SSH so the credential-free fetch can reach a private source. */
export function setRemoteSsh({ appRoot = ROOT, remote = 'origin', sshUrl, spawn = nodeSpawnSync } = {}) {
    const current = readRemoteUrl({ appRoot, remote, spawn });
    if (current === sshUrl) return { remote, url: sshUrl, changed: false, previousUrl: current };
    const result = git(spawn, appRoot, ['remote', 'set-url', remote, sshUrl], process.env);
    if (result.status !== 0) {
        throw new NodeInstallError('remote_set_failed', `Could not set ${remote} to ${sshUrl}: ${result.stderr}`,
            `Run it by hand: git -C ${appRoot} remote set-url ${remote} ${sshUrl}`);
    }
    return { remote, url: sshUrl, changed: true, previousUrl: current };
}

/** Fetch GitHub's currently published SSH host keys. No key material lives in this file. */
export async function fetchGitHubHostKeys({ fetch: fetchImpl = globalThis.fetch } = {}) {
    let response;
    try {
        response = await fetchImpl(GITHUB_META_URL, { headers: { accept: 'application/vnd.github+json' } });
    } catch (error) {
        throw new NodeInstallError('host_keys_unreachable', `Could not read ${GITHUB_META_URL}: ${error.message}`,
            'Restore outbound HTTPS to api.github.com, then re-run the installer.');
    }
    if (!response?.ok) {
        throw new NodeInstallError('host_keys_unreachable',
            `${GITHUB_META_URL} answered ${response?.status ?? 'no status'}.`,
            'Re-run the installer once api.github.com answers.');
    }
    const text = await response.text();
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_META_BYTES) {
        throw new NodeInstallError('host_keys_invalid', 'The GitHub meta document is not the expected size.',
            'Verify nothing is intercepting api.github.com, then re-run.');
    }
    let document;
    try { document = JSON.parse(text); } catch {
        throw new NodeInstallError('host_keys_invalid', 'The GitHub meta document is not JSON.',
            'Verify nothing is intercepting api.github.com, then re-run.');
    }
    const keys = Array.isArray(document?.ssh_keys) ? document.ssh_keys : null;
    if (!keys || !keys.every((key) => typeof key === 'string' && /^[a-z0-9-]+ [A-Za-z0-9+/=]+$/.test(key.trim()))) {
        throw new NodeInstallError('host_keys_invalid', 'The GitHub meta document carries no usable `ssh_keys`.',
            'Verify nothing is intercepting api.github.com, then re-run.');
    }
    const normalized = keys.map((key) => key.trim());
    const types = new Set(normalized.map((key) => key.split(' ')[0]));
    const missing = REQUIRED_HOST_KEY_TYPES.filter((type) => !types.has(type));
    if (missing.length) {
        // A partial answer would pin fewer algorithms than the client may negotiate,
        // which reads as "host key verification failed" long after the install.
        throw new NodeInstallError('host_keys_incomplete',
            `GitHub published no ${missing.join(', ')} host key.`,
            'Re-run the installer; do not hand-write a host key.');
    }
    return normalized;
}

/**
 * Rewrite only the lines this installer owns. Other hosts are preserved
 * verbatim, and a pre-existing *hashed* github.com entry is reported rather than
 * guessed at: it cannot be matched by name, and a stale hashed key is exactly
 * how a rotation turns into a silent "Host key verification failed".
 */
export function writeKnownHosts({ knownHostsPath, keys, readFile = readFileSync, writeFile = writeFileAtomic } = {}) {
    let existing = '';
    try { existing = readFile(knownHostsPath, 'utf8'); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const lines = existing ? existing.split('\n') : [];
    const kept = [];
    let hashedEntries = 0;
    let replaced = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('|1|')) { hashedEntries += 1; kept.push(line); continue; }
        const hosts = trimmed.split(/\s+/)[0].split(',');
        if (hosts.some((host) => MANAGED_HOSTS.includes(host))) { replaced += 1; continue; }
        kept.push(line);
    }
    const managed = [];
    for (const key of keys) {
        managed.push(`github.com ${key}`);
        managed.push(`[ssh.github.com]:443 ${key}`);
    }
    writeFile(knownHostsPath, `${[...kept, ...managed].join('\n')}\n`, 0o600);
    return { path: knownHostsPath, written: managed.length, replaced, hashedEntries };
}

function classifySshProbe({ status, stderr }) {
    const text = stderr || '';
    if (/successfully authenticated/i.test(text)) return 'authenticated';
    if (/Permission denied \(publickey/i.test(text) || /no matching host key/i.test(text)) return 'key_missing';
    if (/Host key verification failed/i.test(text)) return 'host_key_untrusted';
    if (/Connection (?:timed out|refused|closed)|Network is unreachable|Operation timed out|port 22/i.test(text)) return 'blocked';
    return status === 0 ? 'authenticated' : 'blocked';
}

/**
 * Probe port 22, then `ssh.github.com:443` when it is blocked — a corporate
 * network that drops 22 is the common case ADR-156 ك.2 calls out. The probe
 * never writes anything; the 443 routing is only offered, never assumed.
 */
export function probeGitHubSsh({ spawn = nodeSpawnSync, knownHostsPath, env = process.env } = {}) {
    const attempts = [];
    for (const port of [22, 443]) {
        const target = port === 443 ? 'git@ssh.github.com' : 'git@github.com';
        const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
        if (knownHostsPath) args.push('-o', `UserKnownHostsFile=${knownHostsPath}`);
        if (port === 443) args.push('-p', '443');
        const result = spawn('ssh', [...args, target], { encoding: 'utf8', env, timeout: 30000 });
        const outcome = classifySshProbe({ status: result.status, stderr: (result.stderr || '').trim() });
        attempts.push({ port, outcome, stderr: (result.stderr || '').trim() });
        // A key that is missing on 22 will be just as missing on 443: the fallback
        // answers "is the port reachable", not "is there a key".
        if (outcome !== 'blocked') return { port, outcome, attempts };
    }
    return { port: null, outcome: 'blocked', attempts };
}

/** The `~/.ssh/config` stanza that routes github.com over 443. Written only on request. */
export function sshConfigBlock() {
    return [
        SSH_CONFIG_BEGIN,
        'Host github.com',
        '    Hostname ssh.github.com',
        '    Port 443',
        SSH_CONFIG_END,
        '',
    ].join('\n');
}

/**
 * Write the 443 routing into the operator's SSH config. Gated behind an explicit
 * `--write-ssh-config`: this file governs every SSH session of the account, not
 * only Nassaj's fetch, so the installer never edits it as a side effect.
 */
export function writeSshConfig({ sshConfigPath, readFile = readFileSync, writeFile = writeFileAtomic } = {}) {
    let existing = '';
    try { existing = readFile(sshConfigPath, 'utf8'); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    if (existing.includes(SSH_CONFIG_BEGIN)) {
        const before = existing.slice(0, existing.indexOf(SSH_CONFIG_BEGIN));
        const afterIndex = existing.indexOf(SSH_CONFIG_END);
        const after = afterIndex === -1 ? '' : existing.slice(afterIndex + SSH_CONFIG_END.length).replace(/^\n/, '');
        writeFile(sshConfigPath, `${before}${sshConfigBlock()}${after}`, 0o600);
        return { path: sshConfigPath, replaced: true };
    }
    // The stanza goes first: OpenSSH keeps the *first* value it sees for a keyword.
    const prefix = existing && !existing.endsWith('\n') ? `${existing}\n` : existing;
    writeFile(sshConfigPath, `${sshConfigBlock()}${prefix ? `\n${prefix}` : ''}`, 0o600);
    return { path: sshConfigPath, replaced: false };
}

/**
 * The load-bearing verification: can *this* node fetch from the release source
 * with the credential-free environment the updater will actually use? A green
 * here is the answer B-1053 never had.
 */
export function verifyReleaseFetch({
    appRoot = ROOT, sshUrl, spawn = nodeSpawnSync, env = process.env, knownHostsPath,
} = {}) {
    // Deliberately no port override: the updater's fetch has none either, so a
    // 443 route must already be in ~/.ssh/config for this to be the same probe.
    const result = git(spawn, appRoot, ['ls-remote', sshUrl, 'HEAD'],
        probeEnvironment(env, { knownHostsPath }));
    if (result.status === 0) return { ok: true, sshUrl };
    const outcome = classifySshProbe({ status: result.status, stderr: result.stderr });
    if (outcome === 'key_missing') {
        throw new NodeInstallError('release_fetch_key_missing',
            `The credential-free fetch from ${sshUrl} was refused: no usable SSH key for this account.`,
            'Add a read-only deploy key: generate one with `ssh-keygen -t ed25519 -f ~/.ssh/nassaj_deploy -N ""`, '
            + 'register the public half on the repository as a deploy key with write access OFF, '
            + 'then re-run this installer.');
    }
    throw new NodeInstallError('release_fetch_failed',
        `The credential-free fetch from ${sshUrl} failed: ${result.stderr || 'no output'}`,
        outcome === 'blocked'
            ? 'Re-run with --write-ssh-config so github.com is routed over ssh.github.com:443.'
            : 'Settle SSH access for the service account, then re-run this installer.');
}

function renderNodeEnv(values) {
    const header = [
        '# Nassaj node values — operator-owned, never tracked (ADR-156 د.1).',
        '# Written by scripts/install-node.mjs (WI-16). PM2 loads this file into the',
        '# supervised process environment; config/release-source.lock.json attests the',
        '# release source named here and a disagreement fails the update closed.',
        '',
    ];
    const body = Object.entries(values)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`);
    return `${[...header, ...body].join('\n')}\n`;
}

/** Node values live in `config/node.env`, which is gitignored ahead of any writer (B-1050). */
export function writeNodeEnv({ configDir, values, writeFile = writeFileAtomic } = {}) {
    const file = path.join(configDir, 'node.env');
    writeFile(file, renderNodeEnv(values), 0o600);
    return { path: file, values };
}

/**
 * Pin the release-source identity TOFU. Re-running the installer against the same
 * identity is idempotent; a *different* identity is refused rather than
 * overwritten, because silently re-pinning is exactly the authority change the
 * pin exists to make visible (ADR-156 هـ.2.4).
 */
export function writeReleaseSourceLock({
    configDir, identity, repositoryUrl, confirmedBy,
    now = () => new Date().toISOString(), readFile = readFileSync, writeFile = writeFileAtomic,
} = {}) {
    const file = path.join(configDir, 'release-source.lock.json');
    let existing = null;
    try { existing = JSON.parse(readFile(file, 'utf8')); } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw new NodeInstallError('release_source_lock_unreadable',
                `${file} exists but cannot be read as the pin: ${error.message}`,
                'Inspect the file, settle which repository owns this node, then remove or repair it.');
        }
    }
    if (existing && existing.identity !== identity) {
        throw new NodeInstallError('release_source_lock_conflict',
            `This node is already pinned to ${existing.identity}; the remote now derives ${identity}.`,
            'Decide which repository owns this node\'s releases; the installer will not re-pin silently.');
    }
    if (existing && existing.identity === identity) return { path: file, pinned: existing, changed: false };
    const pinned = {
        schema: RELEASE_SOURCE_LOCK_SCHEMA, identity, repositoryUrl, pinnedAt: now(), confirmedBy,
    };
    writeFile(file, `${JSON.stringify(pinned, null, 2)}\n`, 0o600);
    return { path: file, pinned, changed: true };
}

function installExactFile(source, target, mode) {
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Installer source is unsafe: ${source}`);
    const bytes = readFileSync(source);
    if (existsSync(target)) {
        const current = lstatSync(target);
        if (!current.isFile() || current.isSymbolicLink()) {
            throw new NodeInstallError('launcher_target_unsafe', `${target} is not a regular file.`,
                'Remove the foreign entry, then re-run the installer.');
        }
        if (readFileSync(target).equals(bytes)) { chmodSync(target, mode); return false; }
    }
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    copyFileSync(source, temporary);
    chmodSync(temporary, mode);
    renameSync(temporary, target);
    syncDirectory(path.dirname(target));
    return true;
}

/**
 * The sealed release store the release entry boots (`nassaj-release-launcher.mjs`
 * `inspectSealedRelease`). Without it `pm2-entry.mjs` exits on its first line,
 * so wiring PM2 to it would install a node that never starts (qa-critic C3).
 */
export function assertSealedReleaseLayout(deployRoot) {
    if (!deployRoot || !path.isAbsolute(deployRoot)) {
        throw new NodeInstallError('deploy_root_invalid', 'The deploy root must be an absolute path.',
            'Pass --release-layout --deploy-root <absolute path>.');
    }
    const current = path.join(deployRoot, 'current');
    let sealed = false;
    try {
        sealed = lstatSync(current).isSymbolicLink() && existsSync(path.join(current, 'runtime-generation.json'));
    } catch { sealed = false; }
    if (!sealed) {
        throw new NodeInstallError('release_layout_absent',
            `${deployRoot} holds no sealed release store (current -> releases/<generation> with runtime-generation.json).`,
            'Omit --release-layout to install this git checkout, or bootstrap the sealed release store first.');
    }
    return { deployRoot, current };
}

/**
 * Place the release-borne PM2 entry beside the launcher (release layout only).
 * PM2 loads a fork-mode script from inside its own CommonJS container, so the
 * launcher's `argv[1]` self-execution guard never fires when PM2 is pointed at
 * the launcher directly: the process reports healthy, binds no port and writes
 * no log (memo item 4). The entry ships with the release and verifies the
 * launcher digest itself, so the two are installed as the reviewed pair they are.
 */
export function installPm2Entry({ appRoot = ROOT, deployRoot } = {}) {
    assertSealedReleaseLayout(deployRoot);
    const launcherRoot = path.join(deployRoot, 'launcher');
    mkdirSync(launcherRoot, { recursive: true, mode: 0o755 });
    const launcherChanged = installExactFile(
        path.join(appRoot, 'scripts', 'nassaj-release-launcher.mjs'),
        path.join(launcherRoot, 'nassaj-release-launcher.mjs'), 0o755);
    const entryChanged = installExactFile(
        path.join(appRoot, 'scripts', 'pm2-entry.mjs'),
        path.join(launcherRoot, 'pm2-entry.mjs'), 0o755);
    return {
        launcherRoot,
        entry: path.join(launcherRoot, 'pm2-entry.mjs'),
        changed: launcherChanged || entryChanged,
    };
}

/**
 * Generate the node's ecosystem file *into `config/`* rather than the install
 * root: a generated file at the root is an untracked file, and an untracked file
 * at the root is the `dirty_worktree` refusal of B-1050.
 *
 * The generated file derives its PM2 contract from the tracked
 * `ecosystem.config.example.cjs` instead of copying it, so the drain and
 * kill-timeout semantics stay owned by one reviewed file, and reads node values
 * from `config/node.env` so regenerating never re-states them.
 */
export function generateEcosystem({
    appRoot = ROOT, configDir, layout = GIT_CHECKOUT_LAYOUT, deployRoot, node, port = '3004', databasePath,
    processName = 'nassaj-dev', writeFile = writeFileAtomic, verify = verifyGeneratedEcosystem,
} = {}) {
    const resolvedLayout = resolveInstallLayout(layout);
    const release = resolvedLayout === RELEASE_LAYOUT;
    if (release && (!deployRoot || !path.isAbsolute(deployRoot))) {
        throw new NodeInstallError('deploy_root_invalid', 'The deploy root must be an absolute path.',
            'Pass --release-layout --deploy-root <absolute path>.');
    }
    if (!SAFE_NODE_NAME.test(node || '')) {
        throw new NodeInstallError('node_name_invalid', `'${node}' is not a valid node name.`,
            'Use lowercase letters, digits, dashes or underscores for --node.');
    }
    if (!SAFE_PROCESS_NAME.test(processName)) {
        throw new NodeInstallError('process_name_invalid', `'${processName}' is not a valid PM2 process name.`,
            'Pass a simple name to --process-name.');
    }
    if (!/^\d{2,5}$/.test(String(port))) {
        throw new NodeInstallError('port_invalid', `'${port}' is not a valid port.`, 'Pass --port <number>.');
    }
    const file = path.join(configDir, `ecosystem.${node}.config.cjs`);
    const contents = `// Generated by scripts/install-node.mjs for node "${node}" (ADR-156, WI-16).
// Regenerate rather than edit: node values belong in config/node.env, and the
// PM2 contract (drain, kill timeout, stop codes) belongs to the tracked
// ecosystem.config.example.cjs this file derives from.
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = ${JSON.stringify(appRoot)};
const LAYOUT = ${JSON.stringify(resolvedLayout)};${release ? `\nconst DEPLOY_ROOT = ${JSON.stringify(deployRoot)};` : ''}

/** config/node.env is the operator-owned source of node values (ADR-156 د.1). */
function readNodeEnv(file) {
  const values = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return values;
  }
  for (const line of text.split('\\n')) {
    const match = /^\\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^(['"])(.*)\\1$/, '$2');
  }
  return values;
}

const nodeEnv = readNodeEnv(path.join(APP_ROOT, 'config', 'node.env'));

// The example derives the PM2 entry (script + cwd) from the layout, through
// scripts/lib/pm2-install-layout.cjs — the same rule the update pre-flight's
// pm2_entry code checks the running process against.
process.env.NASSAJ_INSTALL_LAYOUT = LAYOUT;${release ? '\nprocess.env.NASSAJ_DEPLOY_ROOT = DEPLOY_ROOT;' : ''}
const base = require(path.join(APP_ROOT, 'ecosystem.config.example.cjs')).apps[0];

module.exports = {
  apps: [{
    ...base,
    name: ${JSON.stringify(processName)},
    args: '--port ${port}',
    env: {
      ...base.env,
      NASSAJ_INSTALL_LAYOUT: LAYOUT,${release ? '\n      NASSAJ_DEPLOY_ROOT: DEPLOY_ROOT,' : ''}
      // safe-restart.sh and the pre-flight address the process by this name.
      PROC_NAME: ${JSON.stringify(processName)},
      NASSAJ_PROCESS_NAME: ${JSON.stringify(processName)},
      SERVER_PORT: '${port}',${databasePath ? `\n      DATABASE_PATH: ${JSON.stringify(databasePath)},` : ''}
      // B-881: the build tmpdir must be on disk; /tmp is tmpfs and the updater refuses it.
      TMPDIR: '/var/tmp',
      // node.env wins: it is what the operator owns, and it carries
      // NASSAJ_RELEASE_SOURCE, which config/release-source.lock.json attests.
      ...nodeEnv,
    },
  }],
};
`;
    writeFile(file, contents, 0o644);
    const expected = expectedPm2Entry({ layout: resolvedLayout, appRoot, deployRoot });
    verify(file, expected);
    return { path: file, layout: resolvedLayout, script: expected.script, cwd: expected.cwd };
}

/**
 * Load the file just written, exactly as `pm2 start` will, and prove its entry is
 * the one the layout requires. The installer's green is worth nothing if the
 * generated file points PM2 somewhere else (qa-critic C3).
 */
export function verifyGeneratedEcosystem(file, expected) {
    const load = createRequire(file);
    const saved = { layout: process.env.NASSAJ_INSTALL_LAYOUT, deployRoot: process.env.NASSAJ_DEPLOY_ROOT };
    let app;
    try {
        for (const key of Object.keys(load.cache)) delete load.cache[key];
        app = load(file).apps?.[0];
    } finally {
        for (const [key, value] of [['NASSAJ_INSTALL_LAYOUT', saved.layout], ['NASSAJ_DEPLOY_ROOT', saved.deployRoot]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
    if (app?.script !== expected.script || (app?.cwd ?? null) !== expected.cwd) {
        throw new NodeInstallError('ecosystem_entry_mismatch',
            `${file} starts ${app?.script} (cwd ${app?.cwd ?? 'unset'}); the ${expected.layout} layout needs `
            + `${expected.script} (cwd ${expected.cwd ?? 'unset'}).`,
            'This is a bug in the installer or in ecosystem.config.example.cjs; do not start PM2 from this file.');
    }
    return app;
}

/**
 * Seed the directories the atomic client build expects to already exist (B-1060).
 *
 * `assetInventory` lstats `dist/` and walks `dist/assets`, and the exchange
 * support check refuses an absent live directory — so on a genuinely fresh
 * install the *first* build fails before it produces anything. Both paths are
 * gitignored, so seeding them leaves no trace in the install root.
 */
export function seedFirstBuildDirectories({ appRoot = ROOT } = {}) {
    const created = [];
    for (const relative of ['dist', 'dist/assets', 'dist-server']) {
        const directory = path.join(appRoot, relative);
        if (existsSync(directory)) continue;
        mkdirSync(directory, { recursive: true, mode: 0o755 });
        created.push(relative);
    }
    return { created };
}

/**
 * Seal the served-generation archive a freshly built dist requires (B-1293).
 *
 * The candidate build rewrites `dist/index.html` to load
 * `/assets/generations/<generationId>/…`, and those URLs are served ONLY from
 * `.nassaj-local-preview/client-assets/generations/<generationId>` by
 * `server/services/client-publication-static.js`. The update button prepares
 * that archive through `prepareClientPublicationAssets`; a fresh `git clone`
 * install that merely drops a candidate-built dist never did, so the very first
 * page load was a white page — every generation-scoped asset returned 404 — until
 * an operator copied dist into the archive by hand on each node (measured
 * 2026-09-22 on two fleet nodes).
 *
 * This runs the SAME contract the update path runs (`server/index.js`
 * `completeBootstrappedSourceUpdate`): validate the sealed dist manifest, verify
 * its asset closure with `verifyAssetClosure`, and atomically publish the served
 * copy. It is idempotent — `prepareClientPublicationAssets` revalidates and
 * returns an already-present generation without copying — and a no-op when dist
 * carries no sealed manifest (a genuinely empty fresh tree, or a dev build with
 * no generation URLs), so it never invents an archive. The archive lives under
 * `.nassaj-local-preview/`, which is gitignored, so it leaves no trace in the
 * install root (asserted alongside the other writes by `assertNoUntrackedTrace`).
 */
export function prepareServedClientGeneration({ appRoot = ROOT } = {}) {
    const dist = path.join(appRoot, 'dist');
    if (!existsSync(path.join(dist, 'CLIENT_ASSET_MANIFEST.json'))) {
        return { prepared: false, reason: 'no_sealed_dist' };
    }
    const destination = prepareClientPublicationAssets(appRoot, dist, {}, verifyAssetClosure,
        { reserveBytes: 2 * 1024 ** 3 });
    return { prepared: true, generationId: path.basename(destination), destination };
}

/**
 * Close the report with the read-only pre-flight (WI-8). The installer never
 * interprets it: the pre-flight codes belong to `doctor.mjs`, and a second opinion
 * written here would be a second contract to keep in step.
 */
export function runUpdatePreflight({ appRoot = ROOT, spawn = nodeSpawnSync } = {}) {
    const result = spawn(process.execPath, [path.join(appRoot, 'scripts', 'doctor.mjs'), '--update-preflight'],
        { cwd: appRoot, encoding: 'utf8', timeout: 300000 });
    return {
        status: result.status,
        stdout: (result.stdout || '').trim(),
        stderr: (result.stderr || '').trim(),
    };
}

/**
 * Prove the promise this installer makes: nothing it wrote is an untracked file
 * in the install root. A single stray file there converts every future update
 * into a `dirty_worktree` refusal (B-1050).
 */
export function assertNoUntrackedTrace({ appRoot = ROOT, paths, spawn = nodeSpawnSync } = {}) {
    const inside = paths.filter((file) => file.startsWith(`${appRoot}${path.sep}`));
    if (!inside.length) return { checked: [] };
    const relative = inside.map((file) => path.relative(appRoot, file));
    const result = spawn('git', ['-C', appRoot, 'check-ignore', '--', ...relative], { encoding: 'utf8' });
    const ignored = new Set((result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean));
    const exposed = relative.filter((file) => !ignored.has(file));
    if (exposed.length) {
        throw new NodeInstallError('install_root_polluted',
            `The installer would leave untracked files in the install root: ${exposed.join(', ')}`,
            'This is a bug in the installer: node state belongs under config/ or .artifacts/.');
    }
    return { checked: relative };
}

async function confirmDerivedSource({ identity, sshUrl, assumeYes, input = process.stdin, output = process.stdout }) {
    const line = `Derived release source: ${identity}  (NASSAJ_RELEASE_SOURCE=${sshUrl})`;
    if (assumeYes) {
        output.write(`${line}\n  confirmed by --yes\n`);
        return true;
    }
    if (!input.isTTY) {
        throw new NodeInstallError('release_source_unconfirmed',
            `${line}\nThe release source is never derived silently (ADR-156 هـ.2.1).`,
            'Re-run with --yes, or run the installer on a terminal to confirm interactively.');
    }
    const rl = readline.createInterface({ input, output });
    try {
        const answer = await rl.question(`${line}\nPin this repository as the release authority for this node? [y/N] `);
        if (!/^y(es)?$/i.test(answer.trim())) {
            throw new NodeInstallError('release_source_declined', 'The operator declined the derived release source.',
                'Point the remote at the repository that owns this node\'s releases, then re-run.');
        }
    } finally {
        rl.close();
    }
    return true;
}

/** Run every step in order, stopping at the first one with a single named action. */
export async function installNode({
    appRoot = ROOT,
    layout = GIT_CHECKOUT_LAYOUT,
    deployRoot,
    node,
    port = '3004',
    databasePath,
    processName = 'nassaj-dev',
    remote = 'origin',
    assumeYes = false,
    writeSshConfigAllowed = false,
    homeDir = os.homedir(),
    env = process.env,
    spawn = nodeSpawnSync,
    fetch: fetchImpl = globalThis.fetch,
    now = () => new Date().toISOString(),
    confirm = confirmDerivedSource,
    output = process.stdout,
} = {}) {
    const steps = [];
    const record = (name, detail) => { steps.push({ step: name, ...detail }); return detail; };
    const configDir = path.join(appRoot, 'config');
    const sshDir = path.join(homeDir, '.ssh');
    const knownHostsPath = path.join(sshDir, 'known_hosts');
    const resolvedLayout = resolveInstallLayout(layout);
    // Before any write: the release entry boots only a sealed store (C3).
    if (resolvedLayout === RELEASE_LAYOUT) assertSealedReleaseLayout(deployRoot);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });

    const source = deriveReleaseSource(readRemoteUrl({ appRoot, remote, spawn }));
    record('derive-release-source', { identity: source.identity, sshUrl: source.sshUrl });
    await confirm({ identity: source.identity, sshUrl: source.sshUrl, assumeYes, output });

    const keys = await fetchGitHubHostKeys({ fetch: fetchImpl });
    record('host-keys', writeKnownHosts({ knownHostsPath, keys }));

    const probe = record('ssh-probe', probeGitHubSsh({ spawn, knownHostsPath, env }));
    if (probe.outcome === 'key_missing') {
        throw new NodeInstallError('release_fetch_key_missing',
            'GitHub is reachable but this account has no usable SSH key.',
            'Add a read-only deploy key: `ssh-keygen -t ed25519 -f ~/.ssh/nassaj_deploy -N ""`, register the '
            + 'public half on the repository as a deploy key with write access OFF, then re-run this installer.');
    }
    if (probe.outcome === 'host_key_untrusted') {
        throw new NodeInstallError('github_host_key_untrusted',
            `GitHub's key was refused against ${knownHostsPath} even after the published keys were written.`,
            'Remove any stale or hashed github.com entry from that file, then re-run the installer.');
    }
    if (probe.port === null) {
        throw new NodeInstallError('github_ssh_blocked',
            'Neither github.com:22 nor ssh.github.com:443 accepted a connection.',
            'Open outbound SSH to github.com (port 22) or ssh.github.com (port 443), then re-run.');
    }
    if (probe.port === 443) {
        if (!writeSshConfigAllowed) {
            // Without the routing in ~/.ssh/config the *updater's* fetch still goes to
            // port 22 and still fails; a green here would be a false green.
            throw new NodeInstallError('ssh_config_required',
                `Port 22 is blocked; ssh.github.com:443 works.\n${sshConfigBlock()}`,
                'Re-run with --write-ssh-config to have the installer add that stanza to ~/.ssh/config.');
        }
        record('ssh-config', writeSshConfig({ sshConfigPath: path.join(sshDir, 'config') }));
    }

    record('remote', setRemoteSsh({ appRoot, remote, sshUrl: source.sshUrl, spawn }));
    record('release-fetch', verifyReleaseFetch({ appRoot, sshUrl: source.sshUrl, spawn, env, knownHostsPath }));

    const confirmedBy = `${env.SUDO_USER || env.USER || env.LOGNAME || 'unknown'}@${os.hostname()}`;
    const nodeEnv = record('node-env', writeNodeEnv({
        configDir,
        values: {
            NASSAJ_RELEASE_SOURCE: source.sshUrl,
            NASSAJ_UPDATE_REMOTE: remote,
            TMPDIR: '/var/tmp',
            ...(databasePath ? { DATABASE_PATH: databasePath } : {}),
        },
    }));
    const lock = record('release-source-lock', writeReleaseSourceLock({
        configDir, identity: source.identity, repositoryUrl: source.sshUrl, confirmedBy, now,
    }));

    const entry = resolvedLayout === RELEASE_LAYOUT
        ? record('pm2-entry', installPm2Entry({ appRoot, deployRoot }))
        : null;
    const ecosystem = record('ecosystem', generateEcosystem({
        appRoot, configDir, layout: resolvedLayout, deployRoot, node, port, databasePath, processName,
    }));
    record('first-build-seed', seedFirstBuildDirectories({ appRoot }));
    const archive = record('client-archive', prepareServedClientGeneration({ appRoot }));

    record('install-root', assertNoUntrackedTrace({
        appRoot, spawn,
        paths: [nodeEnv.path, lock.path, ecosystem.path, path.join(appRoot, 'dist'), path.join(appRoot, 'dist-server'),
            ...(archive.destination ? [archive.destination] : [])],
    }));

    const preflight = record('update-preflight', runUpdatePreflight({ appRoot, spawn }));
    output.write(`\n${preflight.stdout || preflight.stderr}\n`);
    return { source, steps, entry, ecosystem, nodeEnv, lock, preflight };
}

/** Parse a `KEY=value` env file's text into a plain object (values used only internally). */
export function parseEnvFileText(text) {
    const out = {};
    if (typeof text !== 'string') return out;
    for (const line of text.split('\n')) {
        if (/^\s*#/.test(line)) continue;
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        out[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    return out;
}

/**
 * The LIVE pm2 process environment for the named process (ADR-156 §3.4 C2): the
 * source of truth for the import, read from `pm2 jlist` as JSON — never by
 * `require()` of a .cjs, and with pm2's stderr MUTED so a malformed answer can
 * never echo a source line with its values. Returns the `pm2_env.env` object or
 * null; a JSON SyntaxError yields null without printing anything.
 */
export function readLivePm2Env({ appRoot = ROOT, processName = 'nassaj-dev', spawn = nodeSpawnSync } = {}) {
    const result = spawn('pm2', ['jlist'], {
        encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    let processes;
    try { processes = JSON.parse(result.stdout.slice(result.stdout.indexOf('['))); } catch { return null; }
    if (!Array.isArray(processes)) return null;
    const app = processes.find((entry) => entry?.name === processName)
        || processes.find((entry) => {
            try { return realpathSync(entry?.pm2_env?.pm_cwd || '') === realpathSync(appRoot); } catch { return false; }
        });
    if (!app) return null;
    const envObject = app?.pm2_env?.env;
    return envObject && typeof envObject === 'object' && !Array.isArray(envObject) ? envObject : null;
}

/**
 * `--import-live-env` (ADR-156 §3.4 step 2, C2, T-1730 W11). Shows a NAME-ONLY
 * diff of the live pm2 env against .env and the current config/node.env, and
 * writes ONLY the allowlisted (`TMPDIR`), non-secret keys named with an explicit
 * `--accept <KEY>`. It never prints a value, never imports a secret, and never
 * replaces a key without `--accept`. Written with mode 0600.
 */
export function importLiveEnv({
    appRoot = ROOT, processName = 'nassaj-dev', accept = [], spawn = nodeSpawnSync,
    output = process.stdout, readFile = readFileSync, writeFile = writeFileAtomic,
} = {}) {
    const configDir = path.join(appRoot, 'config');
    const liveEnv = readLivePm2Env({ appRoot, processName, spawn });
    if (!liveEnv) {
        output.write('Could not read the live pm2 environment (is the daemon running and the process named correctly?).\n');
        output.write(`  Try: pm2 jlist   # confirm the process name, then re-run with --process-name <name>\n`);
        return { ok: false, reason: 'live_env_unreadable', written: [], refused: [] };
    }
    const dotenv = parseEnvFileText(tryReadFile(readFile, path.join(appRoot, '.env')));
    const nodeEnv = parseEnvFileText(tryReadFile(readFile, path.join(configDir, 'node.env')));

    output.write('\nLive pm2 env vs .env vs config/node.env — NAMES only, no values (ADR-156 §3.4 C2).\n\n');
    const keys = [...new Set([...Object.keys(liveEnv), ...Object.keys(dotenv), ...Object.keys(nodeEnv)])].sort();
    for (const key of keys) {
        const present = [
            liveEnv[key] !== undefined && 'live',
            dotenv[key] !== undefined && '.env',
            nodeEnv[key] !== undefined && 'node.env',
        ].filter(Boolean);
        const values = [liveEnv[key], dotenv[key], nodeEnv[key]].filter((v) => v !== undefined);
        const verdict = values.length <= 1 ? `only ${present.join('')}` : (values.every((v) => v === values[0]) ? 'match' : 'differ');
        const secret = isSecretKey(key);
        const importable = LIVE_ENV_IMPORT_ALLOWLIST.includes(key) && !secret
            && liveEnv[key] !== undefined && liveEnv[key] !== nodeEnv[key];
        const tags = [
            secret ? 'secret — stays in .env, not importable' : null,
            !secret && !LIVE_ENV_IMPORT_ALLOWLIST.includes(key) ? 'blocked — not in the import allowlist' : null,
            importable ? 'importable with --accept' : null,
        ].filter(Boolean);
        output.write(`  ${key}  [${present.join(',')}] ${verdict}${tags.length ? `  (${tags.join('; ')})` : ''}\n`);
    }

    const written = [];
    const refused = [];
    for (const key of accept) {
        if (isSecretKey(key)) { refused.push(`${key} (secret — never imported)`); continue; }
        if (!LIVE_ENV_IMPORT_ALLOWLIST.includes(key)) { refused.push(`${key} (not in the import allowlist; only ${LIVE_ENV_IMPORT_ALLOWLIST.join(', ')})`); continue; }
        if (liveEnv[key] === undefined) { refused.push(`${key} (absent from the live pm2 env)`); continue; }
        written.push(key);
    }

    if (written.length > 0) {
        const merged = { ...nodeEnv };
        for (const key of written) merged[key] = liveEnv[key];
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        writeFile(path.join(configDir, 'node.env'), renderNodeEnv(merged), 0o600);
        output.write(`\nWrote ${written.length} key(s) to config/node.env (mode 0600): ${written.join(', ')}\n`);
    } else {
        output.write('\nNothing written. Re-run with --accept <KEY> for an allowlisted key to import it.\n');
    }
    if (refused.length > 0) output.write(`Refused: ${refused.join('; ')}\n`);
    return { ok: true, written, refused };
}

/** Read a file's text, or '' when absent/unreadable — never throws into the diff. */
function tryReadFile(readFile, file) {
    try { return readFile(file, 'utf8'); } catch { return ''; }
}

function parseArguments(argv) {
    const options = { assumeYes: false, writeSshConfigAllowed: false, layout: GIT_CHECKOUT_LAYOUT };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const take = () => {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
            index += 1;
            return value;
        };
        if (flag === '--node') options.node = take();
        else if (flag === '--deploy-root') options.deployRoot = take();
        else if (flag === '--port') options.port = take();
        else if (flag === '--database-path') options.databasePath = take();
        else if (flag === '--process-name') options.processName = take();
        else if (flag === '--remote') options.remote = take();
        else if (flag === '--yes') options.assumeYes = true;
        else if (flag === '--write-ssh-config') options.writeSshConfigAllowed = true;
        else if (flag === '--release-layout') options.layout = RELEASE_LAYOUT;
        else throw new Error(`Unknown argument: ${flag}`);
    }
    if (!options.node) throw new Error('--node <name> is required');
    const release = options.layout === RELEASE_LAYOUT;
    if (release && !options.deployRoot) throw new Error('--release-layout requires --deploy-root <path>');
    if (!release && options.deployRoot) {
        // A git checkout runs from its own tree; a deploy root here would be ignored,
        // and an ignored flag is how C3 shipped an unbootable entry.
        throw new Error('--deploy-root applies only with --release-layout');
    }
    return options;
}

/** `--import-live-env` takes its own small argument set (no --node required). */
export function parseImportArguments(argv) {
    const options = { processName: 'nassaj-dev', accept: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const take = () => {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
            index += 1;
            return value;
        };
        if (flag === '--import-live-env') continue;
        else if (flag === '--process-name') options.processName = take();
        else if (flag === '--accept') options.accept.push(take());
        else throw new Error(`Unknown argument for --import-live-env: ${flag}`);
    }
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--import-live-env')) {
        try {
            const result = importLiveEnv(parseImportArguments(process.argv.slice(2)));
            process.exitCode = result.ok ? 0 : 1;
        } catch (error) {
            process.stderr.write(`\nImport stopped (${error.code || 'invalid_arguments'}).\n  ${error.message}\n`);
            process.exitCode = 78;
        }
    } else {
    try {
        const result = await installNode(parseArguments(process.argv.slice(2)));
        process.stdout.write(`\nNode install complete: ${result.source.identity}\n`);
    } catch (error) {
        process.stderr.write(`\nNassaj node install stopped (${error.code || 'invalid_arguments'}).\n`);
        process.stderr.write(`  ${error.message}\n`);
        if (error.action) process.stderr.write(`  Do this: ${error.action}\n`);
        process.exitCode = 78;
    }
    }
}
