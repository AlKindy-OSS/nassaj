/**
 * ACP transport (T-2094): newline-delimited JSON-RPC 2.0 over a child's stdio.
 *
 * Generic — knows nothing about any agent. It correlates request ids, applies
 * per-request timeouts, answers inbound requests through `onRequest`, forwards
 * notifications to `onNotification`, and NEVER throws into the server: a broken
 * stream ends in `onFatal` + every pending request rejected.
 *
 * qa-critic condition: a single line is capped (16 MB by default). On overflow
 * the buffer is dropped, bytes are discarded up to the next newline, the
 * connection is closed with an `acp_line_overflow` error and `onFatal` fires
 * once, so the caller fails the turn and kills the process.
 */

export const ACP_MAX_LINE_BYTES = 16 * 1024 * 1024;
export const ACP_DEFAULT_TIMEOUT_MS = 60_000;

/** A JSON-RPC error answer from the agent (code/message as sent). */
export class AcpRpcError extends Error {
  constructor(code, message, data) {
    super(typeof message === 'string' && message ? message : `ACP error ${code}`);
    this.name = 'AcpRpcError';
    this.code = code;
    this.data = data;
  }
}

/** A local transport failure (timeout, overflow, closed stream). */
export class AcpTransportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AcpTransportError';
    this.code = code;
  }
}

const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/**
 * Splits incoming chunks into complete lines with a hard per-line cap.
 * @returns {{ push(chunk: Buffer): void }}
 */
function createLineSplitter({ maxLineBytes, onLine, onOverflow }) {
  let parts = [];
  let size = 0;
  let discarding = false;
  const take = (piece) => {
    if (discarding) return;
    if (size + piece.length > maxLineBytes) {
      parts = [];
      size = 0;
      discarding = true;
      onOverflow();
      return;
    }
    parts.push(piece);
    size += piece.length;
  };
  return {
    push(chunk) {
      let rest = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      for (let nl = rest.indexOf(10); nl !== -1; nl = rest.indexOf(10)) {
        take(rest.subarray(0, nl));
        if (!discarding) onLine(Buffer.concat(parts).toString('utf8'));
        parts = [];
        size = 0;
        discarding = false;
        rest = rest.subarray(nl + 1);
      }
      if (rest.length > 0) take(rest);
    },
  };
}

/**
 * Routes one parsed inbound line: answers agent requests through
 * `spec.onRequest`, forwards notifications, settles pending requests.
 */
function createInboundDispatcher({ spec, pending, write, logger, isClosed }) {
  const answerRequest = (message) => {
    Promise.resolve()
      .then(() => spec.onRequest?.(message.method, message.params))
      .then((result) => {
        if (result === undefined) {
          write({ id: message.id, error: { code: METHOD_NOT_FOUND, message: 'Method not found' } });
        } else {
          write({ id: message.id, result });
        }
      })
      .catch((error) => {
        logger.warn(JSON.stringify({ event: 'acp_inbound_request_failed', method: message.method, error: String(error?.message || error) }));
        write({ id: message.id, error: { code: INTERNAL_ERROR, message: 'Internal error' } });
      });
  };

  const settle = (message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new AcpRpcError(message.error.code, message.error.message, message.error.data));
    else entry.resolve(message.result);
  };

  const dispatch = (line) => {
    if (isClosed() || !line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      logger.warn(JSON.stringify({ event: 'acp_malformed_line', bytes: line.length }));
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (typeof message.method === 'string') {
      if (message.id !== undefined && message.id !== null) answerRequest(message);
      else spec.onNotification?.(message.method, message.params);
      return;
    }
    if (message.id !== undefined) settle(message);
  };

  return dispatch;
}

/**
 * Builds `request(method, params, { timeoutMs })`; `timeoutMs: 0` waits forever (a prompt turn).
 * @returns {(method: string, params: unknown, opts?: { timeoutMs?: number }) => Promise<any>}
 */
function createRequester({ pending, write, isClosed, nextId }) {
  return (method, params, { timeoutMs = ACP_DEFAULT_TIMEOUT_MS } = {}) => {
    if (isClosed()) return Promise.reject(new AcpTransportError('acp_closed', 'ACP connection closed'));
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          pending.delete(id);
          reject(new AcpTransportError('acp_timeout', `ACP ${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs)
        : null;
      timer?.unref?.();
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  };
}

/** Rejects and clears every pending request. */
function rejectAll(pending, error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

/** A dispatch failure is logged, never thrown into the stream handler. */
function safeDispatch(dispatch, line, logger) {
  try {
    dispatch(line);
  } catch (error) {
    logger.warn(JSON.stringify({ event: 'acp_dispatch_failed', error: String(error?.message || error) }));
  }
}

/**
 * Opens a JSON-RPC connection over `input` (agent stdout) and `output` (agent stdin).
 * @param {{ input: NodeJS.ReadableStream, output: NodeJS.WritableStream,
 *   onRequest?: (method: string, params: unknown) => unknown,
 *   onNotification?: (method: string, params: unknown) => void,
 *   onFatal?: (error: Error) => void, maxLineBytes?: number,
 *   logger?: Pick<Console, 'warn'> }} spec
 */
export function createAcpConnection(spec) {
  const { input, output, maxLineBytes = ACP_MAX_LINE_BYTES, logger = console } = spec;
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  const write = (message) => {
    if (closed) return false;
    try {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      return true;
    } catch (error) {
      close(new AcpTransportError('acp_write_failed', `ACP write failed: ${error?.message || error}`));
      return false;
    }
  };

  const close = (reason) => {
    if (closed) return;
    closed = true;
    rejectAll(pending, reason instanceof Error ? reason : new AcpTransportError('acp_closed', 'ACP connection closed'));
  };

  const dispatch = createInboundDispatcher({ spec, pending, write, logger, isClosed: () => closed });

  const splitter = createLineSplitter({
    maxLineBytes,
    onLine: (line) => safeDispatch(dispatch, line, logger),
    onOverflow: () => {
      if (closed) return;
      const error = new AcpTransportError('acp_line_overflow', `ACP line exceeded ${maxLineBytes} bytes`);
      close(error);
      spec.onFatal?.(error);
    },
  });
  input.on('data', (chunk) => splitter.push(chunk));

  const request = createRequester({ pending, write, isClosed: () => closed, nextId: () => nextId++ });

  return {
    request,
    /** Sends a notification (no answer expected). */
    notify: (method, params) => write({ method, params }),
    close,
    get closed() {
      return closed;
    },
  };
}
