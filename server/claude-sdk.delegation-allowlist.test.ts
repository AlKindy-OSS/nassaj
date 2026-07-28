/**
 * Delegation must never require a permission round-trip.
 *
 * Regression lock for the failure the owner hit repeatedly: every Agent/Task call
 * returned "the user doesn't want to proceed with this tool use" although nobody
 * pressed anything, which froze the coordinator convention (delegate first) with
 * no way forward.
 *
 * The refusal never came from nassaj — ZERO [B117-DENY] lines across every pm2
 * log. It came from the CLI, and the cause was NOT the missing allow rule this
 * file locks: the refusals continued after this shipped. The tool is cancelled at
 * ENTRY, before any permission check, because its PreToolUse SDK-callback hook
 * cannot be run once the control stream is closed — see
 * claude-sdk.control-stream.test.ts, which locks the actual fix (a streaming
 * prompt, so the SDK stops closing stdin at the first `result`).
 *
 * What this file still guards: delegation resolves from a settings rule rather
 * than a permission round-trip, matching what managed-settings already declares
 * (`Agent(*)`) — one less moving part in the path that broke.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK, buildValidClaudeModelValues } from './claude-sdk.js';

const validModels = buildValidClaudeModelValues?.() ?? [];

function allowedFor(options: Record<string, unknown>): string[] {
  const sdk = mapCliOptionsToSDK(options as never, validModels as never) as {
    allowedTools?: string[];
  };
  return sdk.allowedTools ?? [];
}

test('the subagent tool is allow-listed in the DEFAULT mode, not only in plan mode', () => {
  const allowed = allowedFor({});
  assert.ok(allowed.includes('Task'), 'Task must not need a permission round-trip');
  assert.ok(allowed.includes('Agent'), 'the alternate spelling must be covered too');
});

test('an explicit permission mode still keeps delegation allow-listed', () => {
  for (const permissionMode of ['default', 'acceptEdits', 'plan']) {
    const allowed = allowedFor({ permissionMode });
    assert.ok(allowed.includes('Task'), `Task missing under permissionMode=${permissionMode}`);
    assert.ok(allowed.includes('Agent'), `Agent missing under permissionMode=${permissionMode}`);
  }
});

test('caller-supplied allowedTools are preserved, and no entry is duplicated', () => {
  const allowed = allowedFor({ toolsSettings: { allowedTools: ['Read', 'Task'] } });
  assert.ok(allowed.includes('Read'), 'caller entries must survive');
  assert.equal(
    allowed.filter((t) => t === 'Task').length,
    1,
    'an already-present entry must not be appended twice',
  );
});

test('allow-listing delegation does NOT widen anything else', () => {
  // The child agent runs under its own permission gates; this change must not
  // quietly hand the parent turn any additional tool.
  const base = allowedFor({});
  const extras = base.filter((t) => t !== 'Task' && t !== 'Agent');
  assert.deepEqual(extras, [], 'default mode must add delegation and nothing more');
});
