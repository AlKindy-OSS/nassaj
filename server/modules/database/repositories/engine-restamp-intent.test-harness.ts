import { getConnection } from '@/modules/database/connection.js';
import { ENGINE_RESTAMP_INTENT_PREFIX } from '@/modules/database/repositories/app-config-reserved.js';
import { engineRestampIntentKey } from '@/modules/database/repositories/engine-restamp-intent.db.js';

/** Inserts deliberately malformed intent storage for repository boundary tests only. */
export function insertRawEngineRestampIntentFixture(sessionId: string, value: string | Buffer): void {
  getConnection().prepare('INSERT INTO app_config(key,value) VALUES (?,?)')
    .run(engineRestampIntentKey(sessionId), value);
}

/** Inserts one exact reserved key to exercise duplicate-session recovery rejection. */
export function insertRawEngineRestampIntentKeyFixture(keySuffix: string, value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(keySuffix)) throw new Error('fixture reserved key invalid');
  getConnection().prepare('INSERT INTO app_config(key,value) VALUES (?,?)')
    .run(`${ENGINE_RESTAMP_INTENT_PREFIX}${keySuffix}`, value);
}

/** Seeds the reserved namespace without bypassing production repository exports. */
export function seedRawEngineRestampIntentFixtures(count: number): void {
  const db = getConnection();
  const insert = db.prepare('INSERT INTO app_config(key,value) VALUES (?,?)');
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(`${ENGINE_RESTAMP_INTENT_PREFIX}${index.toString(16).padStart(64, '0')}`, '{}');
    }
  }).immediate();
}

/** Clears only test-seeded reserved rows between isolated recovery scan cases. */
export function clearRawEngineRestampIntentFixtures(): void {
  getConnection().prepare('DELETE FROM app_config WHERE key >= ? AND key < ?')
    .run(ENGINE_RESTAMP_INTENT_PREFIX, `${ENGINE_RESTAMP_INTENT_PREFIX}\uffff`);
}
