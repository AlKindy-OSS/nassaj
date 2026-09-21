/**
 * vendor-cli-permissions.test.ts — SL-4 (ADR-062) permission-ceiling proof.
 *
 * Locks down the single chokepoint mapPermissionModeToVendorFlags for every
 * (vendorId, mode) pair and the operator-flag matrix, asserting the same invariants
 * the Codex ceiling test (openai-codex.permission-ceiling.test.ts) proves one CLI over:
 *   1. Default is OFF: no full-access, no network, for any client-chosen mode.
 *   2. A client's bypassPermissions is CAPPED — it reaches a vendor's danger flag
 *      (Kimi --yolo / OpenCode --auto) ONLY behind the operator SERVER flag.
 *   3. Only the exact string 'true' unlocks; '1'/'yes'/'TRUE'/'' do not.
 *   4. plan mode maps to each vendor's read-only surface.
 *   5. Unknown vendor fails closed (no flags, everything OFF).
 *   6. Mode aliases (gemini/native vocab) normalize; junk never escalates.
 *
 * Pure unit test — no DB, no SDK, no subprocess. Runner (package.json "test"):
 *   tsx --tsconfig server/tsconfig.json --test "server/(glob)/*.test.ts"
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mapPermissionModeToVendorFlags,
  normalizePermissionMode,
} from './vendor-cli-permissions.js';

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// normalizePermissionMode
// ---------------------------------------------------------------------------
describe('normalizePermissionMode', () => {
  it('maps the four nassaj-native modes', () => {
    assert.equal(normalizePermissionMode('plan'), 'plan');
    assert.equal(normalizePermissionMode('default'), 'default');
    assert.equal(normalizePermissionMode('acceptEdits'), 'acceptEdits');
    assert.equal(normalizePermissionMode('bypassPermissions'), 'bypass');
  });

  it('folds the gemini/vendor aliases (case-insensitive, trimmed)', () => {
    assert.equal(normalizePermissionMode('  YOLO '), 'bypass');
    assert.equal(normalizePermissionMode('auto_edit'), 'acceptEdits');
    assert.equal(normalizePermissionMode('AcceptEdits'), 'acceptEdits');
    assert.equal(normalizePermissionMode('BYPASSPERMISSIONS'), 'bypass');
  });

  it('resolves unknown / non-string / empty to the SAFE default (never bypass)', () => {
    for (const bad of ['nonsense', '', '   ', undefined, null, 42, {}] as unknown[]) {
      assert.equal(normalizePermissionMode(bad), 'default', `${JSON.stringify(bad)} must not escalate`);
    }
  });
});

// ===========================================================================
// KIMI (native) — --plan < --auto < --yolo
// ===========================================================================
describe('mapPermissionModeToVendorFlags — kimi', () => {
  it('plan -> --plan, read-only, no full access, network OFF', () => {
    const r = mapPermissionModeToVendorFlags('kimi', 'plan', {});
    assert.deepEqual(r.flags, ['--plan']);
    assert.equal(r.fullAccess, false);
    assert.equal(r.network, false);
    assert.equal(r.ceiling, 'plan');
  });

  it('default -> --auto (workspace autonomous), no full access, network OFF', () => {
    const r = mapPermissionModeToVendorFlags('kimi', 'default', {});
    assert.deepEqual(r.flags, ['--auto']);
    assert.equal(r.fullAccess, false);
    assert.equal(r.network, false);
    assert.equal(r.ceiling, 'workspace');
  });

  it('acceptEdits -> --auto, identical safe ceiling to default', () => {
    const r = mapPermissionModeToVendorFlags('kimi', 'acceptEdits', {});
    assert.deepEqual(r.flags, ['--auto']);
    assert.equal(r.fullAccess, false);
    assert.equal(r.network, false);
  });

  it('bypassPermissions is CAPPED to --auto with NO operator flag (the B-169/T-884 hole, closed)', () => {
    const r = mapPermissionModeToVendorFlags('kimi', 'bypassPermissions', {});
    assert.deepEqual(r.flags, ['--auto'], 'client bypass must NOT reach --yolo');
    assert.equal(r.fullAccess, false);
    assert.equal(r.network, false);
  });

  it('bypassPermissions stays capped when the flag is present-but-not-"true"', () => {
    for (const bad of ['1', 'yes', 'TRUE', 'on', '', 'false']) {
      const r = mapPermissionModeToVendorFlags('kimi', 'bypassPermissions', {
        KIMI_ALLOW_FULL_ACCESS: bad,
      } as Env);
      assert.deepEqual(r.flags, ['--auto'], `KIMI_ALLOW_FULL_ACCESS=${JSON.stringify(bad)} must NOT unlock --yolo`);
      assert.equal(r.fullAccess, false);
    }
  });

  it('bypassPermissions -> --yolo ONLY with KIMI_ALLOW_FULL_ACCESS==="true" (network rides with full access)', () => {
    const r = mapPermissionModeToVendorFlags('kimi', 'bypassPermissions', {
      KIMI_ALLOW_FULL_ACCESS: 'true',
    } as Env);
    assert.deepEqual(r.flags, ['--yolo']);
    assert.equal(r.fullAccess, true);
    assert.equal(r.network, true, '--yolo implies unrestricted network');
    assert.equal(r.ceiling, 'full');
  });

  it('the full-access flag does NOT escalate non-bypass modes', () => {
    const env = { KIMI_ALLOW_FULL_ACCESS: 'true' } as Env;
    assert.deepEqual(mapPermissionModeToVendorFlags('kimi', 'default', env).flags, ['--auto']);
    assert.deepEqual(mapPermissionModeToVendorFlags('kimi', 'acceptEdits', env).flags, ['--auto']);
    assert.deepEqual(mapPermissionModeToVendorFlags('kimi', 'plan', env).flags, ['--plan']);
    assert.equal(mapPermissionModeToVendorFlags('kimi', 'acceptEdits', env).fullAccess, false);
  });

  it('KIMI_ALLOW_NETWORK==="true" opens network under --auto/--plan WITHOUT granting full access', () => {
    const env = { KIMI_ALLOW_NETWORK: 'true' } as Env;
    const auto = mapPermissionModeToVendorFlags('kimi', 'default', env);
    assert.equal(auto.network, true);
    assert.equal(auto.fullAccess, false, 'network flag must not grant full access');
    assert.deepEqual(auto.flags, ['--auto']);

    const plan = mapPermissionModeToVendorFlags('kimi', 'plan', env);
    assert.equal(plan.network, true);
    assert.equal(plan.fullAccess, false);
  });

  it('KIMI_ALLOW_NETWORK only unlocks on exact "true"', () => {
    for (const bad of ['1', 'YES', 'TRUE', '']) {
      const r = mapPermissionModeToVendorFlags('kimi', 'default', { KIMI_ALLOW_NETWORK: bad } as Env);
      assert.equal(r.network, false, `KIMI_ALLOW_NETWORK=${JSON.stringify(bad)} must NOT open network`);
    }
  });

  it('returns a FRESH flags array each call (no shared mutable table)', () => {
    const a = mapPermissionModeToVendorFlags('kimi', 'default', {});
    const b = mapPermissionModeToVendorFlags('kimi', 'default', {});
    assert.notEqual(a.flags, b.flags);
    a.flags.push('--tainted');
    assert.deepEqual(b.flags, ['--auto'], 'mutating one result must not leak into another');
  });
});

// ===========================================================================
// OPENCODE (carrier) — --agent plan < default < --auto (dangerous)
// ===========================================================================
describe('mapPermissionModeToVendorFlags — opencode', () => {
  it('plan -> --agent plan (read-only build agent), no full access, network OFF', () => {
    const r = mapPermissionModeToVendorFlags('opencode', 'plan', {});
    assert.deepEqual(r.flags, ['--agent', 'plan']);
    assert.equal(r.fullAccess, false);
    assert.equal(r.network, false);
    assert.equal(r.ceiling, 'plan');
  });

  it('default -> no flag (OpenCode ask/deny default), network OFF', () => {
    const r = mapPermissionModeToVendorFlags('opencode', 'default', {});
    assert.deepEqual(r.flags, []);
    assert.equal(r.fullAccess, false);
    assert.equal(r.network, false);
    assert.equal(r.ceiling, 'default');
  });

  it('acceptEdits -> no flag (no mid-tier flag exists; stays on safe default)', () => {
    const r = mapPermissionModeToVendorFlags('opencode', 'acceptEdits', {});
    assert.deepEqual(r.flags, []);
    assert.equal(r.fullAccess, false);
    assert.equal(r.network, false);
  });

  it('bypassPermissions is CAPPED (no --auto) without the operator flag', () => {
    const r = mapPermissionModeToVendorFlags('opencode', 'bypassPermissions', {});
    assert.deepEqual(r.flags, [], 'client bypass must NOT reach the dangerous --auto');
    assert.equal(r.fullAccess, false);
    assert.equal(r.network, false);
  });

  it('bypassPermissions stays capped when OPENCODE_ALLOW_FULL_ACCESS is not exactly "true"', () => {
    for (const bad of ['1', 'yes', 'TRUE', 'on', '', 'false']) {
      const r = mapPermissionModeToVendorFlags('opencode', 'bypassPermissions', {
        OPENCODE_ALLOW_FULL_ACCESS: bad,
      } as Env);
      assert.deepEqual(r.flags, [], `OPENCODE_ALLOW_FULL_ACCESS=${JSON.stringify(bad)} must NOT unlock --auto`);
      assert.equal(r.fullAccess, false);
    }
  });

  it('bypassPermissions -> --auto ONLY with OPENCODE_ALLOW_FULL_ACCESS==="true"', () => {
    const r = mapPermissionModeToVendorFlags('opencode', 'bypassPermissions', {
      OPENCODE_ALLOW_FULL_ACCESS: 'true',
    } as Env);
    assert.deepEqual(r.flags, ['--auto']);
    assert.equal(r.fullAccess, true);
    assert.equal(r.network, true);
    assert.equal(r.ceiling, 'full');
  });

  it('the full-access flag does NOT escalate non-bypass modes', () => {
    const env = { OPENCODE_ALLOW_FULL_ACCESS: 'true' } as Env;
    assert.deepEqual(mapPermissionModeToVendorFlags('opencode', 'default', env).flags, []);
    assert.deepEqual(mapPermissionModeToVendorFlags('opencode', 'acceptEdits', env).flags, []);
    assert.deepEqual(mapPermissionModeToVendorFlags('opencode', 'plan', env).flags, ['--agent', 'plan']);
  });

  it("'glm' aliases to the OpenCode carrier table", () => {
    assert.deepEqual(
      mapPermissionModeToVendorFlags('glm', 'plan', {}),
      mapPermissionModeToVendorFlags('opencode', 'plan', {}),
    );
    assert.deepEqual(
      mapPermissionModeToVendorFlags('glm', 'bypassPermissions', { OPENCODE_ALLOW_FULL_ACCESS: 'true' } as Env),
      mapPermissionModeToVendorFlags('opencode', 'bypassPermissions', { OPENCODE_ALLOW_FULL_ACCESS: 'true' } as Env),
    );
  });
});

// ===========================================================================
// Cross-cutting: unknown vendor fail-closed, vendor casing, client can't cross vendors
// ===========================================================================
describe('mapPermissionModeToVendorFlags — fail-closed & robustness', () => {
  it('unknown vendor -> locked default (no flags, no access, no network)', () => {
    for (const v of ['claude', 'gemini', 'cursor', '', 'KIMI2', undefined as unknown as string]) {
      const r = mapPermissionModeToVendorFlags(v, 'bypassPermissions', {
        KIMI_ALLOW_FULL_ACCESS: 'true',
        OPENCODE_ALLOW_FULL_ACCESS: 'true',
      } as Env);
      assert.deepEqual(r.flags, [], `unknown vendor ${JSON.stringify(v)} must emit no flags`);
      assert.equal(r.fullAccess, false);
      assert.equal(r.network, false);
      assert.equal(r.ceiling, 'locked');
    }
  });

  it('vendorId is case-insensitive / trimmed', () => {
    assert.deepEqual(mapPermissionModeToVendorFlags('  Kimi ', 'plan', {}).flags, ['--plan']);
    assert.deepEqual(mapPermissionModeToVendorFlags('OpenCode', 'plan', {}).flags, ['--agent', 'plan']);
  });

  it("Kimi's flag does not leak into OpenCode and vice-versa (per-vendor flag isolation)", () => {
    const bothFlags = { KIMI_ALLOW_FULL_ACCESS: 'true', OPENCODE_ALLOW_FULL_ACCESS: 'true' } as Env;
    // Kimi honors only its own flag name; OpenCode's flag is irrelevant to it and vice-versa.
    assert.equal(mapPermissionModeToVendorFlags('kimi', 'bypassPermissions', { OPENCODE_ALLOW_FULL_ACCESS: 'true' } as Env).fullAccess, false);
    assert.equal(mapPermissionModeToVendorFlags('opencode', 'bypassPermissions', { KIMI_ALLOW_FULL_ACCESS: 'true' } as Env).fullAccess, false);
    // With both set, each still uses its own gate correctly.
    assert.deepEqual(mapPermissionModeToVendorFlags('kimi', 'bypassPermissions', bothFlags).flags, ['--yolo']);
    assert.deepEqual(mapPermissionModeToVendorFlags('opencode', 'bypassPermissions', bothFlags).flags, ['--auto']);
  });

  it('a junk/unknown client mode never escalates on either vendor', () => {
    const env = { KIMI_ALLOW_FULL_ACCESS: 'true', OPENCODE_ALLOW_FULL_ACCESS: 'true' } as Env;
    // 'nonsense' normalizes to 'default' -> safe ceiling on both.
    assert.deepEqual(mapPermissionModeToVendorFlags('kimi', 'nonsense', env).flags, ['--auto']);
    assert.deepEqual(mapPermissionModeToVendorFlags('opencode', 'nonsense', env).flags, []);
    assert.equal(mapPermissionModeToVendorFlags('kimi', 'nonsense', env).fullAccess, false);
  });
});
