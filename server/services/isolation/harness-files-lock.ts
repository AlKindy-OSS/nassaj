/**
 * harness-files-lock — per-user mutual exclusion for every write that depends on
 * the user's skills mode (ADR-203 condition 2): the mode PUT, the seed, the
 * Claude link repoint, the Codex materialization and the skill add/remove.
 *
 * Two entry points over ONE in-process table:
 *   - withHarnessFilesLock(userId, fn): async FIFO lock for request handlers.
 *   - tryWithHarnessFilesLockSync(userId, fn): for synchronous spawn paths
 *     (provisioning, launch). Node runs a synchronous section to completion, so
 *     holding the slot for its duration is exclusive. If an async holder or
 *     waiter exists the section does NOT run (`ran: false`); the caller keeps the
 *     current state and the next launch tries again.
 *
 * Single-process scope: the server is one Node process per node.
 */

type Slot = { tail: Promise<void>; depth: number };

const slots = new Map<string, Slot>();

function keyOf(userId: string | number): string {
  return String(userId);
}

/**
 * Runs `fn` while holding the user's lock; callers queue in FIFO order.
 *
 * @param userId lock key (authenticated user id, or a reserved key such as `*`)
 * @param fn critical section; must re-read the mode itself
 */
export async function withHarnessFilesLock<T>(
  userId: string | number,
  fn: () => Promise<T> | T,
): Promise<T> {
  const key = keyOf(userId);
  const slot = slots.get(key) ?? { tail: Promise.resolve(), depth: 0 };
  slots.set(key, slot);
  slot.depth += 1;
  const previous = slot.tail;
  let release: () => void = () => {};
  slot.tail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await previous;
    return await fn();
  } finally {
    release();
    slot.depth -= 1;
    if (slot.depth === 0 && slots.get(key) === slot) slots.delete(key);
  }
}

/**
 * Runs a synchronous section under the user's lock if it is free.
 *
 * @returns `{ ran: true, value }`, or `{ ran: false }` when the lock is busy
 */
export function tryWithHarnessFilesLockSync<T>(
  userId: string | number,
  fn: () => T,
): { ran: true; value: T } | { ran: false } {
  const key = keyOf(userId);
  if (slots.has(key)) return { ran: false };
  const slot: Slot = { tail: Promise.resolve(), depth: 1 };
  slots.set(key, slot);
  try {
    return { ran: true, value: fn() };
  } finally {
    if (slots.get(key) === slot) slots.delete(key);
  }
}

/** True while an async holder or waiter, or a sync section, owns the user's lock. */
export function isHarnessFilesLockHeld(userId: string | number): boolean {
  return slots.has(keyOf(userId));
}
