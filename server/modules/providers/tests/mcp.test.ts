import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import TOML from '@iarna/toml';

import { ClaudeMcpProvider } from '@/modules/providers/list/claude/claude-mcp.provider.js';
import { CodexMcpProvider } from '@/modules/providers/list/codex/codex-mcp.provider.js';
import { GeminiMcpProvider } from '@/modules/providers/list/gemini/gemini-mcp.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import {
  connectorRolloutTargets,
  globalManualTargets,
  legacyCleanupPlacements,
} from '@/modules/providers/services/mcp-placement.policy.js';
import {
  legacyCleanupLockName,
  removeLegacyMcpEntry,
  withCanonicalMcpWriterLock,
} from '@/modules/providers/services/legacy-mcp-cleanup.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { AppError } from '@/shared/utils.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  const originalHome = process.env.HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  (os as any).homedir = () => nextHomeDir;
  process.env.HOME = nextHomeDir;
  process.env.CODEX_HOME = path.join(nextHomeDir, '.codex');
  return () => {
    (os as any).homedir = original;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  };
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
};

const modeOf = async (filePath: string): Promise<number> =>
  (await fs.stat(filePath)).mode & 0o777;

test('connector targets remain explicitly rollout-gated despite additional proven readers', () => {
  assert.equal(providerMcpService.providerWritesPerUserMcpConfig('antigravity'), true);
  assert.equal(providerMcpService.providerWritesPerUserMcpConfig('cursor'), true);
  assert.deepEqual(providerMcpService.listMcpTargets(), [
    { provider: 'claude', writesPerUserConfig: true },
    { provider: 'codex', writesPerUserConfig: true },
  ]);
});

test('MCP placement inventories remain explicit, independent, and path-specific', () => {
  assert.deepEqual(connectorRolloutTargets.map(({ provider }) => provider), ['claude', 'codex']);
  assert.deepEqual(
    globalManualTargets.map(({ provider, scope }) => `${provider}:${scope}`),
    [
      'claude:user', 'codex:user', 'cursor:user',
      'claude:project', 'cursor:project',
    ],
  );
  assert.deepEqual(
    legacyCleanupPlacements.map(({ id }) => id),
    [
      'claude-user-json', 'codex-user-toml', 'gemini-pseudo-user-json',
      'cursor-user-json', 'agy-user-json', 'opencode-user-json',
    ],
  );
  assert.deepEqual(
    legacyCleanupPlacements.map(({ storagePathAlias }) => storagePathAlias),
    [
      '$CLAUDE_CONFIG_DIR/.claude.json#mcpServers',
      '$CODEX_HOME/config.toml#mcp_servers',
      '$USER_HOME/.gemini/settings.json#mcpServers',
      '$USER_HOME/.cursor/mcp.json#mcpServers',
      '$USER_HOME/.gemini/config/mcp_config.json#mcpServers',
      '$XDG_CONFIG_HOME/opencode/opencode.json#mcp',
    ],
  );
  const gemini = legacyCleanupPlacements.find(({ id }) => id === 'gemini-pseudo-user-json');
  const agy = legacyCleanupPlacements.find(({ id }) => id === 'agy-user-json');
  assert.equal(gemini?.runtimeReadProof.kind, 'historical-only');
  assert.equal(gemini?.residueAbsenceProof.kind, 'same-storage-readback');
  assert.notEqual(gemini?.storagePathAlias, agy?.storagePathAlias);
  assert.ok(legacyCleanupPlacements.every(({ residueAbsenceProof }) =>
    residueAbsenceProof.kind === 'same-storage-readback'));
});

test('MCP fan-out contracts never derive targets by iterating the provider registry', () => {
  const original = providerRegistry.listProviders;
  providerRegistry.listProviders = () => {
    throw new Error('registry iteration is forbidden for MCP placement');
  };
  try {
    assert.deepEqual(providerMcpService.listMcpTargets(), [
      { provider: 'claude', writesPerUserConfig: true },
      { provider: 'codex', writesPerUserConfig: true },
    ]);
  } finally {
    providerRegistry.listProviders = original;
  }
});

test('connector cleanup includes legacy targets excluded from new fan-out', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-cleanup-targets-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const name = 'nassaj-connector-proof';
    const userRoot = path.join(tempRoot, '.nassaj-users', '7');
    const jsonPlacements = [
      path.join(userRoot, '.claude', '.claude.json'),
      path.join(userRoot, '.gemini', 'settings.json'),
      path.join(userRoot, '.cursor', 'mcp.json'),
      path.join(userRoot, '.gemini', 'config', 'mcp_config.json'),
    ];
    for (const filePath of jsonPlacements) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify({
        mcpServers: { [name]: { command: 'legacy-proof', args: [] } },
      }));
    }
    const codexPath = path.join(userRoot, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await fs.writeFile(codexPath, TOML.stringify({
      mcp_servers: { [name]: { command: 'legacy-proof', args: [] } },
    }));
    const opencodePath = path.join(userRoot, '.config', 'opencode', 'opencode.json');
    await fs.mkdir(path.dirname(opencodePath), { recursive: true });
    await fs.writeFile(opencodePath, JSON.stringify({
      mcp: { [name]: { type: 'local', command: ['legacy-proof'] } },
    }));

    const originalListProviders = providerRegistry.listProviders;
    providerRegistry.listProviders = () => {
      throw new Error('cleanup must not iterate the provider registry');
    };
    const results = await (async () => {
      try {
        return await providerMcpService.removeMcpServerFromAllProviders({
          name,
          scope: 'user',
          userId: 7,
        });
      } finally {
        providerRegistry.listProviders = originalListProviders;
      }
    })();
    assert.deepEqual(
      results.map((result) => result.provider).sort(),
      ['antigravity', 'claude', 'codex', 'cursor', 'gemini', 'opencode'],
    );
    assert.ok(results.every((result) => result.verified));
    assert.ok(
      results.every((result) => result.removed === true && result.state === 'removed'),
      'same-storage read-back proves residue absence independently of runtime-read proof',
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('historical JSON/TOML cleanup rejects ancestor and final symlinks without mutation', async (t) => {
  const families = [
    { id: 'claude', rootSubdir: '.claude', relativePath: '.claude.json', format: 'json', mapKey: 'mcpServers' },
    { id: 'codex', rootSubdir: '.codex', relativePath: 'config.toml', format: 'toml', mapKey: 'mcp_servers' },
    { id: 'gemini-pseudo', rootSubdir: '', relativePath: '.gemini/settings.json', format: 'json', mapKey: 'mcpServers' },
    { id: 'cursor', rootSubdir: '', relativePath: '.cursor/mcp.json', format: 'json', mapKey: 'mcpServers' },
    { id: 'agy', rootSubdir: '', relativePath: '.gemini/config/mcp_config.json', format: 'json', mapKey: 'mcpServers' },
  ] as const;
  const name = 'must-survive';
  const serialized = (format: 'json' | 'toml', mapKey: 'mcpServers' | 'mcp_servers') =>
    format === 'json'
      ? JSON.stringify({ [mapKey]: { [name]: { command: 'victim' } } })
      : TOML.stringify({ [mapKey]: { [name]: { command: 'victim' } } });

  for (const family of families) {
    await t.test(`${family.id}: ancestor symlink`, async () => {
      const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-cleanup-${family.id}-ancestor-`));
      try {
        const userRoot = path.join(sandbox, 'user');
        const victimRoot = path.join(sandbox, 'victim-root');
        await fs.mkdir(victimRoot, { recursive: true });
        const victimPath = path.join(victimRoot, family.relativePath);
        await fs.mkdir(path.dirname(victimPath), { recursive: true });
        const original = serialized(family.format, family.mapKey);
        await fs.writeFile(victimPath, original);
        const rootDir = path.join(userRoot, family.rootSubdir || 'linked-root');
        await fs.mkdir(path.dirname(rootDir), { recursive: true });
        await fs.symlink(victimRoot, rootDir);

        await assert.rejects(
          removeLegacyMcpEntry({
            rootDir,
            relativePath: family.relativePath,
            format: family.format,
            mapKey: family.mapKey,
            name,
          }),
          (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_UNSAFE_PATH',
        );
        assert.equal(await fs.readFile(victimPath, 'utf8'), original);
      } finally {
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    });

    await t.test(`${family.id}: final symlink`, async () => {
      const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-cleanup-${family.id}-final-`));
      try {
        const rootDir = path.join(sandbox, 'user', family.rootSubdir);
        const finalPath = path.join(rootDir, family.relativePath);
        const victimPath = path.join(sandbox, 'victim-config');
        const original = serialized(family.format, family.mapKey);
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(victimPath, original);
        await fs.symlink(victimPath, finalPath);

        await assert.rejects(
          removeLegacyMcpEntry({
            rootDir,
            relativePath: family.relativePath,
            format: family.format,
            mapKey: family.mapKey,
            name,
          }),
          (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_UNSAFE_PATH',
        );
        assert.equal(await fs.readFile(victimPath, 'utf8'), original);
        assert.equal((await fs.lstat(finalPath)).isSymbolicLink(), true);
      } finally {
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    });
  }
});

test('historical cleanup treats a missing tree as absent without materializing it', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cleanup-missing-'));
  const missingRoot = path.join(sandbox, 'must-not-be-created');
  try {
    assert.deepEqual(await removeLegacyMcpEntry({
      rootDir: missingRoot,
      relativePath: '.cursor/mcp.json',
      format: 'json',
      mapKey: 'mcpServers',
      name: 'absent',
    }), { removed: false, residueAbsent: true });
    await assert.rejects(fs.lstat(missingRoot), { code: 'ENOENT' });
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('historical JSON/TOML cleanup rejects hardlinks without mutating the outside inode', async (t) => {
  const formats = [
    { id: 'json', relativePath: '.cursor/mcp.json', format: 'json', mapKey: 'mcpServers' },
    { id: 'toml', relativePath: '.codex/config.toml', format: 'toml', mapKey: 'mcp_servers' },
  ] as const;
  for (const entry of formats) {
    await t.test(entry.id, async () => {
      const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-cleanup-hardlink-${entry.id}-`));
      try {
        const rootDir = path.join(sandbox, 'user');
        const finalPath = path.join(rootDir, entry.relativePath);
        const outsidePath = path.join(sandbox, `outside.${entry.id}`);
        const original = entry.format === 'json'
          ? JSON.stringify({ [entry.mapKey]: { linked: { command: 'outside' } } })
          : TOML.stringify({ [entry.mapKey]: { linked: { command: 'outside' } } });
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(outsidePath, original);
        await fs.link(outsidePath, finalPath);

        await assert.rejects(removeLegacyMcpEntry({
          rootDir,
          relativePath: entry.relativePath,
          format: entry.format,
          mapKey: entry.mapKey,
          name: 'linked',
        }), (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_UNSAFE_PATH');
        assert.equal(await fs.readFile(outsidePath, 'utf8'), original);
        assert.equal((await fs.stat(outsidePath)).nlink, 2);
      } finally {
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    });
  }
});

test('historical staged cleanup faults never tear the original JSON/TOML file', async (t) => {
  const formats = [
    { id: 'json', relativePath: '.cursor/mcp.json', format: 'json', mapKey: 'mcpServers' },
    { id: 'toml', relativePath: '.codex/config.toml', format: 'toml', mapKey: 'mcp_servers' },
  ] as const;
  const phases = ['after-stage-write', 'after-stage-fsync', 'before-promotion'] as const;
  for (const entry of formats) {
    for (const phase of phases) {
      await t.test(`${entry.id}: ${phase}`, async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-cleanup-fault-${entry.id}-`));
        try {
          const rootDir = path.join(sandbox, 'user');
          const finalPath = path.join(rootDir, entry.relativePath);
          const original = entry.format === 'json'
            ? JSON.stringify({ [entry.mapKey]: { keep: { command: 'original' } }, unrelated: true })
            : TOML.stringify({ [entry.mapKey]: { keep: { command: 'original' } }, unrelated: true });
          await fs.mkdir(path.dirname(finalPath), { recursive: true });
          await fs.writeFile(finalPath, original, { mode: 0o640 });

          await assert.rejects(removeLegacyMcpEntry({
            rootDir,
            relativePath: entry.relativePath,
            format: entry.format,
            mapKey: entry.mapKey,
            name: 'keep',
            testFaultAfter: phase,
          }), (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_TEST_FAULT');
          assert.equal(await fs.readFile(finalPath, 'utf8'), original);
          assert.equal((await fs.stat(finalPath)).mode & 0o777, 0o640);
          assert.equal(
            (await fs.readdir(path.dirname(finalPath))).some((name) => name.startsWith('.nassaj-mcp-cleanup-')),
            false,
          );
        } finally {
          await fs.rm(sandbox, { recursive: true, force: true });
        }
      });
    }
  }
});

test('pinned cleanup rejects a deterministic ancestor swap and leaves both trees untouched', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cleanup-ancestor-race-'));
  try {
    const rootDir = path.join(sandbox, 'user');
    const parent = path.join(rootDir, '.cursor');
    const movedParent = path.join(rootDir, '.cursor-moved');
    const victimParent = path.join(sandbox, 'victim');
    const finalPath = path.join(parent, 'mcp.json');
    const original = JSON.stringify({ mcpServers: { keep: { command: 'original' } } });
    const victim = JSON.stringify({ mcpServers: { keep: { command: 'victim' } } });
    await fs.mkdir(parent, { recursive: true });
    await fs.mkdir(victimParent, { recursive: true });
    await fs.writeFile(finalPath, original);
    await fs.writeFile(path.join(victimParent, 'mcp.json'), victim);

    await assert.rejects(removeLegacyMcpEntry({
      rootDir,
      relativePath: '.cursor/mcp.json',
      format: 'json',
      mapKey: 'mcpServers',
      name: 'keep',
      testBeforePromotion: async () => {
        await fs.rename(parent, movedParent);
        await fs.symlink(victimParent, parent);
      },
    }), (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_UNSAFE_PATH');
    assert.equal(await fs.readFile(path.join(movedParent, 'mcp.json'), 'utf8'), original);
    assert.equal(await fs.readFile(path.join(victimParent, 'mcp.json'), 'utf8'), victim);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

const runCleanupWorker = async (args: string[]): Promise<{ removed: boolean; residueAbsent: boolean }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
      ['--tsconfig', 'server/tsconfig.json', 'server/modules/providers/tests/legacy-mcp-cleanup.worker.ts', ...args],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`cleanup worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { removed: boolean; residueAbsent: boolean });
    });
  });

const runCrashingCleanupWorker = async (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
      ['--tsconfig', 'server/tsconfig.json', 'server/modules/providers/tests/legacy-mcp-cleanup.worker.ts', ...args],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 77) resolve();
      else reject(new Error(`cleanup crash worker exited ${code}: ${stderr}`));
    });
  });

const runProviderWriter = async (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
      ['--tsconfig', 'server/tsconfig.json', 'server/modules/providers/tests/legacy-mcp-provider-writer.worker.ts', ...args],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`provider writer exited ${code}: ${stderr}`));
    });
  });

const runCrashingWriterLock = async (
  filePath: string,
  action: 'crash-after-create' | 'crash-after-mkdir' = 'crash-after-create',
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      path.join(process.cwd(), 'node_modules', '.bin', 'tsx'),
      [
        '--tsconfig', 'server/tsconfig.json',
        'server/modules/providers/tests/mcp-writer-lock.worker.ts',
        filePath, action,
      ],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 77) resolve();
      else reject(new Error(`writer lock crash worker exited ${code}: ${stderr}`));
    });
  });

const waitForFile = async (filePath: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fs.lstat(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
};

test('first-create provider transactions are cross-process, pinned and private', { concurrency: false }, async (t) => {
  const providers = [
    {
      provider: 'claude', relativePath: '.claude.json', mapKey: 'mcpServers',
      parse: (content: string) => JSON.parse(content) as Record<string, unknown>,
    },
    {
      provider: 'codex', relativePath: '.codex/config.toml', mapKey: 'mcp_servers',
      parse: (content: string) => TOML.parse(content) as Record<string, unknown>,
    },
  ] as const;

  for (const entry of providers) {
    await t.test(`${entry.provider}: missing-file upsert/upsert preserves both`, async () => {
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-first-${entry.provider}-`));
      const finalPath = path.join(rootDir, entry.relativePath);
      const originalUmask = process.umask(0o777);
      try {
        await Promise.all([
          runProviderWriter([entry.provider, rootDir, 'first', 'upsert']),
          runProviderWriter([entry.provider, rootDir, 'second', 'upsert']),
        ]);
        const config = entry.parse(await fs.readFile(finalPath, 'utf8'));
        const servers = config[entry.mapKey] as Record<string, unknown>;
        assert.ok(servers.first);
        assert.ok(servers.second);
        assert.equal((await fs.stat(finalPath)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(path.dirname(finalPath))).mode & 0o777, 0o700);
        assert.equal(
          (await fs.readdir(path.dirname(finalPath))).some((name) =>
            name.includes('.lock') || name.includes('.tmp-')),
          false,
        );
      } finally {
        process.umask(originalUmask);
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    });

    await t.test(`${entry.provider}: missing-file upsert/remove is serialized`, async () => {
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-first-remove-${entry.provider}-`));
      const finalPath = path.join(rootDir, entry.relativePath);
      try {
        const upsert = runProviderWriter([entry.provider, rootDir, 'transient', 'upsert']);
        await waitForFile(finalPath);
        const remove = runProviderWriter([entry.provider, rootDir, 'transient', 'remove']);
        await Promise.all([upsert, remove]);
        const config = entry.parse(await fs.readFile(finalPath, 'utf8'));
        const servers = config[entry.mapKey] as Record<string, unknown>;
        assert.equal(servers.transient, undefined);
        assert.equal(
          (await fs.readdir(path.dirname(finalPath))).some((name) => name.includes('.lock')),
          false,
        );
      } finally {
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    });

    await t.test(`${entry.provider}: mode-000 mkdir crash is recovered immediately`, async () => {
      const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-first-mode-zero-${entry.provider}-`));
      const providerRoot = entry.provider === 'claude' ? path.join(rootDir, 'claude-home') : rootDir;
      const finalPath = path.join(providerRoot, entry.relativePath);
      const crashedDirectory = path.dirname(finalPath);
      const originalUmask = process.umask(0o777);
      try {
        await runCrashingWriterLock(finalPath, 'crash-after-mkdir');
      } finally {
        process.umask(originalUmask);
      }
      try {
        assert.equal((await fs.stat(crashedDirectory)).mode & 0o777, 0);
        await runProviderWriter([entry.provider, providerRoot, 'recovered-mode', 'upsert']);
        const config = entry.parse(await fs.readFile(finalPath, 'utf8'));
        const servers = config[entry.mapKey] as Record<string, unknown>;
        assert.ok(servers['recovered-mode']);
        assert.equal((await fs.stat(crashedDirectory)).mode & 0o777, 0o700);
        assert.equal((await fs.stat(finalPath)).mode & 0o777, 0o600);
        assert.equal(
          (await fs.readdir(crashedDirectory)).some((name) => name.includes('.lock')),
          false,
        );
      } finally {
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    });
  }

  await t.test('ancestor and final symlinks are rejected without touching victims', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-first-symlink-'));
    const victimDir = path.join(sandbox, 'victim');
    try {
      await fs.mkdir(victimDir);
      await fs.writeFile(path.join(victimDir, 'config.json'), 'victim');
      await fs.symlink(victimDir, path.join(sandbox, 'linked'));
      await assert.rejects(
        withCanonicalMcpWriterLock(path.join(sandbox, 'linked', 'config.json'), async () => {}),
        (error: unknown) => error instanceof AppError && error.code === 'MCP_CONFIG_UNSAFE_DIRECTORY',
      );
      const finalVictim = path.join(sandbox, 'final-victim');
      const finalPath = path.join(sandbox, 'final.json');
      await fs.writeFile(finalVictim, 'final-victim');
      await fs.symlink(finalVictim, finalPath);
      await assert.rejects(
        withCanonicalMcpWriterLock(finalPath, async () => {}),
        (error: unknown) => error instanceof AppError && error.code === 'MCP_CONFIG_UNSAFE_DIRECTORY',
      );
      assert.equal(await fs.readFile(path.join(victimDir, 'config.json'), 'utf8'), 'victim');
      assert.equal(await fs.readFile(finalVictim, 'utf8'), 'final-victim');
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });

  for (const provider of ['claude', 'codex'] as const) {
    for (const attack of ['symlink', 'hardlink'] as const) {
      await t.test(`${provider}: provider snapshot rejects a post-check final ${attack}`, async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-final-toctou-${provider}-${attack}-`));
        const configDir = provider === 'claude' ? sandbox : path.join(sandbox, '.codex');
        const finalPath = provider === 'claude'
          ? path.join(configDir, '.claude.json')
          : path.join(configDir, 'config.toml');
        const victimPath = path.join(sandbox, 'victim');
        const victimContent = provider === 'claude'
          ? '{"sentinel":"victim-json"}\n'
          : 'sentinel = "victim-toml"\n';
        const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
        const previousCodexHome = process.env.CODEX_HOME;
        try {
          await fs.mkdir(configDir, { recursive: true });
          await fs.writeFile(victimPath, victimContent, { mode: 0o600 });
          await fs.chmod(victimPath, 0);
          const attackHook = async () => {
            if (attack === 'symlink') await fs.symlink(victimPath, finalPath);
            else await fs.link(victimPath, finalPath);
          };
          let instance: ClaudeMcpProvider | CodexMcpProvider;
          if (provider === 'claude') {
            process.env.CLAUDE_CONFIG_DIR = configDir;
            class HookedClaudeProvider extends ClaudeMcpProvider {
              protected override writerTransactionTestHooks() {
                return { testAfterFinalSnapshot: attackHook };
              }
            }
            instance = new HookedClaudeProvider();
          } else {
            process.env.CODEX_HOME = configDir;
            class HookedCodexProvider extends CodexMcpProvider {
              protected override writerTransactionTestHooks() {
                return { testAfterFinalSnapshot: attackHook };
              }
            }
            instance = new HookedCodexProvider();
          }
          await assert.rejects(instance.upsertServer({
            name: 'must-not-land', scope: 'user', transport: 'stdio',
            command: 'blocked', userId: null,
          }), (error: unknown) => error instanceof AppError
            && error.code === 'MCP_CLEANUP_UNSAFE_PATH');
          await fs.chmod(victimPath, 0o600);
          assert.equal(await fs.readFile(victimPath, 'utf8'), victimContent);
          const finalStat = await fs.lstat(finalPath);
          assert.equal(attack === 'symlink' ? finalStat.isSymbolicLink() : finalStat.nlink === 2, true);
          assert.equal(
            (await fs.readdir(configDir)).some((name) =>
              name.includes('.tmp-') || name.includes('.lock')),
            false,
          );
        } finally {
          if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
          else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
          if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
          else process.env.CODEX_HOME = previousCodexHome;
          await fs.rm(sandbox, { recursive: true, force: true });
        }
      });
    }
  }

  for (const provider of ['claude', 'codex'] as const) {
    for (const attack of ['symlink', 'hardlink', 'other-inode'] as const) {
      await t.test(`${provider}: post-effect final ${attack} swap fails before success`, async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-final-post-${provider}-${attack}-`));
        const configDir = provider === 'claude' ? sandbox : path.join(sandbox, '.codex');
        const finalPath = provider === 'claude'
          ? path.join(configDir, '.claude.json')
          : path.join(configDir, 'config.toml');
        const victimPath = path.join(sandbox, 'victim-post');
        const victimContent = 'post-effect-victim';
        const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
        const previousCodexHome = process.env.CODEX_HOME;
        try {
          await fs.mkdir(configDir, { recursive: true });
          await fs.writeFile(victimPath, victimContent, { mode: 0o600 });
          const attackHook = async () => {
            const replacementPath = path.join(configDir, '.replacement-inode');
            if (attack === 'other-inode') {
              await fs.writeFile(replacementPath, 'replacement-inode', { mode: 0o600 });
            }
            await fs.rm(finalPath);
            if (attack === 'symlink') await fs.symlink(victimPath, finalPath);
            else if (attack === 'hardlink') await fs.link(victimPath, finalPath);
            else await fs.rename(replacementPath, finalPath);
          };
          let instance: ClaudeMcpProvider | CodexMcpProvider;
          if (provider === 'claude') {
            process.env.CLAUDE_CONFIG_DIR = configDir;
            class PostHookedClaudeProvider extends ClaudeMcpProvider {
              protected override writerTransactionTestHooks() {
                return { testAfterEffect: attackHook };
              }
            }
            instance = new PostHookedClaudeProvider();
          } else {
            process.env.CODEX_HOME = configDir;
            class PostHookedCodexProvider extends CodexMcpProvider {
              protected override writerTransactionTestHooks() {
                return { testAfterEffect: attackHook };
              }
            }
            instance = new PostHookedCodexProvider();
          }
          await assert.rejects(instance.upsertServer({
            name: 'false-success', scope: 'user', transport: 'stdio',
            command: 'blocked', userId: null,
          }), (error: unknown) => error instanceof AppError
            && error.code === 'MCP_CLEANUP_UNSAFE_PATH');
          assert.equal(await fs.readFile(victimPath, 'utf8'), victimContent);
          assert.equal(
            (await fs.readdir(configDir)).some((name) =>
              name.includes('.tmp-') || name.includes('.lock')),
            false,
          );
        } finally {
          if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
          else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
          if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
          else process.env.CODEX_HOME = previousCodexHome;
          await fs.rm(sandbox, { recursive: true, force: true });
        }
      });
    }
  }

  for (const provider of ['claude', 'codex'] as const) {
    await t.test(`${provider}: a legitimate writer after release does not falsify A success`, async () => {
      const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-post-release-${provider}-`));
      const configDir = provider === 'claude' ? sandbox : path.join(sandbox, '.codex');
      const finalPath = provider === 'claude'
        ? path.join(configDir, '.claude.json')
        : path.join(configDir, 'config.toml');
      const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
      const previousCodexHome = process.env.CODEX_HOME;
      try {
        let instance: ClaudeMcpProvider | CodexMcpProvider;
        const writerB = () => runProviderWriter([provider, sandbox, 'same-name', 'upsert']);
        if (provider === 'claude') {
          process.env.CLAUDE_CONFIG_DIR = configDir;
          class ReleasedClaudeProvider extends ClaudeMcpProvider {
            protected override writerTransactionTestHooks() {
              return { testAfterRelease: writerB };
            }
          }
          instance = new ReleasedClaudeProvider();
        } else {
          process.env.CODEX_HOME = configDir;
          class ReleasedCodexProvider extends CodexMcpProvider {
            protected override writerTransactionTestHooks() {
              return { testAfterRelease: writerB };
            }
          }
          instance = new ReleasedCodexProvider();
        }
        const writerA = await instance.upsertServer({
          name: 'same-name', scope: 'user', transport: 'stdio',
          command: 'writer-a', userId: null,
        });
        assert.equal(writerA.command, 'writer-a');
        const config = provider === 'claude'
          ? JSON.parse(await fs.readFile(finalPath, 'utf8')) as Record<string, unknown>
          : TOML.parse(await fs.readFile(finalPath, 'utf8')) as Record<string, unknown>;
        const mapKey = provider === 'claude' ? 'mcpServers' : 'mcp_servers';
        const finalServer = (config[mapKey] as Record<string, Record<string, unknown>>)['same-name'];
        assert.equal(finalServer?.command, 'writer');
        assert.equal(
          (await fs.readdir(configDir)).some((name) => name.includes('.lock')),
          false,
        );
      } finally {
        if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
        if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previousCodexHome;
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    });
  }

  await t.test('pinned writer fails closed on deterministic ancestor swap without redirecting bytes', async () => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-first-swap-'));
    const parent = path.join(sandbox, 'config');
    const movedParent = path.join(sandbox, 'config-moved');
    const victimParent = path.join(sandbox, 'victim');
    const finalPath = path.join(parent, 'mcp.json');
    try {
      await fs.mkdir(parent);
      await fs.mkdir(victimParent);
      await fs.writeFile(path.join(victimParent, 'mcp.json'), 'victim');
      await assert.rejects(withCanonicalMcpWriterLock(
        finalPath,
        async ({ targetPath }) => {
          await fs.writeFile(targetPath, 'pinned', { mode: 0o600 });
        },
        {
          testBeforeEffect: async () => {
            await fs.rename(parent, movedParent);
            await fs.symlink(victimParent, parent);
          },
        },
      ), (error: unknown) => error instanceof AppError
        && (error.code === 'MCP_CLEANUP_UNSAFE_PATH'
          || error.code === 'MCP_CONFIG_UNSAFE_DIRECTORY'));
      await assert.rejects(fs.lstat(path.join(movedParent, 'mcp.json')), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(victimParent, 'mcp.json'), 'utf8'), 'victim');
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });

  await t.test('dead first-create owner is recovered without lock residue', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-first-crash-'));
    const finalPath = path.join(rootDir, '.claude.json');
    try {
      await runCrashingWriterLock(finalPath);
      assert.ok((await fs.readdir(rootDir)).some((name) => name.includes('.lock')));
      await runProviderWriter(['claude', rootDir, 'recovered', 'upsert']);
      const config = JSON.parse(await fs.readFile(finalPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      assert.ok(config.mcpServers.recovered);
      assert.equal((await fs.stat(finalPath)).mode & 0o777, 0o600);
      assert.equal((await fs.readdir(rootDir)).some((name) => name.includes('.lock')), false);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

test('cleanup pins only the parent before a competing process promotes the target', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-cleanup-before-lock-'));
  const relativePath = 'mcp.json';
  const finalPath = path.join(rootDir, relativePath);
  try {
    await fs.writeFile(finalPath, JSON.stringify({ mcpServers: {
      first: { command: 'one' }, second: { command: 'two' }, retained: { command: 'three' },
    } }));
    const result = await removeLegacyMcpEntry({
      rootDir, relativePath, format: 'json', mapKey: 'mcpServers', name: 'second',
      testAfterParentPinned: async () => {
        // No target descriptor or snapshot may precede lock ownership.
        const descriptors = await fs.readdir('/proc/self/fd');
        for (const descriptor of descriptors) {
          const target = await fs.readlink(`/proc/self/fd/${descriptor}`).catch(() => null);
          assert.notEqual(target, finalPath);
        }
        assert.deepEqual(await runCleanupWorker([
          rootDir, relativePath, 'json', 'mcpServers', 'first',
        ]), { removed: true, residueAbsent: true });
      },
    });
    assert.deepEqual(result, { removed: true, residueAbsent: true });
    assert.deepEqual(JSON.parse(await fs.readFile(finalPath, 'utf8')), {
      mcpServers: { retained: { command: 'three' } },
    });
    assert.deepEqual(await fs.readdir(rootDir), [relativePath]);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('cross-process cleanup serializes distinct-name RMW for JSON and TOML', async (t) => {
  const formats = [
    { id: 'json', relativePath: '.cursor/mcp.json', format: 'json', mapKey: 'mcpServers' },
    { id: 'toml', relativePath: '.codex/config.toml', format: 'toml', mapKey: 'mcp_servers' },
  ] as const;
  for (const entry of formats) {
    await t.test(entry.id, async () => {
      const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-cleanup-process-${entry.id}-`));
      try {
        const rootDir = path.join(sandbox, 'user');
        const finalPath = path.join(rootDir, entry.relativePath);
        const config = {
          [entry.mapKey]: {
            first: { command: 'one' },
            second: { command: 'two' },
            retained: { command: 'three' },
          },
        };
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(finalPath, entry.format === 'json'
          ? JSON.stringify(config)
          : TOML.stringify(config));

        const common = [rootDir, entry.relativePath, entry.format, entry.mapKey];
        const [first, second] = await Promise.all([
          runCleanupWorker([...common, 'first']),
          runCleanupWorker([...common, 'second']),
        ]);
        assert.deepEqual(first, { removed: true, residueAbsent: true });
        assert.deepEqual(second, { removed: true, residueAbsent: true });
        const finalConfig = entry.format === 'json'
          ? JSON.parse(await fs.readFile(finalPath, 'utf8')) as Record<string, unknown>
          : TOML.parse(await fs.readFile(finalPath, 'utf8')) as Record<string, unknown>;
        const servers = finalConfig[entry.mapKey] as Record<string, unknown>;
        assert.equal(servers.first, undefined);
        assert.equal(servers.second, undefined);
        assert.ok(servers.retained);
        assert.equal(
          (await fs.readdir(path.dirname(finalPath))).some((name) => name.includes('.lock')),
          false,
        );
      } finally {
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    });
  }
});

test('provider writers share the cleanup lock and cannot resurrect removed entries', async (t) => {
  const formats = [
    { provider: 'cursor', relativePath: '.cursor/mcp.json', format: 'json', mapKey: 'mcpServers' },
    { provider: 'codex', relativePath: '.codex/config.toml', format: 'toml', mapKey: 'mcp_servers' },
  ] as const;
  for (const entry of formats) {
    await t.test(entry.provider, async () => {
      const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-cleanup-writer-${entry.provider}-`));
      try {
        const finalPath = path.join(sandbox, entry.relativePath);
        const config = {
          [entry.mapKey]: {
            remove: { command: 'old' },
            retained: { command: 'keep' },
          },
        };
        await fs.mkdir(path.dirname(finalPath), { recursive: true });
        await fs.writeFile(finalPath, entry.format === 'json'
          ? JSON.stringify(config)
          : TOML.stringify(config));

        const [cleanup] = await Promise.all([
          runCleanupWorker([sandbox, entry.relativePath, entry.format, entry.mapKey, 'remove']),
          runProviderWriter([entry.provider, sandbox, 'writer-added']),
        ]);
        assert.deepEqual(cleanup, { removed: true, residueAbsent: true });
        const finalConfig = entry.format === 'json'
          ? JSON.parse(await fs.readFile(finalPath, 'utf8')) as Record<string, unknown>
          : TOML.parse(await fs.readFile(finalPath, 'utf8')) as Record<string, unknown>;
        const servers = finalConfig[entry.mapKey] as Record<string, unknown>;
        assert.equal(servers.remove, undefined, 'writer must not restore its pre-cleanup snapshot');
        assert.ok(servers.retained);
        assert.ok(servers['writer-added']);
      } finally {
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    });
  }
});

test('cleanup lock recovers dead owners and rejects malformed or symlink lock state', async (t) => {
  const setup = async (suffix: string) => {
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `mcp-cleanup-lock-${suffix}-`));
    const rootDir = path.join(sandbox, 'user');
    const relativePath = '.cursor/mcp.json';
    const finalPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    const original = JSON.stringify({ mcpServers: { remove: { command: 'old' } } });
    await fs.writeFile(finalPath, original);
    return {
      sandbox, rootDir, relativePath, finalPath, original,
      lockPath: path.join(path.dirname(finalPath), legacyCleanupLockName(relativePath)),
    };
  };
  const validOwner = (pid: number, options?: { expired?: boolean }) => {
    const token = randomUUID();
    const createdAt = options?.expired ? Date.now() - 60_000 : Date.now();
    return {
      token,
      fence: `${createdAt}-${token}`,
      pid,
      createdAt,
      expiresAt: options?.expired ? createdAt + 1_000 : createdAt + 60_000,
    };
  };

  await t.test('dead owner is recovered', async () => {
    const fixture = await setup('dead');
    try {
      await fs.writeFile(
        fixture.lockPath,
        JSON.stringify(validOwner(2_147_483_647)),
        { mode: 0o600 },
      );
      assert.deepEqual(await removeLegacyMcpEntry({
        rootDir: fixture.rootDir, relativePath: fixture.relativePath,
        format: 'json', mapKey: 'mcpServers', name: 'remove',
      }), { removed: true, residueAbsent: true });
      await assert.rejects(fs.lstat(fixture.lockPath), { code: 'ENOENT' });
    } finally {
      await fs.rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  await t.test('dead publication crash with nlink=2 is normalized then recovered', async () => {
    const fixture = await setup('dead-publish');
    try {
      const owner = validOwner(2_147_483_647);
      const publishPath = path.join(
        path.dirname(fixture.lockPath),
        `${legacyCleanupLockName(fixture.relativePath)}.publish-${owner.token}`,
      );
      await fs.writeFile(publishPath, JSON.stringify(owner), { mode: 0o600 });
      await fs.link(publishPath, fixture.lockPath);
      assert.equal((await fs.stat(fixture.lockPath)).nlink, 2);
      assert.deepEqual(await removeLegacyMcpEntry({
        rootDir: fixture.rootDir, relativePath: fixture.relativePath,
        format: 'json', mapKey: 'mcpServers', name: 'remove',
      }), { removed: true, residueAbsent: true });
      await assert.rejects(fs.lstat(fixture.lockPath), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(publishPath), { code: 'ENOENT' });
    } finally {
      await fs.rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  for (const transition of ['recovery', 'release'] as const) {
    await t.test(`${transition} crash after quarantine link is normalized and recovered`, async () => {
      const fixture = await setup(`${transition}-quarantine-crash`);
      try {
        if (transition === 'recovery') {
          await fs.writeFile(
            fixture.lockPath,
            JSON.stringify(validOwner(2_147_483_647)),
            { mode: 0o600 },
          );
        }
        await runCrashingCleanupWorker([
          fixture.rootDir,
          fixture.relativePath,
          'json',
          'mcpServers',
          'remove',
          `${transition}-after-quarantine-link`,
        ]);
        assert.equal((await fs.stat(fixture.lockPath)).nlink, 2);
        const lockSiblings = (await fs.readdir(path.dirname(fixture.lockPath)))
          .filter((name) => name.includes('.lock'));
        assert.equal(lockSiblings.length, 2);

        const recovered = await removeLegacyMcpEntry({
          rootDir: fixture.rootDir, relativePath: fixture.relativePath,
          format: 'json', mapKey: 'mcpServers', name: 'remove',
        });
        assert.equal(recovered.residueAbsent, true);
        assert.equal(recovered.removed, transition === 'recovery');
        assert.equal(
          (await fs.readdir(path.dirname(fixture.lockPath))).some((name) => name.includes('.lock')),
          false,
        );
      } finally {
        await fs.rm(fixture.sandbox, { recursive: true, force: true });
      }
    });
  }

  await t.test('malformed lock fails without config mutation', async () => {
    const fixture = await setup('malformed');
    try {
      await fs.writeFile(fixture.lockPath, '{not-json', { mode: 0o600 });
      await assert.rejects(removeLegacyMcpEntry({
        rootDir: fixture.rootDir, relativePath: fixture.relativePath,
        format: 'json', mapKey: 'mcpServers', name: 'remove',
      }), (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_LOCK_MALFORMED');
      assert.equal(await fs.readFile(fixture.finalPath, 'utf8'), fixture.original);
    } finally {
      await fs.rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  await t.test('symlink lock fails without touching its target', async () => {
    const fixture = await setup('symlink');
    const victim = path.join(fixture.sandbox, 'victim-lock');
    try {
      await fs.writeFile(victim, 'victim');
      await fs.symlink(victim, fixture.lockPath);
      await assert.rejects(removeLegacyMcpEntry({
        rootDir: fixture.rootDir, relativePath: fixture.relativePath,
        format: 'json', mapKey: 'mcpServers', name: 'remove',
      }), (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_UNSAFE_PATH');
      assert.equal(await fs.readFile(victim, 'utf8'), 'victim');
      assert.equal(await fs.readFile(fixture.finalPath, 'utf8'), fixture.original);
    } finally {
      await fs.rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  await t.test('expired lock owned by a live process is never stolen', async () => {
    const fixture = await setup('live-expired');
    try {
      const owner = validOwner(process.pid, { expired: true });
      let publishAttempts = 0;
      await fs.writeFile(fixture.lockPath, JSON.stringify(owner), { mode: 0o600 });
      await assert.rejects(removeLegacyMcpEntry({
        rootDir: fixture.rootDir, relativePath: fixture.relativePath,
        format: 'json', mapKey: 'mcpServers', name: 'remove',
        testLockWaitLimitMs: 30,
        testBeforeLockPublish: () => { publishAttempts += 1; },
      }), (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_LOCK_TIMEOUT');
      const retained = JSON.parse(await fs.readFile(fixture.lockPath, 'utf8')) as { token: string };
      assert.equal(retained.token, owner.token);
      assert.equal(publishAttempts, 0, 'contention polling must not stage or fsync publication files');
      assert.equal(await fs.readFile(fixture.finalPath, 'utf8'), fixture.original);
    } finally {
      await fs.rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  await t.test('recovery CAS never deletes a swapped-in live owner', async () => {
    const fixture = await setup('recovery-swap');
    const successor = validOwner(process.pid);
    try {
      await fs.writeFile(fixture.lockPath, JSON.stringify(validOwner(2_147_483_647)), { mode: 0o600 });
      await assert.rejects(removeLegacyMcpEntry({
        rootDir: fixture.rootDir, relativePath: fixture.relativePath,
        format: 'json', mapKey: 'mcpServers', name: 'remove',
        testLockHook: async (phase, lockPath) => {
          if (phase !== 'recovery-before-quarantine') return;
          await fs.rm(lockPath);
          await fs.writeFile(lockPath, JSON.stringify(successor), { mode: 0o600 });
        },
      }), (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_LOCK_CHANGED');
      const retained = JSON.parse(await fs.readFile(fixture.lockPath, 'utf8')) as { token: string };
      assert.equal(retained.token, successor.token);
    } finally {
      await fs.rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  await t.test('release CAS never deletes a swapped-in live owner', async () => {
    const fixture = await setup('release-swap');
    const successor = validOwner(process.pid);
    try {
      await assert.rejects(removeLegacyMcpEntry({
        rootDir: fixture.rootDir, relativePath: fixture.relativePath,
        format: 'json', mapKey: 'mcpServers', name: 'remove',
        testLockHook: async (phase, lockPath) => {
          if (phase !== 'release-before-quarantine') return;
          await fs.rm(lockPath);
          await fs.writeFile(lockPath, JSON.stringify(successor), { mode: 0o600 });
        },
      }), (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_LOCK_CHANGED');
      const retained = JSON.parse(await fs.readFile(fixture.lockPath, 'utf8')) as { token: string };
      assert.equal(retained.token, successor.token);
    } finally {
      await fs.rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  await t.test('quasi-valid malformed owner fields fail safe', async () => {
    const malformedOwner = (overrides: Record<string, unknown>) => {
      const owner = { ...validOwner(process.pid), ...overrides };
      if (!Object.prototype.hasOwnProperty.call(overrides, 'fence')) {
        owner.fence = `${owner.createdAt}-${owner.token}`;
      }
      return owner;
    };
    const malformedOwners = [
      malformedOwner({ pid: 0 }),
      malformedOwner({ token: '' }),
      malformedOwner({ token: randomUUID().toUpperCase() }),
      malformedOwner({ token: '00000000-0000-1000-8000-000000000000' }),
      malformedOwner({ token: '00000000-0000-4000-8000-00000000000g' }),
      malformedOwner({ fence: 'short' }),
      malformedOwner({ fence: `${Date.now()}-${randomUUID()}` }),
      malformedOwner({ createdAt: 1.5 }),
      malformedOwner({ createdAt: 0, expiresAt: 1 }),
      malformedOwner({ createdAt: Date.now() + 120_000, expiresAt: Date.now() + 121_000 }),
      malformedOwner({ createdAt: Number.MAX_SAFE_INTEGER, expiresAt: 1 }),
      malformedOwner({ expiresAt: Date.now() + 2 * 24 * 60 * 60 * 1_000 }),
      malformedOwner({ unexpected: true }),
    ];
    for (const [index, owner] of malformedOwners.entries()) {
      const fixture = await setup(`malformed-${index}`);
      try {
        await fs.writeFile(fixture.lockPath, JSON.stringify(owner), { mode: 0o600 });
        await assert.rejects(removeLegacyMcpEntry({
          rootDir: fixture.rootDir, relativePath: fixture.relativePath,
          format: 'json', mapKey: 'mcpServers', name: 'remove',
        }), (error: unknown) => error instanceof AppError && error.code === 'MCP_CLEANUP_LOCK_MALFORMED');
        assert.equal(await fs.readFile(fixture.finalPath, 'utf8'), fixture.original);
      } finally {
        await fs.rm(fixture.sandbox, { recursive: true, force: true });
      }
    }
  });

  await t.test('umask 0777 still publishes a 0600 lock and leaves no orphan', async () => {
    const fixture = await setup('umask');
    const originalUmask = process.umask(0o777);
    try {
      let observedMode = -1;
      assert.deepEqual(await removeLegacyMcpEntry({
        rootDir: fixture.rootDir, relativePath: fixture.relativePath,
        format: 'json', mapKey: 'mcpServers', name: 'remove',
        testAfterLockAcquired: async (lockPath) => {
          observedMode = (await fs.stat(lockPath)).mode & 0o777;
        },
      }), { removed: true, residueAbsent: true });
      assert.equal(observedMode, 0o600);
      await assert.rejects(fs.lstat(fixture.lockPath), { code: 'ENOENT' });
    } finally {
      process.umask(originalUmask);
      await fs.rm(fixture.sandbox, { recursive: true, force: true });
    }
  });

  await t.test('lock publication failures never expose canonical or temp orphans', async () => {
    for (const phase of ['chmod', 'write', 'fsync', 'dir-fsync'] as const) {
      const fixture = await setup(`publish-${phase}`);
      try {
        await assert.rejects(removeLegacyMcpEntry({
          rootDir: fixture.rootDir, relativePath: fixture.relativePath,
          format: 'json', mapKey: 'mcpServers', name: 'remove',
          testLockPublishFault: phase,
        }));
        assert.equal(await fs.readFile(fixture.finalPath, 'utf8'), fixture.original);
        const siblings = await fs.readdir(path.dirname(fixture.finalPath));
        assert.equal(siblings.some((name) => name.includes('.lock')), false);
      } finally {
        await fs.rm(fixture.sandbox, { recursive: true, force: true });
      }
    }
  });
});

/**
 * This test covers Claude MCP support for all scopes (user/local/project) and all transports (stdio/http/sse),
 * including add, update/list, and remove operations.
 */
test('providerMcpService handles claude MCP scopes/transports with file-backed persistence', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-claude-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'my-server'],
      env: { API_KEY: 'secret' },
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-API-Key': 'abc' },
      workspacePath,
    });

    const grouped = await providerMcpService.listProviderMcpServers('claude', { workspacePath });
    assert.ok(grouped.user.some((server) => server.name === 'claude-user-stdio' && server.transport === 'stdio'));
    assert.ok(grouped.local.some((server) => server.name === 'claude-local-http' && server.transport === 'http'));
    assert.ok(grouped.project.some((server) => server.name === 'claude-project-sse' && server.transport === 'sse'));

    // update behavior is the same upsert route with same name
    await providerMcpService.upsertProviderMcpServer('claude', {
      name: 'claude-project-sse',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.com/sse-updated',
      headers: { 'X-API-Key': 'updated' },
      workspacePath,
    });

    const projectConfig = await readJson(path.join(workspacePath, '.mcp.json'));
    const projectServers = projectConfig.mcpServers as Record<string, unknown>;
    const projectServer = projectServers['claude-project-sse'] as Record<string, unknown>;
    assert.equal(projectServer.url, 'https://example.com/sse-updated');
    assert.equal(await modeOf(path.join(workspacePath, '.mcp.json')), 0o600);

    const removeResult = await providerMcpService.removeProviderMcpServer('claude', {
      name: 'claude-local-http',
      scope: 'local',
      workspacePath,
    });
    assert.equal(removeResult.removed, true);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * This test covers Codex MCP support for its real user-only scope, stdio/http
 * formats, and validation for unsupported scope/transport combinations.
 */
test('providerMcpService handles codex MCP TOML config and capability validation', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-codex-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-user-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'python',
      args: ['server.py'],
      env: { API_KEY: 'x' },
      envVars: ['API_KEY'],
      cwd: '/tmp',
    });

    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'codex-user-http',
      scope: 'user',
      transport: 'http',
      url: 'https://codex.example.com/mcp',
      headers: { 'X-Custom-Header': 'value' },
      envHttpHeaders: { 'X-API-Key': 'MY_API_KEY_ENV' },
      bearerTokenEnvVar: 'MY_API_TOKEN',
      workspacePath,
    });

    const userTomlPath = path.join(tempRoot, '.codex', 'config.toml');
    const userConfig = TOML.parse(await fs.readFile(userTomlPath, 'utf8')) as Record<string, unknown>;
    const userServers = userConfig.mcp_servers as Record<string, unknown>;
    const userStdio = userServers['codex-user-stdio'] as Record<string, unknown>;
    assert.equal(userStdio.command, 'python');

    const userHttp = userServers['codex-user-http'] as Record<string, unknown>;
    assert.equal(userHttp.url, 'https://codex.example.com/mcp');
    assert.equal(await modeOf(userTomlPath), 0o600);
    assert.equal(await modeOf(path.dirname(userTomlPath)), 0o700);

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('codex', {
        name: 'codex-local',
        scope: 'local',
        transport: 'stdio',
        command: 'node',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('codex', {
        name: 'codex-project',
        scope: 'project',
        transport: 'http',
        url: 'https://example.com/mcp',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );

    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('codex', {
        name: 'codex-sse',
        scope: 'user',
        transport: 'sse',
        url: 'https://example.com/sse',
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'MCP_TRANSPORT_NOT_SUPPORTED' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('OpenCode MCP stays dormant in the registry while its direct adapter contract is reviewed', async () => {
  assert.equal(providerMcpService.providerWritesPerUserMcpConfig('opencode'), false);
  assert.ok(!providerMcpService.listMcpTargets().some(({ provider }) => provider === 'opencode'));
  await assert.rejects(
    providerMcpService.upsertProviderMcpServer('opencode', {
      name: 'must-stay-dormant',
      scope: 'user',
      transport: 'stdio',
      command: 'false',
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'MCP_SCOPE_NOT_SUPPORTED' &&
      error.statusCode === 400,
  );
});

/**
 * Gemini's pseudo adapter is cleanup-only; Cursor retains its generic manual API.
 */
test('providerMcpService blocks generic Gemini MCP while retaining Cursor manual config', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-gc-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    assert.equal(providerMcpService.providerSupportsMcp('gemini'), false);
    assert.equal(providerMcpService.providerWritesPerUserMcpConfig('gemini'), false);
    const cleanupOnly = new GeminiMcpProvider({ cleanupOnly: true });
    assert.equal(cleanupOnly.supportsMcp, true);
    assert.equal(cleanupOnly.writesPerUserConfig, true);
    assert.deepEqual(await cleanupOnly.listServersForScope('project'), []);
    // 035fe5fb1 (T-1749/ADR-159 D1) unregistered gemini: the service refuses it as an
    // unsupported provider; the HTTP routes keep their 403 GEMINI_GENERIC_MCP_DISABLED.
    await assert.rejects(
      providerMcpService.upsertProviderMcpServer('gemini', {
        name: 'gemini-stdio', scope: 'user', transport: 'stdio', command: 'node',
      }),
      (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_PROVIDER',
    );
    await assert.rejects(
      providerMcpService.listProviderMcpServers('gemini', { workspacePath }),
      (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_PROVIDER',
    );
    await assert.rejects(
      providerMcpService.removeProviderMcpServer('gemini', {
        name: 'gemini-stdio', scope: 'user',
      }),
      (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_PROVIDER',
    );

    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'cursor-stdio',
      scope: 'project',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server'],
      env: { API_KEY: 'value' },
      workspacePath,
    });

    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'cursor-http',
      scope: 'user',
      transport: 'http',
      url: 'http://localhost:3333/mcp',
      headers: { API_KEY: 'value' },
    });

    const cursorUserConfig = await readJson(path.join(tempRoot, '.cursor', 'mcp.json'));
    const cursorHttpServer = (cursorUserConfig.mcpServers as Record<string, unknown>)['cursor-http'] as Record<string, unknown>;
    assert.equal(cursorHttpServer.url, 'http://localhost:3333/mcp');
    assert.equal(cursorHttpServer.type, undefined);
    assert.equal(await modeOf(path.join(tempRoot, '.cursor', 'mcp.json')), 0o600);
    assert.equal(await modeOf(path.join(workspacePath, '.cursor', 'mcp.json')), 0o600);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * The compatibility URL/envelope remains, but the target matrix is explicit.
 */
test('providerMcpService global adder uses explicit scope targets and rejects unsupported transports', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-global-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    const originalListProviders = providerRegistry.listProviders;
    providerRegistry.listProviders = () => {
      throw new Error('global manual add must not iterate the provider registry');
    };
    const globalResult = await (async () => {
      try {
        return await providerMcpService.addMcpServerToAllProviders({
          name: 'global-http',
          scope: 'project',
          transport: 'http',
          url: 'https://global.example.com/mcp',
          workspacePath,
        });
      } finally {
        providerRegistry.listProviders = originalListProviders;
      }
    })();

    assert.equal(globalResult.length, 2);
    const created = globalResult.filter((entry) => entry.created === true);
    const failed = globalResult.filter((entry) => entry.created === false);
    assert.deepEqual(created.map(({ provider }) => provider), ['claude', 'cursor']);
    assert.equal(failed.length, 0);

    const claudeProject = await readJson(path.join(workspacePath, '.mcp.json'));
    assert.ok((claudeProject.mcpServers as Record<string, unknown>)['global-http']);

    const cursorProject = await readJson(path.join(workspacePath, '.cursor', 'mcp.json'));
    assert.ok((cursorProject.mcpServers as Record<string, unknown>)['global-http']);

    await assert.rejects(
      providerMcpService.addMcpServerToAllProviders({
        name: 'global-sse',
        scope: 'project',
        transport: 'sse',
        url: 'https://example.com/sse',
        workspacePath,
      }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_GLOBAL_MCP_TRANSPORT' &&
        error.statusCode === 400,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
