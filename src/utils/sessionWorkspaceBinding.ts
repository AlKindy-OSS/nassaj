const STORAGE_PREFIX = 'nassaj:session-workspace-generation:';

function storageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

/** Persist the opaque server-issued workspace generation for one session. */
export function rememberSessionWorkspaceGeneration(
  sessionId: unknown,
  generation: unknown,
  storage: Pick<Storage, 'setItem'> = window.sessionStorage,
): boolean {
  if (typeof sessionId !== 'string' || !sessionId.trim()
      || typeof generation !== 'string' || !generation.trim()) {
    return false;
  }
  storage.setItem(storageKey(sessionId.trim()), generation.trim());
  return true;
}

/** Read a previously attested generation; absence deliberately stays unknown. */
export function readSessionWorkspaceGeneration(
  sessionId: unknown,
  storage: Pick<Storage, 'getItem'> = window.sessionStorage,
): string | null {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  const value = storage.getItem(storageKey(sessionId.trim()));
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
