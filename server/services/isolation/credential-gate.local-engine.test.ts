/**
 * ADR-227 / T-2098 stage 3a — the Claude credential predicate for a LOCAL engine.
 * A Claude turn on a caller-owned local server spends no Anthropic credential and
 * no vendor key, so it needs none — and no grant applies (sharing waits for
 * T-1807). Server ownership is enforced by the run profile, not here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { CREDENTIAL_PREDICATES } = await import('./credential-gate.js');
const { formatLocalEnginePin } = await import('./local-engine-pin.js');

const ctx = (engine: string | null, model: string | null = null) => ({
  actor: 7, mode: 'agent', model, engine, honorGrants: true,
});
const pin = formatLocalEnginePin({ serverId: '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11', ownerId: 7, origin: 'http://127.0.0.1:18080' });

test('a local pin or the bare local engine needs no credential and takes no grant', () => {
  for (const engine of [pin, 'local']) {
    const requirement = CREDENTIAL_PREDICATES.claude(ctx(engine));
    assert.ok(requirement, engine);
    assert.equal(requirement.unit, 'local');
    assert.equal(requirement.own, true, 'no grant applies');
    assert.equal(requirement.linked(7), true);
  }
});

test('a new official-engine turn that names a local model is admitted as local', () => {
  const requirement = CREDENTIAL_PREDICATES.claude(ctx(null, 'nassaj_local_abc/gpt-oss-20b'));
  assert.equal(requirement?.unit, 'local');
});

test('official and vendor engines keep their existing requirements', () => {
  assert.equal(CREDENTIAL_PREDICATES.claude(ctx(null))?.unit, 'claude');
  assert.equal(CREDENTIAL_PREDICATES.claude(ctx('anthropic'))?.unit, 'claude');
  assert.equal(CREDENTIAL_PREDICATES.claude(ctx('glm'))?.unit, 'glm');
  assert.equal(CREDENTIAL_PREDICATES.claude(ctx('local:forged')), null, 'a malformed pin is not placed');
});
