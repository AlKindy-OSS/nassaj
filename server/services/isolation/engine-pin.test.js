/**
 * engine-pin.test.js — ADR-088 (B-258/B-262/B-358) decision-core tests.
 *
 * The inference fixtures are DERIVED FROM THE REAL incident transcript
 * (session 43b0dc60, 2026-07-31), not invented: its assistant-model sequence
 * is kimi-k3 ×21 → claude-opus-5 ×43 → kimi-k2.6 ×44 — a vendor session whose
 * middle was stolen by a leaked official turn. Synthetic-fixture confidence is
 * exactly how the first reconcile fix shipped broken
 * (feedback_synthetic_fixtures_false_confidence).
 *
 * Run: npx tsx --test server/services/isolation/engine-pin.test.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OFFICIAL_ENGINE,
  enginePinEnforceEnabled,
  resolveSpawnEngine,
  inferEngineFromHistory,
  pickEngineModel,
} from './engine-pin.js';

// Catalogs as of 2026-07-31 (vendor-config fallbacks). The claude ids are NOT
// in any engine catalog — that asymmetry is what the inference rule leans on.
const CATALOGS = {
  kimi: ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3'],
  glm: ['glm-5.2'],
};

// ---------------------------------------------------------------------------
// resolveSpawnEngine — the decision table (server wins, shadow by default)
// ---------------------------------------------------------------------------

test('unknown stored state honours the client verbatim (today\'s behaviour)', () => {
  for (const enforce of [false, true]) {
    assert.deepEqual(
      resolveSpawnEngine({ storedEngine: null, clientEngine: null, enforce }),
      { engine: null, decision: 'client', mismatch: false },
    );
    assert.deepEqual(
      resolveSpawnEngine({ storedEngine: null, clientEngine: 'kimi', enforce }),
      { engine: 'kimi', decision: 'client', mismatch: false },
    );
  }
});

test('stored and client agreeing is a silent match — both axes', () => {
  assert.deepEqual(
    resolveSpawnEngine({ storedEngine: 'kimi', clientEngine: 'kimi', enforce: true }),
    { engine: 'kimi', decision: 'match', mismatch: false },
  );
  // stored 'anthropic' + client null: official on both sides.
  assert.deepEqual(
    resolveSpawnEngine({ storedEngine: OFFICIAL_ENGINE, clientEngine: null, enforce: true }),
    { engine: null, decision: 'match', mismatch: false },
  );
});

test('THE INCIDENT ROW: stored engine + absent client stamp → server wins under enforcement', () => {
  // Session 43b0dc60's second turn: localStorage stamp lost ⇒ client sent null.
  const verdict = resolveSpawnEngine({ storedEngine: 'kimi', clientEngine: null, enforce: true });
  assert.deepEqual(verdict, { engine: 'kimi', decision: 'server-wins', mismatch: true });
});

test('shadow mode (flag off) keeps today\'s behaviour byte-for-byte and only flags', () => {
  const verdict = resolveSpawnEngine({ storedEngine: 'kimi', clientEngine: null, enforce: false });
  assert.deepEqual(verdict, { engine: null, decision: 'shadow', mismatch: true });
});

test('stored official beats a stale vendor stamp under enforcement (B-218 replay)', () => {
  const verdict = resolveSpawnEngine({
    storedEngine: OFFICIAL_ENGINE,
    clientEngine: 'kimi',
    enforce: true,
  });
  assert.deepEqual(verdict, { engine: null, decision: 'server-wins', mismatch: true });
});

test('stored engine X beats a disagreeing engine Y under enforcement', () => {
  const verdict = resolveSpawnEngine({ storedEngine: 'glm', clientEngine: 'kimi', enforce: true });
  assert.deepEqual(verdict, { engine: 'glm', decision: 'server-wins', mismatch: true });
});

test('whitespace/empty inputs normalize to null on both axes', () => {
  assert.equal(resolveSpawnEngine({ storedEngine: '  ', clientEngine: ' ', enforce: true }).decision, 'client');
});

// ---------------------------------------------------------------------------
// inferEngineFromHistory — the backfill rule (any engine id, never "last")
// ---------------------------------------------------------------------------

test('KILLER CASE: incident transcript truncated AT the stolen turn still pins kimi', () => {
  // If the session had ended right after the leak, the LAST model id would be
  // claude-opus-5 — a last-id rule would return "none" and the backfill would
  // freeze the leak as an official pin (qa-critic حرج 1). The any-id rule pins kimi.
  const truncatedAtTheft = ['kimi-k3', 'claude-opus-5'];
  assert.deepEqual(
    inferEngineFromHistory(truncatedAtTheft, CATALOGS),
    { kind: 'engine', engine: 'kimi' },
  );
});

test('full incident history (leak in the middle) pins kimi', () => {
  const full = ['kimi-k3', 'claude-opus-5', 'kimi-k2.6'];
  assert.deepEqual(inferEngineFromHistory(full, CATALOGS), { kind: 'engine', engine: 'kimi' });
});

test('two engines in one history is AMBIGUOUS — refused, never guessed', () => {
  const hint = inferEngineFromHistory(['kimi-k3', 'glm-5.2'], CATALOGS);
  assert.equal(hint.kind, 'ambiguous');
  assert.deepEqual(hint.engines, ['glm', 'kimi']);
});

test('official-only, retired-vendor, and sentinel ids all stay UNKNOWN — never "official"', () => {
  // Real ids observed in this host's transcripts that are in NO loaded catalog:
  for (const history of [
    ['claude-opus-5', 'claude-fable-5'],
    ['kimi-k1-retired'],
    ['<synthetic>', 'opus', 'sonnet'],
    [],
  ]) {
    assert.deepEqual(inferEngineFromHistory(history, CATALOGS), { kind: 'none' });
  }
});

test('a missing/failed engine catalog only reduces matches (fail toward unknown)', () => {
  assert.deepEqual(inferEngineFromHistory(['kimi-k3'], { glm: CATALOGS.glm }), { kind: 'none' });
  assert.deepEqual(inferEngineFromHistory(['kimi-k3'], {}), { kind: 'none' });
  assert.deepEqual(inferEngineFromHistory(['kimi-k3'], undefined), { kind: 'none' });
});

// ---------------------------------------------------------------------------
// pickEngineModel — membership-checked model restore (qa-critic بند 9)
// ---------------------------------------------------------------------------

const KIMI_CATALOG = {
  OPTIONS: CATALOGS.kimi.map((value) => ({ value })),
  DEFAULT: 'kimi-k2.6',
};

test('polluted transcript model (claude id) falls to the ENGINE default, with a warning', () => {
  const warnings = [];
  const model = pickEngineModel({
    engine: 'kimi',
    resolvedModel: 'claude-opus-5', // what resolveResumeModel returns for 43b0dc60
    clientModel: 'default',
    catalog: KIMI_CATALOG,
    warn: (m) => warnings.push(m),
  });
  assert.equal(model, 'kimi-k2.6');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /claude-opus-5/);
});

test('transcript model that IS an engine model wins over the client value', () => {
  const model = pickEngineModel({
    engine: 'kimi',
    resolvedModel: 'kimi-k3',
    clientModel: 'kimi-k2.6',
    catalog: KIMI_CATALOG,
  });
  assert.equal(model, 'kimi-k3');
});

test('client engine model is used when the transcript has none', () => {
  const model = pickEngineModel({
    engine: 'kimi',
    resolvedModel: null,
    clientModel: 'kimi-k3',
    catalog: KIMI_CATALOG,
  });
  assert.equal(model, 'kimi-k3');
});

test('catalog outage: first candidate passes through unmodified (no invented values)', () => {
  const model = pickEngineModel({
    engine: 'kimi',
    resolvedModel: 'kimi-k3',
    clientModel: null,
    catalog: null,
  });
  assert.equal(model, 'kimi-k3');
});

test('no candidates at all yields the engine default', () => {
  const model = pickEngineModel({
    engine: 'kimi',
    resolvedModel: null,
    clientModel: null,
    catalog: KIMI_CATALOG,
  });
  assert.equal(model, 'kimi-k2.6');
});

// ---------------------------------------------------------------------------
// enginePinEnforceEnabled — the flag contract
// ---------------------------------------------------------------------------

test('enforcement flag defaults ON and only explicit 0/false opts out', () => {
  assert.equal(enginePinEnforceEnabled({}), true);
  assert.equal(enginePinEnforceEnabled({ NASSAJ_ENGINE_PIN_ENFORCE: '0' }), false);
  assert.equal(enginePinEnforceEnabled({ NASSAJ_ENGINE_PIN_ENFORCE: 'false' }), false);
  assert.equal(enginePinEnforceEnabled({ NASSAJ_ENGINE_PIN_ENFORCE: 'yes' }), true);
  assert.equal(enginePinEnforceEnabled({ NASSAJ_ENGINE_PIN_ENFORCE: '1' }), true);
  assert.equal(enginePinEnforceEnabled({ NASSAJ_ENGINE_PIN_ENFORCE: 'true' }), true);
});
