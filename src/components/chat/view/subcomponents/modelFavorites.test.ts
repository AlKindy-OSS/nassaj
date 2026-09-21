/**
 * modelFavorites.test.ts — unit tests for the pure favourites logic.
 *
 * Covers:
 * (a) isFavorite — membership predicate.
 * (b) toggleFavorite — immutable add/remove, FIFO ordering.
 * (c) resolveFavoriteRows — stale keys dropped, locked rows excluded,
 *     FIFO order preserved, empty-favorites fast-path.
 * (d) Integration: a row that is both stale and locked is handled without error.
 *
 * Run: npx vitest run src/components/chat/view/subcomponents/modelFavorites.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { PickerRow } from './modelPickerRows';
import { isFavorite, resolveFavoriteRows, toggleFavorite } from './modelFavorites';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const row = (key: string, locked = false): PickerRow => ({
  key,
  model: locked ? '' : key.split(':').pop() ?? key,
  label: key,
  engine: { key: 'subscription', vars: { engine: 'Test' } },
  engineProvider: null,
  locked,
});

const ROW_A = row('claude:claude-sonnet-4-5');
const ROW_B = row('claude:claude-opus-4-8');
const ROW_C = row('opencode:glm/glm-5.2');
const ROW_LOCKED = row('claude:engine:glm:locked', true);

const ALL_ROWS = [ROW_A, ROW_B, ROW_C, ROW_LOCKED];

// ─── isFavorite ───────────────────────────────────────────────────────────────

describe('isFavorite', () => {
  it('returns true when the key is present', () => {
    expect(isFavorite(ROW_A.key, [ROW_A.key, ROW_B.key])).toBe(true);
  });

  it('returns false when the key is absent', () => {
    expect(isFavorite(ROW_C.key, [ROW_A.key, ROW_B.key])).toBe(false);
  });

  it('returns false for an empty favourites list', () => {
    expect(isFavorite(ROW_A.key, [])).toBe(false);
  });
});

// ─── toggleFavorite ──────────────────────────────────────────────────────────

describe('toggleFavorite', () => {
  it('adds a key that is not yet in the list (FIFO: appended)', () => {
    const result = toggleFavorite(ROW_C.key, [ROW_A.key, ROW_B.key]);
    expect(result).toEqual([ROW_A.key, ROW_B.key, ROW_C.key]);
  });

  it('removes a key that is already in the list', () => {
    const result = toggleFavorite(ROW_A.key, [ROW_A.key, ROW_B.key]);
    expect(result).toEqual([ROW_B.key]);
  });

  it('does not mutate the original array (immutable)', () => {
    const original = [ROW_A.key];
    toggleFavorite(ROW_B.key, original);
    expect(original).toEqual([ROW_A.key]);
  });

  it('works on an empty list', () => {
    expect(toggleFavorite(ROW_A.key, [])).toEqual([ROW_A.key]);
  });
});

// ─── resolveFavoriteRows ─────────────────────────────────────────────────────

describe('resolveFavoriteRows', () => {
  it('returns an empty array when favorites is empty (fast path)', () => {
    expect(resolveFavoriteRows(ALL_ROWS, [])).toEqual([]);
  });

  it('returns matched, non-locked rows in FIFO order', () => {
    const result = resolveFavoriteRows(ALL_ROWS, [ROW_C.key, ROW_A.key]);
    expect(result).toEqual([ROW_C, ROW_A]);
  });

  it('drops stale keys that are not in the current catalog', () => {
    const staleKey = 'claude:claude-3-retired';
    const result = resolveFavoriteRows(ALL_ROWS, [staleKey, ROW_B.key]);
    // Stale key silently skipped; ROW_B still appears.
    expect(result).toEqual([ROW_B]);
  });

  it('drops locked rows even when their key is in favorites', () => {
    const result = resolveFavoriteRows(ALL_ROWS, [ROW_LOCKED.key, ROW_A.key]);
    // Locked row excluded; ROW_A still appears.
    expect(result).toEqual([ROW_A]);
  });

  it('handles a favorites list where ALL keys are stale — returns empty', () => {
    expect(resolveFavoriteRows(ALL_ROWS, ['stale:one', 'stale:two'])).toEqual([]);
  });

  it('preserves order even when allRows is in a different order', () => {
    // favorites: B, C, A — result should respect that order
    const result = resolveFavoriteRows(ALL_ROWS, [ROW_B.key, ROW_C.key, ROW_A.key]);
    expect(result.map((r) => r.key)).toEqual([ROW_B.key, ROW_C.key, ROW_A.key]);
  });

  it('handles a mix of stale + locked + valid — returns only valid', () => {
    const result = resolveFavoriteRows(ALL_ROWS, [
      'stale:ghost',
      ROW_LOCKED.key,
      ROW_C.key,
    ]);
    expect(result).toEqual([ROW_C]);
  });
});
