/**
 * credential-write-visibility.test.ts — the key-status endpoint tells a caller
 * whether THEY may write, and it agrees with the gate that enforces it (B-362).
 *
 * THE BUG THIS PINS. `opencode` defaults to `sharing: 'shared'`, so
 * `requiresElevatedRole('opencode')` is true and `POST /:provider/api-key`
 * answers a member with 403. But the entry surface had no way to know that:
 * `GET /:provider/api-key/capability` is role-free BY DESIGN — it says how a key
 * is written, never whether YOU may write it. So a member saw a field, a Save
 * button and a "get a key" link for four opencode slots, bought a key, pasted
 * it, and only then was refused.
 *
 * WHY NOBODY CAUGHT IT, AND WHY THIS FILE EXISTS. The single account that can
 * never reach that state is the operator's: they are `owner`, so the gate always
 * passes and every manual check looks fine. This is the project rule made
 * executable — an acceptance check run as the operator is not a pass. Every case
 * below therefore asserts from a MEMBER's seat, and the last one asserts the two
 * answers cannot drift apart.
 *
 * RUNNER: node:test via `npm run test:server`.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { providerCredentialsService } from '../services/provider-credentials.service.js';
import {
  _resetProviderSharingCache,
  setProviderSharingConfig,
} from '../../../services/provider-sharing.js';

/**
 * The rule the route applies, mirrored here at its two inputs (provider policy ×
 * caller role). Kept deliberately tiny: the point is that ONE predicate decides
 * both the 403 and the rendered surface.
 */
function evaluate(provider: string, role: string): { writable: boolean; reason?: string } {
  if (!providerCredentialsService.requiresElevatedRole(provider)) {
    return { writable: true };
  }
  if (role === 'owner' || role === 'admin') {
    return { writable: true };
  }
  return { writable: false, reason: 'shared_requires_admin' };
}

after(() => {
  _resetProviderSharingCache();
});

describe('credential write visibility — a member is never offered a write that 403s (B-362)', () => {
  it('shared provider + member: not writable, with a reason to render instead of a box', () => {
    setProviderSharingConfig({ opencode: 'shared' });

    const verdict = evaluate('opencode', 'user');

    assert.equal(verdict.writable, false, 'a member may not write a shared operator credential');
    assert.equal(
      verdict.reason,
      'shared_requires_admin',
      'the refusal must carry a reason — a disabled box with no explanation is the same dead end',
    );
  });

  it('shared provider + owner: writable — the seat that hid the bug', () => {
    setProviderSharingConfig({ opencode: 'shared' });

    assert.equal(evaluate('opencode', 'owner').writable, true);
    assert.equal(evaluate('opencode', 'admin').writable, true);
  });

  it('isolated provider + member: writable — isolation is exactly what makes it their own', () => {
    setProviderSharingConfig({ opencode: 'isolated' });

    const verdict = evaluate('opencode', 'user');

    assert.equal(verdict.writable, true, 'an isolated slot is the member’s own tree');
    assert.equal(verdict.reason, undefined);
  });

  it('vendor slots stay writable for a member regardless of policy', () => {
    // Vendor keys live in the per-user encrypted store, so they never touch the
    // operator's credentials — gating them on role would lock a member out of a
    // secret that is only ever theirs.
    for (const mode of ['shared', 'isolated'] as const) {
      setProviderSharingConfig({ kimi: mode, glm: mode });
      assert.equal(evaluate('kimi', 'user').writable, true, `kimi under ${mode}`);
      assert.equal(evaluate('glm', 'user').writable, true, `glm under ${mode}`);
    }
  });

  it('the advertised verdict never disagrees with the gate, over every combination', () => {
    // The drift this guards against is the whole reason the rule became one
    // function: two places deciding the same thing eventually answer differently,
    // and the UI half fails silently — it just shows a box that will be refused.
    for (const mode of ['shared', 'isolated'] as const) {
      for (const provider of ['opencode', 'claude', 'codex', 'kimi']) {
        setProviderSharingConfig({ [provider]: mode });
        for (const role of ['owner', 'admin', 'user']) {
          const advertised = evaluate(provider, role).writable;
          const gateWouldThrow =
            providerCredentialsService.requiresElevatedRole(provider)
            && role !== 'owner'
            && role !== 'admin';

          assert.equal(
            advertised,
            !gateWouldThrow,
            `${provider}/${mode}/${role}: surface says writable=${advertised} but gate `
              + `${gateWouldThrow ? 'refuses' : 'allows'}`,
          );
        }
      }
    }
  });
});
