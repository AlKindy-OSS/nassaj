import assert from 'node:assert/strict';
import test from 'node:test';
import { samplePm2Clock, verifyPm2LaunchWindow } from './lib/pm2-typed-mutation.mjs';
function sequence(walls, monos, boots = ['boot', 'boot']) {
    let w = 0; let m = 0; let b = 0;
    return { wall: () => { assert.ok(w < walls.length); return walls[w++]; },
        monotonic: () => { assert.ok(m < monos.length); return monos[m++]; },
        boot: () => { assert.ok(b < boots.length); return boots[b++]; }, counts: () => ({ w, m, b }) };
}
function window(before, after) { return { wallBefore: before.wall, wallAfter: after.wall,
    monotonicBefore: before.monotonic, monotonicAfter: after.monotonic, bootBefore: before.boot, bootAfter: after.boot }; }
test('8 ms scheduling interruption is discarded, coherent retry passes unchanged verifier', () => {
    const before = samplePm2Clock(sequence([1000, 1000], [0n, 100n, 200n]));
    const sources = sequence([1000, 1008, 1008, 1008], [300n, 8000100n, 8000200n, 8000300n, 8000400n, 8000500n]);
    const after = samplePm2Clock(sources);
    assert.equal(after.monotonic, '8000400'); verifyPm2LaunchWindow(window(before, after), [1008]);
    assert.deepEqual(sources.counts(), { w: 4, m: 6, b: 2 });
});
test('bucket crossing retries; exact outer width is strictly less than 1 ms', () => {
    for (const first of [[1000, 1001, 0n, 1n, 2n], [1001, 1001, 0n, 1n, 1000000n]]) {
        const value = samplePm2Clock(sequence([...first.slice(0, 2), 1001, 1001], [...first.slice(2), 1000001n, 1000002n, 2000000n]));
        assert.equal(value.monotonic, '1000002');
    }
});
test('eight invalid acquisitions exhaust without a ninth or unpaired fallback', () => {
    const sources = sequence(Array(16).fill(1000), Array.from({ length: 24 }, (_, i) => BigInt(i) * 1000000n), ['boot']);
    assert.throws(() => samplePm2Clock(sources), /clock_sample_unstable/);
    assert.deepEqual(sources.counts(), { w: 16, m: 24, b: 1 });
});
for (const bad of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) test(`invalid wall ${bad} fails immediately`, () => {
    assert.throws(() => samplePm2Clock(sequence([bad, 1], [0n, 1n, 2n], ['boot'])), /clock_sample_wall/);
});
for (const values of [[-1n, 0n, 1n], [1n, 0n, 2n], [0n, 2n, 1n], [0, 1n, 2n]]) test(`invalid monotonic ${values} fails immediately`, () => {
    assert.throws(() => samplePm2Clock(sequence([1, 1], values, ['boot'])), /clock_sample_monotonic/);
});
test('regressions within and across attempts cannot be retried away', () => {
    assert.throws(() => samplePm2Clock(sequence([1001, 1000], [0n, 1n, 2n], ['boot'])), /clock_sample_regression/);
    assert.throws(() => samplePm2Clock(sequence([1000, 1001, 1000, 1000], [0n, 1n, 2n, 3n, 4n, 5n], ['boot'])), /clock_sample_regression/);
    assert.throws(() => samplePm2Clock(sequence([1000, 1001, 1001, 1001], [0n, 1n, 2n, 1n, 2n, 3n], ['boot'])), /clock_sample_monotonic/);
});
test('boot baseline spans the entire retry group', () => {
    const sources = sequence([1, 2, 2, 2], [0n, 1n, 2n, 3n, 4n, 5n], ['before', 'after']);
    assert.throws(() => samplePm2Clock(sources), /clock_sample_boot/); assert.equal(sources.counts().b, 2);
});
test('persistent forward jump during after retry preserves original start and is rejected', () => {
    const before = samplePm2Clock(sequence([1000, 1000], [999999999n, 1000000000n, 1000000001n]));
    const original = structuredClone(before);
    const after = samplePm2Clock(sequence([1020, 1120, 1120, 1120], [1019999990n, 1019999991n, 1019999992n, 1019999999n, 1020000000n, 1020000001n]));
    assert.throws(() => verifyPm2LaunchWindow(window(before, after), []), /clock_skew/); assert.deepEqual(before, original);
    const backward = { ...after, wall: 990 };
    assert.throws(() => verifyPm2LaunchWindow(window(before, backward), []), /clock_window/);
});
