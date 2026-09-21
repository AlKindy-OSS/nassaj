/** Pure generation decisions, shared by sealed OID control and source activation. */
export const UPDATE_GENERATION_NAMES = Object.freeze(['nodeModules', 'server', 'client']);

/** Classify both sides independently of an exchange receipt, including a lost receipt. */
export function classifyGenerationExchange({ previous, target, live, candidate }) {
    const valid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (![previous, target, live, candidate].every(valid)) return 'manual';
    if (previous === target) return live === previous && candidate === target ? 'identical' : 'manual';
    if (live === previous && candidate === target) return 'pending';
    if (live === target && candidate === previous) return 'exchanged';
    return 'manual';
}

/** Produce a closed, ordered plan; callers still own locks, durable intents and effects. */
export function reconcileUpdateGenerations({ generationNames, generations, direction, databaseState }) {
    if (JSON.stringify(generationNames) !== JSON.stringify(UPDATE_GENERATION_NAMES)
        || !generations || Object.keys(generations).sort().join(',') !== 'client,nodeModules,server'
        || !['forward', 'rollback'].includes(direction)
        || !['PRE_CANDIDATE', 'UNKNOWN', 'TARGET_VERIFIED'].includes(databaseState)) {
        return Object.freeze({ state: 'manual', reason: 'generation_contract_invalid', steps: [] });
    }
    if (direction === 'rollback' && databaseState !== 'PRE_CANDIDATE') {
        return Object.freeze({ state: 'manual', reason: 'database_downgrade_forbidden', steps: [] });
    }
    const names = direction === 'forward' ? UPDATE_GENERATION_NAMES : [...UPDATE_GENERATION_NAMES].reverse();
    const steps = names.map(name => {
        const position = classifyGenerationExchange(generations[name] || {});
        const exchange = direction === 'forward' ? position === 'pending' : position === 'exchanged';
        return Object.freeze({ name, position, operation: exchange ? 'exchange' : 'attest' });
    });
    if (steps.some(step => step.position === 'manual')) {
        return Object.freeze({ state: 'manual', reason: 'generation_identity_unknown', steps: [] });
    }
    // UNKNOWN permits verification of an already installed target, never new exchanges.
    if (databaseState !== 'PRE_CANDIDATE' && steps.some(step => step.operation === 'exchange')) {
        return Object.freeze({ state: 'manual', reason: 'database_unknown_partial_generation', steps: [] });
    }
    return Object.freeze({ state: 'verified', direction, steps: Object.freeze(steps) });
}
