/**
 * B-1327: every per-run writer view is a Proxy over a shared WebSocketWriter.
 * Reading `WRITER_TARGET` through such a Proxy returns the object it wraps, so
 * code that must reason about the underlying transport writer (identity,
 * user ownership) can see through any stack of wrappers. A registered symbol
 * keeps the key identical across ESM/TS module boundaries.
 */
export const WRITER_TARGET = Symbol.for('nassaj.writer.target');

/** Upper bound on wrapper depth; a cycle can never loop forever. */
const MAX_WRITER_WRAP_DEPTH = 32;

/**
 * Returns the innermost writer behind any number of writer Proxies. A plain
 * writer (or a non-object) is returned unchanged.
 * @param {unknown} writer
 * @returns {unknown}
 */
export function unwrapWriter(writer) {
  let current = writer;
  for (let depth = 0; depth < MAX_WRITER_WRAP_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object') return current;
    const inner = current[WRITER_TARGET];
    if (!inner || inner === current) return current;
    current = inner;
  }
  return current;
}
