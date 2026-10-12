/**
 * vendor-key-backup.guard — ADR-200 §2 (in-flag): before nassaj's first write
 * to a member's Claude, Codex or OpenCode credential file, that file's bytes
 * are stored encrypted as `backup:<harness>`. Every harness-file write path
 * calls this first: the credential dispatcher (company route, legacy route,
 * fan-out) and the link-mode switch.
 *
 * With the flag off it returns at once and runs nothing, so flag-off
 * behaviour is unchanged. (The migration runtime it loads at call time is
 * already imported statically by the provider routes, so this is not an
 * import-graph guarantee.)
 */

import {
  PROJECTION_HARNESSES,
  isUnifiedVendorKeysEnabled,
} from '@/services/isolation/provider-secrets-store.js';
import {
  isProviderSecretsStoreUnreadable,
  providerSecretsStoreUnreadableError,
} from '@/services/isolation/provider-secrets-store.errors.js';

/**
 * Backs up the member's own harness files unless the migration is already
 * verified. A backup that cannot be stored refuses the write: an unreadable
 * keys store becomes its typed 409.
 * @param userId the member whose tree is about to be written
 * @param provider the harness about to be written; other providers are ignored
 */
export async function backupBeforeFirstWrite(
  userId: string | number | null | undefined,
  provider: string,
): Promise<void> {
  if (!isUnifiedVendorKeysEnabled() || !(PROJECTION_HARNESSES as readonly string[]).includes(provider)) return;
  try {
    const { vendorKeyMigrationService } = await import('./vendor-key-migration.runtime.js');
    await vendorKeyMigrationService.ensureBackups(userId);
  } catch (error) {
    if (isProviderSecretsStoreUnreadable(error)) throw providerSecretsStoreUnreadableError();
    throw error;
  }
}
