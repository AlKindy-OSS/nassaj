/**
 * The one definition of "text a terminal pane may be handed".
 *
 * It lives in `shared/` because BOTH ends write to the same pane and both must
 * strip the same bytes: the server builds `output` frames
 * (`server/modules/websocket/services/shell-error-frame.ts`) and the client
 * writes `error` frames straight into xterm
 * (`src/components/shell/hooks/useShellConnection.ts`). Those two used to be one
 * sanitiser and one raw `terminal.write` — the frames the client rendered simply
 * bypassed the guard the server had built (B-1253 M-3). Two copies of this
 * function would be worse than one gap: they drift, and the drift is invisible
 * until something hostile lands on the weaker side.
 */

/**
 * Strip every control character the terminal would interpret as a command.
 *
 * Rather than pattern-match escape GRAMMARS — the classic place to get a bypass
 * wrong, since the same OSC can arrive as ESC `]` or as the single C1 byte 0x9d
 * — this drops the bytes those grammars are built from: C0 except tab/LF/CR,
 * DEL, and the whole C1 range. An escape sequence with no introducer is inert
 * text, and printable characters of every script (Arabic included) pass through
 * untouched.
 *
 * Colour codes are therefore added by the caller AFTER sanitising, so the only
 * escapes in a payload are the ones our own code wrote.
 *
 * @param text Untrusted or interpolated text bound for the pane.
 * @returns The same text with terminal-control bytes removed.
 */
export function sanitizeTerminalText(text: string): string {
  // Kept: TAB (09), LF (0a), CR (0d) — the pane's own line discipline.
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}
