/**
 * B-472 — the Settings panel's Codex permission mode seeds the composer.
 *
 * The panel persists its choice in localStorage `codex-settings`. That value is a
 * user PREFERENCE, not a security control (the cap is server-side,
 * mapPermissionModeToCodexOptions). It is used only as the INITIAL composer mode
 * for Codex, so the composer shows exactly what will run; what is sent is always
 * the composer's own mode.
 */
const CODEX_MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;
export type CodexSettingsPermissionMode = (typeof CODEX_MODES)[number];

const isCodexMode = (value: unknown): value is CodexSettingsPermissionMode =>
  typeof value === 'string' && (CODEX_MODES as readonly string[]).includes(value);

/** Settings-panel Codex mode from the raw stored JSON; 'default' when missing/invalid. */
export function readCodexSettingsPermissionMode(
  rawCodexSettings: string | null | undefined,
): CodexSettingsPermissionMode {
  try {
    const stored = rawCodexSettings ? (JSON.parse(rawCodexSettings) as { permissionMode?: unknown }) : null;
    if (isCodexMode(stored?.permissionMode)) {
      return stored.permissionMode;
    }
  } catch {
    // unreadable settings fall back to the strictest mode
  }
  return 'default';
}

/** Initial composer permission mode for a provider ('default' for all but Codex). */
export function initialComposerPermissionMode(
  provider: string,
  rawCodexSettings: string | null | undefined,
): CodexSettingsPermissionMode {
  return provider === 'codex' ? readCodexSettingsPermissionMode(rawCodexSettings) : 'default';
}

const PENDING_KEY = '__nassaj_pending_codex_permission_stamp';
const PENDING_TTL_MS = 60_000;

/**
 * One-shot hand-off bound to the creating send: the mode a brand-new Codex chat
 * was sent with, keyed by that send's clientMsgId. The session_created handler
 * applies it only to the session minted for the SAME clientMsgId, so neither a
 * session opened meanwhile nor an unrelated event can ever take it.
 */
export function writePendingCodexPermissionStamp(mode: string, clientMsgId: string | null | undefined): void {
  if (!clientMsgId || !isCodexMode(mode)) return;
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ mode, clientMsgId, at: Date.now() }));
}

/** Drops the stamp (send failure, or session_created with an empty id). */
export function clearPendingCodexPermissionStamp(): void {
  sessionStorage.removeItem(PENDING_KEY);
}

/**
 * session_created handler: persists `permissionMode-<newSessionId>` from the
 * stamp when (and only when) `incomingClientMsgId` matches the stamp's send.
 * A mismatch leaves the stamp for its own send (stale ones expire by TTL).
 */
export function applyPendingCodexPermissionStamp(
  newSessionId: string,
  incomingClientMsgId: string | null | undefined,
): CodexSettingsPermissionMode | null {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw || !incomingClientMsgId) return null;
  try {
    const stamp = JSON.parse(raw) as { mode?: unknown; clientMsgId?: unknown; at?: unknown };
    if (typeof stamp.at !== 'number' || Date.now() - stamp.at > PENDING_TTL_MS) {
      clearPendingCodexPermissionStamp();
      return null;
    }
    if (stamp.clientMsgId !== incomingClientMsgId || !isCodexMode(stamp.mode)) return null;
    localStorage.setItem(`permissionMode-${newSessionId}`, stamp.mode);
    clearPendingCodexPermissionStamp();
    return stamp.mode;
  } catch {
    clearPendingCodexPermissionStamp();
    return null;
  }
}

/**
 * Fork / stale-resume continuity: the replacement session keeps the mode the user
 * chose for the one it continues (never re-seeded from Settings). No-op when the
 * old session has no saved mode or the new one already has its own.
 */
export function carryPermissionModeToSession(fromSessionId: string, toSessionId: string): void {
  const saved = localStorage.getItem(`permissionMode-${fromSessionId}`);
  if (saved && isCodexMode(saved) && localStorage.getItem(`permissionMode-${toSessionId}`) === null) {
    localStorage.setItem(`permissionMode-${toSessionId}`, saved);
  }
}
