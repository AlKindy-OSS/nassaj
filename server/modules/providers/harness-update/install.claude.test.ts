/**
 * install.claude.test — ADR-215 stage B: owner install of Claude Code from the
 * vendor's signed release (ش1–ش3, owner decision 2, npm-removal warning).
 *
 * The real `gpgv` verifies the REAL 2.1.304 manifest and signature captured on
 * 2026-10-20 (`__fixtures__/claude-2.1.304`) against the vendored keyring.
 * The job flow runs against a fake release (small fake binary, fake gpgv
 * verdict, fake `claude install`) inside the test HOME sandbox: no vendor
 * binary is downloaded or executed and the server HOME is never touched.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { HarnessBinaryUnresolvedError } from '@/shared/harness-binaries.js';

import { CLAUDE_SIGNING_FINGERPRINT, CLAUDE_SIGNING_KEYRING_BASE64 } from './claude-signing-key.js';
import { AckTokenService } from './confirmation.js';
import { HARNESS_INSTALL_SOURCES } from './install-sources.js';
import { _resetInstallSlot, _setInstallTestDeps, startHarnessInstall, type InstallDeps } from './install.service.js';
import { _resetHarnessLeases, acquireHarnessLease, isHarnessLeased, releaseHarnessLease } from './lease.js';
import { runHarnessUpdateCommand } from './run-command.js';
import {
  detectClaudePlatform,
  findGpgv,
  gpgvStatusValid,
  parseVerifiedManifest,
  verifyManifestSignature,
  versionAtLeast,
  type SignedManifestSource,
} from './signed-manifest.js';
import { _resetHarnessJobs, getHarnessUpdateJob, type RunResult } from './update-jobs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '__fixtures__', 'claude-2.1.304');
const SOURCE = HARNESS_INSTALL_SOURCES.claude as SignedManifestSource;
const BASE = 'https://downloads.claude.ai/claude-code-releases';
const V = '2.1.304';
const BIN = Buffer.from('#!/bin/sh\necho fake claude\n');
const BIN_SHA = createHash('sha256').update(BIN).digest('hex');
const GPGV = '/usr/bin/gpgv';
const LAUNCHER = path.join(SANDBOX_HOME, '.local', 'bin', 'claude');
const VERSION_FILE = path.join(SANDBOX_HOME, '.local', 'share', 'claude', 'versions', V);
const VALIDSIG = `[GNUPG:] GOODSIG BAA929FF1A7ECACE Anthropic\n[GNUPG:] VALIDSIG ${CLAUDE_SIGNING_FINGERPRINT} `
  + `2026-10-19 1792434757 0 4 0 1 10 00 ${CLAUDE_SIGNING_FINGERPRINT}\n`;
const OK: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false };

let staging = '';
let audits: Array<{ action: string; metadata: Record<string, unknown> }> = [];
let fetched: string[] = [];
let installs: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];

function manifestFor(over: Record<string, unknown> = {}, platform = 'linux-x64'): string {
  return JSON.stringify({ version: V, platforms: { [platform]: { binary: 'claude', checksum: BIN_SHA, size: BIN.length } }, ...over });
}

function respond(status: number, body: Buffer | string = '', headers: Record<string, string> = {}): Response {
  const buf = Buffer.from(body);
  return new Response(status === 302 ? null : buf, { status, headers: { 'content-length': String(buf.length), ...headers } });
}

/** A fake release bucket; `over` replaces single URLs (suffix after BASE). */
function releaseFetch(over: Record<string, () => Response> = {}): typeof fetch {
  const table: Record<string, () => Response> = {
    '/latest': () => respond(200, `${V}\n`),
    [`/${V}/manifest.json`]: () => respond(200, manifestFor()),
    [`/${V}/manifest.json.sig`]: () => respond(200, 'sig'),
    [`/${V}/linux-x64/claude`]: () => respond(200, BIN),
    ...over,
  };
  return (async (url: string | URL) => {
    const u = String(url);
    fetched.push(u);
    const key = u.startsWith(BASE) ? u.slice(BASE.length) : u;
    if (table[key]) return table[key]();
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

/** Fake `claude install <v>`: places the version file and the launcher link. */
function placeClaude(content: Buffer = BIN): () => void {
  return () => {
    fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true });
    fs.writeFileSync(VERSION_FILE, content, { mode: 0o755 });
    fs.mkdirSync(path.dirname(LAUNCHER), { recursive: true });
    fs.symlinkSync(VERSION_FILE, LAUNCHER);
    fs.writeFileSync(path.join(SANDBOX_HOME, '.claude.json'), '{}');
  };
}

function runner(gpgv: RunResult, onInstall: () => void = placeClaude()): InstallDeps['runCommand'] {
  return async (cmd, args, opts) => {
    if (cmd === GPGV) return gpgv;
    installs.push({ cmd, args, env: opts.env });
    onInstall();
    return OK;
  };
}

function setDeps(over: Partial<InstallDeps> = {}, realVerify = false): void {
  fs.rmSync(staging, { recursive: true, force: true });
  staging = fs.mkdtempSync(path.join('/var/tmp', 'install-claude-test-staging-'));
  audits = [];
  fetched = [];
  installs = [];
  const acks = new AckTokenService(randomBytes(32));
  const deps: Partial<InstallDeps> = {
    home: () => SANDBOX_HOME,
    isPlatform: () => false,
    serverEnv: () => ({}),
    stagingParent: staging,
    resolveBinary: (id) => { throw new HarnessBinaryUnresolvedError(id, 'not-installed', 'missing'); },
    audit: (action, metadata) => { audits.push({ action, metadata }); },
    cleanEnv: () => ({}),
    fetchImpl: releaseFetch(),
    freeBytes: () => 10 * 1024 ** 3,
    verifyInstalled: async () => V,
    gpgvPath: () => GPGV,
    claudePlatform: () => 'linux-x64',
    systemClaudePaths: [],
    npmPrefixes: () => [],
    acks: () => acks,
    runCommand: runner({ ...OK, stdout: VALIDSIG }),
    ...over,
  };
  if (realVerify) delete deps.verifyInstalled;
  _setInstallTestDeps(deps);
}

async function runClaude(acks?: unknown): Promise<NonNullable<ReturnType<typeof getHarnessUpdateJob>>> {
  const job = startHarnessInstall('claude', { userId: 1, acks });
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
  for (const dir of ['.local', '.claude', '.npm-global']) fs.rmSync(path.join(SANDBOX_HOME, dir), { recursive: true, force: true });
  for (const file of ['.claude.json', '.npmrc']) fs.rmSync(path.join(SANDBOX_HOME, file), { force: true });
});

// ── pure helpers ─────────────────────────────────────────────────────────────

test('I-3: one platform detector for glibc/musl and x64/arm64', () => {
  assert.equal(detectClaudePlatform({ platform: 'linux', arch: 'x64', musl: false }), 'linux-x64');
  assert.equal(detectClaudePlatform({ platform: 'linux', arch: 'arm64', musl: false }), 'linux-arm64');
  assert.equal(detectClaudePlatform({ platform: 'linux', arch: 'x64', musl: true }), 'linux-x64-musl');
  assert.equal(detectClaudePlatform({ platform: 'linux', arch: 'arm64', musl: true }), 'linux-arm64-musl');
  assert.equal(detectClaudePlatform({ platform: 'darwin', arch: 'arm64', musl: false }), 'darwin-arm64');
  assert.equal(detectClaudePlatform({ platform: 'win32', arch: 'x64', musl: false }), null);
  assert.equal(detectClaudePlatform({ platform: 'linux', arch: 'ia32', musl: false }), null);
});

test('versionAtLeast compares numerically and rejects non x.y.z', () => {
  assert.equal(versionAtLeast('2.1.89', '2.1.89'), true);
  assert.equal(versionAtLeast('2.1.100', '2.1.89'), true);
  assert.equal(versionAtLeast('2.1.88', '2.1.89'), false);
  assert.equal(versionAtLeast('3.0.0', '2.9.9'), true);
  assert.equal(versionAtLeast('2.1', '2.1.89'), false);
});

test('ش3: gpgv status needs VALIDSIG with the full pinned primary fingerprint and no bad line', () => {
  assert.equal(gpgvStatusValid(VALIDSIG, CLAUDE_SIGNING_FINGERPRINT), true);
  const other = 'A'.repeat(40);
  assert.equal(gpgvStatusValid(VALIDSIG.split(CLAUDE_SIGNING_FINGERPRINT).join(other), CLAUDE_SIGNING_FINGERPRINT), false);
  assert.equal(gpgvStatusValid(`${VALIDSIG}[GNUPG:] BADSIG X y\n`, CLAUDE_SIGNING_FINGERPRINT), false);
  assert.equal(gpgvStatusValid(`[GNUPG:] ERRSIG x\n${VALIDSIG}`, CLAUDE_SIGNING_FINGERPRINT), false);
  assert.equal(gpgvStatusValid(`[GNUPG:] VALIDSIG ${CLAUDE_SIGNING_FINGERPRINT}\n`, CLAUDE_SIGNING_FINGERPRINT), false);
  assert.equal(gpgvStatusValid('[GNUPG:] GOODSIG x y\n', CLAUDE_SIGNING_FINGERPRINT), false);
  assert.equal(gpgvStatusValid(VALIDSIG, CLAUDE_SIGNING_FINGERPRINT.slice(-16)), false, 'short ids never match');
});

test('ش1/ش3: the manifest is parsed from verified bytes; version, platform, checksum and size are enforced', () => {
  const ok = parseVerifiedManifest(Buffer.from(manifestFor()), V, 'linux-x64', 1024);
  assert.deepEqual(ok, { version: V, platform: 'linux-x64', checksum: BIN_SHA, size: BIN.length });
  const bad = (bytes: string, version = V, cap = 1024) => assert.throws(
    () => parseVerifiedManifest(Buffer.from(bytes), version, 'linux-x64', cap), { name: 'Error' });
  assert.throws(() => parseVerifiedManifest(Buffer.from('{'), V, 'linux-x64', 1), { cause: 'manifest_invalid' });
  assert.throws(() => parseVerifiedManifest(Buffer.from(manifestFor()), '2.1.303', 'linux-x64', 1024),
    { cause: 'version_mismatch' });
  assert.throws(() => parseVerifiedManifest(Buffer.from(manifestFor({}, 'darwin-x64')), V, 'linux-x64', 1024),
    { cause: 'platform_missing' });
  bad(JSON.stringify({ version: V, platforms: { 'linux-x64': { checksum: 'nothex', size: 1 } } }));
  bad(JSON.stringify({ version: V, platforms: { 'linux-x64': { checksum: BIN_SHA, size: 0 } } }));
  bad(manifestFor(), V, BIN.length - 1);
});

const gpgvPresent = findGpgv() !== null;

test('M-3 (real gpgv): the vendored keyring verifies the real 2.1.304 manifest; one changed byte fails',
  { skip: !gpgvPresent && 'gpgv not installed' }, async () => {
    const manifest = fs.readFileSync(path.join(FIXTURES, 'manifest.json'));
    const sig = fs.readFileSync(path.join(FIXTURES, 'manifest.json.sig'));
    const deps = { gpgvPath: findGpgv, runCommand: runHarnessUpdateCommand };
    const fresh = () => fs.mkdtempSync(path.join('/var/tmp', 'install-claude-gpgv-'));
    const dirs = [fresh(), fresh(), fresh()];
    try {
      await verifyManifestSignature(SOURCE, dirs[0], manifest, sig, deps);
      const parsed = parseVerifiedManifest(manifest, V, 'linux-x64', SOURCE.binaryCapBytes);
      assert.match(parsed.checksum, /^[0-9a-f]{64}$/u);
      const tampered = Buffer.from(manifest);
      tampered[tampered.indexOf('"size"') + 9] ^= 1;
      await assert.rejects(verifyManifestSignature(SOURCE, dirs[1], tampered, sig, deps), { cause: 'bad_signature' });
      await assert.rejects(verifyManifestSignature({ ...SOURCE, keyFingerprint: 'B'.repeat(40) }, dirs[2], manifest, sig, deps),
        { cause: 'bad_signature' }, 'a different pinned fingerprint fails even on a good signature');
    } finally {
      for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

/** OpenPGP CRC-24 (RFC 4880 §6.1) over `bytes`. */
function crc24(bytes: Buffer): number {
  let crc = 0xb704ce;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let bit = 0; bit < 8; bit++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

/** Dearmors one ASCII-armored public key block and checks its CRC-24 line (B-1718). */
function dearmorPublicKey(armored: string): Buffer {
  const lines = armored.split(/\r?\n/u).map((line) => line.trim());
  const begin = lines.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----');
  const end = lines.indexOf('-----END PGP PUBLIC KEY BLOCK-----');
  assert.ok(begin >= 0 && end > begin, 'armor header and footer are present');
  const blank = lines.indexOf('', begin);
  assert.ok(blank > begin && blank < end, 'armor headers end with a blank line');
  const body = lines.slice(blank + 1, end).filter((line) => line !== '');
  const checksum = body.at(-1)?.startsWith('=') ? body.pop()!.slice(1) : null;
  const bytes = Buffer.from(body.join(''), 'base64');
  assert.ok(checksum, 'armor carries a CRC-24 checksum line');
  assert.equal(crc24(bytes), Buffer.from(checksum, 'base64').readUIntBE(0, 3), 'armor CRC-24 matches');
  return bytes;
}

test('ش3: the embedded keyring equals dearmored keys/claude-code.asc and the descriptor pins its fingerprint', () => {
  const committed = dearmorPublicKey(fs.readFileSync(path.join(HERE, 'keys', 'claude-code.asc'), 'utf8'));
  assert.deepEqual(Buffer.from(CLAUDE_SIGNING_KEYRING_BASE64, 'base64'), committed);
  assert.equal(SOURCE.keyFingerprint, '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE');
  assert.equal(SOURCE.keyringBase64, CLAUDE_SIGNING_KEYRING_BASE64);
  assert.equal(SOURCE.minSignedVersion, '2.1.89');
  assert.deepEqual([...SOURCE.allowedHosts], ['downloads.claude.ai']);
  assert.equal(SOURCE.maxRedirects, 0);
  assert.equal(SOURCE.smallCapBytes, 64 * 1024);
});

// ── job flow ─────────────────────────────────────────────────────────────────

test('claude: signed release → streamed binary → `install <v>` → checksum of versions/<v>', async () => {
  setDeps();
  const done = await runClaude();
  assert.equal(done.status, 'succeeded');
  assert.equal(done.toVersion, V);
  assert.equal(installs.length, 1);
  assert.deepEqual(installs[0].args, ['install', V], 'ش1: explicit verified version, never latest');
  assert.equal(path.dirname(installs[0].cmd).startsWith(staging), true, 'the staged, verified binary runs');
  assert.ok(done.log.includes(`Expected binary: sha256 ${BIN_SHA}`));
  assert.ok(done.log.some((l) => l.startsWith(`Signed manifest verified: claude ${V}`)));
  const ok = audits.at(-1);
  assert.equal(ok?.action, 'harness_install_succeeded');
  assert.equal(ok?.metadata.manifestVersion, V);
  assert.equal(ok?.metadata.keyFingerprint, CLAUDE_SIGNING_FINGERPRINT);
  assert.ok(fs.lstatSync(LAUNCHER).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(staging), [], 'staging removed');
  assert.equal(isHarnessLeased('claude'), false);
});

test('ش2: an installed version file that differs from the signed checksum is verify_failed and removed', async () => {
  setDeps({ runCommand: runner({ ...OK, stdout: VALIDSIG }, placeClaude(Buffer.from('tampered'))) });
  const done = await runClaude();
  assert.equal(done.error?.code, 'verify_failed');
  assert.equal(audits.at(-1)?.metadata.cause, 'installed_checksum_mismatch');
  assert.equal(fs.existsSync(VERSION_FILE), false);
  assert.equal(fs.readdirSync(path.dirname(LAUNCHER)).includes('claude'), false,
    'launcher link pointing literally at versions/<v> removed');
  assert.deepEqual(audits.at(-1)?.metadata.removedPaths, ['~/.local/bin/claude', `~/.local/share/claude/versions/${V}`]);
  assert.ok(fs.existsSync(path.join(SANDBOX_HOME, '.claude.json')), '~/.claude.json is never removed');
});

test('ش5 claude: a launcher pointing anywhere else is left in place', async () => {
  const elsewhere = path.join(SANDBOX_HOME, '.local', 'share', 'other-claude');
  setDeps({
    runCommand: runner({ ...OK, stdout: VALIDSIG }, () => {
      fs.mkdirSync(path.dirname(LAUNCHER), { recursive: true });
      fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
      fs.writeFileSync(elsewhere, 'x');
      fs.symlinkSync(elsewhere, LAUNCHER);
    }),
  });
  const done = await runClaude();
  assert.equal(done.error?.code, 'verify_failed');
  assert.ok(fs.lstatSync(LAUNCHER).isSymbolicLink());
  assert.ok(done.log.includes('Left in place ~/.local/bin/claude (symlink)'));
});

test('ش3: no gpgv fails closed (verifier_unavailable) before any binary download or install', async () => {
  setDeps({ gpgvPath: () => null });
  const done = await runClaude();
  assert.equal(done.error?.code, 'verifier_unavailable');
  assert.ok(done.error?.messageAr);
  assert.equal(fetched.some((u) => u.endsWith('/claude')), false);
  assert.equal(installs.length, 0);
});

test('ش3: a bad signature, a timeout or a wrong-key VALIDSIG is script_rejected; nothing downloaded or run', async () => {
  const wrongKey = VALIDSIG.split(CLAUDE_SIGNING_FINGERPRINT).join('C'.repeat(40));
  for (const verdict of [{ ...OK, code: 1, stdout: '[GNUPG:] BADSIG x\n' }, { ...OK, stdout: wrongKey },
    { ...OK, code: null, timedOut: true }]) {
    setDeps({ runCommand: runner(verdict) });
    const done = await runClaude();
    assert.equal(done.error?.code, 'script_rejected');
    assert.match(String(audits.at(-1)?.metadata.cause), /^(bad_signature|gpgv_timeout)$/u);
    assert.equal(fetched.some((u) => u.endsWith('/claude')), false);
    assert.equal(installs.length, 0);
  }
});

test('ش1/ش3: latest and manifest checks (bad pointer, below 2.1.89, version mismatch, no platform)', async () => {
  const cases: Array<[Record<string, () => Response>, string, Partial<InstallDeps>?]> = [
    [{ '/latest': () => respond(200, '<html>oops</html>') }, 'bad_version'],
    [{ '/latest': () => respond(200, '2.1.88') }, 'below_min_signed'],
    [{ [`/${V}/manifest.json`]: () => respond(200, manifestFor({ version: '2.1.303' })) }, 'version_mismatch'],
    [{}, 'platform_unsupported', { claudePlatform: () => null }],
    [{ '/latest': () => respond(302, '', { location: 'https://evil.example/latest' }) }, 'ASSET_REDIRECT_LIMIT'],
    [{ [`/${V}/manifest.json.sig`]: () => respond(200, '') }, 'empty_body'],
    [{ [`/${V}/manifest.json`]: () => respond(200, 'x'.repeat(64 * 1024 + 1)) }, 'ASSET_TOO_LARGE'],
  ];
  for (const [over, cause, deps] of cases) {
    setDeps({ fetchImpl: releaseFetch(over), ...(deps ?? {}) });
    const done = await runClaude();
    assert.equal(done.error?.code, 'script_rejected', cause);
    assert.equal(audits.at(-1)?.metadata.cause, cause);
    assert.equal(installs.length, 0, cause);
  }
});

test('ش3: binary size or digest different from the signed manifest is rejected before it runs', async () => {
  for (const [body, cause] of [[Buffer.from('#!/bin/sh\necho evil claude\n'), 'ASSET_DIGEST_MISMATCH'],
    [Buffer.from('short'), 'ASSET_SIZE_MISMATCH']] as const) {
    setDeps({ fetchImpl: releaseFetch({ [`/${V}/linux-x64/claude`]: () => respond(200, body) }) });
    const done = await runClaude();
    assert.equal(done.error?.code, 'script_rejected');
    assert.equal(audits.at(-1)?.metadata.cause, cause);
    assert.equal(installs.length, 0);
    assert.deepEqual(fs.readdirSync(staging), []);
  }
});

test('ش4: free space is checked in HOME and in the staging parent', async () => {
  setDeps({ freeBytes: (dir) => (dir === SANDBOX_HOME ? 10 * 1024 ** 3 : 1) });
  const done = await runClaude();
  assert.equal(done.error?.code, 'insufficient_space');
  assert.equal(fetched.length, 0);
});

test('nonzero `claude install` exit fails install_failed and removes what it created', async () => {
  setDeps({
    runCommand: async (cmd, args) => {
      if (cmd === GPGV) return { ...OK, stdout: VALIDSIG };
      installs.push({ cmd, args });
      placeClaude()();
      return { ...OK, code: 2 };
    },
  });
  const done = await runClaude();
  assert.equal(done.error?.code, 'install_failed');
  assert.equal(fs.existsSync(VERSION_FILE), false);
});

// ── pre-run warnings (owner decision 2 + npm removal) ───────────────────────

test('owner decision 2: a system copy needs an acknowledgement, then installs; nothing is deleted', async () => {
  const system = path.join(SANDBOX_HOME, '.local', 'system-claude');
  fs.mkdirSync(path.dirname(system), { recursive: true });
  fs.writeFileSync(system, 'system');
  setDeps({ systemClaudePaths: [system, path.join(SANDBOX_HOME, 'absent-claude')] });
  let required: Array<{ kind: string; token: string; textEn: string; textAr: string }> = [];
  assert.throws(() => startHarnessInstall('claude', { userId: 1 }), (e: { code?: string; details?: { required?: typeof required } }) => {
    required = e.details?.required ?? [];
    return e.code === 'CONFIRMATION_REQUIRED';
  });
  assert.deepEqual(required.map((r) => r.kind), ['systemCopy']);
  assert.match(required[0].textEn, /will not delete the system copy/u);
  assert.match(required[0].textAr, /CLAUDE_CLI_PATH/u);
  assert.equal(isHarnessLeased('claude'), false, 'refused before the lease');
  assert.throws(() => startHarnessInstall('claude', { userId: 1, acks: [{ kind: 'systemCopy', token: 'forged' }] }),
    { code: 'CONFIRMATION_REQUIRED' });
  const done = await runClaude(required.map((r) => ({ kind: r.kind, token: r.token })));
  assert.equal(done.status, 'succeeded');
  assert.equal(fs.readFileSync(system, 'utf8'), 'system');
});

test('npm removal: a writable npm-global claude requires the owner to confirm its removal', async () => {
  const prefix = path.join(SANDBOX_HOME, '.npm-global');
  fs.mkdirSync(path.join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  setDeps({ npmPrefixes: () => [prefix] });
  let required: Array<{ kind: string; token: string; textEn: string }> = [];
  assert.throws(() => startHarnessInstall('claude', { userId: 1 }), (e: { details?: { required?: typeof required } }) => {
    required = e.details?.required ?? [];
    return true;
  });
  assert.deepEqual(required.map((r) => r.kind), ['npmRemoval']);
  assert.match(required[0].textEn, /npm uninstall --global @anthropic-ai\/claude-code/u);
  const done = await runClaude(required.map((r) => ({ kind: r.kind, token: r.token })));
  assert.equal(done.status, 'succeeded');
});

// ── qa follow-ups on stage B ─────────────────────────────────────────────────

/** Runs `fn` with the real claude verifier (registry resolver + realpath + --version). */
async function withRealVerify(fn: () => Promise<void>): Promise<void> {
  const saved = process.env.CLAUDE_CLI_PATH;
  delete process.env.CLAUDE_CLI_PATH;
  try {
    await fn();
  } finally {
    if (saved !== undefined) process.env.CLAUDE_CLI_PATH = saved;
  }
}

function setRealVerify(over: Partial<InstallDeps>): void {
  setDeps(over, true);
}

test('M1: the launcher must resolve to the verified versions/<v> and --version must be <v>', async () => {
  await withRealVerify(async () => {
    let versionOf = '';
    setRealVerify({ runVersion: async (bin) => { versionOf = bin; return `${V} (Claude Code)`; } });
    const done = await runClaude();
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    assert.equal(done.toVersion, V);
    assert.equal(versionOf, LAUNCHER);
  });
});

test('M1: a launcher linked to another file with the same bytes is verify_failed (launcher_mismatch)', async () => {
  await withRealVerify(async () => {
    const other = path.join(SANDBOX_HOME, '.local', 'share', 'claude-elsewhere');
    setRealVerify({
      runVersion: async () => V,
      runCommand: runner({ ...OK, stdout: VALIDSIG }, () => {
        fs.mkdirSync(path.dirname(VERSION_FILE), { recursive: true });
        fs.writeFileSync(VERSION_FILE, BIN, { mode: 0o755 });
        fs.writeFileSync(other, BIN, { mode: 0o755 });
        fs.mkdirSync(path.dirname(LAUNCHER), { recursive: true });
        fs.symlinkSync(other, LAUNCHER);
      }),
    });
    const done = await runClaude();
    assert.equal(done.error?.code, 'verify_failed');
    assert.equal(audits.at(-1)?.metadata.cause, 'launcher_mismatch');
  });
});

test('M1: a --version that differs from the signed release is verify_failed (version_mismatch)', async () => {
  await withRealVerify(async () => {
    setRealVerify({ runVersion: async () => '2.1.303 (Claude Code)' });
    const done = await runClaude();
    assert.equal(done.error?.code, 'verify_failed');
    assert.equal(audits.at(-1)?.metadata.cause, 'version_mismatch');
    assert.equal(fs.existsSync(VERSION_FILE), false, 'the job cleaned up what it created');
  });
});

test('I1: a busy lease or slot refuses without consuming the owner\'s confirmation tokens', async () => {
  const system = path.join(SANDBOX_HOME, '.local', 'system-claude');
  fs.mkdirSync(path.dirname(system), { recursive: true });
  fs.writeFileSync(system, 'system');
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setDeps({
    systemClaudePaths: [system],
    installCompatAsset: async () => { await gate; },
  });
  let required: Array<{ kind: string; token: string }> = [];
  assert.throws(() => startHarnessInstall('claude', { userId: 1 }), (e: { details?: { required?: typeof required } }) => {
    required = e.details?.required ?? [];
    return required.length === 1;
  });
  const acks = required.map((r) => ({ kind: r.kind, token: r.token }));
  acquireHarnessLease('claude', 'other-job');
  assert.throws(() => startHarnessInstall('claude', { userId: 1, acks }), { code: 'HARNESS_UPDATE_IN_PROGRESS' });
  releaseHarnessLease('claude', 'other-job');
  const holder = startHarnessInstall('opencode', { userId: 1 });
  assert.throws(() => startHarnessInstall('claude', { userId: 1, acks }), { code: 'HARNESS_INSTALL_SLOT_BUSY' });
  release();
  await holder.done;
  const done = await runClaude(acks);
  assert.equal(done.status, 'succeeded', 'the same tokens still work after both refusals');
});

test('I2/I5: only the claude install step gets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1; 10 min timeout', async () => {
  setDeps({ cleanEnv: () => ({ ANTHROPIC_BASE_URL: 'https://x', CLAUDE_CONFIG_DIR: '/c' }) });
  const done = await runClaude();
  assert.equal(done.status, 'succeeded');
  const env = installs[0].env ?? {};
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal('ANTHROPIC_BASE_URL' in env, false);
  assert.equal('CLAUDE_CONFIG_DIR' in env, false);
  assert.equal(SOURCE.timeoutMs, 10 * 60 * 1000);
});

