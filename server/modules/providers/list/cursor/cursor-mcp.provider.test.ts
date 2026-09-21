import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';
import { promisify } from 'node:util';

let root = '';
let CursorMcpProvider: typeof import('./cursor-mcp.provider.js').CursorMcpProvider;
const execFile = promisify(execFileCallback);

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cursor-mcp-contract-'));
  mock.module('@/services/isolation/resolve-provider-env.js', {
    namedExports: {
      resolveProviderEnv: (userId: string | number | null, _provider: string, env: NodeJS.ProcessEnv) => ({
        ...env,
        HOME: path.join(root, String(userId ?? 'operator')),
      }),
    },
  });
  ({ CursorMcpProvider } = await import('./cursor-mcp.provider.js'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('Cursor user MCP writer uses the same per-user HOME as cursor-agent', async () => {
  const provider = new CursorMcpProvider();
  await provider.upsertServer({
    name: 'private-a',
    scope: 'user',
    transport: 'stdio',
    command: 'node',
    userId: 'user-a',
  });

  assert.deepEqual(
    (await provider.listServersForScope('user', { userId: 'user-a' })).map(({ name }) => name),
    ['private-a'],
  );
  assert.deepEqual(await provider.listServersForScope('user', { userId: 'user-b' }), []);

  const configPath = path.join(root, 'user-a', '.cursor', 'mcp.json');
  assert.match(await readFile(configPath, 'utf8'), /private-a/);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
});

test('Cursor project MCP stays workspace-scoped and does not touch user HOME', async () => {
  const provider = new CursorMcpProvider();
  const workspacePath = path.join(root, 'workspace');
  await provider.upsertServer({
    name: 'project-a',
    scope: 'project',
    transport: 'http',
    url: 'https://example.test/mcp',
    workspacePath,
    userId: 'user-a',
  });

  assert.deepEqual(
    (await provider.listServersForScope('project', { workspacePath, userId: 'user-b' }))
      .map(({ name }) => name),
    ['project-a'],
  );
  assert.match(await readFile(path.join(workspacePath, '.cursor', 'mcp.json'), 'utf8'), /project-a/);
});

test('real cursor-agent reader discovers both user and project writer outputs', async (t) => {
  try {
    await execFile('cursor-agent', ['--version']);
  } catch {
    t.skip('cursor-agent binary is not installed');
    return;
  }

  const provider = new CursorMcpProvider();
  const userId = 'real-reader-user';
  const workspacePath = path.join(root, 'real-reader-workspace');
  await provider.upsertServer({
    name: 'user_canary',
    scope: 'user',
    transport: 'stdio',
    command: 'false',
    userId,
  });
  await provider.upsertServer({
    name: 'project_canary',
    scope: 'project',
    transport: 'stdio',
    command: 'false',
    workspacePath,
    userId,
  });

  const { stdout } = await execFile('cursor-agent', ['mcp', 'list'], {
    cwd: workspacePath,
    env: { ...process.env, HOME: path.join(root, userId) },
  });
  assert.match(stdout, /user_canary:/);
  assert.match(stdout, /project_canary:/);
});
