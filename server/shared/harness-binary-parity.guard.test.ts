/**
 * T-1873 harness-binary parity guard. Every harness CLI Nassaj launches,
 * probes, versions or updates must be the ONE copy the harness registry
 * (server/shared/harness-binaries.ts) resolves:
 *   (1) registry keys == every non-`no-cli` HARNESS_UPDATE_DESCRIPTORS id;
 *   (2) descriptor.resolveBinary / updateArgv target == the registry resolver
 *       (npm-prefix: prefix/bin/<bin>);
 *   (3) static AST check over the launch inventory: each harness spawn / exec /
 *       SDK executable option traces to the registry or a named allowlist entry;
 *   (4) PTY command lines start with the quoted resolver path;
 *   (5) a member env's *_PATH never redirects a binary;
 *   (6) behaviour: representative launchers spawn exactly the registry path
 *       (bwrap argv unwrapped when the cage is on).
 *
 * HOME is a fixture tree built BEFORE any server module loads, because the
 * descriptor table derives its npm prefixes from the operator home at load.
 */

import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, mock, test } from 'node:test';

import ts from 'typescript';

import { pointCurrent, writeCodexRelease } from './tests/codex-release-fixture.js';

// ---------------------------------------------------------------------------
// Fixture operator home (built before any server import)
// ---------------------------------------------------------------------------

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.dirname(SERVER_ROOT);
const scratchParent = process.env.TMPDIR && fs.existsSync(process.env.TMPDIR) ? process.env.TMPDIR : '/var/tmp';
const scratch = fs.mkdtempSync(path.join(scratchParent, 't1873-guard-'));
const FAKE_HOME = path.join(scratch, 'home');
const OVERRIDE_ENVS = [
  'CLAUDE_CLI_PATH', 'CODEX_PATH', 'AGY_PATH', 'CURSOR_PATH', 'OPENCODE_PATH',
  'QWEN_PATH', 'KIMI_PATH',
] as const;
const savedEnv = Object.fromEntries(
  [...OVERRIDE_ENVS, 'HOME', 'NASSAJ_PROVIDER_CAGE', 'NASSAJ_VENDOR_BINARY_PIN'].map((key) => [key, process.env[key]]),
);

function writeExecutable(file: string, body = '#!/bin/sh\nexit 0\n'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function linkInto(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), target), link);
}

/** Measured install layouts, reproduced under FAKE_HOME. */
function buildFakeInstalls(home: string): void {
  const local = path.join(home, '.local');
  linkInto(writeExecutable(path.join(local, 'share', 'claude', 'versions', '9.9.9')), path.join(local, 'bin', 'claude'));
  linkInto(
    writeExecutable(path.join(local, 'share', 'cursor-agent', 'versions', 'v1', 'cursor-agent')),
    path.join(local, 'bin', 'cursor-agent'),
  );
  writeExecutable(path.join(local, 'bin', 'agy'));
  // codex: a real machine release (T-1872 layout) at the measured standalone
  // install, so the registry's machine-identity resolver accepts it.
  const standalone = path.join(home, '.codex', 'packages', 'standalone');
  pointCurrent(standalone, writeCodexRelease(standalone, '9.9.9'));
  linkInto(path.join(standalone, 'current', 'bin', 'codex'), path.join(local, 'bin', 'codex'));
  writeExecutable(path.join(home, '.opencode', 'bin', 'opencode'));
  // npm `--global --prefix ~/.local` layouts: lib/node_modules/<pkg> + bin link.
  linkInto(
    writeExecutable(path.join(local, 'lib', 'node_modules', '@qwen-code', 'qwen-code', 'cli-entry.js')),
    path.join(local, 'bin', 'qwen'),
  );
  // kimi: the vendor's native install script puts one binary in ~/.kimi-code/bin.
  writeExecutable(path.join(home, '.kimi-code', 'bin', 'kimi'));
}

buildFakeInstalls(FAKE_HOME);
process.env.HOME = FAKE_HOME;
for (const key of OVERRIDE_ENVS) delete process.env[key];
delete process.env.NASSAJ_PROVIDER_CAGE;
delete process.env.NASSAJ_VENDOR_BINARY_PIN;

// ---------------------------------------------------------------------------
// child_process recorder (module-level mock, before the launchers load)
// ---------------------------------------------------------------------------

type SpawnCall = { fn: 'spawn' | 'spawnSync'; cmd: string; args: readonly string[]; env?: NodeJS.ProcessEnv };
const spawnCalls: SpawnCall[] = [];
let spawnSyncStdout = '';

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean; pid: number } {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true, pid: 424242,
  });
  setImmediate(() => child.emit('close', 0, null));
  return child;
}

mock.module('node:child_process', {
  exports: {
    ...childProcess,
    spawn: (cmd: string, args: readonly string[] = [], options: { env?: NodeJS.ProcessEnv } = {}) => {
      spawnCalls.push({ fn: 'spawn', cmd, args, env: options.env });
      return fakeChild();
    },
    spawnSync: (cmd: string, args: readonly string[] = [], options: { env?: NodeJS.ProcessEnv } = {}) => {
      spawnCalls.push({ fn: 'spawnSync', cmd, args, env: options.env });
      return { status: 0, stdout: spawnSyncStdout, stderr: '', signal: null, pid: 1, output: [] };
    },
  },
});

const registry = await import('./harness-binaries.js');
const { HARNESS_UPDATE_DESCRIPTORS, npmPrefixInstallArgs } = await import(
  '../modules/providers/harness-update/descriptors.js'
);

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

const fakePath = (...segments: string[]) => path.join(FAKE_HOME, ...segments);
const realpath = (file: string) => fs.realpathSync(file);

function withEnv<T>(patch: Record<string, string | undefined>, run: () => T): T {
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withHiddenFile<T>(file: string, run: () => T): T {
  const hidden = `${file}.hidden`;
  fs.renameSync(file, hidden);
  try {
    return run();
  } finally {
    fs.renameSync(hidden, file);
  }
}

// ---------------------------------------------------------------------------
// Registry unit behaviour
// ---------------------------------------------------------------------------

describe('harness registry resolution rule', () => {
  test('resolves every harness to its measured path under the operator home', () => {
    const expected: Record<string, string> = {
      claude: fakePath('.local', 'bin', 'claude'),
      codex: fakePath('.local', 'bin', 'codex'),
      antigravity: fakePath('.local', 'bin', 'agy'),
      cursor: fakePath('.local', 'bin', 'cursor-agent'),
      opencode: fakePath('.opencode', 'bin', 'opencode'),
      qwen: fakePath('.local', 'bin', 'qwen'),
      kimi: fakePath('.kimi-code', 'bin', 'kimi'),
    };
    assert.deepEqual([...registry.HARNESS_BINARY_IDS].sort(), Object.keys(expected).sort());
    for (const [id, file] of Object.entries(expected)) {
      assert.equal(registry.resolveHarnessBinary(id), file, id);
    }
  });

  test('returns the launcher itself, never its realpath (snapshot layouts need the link)', () => {
    const claude = registry.resolveHarnessBinary('claude');
    assert.ok(fs.lstatSync(claude).isSymbolicLink());
  });

  test('aliases map to canonical ids; unknown ids are a programming error', () => {
    assert.equal(registry.toHarnessBinaryId('agy'), 'antigravity');
    assert.equal(registry.toHarnessBinaryId(' Cursor-Agent '), 'cursor');
    assert.equal(registry.toHarnessBinaryId('glm'), null);
    assert.equal(registry.resolveHarnessBinary('agy'), registry.resolveHarnessBinary('antigravity'));
    assert.throws(() => registry.resolveHarnessBinary('deepseek'), /Unknown harness binary id/);
  });

  test('an absolute runnable server override wins', () => {
    const override = writeExecutable(path.join(scratch, 'opt', 'kimi'));
    withEnv({ KIMI_PATH: `  ${override}  ` }, () => {
      assert.equal(registry.resolveHarnessBinary('kimi'), override);
    });
  });

  test('a relative override fails instead of a PATH lookup', () => {
    withEnv({ QWEN_PATH: 'qwen' }, () => {
      assert.throws(
        () => registry.resolveHarnessBinary('qwen'),
        (error: unknown) => error instanceof registry.HarnessBinaryUnresolvedError
          && error.reason === 'override-not-absolute' && /QWEN_PATH must be an absolute path/.test(error.message),
      );
    });
  });

  test('a missing override fails instead of falling back to the measured path', () => {
    withEnv({ KIMI_PATH: path.join(scratch, 'nope', 'kimi') }, () => {
      assert.throws(
        () => registry.resolveHarnessBinary('kimi'),
        (error: unknown) => error instanceof registry.HarnessBinaryUnresolvedError
          && error.reason === 'override-not-runnable',
      );
    });
  });

  test('a missing measured install fails with a clear, home-relative message', () => {
    withHiddenFile(fakePath('.local', 'bin', 'agy'), () => {
      assert.throws(
        () => registry.resolveHarnessBinary('antigravity'),
        (error: unknown) => error instanceof registry.HarnessBinaryUnresolvedError
          && error.reason === 'not-installed' && error.harness === 'antigravity'
          && error.message.includes('~/.local/bin/agy') && error.message.includes('AGY_PATH'),
      );
      assert.equal(registry.tryResolveHarnessBinary('agy'), null);
    });
  });

  test('a non-executable measured file is not installed', () => {
    const file = fakePath('.local', 'bin', 'cursor-agent');
    fs.chmodSync(realpath(file), 0o644);
    try {
      assert.equal(registry.tryResolveHarnessBinary('cursor'), null);
    } finally {
      fs.chmodSync(realpath(file), 0o755);
    }
  });

  test('codex resolves through the machine release identity its launches use', async () => {
    const { resolveCodexMachineRuntime } = await import('./codex-executable.js');
    const launcher = registry.resolveHarnessBinary('codex');
    assert.equal(launcher, fakePath('.local', 'bin', 'codex'));
    assert.equal(realpath(launcher), resolveCodexMachineRuntime().executablePath);
    // Not a machine release (a script at the launcher) → invalid, never a fallback.
    const stub = writeExecutable(path.join(scratch, 'codex-script', 'codex'));
    withEnv({ CODEX_PATH: stub }, () => {
      assert.throws(() => registry.resolveHarnessBinary('codex'), (error: unknown) => (
        error instanceof registry.HarnessBinaryUnresolvedError && error.reason === 'invalid-install'
          && !error.message.includes(scratch)
      ));
    });
    withEnv({ CODEX_PATH: 'codex' }, () => {
      assert.throws(() => registry.resolveHarnessBinary('codex'), (error: unknown) => (
        error instanceof registry.HarnessBinaryUnresolvedError && error.reason === 'override-not-absolute'
      ));
    });
    withEnv({ CODEX_PATH: path.join(scratch, 'no-codex', 'codex') }, () => {
      assert.throws(() => registry.resolveHarnessBinary('codex'), (error: unknown) => (
        error instanceof registry.HarnessBinaryUnresolvedError && error.reason === 'not-installed'
      ));
    });
  });

  test('an extra server-env override wins under the same rules', () => {
    const custom = writeExecutable(path.join(scratch, 'wf', 'claude'));
    withEnv({ WORKFLOW_SUPERVISOR_CLAUDE_BIN: undefined }, () => {
      assert.equal(registry.resolveHarnessBinaryWithOverride('claude', 'WORKFLOW_SUPERVISOR_CLAUDE_BIN'),
        registry.resolveHarnessBinary('claude'));
    });
    withEnv({ WORKFLOW_SUPERVISOR_CLAUDE_BIN: custom }, () => {
      assert.equal(registry.resolveHarnessBinaryWithOverride('claude', 'WORKFLOW_SUPERVISOR_CLAUDE_BIN'), custom);
    });
    withEnv({ WORKFLOW_SUPERVISOR_CLAUDE_BIN: 'claude' }, () => {
      assert.throws(
        () => registry.resolveHarnessBinaryWithOverride('claude', 'WORKFLOW_SUPERVISOR_CLAUDE_BIN'),
        (error: unknown) => error instanceof registry.HarnessBinaryUnresolvedError
          && error.reason === 'override-not-absolute' && error.message.includes('WORKFLOW_SUPERVISOR_CLAUDE_BIN'),
      );
    });
  });

  test('tryResolve rethrows programming errors', () => {
    assert.throws(() => registry.tryResolveHarnessBinary('not-a-harness'), /Unknown harness binary id/);
  });

  test('shell quoting survives embedded quotes and spaces', () => {
    assert.equal(registry.shellQuoteBinary("/a b/it's"), `'/a b/it'\\''s'`);
    assert.equal(registry.quotedHarnessBinary('kimi'), `'${fakePath('.kimi-code', 'bin', 'kimi')}'`);
  });

  test('win32 claude keeps the claude-cli-path resolver', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      withEnv({ CLAUDE_CLI_PATH: 'C:\\tools\\claude.exe' }, () => {
        assert.equal(registry.resolveHarnessBinary('claude'), 'C:\\tools\\claude.exe');
      });
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  test('boot check logs unresolved harnesses and never throws', () => {
    const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
    const warn = (message: string, details: Record<string, unknown>) => warnings.push({ message, details });
    const allResolved = registry.logUnresolvedHarnessBinaries(warn);
    assert.equal(allResolved.every((status) => status.resolved), true);
    assert.equal(warnings.length, 0);

    withHiddenFile(fakePath('.opencode', 'bin', 'opencode'), () => {
      const statuses = registry.logUnresolvedHarnessBinaries(warn);
      const opencode = statuses.find((status) => status.id === 'opencode')!;
      assert.equal(opencode.resolved, false);
      assert.equal(opencode.path, null);
      assert.match(opencode.error ?? '', /opencode CLI not found/);
    });
    assert.equal(warnings.length, 1);
    assert.deepEqual(
      (warnings[0].details.unresolved as Array<{ id: string }>).map((row) => row.id),
      ['opencode'],
    );
  });

  test('boot check never warns about a retired body missing its CLI (T-1953)', () => {
    const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
    const warn = (message: string, details: Record<string, unknown>) => warnings.push({ message, details });
    withHiddenFile(fakePath('.local', 'bin', 'cursor-agent'), () => {
      withHiddenFile(fakePath('.local', 'bin', 'qwen'), () => {
        withHiddenFile(fakePath('.kimi-code', 'bin', 'kimi'), () => {
          const statuses = registry.logUnresolvedHarnessBinaries(warn);
          for (const id of ['cursor', 'qwen', 'kimi']) {
            assert.equal(statuses.find((status) => status.id === id)!.resolved, false, id);
          }
        });
      });
    });
    assert.equal(warnings.length, 0);
  });

  test('boot check names only the non-retired harness when a retired body is also missing', () => {
    const warnings: Array<{ message: string; details: Record<string, unknown> }> = [];
    const warn = (message: string, details: Record<string, unknown>) => warnings.push({ message, details });
    withHiddenFile(fakePath('.local', 'bin', 'qwen'), () => {
      withHiddenFile(fakePath('.opencode', 'bin', 'opencode'), () => {
        registry.logUnresolvedHarnessBinaries(warn);
      });
    });
    assert.equal(warnings.length, 1);
    assert.deepEqual(
      (warnings[0].details.unresolved as Array<{ id: string }>).map((row) => row.id),
      ['opencode'],
    );
  });
});

// ---------------------------------------------------------------------------
// B-1349: harness stubs never land outside a test sandbox
// ---------------------------------------------------------------------------

describe('B-1349 test fixtures refuse the real home', async () => {
  const fixtures = await import('./__tests__/harness-binary-fixtures.js');

  test('installFakeHarnessBinary refuses the real operator home and non-temp dirs', () => {
    const realHome = os.userInfo().homedir;
    for (const id of registry.HARNESS_BINARY_IDS) {
      assert.throws(() => fixtures.installFakeHarnessBinary(realHome, id), /B-1349: .*real home/);
    }
    assert.throws(() => fixtures.installFakeHarnessBinary('/usr/share/nassaj-not-a-sandbox', 'qwen'), /B-1349/);
    assert.throws(() => fixtures.installFakeHarnessOverrides(realHome), /B-1349/);
  });

  test('a stub replaces a launcher link instead of writing through it', () => {
    const home = path.join(scratch, 'b1349-home');
    const target = writeExecutable(path.join(scratch, 'b1349-pkg', 'cli-entry.js'), 'REAL PACKAGE ENTRY');
    linkInto(target, path.join(home, '.local', 'bin', 'qwen'));
    const file = fixtures.installFakeHarnessBinary(home, 'qwen');
    assert.equal(fs.readFileSync(target, 'utf8'), 'REAL PACKAGE ENTRY', 'the link target is untouched');
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  });

  test('an intermediate dir linking out of the sandbox is refused before any write', () => {
    const home = path.join(scratch, 'b1349-escape');
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync('/usr/share', path.join(home, '.local'));
    fs.symlinkSync('/usr/share', path.join(home, '.kimi-code'));
    for (const id of ['qwen', 'kimi'] as const) {
      assert.throws(() => fixtures.installFakeHarnessBinary(home, id), /B-1349/);
    }
  });

  test('every harness-update test sandboxes HOME in its first import', () => {
    const dir = path.join(SERVER_ROOT, 'modules/providers/harness-update');
    const offenders = fs.readdirSync(dir)
      .filter((name) => /\.test\.[cm]?[jt]s$/.test(name))
      .filter((name) => {
        const first = fs.readFileSync(path.join(dir, name), 'utf8').match(/^import [^\n]*$/m)?.[0] ?? '';
        return !/sandbox-home|stub-harness-binaries/.test(first);
      });
    assert.deepEqual(offenders, []);
  });

  test('no test hands the fixture the process home', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/installFakeHarness(?:Binary|Overrides)\(\s*(?:os\.homedir\(\)|process\.env\.HOME|os\.userInfo\(\))/.test(text)) {
            offenders.push(path.relative(SERVER_ROOT, full));
          }
        }
      }
    };
    walk(SERVER_ROOT);
    assert.deepEqual(offenders, []);
  });
});

// ---------------------------------------------------------------------------
// (1) + (2) descriptor parity
// ---------------------------------------------------------------------------

type DescriptorLike = { id: string; state: string };

/** Registry ids missing for a CLI descriptor, and registry ids with no descriptor. */
function registryParityViolations(descriptors: Readonly<Record<string, DescriptorLike>>): string[] {
  const cliIds = Object.values(descriptors).filter((d) => d.state !== 'no-cli').map((d) => d.id).sort();
  const registryIds = [...registry.HARNESS_BINARY_IDS].sort();
  return [
    ...cliIds.filter((id) => !registryIds.includes(id as never)).map((id) => `descriptor without registry entry: ${id}`),
    ...registryIds.filter((id) => !cliIds.includes(id)).map((id) => `registry entry without descriptor: ${id}`),
  ];
}

describe('(1) registry keys == every CLI harness descriptor', () => {
  test('the live descriptor table and the registry agree exactly', () => {
    assert.deepEqual(registryParityViolations(HARNESS_UPDATE_DESCRIPTORS), []);
  });

  test('a fake CLI harness without a registry entry is caught', () => {
    const withFake = { ...HARNESS_UPDATE_DESCRIPTORS, fakecli: { id: 'fakecli', state: 'updatable' } };
    assert.deepEqual(registryParityViolations(withFake), ['descriptor without registry entry: fakecli']);
  });
});

describe('(2) descriptor resolver and update target == registry', () => {
  const cliDescriptors = Object.values(HARNESS_UPDATE_DESCRIPTORS).filter((d) => d.state !== 'no-cli');

  /** Env/home matrix: measured installs, absolute overrides, and a missing install. */
  const matrix: Array<{ name: string; env: Record<string, string | undefined>; hide?: string }> = [
    { name: 'measured installs', env: {} },
    ...cliDescriptors.map((d) => {
      const spec = registry.HARNESS_BINARY_SPECS[d.id as keyof typeof registry.HARNESS_BINARY_SPECS];
      const override = writeExecutable(path.join(scratch, 'overrides', d.id, spec.command));
      return { name: `${spec.overrideEnv} override`, env: { [spec.overrideEnv]: override } };
    }),
    { name: 'missing opencode', env: {}, hide: fakePath('.opencode', 'bin', 'opencode') },
  ];

  for (const row of matrix) {
    test(`resolveBinary() equals the registry — ${row.name}`, () => {
      const run = () => withEnv(row.env, () => {
        for (const d of cliDescriptors) {
          const fromRegistry = registry.tryResolveHarnessBinary(d.id);
          if (fromRegistry === null) {
            assert.throws(() => d.resolveBinary(), registry.HarnessBinaryUnresolvedError, d.id);
            assert.equal(d.updateArgv(), null, `${d.id}: no update target when unresolved`);
          } else {
            assert.equal(d.resolveBinary(), fromRegistry, d.id);
          }
        }
      });
      if (row.hide) withHiddenFile(row.hide, run);
      else run();
    });
  }

  test('native self-update harnesses update the resolver binary itself', () => {
    for (const d of cliDescriptors.filter((x) => x.installMethod === 'native-self-update')) {
      assert.equal(d.updateArgv()?.cmd, registry.resolveHarnessBinary(d.id), d.id);
    }
  });

  test('npm-prefix harnesses install globally into the prefix whose bin IS the resolver', () => {
    const npmDescriptors = cliDescriptors.filter((d) => d.installMethod === 'npm-prefix');
    assert.deepEqual(npmDescriptors.map((d) => d.id).sort(), ['qwen']);
    for (const d of npmDescriptors) {
      const argv = d.updateArgv()!;
      assert.equal(argv.cmd, 'npm');
      assert.deepEqual(argv.args, npmPrefixInstallArgs(d.npm!.prefix, `${d.npm!.pkg}@latest`));
      assert.ok(argv.args.includes('--global'), `${d.id}: a non-global install writes prefix/node_modules`);
      assert.equal(d.npm!.prefix, fakePath('.local'));
      const spec = registry.HARNESS_BINARY_SPECS[d.id as 'qwen'];
      const prefixBin = path.join(d.npm!.prefix, 'bin', spec.command);
      assert.equal(realpath(prefixBin), realpath(registry.resolveHarnessBinary(d.id)), d.id);
      assert.ok(
        realpath(prefixBin).startsWith(path.join(d.npm!.prefix, 'lib', 'node_modules', ...d.npm!.pkg.split('/'))),
        `${d.id}: the bin must point into the global package tree the update rewrites`,
      );
    }
  });

  test('a descriptor resolver ignores a member env handed to it', () => {
    for (const d of cliDescriptors) {
      const call = d.resolveBinary as unknown as (env: NodeJS.ProcessEnv) => string;
      assert.equal(call({ KIMI_PATH: '/evil/kimi', QWEN_PATH: '/evil/qwen' }), registry.resolveHarnessBinary(d.id));
    }
  });
});

// ---------------------------------------------------------------------------
// (3) static AST check over the launch inventory
// ---------------------------------------------------------------------------

/** Registry resolvers and the reviewed wrappers that delegate to them. */
const REGISTRY_CALLS = new Set([
  'resolveHarnessBinary', 'tryResolveHarnessBinary', 'quotedHarnessBinary', 'resolveHarnessBinaryWithOverride',
]);
/** Cross-file wrappers: name → defining file (proven below to call the registry). */
const REGISTRY_WRAPPERS: Readonly<Record<string, string>> = Object.freeze({
  resolveOpenCodeBinaryPath: 'shared/utils.ts',
  resolveRealClaudeBinary: 'services/isolation/managed-claude-terminal-env.ts',
});
/** Calls whose `cmd`/`command` result is the registry value or the cage's bwrap. */
const CAGE_CALLS = new Set(['resolveCagedLaunch', 'cagedLaunchFn', 'buildCagedLaunch']);
/**
 * codex launch identity (shared/codex-executable.js, T-1872): the SAME machine
 * release the registry's codex entry validates — proven in (3) below. A launch
 * runs `codexLaunchOptions(env, identity).codexPathOverride` or
 * `codexShellCommand(identity, …)`, both `identity.executablePath`.
 */
const CODEX_IDENTITY_CALLS = new Set(['codexShellCommand']);
const CODEX_OPTION_CALLS = new Set(['codexLaunchOptions']);
const SPAWN_NAMES = new Set([
  'spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'spawnFunction', 'spawnRaw',
  'crossSpawn', 'spawnImpl', 'spawnFn', 'execImpl', 'execFileAsync', 'rawSpawn',
]);
const HARNESS_COMMANDS = new Set(['claude', 'codex', 'agy', 'cursor-agent', 'opencode', 'qwen', 'kimi']);

/**
 * Named allowlist: `file#sink` → reason. A sink is the source text of the
 * binary expression handed to spawn/exec/SDK. Anything not listed here must
 * trace to the registry.
 */
const SINK_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  // Cage: the systemd-run transient unit wraps the adapter spec binary, which
  // extended-cli-adapter pins from the registry at probe() time.
  'modules/turn-supervisor/adapters/isolated-cli-cage.ts#systemdRun': 'systemd-run unit wrapping the spec binary',
  'modules/turn-supervisor/adapters/isolated-cli-cage.ts#systemctl': 'systemctl control of that unit',
  // kimi: POSIX `sh -c 'exec "$0" "$@"' <registry kimi>` wrapper (see (6)).
  'kimi-agent-cli.js#spawnCmd': 'sh exec-wrapper around the registry kimi (binaryPath)',
  // Extended adapter: `binary` is pinned by probe() from resolveExtendedCliBinary.
  'modules/turn-supervisor/adapters/extended-cli-adapter.ts#binary': 'pinned at probe() from resolveExtendedCliBinary',
  // cli-capability: `binary` params are the registry value passed by the probes.
  'modules/turn-supervisor/cli-capability.ts#binary': 'parameter fed only by tryResolveHarnessBinary',
  // Managed claude terminal: realBinary is resolveRealClaudeBinary() (registry),
  // carried server → PTY env contract.
  'services/isolation/managed-claude-launcher.ts#realBinary': 'server-resolved resolveRealClaudeBinary() via the PTY contract',
  // Workflow unit: task-runner execs the absolute --claude-bin launchScope passes
  // from the registry (it runs out of process, inside the systemd unit).
  'modules/workflow-supervisor/task-runner.ts#a.claudeBin': 'absolute --claude-bin from launchScope (registry)',
  // PTY: the shell is bash/powershell; the harness command line inside it is
  // built by buildShellCommand from quoted registry paths (checked in (4)).
  'modules/websocket/services/shell-websocket.service.ts#ptyLaunch.cmd': 'bash -c <registry-built command> (see (4))',
  'modules/websocket/services/shell-websocket.service.ts#shell': 'bash/powershell host shell',
  'services/isolation/provider-cage-wiring.js#launch.cmd': 'cage bwrap or the caller-checked cmd',
  'services/isolation/provider-cage-wiring.js#spec.command': 'SDK-composed command from pathToClaudeCodeExecutable (registry)',
  // Generic git transport helper; its callers pass the literal 'git'.
  'routes/git.js#command': 'spawnAsync(git …) helper',
});

type Violation = { file: string; line: number; sink: string };

function parse(file: string): ts.SourceFile {
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    if (expression.name.text === 'sync' || expression.name.text === 'async') return calleeName(expression.expression);
    return expression.name.text;
  }
  return null;
}

/** Collects every value assigned to `name` in the file (declarations + `=` assignments). */
function assignmentsOf(source: ts.SourceFile, name: string): ts.Expression[] {
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      values.push(node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left) && node.left.text === name) {
      values.push(node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

/** Every value given to an object-literal property `name` in the file (incl. shorthand). */
function propertyValuesNamed(source: ts.SourceFile, name: string): ts.Expression[] {
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name) values.push(node.initializer);
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === name) values.push(node.name);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

/** Local function declarations by name (a local wrapper must return registry values). */
function localFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration | null {
  let found: ts.FunctionDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function returnsOf(fn: ts.FunctionDeclaration): ts.Expression[] {
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn, visit);
  return values;
}

/** True when `expression` provably yields a registry-resolved binary. */
function traces(source: ts.SourceFile, expression: ts.Expression, seen = new Set<string>()): boolean {
  const node = ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isNonNullExpression(expression) ? expression.expression : expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    // A fixed non-harness tool (git, systemctl, bwrap, …); a bare harness name
    // is always a violation (a PATH lookup of a second copy).
    // (also a hard-coded path to one: `/opt/codex`, `~/.kimi-code/bin/kimi`).
    return !HARNESS_COMMANDS.has(node.text) && !HARNESS_COMMANDS.has(path.basename(node.text));
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression);
    if (!name) return false;
    if (REGISTRY_CALLS.has(name) || Object.hasOwn(REGISTRY_WRAPPERS, name) || CODEX_IDENTITY_CALLS.has(name)) return true;
    const fn = localFunction(source, name);
    if (fn && !seen.has(`fn:${name}`)) {
      seen.add(`fn:${name}`);
      const values = returnsOf(fn);
      return values.length > 0 && values.every((value) => traces(source, value, seen));
    }
    return false;
  }
  if (ts.isConditionalExpression(node)) {
    return traces(source, node.whenTrue, seen) && traces(source, node.whenFalse, seen);
  }
  if (ts.isTemplateExpression(node)) {
    // A PTY command line: the leading token must be a registry value.
    const first = node.templateSpans[0];
    return node.head.text === '' && first !== undefined && traces(source, first.expression, seen);
  }
  if (ts.isObjectLiteralExpression(node)) {
    // SDK options (`new Codex({...})`): the executable comes from a spread of
    // codexLaunchOptions(...) or an explicit codexPathOverride that traces.
    return node.properties.some((property) => (
      (ts.isSpreadAssignment(property) && ts.isCallExpression(property.expression)
        && CODEX_OPTION_CALLS.has(calleeName(property.expression.expression) ?? ''))
      || (ts.isPropertyAssignment(property) && property.name.getText(source) === 'codexPathOverride'
        && traces(source, property.initializer, seen))
    ));
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const owner = node.expression.text;
    const prop = node.name.text;
    const values = assignmentsOf(source, owner);
    if (values.length > 0) {
      // `<x>.cmd` of a caged launch (checked at the cage's `cmd:` input) or
      // `<x>.codexPathOverride` of codexLaunchOptions(env, identity).
      return values.every((value) => ts.isCallExpression(value) && (
        ((prop === 'cmd' || prop === 'command') && CAGE_CALLS.has(calleeName(value.expression) ?? ''))
        || (prop === 'codexPathOverride' && CODEX_OPTION_CALLS.has(calleeName(value.expression) ?? ''))
      ));
    }
    // `<param>.binary`: every `binary` value handed around in this file traces.
    const key = `prop:${prop}`;
    if (seen.has(key)) return true;
    seen.add(key);
    const handed = propertyValuesNamed(source, prop);
    return handed.length > 0 && handed.every((value) => traces(source, value, seen));
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return true;
    seen.add(node.text);
    const values = assignmentsOf(source, node.text);
    return values.length > 0 && values.every((value) => traces(source, value, seen));
  }
  return false;
}

/** Every binary sink in a file: spawn/exec first args, SDK and cage `cmd` options. */
function sinksOf(source: ts.SourceFile): Array<{ expression: ts.Expression; line: number }> {
  const sinks: Array<{ expression: ts.Expression; line: number }> = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      // `.exec(` on a RegExp/cursor is not a process launch; only bare/imported
      // exec is (a namespace `child_process.exec` is covered by `spawn*` names).
      const regexExec = name === 'exec' && ts.isPropertyAccessExpression(node.expression);
      const isPty = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'pty' && name === 'spawn';
      if (name && !regexExec && (SPAWN_NAMES.has(name) || isPty) && node.arguments[0]) {
        sinks.push({ expression: node.arguments[0], line: lineOf(node) });
      }
      if (name && CAGE_CALLS.has(name) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        for (const property of node.arguments[0].properties) {
          if (ts.isPropertyAssignment(property) && property.name.getText(source) === 'cmd') {
            sinks.push({ expression: property.initializer, line: lineOf(property) });
          }
        }
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Codex'
      && node.arguments?.[0]) {
      sinks.push({ expression: node.arguments[0], line: lineOf(node) });
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'pathToClaudeCodeExecutable') {
      sinks.push({ expression: node.initializer, line: lineOf(node) });
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'pathToClaudeCodeExecutable') {
      sinks.push({ expression: node.right, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sinks;
}

/** The harness launch files: the committed permission inventory + every spawn-admission user. */
function harnessLaunchFiles(): string[] {
  const inventory = JSON.parse(fs.readFileSync(
    path.join(SERVER_ROOT, 'modules/execution-permissions/permission-launch-inventory.json'), 'utf8',
  )) as { entries: Array<{ file: string; classification: string; primitive: string }> };
  const harnessClasses = new Set([
    'provider_effect_enclosed', 'provider_effect_denied', 'capability_probe_effect', 'interactive_shell_effect',
  ]);
  const fromInventory = inventory.entries
    .filter((entry) => harnessClasses.has(entry.classification) && !entry.primitive.startsWith('provider_launcher.'))
    .map((entry) => path.join(REPO_ROOT, entry.file));
  const admissionUsers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/\b(?:beginHarnessLaunch|isSpawnBlockedForRunProvider|refuseSpawnIfHarnessUpdating|assertHarnessNotUpdating)\(/.test(text)
          && !full.includes(`${path.sep}harness-update${path.sep}spawn-admission`)) {
          admissionUsers.push(full);
        }
      }
    }
  };
  walk(SERVER_ROOT);
  return [...new Set([...fromInventory, ...admissionUsers])].filter((file) => fs.existsSync(file)).sort();
}

function allServerSources(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) files.push(full);
    }
  };
  walk(SERVER_ROOT);
  return files;
}

function launchViolations(files: readonly string[], allowlist: Readonly<Record<string, string>>): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const source = parse(file);
    const relative = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
    for (const sink of sinksOf(source)) {
      const text = sink.expression.getText(source);
      if (Object.hasOwn(allowlist, `${relative}#${text}`)) continue;
      if (!traces(source, sink.expression)) violations.push({ file: relative, line: sink.line, sink: text });
    }
  }
  return violations;
}

describe('(3) every harness launch site resolves through the registry', () => {
  const files = harnessLaunchFiles();

  test('the launch set is derived from the inventory and admission users', () => {
    const relative = files.map((file) => path.relative(SERVER_ROOT, file));
    for (const expected of [
      'claude-sdk.js', 'cursor-cli.js', 'qwen-cli.js', 'agy-cli.js', 'kimi-agent-cli.js',
      'opencode-cli.js', 'modules/turn-supervisor/cli-capability.ts',
      'modules/turn-supervisor/adapters/extended-cli-adapter.ts',
      'modules/workflow-supervisor/resume-turn-runner.ts', 'modules/workflow-supervisor/systemd.ts',
      'modules/websocket/services/shell-websocket.service.ts',
    ]) {
      assert.ok(relative.includes(expected), `${expected} must be in the checked launch set`);
    }
  });

  test('no sink outside the named allowlist bypasses the registry', () => {
    const extra = [
      path.join(SERVER_ROOT, 'modules/workflow-supervisor/task-runner.ts'),
      path.join(SERVER_ROOT, 'modules/providers/services/claude-usage.service.ts'),
      path.join(SERVER_ROOT, 'modules/execution-permissions/capability-registry.ts'),
    ];
    assert.deepEqual(launchViolations([...new Set([...files, ...extra])], SINK_ALLOWLIST), []);
  });

  test('every allowlist entry is still used (no stale exemptions)', () => {
    const used = new Set<string>();
    for (const file of [...files, path.join(SERVER_ROOT, 'modules/workflow-supervisor/task-runner.ts')]) {
      const source = parse(file);
      const relative = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
      for (const sink of sinksOf(source)) used.add(`${relative}#${sink.expression.getText(source)}`);
    }
    const stale = Object.keys(SINK_ALLOWLIST).filter((key) => !used.has(key));
    assert.deepEqual(stale, []);
  });

  test('no server file spawns a bare harness command name', () => {
    const offenders: string[] = [];
    for (const file of allServerSources()) {
      const source = parse(file);
      for (const sink of sinksOf(source)) {
        const value = sink.expression;
        if ((ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && HARNESS_COMMANDS.has(value.text)) {
          offenders.push(`${path.relative(SERVER_ROOT, file)}:${sink.line}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('codex launches and the registry share one machine-release resolver', () => {
    const codexSource = parse(path.join(SERVER_ROOT, 'shared/codex-executable.js'));
    const body = (name: string): string => {
      let text = '';
      const visit = (node: ts.Node): void => {
        if ((ts.isFunctionDeclaration(node) && node.name?.text === name)
          || (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)) {
          text = node.getText(codexSource);
        }
        ts.forEachChild(node, visit);
      };
      visit(codexSource);
      assert.ok(text, `${name} must exist in codex-executable.js`);
      return text;
    };
    assert.match(body('acquireCodexLaunchIdentity'), /resolveCodexMachineRuntime\(\)/);
    assert.match(body('resolveCodexMachineRuntime'), /codexMachineLauncherPath\(\)/);
    assert.match(body('codexLaunchOptions'), /codexPathOverride: identity\.executablePath/);
    assert.match(body('codexShellCommand'), /identity\.executablePath/);
    const registrySource = parse(path.join(SERVER_ROOT, 'shared/harness-binaries.ts'));
    const resolver = localFunction(registrySource, 'resolveCodexMachineLauncher')!.getText(registrySource);
    assert.match(resolver, /resolveCodexMachineRuntime\(\)/);
    assert.match(resolver, /return codexMachineLauncherPath\(\)/);
  });

  test('the cross-file wrappers really delegate to the registry', () => {
    for (const [name, file] of Object.entries(REGISTRY_WRAPPERS)) {
      const source = parse(path.join(SERVER_ROOT, file));
      const fn = localFunction(source, name);
      assert.ok(fn, `${name} must be defined in ${file}`);
      assert.match(fn!.getText(source), /\bresolveHarnessBinary\('(?:opencode|claude)'\)/, name);
    }
  });

  test('the guard catches `binary = provider` and aliased resolvers', () => {
    const fixture = path.join(scratch, 'fixture-launcher.ts');
    fs.writeFileSync(fixture, [
      "import { spawn } from 'node:child_process';",
      "import { resolveHarnessBinary } from './harness-binaries.js';",
      'export function a(provider: string) { const binary = provider; spawn(binary, []); }',
      "export function b() { spawn('qwen', []); }",
      "export function c() { const ok = resolveHarnessBinary('qwen'); spawn(ok, []); }",
      "export function d(env: NodeJS.ProcessEnv) { spawn(env.QWEN_PATH || 'qwen', []); }",
      'const alias = resolveCliExecutablePath;',
      "export function e() { spawn(alias('agy'), []); }",
      "export function f() { return { pathToClaudeCodeExecutable: resolveHarnessBinary('claude') }; }",
      "export function g() { spawn('codex', []); new Codex({ codexPathOverride: '/opt/codex' }); }",
      'export function h(identity: never) { const launch = codexLaunchOptions({}, identity); spawn(launch.codexPathOverride, []); }',
      '',
    ].join('\n'));
    const found = launchViolations([fixture], {}).map((v) => v.sink);
    assert.deepEqual(found, [
      'binary', "'qwen'", "env.QWEN_PATH || 'qwen'", "alias('agy')", "'codex'", "{ codexPathOverride: '/opt/codex' }",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (4) PTY commands
// ---------------------------------------------------------------------------

describe('(4) PTY command lines start with the quoted registry path', async () => {
  const shell = await import('../modules/websocket/services/shell-websocket.service.js');
  const build = (message: Record<string, unknown>, codexIdentity: unknown = null) => (
    shell.buildShellCommand(message as never, {} as never, codexIdentity as never)
  );
  const q = (id: string) => registry.quotedHarnessBinary(id);

  test('provider login commands', () => {
    const cases: Array<[string, string, string]> = [
      ['kimi', 'kimi login', 'kimi'],
      ['cursor', 'cursor-agent login', 'cursor'],
      ['opencode', 'opencode auth login', 'opencode'],
      ['agy', 'agy', 'antigravity'],
    ];
    for (const [provider, initialCommand, id] of cases) {
      const command = build({ provider, initialCommand });
      assert.ok(command.startsWith(`${q(id)}`), `${initialCommand} → ${command}`);
      assert.equal(command, [q(id), ...initialCommand.split(' ').slice(1)].join(' '));
    }
  });

  test('interactive and resume commands', () => {
    const cases: Array<[string, string]> = [
      ['cursor', 'cursor'], ['opencode', 'opencode'], ['kimi', 'kimi'], ['agy', 'antigravity'], ['antigravity', 'antigravity'],
    ];
    for (const [provider, id] of cases) {
      assert.equal(build({ provider }), q(id), provider);
      const resumed = build({ provider, hasSession: true, sessionId: 'abc-1' });
      assert.ok(resumed.startsWith(q(id)), resumed);
      assert.ok(!/(^|\|\| )(kimi|agy|cursor-agent|opencode)\b/.test(resumed), `bare fallback in: ${resumed}`);
    }
  });

  test('codex login commands run the frozen identity of the registry codex', async () => {
    const { acquireCodexLaunchIdentity, codexShellCommand } = await import('./codex-executable.js');
    const identity = acquireCodexLaunchIdentity();
    assert.equal(identity.executablePath, realpath(registry.resolveHarnessBinary('codex')));
    for (const [command, args] of [['codex login', ['login']], ['codex login --device-auth', ['login', '--device-auth']]] as const) {
      const line = shell.materializeProviderLoginCommand(command, identity);
      assert.equal(line, codexShellCommand(identity, [...args]));
      assert.ok(line.startsWith(registry.shellQuoteBinary(identity.executablePath)), line);
      assert.equal(build({ provider: 'codex', initialCommand: command }, identity), line);
    }
    assert.throws(() => shell.materializeProviderLoginCommand('codex login'), /IDENTITY_REQUIRED/);
    assert.equal(shell.isCodexLoginCommand(' codex login '), true);
    assert.equal(shell.isCodexLoginCommand('codex resume x'), false);
  });

  test('claude keeps the managed shim; free commands are untouched', () => {
    assert.equal(build({ provider: 'claude' }), 'claude');
    assert.equal(build({ provider: 'claude', initialCommand: 'claude auth login' }), 'claude auth login');
    assert.equal(build({ isPlainShell: true, initialCommand: 'ls -la' }), 'ls -la');
    assert.equal(shell.materializeProviderLoginCommand('kimi login; curl x'), 'kimi login; curl x');
  });

  test('a kimi PTY removes a stale native update stage before it runs (T-1873 qa HIGH)', () => {
    const staging = path.join(path.dirname(registry.resolveHarnessBinary('kimi')), '.staging');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'staged.json'), '{"manual":true}');
    assert.ok(build({ provider: 'kimi', hasSession: true, sessionId: 's-1' }).startsWith(q('kimi')));
    assert.equal(fs.existsSync(staging), false);
  });

  test('an unresolved harness fails with the publishable diagnostic prefix', () => {
    withHiddenFile(fakePath('.kimi-code', 'bin', 'kimi'), () => {
      assert.throws(() => build({ provider: 'kimi' }), (error: unknown) => (
        error instanceof Error && error.message.startsWith(shell.SHELL_HARNESS_CLI_MISSING_PREFIX)
      ));
    });
  });
});

// ---------------------------------------------------------------------------
// (5) + (6) behaviour: member env ignored, representative launchers
// ---------------------------------------------------------------------------

/**
 * The binary a launch finally execs: unwraps the cage's `bwrap … -- <cmd>` and
 * the POSIX `sh -c 'exec "$0" "$@"' <cmd>` exec-wrapper.
 */
function unwrapLaunch(cmd: string, args: readonly string[]): string {
  if (path.basename(cmd) === 'bwrap') {
    const separator = args.indexOf('--');
    assert.ok(separator >= 0 && args[separator + 1], 'a bwrap launch must carry `-- <cmd>`');
    return unwrapLaunch(args[separator + 1], args.slice(separator + 2));
  }
  if (cmd === 'sh' && args[0] === '-c' && args[1] === 'exec "$0" "$@"') return args[2];
  return cmd;
}

const MEMBER_ENV: NodeJS.ProcessEnv = Object.freeze({
  PATH: '/usr/bin:/bin',
  CLAUDE_CLI_PATH: '/evil/claude', KIMI_PATH: '/evil/kimi', QWEN_PATH: '/evil/qwen',
  AGY_PATH: '/evil/agy', CURSOR_PATH: '/evil/cursor-agent',
  OPENCODE_PATH: '/evil/opencode',
});

describe('(5)+(6) launchers spawn the registry binary; member *_PATH is ignored', () => {
  test('cli-capability probes (spawnSync) use the registry binary for a member env', async () => {
    const { installedMechanicalCliProbe } = await import('../modules/turn-supervisor/cli-capability.js');
    spawnCalls.length = 0;
    spawnSyncStdout = '0.21.12\n';
    installedMechanicalCliProbe('qwen', MEMBER_ENV);
    const commands = new Set(spawnCalls.map((call) => call.cmd));
    assert.ok(spawnCalls.length > 0);
    assert.deepEqual([...commands], [registry.resolveHarnessBinary('qwen')]);
  });

  test('resume-turn runner (spawn) runs the registry claude, whatever the turn env says', async () => {
    const { defaultRunResumeTurn } = await import('../modules/workflow-supervisor/resume-turn-runner.js');
    spawnCalls.length = 0;
    await defaultRunResumeTurn({
      userId: 1, conversationId: 'c1', projectPath: scratch, prompt: 'p', systemFraming: 's',
      model: null, disallowedTools: ['Task'], env: MEMBER_ENV, maxHoldMs: 0,
    });
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, registry.resolveHarnessBinary('claude'));

    // The supervisor's server-env override is honoured — and a bare one refused.
    const custom = writeExecutable(path.join(scratch, 'wf-bin', 'claude'));
    const turn = { userId: 1, conversationId: 'c1', projectPath: scratch, prompt: 'p', systemFraming: 's',
      model: null, disallowedTools: ['Task'], env: MEMBER_ENV, maxHoldMs: 0 };
    spawnCalls.length = 0;
    await withEnv({ WORKFLOW_SUPERVISOR_CLAUDE_BIN: custom }, () => defaultRunResumeTurn(turn));
    assert.equal(spawnCalls[0]?.cmd, custom);
    spawnCalls.length = 0;
    const refused = await withEnv({ WORKFLOW_SUPERVISOR_CLAUDE_BIN: 'claude' }, () => defaultRunResumeTurn(turn));
    assert.equal(refused.ok, false);
    assert.equal(spawnCalls.length, 0);
  });

  test('kimi agent launch (cage ON, bwrap unwrapped) runs the registry kimi, not the member KIMI_PATH', async () => {
    const { prepareKimiAgentLaunch } = await import('../kimi-agent-cli.js');
    const { resolveCagedLaunch } = await import('../services/isolation/provider-cage-wiring.js');
    const bwrap = writeExecutable(path.join(scratch, 'bin', 'bwrap'));
    withEnv({ NASSAJ_PROVIDER_CAGE: 'true' }, () => {
      const prepared = prepareKimiAgentLaunch(
        { userId: null, command: 'hi', model: 'kimi-k2.6', permissionMode: 'default', cwd: scratch, baseEnv: MEMBER_ENV },
        {
          resolveProviderEnv: (_u: unknown, _p: unknown, env: NodeJS.ProcessEnv) => ({ ...env }),
          verifyVendorBinaryDigest: (_id: string, file: string) => file,
          ensureVendorCliGovernance: (id: string, home: string) => ({ ok: true, vendorId: id, home, repaired: false }),
          isGovernanceExempt: () => false,
          resolveCagedLaunch: (spec: Parameters<typeof resolveCagedLaunch>[0]) => resolveCagedLaunch(spec, {
            resolveBwrapPath: () => bwrap,
            homedir: () => FAKE_HOME,
            existsSync: () => false,
          }),
        },
      );
      assert.equal(prepared.binaryPath, registry.resolveHarnessBinary('kimi'));
      assert.equal(path.basename(prepared.launch.cmd), 'bwrap', 'the cage must be on for this case');
      assert.equal(unwrapLaunch(prepared.launch.cmd, prepared.launch.args), registry.resolveHarnessBinary('kimi'));
    });
  });

  test('extended CLI adapter pins the registry binary at probe time', async () => {
    const { createExtendedCliAdapter } = await import('../modules/turn-supervisor/adapters/extended-cli-adapter.js');
    const seen: string[] = [];
    const adapter = createExtendedCliAdapter('qwen', {
      executableProbe: async (binary: string) => { seen.push(binary); return false; },
    });
    await adapter.probe({ userId: 1 } as never);
    assert.deepEqual(seen, [registry.resolveHarnessBinary('qwen')]);
    const missing = createExtendedCliAdapter('qwen', {
      executableProbe: async () => { throw new Error('must not probe an unresolved binary'); },
    });
    // probe() resolves synchronously before its first await, inside the hide window.
    const probed = withHiddenFile(fakePath('.local', 'bin', 'qwen'), () => missing.probe({ userId: 1 } as never));
    assert.equal(await probed, false);
  });
});
