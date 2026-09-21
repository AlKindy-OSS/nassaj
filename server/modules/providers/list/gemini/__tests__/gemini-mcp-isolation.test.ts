/**
 * B-740: the installed `gemini` runtime is agy and does not read Google's
 * `.gemini/settings.json`. The generic adapter is therefore dormant. A private,
 * user-only adapter remains solely to remove residue written by older releases.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { AppError } from '@/shared/utils.js';

let root = '';
let GeminiMcpProvider: typeof import('../gemini-mcp.provider.js').GeminiMcpProvider;

const originalHomedir = os.homedir;
const settingsPath = (userId: string | number): string =>
  path.join(root, '.nassaj-users', String(userId), '.gemini', 'settings.json');

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'gemini-mcp-isolation-'));
  (os as unknown as { homedir: () => string }).homedir = () => root;
  ({ GeminiMcpProvider } = await import('../gemini-mcp.provider.js'));
});

after(async () => {
  (os as unknown as { homedir: () => string }).homedir = originalHomedir;
  await rm(root, { recursive: true, force: true });
});

test('generic Gemini MCP is dormant and always rejects with its stable 403 code', async () => {
  const provider = new GeminiMcpProvider();
  assert.equal(provider.supportsMcp, false);
  assert.equal(provider.writesPerUserConfig, false);
  const isStableRefusal = (error: unknown) => error instanceof AppError
    && error.code === 'GEMINI_GENERIC_MCP_DISABLED'
    && error.statusCode === 403;
  await assert.rejects(provider.listServersForScope('user', { userId: 'user-a' }), isStableRefusal);
  await assert.rejects(provider.upsertServer({
    name: 'private-a', scope: 'user', transport: 'stdio', command: 'example-mcp', userId: 'user-a',
  }), isStableRefusal);
  await assert.rejects(provider.removeServer({ name: 'private-a', scope: 'user', userId: 'user-a' }), isStableRefusal);
});

test('cleanupOnly removes historical user residue and preserves unrelated settings', async () => {
  const provider = new GeminiMcpProvider({ cleanupOnly: true });
  const userId = 'user-keys';
  const filePath = settingsPath(userId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    theme: 'GitHub',
    selectedAuthType: 'oauth-personal',
    mcpServers: {
      remove: { command: 'old' },
      keep: { command: 'still-here' },
    },
  }), { mode: 0o640 });

  assert.equal((await provider.removeServer({ name: 'remove', scope: 'user', userId })).removed, true);
  assert.deepEqual((await provider.listServersForScope('user', { userId })).map(({ name }) => name), ['keep']);
  assert.deepEqual(await provider.listServersForScope('project', { userId }), []);
  const after = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  assert.equal(after.theme, 'GitHub');
  assert.equal(after.selectedAuthType, 'oauth-personal');
  assert.equal((after.mcpServers as Record<string, unknown>).remove, undefined);
  assert.ok((after.mcpServers as Record<string, unknown>).keep);
  assert.equal((await stat(filePath)).mode & 0o777, 0o640);
});
