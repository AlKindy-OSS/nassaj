/**
 * vendor-cli-permissions.test.ts — SL-4 (ADR-062) permission-ceiling proof.
 *
 * Locks down the single chokepoint mapPermissionModeToVendorFlags for every
 * (vendorId, mode) pair and the operator-flag matrix, asserting the same invariants
 * the Codex ceiling test (openai-codex.permission-ceiling.test.ts) proves one CLI over:
 *   1. OpenCode (B-1707 owner ruling): the input is Claude's effective mode and is
 *      translated as is; the OPENCODE_ALLOW_FULL_ACCESS gate is retired.
 *   2. plan mode maps to the vendor's read-only surface.
 *   3. Unknown vendor fails closed (no flags, everything OFF) — the removed Kimi
 *      native body (ADR-229) included.
 *   4. Mode aliases (vendor/native vocab) normalize; junk never escalates.
 *
 * Pure unit test — no DB, no SDK, no subprocess. Runner (package.json "test"):
 *   tsx --tsconfig server/tsconfig.json --test "server/(glob)/*.test.ts"
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mapPermissionModeToVendorFlags,
  normalizePermissionMode,
  OPENCODE_PLAN_PERMISSION,
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

  it('folds the vendor aliases (case-insensitive, trimmed)', () => {
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
// OPENCODE — B-1707 owner ruling: the input is the mode Claude would run under,
// translated as is (no OpenCode-only grant, no OpenCode-only cage).
// ===========================================================================
describe('mapPermissionModeToVendorFlags — opencode (Claude parity)', () => {
  it('plan -> --agent plan + a nassaj OPENCODE_PERMISSION denying edit and bash', () => {
    const r = mapPermissionModeToVendorFlags('opencode', 'plan', {});
    assert.deepEqual(r.flags, ['--agent', 'plan']);
    assert.deepEqual(JSON.parse(r.permission ?? 'null'), { edit: 'deny', bash: 'deny' });
    assert.equal(r.permission, OPENCODE_PLAN_PERMISSION);
    assert.equal(r.fullAccess, false);
    assert.equal(r.ceiling, 'plan');
  });

  // ADR-226 (was: the skip flag): the parity engine decides bypass, OpenCode gets no flag.
  it('bypassPermissions -> no flag at all, full ceiling (the parity engine decides)', () => {
    const r = mapPermissionModeToVendorFlags('opencode', 'bypassPermissions', {});
    assert.deepEqual(r.flags, []);
    assert.equal(r.permission, null);
    assert.equal(r.fullAccess, true);
    assert.equal(r.ceiling, 'full');
  });

  it('the retired OPENCODE_ALLOW_FULL_ACCESS changes nothing either way', () => {
    for (const value of [undefined, 'true', 'false']) {
      const env = { OPENCODE_ALLOW_FULL_ACCESS: value } as Env;
      assert.deepEqual(mapPermissionModeToVendorFlags('opencode', 'bypassPermissions', env).flags, []);
      assert.deepEqual(mapPermissionModeToVendorFlags('opencode', 'default', env).flags, []);
    }
  });

  it('default / acceptEdits / auto / dontAsk -> no flag and no permission (OpenCode own rules)', () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'dontAsk']) {
      const r = mapPermissionModeToVendorFlags('opencode', mode, {});
      assert.deepEqual(r.flags, [], mode);
      assert.equal(r.permission, null, mode);
      assert.equal(r.fullAccess, false, mode);
      assert.equal(r.ceiling, 'default', mode);
    }
  });

  it("'glm' aliases to the OpenCode table", () => {
    for (const mode of ['plan', 'bypassPermissions', 'default']) {
      assert.deepEqual(
        mapPermissionModeToVendorFlags('glm', mode, {}),
        mapPermissionModeToVendorFlags('opencode', mode, {}),
      );
    }
  });
});

// ===========================================================================
// Cross-cutting: unknown vendor fail-closed, vendor casing, client can't cross vendors
// ===========================================================================
describe('mapPermissionModeToVendorFlags — fail-closed & robustness', () => {
  it('unknown vendor -> locked default (no flags, no access, no network)', () => {
    for (const v of ['claude', 'agy', 'cursor', 'kimi', '', undefined as unknown as string]) {
      const r = mapPermissionModeToVendorFlags(v, 'bypassPermissions', {});
      assert.deepEqual(r.flags, [], `unknown vendor ${JSON.stringify(v)} must emit no flags`);
      assert.equal(r.fullAccess, false);
      assert.equal(r.network, false);
      assert.equal(r.ceiling, 'locked');
    }
  });

  it('vendorId is case-insensitive / trimmed', () => {
    assert.deepEqual(mapPermissionModeToVendorFlags('  OpenCode ', 'plan', {}).flags, ['--agent', 'plan']);
  });

  it('a junk/unknown client mode never escalates', () => {
    // 'nonsense' normalizes to 'default' -> no escalation.
    assert.deepEqual(mapPermissionModeToVendorFlags('opencode', 'nonsense', {}).flags, []);
    assert.equal(mapPermissionModeToVendorFlags('opencode', 'nonsense', {}).fullAccess, false);
  });
});
