/**
 * T-2037 — turns a one-shot capture into composer text the user reviews before
 * sending. Terminal output is untrusted: it may carry bidi overrides that make
 * the chat render something other than what was captured, control bytes, or a
 * backtick run that would close our fence early and turn the rest into live
 * markdown. All three are neutralised here.
 */

// ANSI CSI / OSC / DCS-style escapes, removed BEFORE the C0 sweep — otherwise
// dropping ESC alone would leave their printable tails (`[31m`) in the text.
const ANSI_ESCAPES =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[PX^_][^\u001B]*\u001B\\|\u001B[@-Z\\-_])/g;
// Every format character (bidi embeddings/overrides/isolates and marks, zero
// widths, soft hyphen… — the Trojan-Source class) plus the Unicode line and
// paragraph separators, matching the server's capture sanitiser.
const BIDI_CONTROLS = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
// C0 except \t and \n, DEL, and the C1 range.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Folds carriage returns the way a terminal would show them: CRLF becomes a
 * newline, and a bare CR (progress bars) keeps only what was drawn last.
 */
export function foldCarriageReturns(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r').filter((segment) => segment.length > 0);
      return segments.length > 0 ? segments[segments.length - 1] : '';
    })
    .join('\n');
}

/** Strips escapes, bidi controls and control bytes; keeps \n and \t. */
export function sanitizeCapturedText(text: string): string {
  return foldCarriageReturns(text.replace(ANSI_ESCAPES, ''))
    .replace(BIDI_CONTROLS, '')
    .replace(CONTROL_CHARS, '');
}

/** A backtick fence strictly longer than any backtick run in `content`. */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

export interface CaptureBlockInput {
  command: string;
  text: string;
  exitCode: number | null;
  truncated: boolean;
}

export interface CaptureBlockLabels {
  /** Localized header, e.g. "Output of a shell command — exit code 0". */
  header: string;
  /** Localized note appended when the server truncated the capture. */
  truncatedNote: string;
}

/**
 * Builds the composer insertion: a localized header line, then one ```text
 * fence holding `$ <command>` and the sanitized output. The command sits INSIDE
 * the fence so it can never render as markdown either.
 */
export function buildCaptureBlock(input: CaptureBlockInput, labels: CaptureBlockLabels): string {
  const command = sanitizeCapturedText(input.command).replace(/\n/g, ' ');
  const output = sanitizeCapturedText(input.text).replace(/\n+$/, '');
  const body = output ? `$ ${command}\n${output}` : `$ ${command}`;
  const fence = fenceFor(body);
  const lines = [labels.header, `${fence}text`, body, fence];
  if (input.truncated) lines.push(labels.truncatedNote);
  return lines.join('\n');
}
