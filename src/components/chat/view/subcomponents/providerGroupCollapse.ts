/**
 * Collapse/expand resolution for the model-picker provider groups (T-871).
 *
 * Pure, DOM-free logic so the behaviour is unit-tested deterministically and no
 * business rule lives inside the render tree. The picker component (Provider
 * SelectionEmptyState) owns the React state and the localStorage side effects;
 * this module only decides "given these inputs, is the group open?".
 *
 * Storage model: a single JSON object keyed by group id, each value the
 * per-group COLLAPSED flag (true = user chose collapsed, false = user chose
 * expanded). A group absent from the map has no stored preference and falls
 * back to the size/selection default below.
 */

/** localStorage key holding the `{ [groupId]: collapsed }` map. */
export const COLLAPSE_STORAGE_KEY = 'model-picker-collapsed-groups';

/**
 * Every group starts COLLAPSED (owner decision, 2026-07-28). The picker's job on
 * open is to show WHAT CAN RUN — one line per body — not to dump every model of
 * every body into one scroll. The size heuristic this replaces (expand any group
 * with ≤ 5 models) meant the first two bodies filled the viewport and everything
 * after them, including the engine rows, was below the fold: the owner read the
 * top of the list, saw no GLM, and reported it missing while the settings screen
 * said it was there. Both were true (B-245).
 *
 * A stored per-group preference still wins, and an active search still expands
 * everything so cmdk can filter across all of it.
 */
export const START_COLLAPSED = true;

/** Per-group collapsed flags. `true` = collapsed, `false` = expanded. */
export type CollapsedMap = Record<string, boolean>;

/** Minimal storage surface so tests can pass a stub without a full Storage. */
type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

/**
 * Reads and sanitises the persisted collapsed map. Never throws: a missing key,
 * malformed JSON, a non-object, or non-boolean values all degrade to an empty
 * map (⇒ every group uses its default). Only boolean entries survive.
 */
export function readCollapsedMap(storage: ReadableStorage | null | undefined): CollapsedMap {
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: CollapsedMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Persists the collapsed map. Never throws (private mode / quota / disabled
 * storage are swallowed — the in-memory React state remains the source of truth
 * for the current session).
 */
export function writeCollapsedMap(
  map: CollapsedMap,
  storage: WritableStorage | null | undefined,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* best-effort: storage unavailable */
  }
}

/**
 * The group's open state IGNORING any active search.
 *
 * Precedence:
 *  1. A stored preference (the user toggled this group) always wins.
 *  2. Otherwise every group starts collapsed — see {@link START_COLLAPSED}.
 *
 * `modelCount` and `containsSelected` are still accepted so callers keep one
 * call shape, but neither opens a group any more: which model is active is
 * already stated on the card that opens this dialog, so opening its group as
 * well bought nothing and cost the fold.
 */
export function resolveExpandedNoSearch(params: {
  storedCollapsed: boolean | undefined;
  modelCount?: number;
  containsSelected?: boolean;
}): boolean {
  const { storedCollapsed } = params;
  if (storedCollapsed !== undefined) {
    return !storedCollapsed;
  }
  return !START_COLLAPSED;
}

/**
 * The group's effective open state. An active search overrides collapse
 * entirely (every group is rendered expanded so cmdk can filter its items and
 * hide the groups with no match); otherwise it defers to
 * {@link resolveExpandedNoSearch}.
 */
export function resolveGroupExpanded(params: {
  storedCollapsed: boolean | undefined;
  modelCount?: number;
  containsSelected?: boolean;
  isSearching: boolean;
}): boolean {
  if (params.isSearching) {
    return true;
  }
  return resolveExpandedNoSearch(params);
}
