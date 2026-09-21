import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { setupInitialArmFixture } from './fixtures/initial-arm-fixture.mjs';
import { installFixedStateMutexAuthority } from './fixtures/fixed-state-mutex-authority.mjs';

for (const mode of ['gap', 'exhaust', 'expiry']) test(`real supervisor arm clock ${mode} preserves original authority window`, async t => {
    const f = await setupInitialArmFixture(t);
    installFixedStateMutexAuthority(t, f.root, f.config);
    const originalClock = structuredClone(f.clock); const originalWindow = structuredClone(f.window);
    const originalHr = process.hrtime.bigint.bind(process.hrtime); const originalRead = fs.readFileSync.bind(fs);
    let reads = 0; let expired = false;
    // Clock-only seam: exercise the real sampler called by rootClock, not a replacement decision.
    t.mock.method(process.hrtime, 'bigint', () => {
        if (!new Error().stack.includes('samplePm2Clock')) return originalHr();
        reads++;
        if (mode === 'gap' && reads === 2) { const until = performance.now() + 8; while (performance.now() < until) {} }
        if (mode === 'expiry') expired = true;
        return mode === 'exhaust' ? BigInt(reads) * 2000000n : originalHr();
    });
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (file === '/proc/uptime' && expired) return `${(f.window.expiresAtBootMs + 1000) / 1000} 0`;
        return originalRead(file, ...args);
    });
    if (mode === 'gap') {
        const receipt = await f.arm(); assert.equal(receipt.process.pid, f.target.pid); assert.ok(reads >= 6);
    } else {
        await assert.rejects(f.arm(), mode === 'exhaust' ? /clock_sample_unstable/ : /initial_window_expired_or_changed/);
        assert.equal(f.read('first-cutover.json').initialTargetProcess, undefined);
        assert.equal(f.read('startup-admission.json').offer, null);
        if (mode === 'exhaust') assert.equal(reads, 24);
    }
    assert.deepEqual(f.clock, originalClock); assert.deepEqual(f.read('first-cutover.json').initialStartWindow, originalWindow);
});
