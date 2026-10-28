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

// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mapCliOptionsToSDK, applySettingsPermissionMode, buildValidClaudeModelValues } from './claude-sdk.js';

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

test('T-2071: the permission mode is always passed, default included', () => {
  const modeFor = (options: Record<string, unknown>) =>
    (mapCliOptionsToSDK(options as never, validModels as never) as { permissionMode?: string }).permissionMode;
  assert.equal(modeFor({}), 'default', 'an absent mode is sent as default, never left to the CLI');
  assert.equal(modeFor({ permissionMode: 'default' }), 'default');
  assert.equal(modeFor({ permissionMode: 'acceptEdits' }), 'acceptEdits');
  assert.equal(modeFor({ permissionMode: 'plan' }), 'plan');
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

test('enforce projects full delegation while mechanically denying agent delegation', () => {
  const sdk = mapCliOptionsToSDK({
    permissionMode: 'plan',
    permissionExecution: {
      mode: 'enforce',
      effectivePolicy: { profileId: 'full_delegation' },
    },
    toolsSettings: { allowedTools: ['Read'], disallowedTools: [] },
  } as never, validModels as never) as {
    permissionMode?: string;
    allowDangerouslySkipPermissions?: boolean;
    allowedTools?: string[];
    disallowedTools?: string[];
  };
  assert.equal(sdk.permissionMode, 'bypassPermissions');
  assert.equal(sdk.allowDangerouslySkipPermissions, true);
  assert.ok(!sdk.allowedTools?.includes('Task'));
  assert.ok(!sdk.allowedTools?.includes('Agent'));
  assert.ok(sdk.disallowedTools?.includes('Task'));
  assert.ok(sdk.disallowedTools?.includes('Agent'));
  assert.throws(() => mapCliOptionsToSDK({
    permissionExecution: { mode: 'enforce', effectivePolicy: null },
  } as never, validModels as never), /PERMISSION_EFFECTIVE_POLICY_REQUIRED/u);
});

test('T-2071 M5: an implicit default follows the settings permissions.defaultMode; explicit choices stay', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't2071-m5-'));
  try {
    const configDir = path.join(dir, 'config');
    const managedDir = path.join(dir, 'managed');
    fs.mkdirSync(configDir);
    fs.mkdirSync(managedDir);
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: configDir };
    const run = (options: Record<string, unknown>) => {
      const sdk = mapCliOptionsToSDK({ cwd: dir, ...options } as never, validModels as never) as Record<string, unknown>;
      sdk.env = env;
      return (applySettingsPermissionMode(sdk, { managedSettingsDir: managedDir }) as { permissionMode?: string })
        .permissionMode;
    };
    assert.equal(run({}), 'acceptEdits', 'no mode from the UI: the settings decide');
    assert.equal(run({ permissionMode: 'default' }), 'acceptEdits', 'the composer default is not a choice');
    assert.equal(run({ permissionMode: 'plan' }), 'plan', 'an explicit choice stays');
    assert.equal(run({ permissionMode: 'bypassPermissions' }), 'bypassPermissions');

    fs.writeFileSync(path.join(managedDir, 'managed-settings.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } }));
    assert.equal(run({}), 'plan', 'managed policy wins over user settings');
    fs.writeFileSync(path.join(managedDir, 'managed-settings.json'), '{ broken');
    assert.equal(run({}), 'acceptEdits', 'a malformed file is skipped');
    fs.rmSync(path.join(configDir, 'settings.json'));
    fs.rmSync(path.join(managedDir, 'managed-settings.json'));
    assert.equal(run({}), 'default', 'no settings mode: explicit default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-2071 M5: the parity path is never changed by settings', () => {
  const sdk = mapCliOptionsToSDK({ permissionExecution: { mode: 'enforce',
    effectivePolicy: { profileId: 'full_delegation' } } } as never, validModels as never) as Record<string, unknown>;
  sdk.env = { HOME: '/nonexistent', CLAUDE_CONFIG_DIR: '/nonexistent' };
  assert.equal((applySettingsPermissionMode(sdk) as { permissionMode?: string }).permissionMode, 'bypassPermissions');
});

test('T-2071 I1: project and local-project settings never choose the mode of a run', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't2071-i1-'));
  try {
    const configDir = path.join(dir, 'config');
    const managedDir = path.join(dir, 'managed');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(configDir);
    fs.mkdirSync(managedDir);
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: configDir };
    const run = () => {
      const sdk = mapCliOptionsToSDK({ cwd: dir } as never, validModels as never) as Record<string, unknown>;
      sdk.env = env;
      return (applySettingsPermissionMode(sdk, { managedSettingsDir: managedDir }) as { permissionMode?: string })
        .permissionMode;
    };
    const write = (file: string, mode: string) =>
      fs.writeFileSync(file, JSON.stringify({ permissions: { defaultMode: mode } }));
    write(path.join(dir, '.claude', 'settings.json'), 'acceptEdits');
    assert.equal(run(), 'default', 'project settings are ignored');
    write(path.join(dir, '.claude', 'settings.local.json'), 'dontAsk');
    assert.equal(run(), 'default', 'local project settings are ignored');
    write(path.join(configDir, 'settings.json'), 'plan');
    assert.equal(run(), 'plan', 'the user\'s own settings count');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T-2071 I1: bypassPermissions is never derived from settings', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't2071-i1b-'));
  try {
    const configDir = path.join(dir, 'config');
    const managedDir = path.join(dir, 'managed');
    fs.mkdirSync(configDir);
    fs.mkdirSync(managedDir);
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: configDir };
    const run = () => {
      const sdk = mapCliOptionsToSDK({ cwd: dir } as never, validModels as never) as Record<string, unknown>;
      sdk.env = env;
      const out = applySettingsPermissionMode(sdk, { managedSettingsDir: managedDir }) as Record<string, unknown>;
      return { mode: out.permissionMode, allow: out.allowDangerouslySkipPermissions };
    };
    const write = (file: string, mode: string) =>
      fs.writeFileSync(file, JSON.stringify({ permissions: { defaultMode: mode } }));
    write(path.join(configDir, 'settings.json'), 'bypassPermissions');
    assert.deepEqual(run(), { mode: 'default', allow: undefined }, 'user bypass is ignored');
    write(path.join(managedDir, 'managed-settings.json'), 'bypassPermissions');
    write(path.join(configDir, 'settings.json'), 'acceptEdits');
    assert.deepEqual(run(), { mode: 'acceptEdits', allow: undefined }, 'managed bypass is skipped, next source wins');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
