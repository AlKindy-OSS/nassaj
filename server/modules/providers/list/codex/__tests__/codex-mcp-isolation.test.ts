import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';

let root = '';
let CodexMcpProvider: typeof import('../codex-mcp.provider.js').CodexMcpProvider;

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
