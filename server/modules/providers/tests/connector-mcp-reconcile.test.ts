import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { readJsonConfig, readObjectRecord, writeJsonConfigAtomic } from '@/shared/utils.js';

class TransactionTestProvider extends McpProvider {
  protected override readonly usesLegacyCleanupLock = true;
  lockSnapshots = 0;

  constructor(private readonly file: string) {
    super('claude', ['user'], ['stdio'], true);
  }

  protected override writerTransactionTestHooks() {
    return { testAfterFinalSnapshot: () => { this.lockSnapshots += 1; } };
  }

  protected scopedConfigPath(): string {
    return this.file;
  }

  protected async readScopedServers(
    _scope: McpScope,
    _workspacePath: string,
    _userId?: string | number | null,
    transactionPath?: string,
    transactionSnapshot?: string | null,
  ): Promise<Record<string, unknown>> {
    const config = transactionSnapshot === undefined
      ? await readJsonConfig(transactionPath ?? this.file)
      : transactionSnapshot === null ? {} : JSON.parse(transactionSnapshot) as Record<string, unknown>;
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    _scope: McpScope,
    _workspacePath: string,
    servers: Record<string, unknown>,
    _userId?: string | number | null,
    transactionPath?: string,
    _transactionSnapshot?: string | null,
    beforePromotion?: () => Promise<void>,
    recordPromotion?: Parameters<typeof writeJsonConfigAtomic>[2]['recordPromotion'],
  ): Promise<void> {
    await writeJsonConfigAtomic(transactionPath ?? this.file, { mcpServers: servers }, {
      mode: 0o600,
      directoryPrepared: transactionPath !== undefined,
      beforePromotion,
      recordPromotion,
    });
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    return { command: input.command, args: input.args ?? [] };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    raw: unknown,
  ): ProviderMcpServer | null {
    const value = readObjectRecord(raw);
    if (!value || typeof value.command !== 'string') return null;
    return {
      provider: 'claude', name, scope, transport: 'stdio', command: value.command,
      args: Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === 'string') : [],
    };
  }
}

const desired = (name = 'connector'): UpsertProviderMcpServerInput => ({
  name, scope: 'user', userId: 7, transport: 'stdio', command: 'node', args: ['server.js'],
});

test('connector reconcile owns one canonical lock and returns semantic readback without deadlock', async () => {
  const directory = await mkdtemp('/var/tmp/connector-mcp-reconcile-');
  const file = path.join(directory, 'config.json');
  try {
    const provider = new TransactionTestProvider(file);
    const result = await provider.reconcileUserServer({
      name: 'connector', userId: 7, desired: desired(), decide: () => 'apply',
      assertFenceCurrent: () => {},
      assertAfter: (after) => assert.equal(after.normalized?.command, 'node'),
    });
    assert.equal(provider.lockSnapshots, 1);
    assert.equal(result.applied, true);
    assert.equal(result.after.normalized?.name, 'connector');
    assert.match(await readFile(file, 'utf8'), /server\.js/);

    const collision = await provider.reconcileUserServer({
      name: 'connector', userId: 7, desired: desired(), decide: () => 'keep',
      assertFenceCurrent: () => {},
      assertAfter: (after) => assert.equal(after.normalized?.command, 'node'),
    });
    assert.equal(collision.applied, false);
    assert.equal(provider.lockSnapshots, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('connector reconcile rejects a stale fence after snapshot, before promotion, and after readback', async () => {
  for (const staleAt of [1, 2, 3]) {
    const directory = await mkdtemp('/var/tmp/connector-mcp-stale-');
    try {
      const provider = new TransactionTestProvider(path.join(directory, 'config.json'));
      let checks = 0;
      await assert.rejects(provider.reconcileUserServer({
        name: 'connector', userId: 7, desired: desired(), decide: () => 'apply',
        assertFenceCurrent: () => {
          checks += 1;
          if (checks === staleAt) throw new Error(`stale-${staleAt}`);
        },
        assertAfter: () => {},
      }), new RegExp(`stale-${staleAt}`));
      assert.equal(checks, staleAt);
      assert.equal(provider.lockSnapshots, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('provider service connector adapter fails closed outside Claude and Codex', () => {
  assert.equal(
    providerRegistry.resolveConnectorMcpProvider('claude'),
    providerRegistry.resolveProvider('claude').mcp,
  );
  assert.equal(
    providerRegistry.resolveConnectorMcpProvider('codex'),
    providerRegistry.resolveProvider('codex').mcp,
  );
  assert.throws(
    () => providerMcpService.connectorTargetAdapter('gemini' as 'claude'),
    (error: unknown) => (error as { code?: string }).code === 'CONNECTOR_MCP_TARGET_UNSUPPORTED',
  );
});

test('Claude and Codex connector desiredRaw is provider-native and performs no config I/O', () => {
  const input = desired('nassaj-connector-drive-u7');
  for (const provider of ['claude', 'codex'] as const) {
    const raw = providerMcpService.connectorTargetAdapter(provider).desiredRaw(input);
    assert.equal(raw.command, 'node');
    assert.deepEqual(raw.args, ['server.js']);
    assert.equal('scope' in raw, false);
    assert.equal('userId' in raw, false);
  }
});

test('present malformed entry stays distinguishable and legacy remove still deletes its own key', async () => {
  const directory = await mkdtemp('/var/tmp/connector-mcp-malformed-');
  const file = path.join(directory, 'config.json');
  try {
    await writeFile(file, '{"mcpServers":{"connector":{"unknown":true}}}\n', { mode: 0o600 });
    const provider = new TransactionTestProvider(file);
    let sawMalformed = false;
    const kept = await provider.reconcileUserServer({
      name: 'connector', userId: 7, desired: desired(),
      decide: (current) => {
        sawMalformed = current.present && current.normalized === null;
        return 'keep';
      },
      assertFenceCurrent: () => {},
      assertAfter: (after) => assert.equal(after.present, true),
    });
    assert.equal(sawMalformed, true);
    assert.equal(kept.applied, false);

    const removed = await provider.removeServer({ name: 'connector', scope: 'user', userId: 7 });
    assert.equal(removed.removed, true);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).mcpServers.connector, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
