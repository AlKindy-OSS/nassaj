// Office parsing runs on the main thread (DOMParser is not available in
// workers), so long jobs check for cancellation and yield between parts.

/** Raised when the preview was closed or switched while parsing. */
export class OfficeAbortError extends Error {
  constructor() {
    super('Office preview cancelled');
    this.name = 'OfficeAbortError';
  }
}

/** Throws OfficeAbortError when the signal has been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OfficeAbortError();
}

const YIELD_EVERY_MS = 12;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Returns a checkpoint function: each call throws if cancelled and, once the
 * current slice has run for a frame's worth of time, yields to the event loop
 * so input and rendering stay responsive.
 */
export function createCheckpoint(signal?: AbortSignal): () => Promise<void> {
  let sliceStart = now();
  return async () => {
    throwIfAborted(signal);
    if (now() - sliceStart < YIELD_EVERY_MS) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    sliceStart = now();
    throwIfAborted(signal);
  };
}
