/** ADR-205 D2 step 2: the guest load semaphore (1 runner, bounded queue, wait deadline, abort). */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBoundedSemaphore, SemaphoreRefusedError } from './bounded-semaphore.js';

test('grants runners, queues FIFO, and hands the slot to the next waiter on release', async () => {
  const semaphore = createBoundedSemaphore({ runners: 1, queue: 2, waitMs: 1000 });
  const release = await semaphore.acquire();
  const order: number[] = [];
  const a = semaphore.acquire().then((r) => { order.push(1); return r; });
  const b = semaphore.acquire().then((r) => { order.push(2); return r; });
  assert.deepEqual(semaphore.stats(), { running: 1, queued: 2 });
  await assert.rejects(semaphore.acquire(), (error: SemaphoreRefusedError) => error.reason === 'queue_full');
  release();
  release();
  (await a)();
  (await b)();
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(semaphore.stats(), { running: 0, queued: 0 });
});

test('a waiter past the wait deadline is refused and leaves the queue', async () => {
  const semaphore = createBoundedSemaphore({ runners: 1, queue: 4, waitMs: 20 });
  const release = await semaphore.acquire();
  await assert.rejects(semaphore.acquire(), (error: SemaphoreRefusedError) => error.reason === 'wait_timeout');
  assert.equal(semaphore.stats().queued, 0);
  release();
});

test('an aborted waiter leaves the queue at once; an already aborted signal never queues', async () => {
  const semaphore = createBoundedSemaphore({ runners: 1, queue: 4, waitMs: 1000 });
  const release = await semaphore.acquire();
  const controller = new AbortController();
  const waiting = semaphore.acquire(controller.signal);
  assert.equal(semaphore.stats().queued, 1);
  controller.abort();
  await assert.rejects(waiting, (error: SemaphoreRefusedError) => error.reason === 'aborted');
  assert.equal(semaphore.stats().queued, 0);
  await assert.rejects(semaphore.acquire(controller.signal), (error: SemaphoreRefusedError) => error.reason === 'aborted');
  release();
  assert.equal(semaphore.stats().running, 0);
});
