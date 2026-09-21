/**
 * modelFavorites.ts — pure, DOM-free logic for the model-picker favourites group.
 *
 * Mirrors the structure of providerGroupCollapse.ts: all business rules live here
 * so the component owns only React state and API side-effects; this module only
 * decides "given these inputs, which rows are favourited?".
 *
 * Key design decisions:
 *
 * — KEYS, NOT MODEL NAMES: `FavoriteModels` is an array of `PickerRow.key`
 *   strings (e.g. `"claude:claude-3-5-sonnet-20241022"`,
 *   `"claude:engine:glm:glm-5.2"`). Bare model names are ambiguous: "glm-5.2"
 *   appears under three different runs (B-245 is exactly why the picker uses
 *   the full key as the stable identifier for each runnable combination).
 *
 * — STALE-TOLERANT: `resolveFavoriteRows` skips any key that is no longer in
 *   the live catalog (provider removed, key expired, model retired) but does
 *   NOT remove the key from storage — if the provider/model comes back, the
 *   favourite returns automatically. The caller is responsible for not
 *   re-saving stale keys until the user explicitly removes them.
 *
 * — NO LOCKED ROWS: a locked row (key placeholder → opens settings) cannot be
 *   run as a model, so pinning it as a favourite is meaningless.
 *   `resolveFavoriteRows` silently drops any locked row that somehow appears.
 *
 * — ORDER PRESERVED: rows are returned in the order the user added them (FIFO:
 *   newest at the end), matching the natural feel of a "recently starred" list.
 *   `toggleFavorite` appends rather than prepends.
 *
 * Pure and DOM-free so the row set is unit-tested without React or cmdk.
 */

import type { PickerRow } from './modelPickerRows';

/** The stored preference value: an array of `PickerRow.key` strings. */
export type FavoriteModels = string[];

/**
 * True when `key` is in the favourites list.
 * Pure, no side effects.
 */
export function isFavorite(key: string, favorites: FavoriteModels): boolean {
  return favorites.includes(key);
}

/**
 * Returns a new array with `key` added (if absent) or removed (if present).
 * Immutable — the input array is never mutated.
 */
export function toggleFavorite(key: string, favorites: FavoriteModels): FavoriteModels {
  return favorites.includes(key)
    ? favorites.filter((k) => k !== key)
    : [...favorites, key];
}

/**
 * Resolves which rows from `allRows` should appear in the favourites group.
 *
 * Rules applied in order:
 *  1. Only rows whose key appears in `favorites` are considered.
 *  2. Locked rows are excluded (they open settings, not a model run).
 *  3. The resolved set is ordered by the favourites array (FIFO insertion
 *     order), not by the catalog order.
 *  4. A key present in `favorites` but absent from `allRows` is silently
 *     dropped (stale favourite — see module header).
 *
 * @param allRows   All PickerRow objects from ALL body groups combined. Pass
 *                  the full flat set so a favourite from the Claude body can be
 *                  found even when the Claude group is collapsed.
 * @param favorites The stored `FavoriteModels` array.
 */
export function resolveFavoriteRows(allRows: PickerRow[], favorites: FavoriteModels): PickerRow[] {
  if (favorites.length === 0) {
    return [];
  }

  // Defensive dedupe: duplicate keys in `favorites` would produce colliding
  // React keys (`fav:${key}`) causing reconciliation corruption. Duplicates can
  // appear if a race condition or external write inserts the same key twice.
  // Dedupe preserves FIFO insertion order (first occurrence wins).
  const seen = new Set<string>();
  const deduped = favorites.filter((k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Index all rows by key for O(1) lookup.
  const byKey = new Map<string, PickerRow>(allRows.map((row) => [row.key, row]));

  const out: PickerRow[] = [];
  for (const key of deduped) {
    const row = byKey.get(key);
    // Drop stale (key not in current catalog) and locked rows.
    if (row && !row.locked) {
      out.push(row);
    }
  }
  return out;
}
