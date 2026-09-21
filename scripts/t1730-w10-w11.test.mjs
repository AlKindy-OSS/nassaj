/**
 * T-1730 Wt — W10 (doctor --seal-overlay / --explain-divergence) and
 * W11 (install-node --import-live-env) contract tests (ADR-156 §7).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { importLiveEnv, LIVE_ENV_IMPORT_ALLOWLIST } from './install-node.mjs';
import { sealDigest } from './lib/node-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor.mjs');

function tmpDir(t) {
    const dir = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-t1730-w10-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function runDoctor(args, extraEnv = {}) {
    return spawnSync(process.execPath, [DOCTOR, ...args], {
        cwd: ROOT, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, ...extraEnv },
    });
}

// ---------------------------------------------------------------------------
// W10: --seal-overlay structural guards (ADR-156 §3.1 C1.1, §7)
// ---------------------------------------------------------------------------

test('W10: --seal-overlay refuses a symlink inside the overlay directory', (t) => {
    const dir = tmpDir(t);
    // Build a minimal config/node-overlay.json pointing to our tmp dir
    const configDir = path.join(dir, 'config');
    mkdirSync(path.join(configDir, 'overlay', 'static', 'hub'), { recursive: true });
    writeFileSync(path.join(configDir, 'node-overlay.json'), JSON.stringify({
        schema: 1, static: [{ mount: '/hub', dir: 'static/hub' }],
    }));
    // Place a symlink inside static/hub — the sealer must refuse it
    symlinkSync('/etc/passwd', path.join(configDir, 'overlay', 'static', 'hub', 'evil.html'));

    const result = spawnSync(process.execPath, [DOCTOR, '--seal-overlay'], {
        cwd: dir, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, TMPDIR: process.env.TMPDIR || '/var/tmp' },
    });
    // Doctor will exit non-zero and mention the symlink in its output
    assert.notEqual(result.status, 0, '--seal-overlay must exit non-zero when symlinks are present');
    assert.match(result.stdout + result.stderr, /symlink|يُرفض|refused/, 'output must mention symlink rejection');
    // Manifest must NOT be written
    let written = false;
    try { statSync(path.join(configDir, 'node-overlay.lock.json')); written = true; } catch {}
    assert.equal(written, false, 'no lock file must be written when symlinks are present');
});

test('W10: sealDigest produces consistent sha256 for the same bytes', () => {
    const buf = Buffer.from('hello overlay');
    const digest = sealDigest(buf);
    assert.match(digest, /^[a-f0-9]{64}$/, 'sealDigest produces a hex sha256');
    assert.equal(sealDigest(buf), digest, 'deterministic for same content');
    assert.notEqual(sealDigest(Buffer.from('other')), digest, 'different content → different digest');
});

test('W10: --explain-divergence refuses to print when code class is non-empty', (t) => {
    const bin = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-doctor-bin-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));

    // git diff --name-status outputs a code-class file: public/sw.js is directly under public/
    const gitScript = `#!/bin/sh
case "$*" in
  *"merge-base HEAD"*) echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0;;
  *"merge-base --is-ancestor"*) exit 1;;
  *"diff --name-status"*) printf 'M\\0public/sw.js\\0'; exit 0;;
  *"ls-tree -r --name-only"*) printf ''; exit 0;;
  *"diff --numstat"*) exit 0;;
  *"show "*) echo '{}'; exit 0;;
  *"rev-parse --verify"*) echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0;;
  *"rev-parse --short"*) echo "aaaaaaa"; exit 0;;
  *"tag -l"*) echo "v1.47.0.10"; exit 0;;
  *"status --porcelain"*) printf ''; exit 0;;
  *) exit 0;;
esac`;
    writeFileSync(path.join(bin, 'git'), gitScript, { mode: 0o755 });

    const result = spawnSync(process.execPath, [DOCTOR, '--explain-divergence', '--target', 'v1.47.0.10'], {
        cwd: ROOT, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: process.env.TMPDIR || '/var/tmp' },
    });
    assert.notEqual(result.status, 0, '--explain-divergence must exit non-zero when code class is non-empty');
    const out = result.stdout + result.stderr;
    assert.match(out, /يُرفض|Refusing|code/i, 'output must mention refusal reason');
    // Must not print git reset or git branch backup commands
    assert.doesNotMatch(out, /git reset/, 'must not print reset command when refusing');
    assert.doesNotMatch(out, /git branch backup/, 'must not print backup-branch when refusing');
});

// ---------------------------------------------------------------------------
// W11: --import-live-env contract tests (ADR-156 §3.4 step 2, C2, §7)
// ---------------------------------------------------------------------------

function makeCapture() {
    const chunks = [];
    return {
        write: (s) => { chunks.push(s); },
        toString: () => chunks.join(''),
    };
}

function fakeSpawn(liveEnvJson) {
    return (_cmd, _args, _opts) => ({
        status: 0,
        stdout: JSON.stringify([{ name: 'nassaj-dev', pm2_env: { env: liveEnvJson } }]),
        stderr: '',
    });
}

test('W11: --import-live-env output contains NO values — names only', () => {
    const output = makeCapture();
    const liveEnv = { TMPDIR: '/var/tmp', JWT_SECRET: 'super-secret', DATABASE_PATH: '/opt/nassaj/db.sqlite' };
    importLiveEnv({
        appRoot: '/fake', processName: 'nassaj-dev',
        spawn: fakeSpawn(liveEnv), output,
        readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
        writeFile: () => { throw new Error('must not write'); },
    });
    const out = output.toString();
    // Output must not contain any secret value
    assert.doesNotMatch(out, /super-secret/, 'JWT_SECRET value must not appear in output');
    assert.doesNotMatch(out, /\/opt\/nassaj\/db\.sqlite/, 'DATABASE_PATH value must not appear in output');
    assert.doesNotMatch(out, /\/var\/tmp/, 'TMPDIR value must not appear in output');
    // Key names must appear
    assert.match(out, /TMPDIR/, 'TMPDIR key name must appear');
    assert.match(out, /JWT_SECRET/, 'JWT_SECRET key name must appear');
});

test('W11: --import-live-env writes 0600 when --accept is used', (t) => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-w11-write-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let writtenMode = null;
    let writtenPath = null;
    const output = makeCapture();
    const liveEnv = { TMPDIR: '/var/tmp' };
    importLiveEnv({
        appRoot: dir, processName: 'nassaj-dev', accept: ['TMPDIR'],
        spawn: fakeSpawn(liveEnv), output,
        readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
        writeFile: (filePath, _content, mode) => { writtenMode = mode; writtenPath = filePath; },
    });
    assert.equal(writtenMode, 0o600, 'node.env must be written with mode 0600');
    assert.match(writtenPath, /node\.env$/, 'written to config/node.env');
});

test('W11: --import-live-env refuses secret keys even with --accept', () => {
    const output = makeCapture();
    const liveEnv = { JWT_SECRET: 'super-secret', TMPDIR: '/var/tmp' };
    const result = importLiveEnv({
        appRoot: '/fake', processName: 'nassaj-dev', accept: ['JWT_SECRET'],
        spawn: fakeSpawn(liveEnv), output,
        readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
        writeFile: () => { throw new Error('must not write secret'); },
    });
    assert.ok(result.refused.some((r) => r.includes('JWT_SECRET') && r.includes('secret')),
        'JWT_SECRET must be in refused list with secret reason');
    // output must not contain the secret value
    assert.doesNotMatch(output.toString(), /super-secret/);
});

test('W11: --import-live-env does not write without --accept (dry-run by default)', () => {
    let writeCount = 0;
    const output = makeCapture();
    const liveEnv = { TMPDIR: '/var/tmp' };
    importLiveEnv({
        appRoot: '/fake', processName: 'nassaj-dev', accept: [],
        spawn: fakeSpawn(liveEnv), output,
        readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
        writeFile: () => { writeCount += 1; },
    });
    assert.equal(writeCount, 0, 'nothing should be written when accept list is empty');
    assert.match(output.toString(), /Nothing written/);
});

test('W11: --import-live-env with empty pm2 jlist returns ok:false gracefully', () => {
    const output = makeCapture();
    const result = importLiveEnv({
        appRoot: '/fake', processName: 'nassaj-dev',
        spawn: (_cmd, _args) => ({ status: 0, stdout: '[]', stderr: '' }),
        output,
        readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
        writeFile: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'live_env_unreadable');
});

test('W11: LIVE_ENV_IMPORT_ALLOWLIST exports only TMPDIR (allowlist not expanded silently)', () => {
    assert.deepEqual([...LIVE_ENV_IMPORT_ALLOWLIST], ['TMPDIR'],
        'allowlist must contain only TMPDIR per ADR-156 §3.4 step 1');
});

// ---------------------------------------------------------------------------
// Wt: static guard — no force-restart / confirmKillSessions in update files
// ---------------------------------------------------------------------------

test('static guard: source-updater.js contains no force-restart or kill-sessions primitives', () => {
    const src = readFileSync(path.join(ROOT, 'server', 'services', 'source-updater.js'), 'utf8');
    assert.doesNotMatch(src, /force.restart/i, 'source-updater must not reference force-restart');
    assert.doesNotMatch(src, /confirmKillSessions/i, 'source-updater must not reference confirmKillSessions');
    assert.doesNotMatch(src, /NASSAJ_RESTART_KILL_SESSIONS/i, 'source-updater must not reference NASSAJ_RESTART_KILL_SESSIONS');
});

test('static guard: source-update-worker.js contains no force-restart or kill-sessions primitives', () => {
    const src = readFileSync(path.join(ROOT, 'server', 'services', 'source-update-worker.js'), 'utf8');
    assert.doesNotMatch(src, /force.restart/i, 'source-update-worker must not reference force-restart');
    assert.doesNotMatch(src, /confirmKillSessions/i, 'source-update-worker must not reference confirmKillSessions');
    assert.doesNotMatch(src, /NASSAJ_RESTART_KILL_SESSIONS/i, 'source-update-worker must not reference NASSAJ_RESTART_KILL_SESSIONS');
});

test('static guard: update-deferral-scheduler.js contains no force-restart or kill-sessions primitives', () => {
    const src = readFileSync(path.join(ROOT, 'server', 'services', 'update-deferral-scheduler.js'), 'utf8');
    assert.doesNotMatch(src, /force.restart/i, 'scheduler must not reference force-restart');
    assert.doesNotMatch(src, /confirmKillSessions/i, 'scheduler must not reference confirmKillSessions');
    assert.doesNotMatch(src, /NASSAJ_RESTART_KILL_SESSIONS/i, 'scheduler must not reference NASSAJ_RESTART_KILL_SESSIONS');
});
