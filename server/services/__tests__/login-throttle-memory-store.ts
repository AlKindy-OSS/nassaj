/**
 * In-memory login_throttle store for route tests that mock the database barrel
 * (T-2035). Same contract as loginThrottleDb; `rows` is exposed for assertions.
 */

import type { LoginThrottleRow } from '../../modules/database/repositories/login-throttle.db.js';

/** Builds a fresh store. */
export function createMemoryLoginThrottleStore() {
  const rows = new Map<string, LoginThrottleRow>();
  return {
    rows,
    get: (keyHash: string) => rows.get(keyHash),
    put: (row: LoginThrottleRow) => { rows.set(row.key_hash, { ...row }); },
    delete: (keyHash: string) => (rows.delete(keyHash) ? 1 : 0),
    pruneOlderThan: (cutoffMs: number) => {
      let removed = 0;
      for (const [key, row] of rows) {
        if (row.updated_at < cutoffMs) { rows.delete(key); removed += 1; }
      }
      return removed;
    },
    inTransaction: <T>(work: () => T): T => work(),
  };
}

/**
 * Configures the process-wide login throttle with a fresh in-memory store, for
 * tests whose auth middleware (the production configurer) is a double. Imports
 * the service lazily so it binds to any database mock registered before.
 */
export async function configureMemoryLoginThrottle() {
  const { configureLoginThrottle } = await import('../login-throttle.service.js');
  const store = createMemoryLoginThrottleStore();
  configureLoginThrottle('memory-login-throttle-test-secret-0123456789', store);
  return store;
}
