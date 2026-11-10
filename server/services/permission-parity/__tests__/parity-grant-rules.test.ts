/**
 * parity-grant-rules.test — ADR-226 H3, qa merge condition H4: behaviour, not source text. A
 * member running on a real Claude credential grant gets the GRANTOR's Claude rules on every
 * harness that mirrors Claude, as his Claude turn does (claudeSpawnEnvFor → the grantor's
 * CLAUDE_CONFIG_DIR). Probed with a deny rule only the grantor's settings carry, in
 * bypassPermissions (so nothing but that rule can deny), on OpenCode and on dsh, through the
 * production defaults (no claudeEnv injected). Controls: the same member without the grant,
 * and after revocation, is allowed.
 */
// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

type Row = Record<string, any>;
const OWNER = 41;
const MEMBER = 42;
const PROBE = 'touch grant-probe';
const RULE = `Bash(${PROBE})`;
let db: Row;
let mod: Row;
let scratch = '';
let managedSettingsDir = '';
let cwd = '';

/** Writes the grantor's own Claude settings, after the operator policy was seeded into them. */
function ownerDenies(): void {
  const dir = mod.claudeSpawnEnvFor(OWNER, { PATH: '/usr/bin:/bin', HOME: process.env.HOME }).CLAUDE_CONFIG_DIR;
  const file = path.join(dir, 'settings.json');
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  settings.permissions = { ...settings.permissions, deny: [...(settings.permissions?.deny ?? []), RULE] };
  fs.writeFileSync(file, JSON.stringify(settings));
}

/** The OpenCode engine's decision on the probe for the member (production claudeEnv). */
async function onOpenCode(): Promise<Row> {
  const engine = mod.createClaudeParityEngine({ userId: MEMBER, cwd, home: path.join(scratch, 'oc-home'), sessionId: 's',
    transcriptPath: '/dev/null', permissionMode: 'bypassPermissions', managedSettingsDir, adapter: mod.opencodeParityAdapter });
  return engine.decideTool({ callId: `c${Math.random()}`, sessionID: 's', tool: 'bash', args: { command: PROBE, description: 'probe' } });
}

/** The dsh engine's decision on the probe for the member (production claudeEnv). */
async function onDsh(): Promise<Row> {
  const parity = mod.resolveDshPermissionParity({ permissionMode: 'bypassPermissions' }, { userId: MEMBER, cwd }, { managedSettingsDir });
  const engine = parity.createEngine({ home: path.join(scratch, 'dsh-home'), sessionId: 's', transcriptPath: '/dev/null' });
  return engine.decideTool({ callId: `d${Math.random()}`, tool: 'bash', args: { command: PROBE, description: 'probe' } });
}

describe('ADR-226 H4: a granted member gets the grantor\'s Claude rules on OpenCode and dsh', () => {
  before(async () => {
    db = await import('@/modules/database/index.js');
    await db.initializeDatabase();
    for (const id of [OWNER, MEMBER]) {
      db.getConnection().prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, `grant-${id}`, 'x');
    }
    mod = {
      ...(await import('@/services/isolation/claude-spawn-env.js')),
      ...(await import('@/services/permission-parity/claude-parity-engine.js')),
      ...(await import('@/services/permission-parity/opencode-claude-tools.js')),
      ...(await import('@/modules/providers/list/dsh/dsh-permission-parity.js')),
    };
    scratch = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'parity-grant-'));
    cwd = path.join(scratch, 'ws');
    managedSettingsDir = path.join(scratch, 'managed');
    for (const dir of [cwd, managedSettingsDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(managedSettingsDir, 'managed-settings.json'), '{}');
    ownerDenies();
  });
  after(() => {
    db.credentialGrantsDb.revoke?.(OWNER, MEMBER, 'claude');
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('control: without a grant the member runs on his own settings (bypass → allow)', async () => {
    assert.equal((await onOpenCode()).decision, 'allow');
    assert.equal((await onDsh()).decision, 'allow');
  });

  it('with the grant: the grantor\'s deny rule denies the probe on OpenCode and on dsh', async () => {
    db.credentialGrantsDb.grant(OWNER, MEMBER, 'claude');
    const env = mod.claudeSpawnEnvFor(MEMBER, { PATH: '/usr/bin:/bin', HOME: process.env.HOME });
    assert.ok(env.CLAUDE_CONFIG_DIR.endsWith(path.join(String(OWNER), '.claude')), `grantor's config dir: ${env.CLAUDE_CONFIG_DIR}`);
    for (const [name, verdict] of [['OpenCode', await onOpenCode()], ['dsh', await onDsh()]] as const) {
      assert.equal(verdict.decision, 'deny', `${name}: ${verdict.reason}`);
      assert.ok(String(verdict.reason).includes(RULE), `${name} names the grantor's rule: ${verdict.reason}`);
    }
  });

  it('after revocation the member is back on his own settings', async () => {
    db.credentialGrantsDb.revoke(OWNER, MEMBER, 'claude');
    assert.equal((await onOpenCode()).decision, 'allow');
    assert.equal((await onDsh()).decision, 'allow');
  });
});
