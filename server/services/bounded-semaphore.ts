/**
 * A small counting semaphore with a bounded FIFO queue and a wait deadline
 * (ADR-205 D2 step 2: the guest history load semaphore). It is independent of
 * `historyAdmission`, so guest loads never consume the member history runner.
 */

export type SemaphoreLimits = { runners: number; queue: number; waitMs: number };
export type SemaphoreRefusal = 'queue_full' | 'wait_timeout' | 'aborted';

/** Rejection carrying why a slot was not granted. */
export class SemaphoreRefusedError extends Error {
  constructor(readonly reason: SemaphoreRefusal) {
    super(`semaphore_${reason}`);
    this.name = 'SemaphoreRefusedError';
  }
}

type Waiter = { grant: (release: () => void) => void };

/** Creates a semaphore; `acquire` resolves with a one-shot release function. */
export function createBoundedSemaphore(limits: SemaphoreLimits) {
  let running = 0;
  const waiting: Waiter[] = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next.grant(once());
    else running -= 1;
  };
  function once(): () => void {
    let done = false;
    return () => { if (!done) { done = true; release(); } };
  }

  /** Waits for a slot; refuses when the queue is full, the wait times out, or `signal` aborts. */
  function acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new SemaphoreRefusedError('aborted'));
    if (running < limits.runners) { running += 1; return Promise.resolve(once()); }
    if (waiting.length >= limits.queue) return Promise.reject(new SemaphoreRefusedError('queue_full'));
    return new Promise((resolve, reject) => {
      const leave = (reason: SemaphoreRefusal) => {
        const index = waiting.indexOf(waiter);
        if (index !== -1) waiting.splice(index, 1);
        cleanup();
        reject(new SemaphoreRefusedError(reason));
      };
      const onAbort = () => leave('aborted');
      const timer = setTimeout(() => leave('wait_timeout'), limits.waitMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const waiter: Waiter = { grant: (granted) => { cleanup(); resolve(granted); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(waiter);
    });
  }

  return { acquire, stats: () => ({ running, queued: waiting.length }) };
}

export type BoundedSemaphore = ReturnType<typeof createBoundedSemaphore>;
