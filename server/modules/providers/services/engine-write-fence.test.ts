/**
 * engine-write-fence.test.ts — T-1209.
 *
 * The fence itself lives inside `runClaudeSDKQuery`'s `canUseTool` closure, which
 * no test can reach without spawning a full run. What IS testable — and what the
 * guarantee actually rests on — are the two decisions that closure makes:
 *
 *   1. WHICH tools are fenced (the set), and
 *   2. WHEN the fence is on (the flag's default and its off-switch).
 *
 * Both are asserted here against the real exported values, plus the ordering
 * property that makes the fence work at all: it is evaluated BEFORE the
 * `bypassPermissions` short-circuit. That ordering is pinned by a source
 * assertion rather than a behavioural one, deliberately — a fence expressed only
 * in `disallowedTools` would be dead code in bypass mode (the `cleanSpawnEnv`
 * shape this repo has already paid for), and a comment cannot fail a build.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_SDK_SOURCE = fs.readFileSync(
  path.join(HERE, '..', '..', '..', 'claude-sdk.js'),
  'utf8',
);

// ── 1. the fenced set ─────────────────────────────────────────────────────────

test('fence: every mutating and executing tool is fenced', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'BashOutput', 'KillShell']) {
    assert.match(
      CLAUDE_SDK_SOURCE,
      new RegExp(`ENGINE_FENCED_TOOLS[\\s\\S]{0,200}'${tool}'`),
      `${tool} must be fenced on a vendor engine`,
    );
  }
});

test('fence: read-only tools are NOT fenced — the free engine exists to read', () => {
  const fencedBlock = /const ENGINE_FENCED_TOOLS = new Set\(\[([\s\S]*?)\]\)/.exec(CLAUDE_SDK_SOURCE);
  assert.ok(fencedBlock, 'the fenced set must be declared as a literal');
  const body = fencedBlock![1];
  // Summarising, classifying and reading are the whole point of the free engine
  // (T-1209). A garbled read costs a turn; a garbled Write costs a file.
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task']) {
    assert.doesNotMatch(body, new RegExp(`'${tool}'`), `${tool} must stay available`);
  }
});

// ── 2. the flag ───────────────────────────────────────────────────────────────

test('flag: the fence defaults ON and only an explicit 0/false turns it off', () => {
  // Fail-safe, not fail-open: the cost of being wrong is asymmetric — a needless
  // denial wastes a turn and says why; a needless permission truncates a file.
  const fn = /function isEngineWriteFenceEnabled\(\)\s*\{([\s\S]*?)\n\}/.exec(CLAUDE_SDK_SOURCE);
  assert.ok(fn, 'the flag reader must exist');
  const body = fn![1];
  assert.match(body, /NASSAJ_ENGINE_WRITE_FENCE/, 'the flag is named');
  assert.match(body, /!==\s*'0'/, "'0' turns the fence off");
  assert.match(body, /!==\s*'false'/, "'false' turns the fence off");
  // Read per spawn, never captured at import: an operator may flip it without a
  // restart, and a module-level constant would silently ignore that.
  assert.match(body, /process\.env\.NASSAJ_ENGINE_WRITE_FENCE/, 'read from env at call time');
});

test('flag: the fence follows the ENGAGED engine, never the client’s word', () => {
  // `injectedHosts !== null` is the same proof of engagement recordSessionEnginePin
  // trusts. Keying off options.engineProvider would let a client claim an engine
  // it never got — or, worse, disclaim one it did.
  assert.match(
    CLAUDE_SDK_SOURCE,
    /engineWriteFenceActive = injectedHosts !== null && isEngineWriteFenceEnabled\(\)/,
    'the fence is armed from the resolved verdict',
  );
});

// ── 3. the ordering that makes it real ────────────────────────────────────────

test('order: the fence is checked BEFORE the bypassPermissions short-circuit', () => {
  const fenceAt = CLAUDE_SDK_SOURCE.indexOf('engineWriteFenceActive && ENGINE_FENCED_TOOLS.has(toolName)');
  const bypassAt = CLAUDE_SDK_SOURCE.indexOf("sdkOptions.permissionMode === 'bypassPermissions'");
  assert.ok(fenceAt > 0, 'the fence check must exist');
  assert.ok(bypassAt > 0, 'the bypass check must exist');
  // bypassPermissions returns `allow` before disallowedTools is ever consulted,
  // so a fence placed after it would be dead code in exactly the mode that needs
  // it most.
  assert.ok(
    fenceAt < bypassAt,
    'the engine write fence must precede the bypass short-circuit, or it is unenforceable',
  );
});

test('order: the denial names the engine and the way out', () => {
  const fenceBlock = CLAUDE_SDK_SOURCE.slice(
    CLAUDE_SDK_SOURCE.indexOf('engineWriteFenceActive && ENGINE_FENCED_TOOLS.has(toolName)'),
    CLAUDE_SDK_SOURCE.indexOf('if (!requiresInteraction) {'),
  );
  assert.match(fenceBlock, /engineProviderLabel\(/, 'the denial names the engine, not "Claude"');
  assert.match(fenceBlock, /engine-write-fence/, 'the denial is logged under its own reason code');
  assert.match(fenceBlock, /official/i, 'the denial states the way out');
});
