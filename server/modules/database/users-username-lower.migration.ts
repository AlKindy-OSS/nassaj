import type { Database } from 'better-sqlite3';

/**
 * Case-insensitive username uniqueness (T-1939 slice 4, qa follow-up). The
 * users.username UNIQUE constraint is binary, so 'Sara' and 'sara' could
 * coexist; the application check (services/username-policy.js) closes that for
 * new names and this index makes the database refuse it as well.
 */
export const USERS_USERNAME_LOWER_UNIQUE_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(lower(username));';

const CASE_DUPLICATE_GROUP_COUNT_SQL = `SELECT COUNT(*) AS n FROM (SELECT lower(username) FROM users
  GROUP BY lower(username) HAVING COUNT(*) > 1)`;

/**
 * Adds idx_users_username_lower only when no two existing accounts differ
 * merely by case. Existing users are never renamed here: when such groups
 * exist the index is skipped, a count-only WARN line and an audit row are
 * written, and the next boot retries once the owner has renamed one of them.
 * Probe and CREATE share one immediate transaction.
 *
 * @returns the number of case-insensitive duplicate groups that blocked the index
 */
export function migrateUsernameLowerUniqueIndex(db: Database): number {
  const duplicateGroups = db.transaction(() => {
    const { n } = db.prepare(CASE_DUPLICATE_GROUP_COUNT_SQL).get() as { n: number };
    if (n === 0) {
      db.exec(USERS_USERNAME_LOWER_UNIQUE_INDEX_SQL);
    } else {
      db.prepare('INSERT INTO audit_log (user_id, action, metadata) VALUES (NULL, ?, ?)')
        .run('username_lower_unique_index_skipped', JSON.stringify({ duplicateGroups: n }));
    }
    return n;
  }).immediate();
  if (duplicateGroups > 0) {
    process.stderr.write(`${JSON.stringify({
      level: 'warn', scope: 'auth', code: 'username_lower_unique_index_skipped', duplicateGroups,
    })}\n`);
  }
  return duplicateGroups;
}

/** Explicit rollback of idx_users_username_lower; never invoked automatically. */
export function rollbackUsernameLowerUniqueIndex(db: Database): void {
  db.exec('DROP INDEX IF EXISTS idx_users_username_lower');
}
