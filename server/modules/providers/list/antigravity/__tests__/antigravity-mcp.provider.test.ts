import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';
import { promisify } from 'node:util';

let root = '';
let AntigravityMcpProvider:
  typeof import('../antigravity-mcp.provider.js').AntigravityMcpProvider;
const execFile = promisify(execFileCallback);

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'agy-mcp-contract-'));
  mock.module('@/services/isolation/resolve-provider-env.js', {
    namedExports: {
      resolveProviderEnv: (userId: string | number | null, _provider: string, env: NodeJS.ProcessEnv) => ({
        ...env,
        HOME: path.join(root, String(userId ?? 'operator')),
      }),
    },
  });
  ({ AntigravityMcpProvider } = await import('../antigravity-mcp.provider.js'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('agy writer emits the native mcp_config.json schema in the caller HOME', async () => {
  const provider = new AntigravityMcpProvider();
  await provider.upsertServer({
    name: 'stdio-canary',
    scope: 'user',
    transport: 'stdio',
    command: 'false',
    args: ['one'],
    env: { CANARY: 'value' },
    userId: 'user-a',
  });
  await provider.upsertServer({
    name: 'http-canary',
    scope: 'user',
    transport: 'http',
    url: 'https://example.test/mcp',
    headers: { 'X-Canary': 'value' },
    userId: 'user-a',
  });

  const configPath = path.join(root, 'user-a', '.gemini', 'config', 'mcp_config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  const servers = config.mcpServers as Record<string, Record<string, unknown>>;
  assert.equal(servers['stdio-canary']?.command, 'false');
  assert.equal(servers['http-canary']?.serverUrl, 'https://example.test/mcp');
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.deepEqual(await provider.listServersForScope('user', { userId: 'user-b' }), []);
});

test('agy project MCP is refused because the real reader has no project contract', async () => {
  const provider = new AntigravityMcpProvider();
  await assert.rejects(
    provider.upsertServer({
      name: 'project-canary',
      scope: 'project',
      transport: 'stdio',
      command: 'false',
      workspacePath: path.join(root, 'workspace'),
      userId: 'user-a',
    }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'MCP_SCOPE_NOT_SUPPORTED'
    ),
  );
});

test('real agy reader discovers the per-user native writer output', async (t) => {
  try {
    await execFile('agy', ['--version']);
  } catch {
    t.skip('agy binary is not installed');
    return;
  }

  const provider = new AntigravityMcpProvider();
  const userId = 'real-reader-user';
  await provider.upsertServer({
    name: 'reader_canary',
    scope: 'user',
    transport: 'stdio',
    command: 'false',
    userId,
  });

  const { stdout } = await execFile('agy', ['mcp', 'list'], {
    env: { ...process.env, HOME: path.join(root, userId) },
  });
  assert.match(stdout, /reader_canary\s+stdio\s+enabled/);
});
