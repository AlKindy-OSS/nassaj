import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { PROVIDER_MODELS_CACHE_VERSION } from '@/modules/providers/services/provider-models.service.js';
import { GLM_CARRIER_MODELS } from '@/modules/providers/shared/vendor/vendor-config.js';

/**
 * B-234 tripwire — "deleted from the code" is not "deleted" while a written
 * catalog still names it.
 *
 * The served model catalog is persisted to `~/.cloudcli/provider-models-cache.json`
 * for three days. Ids that OUR code declares (the GLM carrier block that becomes
 * `provider.glm.models` in opencode.json, and therefore `glm/<id>` in the opencode
 * listing) can be removed from every source file and still be offered by the
 * picker until that file expires — which is exactly what happened when B-220
 * deleted the phantom `glm-5.2[1m]`: the live listing was clean, the cached one was
 * not, the operator picked the phantom, and the run died with exit code 1.
 *
 * The one lever that retires a written catalog early is PROVIDER_MODELS_CACHE_VERSION
 * (a mismatch discards the whole file on read). This test pins the carrier catalog
 * to the version that was current when it was last changed, so changing the catalog
 * without bumping the version fails here instead of in the picker three days later.
 *
 * WHEN THIS TEST FAILS: you changed GLM_CARRIER_MODELS. Bump
 * PROVIDER_MODELS_CACHE_VERSION, then update the two pinned values below.
 */
const PINNED = {
  cacheVersion: 2,
  // sha256 of the canonical JSON of GLM_CARRIER_MODELS at version 2 ({'glm-5.2'}).
  carrierFingerprint: crypto
    .createHash('sha256')
    .update(JSON.stringify({ 'glm-5.2': { name: 'GLM 5.2' } }))
    .digest('hex'),
};

const fingerprintCarrierModels = (): string =>
  crypto.createHash('sha256').update(JSON.stringify(GLM_CARRIER_MODELS)).digest('hex');

test('the GLM carrier catalog and the cache version move together (B-234)', () => {
  const actual = fingerprintCarrierModels();

  if (actual !== PINNED.carrierFingerprint) {
    assert.notEqual(
      PROVIDER_MODELS_CACHE_VERSION,
      PINNED.cacheVersion,
      'GLM_CARRIER_MODELS changed but PROVIDER_MODELS_CACHE_VERSION did not. '
        + 'Catalogs already written to ~/.cloudcli/provider-models-cache.json keep '
        + 'offering the old ids for three days (B-234). Bump the version, then update '
        + 'the pinned values in this test.',
    );
    return;
  }

  assert.equal(
    PROVIDER_MODELS_CACHE_VERSION,
    PINNED.cacheVersion,
    'PROVIDER_MODELS_CACHE_VERSION changed without a carrier-catalog change — update '
      + 'the pinned values in this test so the tripwire keeps tracking the current pair.',
  );
});

test('the deleted phantom id is absent from the carrier catalog (B-220)', () => {
  assert.equal(
    Object.keys(GLM_CARRIER_MODELS).some((id) => id.includes('[')),
    false,
    'Bracketed ids are opencode variant notation, never a z.ai wire id — z.ai answers '
      + '`1211 Unknown Model`.',
  );
});
