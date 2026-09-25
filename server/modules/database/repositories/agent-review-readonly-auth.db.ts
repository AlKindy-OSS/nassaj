import type { Database } from 'better-sqlite3';

import { digestApiKey } from '../api-key-digest.js';

export type ReviewAuthUser = { id: number; username: string; role: 'owner' | 'admin' | 'user';
  authorization_generation: number; password_changed_at: number; must_change_password: number; api_key_id?: number };
const USER_COLUMNS = 'u.id,u.username,u.role,u.authorization_generation,u.password_changed_at,u.must_change_password';

/** C4-only explicit-connection auth reads. No refresh, settings creation, audit, last_used or repair. */
export class AgentReviewReadonlyAuthRepository {
  private readonly keyBindings = new WeakMap<ReviewAuthUser, string>();

  constructor(private readonly db: Database) {}

  /** Require the literal persisted TEXT gate; absence, read errors and coerced values deny. */
  ckEnabled(): boolean {
    try {
      const row = this.db.prepare('SELECT value FROM app_config WHERE key = ?').get('external_api.enabled') as { value: unknown } | undefined;
      return row?.value === '1';
    } catch { return false; }
  }

  /** Resolve an active user eligible for the review surface, without updating authentication metadata. */
  user(id: number): ReviewAuthUser | null {
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return this.db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id=? AND u.is_active=1 AND u.status='active'
      AND u.must_change_password=0`).get(id) as ReviewAuthUser | undefined ?? null;
  }

  /** Read-only sibling of canonical CK digest lookup, gated before identity lookup. */
  key(secret: string): ReviewAuthUser | null {
    if (!this.ckEnabled()) return null;
    const digest = digestApiKey(secret); if (!digest) return null;
    const user = this.db.prepare(`SELECT ${USER_COLUMNS},ak.id AS api_key_id FROM api_keys ak JOIN users u ON u.id=ak.user_id
      WHERE ak.key_digest=? AND ak.is_active=1 AND u.is_active=1 AND u.status='active' AND u.must_change_password=0`)
      .get(digest) as ReviewAuthUser | undefined;
    if (!user) return null;
    Object.freeze(user); this.keyBindings.set(user, digest);
    return user;
  }

  /** Recheck the captured generation and exact credential under the caller's current transaction/read boundary. */
  current(userId: number, generation: number, passwordStamp: number, key?: ReviewAuthUser): boolean {
    if (key !== undefined && !this.ckEnabled()) return false;
    const user = this.user(userId);
    if (!user || user.authorization_generation !== generation || user.password_changed_at !== passwordStamp) return false;
    if (key === undefined) return true;
    const digest = this.keyBindings.get(key);
    if (!digest || key.id !== userId) return false;
    return !!this.db.prepare('SELECT 1 FROM api_keys WHERE id=? AND user_id=? AND is_active=1 AND key_digest=?')
      .get(key.api_key_id, userId, digest);
  }
}
