/** B-1707: Claude's permission-mode resolver, shared with every harness (owner ruling 2026-10-28). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  isClaudeBypassDisabledBySettings,
  resolveClaudeEffectivePermissionMode,
  resolveClaudeRequestedPermissionMode,
} from './claude-permission-mode.js';

const root = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'claude-perm-mode-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
/** A fresh Claude layout: user config dir, managed dir, project cwd. */
function layout(user?: object, managed?: object, project?: object) {
  seq += 1;
  const base = path.join(root, `case-${seq}`);
  const configDir = path.join(base, 'config');
  const managedDir = path.join(base, 'managed');
  const cwd = path.join(base, 'project');
  for (const dir of [configDir, managedDir, path.join(cwd, '.claude')]) fs.mkdirSync(dir, { recursive: true });
  if (user) fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(user));
  if (managed) fs.writeFileSync(path.join(managedDir, 'managed-settings.json'), JSON.stringify(managed));
  if (project) fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify(project));
  return {
    env: { HOME: base, CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
    cwd,
    managedSettingsDir: managedDir,
  };
}

const full = { mode: 'enforce', effectivePolicy: { profileId: 'full_delegation' } };

describe('resolveClaudeRequestedPermissionMode (layer 1, the mapCliOptionsToSDK inputs)', () => {
  it('an absent mode is an implicit default', () => {
    assert.deepEqual(resolveClaudeRequestedPermissionMode({}),
      { parityEnforced: false, requested: undefined, mode: 'default', implicit: true });
  });

  it('an explicit default is implicit too (the composer default is not a choice, T-2071)', () => {
    assert.equal(resolveClaudeRequestedPermissionMode({ permissionMode: 'default' }).implicit, true);
  });

  it('keeps other explicit modes', () => {
    for (const mode of ['acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
      const r = resolveClaudeRequestedPermissionMode({ permissionMode: mode });
      assert.equal(r.mode, mode);
      assert.equal(r.implicit, false);
    }
  });

  it('skipPermissions lifts any non-plan mode to bypass, never plan', () => {
    assert.equal(resolveClaudeRequestedPermissionMode({ toolsSettings: { skipPermissions: true } }).mode,
      'bypassPermissions');
    assert.equal(resolveClaudeRequestedPermissionMode({
      permissionMode: 'acceptEdits', toolsSettings: { skipPermissions: true },
    }).mode, 'bypassPermissions');
    const plan = resolveClaudeRequestedPermissionMode({ permissionMode: 'plan', toolsSettings: { skipPermissions: true } });
    assert.equal(plan.mode, 'plan');
    assert.equal(plan.requested, 'plan');
  });

  it('parity enforce + full_delegation is bypass whatever the request says', () => {
    const r = resolveClaudeRequestedPermissionMode({ permissionMode: 'plan', permissionExecution: full });
    assert.deepEqual(r, { parityEnforced: true, requested: 'bypassPermissions', mode: 'bypassPermissions', implicit: false });
  });

  it('parity enforce with another profile refuses, as the Claude spawn does', () => {
    for (const effectivePolicy of [null, { profileId: 'read_only' }]) {
      assert.throws(() => resolveClaudeRequestedPermissionMode({
        permissionExecution: { mode: 'enforce', effectivePolicy },
      }), /PERMISSION_EFFECTIVE_POLICY_REQUIRED/);
    }
  });

  it('legacy and shadow executions defer to the request', () => {
    for (const mode of ['legacy', 'shadow']) {
      assert.equal(resolveClaudeRequestedPermissionMode({
        permissionMode: 'plan', permissionExecution: { mode, effectivePolicy: null },
      }).mode, 'plan');
    }
  });
});

describe('resolveClaudeEffectivePermissionMode (layers 1-3)', () => {
  it('an implicit default follows the user settings defaultMode', () => {
    const l = layout({ permissions: { defaultMode: 'acceptEdits' } });
    assert.equal(resolveClaudeEffectivePermissionMode({}, l), 'acceptEdits');
  });

  it('managed settings win over user settings for the defaultMode', () => {
    const l = layout({ permissions: { defaultMode: 'acceptEdits' } }, { permissions: { defaultMode: 'plan' } });
    assert.equal(resolveClaudeEffectivePermissionMode({ permissionMode: 'default' }, l), 'plan');
  });

  it('a settings defaultMode never yields bypass, and project settings never choose', () => {
    assert.equal(resolveClaudeEffectivePermissionMode({},
      layout({ permissions: { defaultMode: 'bypassPermissions' } })), 'default');
    assert.equal(resolveClaudeEffectivePermissionMode({},
      layout(undefined, undefined, { permissions: { defaultMode: 'plan' } })), 'default');
  });

  it('an explicit mode ignores the settings defaultMode', () => {
    const l = layout({ permissions: { defaultMode: 'plan' } });
    assert.equal(resolveClaudeEffectivePermissionMode({ permissionMode: 'bypassPermissions' }, l), 'bypassPermissions');
  });

  it('disableBypassPermissionsMode in any source turns bypass into default (the CLI gate)', () => {
    const gate = { permissions: { disableBypassPermissionsMode: 'disable' } };
    for (const l of [layout(gate), layout(undefined, gate), layout(undefined, undefined, gate)]) {
      assert.equal(resolveClaudeEffectivePermissionMode({ permissionMode: 'bypassPermissions' }, l), 'default');
      assert.equal(resolveClaudeEffectivePermissionMode({ permissionExecution: full }, l), 'default');
      assert.equal(resolveClaudeEffectivePermissionMode({ permissionMode: 'plan' }, l), 'plan');
    }
  });

  it('without the gate, parity and skipPermissions reach bypass', () => {
    const l = layout();
    assert.equal(resolveClaudeEffectivePermissionMode({ permissionExecution: full }, l), 'bypassPermissions');
    assert.equal(resolveClaudeEffectivePermissionMode({ toolsSettings: { skipPermissions: true } }, l),
      'bypassPermissions');
  });

  it('a malformed settings file counts as disabling bypass (Claude would refuse the spawn)', () => {
    const l = layout();
    fs.writeFileSync(path.join(l.env.CLAUDE_CONFIG_DIR as string, 'settings.json'), '{not json');
    assert.equal(isClaudeBypassDisabledBySettings(l.env, l.cwd, l), true);
    assert.equal(resolveClaudeEffectivePermissionMode({ permissionMode: 'bypassPermissions' }, l), 'default');
  });

  it('no Claude env for the user fails closed: plan stays plan, everything else is default', () => {
    assert.equal(resolveClaudeEffectivePermissionMode({ permissionMode: 'bypassPermissions' }, { env: null }), 'default');
    assert.equal(resolveClaudeEffectivePermissionMode({ permissionMode: 'plan' }, { env: null }), 'plan');
  });
});
