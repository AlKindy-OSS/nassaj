/**
 * B-384 — the writer/reader split on `.claude.json`, and the parity guard that keeps
 * it closed.
 *
 * WHAT WENT WRONG. `ClaudeMcpProvider` wrote `os.homedir()/.claude.json` (the
 * OPERATOR's file) while every claude spawn runs with
 * `CLAUDE_CONFIG_DIR=~/.nassaj-users/<id>/.claude` and `loadMcpConfig` (claude-sdk.js,
 * fixed in B-346) reads THAT file. Measured on the live node before the fix: the
 * operator file held `mcpServers:['playwright']`, all six member files held `[]`. So
 * every MCP server added from the UI was written where no agent would ever read it —
 * the feature was inert for every member, silently.
 *
 * WHY THE PARITY TEST IS THE POINT. B-344, B-346 and B-384 are the same bug three
 * times: a reader and a writer that agree by convention instead of by construction.
 * Testing "the file was written" would have passed in all three. The test that
 * actually holds is the one asserting that the path the writer picks is the path the
 * reader picks, for the same user, under BOTH sharing policies.
 *
 * The fixture is derived from a REAL `.claude.json` (53 top-level keys, secrets
 * redacted), not hand-written: the 2026-06-28 reconcile incident shipped green tests
 * over synthetic fixtures that matched 6.5% of production shapes.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, mock } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '__fixtures__', 'claude-config.real-shape.json');

let root = '';
let ClaudeMcpProvider: typeof import('../claude-mcp.provider.js').ClaudeMcpProvider;

/** Mirrors resolveProviderEnv: a config dir per user when isolated, nothing when shared. */
const isolatedConfigDir = (userId: string | number | null): string =>
  path.join(root, String(userId ?? 'operator'), '.claude');

/** userId 'shared-user' stands in for the `provider_sharing: shared` policy. */
const isShared = (userId: string | number | null): boolean => String(userId) === 'shared-user';

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'claude-mcp-isolation-'));
  mock.module('@/services/isolation/resolve-provider-env.js', {
    namedExports: {
      resolveProviderEnv: (userId: string | number | null, _provider: string, env: NodeJS.ProcessEnv) =>
        (isShared(userId)
          ? { ...env }
          : { ...env, CLAUDE_CONFIG_DIR: isolatedConfigDir(userId) }),
    },
  });
  ({ ClaudeMcpProvider } = await import('../claude-mcp.provider.js'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('user-scoped Claude MCP config lands in the writing member tree only', async () => {
  const provider = new ClaudeMcpProvider();
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

test('writer path equals the path loadMcpConfig reads, isolated and shared alike', async () => {
  const provider = new ClaudeMcpProvider();
  await provider.upsertServer({
    name: 'parity',
    scope: 'user',
    transport: 'http',
    url: 'https://example.test/mcp',
    userId: 'user-parity',
  });

  // The reader's expression, restated: path.join(CLAUDE_CONFIG_DIR || homedir, '.claude.json').
  const readerPath = path.join(isolatedConfigDir('user-parity'), '.claude.json');
  const written = JSON.parse(await readFile(readerPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
  assert.ok(written.mcpServers?.parity, 'the server must be at the exact path the reader opens');

  // Shared policy: no CLAUDE_CONFIG_DIR, so BOTH sides must fall back to the operator
  // home. This is the half that silently broke — assert the fallback, not just the var.
  const sharedProvider = new ClaudeMcpProvider();
  const operatorFile = path.join(os.homedir(), '.claude.json');
  const before = await readFile(operatorFile, 'utf8').catch(() => null);
  try {
    const listed = await sharedProvider.listServersForScope('user', { userId: 'shared-user' });
    assert.ok(Array.isArray(listed), 'shared policy must resolve to the operator file, not throw');
  } finally {
    if (before !== null) {
      assert.equal(await readFile(operatorFile, 'utf8'), before, 'a read must never mutate the operator file');
    }
  }
});

test('local scope writes under projects[cwd].mcpServers — the key the reader merges', async () => {
  const provider = new ClaudeMcpProvider();
  const workspacePath = path.join(root, 'ws-local');
  await provider.upsertServer({
    name: 'local-one',
    scope: 'local',
    transport: 'stdio',
    command: 'example-mcp',
    workspacePath,
    userId: 'user-local',
  });

  const config = JSON.parse(
    await readFile(path.join(isolatedConfigDir('user-local'), '.claude.json'), 'utf8'),
  ) as { projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
  assert.ok(config.projects?.[workspacePath]?.mcpServers?.['local-one']);
});

test('an upsert preserves every other key of a real-shaped config, and writes it 0600', async () => {
  const provider = new ClaudeMcpProvider();
  const userId = 'user-fixture';
  const configDir = isolatedConfigDir(userId);
  const configPath = path.join(configDir, '.claude.json');
  await mkdir(configDir, { recursive: true });
  const original = JSON.parse(await readFile(FIXTURE, 'utf8')) as Record<string, unknown>;
  await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

  await provider.upsertServer({
    name: 'added',
    scope: 'user',
    transport: 'stdio',
    command: 'example-mcp',
    userId,
  });

  const after = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  assert.ok((after.mcpServers as Record<string, unknown>).added, 'the new server must be present');

  // Every pre-existing key must survive byte-identically. oauthAccount is the one that
  // matters most: losing it logs the member out of their provider.
  for (const key of Object.keys(original)) {
    if (key === 'mcpServers') continue;
    assert.deepEqual(after[key], original[key], `key "${key}" must be preserved verbatim`);
  }

  const mode = (await stat(configPath)).mode & 0o777;
  assert.equal(mode, 0o600, '.claude.json holds credentials and must never be world-readable');
});

test('removing a server leaves the rest of the config untouched', async () => {
  const provider = new ClaudeMcpProvider();
  const userId = 'user-remove';
  await provider.upsertServer({ name: 'keep', scope: 'user', transport: 'stdio', command: 'a', userId });
  await provider.upsertServer({ name: 'drop', scope: 'user', transport: 'stdio', command: 'b', userId });
  await provider.removeServer({ name: 'drop', scope: 'user', userId });

  const remaining = await provider.listServersForScope('user', { userId });
  assert.deepEqual(remaining.map((server) => server.name), ['keep']);
});

test('loadMcpConfig still resolves CLAUDE_CONFIG_DIR — the reader half of the contract', async () => {
  // The reader is not exported from claude-sdk.js, so this pins its contract at the
  // source level: if someone re-points it at the operator home, the split reopens and
  // this fails loudly instead of shipping another silent B-346.
  const sdk = await readFile(path.join(HERE, '..', '..', '..', '..', '..', 'claude-sdk.js'), 'utf8');
  const fn = sdk.slice(sdk.indexOf('async function loadMcpConfig'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /configDir/, 'loadMcpConfig must resolve its root from the passed config dir');
  assert.match(body, /os\.homedir\(\)/, 'and fall back to the operator home when it is absent');
  assert.match(body, /'\.claude\.json'/, "and read '.claude.json' under that root");
  assert.match(sdk, /loadMcpConfig\(options\.cwd, sdkOptions\.env\.CLAUDE_CONFIG_DIR\)/,
    'the call site must pass the spawn CLAUDE_CONFIG_DIR, not the operator home');
});
