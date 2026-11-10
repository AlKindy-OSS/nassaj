/** B-1707 / ADR-226: OpenCode turn permissions = Claude's (owner ruling 2026-10-28), and honest stderr. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  OPENCODE_CLI_ARGS_REJECTED_CODE,
  OPENCODE_PERMISSION_AUTO_REJECTED_CODE,
  createOpenCodeStderrReader,
  openCodeAutoRejectedError,
  readOpenCodeAutoRejectedPermission,
  resolveOpenCodePermissionParity,
} from './opencode-run-permissions.js';
import { OPENCODE_PROJECT_CONFIG_OFF_FOR_EVERY_SPAWN, applyOpenCodeParityEnv, ensureParityPluginDir } from './opencode-parity-launch.js';

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
  fs.writeFileSync(path.join(managedSettingsDir, 'managed-settings.json'), JSON.stringify(managed ?? {}));
  const env = { HOME: base, CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;
  const seen: Array<string | number | null> = [];
  return {
    cwd,
    seen,
    deps: { claudeEnv: (userId: string | number | null) => { seen.push(userId); return env; }, managedSettingsDir },
  };
}

const launch = (options: Record<string, unknown>, l = claudeLayout()) =>
  resolveOpenCodePermissionParity(options, { userId: 7, cwd: l.cwd }, l.deps);

const SKIP = '--dangerously-skip-permissions';
const full = { mode: 'enforce', effectivePolicy: { profileId: 'full_delegation' } };

describe('resolveOpenCodePermissionParity — Claude mode → OpenCode args, L1 and the engine', () => {
  it('asks Claude\'s env for the SENDER, once (the same env feeds the mode, L1 and the engine)', () => {
    const l = claudeLayout();
    launch({}, l);
    assert.deepEqual(l.seen, [7]);
  });

  it('no mode and no settings defaultMode = Claude default → no flag, L1 = allow-all', () => {
    const r = launch({});
    assert.deepEqual([r.claudeMode, r.args, JSON.parse(r.permission)], ['default', [], { '*': 'allow' }]);
  });

  it('no mode + settings defaultMode plan → plan: `--agent plan` and the plan block after allow-all', () => {
    const r = launch({}, claudeLayout({ permissions: { defaultMode: 'plan' } }));
    assert.equal(r.claudeMode, 'plan');
    assert.deepEqual(r.args, ['--agent', 'plan']);
    assert.deepEqual(JSON.parse(r.permission), { '*': 'allow', edit: 'deny', bash: 'deny' });
  });

  // ADR-226 (was: the skip flag): the engine decides bypass; OpenCode never gets the skip flag.
  it('bypassPermissions, skipPermissions and parity full_delegation → bypass, no flag', () => {
    for (const options of [
      { permissionMode: 'bypassPermissions' },
      { toolsSettings: { skipPermissions: true } },
      { permissionMode: 'default', permissionExecution: full },
    ]) {
      const r = launch(options);
      assert.equal(r.claudeMode, 'bypassPermissions', JSON.stringify(options));
      assert.deepEqual(r.args, []);
      assert.equal(r.args.includes(SKIP), false);
      // Under parity Claude also disallows Task/Agent (mapCliOptionsToSDK); so does OpenCode.
      assert.deepEqual(JSON.parse(r.permission), options.permissionExecution ? { '*': 'allow', task: 'deny' } : { '*': 'allow' });
    }
  });

  it('the settings bypass gate applies to OpenCode exactly as to Claude', () => {
    const gated = claudeLayout(undefined, { permissions: { disableBypassPermissionsMode: 'disable' } });
    const r = launch({ permissionMode: 'bypassPermissions' }, gated);
    assert.equal(r.claudeMode, 'default');
    assert.deepEqual(r.args, []);
  });

  it('acceptEdits / auto / dontAsk → no flag; the engine applies Claude\'s rules', () => {
    for (const permissionMode of ['acceptEdits', 'auto', 'dontAsk']) {
      const r = launch({ permissionMode });
      assert.deepEqual([r.claudeMode, r.args], [permissionMode, []], permissionMode);
    }
  });

  it('parity enforce without full_delegation refuses, as Claude does', () => {
    assert.throws(() => launch({ permissionExecution: { mode: 'enforce', effectivePolicy: null } }),
      /PERMISSION_EFFECTIVE_POLICY_REQUIRED/);
  });

  it('no Claude env for the sender refuses (B-1760: no managed-only fallback)', () => {
    const l = claudeLayout(undefined, { permissions: { deny: ['Bash(pkill:*)'] } });
    for (const claudeEnv of [() => null, () => { throw new Error('no claude for this member'); }]) {
      assert.throws(() => resolveOpenCodePermissionParity({}, { userId: 7, cwd: l.cwd },
        { claudeEnv, managedSettingsDir: l.deps.managedSettingsDir }),
      (error: { code?: string }) => error.code === 'PERMISSION_EFFECTIVE_POLICY_REQUIRED');
    }
  });

  it('L1: Claude\'s deny rules after allow-all; ask rules stay with the engine', () => {
    const r = launch({}, claudeLayout(undefined, { permissions: { deny: ['Bash(pkill:*)', 'WebFetch'], ask: ['Bash(pm2 stop *)'] } }));
    assert.deepEqual(JSON.parse(r.permission), { '*': 'allow', bash: { pkill: 'deny', 'pkill *': 'deny' }, webfetch: 'deny' });
  });

  it('an unreadable Claude settings file refuses before any spawn', () => {
    const l = claudeLayout();
    fs.writeFileSync(path.join(l.deps.claudeEnv(null).CLAUDE_CONFIG_DIR as string, 'settings.json'), '{corrupt');
    assert.throws(() => launch({}, l), (error: { code?: string }) => typeof error.code === 'string');
  });

  it('createEngine builds the OpenCode-adapter engine: deny rules and asks decide each call', async () => {
    const l = claudeLayout(undefined, { permissions: { deny: ['Bash(pkill:*)'] } });
    const r = launch({}, l);
    const engine = r.createEngine({ home: l.cwd, sessionId: 's', transcriptPath: '/dev/null', mcpServers: [], harnessEnv: {} });
    const denied = await engine.decideTool({ callId: 'c1', sessionID: 's', tool: 'bash', args: { command: 'pkill x', description: 'd' } });
    assert.equal(denied.decision, 'deny');
    const asked = await engine.decideTool({ callId: 'c2', sessionID: 's', tool: 'bash', args: { command: 'touch x', description: 'd' } });
    assert.equal(asked.decision, 'ask');
  });

  it('carrier turns are not special-cased (GLM follows the same table)', () => {
    assert.deepEqual(launch({ carrier: true, permissionMode: 'bypassPermissions' }).args, []);
  });
});

describe('applyOpenCodeParityEnv / plugin dir (ADR-226)', () => {
  const parity = { l1Text: '{"*":"allow","bash":{"x":"deny"}}', pluginFile: '/p/nassaj-claude-parity.js' };

  it('sets L1, puts the plugin FIRST, turns lsp/formatter off, strips pure/experimental/enable flags', () => {
    const inherited = { PATH: '/bin', OPENCODE_PERMISSION: '{"*":"deny"}', OPENCODE_PURE: '1',
      OPENCODE_EXPERIMENTAL: '1', OPENCODE_EXPERIMENTAL_CODE_MODE: '1', OPENCODE_ENABLE_EXA: '1',
      NASSAJ_OPENCODE_PARITY_RULES: '{}', NASSAJ_OPENCODE_PARITY_ACK: '/a', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_CONFIG_CONTENT: '{"provider":{"q":{}},"plugin":["a"],"lsp":{"x":{}}}' };
    const env = applyOpenCodeParityEnv(inherited, parity);
    assert.equal(env.OPENCODE_PERMISSION, parity.l1Text);
    for (const key of ['OPENCODE_PURE', 'OPENCODE_EXPERIMENTAL', 'OPENCODE_EXPERIMENTAL_CODE_MODE', 'OPENCODE_ENABLE_EXA',
      'NASSAJ_OPENCODE_PARITY_RULES', 'NASSAJ_OPENCODE_PARITY_ACK']) {
      assert.equal(Object.hasOwn(env, key), false, key);
    }
    assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
    assert.equal(env.OPENCODE_DISABLE_LSP_DOWNLOAD, '1');
    assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? ''),
      { provider: { q: {} }, plugin: ['file:///p/nassaj-claude-parity.js', 'a'], lsp: false, formatter: false });
    assert.equal(inherited.OPENCODE_PERMISSION, '{"*":"deny"}', 'input not mutated');
  });

  it('D2: project config is off on every spawn while the switch is on', () => {
    const env = applyOpenCodeParityEnv({}, parity);
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, OPENCODE_PROJECT_CONFIG_OFF_FOR_EVERY_SPAWN ? '1' : undefined);
  });

  it('refuses an inline config that is not a JSON object', () => {
    assert.throws(() => applyOpenCodeParityEnv({ OPENCODE_CONFIG_CONTENT: '[1]' }, parity), /not a JSON object/);
  });

  it('the plugin dir is content-addressed, verified, and self-heals when tampered (I1)', () => {
    const parityDir = path.join(root, 'parity-root');
    const first = ensureParityPluginDir(parityDir);
    assert.match(first.dir, /nassaj-parity-[0-9a-f]{32}$/);
    assert.deepEqual(fs.readdirSync(first.dir), ['nassaj-claude-parity.js']);
    assert.equal(ensureParityPluginDir(parityDir).dir, first.dir);
    // I1: a stray file is quarantined and the dir re-staged, not a refusal.
    fs.writeFileSync(path.join(first.dir, 'extra.js'), 'x');
    const healed = ensureParityPluginDir(parityDir);
    assert.equal(healed.dir, first.dir);
    assert.deepEqual(fs.readdirSync(healed.dir), ['nassaj-claude-parity.js']);
    const quarantined = fs.readdirSync(parityDir).filter((n) => n.includes('.quarantine-'));
    assert.equal(quarantined.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(parityDir, quarantined[0])).sort(), ['extra.js', 'nassaj-claude-parity.js']);
    // Refuses only when re-staging cannot produce an intact dir (root not writable).
    fs.writeFileSync(path.join(first.dir, 'extra.js'), 'x');
    fs.chmodSync(parityDir, 0o555);
    try {
      assert.throws(() => ensureParityPluginDir(parityDir), /not intact/);
    } finally {
      fs.chmodSync(parityDir, 0o755);
    }
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
