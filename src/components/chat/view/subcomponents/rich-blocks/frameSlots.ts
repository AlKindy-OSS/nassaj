import { useEffect, useState } from 'react';

/**
 * Caps how many sandboxed chart frames are alive at once.
 *
 * Each frame carries its own copy of the chart libraries (~1 MB of script), so a
 * long conversation full of charts would otherwise hold dozens of documents in
 * memory. A block asks for a slot while it is on screen and gives it back when
 * it scrolls away or unmounts; requests beyond the cap wait in FIFO order.
 */
export const MAX_LIVE_FRAMES = 6;

type Waiter = { id: number; grant: () => void };

let nextId = 1;
const holders = new Set<number>();
const waiting: Waiter[] = [];

function pump(): void {
  while (holders.size < MAX_LIVE_FRAMES && waiting.length > 0) {
    const next = waiting.shift()!;
    holders.add(next.id);
    next.grant();
  }
}

/**
 * Requests a slot. `onGrant` runs (synchronously or later) once one is free.
 * The returned function releases the slot or cancels the pending request.
 */
export function acquireFrameSlot(onGrant: () => void): () => void {
  const id = nextId++;
  waiting.push({ id, grant: onGrant });
  pump();
  return () => {
    const index = waiting.findIndex((w) => w.id === id);
    if (index >= 0) waiting.splice(index, 1);
    if (holders.delete(id)) pump();
  };
}

/** Number of slots currently held (diagnostics and tests). */
export function liveFrameCount(): number {
  return holders.size;
}

/** Holds a frame slot while `wanted` is true; returns whether it is granted. */
export function useFrameSlot(wanted: boolean): boolean {
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    if (!wanted) return undefined;
    let active = true;
    const release = acquireFrameSlot(() => {
      if (active) setGranted(true);
    });
    return () => {
      active = false;
      release();
      setGranted(false);
    };
  }, [wanted]);
  return granted;
}
