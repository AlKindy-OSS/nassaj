/**
 * ADR-219 qa ح-1 parity guard: EVERY Claude spawn site in server/ applies the
 * relay policy (`refuse` in relay mode, via the SDK settings or the CLI
 * `--settings` equivalent). A new spawn site fails this test until it is
 * either wired to the policy or listed as exempt with a reason.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../..', import.meta.url));

/** A Claude spawn: the SDK `query(` or the resolved claude binary. */
const SPAWN_MARKER = /\bquery\(\{|resolveHarnessBinary(?:WithOverride)?\('claude'/gu;

/** Wired sites and the evidence that the relay policy reaches every spawn in them. */
const WIRED: Record<string, { evidence: RegExp; spawns: number }> = {
  // run (applyPeerRelayOptions, both query() attempts), command probe and /btw side query.
  'server/claude-sdk.js': { evidence: /\n {4}applyPeerRelayOptions\(sdkOptions, peerRun, peerDelivery\);/u, spawns: 7 },
  'server/modules/providers/list/claude/claude-catalog.client.ts': { evidence: /\.\.\.relaySdkSpawnOptions\(\)/u, spawns: 3 }, // incl. one in a comment
  'server/modules/turn-supervisor/adapters/claude-sdk-adapter.ts': { evidence: /\.\.\.relaySdkSpawnOptions\(\)/u, spawns: 1 },
  'server/modules/workflow-supervisor/resume-turn-runner.ts': { evidence: /\.\.\.relay\.settingsArgs[\s\S]*\.\.\.relay\.disallowedTools/u, spawns: 1 },
  'server/modules/workflow-supervisor/systemd.ts': { evidence: /--relay-refuse/u, spawns: 1 },
};

/** Sites that resolve the binary but never start a session that could receive peers. */
const EXEMPT: Record<string, string> = {
  'server/index.js': 'passes the resolver to the relay CLI-version reader (`--version` only)',
  'server/modules/providers/harness-update/install.service.ts': '`--version` of a freshly installed release',
  'server/modules/providers/list/claude/claude-auth.provider.ts': 'names the resolved path in a message; no spawn',
  'server/modules/execution-permissions/capability-registry.ts': '`--version` probe',
  'server/modules/providers/services/claude-usage.service.ts': '`--version` probe for the User-Agent',
  'server/services/isolation/managed-claude-terminal-env.ts':
    'interactive member terminal (PTY): the member runs claude directly; out of the relay threat model (B-1700)',
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '__tests__' ? [] : sources(full);
    return /\.(ts|js|mjs)$/u.test(entry.name) && !entry.name.includes('.test.') ? [full] : [];
  });
}

test('every Claude spawn site applies the relay policy or is exempt with a reason', () => {
  const found = new Map<string, number>();
  for (const file of sources(path.join(root, 'server'))) {
    const count = [...readFileSync(file, 'utf8').matchAll(SPAWN_MARKER)].length;
    if (count > 0) found.set(path.relative(root, file), count);
  }
  const unknown = [...found.keys()].filter((file) => !(file in WIRED) && !(file in EXEMPT));
  assert.deepEqual(unknown, [], 'new Claude spawn site: wire relaySdkSpawnOptions / relayCliPolicy or exempt it');
  for (const [file, { evidence, spawns }] of Object.entries(WIRED)) {
    const source = readFileSync(path.join(root, file), 'utf8');
    assert.match(source, evidence, `${file} lost its relay policy`);
    assert.equal(found.get(file), spawns, `${file}: spawn count changed — check the new spawn gets the policy`);
  }
});

test('claude-sdk.js: the probe and the /btw side query both spread the spawn settings', () => {
  const source = readFileSync(path.join(root, 'server/claude-sdk.js'), 'utf8');
  assert.equal([...source.matchAll(/\.\.\.peerRelaySpawnSettings\(\)/gu)].length, 2);
});

test('the headless task runner forwards the CLI policy when told the node is in relay mode', () => {
  const runner = readFileSync(path.join(root, 'server/modules/workflow-supervisor/task-runner.ts'), 'utf8');
  assert.match(runner, /--relay-refuse[\s\S]*relayCliArgsForRelayMode\(\)[\s\S]*'--disallowed-tools'/u);
});
