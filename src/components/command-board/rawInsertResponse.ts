/**
 * rawInsertResponse — reads the body of POST /api/system/command-board-raw.
 *
 * Extracted from Markdown.tsx as the fix for B-257: the chat code-block button
 * inserted the command successfully (201, audit row written, badge incremented)
 * and then told the owner «Failed to add command to queue», because it read the
 * created row at the TOP level while the route nests it:
 *
 *     201 → { command: { id, command, digest, requestedBy, requestedAt } }
 *     4xx → { status: 'error', code, position? }
 *
 * So `data.id` and `data.digest` were both undefined and the success guard fell
 * through to the error branch. The review dialog therefore never opened, and the
 * owner was told nothing happened while a real row sat in the queue — the worst
 * possible reading for a surface whose whole job is telling the truth about what
 * is about to run.
 *
 * It lives in its own module rather than inside the component so the shape
 * contract can be tested directly: the bug was invisible to every existing test
 * precisely because it needed a rendered CodeBlock plus an armed board plus a
 * raw tier to reproduce.
 */

import type { RawCommand } from './ExecReviewDialog';

export type RawInsertOutcome =
  | { ok: true; row: RawCommand }
  | { ok: false; code: string };

/** One insert attempt that did not queue the command (B-261). */
export type InsertErrorState = {
  /** Server refusal code, or 'internal' for an actual malfunction. */
  code: string;
  message: string;
  /** Wall-clock of the attempt, so the line can date itself. */
  at: number;
  /** 1-based; surfaced from the second attempt so a repeat click is visible. */
  attempt: number;
};

/**
 * Only a genuine malfunction is an error. Everything else the insert route can
 * answer is the server REFUSING on purpose — the denylist, the Trojan-Source
 * scanner, the length and line caps, a full queue. Painting a working guard in
 * the same red as a broken feature is the mistake B-260 fixed in the text; this
 * is the same mistake one layer up, in the visual and ARIA language.
 */
export function isMalfunction(code: string): boolean {
  return code === 'internal';
}

/**
 * Folds a failed attempt into the previous one.
 *
 * B-261: the old state was a bare string, so clicking Execute three times on an
 * unchanged block re-set the same text to the same value — no visible change at
 * all, which is indistinguishable from a frozen screen. The owner then repaired
 * the problem in their own terminal and read the still-standing line as «my fix
 * did not work», because nothing in it said which moment it described.
 *
 * When the refusal repeats identically the TEXT teaches nothing, so the count is
 * the only honest signal that the click landed. A different code starts over: it
 * is a new verdict, not a repetition.
 */
export function nextInsertError(
  prev: InsertErrorState | null,
  code: string,
  message: string,
  at: number,
): InsertErrorState {
  return {
    code,
    message,
    at,
    attempt: prev && prev.code === code ? prev.attempt + 1 : 1,
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * @param httpOk  res.ok — a non-2xx is an error no matter how the body parses.
 * @param body    the parsed JSON body ({} when parsing failed).
 *
 * A row is only accepted with all three fields that make it reviewable: the id
 * the execute call is addressed to, the command text, and the digest binding
 * that text to the stored bytes. Anything less is reported as an error rather
 * than opened in the reviewer with a missing integrity check.
 */
export function parseRawInsertResponse(httpOk: boolean, body: unknown): RawInsertOutcome {
  const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  // Canonical shape is nested. A flat row is also accepted: it costs one
  // expression, and a mismatch between where the route puts the row and where
  // the client looks for it is exactly the defect this module exists to fix.
  const nested = payload.command;
  const row = (nested && typeof nested === 'object' ? nested : payload) as Record<string, unknown>;

  const id = str(row.id);
  const command = str(row.command);
  const digest = str(row.digest);

  if (!httpOk || !id || !command || !digest) {
    return { ok: false, code: str(payload.code) || 'internal' };
  }

  return {
    ok: true,
    row: {
      id,
      command,
      digest,
      requestedBy: typeof row.requestedBy === 'string' ? row.requestedBy : null,
      requestedAt: typeof row.requestedAt === 'string' ? row.requestedAt : null,
    },
  };
}
