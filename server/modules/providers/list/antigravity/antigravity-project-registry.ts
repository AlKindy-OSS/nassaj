/**
 * In-memory registry mapping freshly created agy brain UUIDs to the real
 * workspace path they were spawned in.
 *
 * Why this exists: agy never records the workspace inside its brain transcript,
 * and the only component that knows the real `cwd` is the spawn adapter
 * (`agy-cli.js`). The session synchronizer, however, can fire at any time — on
 * server boot, on a sidebar refresh, or on a watcher tick — and may reach a
 * brand-new brain UUID *before* the spawn adapter's close handler has filed the
 * real path into the DB. When that race is lost, the synchronizer writes the
 * `/__antigravity__` placeholder and the conversation disappears from its
 * project folder.
 *
 * The spawn adapter publishes the brain UUID -> real path mapping the instant it
 * discovers the UUID (on first stdout, well before the process exits), and the
 * synchronizer consults this registry before ever falling back to the
 * placeholder. The mapping is intentionally process-local and unbounded-free:
 * once the DB row carries a real path the entry is no longer needed, so callers
 * clear it after the session ends.
 */

const PLACEHOLDER_PROJECT_PATH = '/__antigravity__';

const brainUuidToProjectPath = new Map<string, string>();

/**
 * Records the real workspace path for a brain UUID. Placeholder/empty paths are
 * ignored so a bad value can never shadow a previously registered real path.
 */
export function registerAntigravityProjectPath(brainUuid: string, projectPath: string): void {
  const trimmed = projectPath?.trim();
  if (!brainUuid || !trimmed || trimmed === PLACEHOLDER_PROJECT_PATH) {
    return;
  }
  brainUuidToProjectPath.set(brainUuid, trimmed);
}

/**
 * Returns the real workspace path registered for a brain UUID, or null when the
 * UUID was never associated with a real project in this process.
 */
export function getAntigravityProjectPath(brainUuid: string): string | null {
  return brainUuidToProjectPath.get(brainUuid) ?? null;
}

/**
 * Drops a brain UUID's entry once its real path is durably persisted in the DB.
 */
export function clearAntigravityProjectPath(brainUuid: string): void {
  brainUuidToProjectPath.delete(brainUuid);
}
