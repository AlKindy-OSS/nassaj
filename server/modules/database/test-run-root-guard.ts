import path from 'node:path';

import { getDatabasePath } from './connection.js';

/**
 * B-1420: scripts/run-isolated-node-tests.mjs creates one run root per suite
 * (`<tmp>/nassaj-server-tests-XXXXXX`, `<tmp>/nassaj-src-tests-XXXXXX`) and a
 * `case-*` directory per test file. Such a path is only a legitimate project
 * for a database that lives inside the SAME run root (the test's own DB); any
 * other database — the live app DB above all — must never register it.
 */
const TEST_RUN_ROOT_SEGMENT = /^nassaj-(?:server|src)-tests-[^/\\]+$/;

/** Returns the enclosing test run root of `candidate`, or null when it has none. */
function findTestRunRoot(candidate: string): string | null {
  const segments = path.resolve(candidate).split(path.sep);
  const index = segments.findIndex(segment => TEST_RUN_ROOT_SEGMENT.test(segment));
  return index === -1 ? null : segments.slice(0, index + 1).join(path.sep);
}

/**
 * True when `projectPath` sits under a test run root that does not also contain
 * the active database, i.e. a test leaked a transcript into a real watched root.
 */
export function isForeignTestRunPath(
  projectPath: string,
  databasePath: string = getDatabasePath(),
): boolean {
  const runRoot = findTestRunRoot(projectPath);
  if (!runRoot) return false;
  const relative = path.relative(runRoot, path.resolve(databasePath));
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative);
}
