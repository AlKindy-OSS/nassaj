/**
 * update-maintenance-gate.reason-codes.test.js — drift guard for the update
 * gate's public reason-code vocabulary.
 *
 * WHY this exists: every refusal surface (shell/terminal/chat websockets, the
 * /api/terminals 409, the HTTP writer-lease middleware) classifies a denial
 * through `readUpdateGateCode`, which only recognises
 * `UPDATE_GATE_REASON_CODES`. When that list was hand-written it contained a
 * code the gate NEVER raises (`update_lock_timeout`) and omitted the ones it
 * actually raises under a concurrent update (`update_lock_contended`,
 * `update_lock_unavailable`, `update_lock_aborted`, `update_writer_kind_invalid`,
 * `update_journal_cas_mismatch`, …) — so the likeliest field failure was
 * reported to the operator as a plain "maintenance active".
 *
 * The guard therefore derives the truth from the gate SOURCE (the `throw new
 * Error('update_*')` literals) and fails the moment a new code appears there
 * without being declared, or a declared code no longer exists.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    isComposedUpdateGateReasonCode, UPDATE_GATE_COMPOSED_REASON_CODE_PATTERNS,
    UPDATE_GATE_DEFERRABLE_REASON_CODES, UPDATE_GATE_REASON_CODES,
    UPDATE_GATE_REOPEN_GUARDED_LABELS,
} from './update-maintenance-gate.js';
import { isDeferrableGateDenial, isGateDenial, readUpdateGateCode } from './update-writer-lease.js';

const GATE_SOURCE_URL = new URL('./update-maintenance-gate.js', import.meta.url);

/** Literal `update_*` codes the gate actually throws, read from its source. */
export function readGateThrownCodes() {
    const source = fs.readFileSync(GATE_SOURCE_URL, 'utf8');
    return [...new Set([...source.matchAll(/new Error\('(update_[a-z0-9_]+)'\)/g)].map((m) => m[1]))].sort();
}

/**
 * The SAME codes read with every quote form JS allows.
 *
 * `readGateThrownCodes` only matches single quotes — today the file's whole
 * style. If a future edit writes `new Error("update_x")` or a backtick with no
 * interpolation, the narrow regex would silently under-report and the drift
 * guard would pass while a real code went unclassifiable. Comparing the two
 * readings turns that silent escape into a failing test.
 */
function readGateThrownCodesAnyQuote() {
    const source = fs.readFileSync(GATE_SOURCE_URL, 'utf8');
    return [...new Set([...source.matchAll(/new Error\(\s*(['"`])(update_[^'"`$]*)\1\s*\)/g)]
        .map((m) => m[2]))].sort();
}

/** Templated (dynamic) `update_*` throws, which cannot be enumerated statically. */
function readGateTemplatedThrows() {
    const source = fs.readFileSync(GATE_SOURCE_URL, 'utf8');
    return [...new Set([...source.matchAll(/new Error\(`(update_[^`]*)`\)/g)].map((m) => m[1]))].sort();
}

test('the declared reason codes are exactly the codes the gate source throws', () => {
    const thrown = readGateThrownCodes();
    assert.ok(thrown.length > 0, 'the regex still matches the gate source');
    assert.deepEqual([...UPDATE_GATE_REASON_CODES].sort(), thrown,
        'UPDATE_GATE_REASON_CODES drifted from the throws in update-maintenance-gate.js');
    // A code that a concurrent update really raises MUST be classifiable; this
    // is the specific regression the guard was written for.
    for (const code of ['update_lock_contended', 'update_lock_unavailable', 'update_lock_aborted',
        'update_maintenance_active', 'update_writer_kind_invalid']) {
        assert.ok(thrown.includes(code), `${code} is still raised by the gate`);
    }
    assert.ok(!UPDATE_GATE_REASON_CODES.includes('update_lock_timeout'),
        'update_lock_timeout is not a code this gate raises');
    assert.deepEqual(thrown, readGateThrownCodesAnyQuote(),
        'a double-quoted or backtick `update_*` throw appeared: widen the extraction regex, '
        + 'or the drift guard passes while a real code stays unclassifiable');
});

test('every code the gate throws survives classification, and only known dynamic families are excluded', () => {
    for (const code of readGateThrownCodes()) {
        assert.equal(readUpdateGateCode(new Error(code)), code, `${code} is forwarded verbatim`);
    }
    // Unknown / unexpected rejections degrade safely and leak nothing.
    assert.equal(readUpdateGateCode(new Error('boom /home/operator/.secret/tok')), 'update_maintenance_active');
    assert.equal(readUpdateGateCode('not-an-error'), 'update_maintenance_active');
    assert.equal(readUpdateGateCode(undefined), 'update_maintenance_active');

    // KNOWN LIMITS of this guard, stated rather than implied:
    //  (1) it proves only that the two TEXTS agree; it does not execute
    //      acquireWriterLease and observe which codes actually surface there.
    //  (2) it reads update-maintenance-gate.js ONLY. A throw relocated into a
    //      helper module leaves this guard green — extend the source list here
    //      if the gate is ever split.
    assert.deepEqual(readGateTemplatedThrows(), [
        'update_reopen_${label}_unsafe',
        'update_reopen_generation_mismatch_${name}',
        'update_reopen_generation_unrecorded_${name}',
    ], 'a NEW templated update_* throw appeared: add a matching family to '
        + 'UPDATE_GATE_COMPOSED_REASON_CODE_PATTERNS, or it is a gate refusal that '
        + 'classifies as an ordinary error (generic 500, nothing naming the gate)');
    assert.equal(readGateTemplatedThrows().length, UPDATE_GATE_COMPOSED_REASON_CODE_PATTERNS.length,
        'one declared pattern per templated throw');
});

/**
 * The `label` literal every `readGuardedActivationJson` call site passes.
 *
 * Scans BALANCED parentheses rather than matching `[^)]*`: the first argument is
 * itself a `path.join(...)` call at two of the three sites, so a naive regex
 * silently found only one site — and a drift guard that quietly sees less than
 * the source is worse than none.
 */
function readGuardedActivationLabels() {
    const source = fs.readFileSync(GATE_SOURCE_URL, 'utf8');
    const labels = [];
    const opening = 'readGuardedActivationJson(';
    for (let at = source.indexOf(opening); at !== -1; at = source.indexOf(opening, at + 1)) {
        // Neither the declaration nor a `readGuardedActivationJson(file, label)`
        // mention inside a doc comment is a call site.
        const before = source.slice(0, at);
        if (before.endsWith('function ') || before.endsWith('`')) continue;
        let depth = 0;
        let index = at + opening.length - 1;
        for (; index < source.length; index += 1) {
            if (source[index] === '(') depth += 1;
            else if (source[index] === ')') { depth -= 1; if (depth === 0) break; }
        }
        const args = source.slice(at + opening.length, index);
        const label = /,\s*'([a-z0-9_]+)'\s*$/.exec(args);
        assert.ok(label, `a readGuardedActivationJson call passes a non-literal label: ${args}`);
        labels.push(label[1]);
    }
    assert.ok(labels.length > 0, 'the scanner still finds the call sites');
    return [...new Set(labels)].sort();
}

/** The generation names `GENERATION_PATHS` is keyed by, read from the source. */
function readGenerationNames() {
    const source = fs.readFileSync(GATE_SOURCE_URL, 'utf8');
    const declaration = /const GENERATION_PATHS = Object\.freeze\(\{([^}]*)\}\)/.exec(source);
    assert.ok(declaration, 'GENERATION_PATHS is still an inline Object.freeze literal');
    return [...declaration[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort();
}

test('the composed families cover every interpolated value the gate can actually produce', () => {
    // The whole justification for patterns over a prefix test is that the
    // interpolated values come from CLOSED sets. Prove they are still closed,
    // and still the sets the patterns were built from.
    assert.deepEqual([...UPDATE_GATE_REOPEN_GUARDED_LABELS].sort(), readGuardedActivationLabels(),
        'a readGuardedActivationJson label appeared or vanished: update '
        + 'UPDATE_GATE_REOPEN_GUARDED_LABELS or the composed code becomes unclassifiable');

    for (const label of UPDATE_GATE_REOPEN_GUARDED_LABELS) {
        const code = `update_reopen_${label}_unsafe`;
        assert.ok(isComposedUpdateGateReasonCode(code), `${code} is a declared composed code`);
        assert.ok(isGateDenial(new Error(code)), `${code} is a GATE DENIAL, not an ordinary error`);
        assert.equal(readUpdateGateCode(new Error(code)), code, `${code} is forwarded verbatim`);
    }
    for (const name of readGenerationNames()) {
        for (const code of [`update_reopen_generation_mismatch_${name}`,
            `update_reopen_generation_unrecorded_${name}`]) {
            assert.ok(isComposedUpdateGateReasonCode(code), `${code} is a declared composed code`);
            assert.ok(isGateDenial(new Error(code)), `${code} is a GATE DENIAL, not an ordinary error`);
            assert.equal(readUpdateGateCode(new Error(code)), code, `${code} is forwarded verbatim`);
        }
    }

    // A composed code is a FAULT (tampering / integrity failure). A background
    // tick must surface it, never sleep and retry it away.
    for (const code of [`update_reopen_${UPDATE_GATE_REOPEN_GUARDED_LABELS[0]}_unsafe`,
        `update_reopen_generation_mismatch_${readGenerationNames()[0]}`]) {
        assert.equal(isDeferrableGateDenial(new Error(code)), false,
            `${code} is a fault: deferring it turns a tampering finding into a silent retry loop`);
    }
});

test('the composed patterns are anchored and claim nothing outside the gate', () => {
    // `update_` is NOT a gate-owned namespace. These three are raised by
    // server/bootstrap.js and server/services/update-preflight.js; attributing
    // them to the gate is the same fabricated root cause, pointed the other way.
    for (const foreign of ['update_bootstrap_handoff_unsafe', 'update_bootstrap_handoff_invalid',
        'update_preflight_timeout', 'update_failed']) {
        assert.ok(!UPDATE_GATE_REASON_CODES.includes(foreign), `${foreign} is not a gate literal`);
        assert.equal(isComposedUpdateGateReasonCode(foreign), false,
            `${foreign} is raised elsewhere and must never be attributed to the gate`);
        assert.equal(isGateDenial(new Error(foreign)), false, `${foreign} is not a gate denial`);
    }
    // Anchoring: neither a prefix nor a suffix of a real family may match.
    for (const near of ['update_reopen_manifest_unsafe_extra', 'x_update_reopen_manifest_unsafe',
        'update_reopen_nosuchlabel_unsafe', 'update_reopen_generation_mismatch_nosuchtree',
        'update_reopen_generation_mismatch_', 'update_reopen__unsafe']) {
        assert.equal(isComposedUpdateGateReasonCode(near), false, `${near} must not match a family`);
        assert.equal(isGateDenial(new Error(near)), false, `${near} is not a gate denial`);
        assert.equal(readUpdateGateCode(new Error(near)), 'update_maintenance_active',
            `${near} collapses for display and leaks nothing`);
    }
    for (const pattern of UPDATE_GATE_COMPOSED_REASON_CODE_PATTERNS) {
        assert.ok(pattern.source.startsWith('^') && pattern.source.endsWith('$'),
            `${pattern} is anchored at both ends`);
        assert.equal(pattern.global, false, 'a global regex carries lastIndex state between tests');
    }
});

test('the deferrable codes are a declared strict subset, and faults are NOT deferrable', () => {
    const deferrable = [...UPDATE_GATE_DEFERRABLE_REASON_CODES];
    assert.ok(deferrable.length > 0, 'a background tick can still defer at all');
    for (const code of deferrable) {
        assert.ok(UPDATE_GATE_REASON_CODES.includes(code),
            `${code} is deferrable but not a code this gate raises`);
    }
    assert.ok(deferrable.length < UPDATE_GATE_REASON_CODES.length,
        'deferral must stay a STRICT subset: "retry later" cannot be the answer to every fault');
    // The two transient refusals a concurrent update really produces.
    assert.deepEqual(deferrable.sort(), ['update_lock_contended', 'update_maintenance_active']);
    // The exclusions are the point of the list; widening it hides real faults,
    // so each of these must fail this assertion loudly before it can be added.
    for (const fault of ['update_journal_invalid', 'update_journal_unavailable', 'update_lock_unavailable',
        'update_lock_aborted', 'update_writer_kind_invalid', 'update_ownership_token_unsafe',
        'update_existing_control_unsafe', 'update_identity_invalid']) {
        assert.ok(UPDATE_GATE_REASON_CODES.includes(fault), `${fault} is still a gate code`);
        assert.equal(isDeferrableGateDenial(new Error(fault)), false,
            `${fault} is a fault: a background tick must surface it, not retry it away`);
    }
    assert.ok(!UPDATE_GATE_DEFERRABLE_REASON_CODES.includes('update_lock_timeout'),
        'update_lock_timeout is not a code this gate raises');
});

test('gate denials are classified by identity, never by the collapsing code reader', () => {
    for (const code of readGateThrownCodes()) assert.ok(isGateDenial(new Error(code)), `${code} is a gate denial`);
    // The separation `readUpdateGateCode` cannot make: an ordinary application
    // failure must NOT be attributable to the gate, even though the code reader
    // deliberately folds it to `update_maintenance_active` for display.
    // `artifact_*` codes ARE thrown inside this gate file, but they are outside
    // the declared vocabulary on purpose; an undeclared code must not be
    // announced as a gate denial just because the gate raised it.
    for (const other of [new Error('database_failure'), new TypeError('res.status is not a function'),
        new Error('artifact_bootstrap_path_mismatch'), new Error('artifact_maintenance_initializing'),
        new RangeError('Maximum call stack size exceeded'),
        new Error(''), 'update_maintenance_active', undefined, null, { message: 'update_maintenance_active' }]) {
        assert.equal(isGateDenial(other), false, `${String(other)} is not a gate denial`);
        assert.equal(isDeferrableGateDenial(other), false, `${String(other)} is not deferrable`);
    }
    assert.equal(readUpdateGateCode(new Error('database_failure')), 'update_maintenance_active',
        'the code reader still collapses, which is exactly why isGateDenial exists');
});
