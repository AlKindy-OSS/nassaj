import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

mock.module('@/services/isolation/resolve-claude-run-profile.js', {
  namedExports: { resolveClaudeRunProfileOrThrow: async () => ({ env: {}, effectiveEngine: null }) },
});
mock.module('@/modules/providers/index.js', {
  namedExports: { assertSessionAccessible: () => ({}) },
});

const launcher = await import('./managed-claude-launcher.js');
const terminalEnv = await import('./managed-claude-terminal-env.js');

function contractEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin',
    NASSAJ_MANAGED_CLAUDE_MODE: 'general',
    NASSAJ_MANAGED_CLAUDE_USER_ID: '7',
    NASSAJ_MANAGED_CLAUDE_REAL_BIN: '/bin/true',
    ...overrides,
  };
}

function fakeSpawn(calls: Array<{ bin: string; argv: string[]; options: Record<string, unknown> }>) {
  return ((bin: string, argv: string[], options: Record<string, unknown>) => {
    calls.push({ bin, argv, options });
    const child = new EventEmitter() as EventEmitter & { kill: () => boolean };
    child.kill = () => true;
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  }) as never;
}

test('resume parser rejects implicit continue and malformed/multiple resume targets', () => {
  assert.deepEqual(launcher.parseClaudeResumeArgv(['-c']), {
    ok: false,
    error: '--continue cannot be resolved to a server-pinned session',
  });
  assert.equal(launcher.parseClaudeResumeArgv(['--continue']).ok, false);
  assert.equal(launcher.parseClaudeResumeArgv(['--resume']).ok, false);
  assert.equal(launcher.parseClaudeResumeArgv(['-r', 'one', '--resume=two']).ok, false);
  assert.deepEqual(launcher.parseClaudeResumeArgv(['--resume=sess-1']), { ok: true, sessionId: 'sess-1' });
  assert.deepEqual(launcher.parseClaudeResumeArgv(['-rsess-2']), { ok: true, sessionId: 'sess-2' });
  assert.deepEqual(launcher.parseClaudeResumeArgv(['--', '-rprompt-data']), { ok: true, sessionId: null });
});

test('PATH shim is first and remembers a real binary that is not itself', () => {
  const installed = terminalEnv.installManagedClaudeTerminalEnv(
    { PATH: '/bin:/usr/bin', CLAUDE_CLI_PATH: '/bin/true' },
    { userId: 7, mode: 'general' },
  );
  assert.equal(installed.PATH?.split(path.delimiter)[0], terminalEnv.MANAGED_CLAUDE_BIN_DIR);
  assert.equal(installed.NASSAJ_MANAGED_CLAUDE_REAL_BIN, '/bin/true');
  assert.notEqual(installed.NASSAJ_MANAGED_CLAUDE_REAL_BIN, terminalEnv.MANAGED_CLAUDE_WRAPPER);
});

test('launcher asset resolves in both source and compiled module layouts', () => {
  const expected = '/app/server/bin/claude';
  const exists = (candidate: fs.PathLike) => String(candidate) === expected;
  assert.equal(
    terminalEnv.resolveManagedClaudeWrapperPath(
      pathToFileURL('/app/server/services/isolation/module.js').href,
      exists,
    ),
    expected,
  );
  assert.equal(
    terminalEnv.resolveManagedClaudeWrapperPath(
      pathToFileURL('/app/dist-server/server/services/isolation/module.js').href,
      exists,
    ),
    expected,
  );
});

test('server/bin/claude executes the source launcher and fails closed without a canonical principal', (context) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b456-wrapper-'));
  try {
    const result = spawnSync(path.join(process.cwd(), 'server/bin/claude'), ['--help'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        HOME: configDir,
        CLAUDE_CONFIG_DIR: configDir,
        NASSAJ_MANAGED_CLAUDE_MODE: 'general',
        NASSAJ_MANAGED_CLAUDE_USER_ID: '7',
        NASSAJ_MANAGED_CLAUDE_REAL_BIN: '/bin/true',
      },
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.stderr.includes('listen EPERM') && result.stderr.includes('tsx-')) {
      context.skip('sandbox forbids the nested tsx IPC listener');
      return;
    }
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /RUNTIME_EFFECT_AUTHENTICATED_PRINCIPAL_REQUIRED/);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('general resume authorizes before profile and spawns fake binary with pinned env', async () => {
  const order: string[] = [];
  const calls: Array<{ bin: string; argv: string[]; options: Record<string, unknown> }> = [];
  const code = await launcher.runManagedClaudeLauncher(
    ['--resume', 'sess-1'],
    contractEnv({
      ANTHROPIC_BASE_URL: 'https://stale.example',
      PATH: `${terminalEnv.MANAGED_CLAUDE_BIN_DIR}${path.delimiter}/usr/bin`,
    }),
    {
      permissionExecution: null,
      authorizeSession: (sessionId, userId, mode) => {
        order.push(`auth:${sessionId}:${userId}:${mode}`);
        return {} as never;
      },
      resolveProfile: async (input) => {
        order.push(`profile:${input.sessionId}`);
        return {
          env: { ...input.baseEnv, ANTHROPIC_BASE_URL: 'https://glm.example' },
          effectiveEngine: 'glm',
          engineHosts: new Set(['glm.example']),
          pin: {},
        } as never;
      },
      spawnImpl: fakeSpawn(calls),
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(order, ['auth:sess-1:7:write', 'profile:sess-1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.bin, '/bin/true');
  assert.deepEqual(calls[0]!.argv, ['--resume', 'sess-1']);
  assert.equal((calls[0]!.options.env as NodeJS.ProcessEnv).ANTHROPIC_BASE_URL, 'https://glm.example');
  assert.equal((calls[0]!.options.env as NodeJS.ProcessEnv).NASSAJ_MANAGED_CLAUDE_MODE, undefined);
  assert.ok(
    !(calls[0]!.options.env as NodeJS.ProcessEnv).PATH?.split(path.delimiter)
      .includes(terminalEnv.MANAGED_CLAUDE_BIN_DIR),
    'the real child cannot recursively resolve the wrapper from PATH',
  );
});

test('general terminal without resume uses the official/default profile and no session authorization', async () => {
  const calls: Array<{ bin: string; argv: string[]; options: Record<string, unknown> }> = [];
  let authorized = false;
  let profileInput: Record<string, unknown> | null = null;
  await launcher.runManagedClaudeLauncher(['--help'], contractEnv(), {
    permissionExecution: null,
    authorizeSession: () => { authorized = true; return {} as never; },
    resolveProfile: async (input) => {
      profileInput = input as unknown as Record<string, unknown>;
      return { env: input.baseEnv, effectiveEngine: null } as never;
    },
    spawnImpl: fakeSpawn(calls),
  });
  assert.equal(authorized, false);
  assert.equal(profileInput?.sessionId, null);
  assert.equal(profileInput?.requireKnownResumePin, false);
  assert.deepEqual(calls[0]!.argv, ['--help']);
});

test('session-bound bare Claude is forced onto its bound id; cross-session is refused', async () => {
  const calls: Array<{ bin: string; argv: string[]; options: Record<string, unknown> }> = [];
  const env = contractEnv({
    NASSAJ_MANAGED_CLAUDE_MODE: 'session-bound',
    NASSAJ_MANAGED_CLAUDE_SESSION_ID: 'bound-1',
  });
  await launcher.runManagedClaudeLauncher([], env, {
    permissionExecution: null,
    authorizeSession: () => ({} as never),
    resolveProfile: async (input) => ({ env: input.baseEnv, effectiveEngine: 'glm' } as never),
    spawnImpl: fakeSpawn(calls),
  });
  assert.deepEqual(calls[0]!.argv, ['--resume', 'bound-1']);

  let spawned = false;
  await assert.rejects(
    launcher.runManagedClaudeLauncher(['-r', 'foreign-2'], env, {
      permissionExecution: null,
      authorizeSession: () => ({} as never),
      resolveProfile: async () => ({ env: {}, effectiveEngine: null } as never),
      spawnImpl: (() => { spawned = true; }) as never,
    }),
    /cannot resume a different/,
  );
  assert.equal(spawned, false);
});

test('session-bound injects resume before delimiter and refuses session escape flags before spawn', async () => {
  const calls: Array<{ bin: string; argv: string[]; options: Record<string, unknown> }> = [];
  const env = contractEnv({
    NASSAJ_MANAGED_CLAUDE_MODE: 'session-bound',
    NASSAJ_MANAGED_CLAUDE_SESSION_ID: 'bound-1',
  });
  const deps = {
    permissionExecution: null,
    authorizeSession: () => ({} as never),
    resolveProfile: async (input: Record<string, unknown>) => ({
      env: input.baseEnv,
      effectiveEngine: 'glm',
    } as never),
    spawnImpl: fakeSpawn(calls),
  };
  await launcher.runManagedClaudeLauncher(['--', '-rprompt-data'], env, deps as never);
  assert.deepEqual(calls[0]!.argv, ['--resume', 'bound-1', '--', '-rprompt-data']);

  for (const argv of [
    ['--fork-session'],
    ['--fork-session=true'],
    ['--session-id', 'other'],
    ['--session-id=other'],
    ['-rbound-1', '--resume', 'bound-1'],
  ]) {
    await assert.rejects(
      launcher.runManagedClaudeLauncher(argv, env, {
        ...deps,
        spawnImpl: (() => { throw new Error('must not spawn'); }) as never,
      } as never),
    );
  }
  assert.equal(calls.length, 1);
});

test('foreign session, unknown pin, and ambiguous pin all fail before child spawn', async () => {
  let spawned = 0;
  const spawnImpl = (() => { spawned += 1; }) as never;
  await assert.rejects(
    launcher.runManagedClaudeLauncher(['-r', 'foreign'], contractEnv(), {
      permissionExecution: null,
      authorizeSession: () => { throw Object.assign(new Error('Not found'), { statusCode: 404 }); },
      resolveProfile: async () => { throw new Error('must not run'); },
      spawnImpl,
    }),
    /Not found/,
  );
  for (const code of ['ENGINE_PIN_UNKNOWN', 'ENGINE_PIN_AMBIGUOUS']) {
    await assert.rejects(
      launcher.runManagedClaudeLauncher(['-r', 'mine'], contractEnv(), {
        permissionExecution: null,
        authorizeSession: () => ({} as never),
        resolveProfile: async () => { throw Object.assign(new Error(code), { code }); },
        spawnImpl,
      }),
      (error: Error & { code?: string }) => error.code === code,
    );
  }
  assert.equal(spawned, 0);
});
