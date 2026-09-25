import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { HARNESS_UPDATE_DESCRIPTORS } from './descriptors.js';
import {
  _resetHarnessLeases,
  acquireHarnessLease,
  releaseHarnessLease,
} from './lease.js';
import {
  RUN_PROVIDER_TO_HARNESS,
  _resetHarnessLaunches,
  assertHarnessNotUpdating,
  beginHarnessLaunch,
  isHarnessRecoveryBlocked,
  isSpawnBlockedForRunProvider,
  refuseSpawnIfHarnessUpdating,
} from './spawn-admission.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

/** Every provider spawn ENTRY POINT and the run id it must guard with. */
const SPAWN_ENTRY_POINTS: ReadonlyArray<{ file: string; runProvider: string }> = [
  { file: 'claude-sdk.js', runProvider: 'claude' },
  { file: 'openai-codex.js', runProvider: 'codex' },
  { file: 'agy-cli.js', runProvider: 'antigravity' },
  { file: 'cursor-cli.js', runProvider: 'cursor' },
  { file: 'opencode-cli.js', runProvider: 'opencode' },
  { file: 'qwen-cli.js', runProvider: 'qwen' },
  { file: 'kimi-agent-cli.js', runProvider: 'kimi' },
  { file: 'hermes-cli.js', runProvider: 'hermes' },
];

test('every provider spawn entry file consults the harness-update guard', () => {
  for (const { file, runProvider } of SPAWN_ENTRY_POINTS) {
    const source = readFileSync(path.join(SERVER_ROOT, file), 'utf8');
    assert.ok(
      source.includes('refuseSpawnIfHarnessUpdating'),
      `${file} must import/call refuseSpawnIfHarnessUpdating`,
    );
    assert.ok(
      source.includes(`refuseSpawnIfHarnessUpdating('${runProvider}'`),
      `${file} must guard with run id '${runProvider}'`,
    );
  }
});

test('a held lease blocks a spawn of that harness and sends a retryable frame', () => {
  _resetHarnessLeases();
  for (const { runProvider } of SPAWN_ENTRY_POINTS) {
    const harnessId = RUN_PROVIDER_TO_HARNESS[runProvider];
    const sent: Array<Record<string, unknown>> = [];
    const writer = { send: (m: Record<string, unknown>) => sent.push(m) };

    // Allowed when no lease is held.
    assert.equal(refuseSpawnIfHarnessUpdating(runProvider, writer, { sessionId: 's1' }), false);
    assert.equal(sent.length, 0);

    // Blocked while the harness lease is held.
    acquireHarnessLease(harnessId, 'job-1');
    assert.equal(isSpawnBlockedForRunProvider(runProvider), true, runProvider);
    assert.equal(refuseSpawnIfHarnessUpdating(runProvider, writer, { sessionId: 's1' }), true);
    assert.equal(sent.length, 1, runProvider);
    assert.equal(sent[0].code, 'harness_updating');
    assert.equal(sent[0].success, false);
    assert.equal(sent[0].retryable, true);
    assert.equal(sent[0].sessionId, 's1');

    // Allowed again after release.
    releaseHarnessLease(harnessId, 'job-1');
    assert.equal(refuseSpawnIfHarnessUpdating(runProvider, writer, {}), false);
  }
});

test('glm rides the opencode lease; pure-HTTP vendors are never blocked', () => {
  _resetHarnessLeases();
  acquireHarnessLease('opencode', 'job-oc');
  assert.equal(isSpawnBlockedForRunProvider('glm'), true, 'glm via opencode carrier is blocked');
  assert.equal(isSpawnBlockedForRunProvider('opencode'), true);
  releaseHarnessLease('opencode', 'job-oc');
  // deepseek maps to a no-cli harness that is never leased.
  assert.equal(isSpawnBlockedForRunProvider('deepseek'), false);
  assert.equal(isSpawnBlockedForRunProvider('unknown-runtime'), false);
});

test('RUN_PROVIDER_TO_HARNESS is in parity with the descriptor runProviders', () => {
  // Every mapping points at a real harness id…
  for (const [runId, harnessId] of Object.entries(RUN_PROVIDER_TO_HARNESS)) {
    assert.ok(HARNESS_UPDATE_DESCRIPTORS[harnessId], `${runId} → unknown harness ${harnessId}`);
    assert.ok(
      HARNESS_UPDATE_DESCRIPTORS[harnessId].runProviders.includes(runId),
      `${runId} not listed in ${harnessId}.runProviders`,
    );
  }
  // …and every descriptor runProviders entry is COVERED by the map (present as a
  // key), so no spawn site can lack a guard mapping. The mapped harness need not
  // share the run id's name: `glm` self-lists on the no-cli glm descriptor but is
  // deliberately mapped to `opencode` (its carrier binary) for spawn-blocking.
  for (const descriptor of Object.values(HARNESS_UPDATE_DESCRIPTORS)) {
    for (const runId of descriptor.runProviders) {
      assert.ok(
        runId in RUN_PROVIDER_TO_HARNESS,
        `descriptor ${descriptor.id} runProvider ${runId} missing from the spawn-block map`,
      );
    }
  }
});

/**
 * Writer-less spawn sites (T-1749 item 1 audit, section B of the module header).
 * Each must consult the throwing/boolean form of the guard for the harness whose
 * binary it launches, so a secondary path cannot bypass the update admission.
 */
const WRITERLESS_SPAWN_SITES: ReadonlyArray<{ file: string; needle: string }> = [
  { file: 'claude-sdk.js', needle: "assertHarnessNotUpdating('claude')" },
  { file: 'claude-sdk.js', needle: "isSpawnBlockedForRunProvider('claude')" },
  { file: 'modules/providers/list/claude/claude-catalog.client.ts', needle: "beginHarnessLaunch('claude')" },
  { file: 'services/isolation/managed-claude-launcher.ts', needle: "assertHarnessNotUpdating('claude')" },
  { file: 'modules/workflow-supervisor/systemd.ts', needle: "beginHarnessLaunch('claude')" },
  { file: 'modules/workflow-supervisor/resume-turn-runner.ts', needle: "isSpawnBlockedForRunProvider('claude')" },
  { file: 'services/codex-app-server.js', needle: "beginHarnessLaunch('codex')" },
  { file: 'modules/providers/list/codex/codex-credentials.writer.ts', needle: "assertHarnessNotUpdating('codex')" },
  { file: 'modules/turn-supervisor/adapters/claude-sdk-adapter.ts', needle: "isSpawnBlockedForRunProvider('claude')" },
  { file: 'modules/turn-supervisor/adapters/codex-cli-adapter.ts', needle: "isSpawnBlockedForRunProvider('codex')" },
  { file: 'modules/turn-supervisor/adapters/extended-cli-adapter.ts', needle: 'isSpawnBlockedForRunProvider(provider)' },
  { file: 'modules/providers/list/cursor/cursor-models.provider.ts', needle: "beginHarnessLaunch('cursor')" },
  { file: 'modules/providers/list/opencode/opencode-models.provider.ts', needle: "beginHarnessLaunch('opencode')" },
  { file: 'modules/providers/list/antigravity/antigravity-models-cli.client.ts', needle: "beginHarnessLaunch('antigravity')" },
];

test('every writer-less provider spawn site consults the harness-update guard', () => {
  for (const { file, needle } of WRITERLESS_SPAWN_SITES) {
    const source = readFileSync(path.join(SERVER_ROOT, file), 'utf8');
    assert.ok(source.includes(needle), `${file} must call ${needle}`);
  }
});

test('assertHarnessNotUpdating throws a retryable harness_updating error while leased', () => {
  _resetHarnessLeases();
  assert.doesNotThrow(() => assertHarnessNotUpdating('claude'));
  acquireHarnessLease('claude', 'job-assert');
  assert.throws(
    () => assertHarnessNotUpdating('claude'),
    (error: Error & { code?: string; retryable?: boolean }) =>
      error.code === 'harness_updating' && error.retryable === true,
  );
  // An unknown/hosted run id has no updatable binary and never throws.
  assert.doesNotThrow(() => assertHarnessNotUpdating('deepseek'));
  releaseHarnessLease('claude', 'job-assert');
  assert.doesNotThrow(() => assertHarnessNotUpdating('claude'));
});

test('beginHarnessLaunch atomically refuses a child after an update lease wins', () => {
  _resetHarnessLeases();
  _resetHarnessLaunches();
  acquireHarnessLease('kimi', 'job-before-child');
  assert.throws(() => beginHarnessLaunch('kimi'), (error: Error & { code?: string }) =>
    error.code === 'harness_updating');
  releaseHarnessLease('kimi', 'job-before-child');
  const release = beginHarnessLaunch('kimi');
  release();
});

test('an unreadable durable recovery fence blocks admission', () => {
  assert.equal(isHarnessRecoveryBlocked('qwen', () => {
    throw new Error('database unavailable');
  }), true);
});
