/**
 * T-1871 qa condition 2 — every harness spawn crosses the single admission
 * path (spawn-admission.isSpawnBlockedForRunProvider), which blocks it during
 * an update / failed recovery / boot reconcile and notes it in the durable
 * spawn ledger. Three layers:
 *   1. an enumeration of the spawn sites PER HARNESS (GLM carrier, kimi,
 *      workflow/agent runs, qwen, …) and the guard each one calls;
 *   2. a discovery sweep: any server file that resolves a harness binary and
 *      spawns must be enumerated or explicitly exempted — a new bypass fails;
 *   3. behaviour: each guard form notes the spawn in the ledger.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { makeFixtureRoot, removeFixture } from './snapshot/__tests__/fixtures.js';
import {
  _resetHarnessLaunches,
  assertHarnessNotUpdating,
  beginHarnessLaunch,
  isSpawnBlockedForRunProvider,
  refuseSpawnIfHarnessUpdating,
} from './spawn-admission.js';
import { SpawnLedger, _setSharedSpawnLedger } from './spawn-ledger.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

/** Harness → every file that spawns its binary, with the guard call it makes. */
const SPAWN_SITES: Readonly<Record<string, ReadonlyArray<{ file: string; needle: string }>>> = {
  claude: [
    { file: 'claude-sdk.js', needle: "beginHarnessLaunch('claude')" },
    { file: 'claude-sdk.js', needle: "assertHarnessNotUpdating('claude')" },
    { file: 'claude-sdk.js', needle: "isSpawnBlockedForRunProvider('claude')" },
    { file: 'modules/providers/list/claude/claude-catalog.client.ts', needle: "beginHarnessLaunch('claude')" },
    { file: 'services/isolation/managed-claude-launcher.ts', needle: "beginHarnessLaunch('claude')" },
    { file: 'modules/turn-supervisor/adapters/claude-sdk-adapter.ts', needle: "isSpawnBlockedForRunProvider('claude')" },
  ],
  // Workflow / agent runs: the systemd unit (task-runner → claude -p) and the
  // resume-turn runner. A kimi/glm ENGINE session is a claude spawn with an
  // engine env (claude-sdk.js), so it is admitted and noted as claude.
  workflow: [
    { file: 'modules/workflow-supervisor/systemd.ts', needle: "beginHarnessLaunch('claude')" },
    { file: 'modules/workflow-supervisor/resume-turn-runner.ts', needle: "beginHarnessLaunch('claude')" },
  ],
  codex: [
    { file: 'openai-codex.js', needle: "refuseSpawnIfHarnessUpdating('codex'" },
    { file: 'modules/providers/list/codex/codex-reserved-spawn.js', needle: "beginHarnessLaunch('codex')" },
    { file: 'services/codex-app-server.js', needle: 'spawnReservedCodex(' },
    { file: 'modules/providers/list/codex/codex-models-refresh.ts', needle: 'spawnReservedCodex(' },
    { file: 'modules/providers/list/codex/codex-credentials.writer.ts', needle: "assertHarnessNotUpdating('codex')" },
    { file: 'modules/turn-supervisor/adapters/codex-cli-adapter.ts', needle: "isSpawnBlockedForRunProvider('codex')" },
  ],
  antigravity: [
    { file: 'agy-cli.js', needle: "beginHarnessLaunch('antigravity')" },
    { file: 'modules/providers/list/antigravity/antigravity-models-cli.client.ts', needle: "beginHarnessLaunch('antigravity')" },
  ],
  cursor: [
    { file: 'cursor-cli.js', needle: "beginHarnessLaunch('cursor')" },
    { file: 'modules/providers/list/cursor/cursor-models.provider.ts', needle: "beginHarnessLaunch('cursor')" },
    { file: 'modules/providers/list/cursor/cursor-auth.provider.ts', needle: "beginHarnessLaunch('cursor')" },
  ],
  // opencode incl. the GLM carrier (a glm/* model through opencode-cli.js).
  opencode: [
    { file: 'opencode-cli.js', needle: "refuseSpawnIfHarnessUpdating('opencode'" },
    { file: 'opencode-cli.js', needle: 'beginProviderRun(' },
    { file: 'modules/providers/list/opencode/opencode-models.provider.ts', needle: "beginHarnessLaunch('opencode')" },
    { file: 'modules/turn-supervisor/adapters/extended-cli-adapter.ts', needle: 'isSpawnBlockedForRunProvider(provider)' },
  ],
  kimi: [
    { file: 'kimi-agent-cli.js', needle: "beginHarnessLaunch('kimi')" },
  ],
  qwen: [
    { file: 'qwen-cli.js', needle: "beginHarnessLaunch('qwen')" },
    { file: 'modules/turn-supervisor/cli-capability.ts', needle: "beginHarnessLaunch('qwen')" },
  ],
  // Hosted vendor runtimes (glm/kimi chat, deepseek) register through beginProviderRun.
  vendor: [
    { file: 'modules/providers/shared/vendor/vendor-runtime.js', needle: 'beginProviderRun(' },
  ],
  // The managed provider PTY (any harness selected in the shell).
  shell: [
    { file: 'modules/websocket/services/shell-websocket.service.ts', needle: 'beginHarnessLaunch(isolationProvider)' },
  ],
};

/**
 * Files that resolve a harness binary and spawn something, yet need no guard
 * of their own — each with the reason.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'services/isolation/provider-cage-wiring.js': 'launch helper; every caller above is guarded first',
  'services/isolation/vendor-binary-integrity.js': 'digest check only; the spawn is in its guarded caller',
  'shared/claude-cli-path.ts': 'runs where.exe to locate claude on Windows; never the harness',
  'shared/utils.ts': 'isCliInstalled: install-detection probe with no session state',
};

const ADMISSION = /beginHarnessLaunch\(|assertHarnessNotUpdating\(|refuseSpawnIfHarnessUpdating\(|isSpawnBlockedForRunProvider\(|beginProviderRun\(/;
const RESOLVES_HARNESS = /resolveCliExecutablePath\(|resolveClaudeCodeExecutablePath|resolve(Kimi|Cursor|Qwen|OpenCode\w*|Agy\w*|Codex\w*)Binary\w*|claude-agent-sdk['"]/;
const SPAWNS = /\bspawn(Sync)?\(|execFile(Sync)?\(|pty\.spawn\(|\bquery\(|spawnFn\(|spawnFunction\(|crossSpawn\(/;

function read(rel: string): string {
  return fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      // harness-update itself runs the updaters under the lease it owns.
      if (!['node_modules', '__tests__', 'harness-update'].includes(e.name)) sourceFiles(abs, out);
    } else if (/\.(js|ts)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name)) {
      out.push(path.relative(SERVER_ROOT, abs));
    }
  }
  return out;
}

test('every enumerated spawn site of every harness calls its admission guard', () => {
  for (const [harness, sites] of Object.entries(SPAWN_SITES)) {
    for (const { file, needle } of sites) {
      assert.ok(read(file).includes(needle), `${harness}: ${file} must call ${needle}`);
    }
  }
});

test('discovery: a file that resolves a harness binary and spawns is enumerated or exempted', () => {
  const known = new Set(Object.values(SPAWN_SITES).flat().map((s) => s.file));
  const offenders = sourceFiles(SERVER_ROOT).filter((rel) => {
    const src = read(rel);
    if (!RESOLVES_HARNESS.test(src) || !SPAWNS.test(src) || rel in EXEMPT) return false;
    return !(known.has(rel) && ADMISSION.test(src));
  });
  assert.deepEqual(offenders, [], 'new harness spawn site(s) bypass or are not enumerated');
});

test('provider-run presence reserves through beginHarnessLaunch; begin/assert/refuse all reach the admission path', () => {
  assert.match(read('services/provider-run-presence.js'), /launchReservation \?\? beginHarnessLaunch\(provider\)/);
  const admission = read('modules/providers/harness-update/spawn-admission.js');
  assert.match(admission, /export function beginHarnessLaunch[\s\S]*?assertHarnessNotUpdating\(runProviderId\)/);
  assert.match(admission, /export function assertHarnessNotUpdating[\s\S]*?isSpawnBlockedForRunProvider\(runProviderId\)/);
  assert.match(admission, /export function refuseSpawnIfHarnessUpdating[\s\S]*?isSpawnBlockedForRunProvider\(runProviderId\)/);
});

const root = makeFixtureRoot();
after(() => {
  _setSharedSpawnLedger(null);
  removeFixture(root);
});

test('each guard form notes the admitted spawn in the ledger (GLM → opencode, agy → antigravity)', () => {
  let now = 1_000;
  const ledger = new SpawnLedger(path.join(root, 'ledger.json'), () => now);
  _setSharedSpawnLedger(ledger);
  _resetHarnessLaunches();
  for (const h of ['claude', 'codex', 'opencode', 'antigravity', 'kimi']) ledger.recordUpdateSuccess(h, `job-${h}`, 500);
  now = 2_000;
  assert.equal(refuseSpawnIfHarnessUpdating('glm', null), false);
  assertHarnessNotUpdating('kimi');
  beginHarnessLaunch('agy')();
  assert.equal(isSpawnBlockedForRunProvider('codex'), false);
  beginHarnessLaunch('claude')();
  for (const h of ['opencode', 'kimi', 'antigravity', 'codex', 'claude']) {
    assert.deepEqual(ledger.spawnFactsSince(h, `job-${h}`), { firstSpawnAt: 2_000, count: 1, unknown: false }, h);
  }
  assert.equal(isSpawnBlockedForRunProvider('deepseek'), false, 'no binary, never blocked');
});
