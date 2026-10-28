/** B-1707: OpenCode turn permissions = Claude's (owner ruling 2026-10-28), and honest stderr. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  OPENCODE_CLI_ARGS_REJECTED_CODE,
  OPENCODE_PERMISSION_AUTO_REJECTED_CODE,
  OPENCODE_PERMISSION_ENV,
  createOpenCodeStderrReader,
  openCodeAutoRejectedError,
  readOpenCodeAutoRejectedPermission,
  resolveOpenCodePermissionLaunch,
  withOpenCodePermissionEnv,
} from './opencode-run-permissions.js';

const root = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'oc-run-perm-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
/** Claude's env for a user with these user/managed settings, as a launch seam. */
function claudeLayout(user?: object, managed?: object) {
  seq += 1;
  const base = path.join(root, `case-${seq}`);
  const configDir = path.join(base, 'config');
  const managedSettingsDir = path.join(base, 'managed');
  const cwd = path.join(base, 'project');
  for (const dir of [configDir, managedSettingsDir, cwd]) fs.mkdirSync(dir, { recursive: true });
  if (user) fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(user));
  if (managed) fs.writeFileSync(path.join(managedSettingsDir, 'managed-settings.json'), JSON.stringify(managed));
  const env = { HOME: base, CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  const seen: Array<string | number | null> = [];
  return {
    cwd,
    seen,
    deps: { claudeEnv: (userId: string | number | null) => { seen.push(userId); return env; }, managedSettingsDir },
  };
}

const launch = (options: Record<string, unknown>, l = claudeLayout()) =>
  resolveOpenCodePermissionLaunch(options, { userId: 7, cwd: l.cwd }, l.deps);

const SKIP = '--dangerously-skip-permissions';
const full = { mode: 'enforce', effectivePolicy: { profileId: 'full_delegation' } };

describe('resolveOpenCodePermissionLaunch — Claude mode → OpenCode args', () => {
  it('asks Claude\'s env for the SENDER (same user as the Claude spawn)', () => {
    const l = claudeLayout();
    launch({}, l);
    assert.deepEqual(l.seen, [7]);
  });

  it('no mode and no settings defaultMode = Claude default → no flag, no permission', () => {
    assert.deepEqual(launch({}), { claudeMode: 'default', args: [], permission: null });
  });

  it('no mode + settings defaultMode plan → plan (absent mode resolves as Claude does)', () => {
    const r = launch({}, claudeLayout({ permissions: { defaultMode: 'plan' } }));
    assert.equal(r.claudeMode, 'plan');
    assert.deepEqual(r.args, ['--agent', 'plan']);
    assert.deepEqual(JSON.parse(r.permission ?? 'null'), { edit: 'deny', bash: 'deny' });
  });

  it('bypassPermissions, skipPermissions and parity full_delegation → the skip flag', () => {
    for (const options of [
      { permissionMode: 'bypassPermissions' },
      { toolsSettings: { skipPermissions: true } },
      { permissionMode: 'default', permissionExecution: full },
    ]) {
      const r = launch(options);
      assert.equal(r.claudeMode, 'bypassPermissions', JSON.stringify(options));
      assert.deepEqual(r.args, [SKIP]);
      assert.equal(r.permission, null);
    }
  });

  it('the settings bypass gate applies to OpenCode exactly as to Claude', () => {
    const gated = claudeLayout(undefined, { permissions: { disableBypassPermissionsMode: 'disable' } });
    const r = launch({ permissionMode: 'bypassPermissions' }, gated);
    assert.equal(r.claudeMode, 'default');
    assert.deepEqual(r.args, []);
  });

  it('acceptEdits / auto / dontAsk → no flag (documented gap: OpenCode own rules)', () => {
    for (const permissionMode of ['acceptEdits', 'auto', 'dontAsk']) {
      assert.deepEqual(launch({ permissionMode }).args, [], permissionMode);
    }
  });

  it('parity enforce without full_delegation refuses, as Claude does', () => {
    assert.throws(() => launch({ permissionExecution: { mode: 'enforce', effectivePolicy: null } }),
      /PERMISSION_EFFECTIVE_POLICY_REQUIRED/);
  });

  it('no Claude env for the sender fails closed to default', () => {
    const r = resolveOpenCodePermissionLaunch({ permissionMode: 'bypassPermissions' }, { userId: 7, cwd: null },
      { claudeEnv: () => null });
    assert.deepEqual(r, { claudeMode: 'default', args: [], permission: null });
  });

  it('carrier turns are not special-cased (GLM follows the same table)', () => {
    assert.deepEqual(launch({ carrier: true, permissionMode: 'bypassPermissions' }).args, [SKIP]);
  });
});

describe('withOpenCodePermissionEnv', () => {
  it('drops an inherited OPENCODE_PERMISSION and sets only nassaj\'s', () => {
    const inherited = { PATH: '/bin', [OPENCODE_PERMISSION_ENV]: '{"*":"allow"}' };
    assert.equal(OPENCODE_PERMISSION_ENV, 'OPENCODE_PERMISSION');
    assert.equal(Object.hasOwn(withOpenCodePermissionEnv(inherited, null), OPENCODE_PERMISSION_ENV), false);
    assert.equal(withOpenCodePermissionEnv(inherited, '{"edit":"deny"}')[OPENCODE_PERMISSION_ENV], '{"edit":"deny"}');
    assert.equal(inherited[OPENCODE_PERMISSION_ENV], '{"*":"allow"}', 'input not mutated');
  });
});

describe('readOpenCodeAutoRejectedPermission', () => {
  it('reads the coloured stderr line opencode 1.19.3 printed (captured 2026-10-28)', () => {
    const line = '\u001b[93m\u001b[1m! \u001b[0mpermission requested: external_directory '
      + '(/var/tmp/b1707-smoke/outside/*); auto-rejecting';
    assert.equal(readOpenCodeAutoRejectedPermission(line), 'external_directory');
  });

  it('ignores any other stderr line', () => {
    for (const line of ['', 'permission requested: bash (ls)', 'Error: x', 'auto-rejecting',
      'permission requested: ; auto-rejecting']) {
      assert.equal(readOpenCodeAutoRejectedPermission(line), null, line);
    }
    assert.equal(readOpenCodeAutoRejectedPermission(undefined), null);
  });

  it('the error names the permission, says no one was asked, and keeps the path out', () => {
    const frame = openCodeAutoRejectedError('external_directory');
    assert.equal(frame.code, OPENCODE_PERMISSION_AUTO_REJECTED_CODE);
    assert.match(frame.content, /"external_directory"/);
    assert.match(frame.content, /no one was asked/);
    assert.doesNotMatch(frame.content, /\//);
  });
});

describe('createOpenCodeStderrReader', () => {
  const reject = (name: string, pattern: string) => `! permission requested: ${name} (${pattern}); auto-rejecting`;

  it('one error per permission name per turn (P2)', () => {
    const reader = createOpenCodeStderrReader();
    const kinds = [
      reader.read(reject('external_directory', '/a/*')),
      reader.read(reject('external_directory', '/b/*')),
      reader.read(reject('bash', 'rm x')),
      reader.read(reject('bash', 'rm y')),
    ].map((v) => (v.kind === 'error' ? v.error.content.match(/"(\w+)"/)?.[1] : v.kind));
    assert.deepEqual(kinds, ['external_directory', 'drop', 'bash', 'drop']);
    assert.equal(createOpenCodeStderrReader().read(reject('bash', 'x')).kind, 'error', 'a new turn reports again');
  });

  it('a usage dump (refused argv) is one opencode_cli_args_rejected error, the rest dropped (I1)', () => {
    const reader = createOpenCodeStderrReader();
    const first = reader.read('opencode run [message..]');
    assert.equal(first.kind, 'error');
    assert.equal(first.kind === 'error' && first.error.code, OPENCODE_CLI_ARGS_REJECTED_CODE);
    for (const line of ['', 'run opencode with a message', '      --auto  auto-approve ...',
      reject('bash', 'x'), 'Error: anything']) {
      assert.equal(reader.read(line).kind, 'drop', line);
    }
  });

  it('plain lines stay plain', () => {
    assert.deepEqual(createOpenCodeStderrReader().read('some warning'), { kind: 'plain' });
  });
});
