/**
 * In-memory history consumer for server-side snapshot builders (ADR-196).
 *
 * The HTTP history path hands its payload to HistoryHttpSink, which owns a
 * socket. A share snapshot has no socket: it needs the messages themselves,
 * detached from the read lease that produced them, with a hard byte cap so a
 * huge transcript fails fast instead of growing the heap. This sink never
 * writes to a response.
 */
import type { NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Hard cap on the serialized history the sink will retain. */
export const HISTORY_MEMORY_SINK_MAX_BYTES = 8 * 1024 * 1024;

/** Typed 413 raised when a snapshot input or output exceeds a share cap. */
export function snapshotTooLargeError(): AppError {
  return new AppError('The conversation is too large to share.', {
    code: 'SNAPSHOT_TOO_LARGE',
    statusCode: 413,
  });
}

/**
 * Collects history pages as detached copies under one byte budget.
 *
 * Each accepted page is serialized once (that is both the size measurement and
 * the detachment from lease-owned objects) and parsed back, so nothing the
 * sink retains aliases provider caches or lease buffers.
 */
export class HistoryMemorySink {
  readonly #maxBytes: number;
  readonly #controller = new AbortController();
  #bytes = 0;
  #pages: NormalizedMessage[][] = [];

  constructor(maxBytes: number = HISTORY_MEMORY_SINK_MAX_BYTES) {
    this.#maxBytes = maxBytes;
  }

  /** Cancellation signal handed to lease-owning readers. */
  get signal(): AbortSignal { return this.#controller.signal; }

  /** Bytes retained so far. */
  get bytes(): number { return this.#bytes; }

  /**
   * Accepts one page of messages. Pages are prepended because history readers
   * page from the newest end towards the oldest.
   * @throws AppError 413 SNAPSHOT_TOO_LARGE once the cap is exceeded.
   */
  acceptOlderPage(messages: NormalizedMessage[]): void {
    const body = Buffer.from(JSON.stringify(messages));
    if (this.#bytes + body.length > this.#maxBytes) {
      this.#controller.abort(snapshotTooLargeError());
      this.#pages = [];
      throw snapshotTooLargeError();
    }
    this.#bytes += body.length;
    this.#pages.unshift(JSON.parse(body.toString('utf8')) as NormalizedMessage[]);
  }

  /** Returns every accepted message in chronological order. */
  messages(): NormalizedMessage[] {
    return this.#pages.flat();
  }
}
