/**
 * dsh-acp-connection — a minimal Agent Client Protocol (ACP v1) client over a
 * child's stdio: newline-delimited JSON-RPC 2.0 (T-2086, ADR-224).
 *
 * It owns framing and request/response correlation only; what to do with an
 * agent notification or an agent→client request is the caller's (the runtime's)
 * decision through `onNotification` / `onRequest`. No process is created here.
 */

import readline from 'node:readline';

/** ACP protocol version Nassaj speaks (recorded from dsh 0.2.2-rc.1). */
export const ACP_PROTOCOL_VERSION = 1;

/** JSON-RPC "method not found". */
export const RPC_METHOD_NOT_FOUND = -32601;

/** An error answer from the agent, carrying the JSON-RPC error object. */
export class AcpRpcError extends Error {
  /** @param {string} method @param {{ code?: number, message?: string }} rpc */
  constructor(method, rpc) {
    super(`${method} failed: ${rpc?.message ?? 'unknown error'}`);
    this.name = 'AcpRpcError';
    this.code = 'ACP_RPC_ERROR';
    this.rpcCode = rpc?.code ?? null;
  }
}

/**
 * @typedef {{ write: (chunk: string) => unknown, on?: Function }} Writable
 * @typedef {(method: string, params: any) => unknown} NotificationHandler
 * @typedef {(method: string, params: any) => unknown | Promise<unknown>} RequestHandler
 */

export class AcpConnection {
  /**
   * @param {{ input: NodeJS.ReadableStream, output: Writable,
   *   onNotification?: NotificationHandler, onRequest?: RequestHandler }} io
   *   input = the agent's stdout, output = the agent's stdin.
   */
  constructor({ input, output, onNotification, onRequest }) {
    this.output = output;
    this.onNotification = onNotification ?? (() => {});
    this.onRequest = onRequest ?? (() => { throw Object.assign(new Error('Method not found'), { rpcCode: RPC_METHOD_NOT_FOUND }); });
    this.nextId = 1;
    /** @type {Map<number, { method: string, resolve: Function, reject: Function }>} */
    this.pending = new Map();
    this.closedError = null;
    readline.createInterface({ input }).on('line', (line) => this.receive(line));
  }

  /** Sends a request and resolves with its result (rejects with AcpRpcError). */
  request(method, params = {}) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Sends a notification (no answer). */
  notify(method, params = {}) {
    if (!this.closedError) this.send({ jsonrpc: '2.0', method, params });
  }

  /** Rejects every pending request: the agent is gone. */
  close(error = new Error('ACP connection closed')) {
    if (this.closedError) return;
    this.closedError = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  /** @private */
  send(message) {
    try {
      this.output.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** @private */
  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // non-protocol output on stdout is ignored, never executed
    }
    if (!message || typeof message !== 'object') return;
    if (message.method === undefined) {
      this.settle(message);
      return;
    }
    if (message.id === undefined) {
      this.onNotification(message.method, message.params ?? {});
      return;
    }
    this.answer(message);
  }

  /** @private */
  settle(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new AcpRpcError(entry.method, message.error));
    else entry.resolve(message.result ?? {});
  }

  /** @private */
  async answer(message) {
    try {
      const result = await this.onRequest(message.method, message.params ?? {});
      this.send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
    } catch (error) {
      const code = typeof error?.rpcCode === 'number' ? error.rpcCode : -32603;
      this.send({ jsonrpc: '2.0', id: message.id, error: { code, message: String(error?.message ?? error) } });
    }
  }
}
