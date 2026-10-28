/**
 * install.agy.test — ADR-215 stage A: owner install of antigravity (agy)
 * through the audited-script path, the global install slot, the HOME
 * free-space precheck and the owned-path cleanup (ش4/ش5). Network and the
 * vendor script are faked; the timeout case runs a real `/bin/sh` group under
 * the real bounded runner, never a vendor script.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { HarnessBinaryUnresolvedError } from '@/shared/harness-binaries.js';

import { HARNESS_INSTALL_SOURCES, type ScriptInstallSource } from './install-sources.js';
import { _resetInstallSlot, _setInstallTestDeps, startHarnessInstall, type InstallDeps } from './install.service.js';
import { _resetHarnessLeases, isHarnessLeased } from './lease.js';
import { runHarnessUpdateCommand } from './run-command.js';
import { _resetHarnessJobs, getHarnessUpdateJob, type RunResult } from './update-jobs.js';

const AGY_URL = 'https://antigravity.google/cli/install.sh';
const SCRIPT = '#!/bin/bash\necho agy installer\n';
const SCRIPT_SHA = createHash('sha256').update(SCRIPT).digest('hex');
const AGY_SOURCE = HARNESS_INSTALL_SOURCES.antigravity as ScriptInstallSource;
const BIN = path.join(SANDBOX_HOME, '.local', 'bin', 'agy');
const STAGING = path.join(SANDBOX_HOME, '.cache', 'antigravity', 'staging');
const OK: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false };

let staging = '';
let audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];

function respond(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(status === 302 ? null : body, { status, headers });
}

/** antigravity.google 200 serving `script` (no redirect). */
function agyFetch(script = SCRIPT): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url) === AGY_URL) return respond(200, script, { 'content-length': String(Buffer.byteLength(script)) });
    throw new Error(`unexpected fetch ${String(url)}`);
  }) as typeof fetch;
}

function writeFile(file: string, body = 'x', mode = 0o755): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
}

/** A fake vendor step: places the binary and leaves staging files behind. */
const placeAgy = (extra: () => void = () => {}) => async (): Promise<RunResult> => {
  writeFile(BIN, '#!/bin/sh\necho 1.4.3\n');
  writeFile(path.join(STAGING, 'agy.tar.gz'), 'tgz', 0o644);
  extra();
  return OK;
};

function setDeps(over: Partial<InstallDeps>, realVerify = false): void {
  fs.rmSync(staging, { recursive: true, force: true });
  staging = fs.mkdtempSync(path.join('/var/tmp', 'install-agy-test-staging-'));
  audits = [];
  const deps: Partial<InstallDeps> = {
    home: () => SANDBOX_HOME,
    isPlatform: () => false,
    serverEnv: () => ({}),
    stagingParent: staging,
    resolveBinary: (id) => { throw new HarnessBinaryUnresolvedError(id, 'not-installed', 'missing'); },
    audit: (action, metadata) => { audits.push({ action, metadata }); },
    cleanEnv: () => ({}),
    fetchImpl: agyFetch(),
    freeBytes: () => 10 * 1024 ** 3,
    verifyInstalled: async () => '1.4.3',
    ...over,
  };
  if (realVerify) delete deps.verifyInstalled;
  _setInstallTestDeps(deps);
}

async function runAgy(): Promise<NonNullable<ReturnType<typeof getHarnessUpdateJob>>> {
  const job = startHarnessInstall('antigravity', { userId: 1 });
  await job.done;
  const done = getHarnessUpdateJob(job.jobId);
  assert.ok(done);
  return done;
}

afterEach(() => {
  _setInstallTestDeps(null);
  _resetInstallSlot();
  _resetHarnessLeases();
  _resetHarnessJobs();
  fs.rmSync(staging, { recursive: true, force: true });
  for (const dir of ['.local', '.cache', '.gemini']) fs.rmSync(path.join(SANDBOX_HOME, dir), { recursive: true, force: true });
  for (const file of ['.bashrc', '.profile']) fs.rmSync(path.join(SANDBOX_HOME, file), { force: true });
});

test('descriptor: agy is a no-redirect bash script with a 10 min process timeout and 1 GiB precheck', () => {
  assert.equal(AGY_SOURCE.kind, 'script');
  assert.equal(AGY_SOURCE.url, AGY_URL);
  assert.deepEqual([...AGY_SOURCE.allowedHosts], ['antigravity.google']);
  assert.equal(AGY_SOURCE.maxRedirects, 0);
  assert.equal(AGY_SOURCE.interpreter, '/bin/bash');
  assert.equal(AGY_SOURCE.timeoutMs, 10 * 60 * 1000);
  assert.ok(AGY_SOURCE.minFreeBytes >= 2 * 222_322_944, 'ش4: at least 2× the measured payload');
  assert.ok(AGY_SOURCE.knownSha256.every((d) => /^[0-9a-f]{64}$/u.test(d)));
  const owned = AGY_SOURCE.ownedPaths('/h').map((o) => `${o.path}:${o.staging}`);
  assert.deepEqual(owned, ['/h/.local/bin/agy:false', '/h/.cache/antigravity/staging/agy:true',
    '/h/.cache/antigravity/staging/agy.tar.gz:true', '/h/.cache/antigravity/staging/antigravity:true']);
});

test('agy: success keeps the binary, removes staging leftovers, logs the full unreviewed sha256', async () => {
  let seen: { cmd: string; env: NodeJS.ProcessEnv; timeoutMs: number } | null = null;
  setDeps({
    cleanEnv: () => ({ GEMINI_API_KEY: 'g', SHELL: '/bin/bash', LANG: 'C.UTF-8' }),
    runCommand: async (cmd, _args, opts) => {
      seen = { cmd, env: opts.env, timeoutMs: opts.timeoutMs };
      return placeAgy()();
    },
  });
  const done = await runAgy();
  assert.equal(done.status, 'succeeded');
  assert.equal(done.kind, 'install');
  assert.equal(done.toVersion, '1.4.3');
  const s = seen as unknown as { cmd: string; env: NodeJS.ProcessEnv; timeoutMs: number };
  assert.equal(s.cmd, '/bin/bash');
  assert.equal(s.timeoutMs, 10 * 60 * 1000);
  assert.equal('GEMINI_API_KEY' in s.env, false);
  assert.equal(s.env.SHELL, '/bin/bash');
  assert.ok(fs.existsSync(BIN), 'the installed binary stays');
  assert.equal(fs.existsSync(path.join(STAGING, 'agy.tar.gz')), false, 'staging leftover removed');
  assert.ok(fs.existsSync(STAGING), 'staging dir itself is never removed');
  assert.ok(done.log.includes(`Installer downloaded: sha256 ${SCRIPT_SHA}`), 'full digest in the log');
  assert.ok(done.log.some((l) => l.startsWith('Warning: unreviewed script')));
  const ok = audits.at(-1);
  assert.equal(ok?.action, 'harness_install_succeeded');
  assert.equal(ok?.metadata.sha256, SCRIPT_SHA);
  assert.equal(ok?.metadata.reviewed, false);
  assert.deepEqual(ok?.metadata.removedPaths, ['~/.cache/antigravity/staging/agy.tar.gz']);
  assert.equal(isHarnessLeased('antigravity'), false);
  assert.deepEqual(fs.readdirSync(staging), []);
});

test('agy: a reviewed digest logs no warning and audits reviewed=true', async () => {
  setDeps({
    runCommand: placeAgy(),
    sources: { ...HARNESS_INSTALL_SOURCES, antigravity: { ...AGY_SOURCE, knownSha256: [SCRIPT_SHA] } },
  });
  const done = await runAgy();
  assert.equal(done.status, 'succeeded');
  assert.equal(done.log.some((l) => l.startsWith('Warning: unreviewed')), false);
  assert.equal(audits.at(-1)?.metadata.reviewed, true);
});

test('agy: any redirect is refused (maxRedirects 0) and nothing runs', async () => {
  let ran = false;
  setDeps({
    fetchImpl: (async () => respond(302, '', { location: 'https://antigravity.google/other.sh' })) as typeof fetch,
    runCommand: async () => { ran = true; return OK; },
  });
  const done = await runAgy();
  assert.equal(done.error?.code, 'script_rejected');
  assert.equal(ran, false);
});

test('agy: a script over 64 KB or an empty body is script_rejected', async () => {
  for (const body of ['x'.repeat(64 * 1024 + 1), '']) {
    setDeps({ fetchImpl: agyFetch(body) });
    const done = await runAgy();
    assert.equal(done.error?.code, 'script_rejected');
  }
});

test('M-1: exit 0 with an unusable binary is verify_failed and the appeared files are removed', async () => {
  setDeps({ runCommand: placeAgy(), verifyInstalled: async () => { throw new Error('no version'); } });
  const done = await runAgy();
  assert.equal(done.error?.code, 'verify_failed');
  assert.equal(fs.existsSync(BIN), false, 'partial binary removed');
  assert.equal(fs.existsSync(path.join(STAGING, 'agy.tar.gz')), false);
  const failed = audits.at(-1);
  assert.equal(failed?.action, 'harness_install_failed');
  assert.deepEqual(failed?.metadata.removedPaths,
    ['~/.local/bin/agy', '~/.cache/antigravity/staging/agy.tar.gz']);
  // Retry now finds a clean slate (no HARNESS_INSTALL_INVALID) and succeeds.
  setDeps({ runCommand: placeAgy() });
  assert.equal((await runAgy()).status, 'succeeded');
});

test('ش5: pre-existing files, ~/.gemini and shell profiles are never touched by cleanup', async () => {
  const oldStaging = path.join(STAGING, 'antigravity');
  writeFile(oldStaging, 'old', 0o644);
  writeFile(path.join(SANDBOX_HOME, '.bashrc'), '# mine\n', 0o644);
  setDeps({
    runCommand: placeAgy(() => {
      writeFile(path.join(SANDBOX_HOME, '.gemini', 'oauth_creds.json'), '{}', 0o600);
      fs.appendFileSync(path.join(SANDBOX_HOME, '.bashrc'), 'export PATH=x\n');
    }),
    verifyInstalled: async () => { throw new Error('bad'); },
  });
  const done = await runAgy();
  assert.equal(done.error?.code, 'verify_failed');
  assert.equal(fs.readFileSync(oldStaging, 'utf8'), 'old', 'existed before the job: kept');
  assert.ok(fs.existsSync(path.join(SANDBOX_HOME, '.gemini', 'oauth_creds.json')));
  assert.equal(fs.readFileSync(path.join(SANDBOX_HOME, '.bashrc'), 'utf8'), '# mine\nexport PATH=x\n');
});

test('ش5: a symlink the vendor step left at ~/.local/bin/agy is left in place, its target intact', async () => {
  const target = path.join(SANDBOX_HOME, '.cache', 'real-agy');
  setDeps({
    runCommand: async () => {
      writeFile(target, 'real');
      fs.mkdirSync(path.dirname(BIN), { recursive: true });
      fs.symlinkSync(target, BIN);
      return OK;
    },
    verifyInstalled: async () => { throw new Error('bad'); },
  });
  const done = await runAgy();
  assert.equal(done.error?.code, 'verify_failed');
  assert.ok(fs.lstatSync(BIN).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'real');
  assert.ok(done.log.includes('Left in place ~/.local/bin/agy (symlink)'));
});

test('ش4: a SIGKILL on timeout still removes the staging payload (real runner)', async () => {
  const payload = path.join(STAGING, 'agy.tar.gz');
  const extracted = path.join(STAGING, 'antigravity');
  // F1: the extracted binary carries the archive's (past) mtime, as tar keeps it.
  const script = `#!/bin/sh\nmkdir -p ${STAGING}\necho tgz > ${payload}\necho bin > ${extracted}\n`
    + `touch -d '2026-10-20 02:52:00 UTC' ${extracted}\necho started\nsleep 30\n`;
  setDeps({
    fetchImpl: agyFetch(script),
    runCommand: runHarnessUpdateCommand,
    sources: { ...HARNESS_INSTALL_SOURCES, antigravity: { ...AGY_SOURCE, interpreter: '/bin/sh', timeoutMs: 400 } },
  });
  const done = await runAgy();
  assert.equal(done.error?.code, 'install_timeout');
  assert.ok(done.log.includes('started'));
  assert.equal(fs.existsSync(payload), false, 'vendor trap never ran (SIGKILL); Nassaj removed the payload');
  assert.equal(fs.existsSync(extracted), false, 'archive-mtime binary removed (ctime bound)');
  assert.deepEqual(audits.at(-1)?.metadata.removedPaths,
    ['~/.cache/antigravity/staging/agy.tar.gz', '~/.cache/antigravity/staging/antigravity']);
  assert.deepEqual(fs.readdirSync(staging), []);
});

test('F2: a timeout whose process group is not quiesced skips cleanup and keeps lease and slot', async () => {
  setDeps({
    runCommand: async () => {
      writeFile(path.join(STAGING, 'agy.tar.gz'), 'tgz', 0o644);
      return { code: null, stdout: '', stderr: '', timedOut: true, quiesced: false };
    },
  });
  const done = await runAgy();
  assert.equal(done.error?.code, 'install_timeout');
  const failed = audits.at(-1);
  assert.equal(failed?.action, 'harness_install_failed');
  assert.equal(failed?.metadata.cause, 'not_quiesced');
  assert.deepEqual(failed?.metadata.removedPaths, []);
  assert.ok(fs.existsSync(path.join(STAGING, 'agy.tar.gz')), 'no cleanup under a possibly live writer');
  assert.ok(done.log.some((l) => l.startsWith('The installer could not be stopped')));
  assert.equal(isHarnessLeased('antigravity'), true, 'lease retained');
  assert.equal(fs.readdirSync(staging).length, 1, 'script dir kept for boot reconcile');
  setDeps({});
  assert.throws(() => startHarnessInstall('codex', { userId: 1 }), { code: 'HARNESS_INSTALL_SLOT_BUSY' });
});

test('ش4: free space below the minimum, or unreadable, fails insufficient_space before any download', async () => {
  for (const freeBytes of [() => 1024, () => { throw new Error('statfs'); }]) {
    let fetched = false;
    setDeps({ freeBytes, fetchImpl: (async () => { fetched = true; return respond(500); }) as typeof fetch });
    const done = await runAgy();
    assert.equal(done.error?.code, 'insufficient_space');
    assert.ok(done.error?.messageAr);
    assert.equal(fetched, false);
    assert.equal(isHarnessLeased('antigravity'), false);
  }
});

test('§3.6: one install at a time across harnesses; the slot frees when the job settles', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setDeps({ runCommand: async () => { await gate; return placeAgy()(); } });
  const first = startHarnessInstall('antigravity', { userId: 1 });
  assert.throws(() => startHarnessInstall('codex', { userId: 1 }),
    (e: { code?: string; statusCode?: number; details?: { activeJobId?: string } }) =>
      e.code === 'HARNESS_INSTALL_SLOT_BUSY' && e.statusCode === 409 && e.details?.activeJobId === first.jobId);
  release();
  await first.done;
  assert.equal(getHarnessUpdateJob(first.jobId)?.status, 'succeeded');
  setDeps({ resolveBinary: () => '/x' });
  assert.throws(() => startHarnessInstall('codex', { userId: 1 }), { code: 'HARNESS_ALREADY_INSTALLED' },
    'slot free: the next refusal is the ordinary one');
});

test('C3: agy already installed, an override set, or a file at ~/.local/bin/agy is refused', () => {
  setDeps({ resolveBinary: () => BIN });
  assert.throws(() => startHarnessInstall('antigravity', { userId: 1 }), { code: 'HARNESS_ALREADY_INSTALLED' });
  setDeps({ serverEnv: () => ({ AGY_PATH: '/opt/agy' }) });
  assert.throws(() => startHarnessInstall('antigravity', { userId: 1 }), { code: 'HARNESS_OVERRIDE_SET' });
  setDeps({});
  writeFile(BIN, 'x', 0o644);
  assert.throws(() => startHarnessInstall('agy', { userId: 1 }), { code: 'HARNESS_NOT_INSTALLABLE' },
    'the alias is not an install id');
  assert.throws(() => startHarnessInstall('antigravity', { userId: 1 }), { code: 'HARNESS_INSTALL_INVALID' });
});

test('C4: the real launch resolver plus --version proves agy; an unreadable version fails', async () => {
  const saved = process.env.AGY_PATH;
  delete process.env.AGY_PATH;
  try {
    let versionArgs: string[] = [];
    setDeps({
      runCommand: placeAgy(),
      runVersion: async (_bin, args) => { versionArgs = args; return 'agy 1.4.3'; },
    }, true);
    const done = await runAgy();
    assert.equal(done.status, 'succeeded');
    assert.equal(done.toVersion, '1.4.3');
    assert.deepEqual(versionArgs, ['--version']);
    fs.rmSync(BIN);
    setDeps({ runCommand: placeAgy(), runVersion: async () => null }, true);
    const bad = await runAgy();
    assert.equal(bad.error?.code, 'verify_failed');
    assert.equal(fs.existsSync(BIN), false);
  } finally {
    if (saved !== undefined) process.env.AGY_PATH = saved;
  }
});
