/**
 * vendor-config.agent-catalogs.test.ts — the ADDITIVE governed-CLI agent catalogs
 * (GL-2 / KM-4, ADR-062). Pure unit test: no fs, no DB, no spawn.
 *
 * Proves the new agent/carrier exports are correct AND that the pre-existing chat-path
 * exports (VENDOR_RUNTIME / KIMI_FALLBACK_MODELS / GLM_FALLBACK_MODELS) are UNTOUCHED —
 * the live toolless chat seam (vendor-runtime.js) must not regress.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GLM_CARRIER_BASE_URL as MATERIAL_GLM_BASE_URL,
  GLM_CARRIER_MODELS as MATERIAL_GLM_MODELS,
  OPENCODE_GLM_NPM,
} from '@/services/isolation/opencode-config-material.js';

import {
  VENDOR_RUNTIME,
  KIMI_FALLBACK_MODELS,
  GLM_FALLBACK_MODELS,
  DEEPSEEK_FALLBACK_MODELS,
  GLM_CARRIER_BASE_URL,
  GLM_CARRIER_MODELS,
  KIMI_AGENT_MODELS,
} from './vendor-config.js';

describe('vendor-config — GLM carrier constants (GL-2)', () => {
  it('GLM_CARRIER_BASE_URL is z.ai\'s OpenAI-compatible coding-plan endpoint (B-221)', () => {
    // B-221: the carrier wire moved off the Anthropic endpoint because opencode cannot
    // drive @ai-sdk/anthropic at all (it never issues the request). The path had to
    // follow the SDK.
    assert.equal(GLM_CARRIER_BASE_URL, 'https://api.z.ai/api/coding/paas/v4');
  });

  it('the carrier baseURL shares the chat path\'s HOST — the property GL-3 enforces', () => {
    // GL-3's allowlist is host-scoped (ALLOWED_CARRIER_HOST = hostOf(GLM_CARRIER_BASE_URL)),
    // so this equality — NOT full-URL equality — is what keeps "the carrier can never
    // point at a host the vetted chat path did not use" true. Locking it here means a
    // future edit to either constant cannot silently split the two hosts apart.
    assert.equal(
      new URL(GLM_CARRIER_BASE_URL).host,
      new URL(VENDOR_RUNTIME.glm.baseUrl).host,
      'carrier and chat path must resolve to ONE host',
    );
    assert.equal(new URL(GLM_CARRIER_BASE_URL).host, 'api.z.ai');
    // The two are deliberately DIFFERENT urls now; asserting that keeps the split
    // intentional rather than an accident someone "fixes" back into a broken state.
    assert.notEqual(GLM_CARRIER_BASE_URL, VENDOR_RUNTIME.glm.baseUrl);
  });

  it('GLM_CARRIER_MODELS is an opencode.json-shaped record derived from GLM_FALLBACK_MODELS', () => {
    const keys = Object.keys(GLM_CARRIER_MODELS);
    assert.deepEqual(
      keys,
      GLM_FALLBACK_MODELS.OPTIONS.map((m) => m.value),
      'one carrier model entry per fallback option (single source of truth)',
    );
    for (const opt of GLM_FALLBACK_MODELS.OPTIONS) {
      assert.deepEqual(GLM_CARRIER_MODELS[opt.value], { name: opt.label });
    }
    assert.ok(keys.includes('glm-5.2'), 'includes the default glm-5.2 id');
  });

  it('B-220: no bracketed variant id is advertised on either the chat or carrier catalog', () => {
    // `glm-5.2[1m]` is not a wire id — z.ai answers `1211 Unknown Model`. Brackets are
    // opencode's variant notation, never a vendor id, so no z.ai catalog may carry one.
    for (const id of Object.keys(GLM_CARRIER_MODELS)) {
      assert.ok(!id.includes('['), `carrier catalog must not advertise a variant id: ${id}`);
    }
    for (const opt of GLM_FALLBACK_MODELS.OPTIONS) {
      assert.ok(!opt.value.includes('['), `chat catalog must not advertise a variant id: ${opt.value}`);
    }
  });

  it('the isolation-layer opencode-config material MIRRORS vendor-config exactly (no drift)', () => {
    // opencode-config-material.js must define the carrier constants LOCALLY (the eslint
    // boundaries rule forbids the isolation layer importing modules/* internals), so this
    // equality lock is the single-source-of-truth guarantee across the boundary.
    assert.equal(MATERIAL_GLM_BASE_URL, GLM_CARRIER_BASE_URL, 'baseURL must match vendor-config');
    assert.deepEqual(MATERIAL_GLM_MODELS, GLM_CARRIER_MODELS, 'model catalog must match vendor-config');
    // B-221: opencode 1.17.18 produces a zero-token `step-finish reason:"unknown"` — the
    // request is never issued — when a provider is bound to @ai-sdk/anthropic. Pinning
    // the working binding here stops a well-meaning revert to the "Anthropic-wire" SDK.
    assert.equal(OPENCODE_GLM_NPM, '@ai-sdk/openai-compatible');
    assert.notEqual(OPENCODE_GLM_NPM, '@ai-sdk/anthropic');
  });
});

describe('vendor-config — Kimi agent catalog (KM-4)', () => {
  it('KIMI_AGENT_MODELS reuses the conservative chat catalog (one source of truth)', () => {
    assert.deepEqual(KIMI_AGENT_MODELS, KIMI_FALLBACK_MODELS);
    assert.equal(KIMI_AGENT_MODELS.DEFAULT, 'kimi-k2.6');
  });
});

describe('vendor-config — chat path is NOT broken by the additive agent exports', () => {
  it('VENDOR_RUNTIME still carries the three hosted providers with hard-coded base URLs', () => {
    assert.deepEqual(Object.keys(VENDOR_RUNTIME).sort(), ['deepseek', 'glm', 'kimi']);
    assert.equal(VENDOR_RUNTIME.kimi.baseUrl, 'https://api.moonshot.ai/anthropic');
    assert.equal(VENDOR_RUNTIME.deepseek.baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(VENDOR_RUNTIME.glm.baseUrl, 'https://api.z.ai/api/anthropic');
    assert.equal(VENDOR_RUNTIME.kimi.messagesUrl, 'https://api.moonshot.ai/anthropic/v1/messages');
    assert.equal(VENDOR_RUNTIME.glm.keyEnv, 'GLM_API_KEY');
    assert.equal(VENDOR_RUNTIME.kimi.keyEnv, 'KIMI_API_KEY');
  });

  it('the chat fallback catalogs are unchanged', () => {
    assert.equal(KIMI_FALLBACK_MODELS.DEFAULT, 'kimi-k2.6');
    assert.equal(GLM_FALLBACK_MODELS.DEFAULT, 'glm-5.2');
    assert.equal(DEEPSEEK_FALLBACK_MODELS.DEFAULT, 'deepseek-v4-pro');
    // The carrier catalog is a DERIVED view, not a mutation of the source.
    assert.ok(Array.isArray(GLM_FALLBACK_MODELS.OPTIONS), 'source OPTIONS array intact');
  });
});
