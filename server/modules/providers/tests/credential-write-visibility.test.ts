/**
 * credential-write-visibility.test.ts — B-362 after ADR-152 A1 (T-2083).
 *
 * B-362 was a member being offered a key field for a SHARED opencode slot and
 * then refused with 403. The install-wide sharing policy is retired: every key a
 * caller writes lands in their OWN tree, so there is no shared slot, no role
 * predicate and no refusal reason left to render. This pins that the role
 * predicate is gone from the service, so the surface and the gate cannot drift
 * apart again.
 *
 * RUNNER: node:test via `npm run test:server`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { providerCredentialsService } from '../services/provider-credentials.service.js';

describe('credential write visibility — no role decides whose tree a key lands in (B-362, ADR-152 A1)', () => {
  it('the service exposes no elevated-role predicate for credential writes', () => {
    assert.equal('requiresElevatedRole' in providerCredentialsService, false);
  });
});
