import type { FileHandle } from 'node:fs/promises';

/**
 * Bound on what a "latest record" reader (the active model, the token usage)
 * takes from the END of a pinned transcript (B-954, B-1599 L8). Transcripts
 * grow to hundreds of MiB; the answer is in the last records, so reading the
 * whole file only cost memory. A latest record further back than this from the
 * end is not found and the reader falls back to its default.
 */
export const TRANSCRIPT_TAIL_MAX_BYTES = 16 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * UTF-8 text of the last `maxBytes` bytes of the pinned descriptor `fd`, read
 * positionally (the descriptor's file position is untouched). When the tail
 * starts inside the file, the partial first line is dropped, so the text starts
 * at a record boundary (and never inside a multi-byte character).
 */
export async function readPinnedTail(fd: FileHandle, maxBytes: number = TRANSCRIPT_TAIL_MAX_BYTES): Promise<string> {
  const { size } = await fd.stat();
  const start = Math.max(0, size - maxBytes);
  const buffer = Buffer.alloc(size - start);
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await fd.read(buffer, filled, buffer.length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  const tail = buffer.subarray(0, filled);
  if (start === 0) return tail.toString('utf8');
  const boundary = tail.indexOf(NEWLINE);
  return boundary < 0 ? '' : tail.subarray(boundary + 1).toString('utf8');
}
