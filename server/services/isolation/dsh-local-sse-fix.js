/**
 * dsh-local-sse-fix — the ONE rewrite of the DSH local corrector (ADR-227 "DSH
 * local corrector", T-2108): llama.cpp's Anthropic stream starts a `tool_use`
 * block without `input`, which dsh 0.2.2-rc.1 rejects (MALFORMED_RESPONSE). A
 * block start that lacks `input` gets `"input":{}`; every other byte passes
 * unchanged, so a server that already sends `input` is passed byte-identical.
 *
 * The stream is split on LF bytes and only complete lines are decoded, so a
 * multi-byte character split across chunks is never decoded in halves. A CRLF
 * line keeps its CR. A line longer than the cap is an error (the corrector ends
 * the reply with 502). A multi-line `data:` event is not valid JSON per line and
 * passes unchanged.
 */

import { Transform } from 'node:stream';

/** Longest SSE line the fixer holds while waiting for its end. */
export const DSH_SSE_MAX_LINE_BYTES = 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;
const DATA_PREFIX = Buffer.from('data:');
const BLOCK_START = Buffer.from('content_block_start');

/**
 * The block with `input: {}` when it is a tool_use lacking `input`; null otherwise.
 * @param {unknown} block
 * @returns {Record<string, unknown>|null}
 */
function withToolUseInput(block) {
  const candidate = /** @type {Record<string, unknown>|null} */ (block);
  if (candidate?.type !== 'tool_use' || Object.hasOwn(candidate, 'input')) return null;
  return { ...candidate, input: {} };
}

/**
 * One SSE line (without its LF): the fixed line, or the same Buffer when unchanged.
 * @param {Buffer} line
 * @returns {Buffer}
 */
export function fixSseLine(line) {
  if (!line.subarray(0, DATA_PREFIX.length).equals(DATA_PREFIX) || line.indexOf(BLOCK_START) < 0) return line;
  const cr = line.at(-1) === CR;
  let event;
  try {
    event = JSON.parse(line.subarray(DATA_PREFIX.length, cr ? -1 : undefined).toString('utf8'));
  } catch {
    return line;
  }
  if (event?.type !== 'content_block_start') return line;
  const block = withToolUseInput(event.content_block);
  if (!block) return line;
  return Buffer.from(`data: ${JSON.stringify({ ...event, content_block: block })}${cr ? '\r' : ''}`);
}

/**
 * A non-stream Messages reply: the same fix on each `content[]` block. Anything
 * that is not such a reply, or needs no fix, is returned as the same Buffer.
 * @param {Buffer} body
 * @returns {Buffer}
 */
export function fixMessageJson(body) {
  let message;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!Array.isArray(message?.content)) return body;
  let changed = false;
  const content = message.content.map((block) => {
    const fixed = withToolUseInput(block);
    if (fixed) changed = true;
    return fixed ?? block;
  });
  return changed ? Buffer.from(JSON.stringify({ ...message, content })) : body;
}

/** @returns {Error & {code: string}} */
const lineTooLong = () => Object.assign(new Error('SSE line too long'), { code: 'DSH_SSE_LINE_TOO_LONG' });

/**
 * The stream transform. Output order and every unchanged byte are preserved.
 * @param {{ maxLineBytes?: number }} [options]
 * @returns {Transform}
 */
export function createSseToolUseFixer({ maxLineBytes = DSH_SSE_MAX_LINE_BYTES } = {}) {
  /** @type {Buffer[]} */
  let pending = [];
  let pendingBytes = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      const out = [];
      let start = 0;
      for (let at = chunk.indexOf(LF); at >= 0; at = chunk.indexOf(LF, start)) {
        const line = pendingBytes > 0 ? Buffer.concat([...pending, chunk.subarray(start, at)]) : chunk.subarray(start, at);
        pending = [];
        pendingBytes = 0;
        if (line.length > maxLineBytes) return done(lineTooLong());
        out.push(fixSseLine(line), chunk.subarray(at, at + 1));
        start = at + 1;
      }
      if (start < chunk.length) {
        pending.push(Buffer.from(chunk.subarray(start)));
        pendingBytes += chunk.length - start;
        if (pendingBytes > maxLineBytes) return done(lineTooLong());
      }
      return done(null, out.length > 0 ? Buffer.concat(out) : undefined);
    },
    flush(done) {
      done(null, pendingBytes > 0 ? fixSseLine(Buffer.concat(pending)) : undefined);
    },
  });
}
