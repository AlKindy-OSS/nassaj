/**
 * oneshot-capture-store.ts — in-memory output capture for composer shell
 * one-shots (T-2037).
 *
 * Keyed by (userId, runId) and INDEPENDENT of the PTY session entry, so the
 * output stays readable after the PTY exited and its entry left the map. Each
 * capture is the ANSI-stripped plain text of the run, with carriage-return
 * progress bars folded (a lone `\r` rewinds the current line, as a terminal
 * shows it), kept as a 64 KiB tail ring. Not persisted, not mirrored to any
 * other socket; read only by the owning user, and always through
 * maskCaptureText.
 *
 * Bounds per user: every live capture (the one-shot caps hold that at 3) plus
 * at most FINISHED_PER_USER finished ones, each ≤ RING_BYTES; a finished
 * capture expires TTL_MS after its exit.
 */

import { displayLiteralsForSession, maskText } from './display-secret-mask.js';

export const ONESHOT_CAPTURE_RING_BYTES = 64 * 1024;
export const ONESHOT_CAPTURE_FINISHED_PER_USER = 5;
export const ONESHOT_CAPTURE_TTL_MS = 30 * 60 * 1000;

/** Complete CSI / OSC / two-byte escape sequences. */
const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
/** An escape sequence cut off at the end of a chunk (held for the next chunk). */
const ANSI_PARTIAL_TAIL = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?)?$/;
/** Remaining control bytes other than TAB, LF and CR. */
const OTHER_CONTROLS = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g;
/** A held partial escape longer than this is dropped rather than buffered. */
const MAX_PENDING_ESCAPE = 512;

export type OneShotCapture = { text: string; truncated: boolean; exitCode: number | null; finished: boolean };

type CaptureRecord = {
  committed: string;
  line: string;
  pendingCr: boolean;
  pendingEscape: string;
  truncated: boolean;
  exitCode: number | null;
  finished: boolean;
  finishedAt: number;
};

/**
 * Masks capture text for the client UNCONDITIONALLY: unlike the transcript
 * egress helpers it does not consult isDisplayMaskingEnabled(), because a
 * one-shot runs arbitrary commands (`env`, `cat .env`) whose output is the most
 * likely place a secret value is printed.
 */
export function maskCaptureText(text: string): string {
  return maskText(text, { literals: displayLiteralsForSession() });
}

/**
 * maskCaptureText for a text clipped at its START (the ring keeps the tail):
 * the clipped edge may sit inside a secret whose head is gone, where no rule can
 * match it, so the partial first line is dropped before masking (or, on a single
 * very long line, the partial first token).
 */
export function maskClippedCaptureText(text: string, truncated: boolean): string {
  if (!truncated) return maskCaptureText(text);
  const newline = text.indexOf('\n');
  if (newline !== -1) return maskCaptureText(text.slice(newline + 1));
  const space = text.search(/\s/);
  return space === -1 ? '' : maskCaptureText(text.slice(space + 1));
}

/** Keeps the last `maxBytes` UTF-8 bytes of `text` (never splitting a code point). */
function keepTailBytes(text: string, maxBytes: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, clipped: false };
  const bytes = Buffer.from(text, 'utf8');
  let start = bytes.length - maxBytes;
  // Skip UTF-8 continuation bytes so the tail starts on a code-point boundary.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString('utf8'), clipped: true };
}

/** Strips escape sequences from `chunk`, holding a cut-off trailing one. */
function stripChunk(record: CaptureRecord, chunk: string): string {
  let text = record.pendingEscape + chunk;
  record.pendingEscape = '';
  text = text.replace(ANSI_SEQUENCE, '');
  const partial = ANSI_PARTIAL_TAIL.exec(text);
  if (partial) {
    text = text.slice(0, partial.index);
    if (partial[0].length <= MAX_PENDING_ESCAPE) record.pendingEscape = partial[0];
  }
  return text.replace(OTHER_CONTROLS, '');
}

/** Line breaks and lone carriage returns, matched in one pass per chunk. */
const LINE_CONTROL = /\r\n|\r|\n/g;

/**
 * Appends plain text, folding `\r` the way a terminal renders it: a lone `\r`
 * rewinds the current line, `\n` / `\r\n` commit it. Segment-wise (one regex
 * pass), not per character; a `\r` ending a chunk waits for the next chunk to
 * tell `\r\n` from a rewind.
 */
function foldInto(record: CaptureRecord, text: string, ringBytes: number): void {
  let committedAdd = '';
  let cursor = 0;
  if (record.pendingCr && text.length > 0) {
    record.pendingCr = false;
    if (text[0] === '\n') {
      committedAdd += `${record.line}\n`;
      cursor = 1;
    }
    record.line = '';
  }
  LINE_CONTROL.lastIndex = cursor;
  for (let match = LINE_CONTROL.exec(text); match; match = LINE_CONTROL.exec(text)) {
    const segment = text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (match[0] !== '\r') {
      committedAdd += `${record.line}${segment}\n`;
      record.line = '';
    } else if (cursor === text.length) {
      record.line += segment;
      record.pendingCr = true;
    } else {
      record.line = '';
    }
  }
  record.line += text.slice(cursor);
  if (committedAdd) {
    const committed = keepTailBytes(record.committed + committedAdd, ringBytes);
    record.committed = committed.text;
    record.truncated ||= committed.clipped;
  }
  const line = keepTailBytes(record.line, ringBytes);
  record.line = line.text;
  record.truncated ||= line.clipped;
}

/** Renders a record's current text within the ring bound. */
function renderText(record: CaptureRecord, ringBytes: number): { text: string; truncated: boolean } {
  const tail = keepTailBytes(record.committed + record.line, ringBytes);
  return { text: tail.text, truncated: record.truncated || tail.clipped };
}

export type OneShotCaptureStoreOptions = {
  ringBytes?: number;
  finishedPerUser?: number;
  ttlMs?: number;
  now?: () => number;
};

/** Creates an isolated capture store (the shell service holds one singleton). */
export function createOneShotCaptureStore({
  ringBytes = ONESHOT_CAPTURE_RING_BYTES,
  finishedPerUser = ONESHOT_CAPTURE_FINISHED_PER_USER,
  ttlMs = ONESHOT_CAPTURE_TTL_MS,
  now = Date.now,
}: OneShotCaptureStoreOptions = {}) {
  const byUser = new Map<string, Map<string, CaptureRecord>>();

  const recordsFor = (userId: string | number): Map<string, CaptureRecord> | undefined => {
    const records = byUser.get(String(userId));
    if (!records) return undefined;
    const cutoff = now() - ttlMs;
    for (const [runId, record] of records) {
      if (record.finished && record.finishedAt <= cutoff) records.delete(runId);
    }
    return records;
  };

  /** Evicts the oldest finished captures beyond the per-user cap. */
  const evictFinished = (records: Map<string, CaptureRecord>): void => {
    const finished = [...records.entries()]
      .filter(([, record]) => record.finished)
      .sort(([, a], [, b]) => a.finishedAt - b.finishedAt);
    for (const [runId] of finished.slice(0, Math.max(0, finished.length - finishedPerUser))) {
      records.delete(runId);
    }
  };

  return {
    /** Opens an empty live capture for a run. */
    begin(userId: string | number, runId: string): void {
      const userKey = String(userId);
      const records = recordsFor(userKey) ?? new Map<string, CaptureRecord>();
      byUser.set(userKey, records);
      records.set(runId, {
        committed: '', line: '', pendingCr: false, pendingEscape: '',
        truncated: false, exitCode: null, finished: false, finishedAt: 0,
      });
    },
    /** Appends raw PTY output to a live capture; ignored once finished. */
    append(userId: string | number, runId: string, chunk: string): void {
      const record = byUser.get(String(userId))?.get(runId);
      if (!record || record.finished || typeof chunk !== 'string') return;
      foldInto(record, stripChunk(record, chunk), ringBytes);
    },
    /** Marks a capture finished with its exit code (idempotent). */
    finish(userId: string | number, runId: string, exitCode: number | null): void {
      const records = byUser.get(String(userId));
      const record = records?.get(runId);
      if (!records || !record || record.finished) return;
      record.finished = true;
      record.exitCode = typeof exitCode === 'number' ? exitCode : null;
      record.finishedAt = now();
      evictFinished(records);
    },
    /** The RAW (unmasked) capture of the owner's run, or null. Callers mask. */
    get(userId: string | number, runId: string): OneShotCapture | null {
      const record = recordsFor(userId)?.get(runId);
      if (!record) return null;
      const { text, truncated } = renderText(record, ringBytes);
      return { text, truncated, exitCode: record.exitCode, finished: record.finished };
    },
    /** Drops every capture of a user (identity revoked). */
    dropUser(userId: string | number): void {
      byUser.delete(String(userId));
    },
    reset(): void {
      byUser.clear();
    },
  };
}

export type OneShotCaptureStore = ReturnType<typeof createOneShotCaptureStore>;
