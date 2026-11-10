/**
 * test-home-guard — B-1771 fail-fast for test processes that kept the real
 * account's HOME.
 *
 * On 2026-11-09 a server test started ad hoc (outside run-isolated-node-tests.mjs)
 * resolved os.homedir() to the operator's home and replaced a member's live
 * Claude login with a fixture. The roots every member credential lives under
 * (the member tree root and the provider-secrets store) call
 * assertNotRealHomeUnderTest() before resolving: under the node test runner,
 * a HOME that is the real account's home throws instead of resolving.
 *
 * Inert in production: it acts only when the process runs under `node --test`
 * (NODE_TEST_CONTEXT or a --test flag) or its entry file is a `*.test.*` file. The real home is the passwd entry, not
 * $HOME; NASSAJ_TEST_REAL_HOME may name it instead so this guard can be tested
 * (and a decoy audit can be run) without touching the real home.
 * Dependency-free: imported by low-level path resolvers.
 */
import os from 'os';
import path from 'path';

/** Entry files that are test files (`node x.test.mjs` runs node:test without --test). */
const TEST_ENTRY_FILE = /\.test\.[cm]?[jt]sx?$/u;

/**
 * True when this process is a node:test run: under `node --test`, or started
 * directly on a `*.test.*` entry file.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {readonly string[]} [execArgv]
 * @param {readonly string[]} [argv]
 * @returns {boolean}
 */
export function isUnderTestRunner(env = process.env, execArgv = process.execArgv, argv = process.argv) {
  return Boolean(env.NODE_TEST_CONTEXT)
    || execArgv.some((flag) => flag === '--test' || flag.startsWith('--test='))
    || TEST_ENTRY_FILE.test(argv[1] ?? '');
}

/** The real account home: NASSAJ_TEST_REAL_HOME, else the passwd entry; null when unknown. */
function realAccountHome(env) {
  if (env.NASSAJ_TEST_REAL_HOME) return path.resolve(env.NASSAJ_TEST_REAL_HOME);
  try {
    return path.resolve(os.userInfo().homedir);
  } catch {
    return null;
  }
}

/**
 * Throws when a test process would resolve credential roots inside the real
 * account's home. No-op outside a test runner.
 * @param {{ env?: NodeJS.ProcessEnv, execArgv?: readonly string[], argv?: readonly string[] }} [context]
 */
export function assertNotRealHomeUnderTest({ env = process.env, execArgv = process.execArgv, argv = process.argv } = {}) {
  if (!isUnderTestRunner(env, execArgv, argv)) return;
  const realHome = realAccountHome(env);
  if (realHome && path.resolve(os.homedir()) === realHome) {
    throw new Error('B-1771: a test process resolved credential roots in the real account home; '
      + "import '@/shared/__tests__/sandbox-home.js' first or run through scripts/run-isolated-node-tests.mjs");
  }
}
