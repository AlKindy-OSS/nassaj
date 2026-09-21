/**
 * T-820 — the FAIL-CLOSED strict env resolver (§هـ-1, the ToS blocker).
 *
 * The shared resolveProviderEnv is fail-OPEN (null/undefined/'' => base owner
 * env). On the background-task path that is a silent subscription-sharing risk,
 * so resolveProviderEnvStrict THROWS on any non-positive-integer id instead of
 * falling through to the owner subscription.
 *
 * This suite asserts the THROW contract exhaustively (the security-critical
 * half). The delegate-on-valid-id half is exercised end-to-end by the GATE2
 * suite and the T-820 shadow harness (which need a real DB/FS the strict wrapper
 * intentionally does not stub here).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProviderEnvStrict } from '@/services/isolation/resolve-provider-env-strict.js';

test('resolveProviderEnvStrict: THROWS for every non-positive-integer id (no owner fallback)', () => {
  const bad = [null, undefined, '', 'abc', '5', 0, -1, -100, 1.5, NaN, {}, [], true];
  for (const id of bad) {
    assert.throws(
      // @ts-expect-error deliberately passing invalid ids
      () => resolveProviderEnvStrict(id, 'claude', { HOME: '/x' }),
      /fail-closed/,
      `id=${JSON.stringify(id)} must throw (never fall through to the owner env)`,
    );
  }
});

test('resolveProviderEnvStrict: the fail-open null case that the shared resolver allows is BLOCKED here', () => {
  // The exact hole the critic flagged: resolveProviderEnv(null) returns the base
  // (owner) env; the strict wrapper refuses instead.
  assert.throws(
    // @ts-expect-error null id
    () => resolveProviderEnvStrict(null, 'claude', { CLAUDE_CONFIG_DIR: '/owner/.claude' }),
    /non-integer\/non-positive userId/,
  );
});
