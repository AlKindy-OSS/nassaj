import assert from 'node:assert/strict';
import type fs from 'node:fs';
import test from 'node:test';

import {
  resolveRealClaudeBinary,
  wellKnownClaudeInstallCandidates as linkPathCandidates,
} from '@/services/isolation/managed-claude-terminal-env.js';
import {
  isRunnableClaudeExecutable,
  resolveClaudeCodeExecutablePath,
  wellKnownClaudeInstallCandidates,
  type ExecutableProbeDependencies,
  type ResolveClaudeCodeExecutablePathDependencies,
} from '@/shared/claude-cli-path.js';

const POSIX_SYSTEM_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/games'].join(':');

/**
 * A filesystem seam classifying each absolute path as a runnable executable, an
 * existing-but-non-executable file (chmod 000), or a directory. Shared by the
 * detection and link-path tests so both exercise the SAME acceptance criterion.
 */
function fsSeam(spec: {
  runnable?: string[];
  notExecutable?: string[];
  directories?: string[];
}): Required<ExecutableProbeDependencies> {
  const runnable = new Set(spec.runnable ?? []);
  const notExecutable = new Set(spec.notExecutable ?? []);
  const directories = new Set(spec.directories ?? []);
  const exists = (p: string) => runnable.has(p) || notExecutable.has(p) || directories.has(p);
  return {
    existsSync: ((p: fs.PathLike) => exists(String(p))) as typeof fs.existsSync,
    statSync: ((p: fs.PathLike) => {
      const s = String(p);
      if (!exists(s)) {
        throw Object.assign(new Error(`ENOENT: ${s}`), { code: 'ENOENT' });
      }
      return { isFile: () => !directories.has(s) } as fs.Stats;
    }) as typeof fs.statSync,
    accessSync: ((p: fs.PathLike) => {
      if (notExecutable.has(String(p))) {
        throw Object.assign(new Error(`EACCES: ${String(p)}`), { code: 'EACCES' });
      }
    }) as typeof fs.accessSync,
  };
}

test('resolveClaudeCodeExecutablePath resolves the npm Claude wrapper to its native exe on Windows', () => {
  const wrapperDir = 'C:\\nvm4w\\nodejs';
  const nativePath = `${wrapperDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const execFileSync =
    (() => `${wrapperDir}\\claude\r\n${wrapperDir}\\claude.cmd\r\n`) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];
  const readFileSync = (() => '') as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath keeps an explicit JavaScript launcher path unchanged', () => {
  const scriptPath = 'C:\\tools\\claude.js';

  const resolved = resolveClaudeCodeExecutablePath(scriptPath, {
    platform: 'win32',
  });

  assert.equal(resolved, scriptPath);
});

test('resolveClaudeCodeExecutablePath can parse a wrapper file path containing letters r and n before claude.exe', () => {
  const wrapperPath = 'C:\\tools\\claude';
  const nativePath = 'C:\\tools\\custom\\bin\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const readFileSync = (() => `exec "$basedir/custom/bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"`) as unknown as ResolveClaudeCodeExecutablePathDependencies['readFileSync'];

  const resolved = resolveClaudeCodeExecutablePath(wrapperPath, {
    platform: 'win32',
    existsSync: (candidate) => candidate === nativePath,
    readFileSync,
  });

  assert.equal(resolved, nativePath);
});

test('resolveClaudeCodeExecutablePath falls back to the configured command when PATH lookup fails', () => {
  const execFileSync = (() => {
    throw new Error('not found');
  }) as unknown as ResolveClaudeCodeExecutablePathDependencies['execFileSync'];

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'win32',
    execFileSync,
  });

  assert.equal(resolved, 'claude');
});

test('B-1091: a bare command absent from the process PATH resolves to ~/.local/bin/claude', () => {
  const localBin = '/home/op/.local/bin/claude';

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'linux',
    env: { PATH: POSIX_SYSTEM_PATH },
    homedir: () => '/home/op',
    // Reproduces the pm2/systemd node: nothing named `claude` is on the minimal
    // PATH, but the native installer left one in ~/.local/bin.
    ...fsSeam({ runnable: [localBin] }),
  });

  assert.equal(resolved, localBin);
});

test('B-1091: ~/.local/bin wins over /usr/local/bin when both are runnable', () => {
  const localBin = '/home/op/.local/bin/claude';
  const systemBin = '/usr/local/bin/claude';

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'linux',
    // PATH deliberately excludes both dirs so the well-known ORDER decides.
    env: { PATH: '/usr/bin:/bin' },
    homedir: () => '/home/op',
    ...fsSeam({ runnable: [localBin, systemBin] }),
  });

  assert.equal(resolved, localBin);
});

test('B-1091: a chmod-000 ~/.local/bin/claude is skipped for a runnable /usr/local/bin', () => {
  const localBin = '/home/op/.local/bin/claude';
  const systemBin = '/usr/local/bin/claude';

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    homedir: () => '/home/op',
    // The exact split-verdict the reviewer flagged: exists but not executable.
    ...fsSeam({ notExecutable: [localBin], runnable: [systemBin] }),
  });

  assert.equal(resolved, systemBin);
});

test('B-1091: an empty HOME limits the fallback to the system-wide dir', () => {
  const systemBin = '/usr/local/bin/claude';

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    homedir: () => '',
    ...fsSeam({ runnable: [systemBin, '/home/op/.local/bin/claude'] }),
  });

  assert.equal(resolved, systemBin);
});

test('B-1091: an explicit CLAUDE_CLI_PATH takes precedence over the well-known dirs', () => {
  const explicit = '/opt/custom/claude';

  const resolved = resolveClaudeCodeExecutablePath(explicit, {
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    homedir: () => '/home/op',
    // Even though everything "exists", the explicit path is honored verbatim.
    ...fsSeam({ runnable: [explicit, '/home/op/.local/bin/claude'] }),
  });

  assert.equal(resolved, explicit);
});

test('B-1091: a bare command found nowhere is returned unchanged', () => {
  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    homedir: () => '/home/op',
    ...fsSeam({}),
  });

  assert.equal(resolved, 'claude');
});

test('B-1091: the first PATH dir with a runnable claude wins', () => {
  const first = '/usr/local/bin/claude';
  const second = '/usr/bin/claude';

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'linux',
    env: { PATH: POSIX_SYSTEM_PATH },
    homedir: () => {
      throw new Error('homedir must not be consulted once PATH resolves the command');
    },
    // Both PATH dirs hold a runnable claude; the earlier entry must win.
    ...fsSeam({ runnable: [first, second] }),
  });

  assert.equal(resolved, first);
});

test('B-1091: a directory named claude on PATH is not accepted as the executable', () => {
  const pathDir = '/usr/local/bin/claude';
  const localBin = '/home/op/.local/bin/claude';

  const resolved = resolveClaudeCodeExecutablePath('claude', {
    platform: 'linux',
    env: { PATH: POSIX_SYSTEM_PATH },
    homedir: () => '/home/op',
    ...fsSeam({ directories: [pathDir], runnable: [localBin] }),
  });

  assert.equal(resolved, localBin);
});

test('B-1091: win32 resolution is unchanged by the posix well-known fallback', () => {
  const scriptPath = 'C:\\tools\\claude.js';

  const resolved = resolveClaudeCodeExecutablePath(scriptPath, {
    platform: 'win32',
    // A homedir that would throw proves the posix fallback branch is never taken.
    homedir: () => {
      throw new Error('win32 must not enter the posix well-known fallback');
    },
    existsSync: () => false,
  });

  assert.equal(resolved, scriptPath);
});

test('B-1091 parity: detection and the login path resolve identically over one filesystem', () => {
  // Not a deepEqual on a literal delegation: run BOTH resolvers against the same
  // seam where ~/.local/bin/claude exists but is NOT executable and
  // /usr/local/bin/claude is. A shared acceptance criterion must make both skip
  // the first and pick the second.
  const home = '/home/op';
  const localBin = `${home}/.local/bin/claude`;
  const systemBin = '/usr/local/bin/claude';
  const seam = fsSeam({ notExecutable: [localBin], runnable: [systemBin] });

  const detection = resolveClaudeCodeExecutablePath('claude', {
    platform: 'linux',
    env: { PATH: '/usr/bin:/bin' },
    homedir: () => home,
    ...seam,
  });
  const linkPath = resolveRealClaudeBinary(
    { HOME: home, PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
    'claude',
    seam,
  );

  assert.equal(detection, systemBin);
  assert.equal(linkPath, systemBin);
  assert.equal(detection, linkPath);
});

test('B-1091 parity: the shared predicate rejects a non-file and a non-executable alike', () => {
  const seam = fsSeam({
    runnable: ['/bin/claude'],
    notExecutable: ['/opt/claude'],
    directories: ['/srv/claude'],
  });
  assert.equal(isRunnableClaudeExecutable('/bin/claude', seam), true);
  assert.equal(isRunnableClaudeExecutable('/opt/claude', seam), false);
  assert.equal(isRunnableClaudeExecutable('/srv/claude', seam), false);
  assert.equal(isRunnableClaudeExecutable('/nope/claude', seam), false);
});

test('B-1091: detection and the login path share one candidate list', () => {
  const detection = wellKnownClaudeInstallCandidates('/home/op', 'claude');
  const linkList = linkPathCandidates({ HOME: '/home/op' } as NodeJS.ProcessEnv, 'claude');
  assert.deepEqual(linkList, detection);
  assert.ok(detection.includes('/home/op/.local/bin/claude'));
});
