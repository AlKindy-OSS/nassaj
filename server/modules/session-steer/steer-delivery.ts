/**
 * Delivery proof for an injection (T-1903): the CLI transcript is the only
 * witness. A mid-turn message is recorded as an `attachment` of type
 * `queued_command` whose `source_uuid` is our uuid (SDK 0.3.152, A0 spike);
 * one that lands after the last tool call becomes an ordinary user line
 * carrying our uuid. The transcript is read only through the pinned reader
 * (ADR-201 A1), as the run's starter.
 */

// eslint-disable-next-line boundaries/dependencies -- type-only: the reader's handle shape.
import type { SessionTranscriptHandle } from '../providers/shared/session-transcript-reader.js';

/**
 * ADR-201 A1: the one transcript reader, loaded on first use — a static import
 * would pull the session-access graph into every importer of this module, and
 * the providers barrel would add the routes/SDK graph and an import cycle.
 */
// eslint-disable-next-line boundaries/dependencies -- lazy seam to the reader (see above).
const transcriptReader = () => import('../providers/shared/session-transcript.js');

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

/** Retries a check on a short schedule: the CLI appends the line asynchronously. */
export async function confirmWithRetry(check: () => Promise<boolean>, delaysMs: readonly number[] = [300, 1500, 5000]): Promise<boolean> {
  for (const delay of delaysMs) {
    await new Promise<void>(resolve => { const t = setTimeout(resolve, delay); t.unref?.(); });
    if (await check()) return true;
  }
  return false;
}

const SCAN_CHUNK = 1024 * 1024;

/** Opens a transcript for one scan; the scanner closes it. */
export type SteerTranscriptOpener = () => Promise<SessionTranscriptHandle | null>;

/**
 * The run's transcript as its starter may read it: tree-confined, id-bound,
 * pinned (ADR-201 A1); null when there is no admissible transcript yet.
 */
export function steerTranscriptOpener(sessionId: () => string, starterUserId: number): SteerTranscriptOpener {
  return async () => {
    const { isTranscriptHandle, openSessionTranscript } = await transcriptReader();
    const opened = await openSessionTranscript(sessionId(), starterUserId, 'steer');
    return isTranscriptHandle(opened) ? opened : null;
  };
}

/** Bytes appended to `fd` from `from` to `size`, in bounded chunks, fed to `onText`. */
async function readAppended(
  transcript: SessionTranscriptHandle, from: number, size: number, onText: (text: string) => void,
): Promise<number> {
  let offset = from;
  while (offset < size) {
    const length = Math.min(SCAN_CHUNK, size - offset);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await transcript.fd.read(buffer, 0, length, offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
    onText(buffer.subarray(0, bytesRead).toString('utf8'));
  }
  return offset;
}

/**
 * Incremental transcript scanner for ONE run: each scan reads only the bytes
 * appended since the previous one (the first scan starts at the size recorded
 * by `mark()`, or at most TAIL_BYTES back), carrying a partial last line over.
 * Every uuid it proves is remembered, so N injections cost one pass, not N.
 * Each scan pins the transcript afresh through `openTranscript` and closes it.
 */
export function createTranscriptScanner(openTranscript: SteerTranscriptOpener) {
  let offset: number | null = null;
  let carry = '';
  const found = new Set<string>();
  const watched = new Set<string>();
  let running: Promise<void> | null = null;

  const withTranscript = async (read: (transcript: SessionTranscriptHandle, size: number) => Promise<void>) => {
    const transcript = await openTranscript().catch(() => null);
    if (!transcript) return;
    try {
      await read(transcript, Number((await transcript.fd.stat()).size));
    } finally {
      await transcript.fd.close().catch(() => undefined);
    }
  };

  const scanOnce = () => withTranscript(async (transcript, size) => {
    if (offset === null || size < offset) { offset = Math.max(0, size - TAIL_BYTES); carry = ''; }
    offset = await readAppended(transcript, offset, size, (text) => {
      const lines = (carry + text).split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) for (const uuid of watched) if (lineProvesSteer(line, uuid)) found.add(uuid);
    });
  });

  return {
    /** Records the current end of the transcript as the scan start (best effort). */
    async mark(uuid: string): Promise<void> {
      watched.add(uuid);
      if (offset !== null) return;
      await withTranscript(async (_transcript, size) => { if (offset === null) offset = size; }).catch(() => undefined);
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
