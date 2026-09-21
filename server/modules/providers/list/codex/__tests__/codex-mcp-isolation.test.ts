import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { after, before, mock } from 'node:test';

import TOML from '@iarna/toml';

let root = '';
let CodexMcpProvider: typeof import('../codex-mcp.provider.js').CodexMcpProvider;
const execFile = promisify(execFileCallback);

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'codex-mcp-isolation-'));
  mock.module('@/services/isolation/resolve-provider-env.js', {
    namedExports: {
      resolveProviderEnv: (userId: string | number | null, _provider: string, env: NodeJS.ProcessEnv) => ({
        ...env,
        CODEX_HOME: path.join(root, String(userId ?? 'operator'), '.codex'),
      }),
    },
  });
  ({ CodexMcpProvider } = await import('../codex-mcp.provider.js'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('user-scoped Codex MCP configuration is isolated by authenticated user', async () => {
  const provider = new CodexMcpProvider();
  await provider.upsertServer({
    name: 'private-a',
    scope: 'user',
    transport: 'stdio',
    command: 'example-mcp',
    userId: 'user-a',
  });

  const userA = await provider.listServersForScope('user', { userId: 'user-a' });
  const userB = await provider.listServersForScope('user', { userId: 'user-b' });

  assert.deepEqual(userA.map((server) => server.name), ['private-a']);
  assert.deepEqual(userB, []);
});

test('Codex MCP upserts serialize the whole RMW transaction and preserve all 20 entries', async () => {
  const provider = new CodexMcpProvider();
  const userId = 'concurrent-user';

  await Promise.all(Array.from({ length: 20 }, (_, index) => provider.upsertServer({
    name: `server-${index}`,
    scope: 'user',
    transport: 'stdio',
    command: 'node',
    args: [`server-${index}.js`],
    userId,
  })));

  const servers = await provider.listServersForScope('user', { userId });
  assert.deepEqual(
    servers.map((server) => server.name).sort(),
    Array.from({ length: 20 }, (_, index) => `server-${index}`).sort(),
  );
});

test('Codex MCP mixed removes and upserts do not resurrect or drop entries', async () => {
  const provider = new CodexMcpProvider();
  const userId = 'mixed-concurrent-user';
  await Promise.all(Array.from({ length: 20 }, (_, index) => provider.upsertServer({
    name: `original-${index}`,
    scope: 'user',
    transport: 'stdio',
    command: 'node',
    userId,
  })));

  await Promise.all([
    ...Array.from({ length: 10 }, (_, index) => provider.removeServer({
      name: `original-${index}`,
      scope: 'user',
      userId,
    })),
    ...Array.from({ length: 10 }, (_, index) => provider.upsertServer({
      name: `added-${index}`,
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      userId,
    })),
  ]);

  const names = (await provider.listServersForScope('user', { userId }))
    .map((server) => server.name)
    .sort();
  assert.deepEqual(names, [
    ...Array.from({ length: 10 }, (_, index) => `added-${index}`),
    ...Array.from({ length: 10 }, (_, index) => `original-${index + 10}`),
  ].sort());
});

test('Codex MCP atomic replacement preserves unrelated TOML and enforces 0600', async () => {
  const provider = new CodexMcpProvider();
  const userId = 'mode-user';
  const codexDir = path.join(root, userId, '.codex');
  const configPath = path.join(codexDir, 'config.toml');
  await mkdir(codexDir, { recursive: true });
  await writeFile(configPath, 'model = "keep-me"\n', 'utf8');
  await chmod(configPath, 0o644);

  await provider.upsertServer({
    name: 'private-server',
    scope: 'user',
    transport: 'http',
    url: 'https://example.test/mcp',
    userId,
  });

  const parsed = TOML.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(parsed.model, 'keep-me');
  assert.ok((parsed.mcp_servers as Record<string, unknown>)['private-server']);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(codexDir)).mode & 0o777, 0o700);
});

test('Codex MCP creates a new private config directory with mode 0700', async () => {
  const provider = new CodexMcpProvider();
  const userId = 'new-directory-user';
  const codexDir = path.join(root, userId, '.codex');

  await provider.upsertServer({
    name: 'private-server',
    scope: 'user',
    transport: 'stdio',
    command: 'node',
    userId,
  });

  assert.equal((await stat(codexDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(codexDir, 'config.toml'))).mode & 0o777, 0o600);
});

test('Codex MCP refuses a symlinked config directory without chmodding its target', async () => {
  const provider = new CodexMcpProvider();
  const userId = 'symlink-directory-user';
  const userRoot = path.join(root, userId);
  const externalDir = path.join(root, 'external-config-target');
  await mkdir(userRoot, { recursive: true });
  await mkdir(externalDir, { mode: 0o755 });
  await chmod(externalDir, 0o755);
  await symlink(externalDir, path.join(userRoot, '.codex'));

  await assert.rejects(
    provider.upsertServer({
      name: 'must-not-write',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      userId,
    }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'MCP_CONFIG_UNSAFE_DIRECTORY'
    ),
  );
  assert.equal((await stat(externalDir)).mode & 0o777, 0o755);
});

test('Codex MCP rejects project scope because the real CLI does not read workspace .codex config', async () => {
  const provider = new CodexMcpProvider();
  const workspacePath = path.join(root, 'project-scope-refusal');

  await assert.rejects(
    provider.upsertServer({
      name: 'unread-project-server',
      scope: 'project',
      transport: 'stdio',
      command: 'node',
      workspacePath,
      userId: 'project-user',
    }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'MCP_SCOPE_NOT_SUPPORTED'
    ),
  );

  assert.deepEqual(
    await provider.listServersForScope('project', { workspacePath, userId: 'project-user' }),
    [],
  );
});

test('real Codex reader sees user scope and ignores workspace .codex config', async (t) => {
  try {
    await execFile('codex', ['--version']);
  } catch {
    t.skip('codex binary is not installed');
    return;
  }

  const provider = new CodexMcpProvider();
  const userId = 'real-reader-user';
  const workspacePath = path.join(root, 'real-reader-workspace');
  await mkdir(path.join(workspacePath, '.codex'), { recursive: true });
  await writeFile(
    path.join(workspacePath, '.codex', 'config.toml'),
    '[mcp_servers.project_canary]\ncommand = "false"\n',
    { mode: 0o600 },
  );
  await provider.upsertServer({
    name: 'user_canary',
    scope: 'user',
    transport: 'stdio',
    command: 'false',
    userId,
  });

  const codexHome = path.join(root, userId, '.codex');
  const { stdout } = await execFile('codex', ['mcp', 'list', '--json'], {
    cwd: workspacePath,
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  const listed = JSON.parse(stdout) as Array<{ name: string }>;
  assert.deepEqual(listed.map(({ name }) => name), ['user_canary']);
});
