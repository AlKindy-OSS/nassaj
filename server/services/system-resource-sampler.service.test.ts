import assert from 'node:assert/strict';
import test from 'node:test';

import { SystemResourceSampler, readHostMemory } from './system-resource-sampler.service.js';

const totalmem = () => 10_000 * 1024;
const meminfo = (available: number, extra = '') =>
  `MemTotal:       10000 kB\nMemFree:         1500 kB\nMemAvailable:    ${available} kB\nBuffers:          800 kB\nCached:          3700 kB\n${extra}`;

test('readHostMemory uses MemAvailable so page cache is not counted as used', () => {
  const memory = readHostMemory({ readMeminfo: () => meminfo(6000), freemem: () => 1500 * 1024, totalmem });
  assert.equal(memory.free, 6000 * 1024);
  assert.equal(memory.total, 10_000 * 1024);
});

test('readHostMemory falls back to os.freemem only when meminfo is absent', () => {
  const memory = readHostMemory({ readMeminfo: () => null, freemem: () => 1500 * 1024, totalmem });
  assert.equal(memory.free, 1500 * 1024);
});

test('readHostMemory throws when meminfo is present but MemAvailable is missing', () => {
  assert.throws(
    () => readHostMemory({ readMeminfo: () => 'MemTotal: 10000 kB\nMemFree: 1500 kB\n', freemem: () => 0, totalmem }),
    /MemAvailable missing/,
  );
});

test('readHostMemory propagates a meminfo read failure other than ENOENT', () => {
  assert.throws(
    () => readHostMemory({ readMeminfo: () => { throw new Error('EACCES'); }, freemem: () => 0, totalmem }),
    /EACCES/,
  );
});

test('sampler memoryPercent reflects available memory, not MemFree', async () => {
  const sampler = new SystemResourceSampler({
    readCpuTimes: (() => { let n = 0; return () => ({ idle: 50 * n, total: 100 * n++ }); })(),
    readMemory: () => readHostMemory({ readMeminfo: () => meminfo(6000), freemem: () => 1500 * 1024, totalmem }),
    now: () => 1000,
    sleep: async () => {},
  }, { sampleWindowMs: 0, cacheMaxAgeMs: 0 });
  const sample = await sampler.sample();
  assert.equal(Math.round(sample.memoryPercent), 40);
});

test('sampler denies (throws) when meminfo is malformed instead of guessing', async () => {
  const sampler = new SystemResourceSampler({
    readCpuTimes: (() => { let n = 0; return () => ({ idle: 50 * n, total: 100 * n++ }); })(),
    readMemory: () => readHostMemory({ readMeminfo: () => 'garbage', freemem: () => 0, totalmem }),
    now: () => 1000,
    sleep: async () => {},
  }, { sampleWindowMs: 0, cacheMaxAgeMs: 0 });
  await assert.rejects(sampler.sample(), /measurement unavailable/);
});
