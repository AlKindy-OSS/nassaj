/**
 * Delivery proof for an injection (T-1903): the CLI transcript is the only
 * witness. A mid-turn message is recorded as an `attachment` of type
 * `queued_command` whose `source_uuid` is our uuid (SDK 0.3.152, A0 spike);
 * one that lands after the last tool call becomes an ordinary user line
 * carrying our uuid.
 */

import { open, stat } from 'node:fs/promises';

const TAIL_BYTES = 8 * 1024 * 1024;

/** True when a transcript line proves the uuid was taken by the CLI. */
export function lineProvesSteer(line: string, uuid: string): boolean {
  if (!line.includes(uuid)) return false;
  try {
    const raw = JSON.parse(line) as Record<string, any>;
    return (raw.type === 'user' && raw.uuid === uuid)
      || (raw.type === 'attachment' && raw.attachment?.type === 'queued_command' && raw.attachment?.source_uuid === uuid);
  } catch {
    return false;
  }
}

/** Scans the tail of a transcript for the uuid; any I/O failure answers false. */
export async function transcriptHasSteer(filePath: string | null, uuid: string): Promise<boolean> {
  if (!filePath) return false;
  try {
    const { size } = await stat(filePath);
    const start = Math.max(0, size - TAIL_BYTES);
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString('utf8').split('\n').some(line => lineProvesSteer(line, uuid));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** Retries a check on a short schedule: the CLI appends the line asynchronously. */
export async function confirmWithRetry(check: () => Promise<boolean>, delaysMs: readonly number[] = [300, 1500, 5000]): Promise<boolean> {
  for (const delay of delaysMs) {
    await new Promise<void>(resolve => { const t = setTimeout(resolve, delay); t.unref?.(); });
    if (await check()) return true;
  }
  return false;
}

const SCAN_CHUNK = 1024 * 1024;

/**
 * Incremental transcript scanner for ONE run: each scan reads only the bytes
 * appended since the previous one (the first scan starts at the size recorded
 * by `mark()`, or at most TAIL_BYTES back), carrying a partial last line over.
 * Every uuid it proves is remembered, so N injections cost one pass, not N.
 */
export function createTranscriptScanner(resolvePath: () => Promise<string | null>) {
  let filePath: string | null = null;
  let offset: number | null = null;
  let carry = '';
  const found = new Set<string>();
  const watched = new Set<string>();
  let running: Promise<void> | null = null;

  const path = async () => (filePath ??= await resolvePath().catch(() => null));

  const scanOnce = async () => {
    const file = await path();
    if (!file) return;
    const { size } = await stat(file);
    if (offset === null || size < offset) { offset = Math.max(0, size - TAIL_BYTES); carry = ''; }
    const handle = await open(file, 'r');
    try {
      while (offset < size) {
        const length = Math.min(SCAN_CHUNK, size - offset);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        const lines = (carry + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) for (const uuid of watched) if (lineProvesSteer(line, uuid)) found.add(uuid);
      }
    } finally {
      await handle.close();
    }
  };

  return {
    /** Records the current end of the transcript as the scan start (best effort). */
    async mark(uuid: string): Promise<void> {
      watched.add(uuid);
      if (offset !== null) return;
      try {
        const file = await path();
        if (file && offset === null) offset = (await stat(file)).size;
      } catch { /* the first scan falls back to the bounded tail */ }
    },
    /** True once the uuid has been seen; scans only newly appended bytes. */
    async has(uuid: string): Promise<boolean> {
      watched.add(uuid);
      if (found.has(uuid)) return true;
      running ??= scanOnce().catch(() => {}).finally(() => { running = null; });
      await running;
      return found.has(uuid);
    },
  };
}
