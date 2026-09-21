export const FRAME_BYTES = 64 * 1024;
export const CHILD_WIRE_BYTES = 12 * 1024 * 1024;
export const PARENT_WIRE_BYTES = 36 * 1024 * 1024;
const HEADER_BYTES = 9;

/** Path-free failure shared with the parser, without importing server I/O. */
export class PreviewProtocolError extends Error {
  constructor(code = 'TEMPORARILY_UNAVAILABLE', status = 503) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Require precisely the documented fields on a plain protocol object. */
export function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
}

/** Decode canonical bounded base64, rejecting before allocating its raw buffer. */
export function decodeBytes(value, maxBytes) {
  if (typeof value !== 'string') throw new PreviewProtocolError();
  if (value.length > Math.ceil(maxBytes / 3) * 4) {
    throw new PreviewProtocolError('DOCUMENT_TOO_LARGE', 413);
  }
  if (value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new PreviewProtocolError();
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw new PreviewProtocolError('DOCUMENT_TOO_LARGE', 413);
  if (bytes.toString('base64') !== value) throw new PreviewProtocolError();
  return bytes;
}

/** Serialize one message in bounded frames, accounting headers and awaiting backpressure. */
export function createMessageWriter(stream, budget, signal) {
  let total = 0;
  let busy = false;
  return async (message) => {
    if (busy) throw new PreviewProtocolError();
    busy = true;
    try {
      const bytes = Buffer.from(JSON.stringify(message));
      const wireBytes = bytes.length + Math.ceil(bytes.length / (FRAME_BYTES - HEADER_BYTES)) * HEADER_BYTES;
      if (total + wireBytes > budget) throw new PreviewProtocolError('DOCUMENT_TOO_LARGE', 413);
      total += wireBytes;
      for (let offset = 0; offset < bytes.length;) {
        const size = Math.min(FRAME_BYTES - HEADER_BYTES, bytes.length - offset);
        const frame = Buffer.allocUnsafe(HEADER_BYTES + size);
        frame.writeUInt32BE(size, 0);
        frame.writeUInt32BE(bytes.length, 4);
        frame[8] = (offset === 0 ? 1 : 0) | (offset + size === bytes.length ? 2 : 0);
        bytes.copy(frame, HEADER_BYTES, offset, offset + size);
        offset += size;
        await writeFrame(stream, frame, signal);
      }
    } finally { busy = false; }
  };
}

function writeFrame(stream, frame, signal) {
  return new Promise((resolve, reject) => {
    const fail = () => finish(new PreviewProtocolError());
    const finish = (error) => {
      stream.off('close', fail);
      stream.off('error', fail);
      signal?.removeEventListener('abort', fail);
      if (error) reject(error); else resolve();
    };
    stream.once('close', fail);
    stream.once('error', fail);
    signal?.addEventListener('abort', fail, { once: true });
    if (stream.destroyed || signal?.aborted) return fail();
    // One outstanding frame: the callback acknowledges flushing and bounds buffering
    // even for a Writable that closes without ever emitting drain or error.
    stream.write(frame, finish);
  });
}

/** Bounded frame decoder; no JSON parse or message allocation precedes budget checks. */
export function createMessageReader(stream, budget, onMessage, onError) {
  const state = { total: 0, header: Buffer.alloc(HEADER_BYTES), headerOffset: 0,
    message: null, offset: 0, frameLeft: 0, flags: 0, busy: false, failed: false };
  const fail = (error) => {
    if (!state.failed) {
      state.failed = true;
      onError(error);
    }
  };
  const data = (chunk) => {
    if (state.failed) return;
    state.total += chunk.length;
    if (state.total > budget) return fail(new PreviewProtocolError('DOCUMENT_TOO_LARGE', 413));
    try { consumeFrames(chunk, state, budget, onMessage, fail); } catch (error) { fail(error); }
  };
  const end = () => { if (state.message || state.headerOffset) fail(new PreviewProtocolError()); };
  stream.on('data', data);
  stream.on('end', end);
  stream.on('error', fail);
  return () => { stream.off('data', data); stream.off('end', end); stream.off('error', fail); };
}

function beginFrame(state, budget) {
  const size = state.header.readUInt32BE(0);
  const length = state.header.readUInt32BE(4);
  const flags = state.header[8];
  if (size > FRAME_BYTES - HEADER_BYTES || length > budget) {
    throw new PreviewProtocolError('DOCUMENT_TOO_LARGE', 413);
  }
  if (!size || !length || flags > 3 || state.busy) throw new PreviewProtocolError();
  if (flags & 1) {
    if (state.message) throw new PreviewProtocolError();
    state.message = Buffer.allocUnsafe(length);
    state.offset = 0;
  }
  if (!state.message || length !== state.message.length || state.offset + size > length
    || Boolean(flags & 2) !== (state.offset + size === length)) throw new PreviewProtocolError();
  state.frameLeft = size;
  state.flags = flags;
}

function consumeFrames(chunk, state, budget, onMessage, fail) {
  let position = 0;
  while (position < chunk.length) {
    if (!state.frameLeft) {
      const size = Math.min(HEADER_BYTES - state.headerOffset, chunk.length - position);
      chunk.copy(state.header, state.headerOffset, position, position + size);
      position += size;
      state.headerOffset += size;
      if (state.headerOffset < HEADER_BYTES) continue;
      beginFrame(state, budget);
    }
    const size = Math.min(state.frameLeft, chunk.length - position);
    chunk.copy(state.message, state.offset, position, position + size);
    position += size;
    state.offset += size;
    state.frameLeft -= size;
    if (state.frameLeft) continue;
    state.headerOffset = 0;
    if (!(state.flags & 2)) continue;
    let message;
    try { message = JSON.parse(state.message.toString('utf8')); }
    catch { throw new PreviewProtocolError(); }
    state.message = null;
    const pending = onMessage(message);
    if (pending?.then) {
      state.busy = true;
      Promise.resolve(pending).then(() => { state.busy = false; }, fail);
    }
  }
}
