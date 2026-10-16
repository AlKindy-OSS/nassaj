/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * C5: the download stops at the size cap even without Content-Length
 * (the server pipes the file), instead of buffering the whole body first.
 */
import { describe, expect, it, vi } from 'vitest';

import { PreviewTooLargeError, readResponseBounded } from './readBounded';

const MiB = 1024 * 1024;
const LIMIT = 20 * MiB;

/** A chunked body of `total` bytes produced lazily, reporting how much was pulled. */
function chunkedResponse(total: number, chunk = 64 * 1024, headers: Record<string, string> = {}) {
  const stats = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stats.pulled >= total) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, total - stats.pulled);
      stats.pulled += size;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      stats.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), stats };
}

describe('readResponseBounded', () => {
  it('cancels a 21 MiB chunked download without Content-Length right after the cap', async () => {
    const { response, stats } = chunkedResponse(21 * MiB);
    expect(response.headers.get('content-length')).toBeNull();
    await expect(readResponseBounded(response, LIMIT)).rejects.toBeInstanceOf(PreviewTooLargeError);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThan(LIMIT + 256 * 1024);
  });

  it('refuses immediately when Content-Length is over the cap', async () => {
    const { response, stats } = chunkedResponse(MiB, 64 * 1024, { 'content-length': String(LIMIT + 1) });
    await expect(readResponseBounded(response, LIMIT)).rejects.toBeInstanceOf(PreviewTooLargeError);
    expect(stats.pulled).toBe(0);
  });

  it('returns every byte of a body within the cap', async () => {
    const { response } = chunkedResponse(3 * MiB + 7);
    expect((await readResponseBounded(response, LIMIT)).length).toBe(3 * MiB + 7);
  });

  it('ignores a malformed Content-Length and still counts bytes', async () => {
    const { response } = chunkedResponse(10, 4, { 'content-length': 'abc' });
    expect((await readResponseBounded(response, LIMIT)).length).toBe(10);
  });

  it('falls back to arrayBuffer() when the body is not streamable', async () => {
    const small = { headers: new Headers(), body: null, arrayBuffer: vi.fn(async () => new ArrayBuffer(5)) } as unknown as Response;
    expect((await readResponseBounded(small, LIMIT)).length).toBe(5);
    const big = { headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(11) } as unknown as Response;
    await expect(readResponseBounded(big, 10)).rejects.toBeInstanceOf(PreviewTooLargeError);
  });
});
