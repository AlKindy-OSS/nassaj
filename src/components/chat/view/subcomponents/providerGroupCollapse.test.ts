/**
 * Unit contract for the model-picker group collapse logic (T-871, revised B-245).
 *
 * Pure-function assertions (no DOM, no cmdk, no i18n). The default changed on
 * 2026-07-28 by owner decision: EVERY group starts collapsed. The old size and
 * selected-model exceptions meant the first bodies filled the viewport and the
 * rest of the list — engine rows included — sat below the fold, which is how a
 * present GLM entry got reported as missing. The stored-preference and search
 * overrides are unchanged and still pinned here.
 */
import { describe, it, expect } from 'vitest';

import {
  COLLAPSE_STORAGE_KEY,
  START_COLLAPSED,
  readCollapsedMap,
  writeCollapsedMap,
  resolveExpandedNoSearch,
  resolveGroupExpanded,
  type CollapsedMap,
} from './providerGroupCollapse';

describe('resolveExpandedNoSearch — default (no stored preference)', () => {
  it('declares the collapsed-by-default policy', () => {
    expect(START_COLLAPSED).toBe(true);
  });

  it('starts a tiny group collapsed', () => {
    expect(
      resolveExpandedNoSearch({ storedCollapsed: undefined, modelCount: 1, containsSelected: false }),
    ).toBe(false);
  });

  it('starts a large group collapsed', () => {
    expect(
      resolveExpandedNoSearch({ storedCollapsed: undefined, modelCount: 42, containsSelected: false }),
    ).toBe(false);
  });

  it('collapses the group holding the selected model too — the card above already names it', () => {
    expect(
      resolveExpandedNoSearch({ storedCollapsed: undefined, modelCount: 42, containsSelected: true }),
    ).toBe(false);
  });

  it('needs neither count nor selection to decide', () => {
    expect(resolveExpandedNoSearch({ storedCollapsed: undefined })).toBe(false);
  });
});

describe('resolveExpandedNoSearch — stored preference overrides the default', () => {
  it('a stored collapsed=true collapses a tiny group', () => {
    expect(
      resolveExpandedNoSearch({
        storedCollapsed: true,
        modelCount: 1,
        containsSelected: false,
      }),
    ).toBe(false);
  });

  it('a stored collapsed=false expands even a large group', () => {
    expect(
      resolveExpandedNoSearch({
        storedCollapsed: false,
        modelCount: 99,
        containsSelected: false,
      }),
    ).toBe(true);
  });

  it('a stored collapsed=true keeps a group with the selected model closed', () => {
    // Nothing re-opens a group the user closed — not even the active model.
    expect(
      resolveExpandedNoSearch({
        storedCollapsed: true,
        modelCount: 10,
        containsSelected: true,
      }),
    ).toBe(false);
  });
});

describe('resolveGroupExpanded — search overrides collapse', () => {
  it('forces a large, unselected, non-stored group open while searching', () => {
    expect(
      resolveGroupExpanded({
        storedCollapsed: undefined,
        modelCount: 30,
        containsSelected: false,
        isSearching: true,
      }),
    ).toBe(true);
  });

  it('forces a user-collapsed group open while searching', () => {
    expect(
      resolveGroupExpanded({
        storedCollapsed: true,
        modelCount: 30,
        containsSelected: false,
        isSearching: true,
      }),
    ).toBe(true);
  });

  it('defers to the collapsed state once the search clears', () => {
    expect(
      resolveGroupExpanded({
        storedCollapsed: true,
        modelCount: 30,
        containsSelected: false,
        isSearching: false,
      }),
    ).toBe(false);
  });
});

/** In-memory Storage stub exposing only getItem/setItem. */
function makeStorage(seed?: string): Pick<Storage, 'getItem' | 'setItem'> {
  let value: string | null = seed ?? null;
  return {
    getItem: (key: string) => (key === COLLAPSE_STORAGE_KEY ? value : null),
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('readCollapsedMap / writeCollapsedMap', () => {
  it('round-trips a map through storage', () => {
    const storage = makeStorage();
    const map: CollapsedMap = { opencode: true, antigravity: false };
    writeCollapsedMap(map, storage);
    expect(readCollapsedMap(storage)).toEqual(map);
  });

  it('returns an empty map for a cold storage (no key set)', () => {
    expect(readCollapsedMap(makeStorage())).toEqual({});
  });

  it('returns an empty map for malformed JSON instead of throwing', () => {
    expect(readCollapsedMap(makeStorage('{not json'))).toEqual({});
  });

  it('drops non-boolean and array/object shapes defensively', () => {
    const storage = makeStorage(
      JSON.stringify({ opencode: true, bogus: 'yes', nested: { x: 1 }, n: 3 }),
    );
    expect(readCollapsedMap(storage)).toEqual({ opencode: true });
  });

  it('treats a JSON array as empty (not a valid map)', () => {
    expect(readCollapsedMap(makeStorage('[1,2,3]'))).toEqual({});
  });

  it('is a no-op (no throw) when storage is null', () => {
    expect(() => writeCollapsedMap({ a: true }, null)).not.toThrow();
    expect(readCollapsedMap(null)).toEqual({});
  });
});
