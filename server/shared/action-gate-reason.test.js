import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendGateStderr, gateReasonFromStderr, GATE_REASON_MAX_LEN, GATE_STDERR_TAIL_BYTES,
} from './action-gate-reason.js';

test('keeps the last non-empty stderr line without the timestamp and level prefix', () => {
    const tail = '2026-09-29T07:00:00Z [INFO] scanning\n2026-09-29T07:00:01Z [ERR] node required for JSONL parsing\n\n';
    assert.equal(gateReasonFromStderr(tail), 'node required for JSONL parsing');
});

test('strips ANSI escapes, control and bidi override characters', () => {
    const tail = '\u001b[31m2026 [ERR] bad\u0007 value‮ here\u001b[0m';
    assert.equal(gateReasonFromStderr(tail), 'bad value here');
});

test('caps an overlong line', () => {
    const reason = gateReasonFromStderr(`x [ERR] ${'a'.repeat(1000)}`);
    assert.equal(reason.length, GATE_REASON_MAX_LEN);
    assert.ok(reason.endsWith('…'));
});

test('returns null for empty or whitespace-only stderr', () => {
    assert.equal(gateReasonFromStderr(''), null);
    assert.equal(gateReasonFromStderr('\n \n\t'), null);
    assert.equal(gateReasonFromStderr(undefined), null);
});

test('bounds the running tail buffer', () => {
    let tail = '';
    for (let i = 0; i < 100; i += 1) tail = appendGateStderr(tail, Buffer.from(`line ${i} ${'b'.repeat(200)}\n`));
    assert.equal(tail.length, GATE_STDERR_TAIL_BYTES);
    assert.match(gateReasonFromStderr(tail), /^line 99 /);
});

test('keeps only the last segment of absolute paths', () => {
    assert.equal(gateReasonFromStderr('t [ERR] not found: /srv/data/.claude/projects/-srv-app'),
        'not found: …/-srv-app');
});
