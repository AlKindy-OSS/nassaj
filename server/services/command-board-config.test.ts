/**
 * command-board-config tests (T-948 / ADR-067 Phase 1).
 *
 * Verifies fail-closed defaults, owner-floor protection, per-role gating,
 * disable toggles, validation, and round-trip persistence via app_config.
 * Fresh isolated SQLite DB per group (tmpdir + DATABASE_PATH swap).
 *
 * Framework: node:test + node:assert/strict via tsx.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import {
  getCommandBoardConfig,
  setCommandBoardConfig,
  canRoleRunAction,
  canRoleRunRawExec,
  canonicalizeRoleMode,
  capabilityForRole,
  effectiveModeForRole,
  roleCanRun,
  toPublicCommandBoardConfig,
  TIER_ORDER,
  MAX_ASSIGNABLE_TIER,
} from '@/services/command-board-config.js';
import { appConfigDb } from '@/modules/database/index.js';

const KEY = 'command_board_config';

/** Write a raw stored config (old or new vocabulary) straight into app_config. */
function storeRaw(obj: unknown): void {
  appConfigDb.set(KEY, JSON.stringify(obj));
}

async function withDb(runTest: () => void | Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'cbc-test-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'db.sqlite');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test('default config is fail-closed: owner=safe, admin/user=none', async () => {
  await withDb(() => {
    const cfg = getCommandBoardConfig();
    assert.equal(cfg.roleModes.owner, 'safe');
    assert.equal(cfg.roleModes.admin, 'none');
    assert.equal(cfg.roleModes.user, 'none');
    assert.deepEqual(cfg.disabledActions, []);
    assert.equal(canRoleRunAction('owner', 'safe-restart'), true);
    assert.equal(canRoleRunAction('admin', 'safe-restart'), false);
    assert.equal(canRoleRunAction('user', 'safe-restart'), false);
  });
});

test('unknown action is never runnable', async () => {
  await withDb(() => {
    assert.equal(canRoleRunAction('owner', 'rm-rf-slash'), false);
  });
});

test('enabling admin mode=safe lets admin run; user still blocked', async () => {
  await withDb(() => {
    const res = setCommandBoardConfig({ roleModes: { admin: 'safe' } });
    assert.equal(res.ok, true);
    assert.equal(canRoleRunAction('admin', 'safe-restart'), true);
    assert.equal(canRoleRunAction('user', 'safe-restart'), false);
  });
});

test('disabling an action blocks it even for owner', async () => {
  await withDb(() => {
    setCommandBoardConfig({ disabledActions: ['safe-restart'] });
    assert.equal(canRoleRunAction('owner', 'safe-restart'), false);
  });
});

test('ADR-072: legacy general is migrated to custom (read-time), still grants safe list', async () => {
  await withDb(() => {
    // Legacy 'general' accepted on input, canonicalized to the new 'custom' tier.
    setCommandBoardConfig({ roleModes: { admin: 'general' } });
    assert.equal(effectiveModeForRole('admin'), 'custom');
    // A STATIC allowlisted action stays runnable under safe/custom/raw.
    assert.equal(canRoleRunAction('admin', 'safe-restart'), true);
  });
});

test('owner can never be locked out (none coerced to safe)', async () => {
  await withDb(() => {
    const res = setCommandBoardConfig({ roleModes: { owner: 'none' } });
    assert.equal(res.ok, true);
    assert.equal(getCommandBoardConfig().roleModes.owner, 'safe');
  });
});

test('invalid mode / unknown disabled action are rejected fail-closed', async () => {
  await withDb(() => {
    assert.equal(setCommandBoardConfig({ roleModes: { admin: 'root' } }).ok, false);
    assert.equal(setCommandBoardConfig({ disabledActions: ['nope'] }).ok, false);
    assert.equal(setCommandBoardConfig(null).ok, false);
  });
});

test('config round-trips through app_config and survives reload', async () => {
  await withDb(() => {
    setCommandBoardConfig({ roleModes: { admin: 'safe' }, disabledActions: [] });
    const pub = toPublicCommandBoardConfig();
    assert.equal(pub.roleModes.admin, 'safe');
    assert.equal(pub.roleModes.owner, 'safe');
  });
});

test('corrupt stored JSON falls back to safe defaults', async () => {
  await withDb(async () => {
    const { appConfigDb } = await import('@/modules/database/index.js');
    appConfigDb.set('command_board_config', '{not valid json');
    const cfg = getCommandBoardConfig();
    assert.equal(cfg.roleModes.owner, 'safe');
    assert.equal(cfg.roleModes.admin, 'none');
  });
});

// ── ADR-072 tier model ───────────────────────────────────────────────────────

test('TIER_ORDER is the strict none<safe<custom<raw ranking', () => {
  assert.deepEqual(TIER_ORDER, { none: 0, safe: 1, custom: 2, raw: 3 });
});

test('canonicalizeRoleMode: full migration table (pure, fail-closed)', () => {
  // none/safe/custom pass through unchanged.
  assert.equal(canonicalizeRoleMode('admin', 'none'), 'none');
  assert.equal(canonicalizeRoleMode('admin', 'safe'), 'safe');
  assert.equal(canonicalizeRoleMode('admin', 'custom'), 'custom');
  // legacy general → custom when the armed flag is NOT configured (no upgrade).
  assert.equal(canonicalizeRoleMode('admin', 'general'), 'custom');
  assert.equal(canonicalizeRoleMode('owner', 'general'), 'custom');
  assert.equal(canonicalizeRoleMode('owner', 'general', false), 'custom');
  // legacy general + configured-armed flag: owner had raw live pre-ADR-072, so the
  // grant is PRESERVED as raw (capability preservation, not an upgrade). A
  // non-owner on legacy general stays custom — the MIGRATION never upgrades
  // implicitly, even though an EXPLICIT raw grant to any role is now allowed.
  assert.equal(canonicalizeRoleMode('owner', 'general', true), 'raw');
  assert.equal(canonicalizeRoleMode('admin', 'general', true), 'custom');
  assert.equal(canonicalizeRoleMode('user', 'general', true), 'custom');
  // ADR-072 amended 2026-07-26 (owner decision): an EXPLICIT raw grant is honoured
  // for every role — no per-row clip. The only brakes are global (armed ceiling +
  // environment blockers), applied in capabilityForRole, never here.
  assert.equal(canonicalizeRoleMode('admin', 'raw'), 'raw');
  assert.equal(canonicalizeRoleMode('user', 'raw'), 'raw');
  assert.equal(canonicalizeRoleMode('owner', 'raw'), 'raw');
  // missing / corrupt / unknown → none (owner floored to safe).
  assert.equal(canonicalizeRoleMode('admin', undefined), 'none');
  assert.equal(canonicalizeRoleMode('admin', 'bogus'), 'none');
  assert.equal(canonicalizeRoleMode('admin', 42 as any), 'none');
  assert.equal(canonicalizeRoleMode('owner', undefined), 'safe');
  assert.equal(canonicalizeRoleMode('owner', 'none'), 'safe');
});

test('capabilityForRole: the flag is a CEILING (lowers, never raises)', () => {
  const cfg = (mode: string, armed: boolean) => ({
    roleModes: { owner: mode, admin: mode, user: mode },
    disabledActions: [] as string[],
    rawExecEnabled: armed,
  });
  // owner granted raw: unarmed ceiling=custom clips it; armed keeps raw.
  assert.equal(capabilityForRole('owner', cfg('raw', false) as any), 'custom');
  assert.equal(capabilityForRole('owner', cfg('raw', true) as any), 'raw');
  // owner granted custom + armed: stays custom — arming does NOT upgrade a grant.
  assert.equal(capabilityForRole('owner', cfg('custom', true) as any), 'custom');
  // admin granted raw: honoured when armed, and clipped by the SAME ceiling when
  // not — the brake is global, never a per-role clip (ADR-072 amended 2026-07-26).
  assert.equal(capabilityForRole('admin', cfg('raw', true) as any), 'raw');
  assert.equal(capabilityForRole('admin', cfg('raw', false) as any), 'custom');
  // none stays none regardless of arming.
  assert.equal(capabilityForRole('admin', cfg('none', true) as any), 'none');
});

test('roleCanRun: full truth table (capability × requiredTier)', () => {
  const tiers = ['none', 'safe', 'custom', 'raw'] as const;
  // Produce each CAPABILITY level from a role+cfg that actually yields it. Note
  // the owner floor forbids capability 'none' for the owner, and raw is owner-only,
  // so 'none/safe/custom' come from an admin grant and 'raw' from an armed owner.
  const capabilitySources: Record<string, { role: string; cfg: any }> = {
    none: { role: 'admin', cfg: { roleModes: { admin: 'none' }, disabledActions: [], rawExecEnabled: false } },
    safe: { role: 'admin', cfg: { roleModes: { admin: 'safe' }, disabledActions: [], rawExecEnabled: true } },
    custom: { role: 'admin', cfg: { roleModes: { admin: 'custom' }, disabledActions: [], rawExecEnabled: true } },
    raw: { role: 'owner', cfg: { roleModes: { owner: 'raw' }, disabledActions: [], rawExecEnabled: true } },
  };
  for (const cap of tiers) {
    const { role, cfg } = capabilitySources[cap];
    assert.equal(capabilityForRole(role, cfg), cap, `source for capability ${cap}`);
    for (const required of tiers) {
      const expected = TIER_ORDER[cap] >= TIER_ORDER[required];
      assert.equal(roleCanRun(role, required, cfg), expected, `capability=${cap} required=${required}`);
    }
    // fail-closed: an unknown requiredTier is never satisfied.
    assert.equal(roleCanRun(role, 'bogus' as any, cfg), false);
  }
});

test('lazy read-time migration: legacy general/raw stored → new vocab on read', async () => {
  await withDb(() => {
    storeRaw({ roleModes: { owner: 'general', admin: 'general', user: 'raw' }, disabledActions: [] });
    const cfg = getCommandBoardConfig();
    assert.equal(cfg.roleModes.owner, 'custom'); // general → custom (flag not armed)
    assert.equal(cfg.roleModes.admin, 'custom'); // general → custom
    assert.equal(cfg.roleModes.user, 'raw'); // an EXPLICIT raw grant is honoured for any role
    // stored bytes are NOT rewritten by a read (lazy, non-destructive).
    assert.equal(JSON.parse(appConfigDb.get('command_board_config')!).roleModes.owner, 'general');
  });
});

test('migration: legacy rawExecEnabled:true + owner=general ⇒ raw PRESERVED (granted + effective)', async () => {
  await withDb(() => {
    storeRaw({ roleModes: { owner: 'general' }, rawExecEnabled: true });
    const cfg = getCommandBoardConfig();
    // The ceiling is armed…
    assert.equal(cfg.rawExecEnabled, true);
    // …and the owner GENUINELY held raw live pre-ADR-072 (canRoleRunRawExec =
    // rawExecEnabled && mode==='general'), so migration PRESERVES that capability:
    // the granted tier is raw, not a silent downgrade to custom.
    assert.equal(cfg.roleModes.owner, 'raw');
    assert.equal(capabilityForRole('owner', cfg), 'raw');
    assert.equal(canRoleRunRawExec('owner', cfg), true);
  });
});

test('migration: owner=general WITHOUT armed flag ⇒ custom (never held raw)', async () => {
  await withDb(() => {
    storeRaw({ roleModes: { owner: 'general' } }); // rawExecEnabled missing → not armed
    const cfg = getCommandBoardConfig();
    assert.equal(cfg.roleModes.owner, 'custom');
    assert.equal(capabilityForRole('owner', cfg), 'custom');
    assert.equal(canRoleRunRawExec('owner', cfg), false);
  });
});

test('migration: rawExecEnabled:true + admin=general ⇒ custom (raw stays owner-only)', async () => {
  await withDb(() => {
    storeRaw({ roleModes: { owner: 'safe', admin: 'general' }, rawExecEnabled: true });
    const cfg = getCommandBoardConfig();
    assert.equal(cfg.roleModes.admin, 'custom'); // no raw for a non-owner general
    assert.equal(capabilityForRole('admin', cfg), 'custom');
    assert.equal(canRoleRunRawExec('admin', cfg), false);
  });
});

test('migration: unarming after owner=general migration ⇒ granted raw, effective custom (ceiling works)', async () => {
  await withDb(() => {
    storeRaw({ roleModes: { owner: 'general' }, rawExecEnabled: true });
    // migrated to raw while armed…
    assert.equal(getCommandBoardConfig().roleModes.owner, 'raw');
    assert.equal(canRoleRunRawExec('owner'), true);
    // …then the owner unarms the ceiling. Grant stays raw, but effective drops to
    // custom and raw is refused — the ceiling clips a migrated grant just like any other.
    setCommandBoardConfig({ rawExecEnabled: false });
    const cfg = getCommandBoardConfig();
    assert.equal(cfg.roleModes.owner, 'raw'); // grant preserved
    assert.equal(cfg.rawExecEnabled, false);
    assert.equal(capabilityForRole('owner', cfg), 'custom');
    assert.equal(canRoleRunRawExec('owner', cfg), false);
  });
});

test('migration: the LIVE production config verbatim preserves owner raw, admin custom, user none', async () => {
  await withDb(() => {
    // The exact bytes live in app_config right now (fix/security-remediation-2026-07-09).
    storeRaw({
      roleModes: { owner: 'general', admin: 'general', user: 'none' },
      disabledActions: [],
      rawExecEnabled: true,
    });
    const cfg = getCommandBoardConfig();
    // owner: general + armed → raw effective (the capability the owner set up live).
    assert.equal(cfg.roleModes.owner, 'raw');
    assert.equal(capabilityForRole('owner', cfg), 'raw');
    assert.equal(canRoleRunRawExec('owner', cfg), true);
    // admin: general → custom effective (raw is owner-only).
    assert.equal(capabilityForRole('admin', cfg), 'custom');
    assert.equal(canRoleRunRawExec('admin', cfg), false);
    // user: none.
    assert.equal(capabilityForRole('user', cfg), 'none');
  });
});

test('B-199: owner CAN pick raw when armed, and can NEVER pick none', async () => {
  await withDb(() => {
    // owner explicitly assigns tier raw + arms the ceiling → raw is reachable.
    const res = setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw' } });
    assert.equal(res.ok, true);
    assert.equal(getCommandBoardConfig().roleModes.owner, 'raw');
    assert.equal(canRoleRunRawExec('owner'), true);
    // owner=none is refused (coerced to safe) — cannot lock the owner out.
    setCommandBoardConfig({ roleModes: { owner: 'none' } });
    assert.equal(getCommandBoardConfig().roleModes.owner, 'safe');
  });
});

test('B-199: admin/user rows are fully editable across ALL four tiers, raw included', async () => {
  await withDb(() => {
    // ADR-072 amended 2026-07-26 (owner decision «لا تقيدني»): every tier is
    // assignable to every role. No row is frozen and no option is clipped — the
    // brakes are global (armed ceiling + environment blockers), never per-row.
    for (const tier of ['none', 'safe', 'custom', 'raw'] as const) {
      const res = setCommandBoardConfig({ roleModes: { admin: tier, user: tier } });
      assert.equal(res.ok, true, `admin/user=${tier} must be accepted`);
      assert.equal(getCommandBoardConfig().roleModes.admin, tier);
      assert.equal(getCommandBoardConfig().roleModes.user, tier);
    }
  });
});

test('B-192: a config-disabled action is refused even at the raw tier (orthogonal filter)', async () => {
  await withDb(() => {
    setCommandBoardConfig({
      rawExecEnabled: true,
      roleModes: { owner: 'raw' },
      disabledActions: ['safe-restart'],
    });
    // owner reaches the raw tier, yet the disabled static action is still refused.
    assert.equal(canRoleRunRawExec('owner'), true);
    assert.equal(canRoleRunAction('owner', 'safe-restart'), false);
  });
});

test('fail-closed: an unknown role never reaches any tier', async () => {
  await withDb(() => {
    setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw' } });
    assert.equal(canRoleRunAction('ghost' as any, 'safe-restart'), false);
    assert.equal(canRoleRunRawExec('ghost' as any), false);
    assert.equal(roleCanRun('ghost' as any, 'safe'), false);
  });
});

test('a raw grant stored for a non-owner is honoured, and the ceiling is its only brake', async () => {
  await withDb(() => {
    storeRaw({ roleModes: { owner: 'safe', admin: 'raw', user: 'none' }, rawExecEnabled: true });
    assert.equal(getCommandBoardConfig().roleModes.admin, 'raw'); // no per-row clip
    assert.equal(canRoleRunRawExec('admin'), true);
    // the global ceiling still governs it — and an ungranted role stays denied.
    assert.equal(canRoleRunRawExec('user'), false);
    storeRaw({ roleModes: { owner: 'safe', admin: 'raw', user: 'none' }, rawExecEnabled: false });
    assert.equal(canRoleRunRawExec('admin'), false);
  });
});

test('B-197 core: unarming the ceiling drops raw for every role in one flip', async () => {
  await withDb(() => {
    setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw' } });
    assert.equal(canRoleRunRawExec('owner'), true);
    // one flip of the ceiling → raw unreachable, grant untouched.
    setCommandBoardConfig({ rawExecEnabled: false });
    assert.equal(canRoleRunRawExec('owner'), false);
    assert.equal(getCommandBoardConfig().roleModes.owner, 'raw'); // grant preserved
  });
});

test('toPublicCommandBoardConfig: ADR-072 contract (tiers + maxAssignableTier + arming)', async () => {
  await withDb(() => {
    setCommandBoardConfig({ rawExecEnabled: true, roleModes: { owner: 'raw', admin: 'custom' } });
    const pub = toPublicCommandBoardConfig();
    assert.equal(pub.roleModes.owner, 'raw');
    assert.equal(pub.roleModes.admin, 'custom');
    assert.deepEqual(pub.maxAssignableTier, { owner: 'raw', admin: 'raw', user: 'raw' });
    assert.deepEqual(pub.maxAssignableTier, MAX_ASSIGNABLE_TIER);
    assert.equal(pub.rawExecEnabled, true);
    assert.deepEqual(pub.rawExecBlockedReasons, []); // not platform mode in this test
  });
});
