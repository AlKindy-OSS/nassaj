/** Own the response buffer until Node finishes it or destroys the socket. */
import { ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { HISTORY_LIMITS, HistoryBudgetError } from './history-budget.service.js';

/** Concrete Node transport: arbitrary callbacks cannot retain an unbounded response. */
export class HistoryHttpSink {
  #response: ServerResponse;
  #socket: Socket;
  #disconnect = new AbortController();
  #finished: Promise<void>;
  #closed: Promise<void>;
  #started = false;
  #completed = false;
  #aborted = false;
  #signal?: AbortSignal;
  #onAbort?: () => void;
  #cleanup: () => void = () => {};
  constructor(response: ServerResponse) {
    if (!(response instanceof ServerResponse) || !response.socket || response.closed
      || response.destroyed || response.socket.destroyed) throw new HistoryBudgetError('HISTORY_ABORTED');
    this.#response = response; this.#socket = response.socket;
    let resolveClosed!: () => void;
    this.#closed = new Promise(resolve => { resolveClosed = resolve; });
    this.#finished = new Promise((resolve, reject) => {
      const error = () => reject(new HistoryBudgetError('HISTORY_ABORTED'));
      const finish = () => {
        if (this.#aborted || response.destroyed || this.#socket.destroyed) { error(); return; }
        this.#completed = true; resolve();
      };
      const close = () => {
        resolveClosed();
        if (!this.#completed) { this.#disconnect.abort(); error(); }
        this.#cleanup();
      };
      this.#cleanup = () => {
        response.removeListener('finish', finish); response.removeListener('error', error); response.removeListener('close', close);
        if (this.#signal && this.#onAbort) this.#signal.removeEventListener('abort', this.#onAbort);
      };
      response.once('finish', finish); response.once('error', error); response.once('close', close);
    });
    void this.#finished.catch(() => {}); Object.freeze(this);
  }
  static isConcrete(value: unknown): value is HistoryHttpSink {
    return typeof value === 'object' && value !== null && #response in value
      && Object.getPrototypeOf(value) === HistoryHttpSink.prototype;
  }
  get signal(): AbortSignal { return this.#disconnect.signal; }
  get retainedBytes(): number { return this.#response.writableLength + this.#socket.writableLength; }
  /** Encode once in the lease owner; this method accepts only the bounded owned buffer. */
  async write(body: Buffer, signal: AbortSignal): Promise<void> {
    if (this.#started || !Buffer.isBuffer(body) || body.length > HISTORY_LIMITS.responseBytes) {
      throw new HistoryBudgetError('HISTORY_BUDGET_EXCEEDED');
    }
    this.#started = true; this.#signal = signal;
    this.#onAbort = () => { void this.abort(); };
    signal.addEventListener('abort', this.#onAbort, { once: true });
    if (signal.aborted) { await this.abort(); throw new HistoryBudgetError('HISTORY_ABORTED'); }
    this.#response.setHeader('Content-Type', 'application/json; charset=utf-8');
    this.#response.setHeader('Content-Length', body.length); this.#response.end(body);
  }
  async complete(): Promise<void> { await this.#finished; }
  /** Small control responses have their own deadline after the data lease has failed. */
  async sendFailure(error: unknown): Promise<void> {
    if (this.#started || this.#response.destroyed || this.#aborted) return this.abort();
    const legacy: Record<string, number> = { HISTORY_REVISION_CHANGED: 409, CURSOR_STALE: 409,
      INVALID_QUERY_PARAMETER: 400, LIGHT_HISTORY_DISABLED: 409, LIGHT_HISTORY_PAYLOAD_TOO_LARGE: 413,
      SESSION_NOT_FOUND: 404 };
    const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const typed = error instanceof HistoryBudgetError ? error
      : Object.hasOwn(legacy, rawCode) ? { code: rawCode, statusCode: legacy[rawCode], message: 'History is unavailable for this request.' }
      : new HistoryBudgetError('HISTORY_SOURCE_UNAVAILABLE');
    this.#response.statusCode = typed.statusCode;
    if (typed.code === 'HISTORY_BUSY') this.#response.setHeader('Retry-After', '1');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1000);
    try {
      await this.write(Buffer.from(JSON.stringify({ error: { code: typed.code, message: typed.message } })), controller.signal);
      await this.complete();
    } catch { await this.abort(); }
    finally { clearTimeout(timer); }
  }
  /** Destruction is synchronous; await close before releasing the job reservation. */
  async abort(): Promise<void> {
    this.#aborted = true;
    if (!this.#response.destroyed) this.#response.destroy();
    await this.#closed; this.#cleanup();
  }
}
Object.freeze(HistoryHttpSink.prototype);
