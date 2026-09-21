import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGenerationExchange, reconcileUpdateGenerations, UPDATE_GENERATION_NAMES } from './update-generation-reconciliation.mjs';

const previous = 'a'.repeat(64), target = 'b'.repeat(64), other = 'c'.repeat(64);
const pending = { previous, target, live: previous, candidate: target };
const exchanged = { previous, target, live: target, candidate: previous };
const plan = (generations, overrides = {}) => reconcileUpdateGenerations({
    generationNames: UPDATE_GENERATION_NAMES, generations, direction: 'forward', databaseState: 'PRE_CANDIDATE', ...overrides,
});

test('both-side identities distinguish lost receipt, absent exchange and identical generation', () => {
    assert.equal(classifyGenerationExchange(pending), 'pending');
    assert.equal(classifyGenerationExchange(exchanged), 'exchanged');
    assert.equal(classifyGenerationExchange({ previous, target: previous, live: previous, candidate: previous }), 'identical');
    for (const live of [previous, target, other, null]) for (const candidate of [previous, target, other, null]) {
        if (live === previous && candidate === target || live === target && candidate === previous) continue;
        assert.equal(classifyGenerationExchange({ previous, target, live, candidate }), 'manual');
    }
});

test('every crash cut including exchanges without done receipts yields ordered forward/rollback plans', () => {
    for (let mask = 0; mask < 8; mask++) {
        const generations = Object.fromEntries(UPDATE_GENERATION_NAMES.map((name, index) => [name, mask & (1 << index) ? exchanged : pending]));
        const forward = plan(generations), rollback = plan(generations, { direction: 'rollback' });
        assert.equal(forward.state, 'verified'); assert.equal(rollback.state, 'verified');
        assert.deepEqual(forward.steps.map(step => step.name), UPDATE_GENERATION_NAMES);
        assert.deepEqual(rollback.steps.map(step => step.name), [...UPDATE_GENERATION_NAMES].reverse());
        for (const step of forward.steps) assert.equal(step.operation, generations[step.name] === pending ? 'exchange' : 'attest');
        for (const step of rollback.steps) assert.equal(step.operation, generations[step.name] === exchanged ? 'exchange' : 'attest');
    }
});

test('UNKNOWN never authorizes downgrade or completing a partial exchange', () => {
    const complete = Object.fromEntries(UPDATE_GENERATION_NAMES.map(name => [name, exchanged]));
    for (const databaseState of ['UNKNOWN', 'TARGET_VERIFIED']) {
        assert.equal(plan(complete, { databaseState, direction: 'rollback' }).reason, 'database_downgrade_forbidden');
        assert.equal(plan({ ...complete, client: pending }, { databaseState }).reason, 'database_unknown_partial_generation');
        assert.ok(plan(complete, { databaseState }).steps.every(step => step.operation === 'attest'));
    }
});

test('partial schema, missing tree and contamination return no actionable prefix', () => {
    const generations = { nodeModules: pending, server: pending, client: { ...pending, live: other } };
    assert.deepEqual(plan(generations).steps, []);
    assert.equal(plan(generations).reason, 'generation_identity_unknown');
    assert.equal(plan(generations, { generationNames: ['server', 'client'] }).reason, 'generation_contract_invalid');
    assert.equal(plan({ server: pending, client: pending }).reason, 'generation_contract_invalid');
    assert.equal(plan(generations, { databaseState: undefined }).state, 'manual');
});
