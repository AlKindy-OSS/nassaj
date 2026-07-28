/**
 * Tests for resolveDynamicBuiltIns (server/routes/commands.js) — the
 * stale-while-revalidate + cold-start-wait policy behind /api/commands/list
 * (T-75).
 *
 * Coverage:
 *  1. Non-Claude providers always get the static list (no probe).
 *  2. Cold cache + fast probe -> the FIRST request already returns the merged
 *     list (the UI fetches once per project selection, so "static now / full
 *     next time" left the menu incomplete — the original T-75 symptom).
 *  3. Cold cache + slow probe -> bounded wait, static fallback now, merged on
 *     the next request once the probe lands.
 *  4. Expired cache entry -> served STALE immediately (no regression to the
 *     static-only list) while a background refresh updates the cache.
 *  5. Single-flight: concurrent cold requests share one probe.
 *  6. (B-26) The cache is keyed by the probe CONTEXT (effective Claude config
 *     dir), not the provider alone: two users with different config dirs never
 *     share a cache entry (no cross-user leak), while callers sharing a config
 *     dir DO reuse the cache.
 *
 * The SDK probe (getClaudeBuiltInCommands in server/claude-sdk.js) is replaced
 * with node:test module mocking — registered BEFORE commands.js is imported —
 * so no Claude process is ever spawned. COMMANDS_COLD_PROBE_WAIT_MS is pinned
 * low via env (read at module load) to keep the timeout path fast.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

// Must be set before commands.js loads (the constant is read at module scope).
process.env.COMMANDS_COLD_PROBE_WAIT_MS = '120';

// Controllable stand-in for the SDK probe. Each test assigns probeImpl. The
// probe receives the same context object resolveDynamicBuiltIns forwards, so a
// test can make the result depend on context.configDir (B-26 keying).
type ProbeContext = { userId?: unknown; cwd?: unknown; configDir?: unknown };
let probeImpl: (ctx: ProbeContext) => Promise<unknown> = async () => null;
let probeCalls = 0;

const claudeSdkUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../claude-sdk.js')
).href;

// Register ONCE (node:test forbids re-mocking a specifier). Only the named
// export commands.js consumes needs a real implementation.
mock.module(claudeSdkUrl, {
  namedExports: {
    getClaudeBuiltInCommands: (ctx: ProbeContext = {}) => {
      probeCalls += 1;
      return probeImpl(ctx);
    },
  },
});

const commandsModule = await import('../commands.js');
const {
  resolveDynamicBuiltIns,
  builtInCommands,
  _resetDynamicBuiltInsForTests,
  _seedDynamicBuiltInsForTests,
} = commandsModule as unknown as {
  resolveDynamicBuiltIns: (
    provider: string,
    context: Record<string, unknown>
  ) => Promise<Array<{ name: string; metadata?: Record<string, unknown> }>>;
  builtInCommands: Array<{ name: string }>;
  _resetDynamicBuiltInsForTests: () => void;
  _seedDynamicBuiltInsForTests: (
    provider: string,
    commands: unknown[],
    expiresAt: number,
    context?: Record<string, unknown>
  ) => void;
};

const CONTEXT = { userId: 1, cwd: '/tmp' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.beforeEach(() => {
  _resetDynamicBuiltInsForTests();
  probeCalls = 0;
  probeImpl = async () => null;
});

// --- B-26: cache keyed by probe context (effective Claude config dir) ---

// Two users under multi-user isolation get distinct CLAUDE_CONFIG_DIRs.
const USER_A = { userId: 1, cwd: '/tmp', configDir: '/home/dev/.nassaj-users/1/.claude' };
const USER_B = { userId: 2, cwd: '/tmp', configDir: '/home/dev/.nassaj-users/2/.claude' };

test('B-26: different config dirs do NOT share a cache entry (no cross-user leak)', async () => {
  // The probe returns a per-config command set, so a leak would be observable.
  probeImpl = async (ctx) => {
    if (ctx.configDir === USER_A.configDir) {
      return [{ name: 'user-a-only', description: 'A private command' }];
    }
    if (ctx.configDir === USER_B.configDir) {
      return [{ name: 'user-b-only', description: 'B private command' }];
    }
    return [];
  };

  const listA = await resolveDynamicBuiltIns('claude', USER_A);
  assert.ok(
    listA.some((c) => c.name === '/user-a-only'),
    "user A must see A's own commands"
  );

  const listB = await resolveDynamicBuiltIns('claude', USER_B);
  assert.ok(
    listB.some((c) => c.name === '/user-b-only'),
    "user B must see B's own commands"
  );
  // The decisive assertion: B never receives A's cached set, and vice-versa.
  assert.ok(
    !listB.some((c) => c.name === '/user-a-only'),
    "user B must NOT inherit user A's cached commands"
  );
  assert.ok(
    !listA.some((c) => c.name === '/user-b-only'),
    "user A must NOT inherit user B's cached commands"
  );
  // Each context cold-probed exactly once: two distinct cache keys.
  assert.equal(probeCalls, 2, 'each distinct config dir must probe separately');
});

test('B-26: the SAME config dir reuses the cache (no second probe)', async () => {
  probeImpl = async () => [{ name: 'shared-cmd', description: 'Shared command' }];

  const first = await resolveDynamicBuiltIns('claude', USER_A);
  assert.ok(first.some((c) => c.name === '/shared-cmd'));
  assert.equal(probeCalls, 1, 'cold request probes once');

  // Second request with the SAME configDir hits the warm cache — no new probe.
  const second = await resolveDynamicBuiltIns('claude', USER_A);
  assert.ok(second.some((c) => c.name === '/shared-cmd'));
  assert.equal(probeCalls, 1, 'same context must reuse the cache, not re-probe');
});

test('B-26: a seeded entry for one config dir is NOT served to another', async () => {
  // Warm cache for USER_A with a fresh (non-expired) entry.
  _seedDynamicBuiltInsForTests(
    'claude',
    [{ name: 'a-seeded', description: 'A seeded command' }],
    Date.now() + 60_000,
    USER_A
  );
  // USER_B is still cold and must trigger its own probe.
  probeImpl = async () => [{ name: 'b-fresh', description: 'B fresh command' }];

  const listB = await resolveDynamicBuiltIns('claude', USER_B);
  assert.ok(listB.some((c) => c.name === '/b-fresh'), 'B probes for its own set');
  assert.ok(
    !listB.some((c) => c.name === '/a-seeded'),
    "B must not be served A's seeded cache entry"
  );
  assert.equal(probeCalls, 1, "A's seeded entry must not satisfy B's request");

  // USER_A still reads its seeded entry from cache without probing.
  const listA = await resolveDynamicBuiltIns('claude', USER_A);
  assert.ok(listA.some((c) => c.name === '/a-seeded'));
  assert.equal(probeCalls, 1, "A's warm seeded entry must not re-probe");
});

test('non-claude provider returns the static list and never probes', async () => {
  const list = await resolveDynamicBuiltIns('cursor', CONTEXT);
  assert.deepEqual(list, builtInCommands);
  assert.equal(probeCalls, 0);
});

test('cold cache + fast probe: FIRST request already includes dynamic commands', async () => {
  probeImpl = async () => [
    { name: 'context', description: 'Show current context usage' },
  ];

  const list = await resolveDynamicBuiltIns('claude', CONTEXT);

  const added = list.find((c) => c.name === '/context');
  assert.ok(added, 'dynamic /context must be present on the first request');
  assert.equal(added?.metadata?.hasHandler, false, 'dynamic commands are passthrough');
  // Static layer intact underneath.
  for (const staticCmd of builtInCommands) {
    assert.ok(list.some((c) => c.name === staticCmd.name));
  }
});

test('cold cache + slow probe: static fallback now, merged once the probe lands', async () => {
  // Probe resolves AFTER the 120ms cold wait.
  probeImpl = async () => {
    await sleep(300);
    return [{ name: 'insights', description: 'Generate a usage report' }];
  };

  const first = await resolveDynamicBuiltIns('claude', CONTEXT);
  assert.deepEqual(first, builtInCommands, 'cold overrun must fall back to static');

  // Let the in-flight probe finish populating the cache.
  await sleep(350);

  const second = await resolveDynamicBuiltIns('claude', CONTEXT);
  assert.ok(
    second.some((c) => c.name === '/insights'),
    'next request must see the cached dynamic command'
  );
  assert.equal(probeCalls, 1, 'the overrun probe must be reused, not re-spawned');
});

test('expired cache: serves the STALE merged list immediately, refreshes in background', async () => {
  _seedDynamicBuiltInsForTests(
    'claude',
    [{ name: 'goal', description: 'Set a goal' }],
    Date.now() - 1000 // already expired
  );
  // Background refresh is slow AND returns a different set.
  probeImpl = async () => {
    await sleep(150);
    return [{ name: 'usage-credits', description: 'Configure usage credits' }];
  };

  const stale = await resolveDynamicBuiltIns('claude', CONTEXT);
  assert.ok(
    stale.some((c) => c.name === '/goal'),
    'expired entry must still be served (no regression to static-only)'
  );
  assert.equal(probeCalls, 1, 'a background refresh must have been triggered');

  await sleep(250);

  const refreshed = await resolveDynamicBuiltIns('claude', CONTEXT);
  assert.ok(
    refreshed.some((c) => c.name === '/usage-credits'),
    'after the background refresh the new set must be served'
  );
  assert.ok(
    !refreshed.some((c) => c.name === '/goal'),
    'the stale set must have been replaced'
  );
});

test('single-flight: concurrent cold requests share one probe', async () => {
  probeImpl = async () => {
    await sleep(50);
    return [{ name: 'team-onboarding', description: 'Onboarding guide' }];
  };

  const [a, b, c] = await Promise.all([
    resolveDynamicBuiltIns('claude', CONTEXT),
    resolveDynamicBuiltIns('claude', CONTEXT),
    resolveDynamicBuiltIns('claude', CONTEXT),
  ]);

  assert.equal(probeCalls, 1, 'concurrent requests must coalesce into one probe');
  for (const list of [a, b, c]) {
    assert.ok(list.some((cmd) => cmd.name === '/team-onboarding'));
  }
});
