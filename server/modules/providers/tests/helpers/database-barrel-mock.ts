/**
 * Structural module mock for the database barrel (`@/modules/database/index.js`).
 *
 * WHY DERIVED AND NOT HAND-LISTED
 * ESM validates named imports structurally at instantiation time, so a
 * hand-maintained `namedExports` list rots silently: the day any transitively
 * imported service adds `import { newThing } from '@/modules/database/index.js'`,
 * every test that mocks the barrel dies with
 *   SyntaxError: ... does not provide an export named 'newThing'
 * even though production is perfectly fine. That is exactly how
 * `parseStoredTimestampMs` (added to session-conversations-search.service.ts)
 * broke the provider skills tests on 2026-07-26.
 *
 * So: load the REAL barrel once, take its export NAMES, stub them all, and let
 * the caller override only the handful it actually needs. New barrel exports are
 * then covered automatically.
 *
 * IS IMPORTING THE REAL BARREL SAFE?
 * Yes. `connection.ts` opens SQLite lazily inside `getConnection()`, and each
 * repository module only builds a singleton object at load time. Verified: the
 * import creates no database file and touches no filesystem state.
 *
 * FAIL-SAFE DEFAULTS
 * Every function export becomes a no-op returning `undefined`; every non-function
 * export becomes a permissive Proxy whose every property is a no-op function. A
 * newly added DB entry point therefore can never reach the real database from a
 * test — it degrades to an inert stub, never to live I/O.
 */

import { mock } from 'node:test';

/** Permissive stand-in for a repository singleton: any method access is a no-op. */
export const repositoryStub = (): Record<string, unknown> =>
  new Proxy({}, { get: () => () => undefined }) as Record<string, unknown>;

/**
 * Registers a complete mock of the database barrel.
 *
 * @param dbIndexUrl file:// URL of `modules/database/index.js` (as resolved from
 *                   the calling test, e.g. via `pathToFileURL(path.resolve(...))`).
 * @param overrides  exports that need real behaviour in this test. Keys must
 *                   exist on the real barrel — a typo or a renamed export throws
 *                   here instead of quietly doing nothing.
 * @returns the export names that were mocked (useful for assertions/debugging).
 */
export async function mockDatabaseBarrel(
  dbIndexUrl: string,
  overrides: Record<string, unknown> = {},
): Promise<string[]> {
  const real = (await import(dbIndexUrl)) as Record<string, unknown>;
  const realNames = Object.keys(real).filter((name) => name !== 'default');

  if (realNames.length === 0) {
    throw new Error(`mockDatabaseBarrel: no exports found on ${dbIndexUrl}`);
  }

  const unknownOverrides = Object.keys(overrides).filter((name) => !realNames.includes(name));
  if (unknownOverrides.length > 0) {
    throw new Error(
      `mockDatabaseBarrel: override(s) not exported by the barrel: ${unknownOverrides.join(', ')}`,
    );
  }

  const namedExports: Record<string, unknown> = {};
  for (const name of realNames) {
    namedExports[name] = typeof real[name] === 'function' ? () => undefined : repositoryStub();
  }
  Object.assign(namedExports, overrides);

  mock.module(dbIndexUrl, { namedExports });
  return Object.keys(namedExports);
}
