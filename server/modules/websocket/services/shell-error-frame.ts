/**
 * What the terminal pane is allowed to say when a shell launch throws.
 *
 * Two failures pull in opposite directions and both are real:
 *
 *  - A raw `error.message` is an UNBOUNDED source. It can carry absolute paths,
 *    HOME, command text or vendor output, and the pane is our least controlled
 *    surface (it is pasted into screenshots and bug reports). Echoing it was a
 *    genuine leak.
 *  - A single generic sentence hides the ONE failure this fleet has actually
 *    produced since June - the missing `claude` binary - from the only person
 *    who can fix it, because node owners do not read `pm2 logs`.
 *
 * The resolution is neither: a DECLARED list of publishable diagnostics. Each
 * entry is matched by prefix against the thrown message and answers with its own
 * hand-written text, so what reaches the pane is a constant authored here, never
 * the interpolated tail of the exception. Anything unmatched keeps the generic
 * sentence plus its reason code, and the raw message stays in the server log.
 *
 * Adding an entry is therefore an explicit publication decision, reviewable in
 * one place: write the text as if it will be posted in a public issue.
 */

import { sanitizeTerminalText } from '../../../../shared/terminalText.js';

/** Reason code for an exception with no publishable diagnostic. */
export const SHELL_ERROR_UNCLASSIFIED = 'shell_error_unclassified';

type ShellErrorDiagnostic = {
  /** Stable code, logged server-side and shown in the pane for support. */
  code: string;
  /** Prefix of the thrown `Error.message` this entry claims. */
  match: string;
  /** The exact, path-free text published to the pane. */
  text: string;
};

/**
 * Publishable diagnostics, in match order.
 *
 * Deliberately short. An error earns a place here only when (a) the user can act
 * on it and (b) the action can be stated without naming a filesystem path.
 */
export const SHELL_ERROR_DIAGNOSTICS: readonly ShellErrorDiagnostic[] = [
  {
    code: 'shell_claude_binary_missing',
    match: 'Claude executable not found before installing the managed terminal launcher',
    // The thrown message appends the probed candidate and HOME; that tail is the
    // part we refuse to publish. The remedy survives without it.
    text:
      'Claude executable not found. The managed terminal launcher could not find the '
      + "claude CLI on this node's PATH. Install it, or set CLAUDE_CLI_PATH to the "
      + 'absolute path of the claude binary, then reopen this terminal.',
  },
  {
    code: 'shell_session_binding_missing',
    match: 'A session-bound Claude terminal requires a sessionId',
    text:
      'This terminal was opened as a session-bound Claude terminal without a session. '
      + 'Reopen it from the session you want to resume.',
  },
];

/** Classification of a thrown shell error into what the pane may show. */
export type ClassifiedShellError = { code: string; text: string };

/**
 * Map a thrown message onto its publishable diagnostic.
 *
 * @param message Raw `Error.message` (or `String(error)`); never published as-is.
 * @returns The reason code and the text the pane is allowed to render.
 */
export function classifyShellError(message: string): ClassifiedShellError {
  const raw = typeof message === 'string' ? message : String(message);
  for (const diagnostic of SHELL_ERROR_DIAGNOSTICS) {
    if (raw.startsWith(diagnostic.match)) {
      return { code: diagnostic.code, text: diagnostic.text };
    }
  }
  return {
    code: SHELL_ERROR_UNCLASSIFIED,
    text: 'Terminal error: the request could not be completed.',
  };
}

/**
 * Re-exported, not defined here.
 *
 * The client writes server `error` frames into xterm itself, so it needs the
 * same stripping this file's frames get. It now imports the single definition
 * in `shared/terminalText.ts`; this re-export keeps every existing server
 * importer (`shell-websocket.service.ts`, the node test) unchanged, and keeps
 * one function where two copies would have drifted (B-1253 M-3).
 */
export { sanitizeTerminalText };

/**
 * Build the red `output` frame for a failed shell request.
 *
 * The colour codes are added here, AFTER sanitising, so the only escapes in the
 * payload are the two this function wrote itself.
 *
 * @param message Raw thrown message.
 * @returns `{ code, data }` - the reason code to log and the frame payload.
 */
export function buildShellErrorFrame(message: string): { code: string; data: string } {
  const { code, text } = classifyShellError(message);
  return {
    code,
    data: `\r\n\u001b[31m${sanitizeTerminalText(text)} [${code}]\u001b[0m\r\n`,
  };
}
