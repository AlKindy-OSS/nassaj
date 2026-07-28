/**
 * Tests for GET /api/system/stats (server/routes/system.js).
 *
 * Pure-helper coverage (parseCpuLine / parseMeminfo / cpuPercentFromSamples)
 * plus one integration pass mounting the real router on express — the route
 * reads the live /proc of the test host, so we assert shape and ranges, not
 * exact values.
 *
 * Framework: node:test + node:assert/strict via tsx, matching the suite.
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import systemRouter, {
  cpuPercentFromSamples,
  parseCpuLine,
  parseMeminfo,
  round1,
  round2,
} from '../system.js';

test('parseCpuLine extracts idle (incl. iowait) and total jiffies', () => {
  const text = 'cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\n';
  const parsed = parseCpuLine(text);
  assert.ok(parsed);
  assert.equal(parsed.idle, 850); // idle 800 + iowait 50
  assert.equal(parsed.total, 1000);
});

test('parseCpuLine returns null on garbage input', () => {
  assert.equal(parseCpuLine('not a proc stat file'), null);
  assert.equal(parseCpuLine('cpu  abc def\n'), null);
});

test('parseMeminfo extracts MemTotal/MemAvailable in bytes', () => {
  const text = 'MemTotal:       10485760 kB\nMemFree:         1024 kB\nMemAvailable:    5242880 kB\n';
  const parsed = parseMeminfo(text);
  assert.ok(parsed);
  assert.equal(parsed.totalBytes, 10485760 * 1024);
  assert.equal(parsed.availableBytes, 5242880 * 1024);
});

test('parseMeminfo returns null when MemAvailable is missing', () => {
  assert.equal(parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\n'), null);
});

test('cpuPercentFromSamples computes busy ratio and clamps', () => {
  // 1000 jiffies elapsed, 600 of them idle → 40% busy.
  assert.equal(
    cpuPercentFromSamples({ idle: 0, total: 0 }, { idle: 600, total: 1000 }),
    40
  );
  // No elapsed time → null (caller reuses previous value).
  assert.equal(cpuPercentFromSamples({ idle: 5, total: 10 }, { idle: 5, total: 10 }), null);
});

// --- Rounding contract (B-78 / commit b4956ea) ------------------------------
// round2 backs the CPU 2-decimal contract; round1 backs the memory 1-decimal
// contract. Both were unexported before B-78, so a regression to CPU's decimals
// (e.g. reverting to round1) or memory's would have slipped through unnoticed.

test('round2 keeps two decimals (CPU contract) and rounds half-up', () => {
  assert.equal(round2(33.33333), 33.33); // truncated tail dropped
  assert.equal(round2(0.126), 0.13); // rounds up at 3rd decimal
  assert.equal(round2(99.999), 100); // carries across the integer boundary
  assert.equal(round2(12), 12); // integers pass through unchanged
  assert.equal(round2(0), 0);
});

test('round1 keeps one decimal (memory contract) and rounds half-up', () => {
  assert.equal(round1(63.44), 63.4); // rounds down
  assert.equal(round1(63.46), 63.5); // rounds up
  assert.equal(round1(99.99), 100); // carries across the integer boundary
  assert.equal(round1(50), 50); // integers pass through unchanged
  assert.equal(round1(0), 0);
});

test('round2 gives strictly finer resolution than round1 (no double-rounding loss)', () => {
  // The bug B-77 fixed on the client: memory was round1-ed then Math.round-ed to
  // an integer. Here we lock that round1 alone preserves the tenths the API ships.
  assert.equal(round1(63.4), 63.4);
  assert.notEqual(round1(63.4), Math.round(63.4)); // 63.4 !== 63 — decimal survives
  assert.equal(round2(63.44), 63.44); // and CPU keeps the extra digit
});

test('GET /stats returns the documented contract with sane ranges', async () => {
  const app = express();
  app.use('/api/system', systemRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/system/stats`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      cpu: { percent: number };
      memory: { usedBytes: number; totalBytes: number; percent: number };
    };

    assert.equal(typeof body.cpu.percent, 'number');
    assert.ok(body.cpu.percent >= 0 && body.cpu.percent <= 100);
    // Precision contract (B-78): CPU is shipped at 2 decimals (round2), so the
    // value must equal its own 2-decimal rounding — guards against a regression
    // to round1 that the range check alone would not catch.
    assert.equal(Number(body.cpu.percent.toFixed(2)), body.cpu.percent);

    assert.equal(typeof body.memory.usedBytes, 'number');
    assert.equal(typeof body.memory.totalBytes, 'number');
    assert.equal(typeof body.memory.percent, 'number');
    assert.ok(body.memory.totalBytes > 0);
    assert.ok(body.memory.usedBytes >= 0 && body.memory.usedBytes <= body.memory.totalBytes);
    assert.ok(body.memory.percent >= 0 && body.memory.percent <= 100);
    // Precision contract (B-77/B-78): memory is shipped at 1 decimal (round1);
    // the client renders it verbatim, so the wire value must carry at most one
    // decimal place.
    assert.equal(Number(body.memory.percent.toFixed(1)), body.memory.percent);
  } finally {
    server.close();
  }
});

// Kept LAST: it exhausts the module-level statsLimiter for the loopback IP, so
// any /stats-hitting test defined after it would be starved. The limiter is
// shared with the contract test above (both key on the loopback peer), so the
// trip point is at or below the configured max of 120.
test('GET /stats is rate-limited: exceeding the per-IP quota yields 429 + Retry-After', async () => {
  const app = express();
  app.use('/api/system', systemRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/system/stats`;

    let okCount = 0;
    let limited: Response | null = null;
    // Fire past the 120/min/IP cap; a 429 must appear within a bounded number
    // of requests regardless of how many the earlier test already consumed.
    for (let i = 0; i < 200; i++) {
      const res = await fetch(url);
      if (res.status === 429) {
        limited = res;
        break;
      }
      assert.equal(res.status, 200);
      okCount++;
      await res.arrayBuffer(); // drain the body so the socket is released
    }

    assert.ok(okCount > 0, 'route should serve some requests before limiting');
    assert.ok(limited, 'the limiter must trip within the request bound');
    assert.equal(limited.status, 429);
    assert.ok(
      Number(limited.headers.get('retry-after')) > 0,
      'a 429 response must advertise a positive Retry-After'
    );
    const body = (await limited.json()) as { error?: string };
    assert.equal(typeof body.error, 'string'); // generic message, no internals leaked
  } finally {
    server.close();
  }
});
