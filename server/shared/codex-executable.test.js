import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { Codex } from '@openai/codex-sdk';

import { resolveCodexRuntime, codexLaunchOptions, codexFileDigest } from './codex-executable.js';

function fixture(layout = 'bin') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-'));
  const sdkEntry = path.join(root, 'nested', 'sdk', 'index.js');
  const packages = path.join(root, 'nested', 'sdk', 'node_modules', '@openai');
  const vendor = path.join(packages, 'codex-linux-x64', 'vendor', 'x86_64-unknown-linux-musl');
  const executable = path.join(vendor, layout, 'codex');
  for (const filename of [sdkEntry, path.join(packages, 'codex', 'package.json'), path.join(packages, 'codex-linux-x64', 'package.json'), path.join(vendor, 'codex-package.json'), executable]) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, filename.endsWith('.json') ? '{}' : '\x7fELFnative-v1', { mode: 0o700 });
  }
  fs.mkdirSync(path.join(vendor, layout === 'bin' ? 'codex-path' : 'path'));
  return { root, sdkEntry, executable };
}

for (const layout of ['bin', 'codex']) {
  test(`resolves SDK-nested ${layout} layout and preserves companion PATH`, () => {
    const f = fixture(layout);
    try {
      const runtime = resolveCodexRuntime({ sdkEntry: f.sdkEntry, platform: 'linux', arch: 'x64' });
      assert.equal(runtime.executablePath, fs.realpathSync(f.executable));
      const options = codexLaunchOptions({ PATH: '/decoy', TOKEN: 'preserve' }, runtime);
      assert.equal(options.codexPathOverride, runtime.executablePath);
      assert.equal(options.env.PATH, `${runtime.pathDirs[0]}${path.delimiter}/decoy`);
      assert.equal(options.env.TOKEN, 'preserve');
      const before = codexFileDigest(f.executable);
      fs.writeFileSync(f.executable, 'native-v2: same version string');
      assert.notEqual(codexFileDigest(f.executable), before);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('unsupported platform, missing executable, non-executable file fail closed', () => {
  const f = fixture();
  try {
    assert.throws(() => resolveCodexRuntime({ sdkEntry: f.sdkEntry, platform: 'other', arch: 'x64' }), /PLATFORM_UNSUPPORTED/);
    assert.throws(() => resolveCodexRuntime({ sdkEntry: f.sdkEntry, platform: 'linux', arch: 'other' }), /PLATFORM_UNSUPPORTED/);
    fs.writeFileSync(f.executable, '#!/bin/sh\necho codex-cli 0.153.2');
    assert.throws(() => resolveCodexRuntime({ sdkEntry: f.sdkEntry, platform: 'linux', arch: 'x64' }), /NATIVE_BINARY_REQUIRED/);
    fs.writeFileSync(f.executable, '\x7fELFnative-v1');
    fs.chmodSync(f.executable, 0o600);
    assert.throws(() => resolveCodexRuntime({ sdkEntry: f.sdkEntry, platform: 'linux', arch: 'x64' }));
    fs.rmSync(f.executable);
    assert.throws(() => resolveCodexRuntime({ sdkEntry: f.sdkEntry, platform: 'linux', arch: 'x64' }));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('installed resolver equals SDK default binary and companion paths without launching a turn', () => {
  // Read-only compatibility assertion; production never accesses SDK internals.
  const sdk = new Codex();
  const runtime = resolveCodexRuntime();
  assert.equal(runtime.executablePath, fs.realpathSync(sdk.exec.executablePath));
  assert.deepEqual(runtime.pathDirs, sdk.exec.pathDirs.map(item => fs.realpathSync(item)));
});


test('digest invalidates after same-size replacement with restored mtime', () => {
  const f = fixture();
  try {
    const beforeStat = fs.statSync(f.executable);
    const before = codexFileDigest(f.executable);
    fs.writeFileSync(f.executable, '\x7fELFnative-v2');
    fs.utimesSync(f.executable, beforeStat.atime, beforeStat.mtime);
    assert.notEqual(codexFileDigest(f.executable), before);
    const replacement = `${f.executable}.new`;
    fs.writeFileSync(replacement, '\x7fELFnative-v3', { mode: 0o700 });
    fs.utimesSync(replacement, beforeStat.atime, beforeStat.mtime);
    const second = codexFileDigest(f.executable);
    fs.renameSync(replacement, f.executable);
    assert.notEqual(codexFileDigest(f.executable), second);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});


test('ext cache requires two seconds observed stability; unknown FS and future timestamps hash', () => {
  const f = fixture();
  let monotonic = 0;
  const fileTime = Number(fs.statSync(f.executable, { bigint: true }).ctimeNs / 1000000n);
  let wall = fileTime + 3000;
  const policy = { platform: 'linux', filesystemType: () => 0xef53, wallNow: () => wall, monotonicNow: () => monotonic };
  const reads = mock.method(fs, 'readSync');
  try {
    codexFileDigest(f.executable, policy);
    let count = reads.mock.callCount();
    monotonic = 1999;
    codexFileDigest(f.executable, policy);
    assert.ok(reads.mock.callCount() > count);
    count = reads.mock.callCount();
    monotonic = 2000;
    codexFileDigest(f.executable, policy);
    assert.equal(reads.mock.callCount(), count);
    wall = fileTime - 1000;
    codexFileDigest(f.executable, policy);
    assert.ok(reads.mock.callCount() > count);
    count = reads.mock.callCount();
    wall = fileTime + 3000;
    codexFileDigest(f.executable, { ...policy, filesystemType: () => 0 });
    assert.ok(reads.mock.callCount() > count);
    count = reads.mock.callCount();
    codexFileDigest(f.executable, { ...policy, filesystemType: () => { throw new Error('unavailable'); } });
    assert.ok(reads.mock.callCount() > count);
  } finally { reads.mock.restore(); fs.rmSync(f.root, { recursive: true, force: true }); }
});


test('same-tick byte change resets monotonic observation even if the stat tuple stays equal', () => {
  const f = fixture();
  const stat = fs.statSync(f.executable, { bigint: true });
  let monotonic = 0;
  let wall = Number(stat.ctimeNs / 1000000n) + 1000;
  const policy = { platform: 'linux', filesystemType: () => 0xef53, wallNow: () => wall, monotonicNow: () => monotonic };
  const statMock = mock.method(fs, 'statSync', () => stat);
  const fdMock = mock.method(fs, 'fstatSync', () => stat);
  const reads = mock.method(fs, 'readSync');
  try {
    const first = codexFileDigest(f.executable, policy);
    fs.writeFileSync(f.executable, '\x7fELFnative-v2');
    monotonic = 1000;
    assert.notEqual(codexFileDigest(f.executable, policy), first);
    let count = reads.mock.callCount();
    wall += 4000;
    monotonic = 2000;
    codexFileDigest(f.executable, policy);
    assert.ok(reads.mock.callCount() > count);
    count = reads.mock.callCount();
    monotonic = 3000;
    codexFileDigest(f.executable, policy);
    assert.equal(reads.mock.callCount(), count);
  } finally {
    reads.mock.restore(); statMock.mock.restore(); fdMock.mock.restore();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
