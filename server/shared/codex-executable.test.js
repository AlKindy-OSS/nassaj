import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  acquireCodexLaunchIdentity,
  assertCodexIdentityUnchanged,
  CODEX_MACHINE_CLI_MISSING,
  CODEX_MACHINE_CLI_MISSING_MESSAGE,
  codexFileDigest,
  codexFingerprintFields,
  codexLaunchOptions,
  codexMachineLauncherPath,
  codexShellCommand,
  isCodexMachineCliMissing,
  prewarmCodexLaunchIdentity,
  readCodexCliVersion,
  resolveCodexMachineRuntime,
} from './codex-executable.js';
import { createCodexMachineFixture, pointCurrent, writeCodexRelease } from './tests/codex-release-fixture.js';

const canExecFixture = process.platform === 'linux' && process.arch === 'x64';
const fixedVersion = version => () => version;

/** Run `body` with HOME pointed at a fresh machine-release fixture and CODEX_PATH unset. */
function withMachine(body, { version = '0.156.0' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-machine-'));
  const saved = { HOME: process.env.HOME, CODEX_PATH: process.env.CODEX_PATH };
  try {
    const fixture = createCodexMachineFixture(root, version);
    process.env.HOME = fixture.home;
    delete process.env.CODEX_PATH;
    return body(fixture);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const acquire = () => acquireCodexLaunchIdentity({ readVersion: fixedVersion('0.156.0') });

test('acquires a frozen identity inside the versioned release, never through current', () => withMachine((f) => {
  const identity = acquire();
  assert.equal(identity.executablePath, path.join(fs.realpathSync(f.release), 'bin', 'codex'));
  assert.equal(identity.releaseRoot, fs.realpathSync(f.release));
  assert.ok(!identity.executablePath.includes(`${path.sep}current${path.sep}`));
  assert.equal(identity.version, '0.156.0');
  assert.match(identity.treeDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(identity.nativeDigest, codexFileDigest(identity.executablePath));
  assert.deepEqual(identity.pathDirs, [path.join(identity.releaseRoot, 'codex-path')]);
  assert.ok(Object.isFrozen(identity) && Object.isFrozen(identity.pathDirs));
  assert.equal(assertCodexIdentityUnchanged(identity), identity);
}));

test('launch options require the identity and prepend its companion path', () => withMachine(() => {
  const identity = acquire();
  const options = codexLaunchOptions({ PATH: '/decoy', TOKEN: 'keep' }, identity);
  assert.equal(options.codexPathOverride, identity.executablePath);
  assert.equal(options.env.PATH, `${identity.pathDirs[0]}${path.delimiter}/decoy`);
  assert.equal(options.env.TOKEN, 'keep');
  assert.throws(() => codexLaunchOptions({ PATH: '/decoy' }), /PERMISSION_CODEX_IDENTITY_REQUIRED/u);
  assert.equal(codexLaunchOptions.length, 2);
}));

test('default version probe executes the release entrypoint', { skip: !canExecFixture }, () => withMachine((f) => {
  const identity = acquireCodexLaunchIdentity();
  assert.equal(identity.version, '0.156.0');
  assert.equal(readCodexCliVersion(path.join(f.release, 'bin', 'codex')), '0.156.0');
  assert.equal(prewarmCodexLaunchIdentity(), true);
}));

test('reported version must equal codex-package.json version', () => withMachine(() => {
  assert.throws(() => acquireCodexLaunchIdentity({ readVersion: fixedVersion('0.157.0') }),
    /PERMISSION_CODEX_VERSION_MISMATCH/u);
}));

test('reported version output must be exactly codex-cli X.Y.Z', { skip: !canExecFixture }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-version-'));
  try {
    const release = writeCodexRelease(path.join(root, 'pkg'), '0.156.0', { reportedVersion: 'x' });
    assert.throws(() => readCodexCliVersion(path.join(release, 'bin', 'codex')), /CLI_VERSION_INVALID/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing ~/.local/bin/codex fails with CODEX_MACHINE_CLI_MISSING and no fallback', () => withMachine((f) => {
  fs.rmSync(f.launcher);
  // The SDK-bundled npm binary is still installed in node_modules; it must not be used.
  assert.throws(() => acquire(), (error) => error.code === CODEX_MACHINE_CLI_MISSING
    && isCodexMachineCliMissing(error));
  fs.symlinkSync(path.join(f.root, 'nowhere', 'codex'), f.launcher);
  assert.throws(() => acquire(), { code: CODEX_MACHINE_CLI_MISSING });
  assert.equal(prewarmCodexLaunchIdentity(), false);
  assert.match(CODEX_MACHINE_CLI_MISSING_MESSAGE, /Codex غير مثبّت على الجهاز/u);
  assert.match(CODEX_MACHINE_CLI_MISSING_MESSAGE, /install it officially at ~\/.local\/bin\/codex or set CODEX_PATH/u);
}));

test('server CODEX_PATH must be absolute; the resolver accepts no member env', () => withMachine((f) => {
  process.env.CODEX_PATH = 'relative/codex';
  assert.throws(() => codexMachineLauncherPath(), /PERMISSION_CODEX_PATH_NOT_ABSOLUTE/u);
  process.env.CODEX_PATH = f.launcher;
  assert.equal(codexMachineLauncherPath(), f.launcher);
  delete process.env.CODEX_PATH;
  // A member-resolved provider env carrying CODEX_PATH=/evil never reaches resolution.
  const memberEnv = { ...process.env, CODEX_PATH: '/evil' };
  const identity = acquireCodexLaunchIdentity({ readVersion: fixedVersion('0.156.0'), env: memberEnv });
  assert.equal(identity.releaseRoot, fs.realpathSync(f.release));
  assert.equal(codexLaunchOptions(memberEnv, identity).codexPathOverride, identity.executablePath);
  assert.equal(resolveCodexMachineRuntime.length, 0);
}));

test('swapping current between measure and launch leaves the executed file unchanged', () => withMachine((f) => {
  const identity = acquire();
  const next = writeCodexRelease(f.pkg, '0.157.0');
  pointCurrent(f.pkg, next);
  assert.doesNotThrow(() => assertCodexIdentityUnchanged(identity));
  assert.equal(codexLaunchOptions({}, identity).codexPathOverride,
    path.join(fs.realpathSync(f.release), 'bin', 'codex'));
  const fresh = acquireCodexLaunchIdentity({ readVersion: fixedVersion('0.157.0') });
  assert.equal(fresh.releaseRoot, fs.realpathSync(next));
  assert.notEqual(fresh.treeDigest, identity.treeDigest);
}));

for (const [label, mutate] of [
  ['resource bytes', f => fs.appendFileSync(path.join(f.release, 'codex-resources', 'bwrap'), 'x')],
  ['entrypoint bytes', f => fs.appendFileSync(path.join(f.release, 'bin', 'codex'), 'x')],
  ['manifest', f => fs.appendFileSync(path.join(f.release, 'codex-package.json'), ' ')],
  ['removed resource', f => fs.rmSync(path.join(f.release, 'codex-resources', 'voice', 'manifest.json'))],
  ['added file', f => fs.writeFileSync(path.join(f.release, 'codex-path', 'extra'), 'x')],
  ['mode', f => fs.chmodSync(path.join(f.release, 'codex-path', 'rg'), 0o700)],
]) {
  test(`modifying a release (${label}) after measurement refuses with CODEX_RUNTIME_CHANGED`, () => withMachine((f) => {
    const identity = acquire();
    mutate(f);
    assert.throws(() => assertCodexIdentityUnchanged(identity), { code: 'CODEX_RUNTIME_CHANGED' });
  }));
}

test('a deleted release refuses and a non-frozen identity is rejected', () => withMachine((f) => {
  const identity = acquire();
  assert.throws(() => assertCodexIdentityUnchanged({ ...identity }), /IDENTITY_REQUIRED/u);
  fs.rmSync(f.release, { recursive: true, force: true });
  assert.throws(() => assertCodexIdentityUnchanged(identity), { code: 'CODEX_RUNTIME_CHANGED' });
}));

test('tree digest covers every resource file', () => withMachine((f) => {
  const before = acquire().treeDigest;
  fs.rmSync(path.join(f.release, 'codex-resources', 'zsh', 'bin', 'zsh'));
  assert.notEqual(acquire().treeDigest, before);
}));

test('foreign symlinks and special files inside the release are rejected', () => withMachine((f) => {
  const link = path.join(f.release, 'codex-resources', 'evil');
  fs.symlinkSync('/etc/passwd', link);
  assert.throws(() => acquire(), { code: 'PERMISSION_CODEX_RELEASE_SYMLINK' });
  fs.rmSync(link);
  fs.rmSync(path.join(f.release, 'codex'));
  fs.symlinkSync('bin/codex-code-mode-host', path.join(f.release, 'codex'));
  assert.throws(() => acquire(), { code: 'PERMISSION_CODEX_RELEASE_SYMLINK' });
  fs.rmSync(path.join(f.release, 'codex'));
  fs.symlinkSync('bin/codex', path.join(f.release, 'codex'));
  assert.doesNotThrow(() => acquire());
  const fifo = path.join(f.release, 'codex-resources', 'fifo');
  spawnSync('mkfifo', [fifo]);
  if (fs.existsSync(fifo)) assert.throws(() => acquire(), { code: 'PERMISSION_CODEX_RELEASE_FILE_TYPE' });
}));

const manifestPath = f => path.join(f.release, 'codex-package.json');
const rewriteManifest = (f, patch) => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath(f), 'utf8'));
  fs.writeFileSync(manifestPath(f), JSON.stringify({ ...manifest, ...patch }));
};

for (const [label, patch] of [
  ['layout version', { layoutVersion: 2 }],
  ['foreign target', { target: 'aarch64-apple-darwin' }],
  ['entrypoint mismatch', { entrypoint: 'bin/codex-code-mode-host' }],
  ['missing path dir', { pathDir: 'nope' }],
  ['escaping resources dir', { resourcesDir: '../..' }],
  ['absolute path dir', { pathDir: '/usr/bin' }],
  ['invalid version', { version: 'latest' }],
]) {
  test(`incompatible layout (${label}) fails closed`, () => withMachine((f) => {
    rewriteManifest(f, patch);
    assert.throws(() => acquire(), { code: 'PERMISSION_CODEX_LAYOUT_INVALID' });
  }));
}

test('symlinked path dir, missing or corrupt manifest fail closed', () => withMachine((f) => {
  const pathDir = path.join(f.release, 'codex-path');
  fs.renameSync(pathDir, `${pathDir}.real`);
  fs.symlinkSync(`${pathDir}.real`, pathDir);
  assert.throws(() => resolveCodexMachineRuntime(), { code: 'PERMISSION_CODEX_LAYOUT_INVALID' });
  fs.rmSync(pathDir);
  fs.renameSync(`${pathDir}.real`, pathDir);
  fs.writeFileSync(manifestPath(f), '{');
  assert.throws(() => resolveCodexMachineRuntime(), { code: 'PERMISSION_CODEX_LAYOUT_INVALID' });
  fs.rmSync(manifestPath(f));
  assert.throws(() => resolveCodexMachineRuntime(), { code: 'PERMISSION_CODEX_LAYOUT_UNSUPPORTED' });
}));

test('unsupported platform, wrapper script and non-executable entrypoint fail closed', () => withMachine((f) => {
  assert.throws(() => resolveCodexMachineRuntime({ platform: 'other', arch: 'x64' }), /PLATFORM_UNSUPPORTED/u);
  const entry = path.join(f.release, 'bin', 'codex');
  fs.writeFileSync(entry, '#!/bin/sh\necho codex-cli 0.156.0\n');
  assert.throws(() => resolveCodexMachineRuntime(), /NATIVE_BINARY_REQUIRED/u);
  fs.writeFileSync(entry, '\x7fELFnative');
  fs.chmodSync(entry, 0o644);
  assert.throws(() => resolveCodexMachineRuntime(), /EACCES/u);
}));

test('fingerprint fields bind bytes, not inode stamps', () => withMachine(() => {
  const identity = acquire();
  const fields = codexFingerprintFields(identity);
  assert.deepEqual(Object.keys(fields).sort(),
    ['arch', 'nativeDigest', 'platform', 'resolverDigest', 'sdkSourceDigest', 'treeDigest']);
  assert.throws(() => codexFingerprintFields({}), /IDENTITY_REQUIRED/u);
}));

test('shell command quotes the realpath and every argument', () => {
  const identity = { executablePath: "/opt/co'dex/bin/codex" };
  assert.equal(codexShellCommand(identity, ['login', '--device-auth']),
    `'/opt/co'\\''dex/bin/codex' 'login' '--device-auth'`);
  assert.throws(() => codexShellCommand(null, ['login']), /IDENTITY_REQUIRED/u);
});

test('real machine install resolves inside its versioned release', {
  skip: !fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'codex')),
}, () => {
  const identity = acquireCodexLaunchIdentity();
  assert.match(identity.executablePath, /\/releases\/[^/]+\/bin\/codex$/u);
  assert.ok(!identity.executablePath.includes('/node_modules/'));
});

test('digest invalidates after same-size replacement with restored mtime', () => withMachine((f) => {
  const file = path.join(f.release, 'codex-path', 'rg');
  const beforeStat = fs.statSync(file);
  const before = codexFileDigest(file);
  fs.writeFileSync(file, '\x7fELFrg2');
  fs.utimesSync(file, beforeStat.atime, beforeStat.mtime);
  assert.notEqual(codexFileDigest(file), before);
  const replacement = `${file}.new`;
  fs.writeFileSync(replacement, '\x7fELFrg3', { mode: 0o700 });
  fs.utimesSync(replacement, beforeStat.atime, beforeStat.mtime);
  const second = codexFileDigest(file);
  fs.renameSync(replacement, file);
  assert.notEqual(codexFileDigest(file), second);
}));

test('ext cache requires two seconds observed stability; unknown FS and future timestamps hash', () => withMachine((f) => {
  const file = path.join(f.release, 'codex-path', 'rg');
  let monotonic = 0;
  const fileTime = Number(fs.statSync(file, { bigint: true }).ctimeNs / 1000000n);
  let wall = fileTime + 3000;
  const policy = { platform: 'linux', filesystemType: () => 0xef53, wallNow: () => wall, monotonicNow: () => monotonic };
  const reads = mock.method(fs, 'readSync');
  try {
    codexFileDigest(file, policy);
    let count = reads.mock.callCount();
    monotonic = 1999;
    codexFileDigest(file, policy);
    assert.ok(reads.mock.callCount() > count);
    count = reads.mock.callCount();
    monotonic = 2000;
    codexFileDigest(file, policy);
    assert.equal(reads.mock.callCount(), count);
    wall = fileTime - 1000;
    codexFileDigest(file, policy);
    assert.ok(reads.mock.callCount() > count);
    count = reads.mock.callCount();
    wall = fileTime + 3000;
    codexFileDigest(file, { ...policy, filesystemType: () => 0 });
    assert.ok(reads.mock.callCount() > count);
    count = reads.mock.callCount();
    codexFileDigest(file, { ...policy, filesystemType: () => { throw new Error('unavailable'); } });
    assert.ok(reads.mock.callCount() > count);
  } finally { reads.mock.restore(); }
}));

test('same-tick byte change resets monotonic observation even if the stat tuple stays equal', () => withMachine((f) => {
  const file = path.join(f.release, 'codex-path', 'rg');
  const stat = fs.statSync(file, { bigint: true });
  let monotonic = 0;
  let wall = Number(stat.ctimeNs / 1000000n) + 1000;
  const policy = { platform: 'linux', filesystemType: () => 0xef53, wallNow: () => wall, monotonicNow: () => monotonic };
  const statMock = mock.method(fs, 'statSync', () => stat);
  const fdMock = mock.method(fs, 'fstatSync', () => stat);
  const reads = mock.method(fs, 'readSync');
  try {
    const first = codexFileDigest(file, policy);
    fs.writeFileSync(file, '\x7fELFrg2');
    monotonic = 1000;
    assert.notEqual(codexFileDigest(file, policy), first);
    let count = reads.mock.callCount();
    wall += 4000;
    monotonic = 2000;
    codexFileDigest(file, policy);
    assert.ok(reads.mock.callCount() > count);
    count = reads.mock.callCount();
    monotonic = 3000;
    codexFileDigest(file, policy);
    assert.equal(reads.mock.callCount(), count);
  } finally {
    reads.mock.restore(); statMock.mock.restore(); fdMock.mock.restore();
  }
}));

test('qa I5: a failing digest forgets only its own cache entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-digest-cache-'));
  let now = 0;
  const policy = { platform: 'linux', filesystemType: () => 0xef53, wallNow: () => Date.now() + 10_000, monotonicNow: () => now };
  const opens = mock.method(fs, 'openSync');
  try {
    const kept = path.join(root, 'kept');
    fs.writeFileSync(kept, 'stable bytes');
    const digest = codexFileDigest(kept, policy);
    now = 3000;
    assert.equal(codexFileDigest(kept, policy), digest);
    const hashed = opens.mock.callCount();
    assert.throws(() => codexFileDigest(path.join(root, 'missing'), policy));
    now = 6000;
    assert.equal(codexFileDigest(kept, policy), digest);
    assert.equal(opens.mock.callCount(), hashed, 'the unrelated sealed digest was served from cache');
  } finally {
    opens.mock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
