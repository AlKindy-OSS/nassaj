import type { ProviderModelsDefinition } from '../../../types/app';

/**
 * Self-sanitizer for a provider model value.
 *
 * Resolution order:
 *  1. The stored value, if it is a valid option in `def`.
 *  2. The current in-memory value, if it is a valid option in `def`.
 *  3. The catalog default.
 *
 * Pure and React-free so it can be unit tested directly. `def` is whichever
 * catalog is currently authoritative for the provider: the live API catalog
 * when available, otherwise the embedded fallback catalog.
 */
export function pickStoredOrCurrent(
  stored: string | null,
  current: string,
  def: ProviderModelsDefinition,
): string {
  if (stored && def.OPTIONS.some((option) => option.value === stored)) {
    return stored;
  }
  if (current && def.OPTIONS.some((option) => option.value === current)) {
    return current;
  }
  return def.DEFAULT;
}
