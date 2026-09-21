/**
 * provider-fingerprint.test.js — T-1144.
 *
 * Every wire-shape assertion below is backed by the REAL incident transcript
 * (session 43b0dc60, 2026-07-31), verified against the file itself:
 *   kimi-k3   turns → message.id "chatcmpl-6a6c7500…", NO requestId
 *   kimi-k2.6 turns → message.id "chatcmpl-…",        NO requestId
 *   claude-opus-5   → message.id "msg_synthetic_011CdZzM…" + requestId "req_synthetic_011CdZzM…"
 *
 * Run: npx tsx --test server/services/provider-fingerprint.test.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_DISPLAY_NAME, fingerprintResponseProvider } from './provider-fingerprint.js';

// ---------------------------------------------------------------------------
// Anthropic envelope
// ---------------------------------------------------------------------------

test('msg_ id + req_ requestId ⇒ anthropic (the incident\'s stolen turn)', () => {
  assert.equal(
    fingerprintResponseProvider({
      messageId: 'msg_synthetic_011CdZzMcJGtTfm91NxJ3Qu8',
      requestId: 'req_synthetic_011CdZzMaWsgHFQ6ZeFhUTfM',
      modelId: 'claude-opus-5',
    }),
    'anthropic',
  );
});

test('msg_ id alone (older CLI without requestId) still ⇒ anthropic', () => {
  assert.equal(
    fingerprintResponseProvider({ messageId: 'msg_01XyZ', requestId: null, modelId: 'claude-fable-5' }),
    'anthropic',
  );
  assert.equal(
    fingerprintResponseProvider({ messageId: null, requestId: 'req_01XyZ', modelId: 'claude-opus-5' }),
    'anthropic',
  );
});

test('anthropic verdict is not swayed by an aliased/ambiguous model id', () => {
  // Defensive: even if a transcript ever recorded a vendor-sounding id on a
  // msg_ envelope, the envelope wins — it is the wire evidence.
  assert.equal(
    fingerprintResponseProvider({ messageId: 'msg_01A', requestId: 'req_01A', modelId: 'kimi-k3' }),
    'anthropic',
  );
});

// ---------------------------------------------------------------------------
// Vendor envelope (chatcmpl-) — named via the measured model catalogs
// ---------------------------------------------------------------------------

test('chatcmpl- + kimi catalog id ⇒ moonshot (incident\'s kimi-k3 and kimi-k2.6 turns)', () => {
  for (const modelId of ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code']) {
    assert.equal(
      fingerprintResponseProvider({ messageId: 'chatcmpl-6a6c75002861d64155cd4a3a', requestId: null, modelId }),
      'moonshot',
    );
  }
});

test('chatcmpl- + glm catalog id ⇒ zai; deepseek id ⇒ deepseek', () => {
  assert.equal(
    fingerprintResponseProvider({ messageId: 'chatcmpl-abc', requestId: null, modelId: 'glm-5.2' }),
    'zai',
  );
  assert.equal(
    fingerprintResponseProvider({ messageId: 'chatcmpl-abc', requestId: null, modelId: 'deepseek-v4-pro' }),
    'deepseek',
  );
});

test('chatcmpl- + id in NO vendor catalog ⇒ generic openai-compatible, never guessed', () => {
  assert.equal(
    fingerprintResponseProvider({ messageId: 'chatcmpl-abc', requestId: null, modelId: 'kimi-k1-retired' }),
    'openai-compatible',
  );
  assert.equal(
    fingerprintResponseProvider({ messageId: 'chatcmpl-abc', requestId: null, modelId: 'claude-opus-5' }),
    'openai-compatible',
  );
});

// ---------------------------------------------------------------------------
// Unknown / missing evidence
// ---------------------------------------------------------------------------

test('missing or foreign envelope ⇒ unknown', () => {
  assert.equal(fingerprintResponseProvider({}), 'unknown');
  assert.equal(
    fingerprintResponseProvider({ messageId: 'weird-id', requestId: null, modelId: 'x' }),
    'unknown',
  );
});

test('display names exist for every verdict', () => {
  for (const key of ['anthropic', 'moonshot', 'zai', 'deepseek', 'openai-compatible', 'unknown']) {
    assert.equal(typeof PROVIDER_DISPLAY_NAME[key], 'string');
  }
});
