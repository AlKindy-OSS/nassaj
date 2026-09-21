/**
 * opencode-baseurl-guard.local-binding.test.js — GL-3 per-block origin binding (B-1268,
 * ADR-163 §8). Pure filesystem/string unit test: no DB, no spawn, no opencode binary.
 *
 * Proves:
 *  - GLM NON-REGRESSION: with NO local servers the allowlist is exactly api.z.ai — the
 *    pre-ADR-163 behaviour — and a `glm` block pointed anywhere else is refused.
 *  - a `glm` block aimed at a REGISTERED local server's origin is refused (that block
 *    carries the carrier key; only the vetted host may receive it).
 *  - a `nassaj_local_<id>` block may use ITS OWN endpoint only: another registered
 *    server's origin, or an unregistered origin, is refused.
 *  - a corrupt stored endpoint is dropped from the map: it refuses its own block and
 *    does NOT block the carrier block in the same config.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ALLOWED_CARRIER_HOST,
  OPENCODE_BASEURL_NOT_ALLOWED,
  assertOpenCodeBaseUrlAllowed,
} from './opencode-baseurl-guard.js';
import { GLM_CARRIER_BASE_URL } from './opencode-config-material.js';

const LOCAL_A = 'nassaj_local_aaaa';
const LOCAL_B = 'nassaj_local_bbbb';
const ENDPOINT_A = 'http://127.0.0.1:11434/v1';
const ENDPOINT_B = 'http://100.64.0.5:8000/v1';

/** Shape of a real generated config: the fixed glm block plus generated local blocks. */
const configWith = (providers) => JSON.stringify({
  provider: Object.fromEntries(Object.entries(providers).map(([id, baseURL]) => [id, {
    npm: '@ai-sdk/openai-compatible',
    options: { baseURL },
  }])),
});

async function withConfig(contents, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oc-local-binding-'));
  const configPath = path.join(dir, 'opencode.json');
  try {
    await writeFile(configPath, contents, 'utf8');
    await run(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function refusal(fn) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, OPENCODE_BASEURL_NOT_ALLOWED);
    return err;
  }
  assert.fail('expected the guard to refuse');
  return null;
}

describe('GL-3 — GLM non-regression with the local feature idle', () => {
  it('allows the carrier block and nothing else when no local server is registered', async () => {
    await withConfig(configWith({ glm: GLM_CARRIER_BASE_URL }), (configPath) => {
      assert.doesNotThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}, {}));
      assert.doesNotThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}));
    });
    assert.equal(ALLOWED_CARRIER_HOST, 'api.z.ai');
  });

  it('refuses a local block when the caller has no registered server', async () => {
    await withConfig(configWith({ glm: GLM_CARRIER_BASE_URL, [LOCAL_A]: ENDPOINT_A }), (configPath) => {
      assert.equal(refusal(() => assertOpenCodeBaseUrlAllowed(configPath, {}, {})).reason, 'disallowed_host');
    });
  });

  it('refuses a carrier block aimed at any other host', async () => {
    await withConfig(configWith({ glm: 'https://api.competitor.example/v1' }), (configPath) => {
      refusal(() => assertOpenCodeBaseUrlAllowed(configPath, {}, {}));
    });
  });
});

describe('GL-3 — every block is bound to its own host', () => {
  const registered = { [LOCAL_A]: ENDPOINT_A, [LOCAL_B]: ENDPOINT_B };

  it('refuses the glm block pointed at a REGISTERED local origin', async () => {
    await withConfig(configWith({ glm: ENDPOINT_A }), (configPath) => {
      assert.equal(refusal(() => assertOpenCodeBaseUrlAllowed(configPath, {}, registered)).reason, 'disallowed_host');
    });
  });

  it('allows each local block on its own endpoint alongside the carrier', async () => {
    await withConfig(configWith({ glm: GLM_CARRIER_BASE_URL, [LOCAL_A]: ENDPOINT_A, [LOCAL_B]: ENDPOINT_B }), (configPath) => {
      assert.doesNotThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}, registered));
    });
  });

  it('refuses a local block pointed at ANOTHER registered server', async () => {
    await withConfig(configWith({ [LOCAL_A]: ENDPOINT_B }), (configPath) => {
      refusal(() => assertOpenCodeBaseUrlAllowed(configPath, {}, registered));
    });
  });

  it('refuses a local block pointed at an unregistered origin', async () => {
    await withConfig(configWith({ [LOCAL_A]: 'http://192.168.1.9:11434/v1' }), (configPath) => {
      refusal(() => assertOpenCodeBaseUrlAllowed(configPath, {}, registered));
    });
  });

  it('refuses an unknown provider block even on the carrier host', async () => {
    await withConfig(configWith({ anthropic: GLM_CARRIER_BASE_URL }), (configPath) => {
      refusal(() => assertOpenCodeBaseUrlAllowed(configPath, {}, registered));
    });
  });
});

describe('GL-3 — a corrupt stored endpoint cannot block the carrier', () => {
  const corrupt = { [LOCAL_A]: 'not a url', [LOCAL_B]: ENDPOINT_B };

  it('still allows the carrier block', async () => {
    await withConfig(configWith({ glm: GLM_CARRIER_BASE_URL, [LOCAL_B]: ENDPOINT_B }), (configPath) => {
      assert.doesNotThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}, corrupt));
    });
  });

  it('refuses only the block whose row is corrupt', async () => {
    await withConfig(configWith({ glm: GLM_CARRIER_BASE_URL, [LOCAL_A]: ENDPOINT_A }), (configPath) => {
      refusal(() => assertOpenCodeBaseUrlAllowed(configPath, {}, corrupt));
    });
  });
});
