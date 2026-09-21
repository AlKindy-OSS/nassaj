#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const temporaryParent = process.env.NASSAJ_TEST_TEMP_ROOT || process.env.RUNNER_TEMP || os.tmpdir();
const runRoot = mkdtempSync(path.join(temporaryParent, `nassaj-${scope}-tests-`));
let failed = false;

try {
  for (const [index, file] of files.entries()) {
    const caseRoot = mkdtempSync(path.join(runRoot, 'case-'));
    console.log(`## test:${scope}:${index + 1}/${files.length}:${file}`);
    const env = {
      ...process.env,
      DATABASE_PATH: path.join(caseRoot, 'auth.db'),
      TMPDIR: caseRoot,
    };
    delete env.CODEX_HOME;
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
    if (result.status !== 0) failed = true;
    rmSync(caseRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(runRoot, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
