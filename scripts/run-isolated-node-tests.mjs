#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scope = process.argv[2];
// One hung test file must fail fast instead of holding a release run open for hours.
const FILE_TIMEOUT_MS = Number(process.env.NASSAJ_TEST_FILE_TIMEOUT_MS || 10 * 60 * 1000);
if (!['server', 'src'].includes(scope)) {
  console.error('usage: run-isolated-node-tests.mjs <server|src>');
  process.exit(2);
}

const requestedFiles = process.argv.slice(3);
const patterns = scope === 'server'
  ? ['server/**/*.test.ts', 'server/**/*.test.js']
  : ['src/**/*.test.ts', 'src/**/*.test.tsx'];
const files = (requestedFiles.length > 0 ? requestedFiles : globSync(patterns)).sort().filter(file => (
  scope === 'server' || /from\s+['"]node:test['"]/.test(readFileSync(file, 'utf8'))
));

if (files.length === 0) {
  console.log(`test:${scope}: no node:test files`);
  process.exit(0);
}

// Provider/XDG roots that point at real operator state; unset so each resolver
// falls back to the case-local HOME below (B-1420, extends the CODEX_HOME rule).
const INHERITED_STATE_ROOT_KEYS = [
  'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'QWEN_HOME', 'KIMI_SHARE_DIR', 'HERMES_HOME', 'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'WORKSPACES_ROOT', 'WORKFLOW_SUPERVISOR_STATE_DIR',
];

/**
 * Every inherited NASSAJ_* variable may name a live root (repo, deploy, governance,
 * connector keys...), so all are dropped except test knobs (NASSAJ_TEST_*); the
 * runner re-adds the ones it owns per case.
 */
function stripInheritedStateRoots(env) {
  for (const key of INHERITED_STATE_ROOT_KEYS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('NASSAJ_') && !key.startsWith('NASSAJ_TEST_')) delete env[key];
  }
  return env;
}

const temporaryParent = process.env.NASSAJ_TEST_TEMP_ROOT || process.env.RUNNER_TEMP || os.tmpdir();
const runRoot = mkdtempSync(path.join(temporaryParent, `nassaj-${scope}-tests-`));
let failed = false;

try {
  for (const [index, file] of files.entries()) {
    const caseRoot = mkdtempSync(path.join(runRoot, 'case-'));
    // HOME and TMPDIR are disjoint siblings, as on a real host: tests assert that
    // home-derived paths stay out of os.tmpdir() and that tmp paths are not in HOME.
    const caseHome = path.join(caseRoot, 'home');
    const caseTmp = path.join(caseRoot, 'tmp');
    mkdirSync(caseHome, { mode: 0o700 });
    mkdirSync(caseTmp, { mode: 0o700 });
    console.log(`## test:${scope}:${index + 1}/${files.length}:${file}`);
    const env = {
      ...stripInheritedStateRoots({ ...process.env }),
      DATABASE_PATH: path.join(caseRoot, 'auth.db'),
      TMPDIR: caseTmp,
      // T-1871: harness snapshots, spawn ledger and ack key stay inside the case.
      NASSAJ_HARNESS_DATA_HOME: caseRoot,
      // B-1420: every provider home, the per-user root (~/.nassaj-users) and the
      // vendor transcript root derive from HOME/CLAUDE_CONFIG_DIR. Inheriting the
      // operator's values let fixtures write into trees the live server watches,
      // which then registered case dirs as projects in the server database.
      HOME: caseHome,
      USERPROFILE: caseHome,
      CLAUDE_CONFIG_DIR: path.join(caseHome, '.claude'),
      // The workspace validator defaults to HOME; fixtures create project dirs under
      // the repo checkout, so the checkout (not the operator home) is the root.
      WORKSPACES_ROOT: process.cwd(),
      // git would otherwise lose the identity it read from the real ~/.gitconfig.
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'nassaj-test',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'nassaj-test@localhost',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'nassaj-test',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'nassaj-test@localhost',
    };
    if (scope === 'server') env.TSX_TSCONFIG_PATH = path.resolve('server/tsconfig.json');

    // This fixture owns a stricter HOME/JWT/disk setup and its existing 45-second child deadline.
    const args = file === 'server/modules/providers/tests/memory-budget-full-router.test.ts'
      ? [path.resolve('tests/helpers/memory-c0-full-router-runner.mjs')]
      : [
      '--import', 'tsx',
      '--experimental-test-module-mocks',
      '--test-force-exit',
      '--test', file,
    ];
    const result = spawnSync(process.execPath, args, { env, stdio: 'inherit', timeout: FILE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (result.error?.code === 'ETIMEDOUT' || result.signal) {
      console.error(`## test file ${file} exceeded ${FILE_TIMEOUT_MS}ms or died by ${result.signal ?? 'timeout'}`);
    }
    // B-1436: one exit line per file, at line start on stdout, so the release gate
    // names a file that failed without any `not ok` (a crash on import, a hook).
    console.log(`## test file ${file} exited ${result.status ?? result.signal ?? 'unknown'}`);
    if (result.status !== 0) failed = true;
    rmSync(caseRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(runRoot, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
