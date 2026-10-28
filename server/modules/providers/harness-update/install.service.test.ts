/**
 * install.service.test — owner CLI install flow (T-2062, qa C1/C3/C4/C5/C7/C8/C9).
 * Network and child processes are injected; the timeout case runs a real
 * `/bin/sh` group under the real bounded runner, never a vendor script.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { HarnessBinaryUnresolvedError } from '@/shared/harness-binaries.js';

import { HARNESS_INSTALL_INFO } from '../../../../shared/harness-install.contract.js';

import { HARNESS_INSTALL_SOURCES, type ScriptInstallSource } from './install-sources.js';
import {
  _setInstallTestDeps,
  buildInstallEnv,
  INSTALL_PATH_ENV,
  _resetInstallSlot,
  removeOrphanInstallDirs,
  startHarnessInstall,
  type InstallDeps,
} from './install.service.js';
import { _resetHarnessLeases, acquireHarnessLease, isHarnessLeased } from './lease.js';
import { installCompatAsset, OPENCODE_COMPAT_ASSET } from './opencode-asset.js';
import { runHarnessUpdateCommand, sanitizeOutputLine } from './run-command.js';
import { _resetHarnessJobs, getHarnessUpdateJob, type RunResult } from './update-jobs.js';

const SCRIPT = '#!/bin/sh\necho installing\n';
const notInstalled = (id: string) => () => {
  throw new HarnessBinaryUnresolvedError(id, 'not-installed', 'missing');
};

let staging = '';
let audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];

/** A response with a body and headers (no network). */
function respond(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(status === 302 ? null : body, { status, headers });
}

/** Fetch fake: chatgpt.com 302 → releases.openai.com 200 serving `script`. */
function scriptFetch(script: string, redirectTo = 'https://releases.openai.com/codex/install.sh'): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u === 'https://chatgpt.com/codex/install.sh') return respond(302, '', { location: redirectTo });
    if (u === redirectTo) return respond(200, script, { 'content-length': String(Buffer.byteLength(script)) });
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

function setDeps(over: Partial<InstallDeps>, realVerify = false): void {
  fs.rmSync(staging, { recursive: true, force: true });
  staging = fs.mkdtempSync(path.join('/var/tmp', 'install-test-staging-'));
  audits = [];
  const deps: Partial<InstallDeps> = {
    home: () => SANDBOX_HOME,
    isPlatform: () => false,
    serverEnv: () => ({}),
    stagingParent: staging,
    resolveBinary: (id) => notInstalled(id)(),
    audit: (action, metadata) => { audits.push({ action, metadata }); },
    cleanEnv: () => ({ KEEP: '1' }),
    fetchImpl: scriptFetch(SCRIPT),
    verifyInstalled: async () => '9.9.9',
    ...over,
  };
  if (realVerify) delete deps.verifyInstalled;
  _setInstallTestDeps(deps);
}

afterEach(() => {
  _setInstallTestDeps(null);
  _resetInstallSlot();
  _resetHarnessLeases();
  _resetHarnessJobs();
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX_HOME, '.opencode'), { recursive: true, force: true });
  fs.rmSync(path.join(SANDBOX_HOME, '.local'), { recursive: true, force: true });
});

test('display-command parity: every script source URL is the command the UI shows', () => {
  assert.deepEqual(Object.keys(HARNESS_INSTALL_SOURCES).sort(), Object.keys(HARNESS_INSTALL_INFO).sort());
  for (const [id, source] of Object.entries(HARNESS_INSTALL_SOURCES)) {
    if (source.kind !== 'script') continue;
    const shown = HARNESS_INSTALL_INFO[id as keyof typeof HARNESS_INSTALL_INFO].command;
    assert.ok(shown.includes(` ${source.url} `), `${id} display command must fetch ${source.url}`);
    assert.ok(source.allowedHosts.includes(new URL(source.url).hostname));
  }
  assert.ok(Object.isFrozen(HARNESS_INSTALL_SOURCES) && Object.isFrozen(HARNESS_INSTALL_INFO));
});

test('C5/ADR-215 §3.5: allow-list env drops vendor keys and pins HOME, TMPDIR and PATH', () => {
  const env = buildInstallEnv({
    CODEX_HOME: '/x', CODEX_INSTALL_DIR: '/y', XDG_DATA_HOME: '/z', OPENCODE_CONFIG: '/w',
    HOME: '/other', PATH: '/evil', TMPDIR: '/tmp', LANG: 'C.UTF-8', KEEP: '1', LC_ALL: '',
  }, '/home/op');
  assert.deepEqual(env, { HOME: '/home/op', PATH: INSTALL_PATH_ENV, TMPDIR: '/var/tmp', LANG: 'C.UTF-8' });
});

test('ش8 iron rule: the built installer env carries no provider, config or runtime-injection key', () => {
  const base: NodeJS.ProcessEnv = {
    ANTHROPIC_BASE_URL: 'https://proxy.example', ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/home/example/.claude',
    GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'g', AGY_PATH: '/x', NODE_OPTIONS: '--require /evil.js',
    npm_config_prefix: '/evil', LD_PRELOAD: '/evil.so', BASH_ENV: '/evil.sh', ENV: '/evil.sh',
    USER: 'nassaj', LOGNAME: 'nassaj', LC_ALL: 'C.UTF-8',
    HTTPS_PROXY: 'http://p:1', https_proxy: 'http://p:1', NO_PROXY: 'localhost', SHELL: '/bin/bash',
    ALL_PROXY: 'socks5://p:2', SSL_CERT_FILE: '/etc/ssl/ca.pem', CURL_CA_BUNDLE: '/etc/ssl/ca.pem',
  };
  const env = buildInstallEnv(base, '/home/op');
  for (const key of ['ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'GEMINI_API_KEY', 'NODE_OPTIONS',
    'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'AGY_PATH', 'npm_config_prefix', 'LD_PRELOAD', 'BASH_ENV', 'ENV']) {
    assert.equal(key in env, false, `${key} must not reach an installer`);
  }
  assert.deepEqual(Object.keys(env).sort(), ['ALL_PROXY', 'CURL_CA_BUNDLE', 'HOME', 'HTTPS_PROXY', 'LC_ALL',
    'LOGNAME', 'NO_PROXY', 'PATH', 'SHELL', 'SSL_CERT_FILE', 'TMPDIR', 'USER', 'https_proxy'].sort());
});

test('ش7: SHELL passes only as a plain absolute path', () => {
  for (const bad of ['bash', '/bin/bash -c x', '/bin/$(id)', '/bin/ba;sh', '']) {
    assert.equal('SHELL' in buildInstallEnv({ SHELL: bad }, '/h'), false, bad);
  }
  assert.equal(buildInstallEnv({ SHELL: '/usr/bin/zsh' }, '/h').SHELL, '/usr/bin/zsh');
});

test('ش7 codex parity: a real script run sees SHELL (profile choice) and no CODEX_*/XDG_* key', async () => {
  const outFile = path.join('/var/tmp', `install-test-env-${process.pid}`);
  const script = `#!/bin/sh\nprintf '%s|%s|%s|%s' "$SHELL" "\${CODEX_HOME:-}" "\${XDG_CONFIG_HOME:-}" "$HOME" > ${outFile}\n`;
  setDeps({
    fetchImpl: scriptFetch(script),
    runCommand: runHarnessUpdateCommand,
    cleanEnv: () => ({ SHELL: '/bin/bash', CODEX_HOME: '/x', XDG_CONFIG_HOME: '/y' }),
  });
  try {
    const job = startHarnessInstall('codex', { userId: 1 });
    await job.done;
    assert.equal(getHarnessUpdateJob(job.jobId)?.status, 'succeeded');
    assert.equal(fs.readFileSync(outFile, 'utf8'), `/bin/bash|||${SANDBOX_HOME}`);
  } finally {
    fs.rmSync(outFile, { force: true });
  }
});

test('codex: script downloaded privately, run as sh <file>, verified, dir removed', async () => {
  let seen: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; fileMode: number; dirMode: number } | null = null;
  setDeps({
    cleanEnv: () => ({ KEEP: '1', CODEX_HOME: '/x', XDG_CONFIG_HOME: '/y' }),
    runCommand: async (cmd, args, opts) => {
      seen = {
        cmd, args, env: opts.env,
        fileMode: fs.statSync(args[0]).mode & 0o777,
        dirMode: fs.statSync(path.dirname(args[0])).mode & 0o777,
      };
      assert.equal(fs.readFileSync(args[0], 'utf8'), SCRIPT);
      opts.onLine?.('step one');
      return { code: 0, stdout: '', stderr: '', timedOut: false } satisfies RunResult;
    },
  });
  const job = startHarnessInstall('codex', { userId: 1 });
  assert.equal(job.status, 'running');
  await job.done;
  const done = getHarnessUpdateJob(job.jobId);
  assert.equal(done?.status, 'succeeded');
  assert.equal(done?.kind, 'install');
  assert.equal(done?.toVersion, '9.9.9');
  assert.ok(done?.log.includes('step one'));
  assert.ok(seen);
  const s = seen as NonNullable<typeof seen>;
  assert.equal(s.cmd, '/bin/sh');
  assert.equal(s.fileMode, 0o600);
  assert.equal(s.dirMode, 0o700);
  assert.deepEqual(s.env, { HOME: SANDBOX_HOME, TMPDIR: '/var/tmp', PATH: INSTALL_PATH_ENV }, 'allow-list env (ADR-215)');
  assert.deepEqual(fs.readdirSync(staging), [], 'staging dir removed');
  assert.deepEqual(audits.map((a) => a.action), ['harness_install_started', 'harness_install_succeeded']);
  assert.match(String(audits[1].metadata.sha256), /^[0-9a-f]{64}$/u);
  assert.equal(isHarnessLeased('codex'), false);
});

test('codex: a redirect off the allowlist is script_rejected and nothing runs', async () => {
  let ran = false;
  setDeps({
    fetchImpl: scriptFetch(SCRIPT, 'https://evil.example/install.sh'),
    runCommand: async () => { ran = true; return { code: 0, stdout: '', stderr: '', timedOut: false }; },
  });
  const job = startHarnessInstall('codex', { userId: 1 });
  await job.done;
  const done = getHarnessUpdateJob(job.jobId);
  assert.equal(done?.status, 'failed');
  assert.equal(done?.error?.code, 'script_rejected');
  assert.equal(ran, false);
  assert.deepEqual(fs.readdirSync(staging), []);
  assert.equal(audits.at(-1)?.action, 'harness_install_failed');
});

test('codex: an oversized script is script_rejected', async () => {
  setDeps({ fetchImpl: scriptFetch('x'.repeat(256 * 1024 + 1)) });
  const job = startHarnessInstall('codex', { userId: 1 });
  await job.done;
  assert.equal(getHarnessUpdateJob(job.jobId)?.error?.code, 'script_rejected');
});

test('C4: codex with a bad layout after the script fails verify_failed (real launch resolver)', async () => {
  const saved = process.env.CODEX_PATH;
  delete process.env.CODEX_PATH;
  setDeps({
    runCommand: async () => {
      const bin = path.join(SANDBOX_HOME, '.local', 'bin', 'codex');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '#!/bin/sh\necho fake\n', { mode: 0o755 });
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    },
  }, true);
  try {
    const job = startHarnessInstall('codex', { userId: 1 });
    await job.done;
    const done = getHarnessUpdateJob(job.jobId);
    assert.equal(done?.status, 'failed');
    assert.equal(done?.error?.code, 'verify_failed');
  } finally {
    if (saved !== undefined) process.env.CODEX_PATH = saved;
  }
});

test('codex: the timeout SIGKILLs the whole process group (real runner)', async () => {
  const pidFile = path.join('/var/tmp', `install-test-pid-${process.pid}`);
  const script = `#!/bin/sh\necho started\nsleep 30 &\necho $! > ${pidFile}\nwait\n`;
  const source: ScriptInstallSource = { ...(HARNESS_INSTALL_SOURCES.codex as ScriptInstallSource), timeoutMs: 400 };
  setDeps({
    fetchImpl: scriptFetch(script),
    runCommand: runHarnessUpdateCommand,
    cleanEnv: () => ({}),
    sources: { ...HARNESS_INSTALL_SOURCES, codex: source },
  });
  try {
    const job = startHarnessInstall('codex', { userId: 1 });
    await job.done;
    const done = getHarnessUpdateJob(job.jobId);
    assert.equal(done?.error?.code, 'install_timeout');
    assert.ok(done?.log.includes('started'), 'output streamed live into the log');
    const child = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(child, 0), 'background child of the script is dead');
    assert.deepEqual(fs.readdirSync(staging), []);
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});

test('C1: opencode installs the pinned asset at ~/.opencode/bin/opencode (0755 dirs)', async () => {
  let dest = '';
  setDeps({
    installCompatAsset: async (opts) => {
      dest = opts.destPath;
      fs.writeFileSync(opts.destPath, 'bin', { mode: 0o755 });
    },
  });
  const job = startHarnessInstall('opencode', { userId: 1 });
  await job.done;
  assert.equal(getHarnessUpdateJob(job.jobId)?.status, 'succeeded');
  assert.equal(dest, path.join(SANDBOX_HOME, '.opencode', 'bin', 'opencode'));
  assert.equal(fs.statSync(path.dirname(dest)).mode & 0o777, 0o755);
});

test('C1: opencode digest mismatch fails and leaves the destination untouched', async () => {
  const body = Buffer.from('not the pinned tarball');
  const spec = { ...OPENCODE_COMPAT_ASSET, size: body.length };
  setDeps({
    installCompatAsset,
    compatAsset: spec,
    fetchImpl: (async () => respond(200, body.toString(), { 'content-length': String(body.length) })) as typeof fetch,
  });
  const job = startHarnessInstall('opencode', { userId: 1 });
  await job.done;
  const done = getHarnessUpdateJob(job.jobId);
  assert.equal(done?.error?.code, 'install_failed');
  assert.equal(audits.at(-1)?.metadata.cause, 'ASSET_DIGEST_MISMATCH');
  assert.equal(fs.existsSync(path.join(SANDBOX_HOME, '.opencode', 'bin', 'opencode')), false);
  assert.deepEqual(fs.readdirSync(staging), [], 'asset staging removed');
});

test('C1: a symlinked ~/.opencode is refused before any download', async () => {
  let fetched = false;
  fs.symlinkSync('/var/tmp', path.join(SANDBOX_HOME, '.opencode'));
  setDeps({ fetchImpl: (async () => { fetched = true; return respond(500); }) as typeof fetch });
  const job = startHarnessInstall('opencode', { userId: 1 });
  await job.done;
  assert.equal(getHarnessUpdateJob(job.jobId)?.error?.code, 'install_failed');
  assert.equal(fetched, false);
});

test('C3/C8: refusals happen before any job, download or lease', () => {
  setDeps({ resolveBinary: () => '/x/codex' });
  assert.throws(() => startHarnessInstall('codex', { userId: 1 }), { code: 'HARNESS_ALREADY_INSTALLED' });
  setDeps({ resolveBinary: () => { throw new HarnessBinaryUnresolvedError('codex', 'invalid-install', 'bad'); } });
  assert.throws(() => startHarnessInstall('codex', { userId: 1 }), { code: 'HARNESS_INSTALL_INVALID' });
  setDeps({ serverEnv: () => ({ OPENCODE_PATH: '/opt/opencode' }) });
  assert.throws(() => startHarnessInstall('opencode', { userId: 1 }), { code: 'HARNESS_OVERRIDE_SET' });
  setDeps({ isPlatform: () => true });
  assert.throws(() => startHarnessInstall('codex', { userId: 1 }), { code: 'PLATFORM_MODE_UNSUPPORTED', statusCode: 403 });
  setDeps({});
  assert.throws(() => startHarnessInstall('cursor', { userId: 1 }), { code: 'HARNESS_NOT_INSTALLABLE' });
  acquireHarnessLease('codex', 'other-job');
  assert.throws(() => startHarnessInstall('codex', { userId: 1 }),
    (e: { code?: string; details?: { activeJobId?: string } }) =>
      e.code === 'HARNESS_UPDATE_IN_PROGRESS' && e.details?.activeJobId === 'other-job');
  assert.equal(fs.readdirSync(staging).length, 0);
});

test('C3: a file already at the measured path (registry says not-installed) is invalid', () => {
  setDeps({});
  fs.mkdirSync(path.join(SANDBOX_HOME, '.opencode', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX_HOME, '.opencode', 'bin', 'opencode'), 'x', { mode: 0o644 });
  assert.throws(() => startHarnessInstall('opencode', { userId: 1 }), { code: 'HARNESS_INSTALL_INVALID' });
});

test('C7: live lines lose ANSI CSI/OSC and carriage-return redraws', () => {
  assert.equal(sanitizeOutputLine('\u001b[1;32mok\u001b[0m'), 'ok');
  assert.equal(sanitizeOutputLine('\u001b]0;title\u0007done'), 'done');
  assert.equal(sanitizeOutputLine('10%\r50%\r100%'), '100%');
  assert.equal(sanitizeOutputLine('x'.repeat(900)).length, 500);
});

test('C8: boot removes only old own install staging dirs', () => {
  const parent = fs.mkdtempSync(path.join('/var/tmp', 'install-orphans-'));
  try {
    for (const name of ['nassaj-harness-install-old', 'nassaj-harness-install-new', 'other-dir']) {
      fs.mkdirSync(path.join(parent, name));
    }
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(path.join(parent, 'nassaj-harness-install-old'), old, old);
    fs.utimesSync(path.join(parent, 'other-dir'), old, old);
    assert.equal(removeOrphanInstallDirs(parent), 1);
    assert.deepEqual(fs.readdirSync(parent).sort(), ['nassaj-harness-install-new', 'other-dir']);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('I-1: a fetch that never resolves times out as script_rejected/download_timeout, lease released', async () => {
  const hang = (() => new Promise<Response>(() => {})) as typeof fetch;
  for (const id of ['codex', 'opencode'] as const) {
    let ran = false;
    setDeps({
      fetchImpl: hang,
      installCompatAsset,
      scriptDownloadTimeoutMs: 50,
      assetDownloadTimeoutMs: 50,
      runCommand: async () => { ran = true; return { code: 0, stdout: '', stderr: '', timedOut: false }; },
    });
    const job = startHarnessInstall(id, { userId: 1 });
    await job.done;
    const done = getHarnessUpdateJob(job.jobId);
    assert.equal(done?.status, 'failed', id);
    assert.equal(done?.error?.code, 'script_rejected', id);
    assert.equal(audits.at(-1)?.metadata.cause, 'download_timeout', id);
    assert.equal(ran, false);
    assert.equal(isHarnessLeased(id), false, `${id} lease released`);
    assert.deepEqual(fs.readdirSync(staging), [], `${id} staging removed`);
  }
});

test('I-2: a nonzero installer exit still audits the downloaded script sha256', async () => {
  setDeps({ runCommand: async () => ({ code: 3, stdout: '', stderr: 'boom', timedOut: false }) });
  const job = startHarnessInstall('codex', { userId: 1 });
  await job.done;
  assert.equal(getHarnessUpdateJob(job.jobId)?.error?.code, 'install_failed');
  const failed = audits.at(-1);
  assert.equal(failed?.action, 'harness_install_failed');
  assert.equal(failed?.metadata.cause, 'nonzero_exit');
  assert.equal(failed?.metadata.exitCode, 3);
  assert.match(String(failed?.metadata.sha256), /^[0-9a-f]{64}$/u);
});
