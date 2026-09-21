import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { after, before, mock } from 'node:test';

const execFile = promisify(execFileCallback);
const nativeBinary = path.join(os.homedir(), '.opencode', 'bin', 'opencode');
let root = '';
let OpenCodeMcpProvider: typeof import('./opencode-mcp.provider.js').OpenCodeMcpProvider;
let withOpenCodeConfigLock: typeof import('@/services/isolation/opencode-config-lock.js').withOpenCodeConfigLock;
const originalFeatureFlag = process.env.NASSAJ_OPENCODE_MCP_ENABLED;

before(async () => {
  process.env.NASSAJ_OPENCODE_MCP_ENABLED = '1';
  root = await mkdtemp(path.join(os.tmpdir(), 'opencode-mcp-contract-'));
  mock.module('@/modules/providers/list/opencode/opencode-governance.js', {
    namedExports: {
      resolveOpenCodeConfigHomeForUser: (userId: string | number | null) =>
        path.join(root, String(userId ?? 'operator'), '.config', 'opencode'),
    },
  });
  ({ OpenCodeMcpProvider } = await import('./opencode-mcp.provider.js'));
  ({ withOpenCodeConfigLock } = await import('@/services/isolation/opencode-config-lock.js'));
});

after(async () => {
  if (originalFeatureFlag === undefined) delete process.env.NASSAJ_OPENCODE_MCP_ENABLED;
  else process.env.NASSAJ_OPENCODE_MCP_ENABLED = originalFeatureFlag;
  await rm(root, { recursive: true, force: true });
});

test('OpenCode MCP is dormant when its rollout feature flag is off', () => {
  delete process.env.NASSAJ_OPENCODE_MCP_ENABLED;
  const provider = new OpenCodeMcpProvider();
  assert.equal(provider.supportsMcp, false);
  assert.equal(provider.writesPerUserConfig, false);
  process.env.NASSAJ_OPENCODE_MCP_ENABLED = '1';
});

test('user writer updates the governed canonical overlay and provisioning preserves it', async () => {
  const provider = new OpenCodeMcpProvider();
  const userId = 'user-a';
  await provider.upsertServer({
    name: 'canary',
    scope: 'user',
    transport: 'stdio',
    command: 'false',
    userId,
  });

  const configPath = path.join(root, userId, '.config', 'opencode', 'opencode.json');
  const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  assert.ok((parsed.provider as Record<string, unknown>).glm);
  assert.ok((parsed.mcp as Record<string, unknown>).canary);
  assert.equal((await stat(configPath)).mode & 0o777, 0o444);

  const { materializeOpenCodeConfig } = await import('@/services/isolation/opencode-config-material.js');
  assert.equal(materializeOpenCodeConfig(path.dirname(configPath)), true);
  assert.ok((JSON.parse(await readFile(configPath, 'utf8')).mcp as Record<string, unknown>).canary);

  assert.equal((await provider.removeServer({ name: 'canary', scope: 'user', userId })).removed, true);
  const cleaned = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(cleaned.mcp, undefined);
  assert.ok((cleaned.provider as Record<string, unknown>).glm);
});

test('JSONC-only legacy state migrates once and cleanup leaves no old entry or secret', async () => {
  const provider = new OpenCodeMcpProvider();
  const userId = 'legacy-jsonc';
  const configDir = path.join(root, userId, '.config', 'opencode');
  const jsoncPath = path.join(configDir, 'opencode.jsonc');
  await mkdir(configDir, { recursive: true });
  await writeFile(jsoncPath, `{
    // legacy secret-bearing entry
    "mcp": {
      "legacy": {"type":"local","command":["false"],"environment":{"TOKEN":"must-disappear"}}
    }
  }\n`, { mode: 0o600 });

  await provider.upsertServer({
    name: 'new-canary',
    scope: 'user',
    transport: 'stdio',
    command: 'false',
    userId,
  });
  await assert.rejects(access(jsoncPath));
  assert.deepEqual((await readdir(configDir)).filter((name) => name.includes('.migrating-')), []);

  assert.equal((await provider.removeServer({ name: 'legacy', scope: 'user', userId })).removed, true);
  const canonicalPath = path.join(configDir, 'opencode.json');
  const canonical = await readFile(canonicalPath, 'utf8');
  assert.doesNotMatch(canonical, /must-disappear|"legacy"/);
  assert.deepEqual(
    (await provider.listServersForScope('user', { userId })).map(({ name }) => name),
    ['new-canary'],
  );
});

test('dual JSON and JSONC state is rejected without returning or merging legacy entries', async () => {
  const provider = new OpenCodeMcpProvider();
  const userId = 'dual-format';
  await provider.upsertServer({
    name: 'canonical',
    scope: 'user',
    transport: 'stdio',
    command: 'false',
    userId,
  });
  const configDir = path.join(root, userId, '.config', 'opencode');
  await writeFile(path.join(configDir, 'opencode.jsonc'), '{"mcp":{"legacy":{"type":"local","command":["false"]}}}\n');

  await assert.rejects(
    provider.listServersForScope('user', { userId }),
    (error: unknown) => (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'MCP_CONFIG_DUAL_FORMAT'
    ),
  );
});

test('secure user read refuses a symlink without reading its target', async () => {
  const provider = new OpenCodeMcpProvider();
  const userId = 'symlink-config';
  const configDir = path.join(root, userId, '.config', 'opencode');
  const target = path.join(root, 'outside-secret.json');
  await mkdir(configDir, { recursive: true });
  await writeFile(target, '{"mcp":{"stolen":{"type":"local","command":["false"]}}}\n');
  await symlink(target, path.join(configDir, 'opencode.json'));

  await assert.rejects(
    provider.listServersForScope('user', { userId }),
    (error: unknown) => typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'MCP_CONFIG_UNSAFE_FILE',
  );
  assert.match(await readFile(target, 'utf8'), /stolen/);
});

test('single orphan migration is recovered, while multiple orphans fail closed', async () => {
  const provider = new OpenCodeMcpProvider();
  const recoverUser = 'single-orphan';
  const recoverDir = path.join(root, recoverUser, '.config', 'opencode');
  await mkdir(recoverDir, { recursive: true });
  await writeFile(
    path.join(recoverDir, 'opencode.jsonc.migrating-dead-single'),
    '{"mcp":{"legacy":{"type":"local","command":["false"]}}}\n',
    { mode: 0o600 },
  );
  await provider.upsertServer({
    name: 'recovered', scope: 'user', transport: 'stdio', command: 'false', userId: recoverUser,
  });
  assert.deepEqual((await readdir(recoverDir)).filter((name) => name.includes('.migrating-')), []);
  assert.deepEqual(
    (await provider.listServersForScope('user', { userId: recoverUser })).map(({ name }) => name).sort(),
    ['legacy', 'recovered'],
  );

  const ambiguousUser = 'multiple-orphans';
  const ambiguousDir = path.join(root, ambiguousUser, '.config', 'opencode');
  await mkdir(ambiguousDir, { recursive: true });
  await writeFile(path.join(ambiguousDir, 'opencode.jsonc.migrating-dead-a'), '{}\n');
  await writeFile(path.join(ambiguousDir, 'opencode.jsonc.migrating-dead-b'), '{}\n');
  await assert.rejects(
    provider.upsertServer({
      name: 'blocked', scope: 'user', transport: 'stdio', command: 'false', userId: ambiguousUser,
    }),
    (error: unknown) => typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'MCP_CONFIG_MIGRATION_AMBIGUOUS',
  );
});

for (const phase of ['rename', 'canonical', 'neutralize'] as const) {
  test(`migration recovers after an injected crash following ${phase}`, async () => {
    const userId = `crash-${phase}`;
    const configDir = path.join(root, userId, '.config', 'opencode');
    const jsoncPath = path.join(configDir, 'opencode.jsonc');
    await mkdir(configDir, { recursive: true });
    await writeFile(jsoncPath, '{"mcp":{"legacy":{"type":"local","command":["false"],"environment":{"TOKEN":"crash-secret"}}}}\n', {
      mode: 0o600,
    });

    const crashing = new OpenCodeMcpProvider({ testCrashAfter: phase });
    await assert.rejects(
      crashing.upsertServer({
        name: 'canary', scope: 'user', transport: 'stdio', command: 'false', userId,
      }),
      (error: unknown) => typeof error === 'object' && error !== null
        && 'code' in error && error.code === 'MCP_TEST_MIGRATION_CRASH',
    );

    const recovered = new OpenCodeMcpProvider();
    await recovered.upsertServer({
      name: 'after-recovery', scope: 'user', transport: 'stdio', command: 'false', userId,
    });
    assert.equal((await recovered.removeServer({ name: 'legacy', scope: 'user', userId })).removed, true);
    const names = await readdir(configDir);
    assert.deepEqual(names.filter((name) => name.includes('.migrating-')), []);
    assert.doesNotMatch(
      (await Promise.all(names.map((name) => readFile(path.join(configDir, name), 'utf8').catch(() => '')))).join('\n'),
      /crash-secret/,
    );
  });
}

test('ordinary provisioning recovers a provider crash and preserves the legacy overlay', async () => {
  const userId = 'crash-then-provision';
  const configDir = path.join(root, userId, '.config', 'opencode');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, 'opencode.jsonc'),
    '{"mcp":{"legacy":{"type":"local","command":["false"]}}}\n',
    { mode: 0o600 },
  );
  await assert.rejects(
    new OpenCodeMcpProvider({ testCrashAfter: 'rename' }).upsertServer({
      name: 'interrupted', scope: 'user', transport: 'stdio', command: 'false', userId,
    }),
    (error: unknown) => typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'MCP_TEST_MIGRATION_CRASH',
  );

  const { materializeOpenCodeConfig } = await import('@/services/isolation/opencode-config-material.js');
  assert.equal(materializeOpenCodeConfig(configDir), true);
  const canonical = JSON.parse(await readFile(path.join(configDir, 'opencode.json'), 'utf8'));
  assert.deepEqual(Object.keys(canonical.mcp), ['legacy']);
  assert.deepEqual((await readdir(configDir)).filter((name) => name.includes('.migrating-')), []);
});

test('stale dead-process, ownerless, and malformed locks recover with quarantine fencing', async () => {
  const filePath = path.join(root, 'stale-lock', 'opencode.json');
  const lockDir = `${filePath}.nassaj-lock`;
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({
      token: '00000000-0000-4000-8000-000000000000',
      pid: 999_999_999,
      createdAt: Date.now() - 60_000,
    }),
    { mode: 0o600 },
  );
  let entered = false;
  await withOpenCodeConfigLock(filePath, async () => { entered = true; });
  assert.equal(entered, true);
  await assert.rejects(access(lockDir));

  for (const [name, owner] of [
    ['ownerless', null],
    ['malformed', { token: 'short', pid: -1, createdAt: Number.NaN }],
  ] as const) {
    const stalePath = path.join(root, `stale-${name}`, 'opencode.json');
    const staleDir = `${stalePath}.nassaj-lock`;
    await mkdir(staleDir, { recursive: true, mode: 0o700 });
    if (owner) await writeFile(path.join(staleDir, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    await utimes(staleDir, old, old);
    await withOpenCodeConfigLock(stalePath, async () => {});
    await assert.rejects(access(staleDir));
  }
});

test('failure after lock mkdir removes the ownerless directory immediately', async () => {
  const filePath = path.join(root, 'lock-mkdir-fault', 'opencode.json');
  const lockDir = `${filePath}.nassaj-lock`;
  await assert.rejects(
    withOpenCodeConfigLock(filePath, async () => {}, {
      afterMkdir: () => { throw new Error('injected-after-mkdir'); },
    }),
    /injected-after-mkdir/,
  );
  await assert.rejects(access(lockDir));
  let entered = false;
  await withOpenCodeConfigLock(filePath, async () => { entered = true; });
  assert.equal(entered, true);
});

test('provider fault after lock mkdir leaves no lock and the next transaction succeeds', async () => {
  const userId = 'provider-lock-mkdir-fault';
  const configDir = path.join(root, userId, '.config', 'opencode');
  const lockDir = path.join(configDir, 'opencode.json.nassaj-lock');
  await assert.rejects(
    new OpenCodeMcpProvider({ testCrashAfter: 'lock-mkdir' }).upsertServer({
      name: 'interrupted', scope: 'user', transport: 'stdio', command: 'false', userId,
    }),
    (error: unknown) => typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'MCP_TEST_MIGRATION_CRASH',
  );
  await assert.rejects(access(lockDir));
  await new OpenCodeMcpProvider().upsertServer({
    name: 'recovered', scope: 'user', transport: 'stdio', command: 'false', userId,
  });
  assert.deepEqual(
    (await new OpenCodeMcpProvider().listServersForScope('user', { userId })).map(({ name }) => name),
    ['recovered'],
  );
});

test('ancestor symlink is rejected before creating or mutating descendants', async () => {
  const outside = path.join(root, 'ancestor-outside');
  const linked = path.join(root, 'ancestor-link');
  await mkdir(outside, { recursive: true });
  await symlink(outside, linked);
  const filePath = path.join(linked, 'nested', 'opencode.json');
  await assert.rejects(
    withOpenCodeConfigLock(filePath, async () => {}),
    (error: unknown) => typeof error === 'object' && error !== null
      && 'code' in error && error.code === 'MCP_CONFIG_UNSAFE_DIRECTORY',
  );
  await assert.rejects(access(path.join(outside, 'nested')));
});

test('filesystem lock serializes two independent processes', async () => {
  const fixturePath = path.join(root, 'lock-worker.mts');
  const sharedPath = path.join(root, 'cross-process', 'opencode.json');
  const eventPath = path.join(root, 'cross-process-events.log');
  await writeFile(fixturePath, `
import fs from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { withOpenCodeConfigLock } from ${JSON.stringify(path.resolve('server/services/isolation/opencode-config-lock.js'))};
const [filePath, eventPath, label, delay] = process.argv.slice(2);
await withOpenCodeConfigLock(filePath, async () => {
  fs.appendFileSync(eventPath, label + ':start\\n');
  await wait(Number(delay));
  fs.appendFileSync(eventPath, label + ':end\\n');
});
`, { mode: 0o600 });
  const tsx = path.resolve('node_modules/.bin/tsx');
  const first = execFile(tsx, ['--tsconfig', 'server/tsconfig.json', fixturePath, sharedPath, eventPath, 'a', '300']);
  await new Promise((resolve) => setTimeout(resolve, 75));
  const second = execFile(tsx, ['--tsconfig', 'server/tsconfig.json', fixturePath, sharedPath, eventPath, 'b', '0']);
  await Promise.all([first, second]);
  const events = (await readFile(eventPath, 'utf8')).trim().split('\n');
  assert.equal(events.length, 4);
  assert.equal(events[0].split(':')[0], events[1].split(':')[0]);
  assert.equal(events[2].split(':')[0], events[3].split(':')[0]);
  assert.match(events[0], /:start$/);
  assert.match(events[1], /:end$/);
});

test('cleanup-only mode removes legacy OpenCode entries while rollout stays off', async () => {
  const userId = 'cleanup-only';
  const configDir = path.join(root, userId, '.config', 'opencode');
  const configPath = path.join(configDir, 'opencode.json');
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, '{"mcp":{"legacy":{"type":"local","command":["false"]}}}\n', { mode: 0o600 });
  delete process.env.NASSAJ_OPENCODE_MCP_ENABLED;
  try {
    const cleanup = new OpenCodeMcpProvider({ cleanupOnly: true });
    assert.equal(cleanup.supportsMcp, true);
    assert.equal(cleanup.writesPerUserConfig, false);
    assert.equal((await cleanup.removeServer({ name: 'legacy', scope: 'user', userId })).removed, true);
    assert.doesNotMatch(await readFile(configPath, 'utf8'), /legacy/);
    await assert.rejects(
      cleanup.upsertServer({
        name: 'forbidden', scope: 'user', transport: 'stdio', command: 'false', userId,
      }),
      (error: unknown) => typeof error === 'object' && error !== null
        && 'code' in error && error.code === 'MCP_WRITE_FORBIDDEN',
    );
  } finally {
    process.env.NASSAJ_OPENCODE_MCP_ENABLED = '1';
  }
});

test('real OpenCode native list reads the dormant overlay and cleanup removes it', async (t) => {
  try {
    await access(nativeBinary);
  } catch {
    t.skip('OpenCode binary is not installed');
    return;
  }

  const provider = new OpenCodeMcpProvider();
  const userId = 'real-reader';
  const home = path.join(root, userId);
  const fixturePath = path.join(root, 'synthetic-mcp.mjs');
  const methodLogPath = path.join(root, 'synthetic-methods.log');
  await writeFile(fixturePath, `
import fs from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline = input.indexOf('\\n');
  while (newline >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    newline = input.indexOf('\\n');
    if (!line) continue;
    const msg = JSON.parse(line);
    if (process.env.MCP_CANARY_LOG && msg.method) fs.appendFileSync(process.env.MCP_CANARY_LOG, msg.method+'\\n');
    if (msg.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'nassaj-canary',version:'1'}}})+'\\n');
    if (msg.method === 'tools/list') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{tools:[{name:'nassaj_no_secret_canary',description:'synthetic',inputSchema:{type:'object'}}]}})+'\\n');
  }
});
`, { mode: 0o600 });
  await provider.upsertServer({
    name: 'native_canary',
    scope: 'user',
    transport: 'stdio',
    command: process.execPath,
    args: [fixturePath],
    env: { MCP_CANARY_LOG: methodLogPath },
    userId,
  });

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
  };
  await mkdir(env.XDG_DATA_HOME, { recursive: true });
  const listed = await execFile(nativeBinary, ['mcp', 'list'], { env, timeout: 15_000 });
  assert.match(`${listed.stdout}\n${listed.stderr}`, /native_canary/);
  assert.match(`${listed.stdout}\n${listed.stderr}`, /connected/i);
  const methods = await readFile(methodLogPath, 'utf8');
  assert.match(methods, /^initialize$/m);
  assert.match(methods, /^tools\/list$/m);

  assert.equal((await provider.removeServer({ name: 'native_canary', scope: 'user', userId })).removed, true);
  const afterCleanup = await execFile(nativeBinary, ['mcp', 'list'], { env, timeout: 15_000 });
  assert.doesNotMatch(`${afterCleanup.stdout}\n${afterCleanup.stderr}`, /native_canary/);
});
