import type { TurnCaptureEvent, TurnCaptureWriter } from './types.js';

export interface CaptureOnlyWriter extends TurnCaptureWriter {
  /** Immutable copy of the in-memory capture. */
  snapshot(): readonly TurnCaptureEvent[];
}

/**
 * Creates a bounded in-memory sink. It intentionally accepts no callback or
 * persistence dependency, keeping hidden supervisor context out of transcripts.
 */
export function createCaptureOnlyWriter(maxEvents = 1_024): CaptureOnlyWriter {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new TypeError('maxEvents must be a positive safe integer');
  }

  const events: TurnCaptureEvent[] = [];
  return Object.freeze({
    capture(event: TurnCaptureEvent): void {
      if (events.length >= maxEvents) {
        throw new RangeError('turn capture event limit exceeded');
      }
      events.push(Object.freeze({ ...event }));
    },
    snapshot(): readonly TurnCaptureEvent[] {
      return Object.freeze(events.slice());
    },
  });
}

/** Capture sink that rejects every event from a stale or terminal writer. */
export function createFencedCaptureOnlyWriter(
  accepts: () => boolean,
  maxEvents = 1_024,
): CaptureOnlyWriter {
  const inner = createCaptureOnlyWriter(maxEvents);
  return Object.freeze({
    capture(event: TurnCaptureEvent): void | Promise<void> {
      if (!accepts()) throw new Error('stale writer epoch');
      return inner.capture(event);
    },
    snapshot(): readonly TurnCaptureEvent[] {
      return inner.snapshot();
    },
  });
}
