/**
 * UI preferences repository.
 *
 * Stores per-user UI preferences as a single opaque JSON blob so they can be
 * synced across devices (replacing localStorage-only storage). The frontend
 * owns the schema/contract: the server stores any valid JSON object as-is and
 * does NOT enforce a fixed set of keys, which keeps new preferences additive
 * without a server change. Mirrors notification-preferences in lifecycle.
 */

import { getConnection } from '@/modules/database/connection.js';

export type UiPreferences = Record<string, unknown>;

// Upper bound on the serialized stored blob. Guards against a runaway/abusive
// payload bloating the row; 64KB is far larger than any realistic UI-prefs set.
const MAX_PREFERENCES_BYTES = 64 * 1024;

/** True for a plain JSON object (not null, not an array). */
function isPlainObject(value: unknown): value is UiPreferences {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWithinSizeLimit(serialized: string): void {
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_PREFERENCES_BYTES) {
    throw new Error(
      `UI preferences payload too large: ${bytes} bytes (max ${MAX_PREFERENCES_BYTES})`
    );
  }
}

export const uiPreferencesDb = {
  /** Returns the stored preferences object for a user, or {} when none exist. */
  getUiPreferences(userId: number): UiPreferences {
    const db = getConnection();
    const row = db
      .prepare('SELECT preferences_json FROM user_ui_preferences WHERE user_id = ?')
      .get(userId) as { preferences_json: string } | undefined;

    if (!row) {
      return {};
    }

    try {
      const parsed = JSON.parse(row.preferences_json);
      return isPlainObject(parsed) ? parsed : {};
    } catch {
      // Corrupt/legacy value: behave as if unset rather than throwing.
      return {};
    }
  },

  /**
   * Shallow-merges `partial` over the stored preferences (a partial PUT keeps
   * keys it does not mention), upserts the merged object, and returns it.
   * Throws if `partial` is not a plain object or the merged blob exceeds the
   * size limit.
   */
  updateUiPreferences(userId: number, partial: unknown): UiPreferences {
    if (!isPlainObject(partial)) {
      throw new TypeError('UI preferences must be a JSON object');
    }

    const current = uiPreferencesDb.getUiPreferences(userId);
    const merged: UiPreferences = { ...current, ...partial };
    const serialized = JSON.stringify(merged);
    assertWithinSizeLimit(serialized);

    const db = getConnection();
    db.prepare(
      `INSERT INTO user_ui_preferences (user_id, preferences_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         preferences_json = excluded.preferences_json,
         updated_at = CURRENT_TIMESTAMP`
    ).run(userId, serialized);

    return merged;
  },
};
