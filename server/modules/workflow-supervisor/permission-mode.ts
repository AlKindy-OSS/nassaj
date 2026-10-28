/**
 * T-2071: the permission mode every headless `claude -p` spawn passes EXPLICITLY.
 *
 * The CLI's own default flips between versions (`auto` on 2.1.285, `default` on
 * 2.1.302), so leaving `--permission-mode` out makes a spawn's permissions depend
 * on whichever binary is installed. The mode is the session's actual one: the CLI
 * stamps it on every human turn it writes to the transcript (`permissionMode` on a
 * top-level `user` row), so the latest such row is the mode the session last ran in.
 */

/** Every mode the CLI accepts for `--permission-mode` (SDK 0.3.310 PermissionMode). */
export const CLAUDE_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
] as const;

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** Mode used when the session's own mode cannot be read. */
export const FALLBACK_PERMISSION_MODE: ClaudePermissionMode = 'default';

/** Whether `value` is a mode the CLI accepts. */
export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * The session's latest permission mode from transcript text: the `permissionMode`
 * of the last top-level, non-sidechain `user` row that carries a valid one.
 * Unreadable or absent → FALLBACK_PERMISSION_MODE.
 * @param text - whole transcript (JSONL) text, or null when the file is absent
 */
export function lastTranscriptPermissionMode(text: string | null): ClaudePermissionMode {
  if (!text) return FALLBACK_PERMISSION_MODE;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"permissionMode"')) continue;
    let row: { type?: unknown; isSidechain?: unknown; permissionMode?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.type !== 'user' || row.isSidechain === true) continue;
    if (isClaudePermissionMode(row.permissionMode)) return row.permissionMode;
  }
  return FALLBACK_PERMISSION_MODE;
}

/**
 * Modes a transcript row may hand a headless turn as they are: `default` and the
 * more restrictive `plan`. Every other mode (acceptEdits, bypassPermissions, auto,
 * dontAsk) is wider than `default`.
 */
const TRANSCRIPT_TRUSTED_MODES: ReadonlySet<ClaudePermissionMode> = new Set(['default', 'plan']);

/**
 * GUARD (qa M4, T-2071): a mode read from a transcript is capped at `default`. The
 * transcript is a file in the user's config tree, not a trusted record of what the
 * owner chose, so it may narrow a background turn (plan) but never widen it. Lift
 * this cap only once a trusted source (a server-side DB record of the session's
 * mode) exists; until then a wider mode from the transcript alone becomes `default`.
 */
export function capTranscriptPermissionMode(mode: ClaudePermissionMode): ClaudePermissionMode {
  return TRANSCRIPT_TRUSTED_MODES.has(mode) ? mode : FALLBACK_PERMISSION_MODE;
}
