/**
 * control-command-lru.test.ts — T-2093 (ADR-TURN-SCOPED-CONTROL).
 *
 * Per-user idempotency cache for control commands (stop, approval): a repeated
 * commandId returns the stored result instead of executing again.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ControlCommandLru } from './control-command-lru.js';

function makeClock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test('a repeated commandId with the same fingerprint executes once and replays as duplicate', async () => {
  const lru = new ControlCommandLru<string>();
  let runs = 0;
  const first = await lru.run('1', 'cmd-1', 'fp', async () => { runs += 1; return 'stopped'; });
  const second = await lru.run('1', 'cmd-1', 'fp', async () => { runs += 1; return 'other'; });
  assert.deepEqual(first, { status: 'executed', duplicate: false, result: 'stopped' });
  assert.deepEqual(second, { status: 'duplicate', duplicate: true, result: 'stopped' });
  assert.equal(runs, 1);
});

test('a different fingerprint under the same commandId is command_id_reused', async () => {
  const lru = new ControlCommandLru<string>();
  await lru.run('1', 'cmd-1', 'fp-a', async () => 'applied');
  let ran = false;
  const reused = await lru.run('1', 'cmd-1', 'fp-b', async () => { ran = true; return 'x'; });
  assert.deepEqual(reused, { status: 'command_id_reused', duplicate: false });
  assert.equal(ran, false);
});

test('the same commandId from two users is independent', async () => {
  const lru = new ControlCommandLru<string>();
  let runs = 0;
  await lru.run('1', 'cmd', 'fp', async () => { runs += 1; return 'a'; });
  const other = await lru.run('2', 'cmd', 'fp', async () => { runs += 1; return 'b'; });
  assert.equal(runs, 2);
  assert.deepEqual(other, { status: 'executed', duplicate: false, result: 'b' });
});

test('concurrent duplicates share one in-flight execution', async () => {
  const lru = new ControlCommandLru<string>();
  let runs = 0;
  let release!: (value: string) => void;
  const gate = new Promise<string>((resolve) => { release = resolve; });
  const execute = async () => { runs += 1; return gate; };
  const a = lru.run('1', 'cmd', 'fp', execute);
  const b = lru.run('1', 'cmd', 'fp', execute);
  const mismatch = lru.run('1', 'cmd', 'fp-other', execute);
  release('stopped');
  assert.deepEqual(await a, { status: 'executed', duplicate: false, result: 'stopped' });
  assert.deepEqual(await b, { status: 'duplicate', duplicate: true, result: 'stopped' });
  assert.deepEqual(await mismatch, { status: 'command_id_reused', duplicate: false });
  assert.equal(runs, 1);
  assert.equal(lru.inflightCount(), 0, 'the in-flight map is cleaned in finally');
});

test('a failed execution stores nothing and frees the in-flight slot', async () => {
  const lru = new ControlCommandLru<string>();
  await assert.rejects(lru.run('1', 'cmd', 'fp', async () => { throw new Error('boom'); }));
  assert.equal(lru.inflightCount(), 0);
  const retry = await lru.run('1', 'cmd', 'fp', async () => 'ok');
  assert.equal(retry.status, 'executed');
});

test('entries expire after the TTL', async () => {
  const clock = makeClock();
  const lru = new ControlCommandLru<string>({ ttlMs: 10 * 60_000, now: clock.now });
  await lru.run('1', 'cmd', 'fp', async () => 'first');
  clock.advance(10 * 60_000 - 1);
  assert.equal((await lru.run('1', 'cmd', 'fp', async () => 'x')).status, 'duplicate');
  clock.advance(2);
  const fresh = await lru.run('1', 'cmd', 'fp', async () => 'second');
  assert.deepEqual(fresh, { status: 'executed', duplicate: false, result: 'second' });
});

test('per-user cap evicts that user\'s oldest entry only', async () => {
  const lru = new ControlCommandLru<string>({ perUserCap: 2 });
  await lru.run('1', 'a', 'fp', async () => 'a');
  await lru.run('2', 'z', 'fp', async () => 'z');
  await lru.run('1', 'b', 'fp', async () => 'b');
  await lru.run('1', 'c', 'fp', async () => 'c');
  assert.equal((await lru.run('1', 'a', 'fp', async () => 'a2')).status, 'executed', 'oldest of user 1 evicted');
  assert.equal((await lru.run('2', 'z', 'fp', async () => 'z2')).status, 'duplicate', 'user 2 untouched');
});

test('condition 7: the global cap bounds memory across users', async () => {
  const lru = new ControlCommandLru<string>({ perUserCap: 200, globalCap: 3 });
  for (const user of ['1', '2', '3', '4']) {
    await lru.run(user, 'cmd', 'fp', async () => user);
  }
  assert.equal(lru.size(), 3);
  assert.equal((await lru.run('1', 'cmd', 'fp', async () => 'again')).status, 'executed', 'globally oldest evicted');
});

test('defaults: TTL 10 minutes and 200 entries per user', () => {
  const lru = new ControlCommandLru<string>();
  assert.equal(lru.limits.ttlMs, 10 * 60_000);
  assert.equal(lru.limits.perUserCap, 200);
  assert.ok(lru.limits.globalCap >= 200);
});
