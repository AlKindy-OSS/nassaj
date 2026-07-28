/**
 * Per-workflow TERMINAL SIGNAL, read from the harness's own task notifications.
 *
 * WHY THIS EXISTS (the measured defect)
 * ------------------------------------
 * `classifyWorkflowLiveness` decides "finished cleanly" from the journal's key
 * sets: every `started` key must have a matching `result` key. Measured on real
 * data, that test is WRONG — a workflow can finish while its journal shows fewer
 * results than starts:
 *
 *   wf_f66564da-ad8 → journal: 5 `started`, 2 `result`
 *   same session's transcript, 2026-07-28T18:50:33Z:
 *     <task-notification><task-id>wvzupr03j</task-id> … <status>completed</status>
 *
 * So the workflow was DONE and the key-set test still said "not cleanly
 * finished" — and because the session's CLI pid stays alive for the rest of the
 * chat, the classifier answered RUNNING forever. Result: a badge frozen at a
 * fraction like 8/9 for hours, and (once workflow agents are surfaced in the
 * composer strip) rows for agents that stopped existing long ago.
 *
 * WHAT THIS DOES — AND DELIBERATELY DOES NOT DO
 * ---------------------------------------------
 * It does NOT infer completion. It relays the PRODUCER's own verdict: the
 * harness writes a `<task-notification>` carrying `<status>` when a background
 * task settles. A workflow that has such a notification is finished by the only
 * authority that can know; anything else keeps the existing pid+quiet+keys path
 * byte-for-byte. That is why this lives BESIDE `classifyWorkflowLiveness` and
 * never inside it: the "never announce completion on a guess" veto (م-3,
 * ADR-053, incident wf_ef5ba242) stays intact.
 *
 * TERMINAL vs NON-TERMINAL STATUSES (measured frequencies across real transcripts)
 * -------------------------------------------------------------------------------
 *   completed (848), failed (18), killed (80)  => TERMINAL: the run is over.
 *   stopped (150)                              => NOT terminal on purpose. This is
 *     the orphan shape (B-103 / the restart incident). Dropping it here would hide
 *     the very orphan the status endpoint exists to surface, so it falls through to
 *     the unchanged classifier, which reports ORPHAN/UNKNOWN honestly.
 *   running (2)                                => obviously not terminal.
 *
 * ROW TYPE IS NOT `user` — THE 12% TRAP
 * -------------------------------------
 * A notification does NOT arrive as a plain `type:'user'` row. Measured on
 * b3f8d09f…jsonl: 17 notification-bearing rows, of which only 2 are `user`; the
 * rest are `queue-operation` and `attachment`. A parser that filters on row type
 * (or on `message.content` shape) would match ~12% of them — the same failure
 * mode as the reconcile regex that matched 6.5% of real notifications. So the
 * scan is deliberately TYPE-BLIND: it matches on the RAW LINE text and never
 * interprets the row envelope.
 *
 * COST: INCREMENTAL, NOT RE-READ
 * ------------------------------
 * The session transcript grows continuously, so a whole-file scan every 8s poll
 * would be pure waste. State per path is kept as {size, offset, terminal ids}:
 * each call reads only the bytes appended since the last one. A shrunk/replaced
 * file (rotation) resets the cursor to 0. The accumulated id set is monotonic —
 * a terminal verdict is never un-learned.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * Statuses that mean "this background run is over". `stopped` is intentionally
 * absent — see the header: it is the orphan signal, not a completion.
 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Opening marker. The block is NOT matched as one regex: measured on real rows,
 * the workflow id does not live in the header before `<status>` — it appears
 * further down, inside `<summary>`/`<result>` (as `resumeFromRunId: "wf_…"` or a
 * bare `wf_…` token). A pattern that stopped at `<status>` therefore matched the
 * status and found ZERO ids — the exact bug this comment exists to prevent from
 * coming back. So each notification's WHOLE segment is searched for ids, and the
 * status is read from the header within that segment.
 */
const NOTIFICATION_OPEN = '<task-notification>';

/** Status tag, read from inside a notification segment. */
const STATUS_RE = /<status>([a-z_-]*)<\/status>/i;

/** Workflow run id as it appears in a notification body (`wf_<hex>-<hex>`). */
const WF_ID_RE = /\bwf_[0-9a-f]+(?:-[0-9a-f]+)?\b/gi;

/**
 * Bytes scanned per call, per session. A generous ceiling that still bounds the
 * worst case (first scan of a huge transcript); the cursor advances by whatever
 * was consumed, so the remainder is picked up by the next poll rather than
 * blocking this one.
 */
const MAX_BYTES_PER_SCAN = 4 * 1024 * 1024;

type ScanState = {
  /** Byte offset up to which this file has been scanned (always a line boundary). */
  offset: number;
  /** Last observed file size, to detect truncation/rotation. */
  size: number;
  /** Workflow ids observed with a terminal status. Monotonic. */
  terminal: Set<string>;
};

const scanStates = new Map<string, ScanState>();

/** Test seam: drops all cursors so a case starts from a clean slate. */
export function __resetWorkflowTerminalScan(): void {
  scanStates.clear();
}

/**
 * Extracts the workflow ids that a chunk of transcript declares terminal.
 * Exported for direct unit testing against fixtures derived from real
 * transcripts (never synthetic — a hand-written notification would re-create the
 * false confidence that let the 6.5% regex ship).
 */
export function extractTerminalWorkflowIds(chunk: string): Set<string> {
  const found = new Set<string>();

  let cursor = chunk.indexOf(NOTIFICATION_OPEN);
  while (cursor !== -1) {
    // A segment runs to the next notification (or end of chunk): the id may sit
    // anywhere inside it, including after `<status>`.
    const next = chunk.indexOf(NOTIFICATION_OPEN, cursor + NOTIFICATION_OPEN.length);
    const segment = next === -1 ? chunk.slice(cursor) : chunk.slice(cursor, next);

    const status = STATUS_RE.exec(segment)?.[1]?.trim().toLowerCase() ?? '';
    if (TERMINAL_STATUSES.has(status)) {
      WF_ID_RE.lastIndex = 0;
      let idMatch: RegExpExecArray | null = WF_ID_RE.exec(segment);
      while (idMatch !== null) {
        found.add(idMatch[0].toLowerCase());
        idMatch = WF_ID_RE.exec(segment);
      }
    }

    cursor = next;
  }

  return found;
}

/**
 * Returns every workflow id this session's transcript has declared terminal.
 *
 * Fail-safe in one direction only: on ANY anomaly (missing file, unreadable
 * bytes, stat failure) it returns whatever was already known — never a partial
 * or empty set that would resurrect a finished workflow as "running", and never
 * a throw into the caller's scan loop.
 *
 * @param jsonlPath Absolute path to the session transcript, or null.
 */
export async function readTerminalWorkflowIds(
  jsonlPath: string | null,
): Promise<ReadonlySet<string>> {
  if (!jsonlPath) {
    return new Set<string>();
  }

  let state = scanStates.get(jsonlPath);
  if (!state) {
    state = { offset: 0, size: 0, terminal: new Set<string>() };
    scanStates.set(jsonlPath, state);
  }

  let size: number;
  try {
    size = (await fsp.stat(jsonlPath)).size;
  } catch {
    return state.terminal; // Gone/unreadable: keep what we learned.
  }

  // Truncated or replaced (rotation): the old cursor is meaningless. Re-scan from
  // the start; the accumulated set is kept (a terminal verdict cannot expire).
  if (size < state.offset) {
    state.offset = 0;
  }
  state.size = size;

  if (size <= state.offset) {
    return state.terminal; // Nothing appended since the last scan.
  }

  const start = state.offset;
  const end = Math.min(size, start + MAX_BYTES_PER_SCAN);

  let chunk: string;
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(jsonlPath, 'r');
    const buffer = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await handle.read(buffer, 0, end - start, start);
    chunk = buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return state.terminal;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }

  // Advance only to the last COMPLETE line: a notification split across the chunk
  // boundary must be re-read whole on the next pass, not half-matched now.
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) {
    // No line boundary in this window. If we are at EOF the line is still being
    // written; otherwise the line is longer than the scan window — advance past it
    // so the cursor cannot stall forever on one pathological line.
    if (end < size) {
      state.offset = end;
    }
    return state.terminal;
  }

  for (const id of extractTerminalWorkflowIds(chunk.slice(0, lastNewline))) {
    state.terminal.add(id);
  }
  state.offset = start + Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8');

  return state.terminal;
}

/** Diagnostics/tests: how many transcripts currently hold a scan cursor. */
export function trackedTerminalScanCount(): number {
  return scanStates.size;
}

/**
 * Synchronous existence probe used by the scanner's fast path in tests; kept out
 * of the hot path deliberately (the async reader above is the only caller-facing
 * API). Exported so a test can assert the module never touches the FS when the
 * path is null.
 */
export function transcriptExists(jsonlPath: string | null): boolean {
  if (!jsonlPath) return false;
  try {
    return fs.existsSync(jsonlPath);
  } catch {
    return false;
  }
}
