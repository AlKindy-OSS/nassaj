import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  buildCodexCagedLaunch,
  CodexCageError,
} from './codex-provider-cage.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cage-'));
const codexHome = path.join(sandbox, '.nassaj-users', '7', '.codex');
const cwd = path.join(sandbox, 'project');
const bwrap = path.join(sandbox, 'bwrap');
const runtime = path.join(sandbox, 'runtime');
const binary = path.join(runtime, 'codex');

before(() => {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(cwd);
  fs.mkdirSync(runtime);
  fs.writeFileSync(binary, '#!/bin/sh\n');
  fs.writeFileSync(bwrap, '#!/bin/sh\n');
  fs.chmodSync(binary, 0o700);
  fs.chmodSync(bwrap, 0o700);
});

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function build(overrides: Record<string, unknown> = {}, depOverrides = {}) {
  return buildCodexCagedLaunch(
    {
      userId: 7,
      codexHome,
      cwd,
      trustedProjectRoot: cwd,
      cmd: binary,
      args: ['exec', 'hello'],
      ...overrides,
    },
    { resolveBwrapPath: () => bwrap, runtimeReadPaths: [runtime], ...depOverrides },
  );
}

function errorCode(run: () => unknown) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof CodexCageError);
    return true;
  });
  try {
    run();
  } catch (error) {
    return (error as CodexCageError).code;
  }
}

describe('buildCodexCagedLaunch', () => {
  it('builds a networkless allowlist cage with only explicit writable mounts', () => {
    const launch = build();
    assert.equal(launch.cmd, bwrap);
    assert.ok(launch.args.includes('--unshare-net'));
    assert.ok(launch.args.includes('--clearenv'));
    assert.deepEqual(
      launch.args.slice(launch.args.indexOf('--ro-bind'), launch.args.indexOf('--dev')),
      ['--ro-bind', runtime, runtime],
    );
    assert.equal(launch.args.includes('/'), false, 'host root must never be mounted');
    const binds = launch.args
      .map((value, index) => (value === '--bind' ? launch.args.slice(index + 1, index + 3) : null))
      .filter(Boolean);
    assert.deepEqual(binds, [
      [codexHome, codexHome],
      [cwd, cwd],
    ]);
    assert.ok(launch.args.includes('--tmpfs'));
    assert.ok(launch.args.includes('/tmp'));
  });

  it('clears inherited env and exposes only per-user Codex home metadata', () => {
    const args = build().args;
    assert.deepEqual(args.slice(args.indexOf('--clearenv'), args.indexOf('--ro-bind')), [
      '--clearenv',
      '--setenv',
      'CODEX_HOME',
      codexHome,
      '--setenv',
      'HOME',
      path.dirname(codexHome),
      '--setenv',
      'PATH',
      '/usr/bin:/bin',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'LANG',
      'C.UTF-8',
    ]);
    assert.equal(args.includes('.npmrc'), false);
    assert.equal(args.includes('.hermes'), false);
  });

  it('fails closed when bwrap is absent or not executable', () => {
    assert.equal(
      errorCode(() => build({}, { resolveBwrapPath: () => null })),
      'missing-bwrap',
    );
    assert.equal(
      errorCode(() => build({}, { resolveBwrapPath: () => runtime })),
      'invalid-bwrap',
    );
  });

  it('fails closed for absent identity, home, cwd, or binary', () => {
    assert.equal(errorCode(() => build({ userId: null })), 'invalid-user-id');
    assert.equal(errorCode(() => build({ codexHome: '' })), 'missing-codex-home');
    assert.equal(errorCode(() => build({ cwd: '' })), 'missing-cwd');
    assert.equal(errorCode(() => build({ cmd: '' })), 'missing-binary');
  });

  it('fails closed for nonexistent home, cwd, or binary', () => {
    assert.equal(
      errorCode(() => build({ codexHome: path.join(sandbox, '.nassaj-users', '7', '.missing') })),
      'invalid-codex-home',
    );
    assert.equal(errorCode(() => build({ cwd: path.join(sandbox, 'missing') })), 'invalid-cwd');
    assert.equal(errorCode(() => build({ cmd: path.join(sandbox, 'missing') })), 'invalid-binary');
  });

  it('rejects a shared or foreign-user CODEX_HOME', () => {
    assert.equal(errorCode(() => build({ codexHome: cwd })), 'invalid-codex-home');
    const foreign = path.join(sandbox, '.nassaj-users', '8', '.codex');
    fs.mkdirSync(foreign, { recursive: true });
    assert.equal(errorCode(() => build({ codexHome: foreign })), 'invalid-codex-home');
  });

  it('rejects overlapping writable mounts that could expose credentials', () => {
    const broadCwd = path.join(sandbox, '.nassaj-users', '7');
    assert.equal(
      errorCode(() => build({ cwd: broadCwd })),
      'overlapping-writable-paths',
    );
  });

  it('rejects host-root read or write grants even through injected test seams', () => {
    assert.equal(errorCode(() => build({ cwd: '/' })), 'invalid-cwd');
    assert.equal(
      errorCode(() => build({}, { runtimeReadPaths: ['/'] })),
      'invalid-runtime-path',
    );
  });

  it('rejects host-root grants reached through symlinks after canonicalization', () => {
    const rootLink = path.join(sandbox, 'host-root-link');
    fs.symlinkSync('/', rootLink);

    assert.equal(
      errorCode(() => build({ cwd: rootLink })),
      'overlapping-writable-paths',
    );
    assert.equal(
      errorCode(() =>
        build(
          { cmd: '/bin/sh' },
          { runtimeReadPaths: [rootLink] },
        )),
      'invalid-runtime-path',
    );
  });

  it('fails closed when no declared runtime path contains the binary', () => {
    assert.equal(
      errorCode(() =>
        build({}, { runtimeReadPaths: [path.join(sandbox, 'missing-runtime')] })),
      'binary-outside-runtime',
    );
  });

  it('rejects reserved host pseudo-filesystems and runtime sockets as cwd', () => {
    for (const reserved of ['/proc', '/dev', '/run', '/tmp']) {
      assert.equal(
        errorCode(() => build({ cwd: reserved })),
        'invalid-cwd',
        `${reserved} must not be rebound writable over the cage`,
      );
    }
  });

  it('requires an explicit trusted project root containing cwd', () => {
    assert.equal(
      errorCode(() => build({ trustedProjectRoot: undefined })),
      'missing-project-root',
    );
    const outside = path.join(sandbox, 'outside-project');
    fs.mkdirSync(outside);
    assert.equal(errorCode(() => build({ cwd: outside })), 'invalid-cwd');
  });

  it('rejects trusted roots overlapping CODEX_HOME or operator app data', () => {
    const userWork = path.join(sandbox, '.nassaj-users', '7', 'work');
    fs.mkdirSync(userWork);
    assert.equal(
      errorCode(() =>
        build({ cwd: userWork, trustedProjectRoot: path.dirname(codexHome) })),
      'invalid-project-root',
    );

    const hermesWork = path.join(sandbox, '.hermes', 'work');
    fs.mkdirSync(hermesWork, { recursive: true });
    assert.equal(
      errorCode(() =>
        build(
          { cwd: hermesWork, trustedProjectRoot: hermesWork },
          { homedir: () => sandbox },
        )),
      'invalid-cwd',
    );
  });

  it('rejects runtime grants inside the operator home', () => {
    assert.equal(
      errorCode(() => build({}, { homedir: () => sandbox })),
      'invalid-runtime-path',
    );
  });

  it('uses canonical containment for cwd, including symlink chains', () => {
    const nested = path.join(cwd, 'nested');
    const outside = path.join(sandbox, 'outside-canonical-root');
    const insideLink = path.join(sandbox, 'inside-link');
    const insideChain = path.join(sandbox, 'inside-chain');
    const outsideLink = path.join(sandbox, 'outside-link');
    fs.mkdirSync(nested);
    fs.mkdirSync(outside);
    fs.symlinkSync(nested, insideLink);
    fs.symlinkSync(insideLink, insideChain);
    fs.symlinkSync(outside, outsideLink);

    assert.equal(build({ cwd: nested }).args.includes(nested), true);
    assert.equal(build({ cwd: insideChain }).args.includes(nested), true);
    assert.equal(errorCode(() => build({ cwd: outsideLink })), 'invalid-cwd');
  });

  it('rejects chained runtime aliases to root and operator data', () => {
    const rootAlias = path.join(sandbox, 'root-alias');
    const rootChain = path.join(sandbox, 'root-chain');
    const operatorHome = path.join(sandbox, 'operator-home-runtime');
    const operatorRuntime = path.join(operatorHome, 'runtime');
    const operatorAlias = path.join(sandbox, 'operator-runtime-alias');
    fs.mkdirSync(operatorRuntime, { recursive: true });
    fs.symlinkSync('/', rootAlias);
    fs.symlinkSync(rootAlias, rootChain);
    fs.symlinkSync(operatorRuntime, operatorAlias);

    assert.equal(
      errorCode(() =>
        build({ cmd: '/bin/sh' }, { runtimeReadPaths: [rootChain] })),
      'invalid-runtime-path',
    );
    assert.equal(
      errorCode(() =>
        build(
          { cmd: path.join(operatorRuntime, 'codex') },
          {
            homedir: () => operatorHome,
            runtimeReadPaths: [operatorAlias],
            statSync: (candidate: string) =>
              candidate === path.join(operatorRuntime, 'codex')
                ? { isFile: () => true }
                : fs.statSync(candidate),
            accessSync: () => undefined,
            realpathSync: (candidate: string) =>
              candidate === path.join(operatorRuntime, 'codex')
                ? candidate
                : fs.realpathSync(candidate),
          },
        )),
      'invalid-runtime-path',
    );
  });

  it('rejects traversal-shaped and non-canonical user identities', () => {
    for (const userId of ['../7', '7/../8', '٠٧', 0, -1, '1e2']) {
      assert.equal(errorCode(() => build({ userId })), 'invalid-user-id');
    }
    assert.equal(
      errorCode(() =>
        build({
          codexHome: path.join(sandbox, '.nassaj-users', '8', '..', '7', '.codex'),
          userId: 8,
        })),
      'invalid-codex-home',
    );
  });

  it('rejects common operator credential trees even when claimed as a project', () => {
    const operatorHome = path.join(sandbox, 'operator-home-credentials');
    fs.mkdirSync(operatorHome);
    for (const name of ['.ssh', '.claude', '.config', '.docker', '.aws']) {
      const credentialTree = path.join(operatorHome, name);
      fs.mkdirSync(credentialTree);
      assert.equal(
        errorCode(() =>
          build(
            { cwd: credentialTree, trustedProjectRoot: credentialTree },
            { homedir: () => operatorHome },
          )),
        'invalid-cwd',
        `${name} must never be accepted as a writable project`,
      );
    }
  });

  it('rejects canonical targets of symlinked operator credential trees', () => {
    const operatorHome = path.join(sandbox, 'operator-home-credential-links');
    fs.mkdirSync(operatorHome);
    for (const name of ['.ssh', '.claude', '.config', '.docker', '.aws']) {
      const target = path.join(sandbox, `credential-target-${name.slice(1)}`);
      fs.mkdirSync(target);
      fs.symlinkSync(target, path.join(operatorHome, name));
      assert.equal(
        errorCode(() =>
          build(
            { cwd: target, trustedProjectRoot: target },
            { homedir: () => operatorHome },
          )),
        'invalid-cwd',
        `${name} canonical target must never become a writable project`,
      );
    }
  });

  it('requires argv to remain an array of literal strings', () => {
    assert.equal(errorCode(() => build({ args: 'exec --help' })), 'invalid-args');
    assert.equal(errorCode(() => build({ args: ['exec', { injected: true }] })), 'invalid-args');
  });

  it('preserves empty and Unicode argv without shell interpretation', () => {
    const launch = build({ args: ['', 'مرحبا 🌍', 'a b', ';rm -rf /'] });
    assert.deepEqual(launch.args.slice(launch.args.indexOf('--')), [
      '--',
      binary,
      '',
      'مرحبا 🌍',
      'a b',
      ';rm -rf /',
    ]);
  });

  it('preserves argv as data after the bwrap separator', () => {
    const args = build({ args: ['exec', '$(touch /tmp/nope)', '--flag=value'] }).args;
    assert.deepEqual(args.slice(args.indexOf('--')), [
      '--',
      binary,
      'exec',
      '$(touch /tmp/nope)',
      '--flag=value',
    ]);
  });
});
