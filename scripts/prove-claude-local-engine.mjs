#!/usr/bin/env node
/**
 * Acceptance step for a Claude CLI version on the local-engine path (ADR-227,
 * T-2098 qa item 3). Runs the header-echo proof against the installed CLI through
 * the isolated test runner in release-gate mode (a skip fails), and on success
 * records the version in server/services/isolation/claude-local-proven-versions.json.
 * Commit that file to admit the version. Dummy credentials only; the CLI runs in
 * a loopback-only network namespace.
 *
 *   node scripts/prove-claude-local-engine.mjs [path-to-claude]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { recordProvenVersion } from '../server/services/isolation/claude-local-cli-proof.js';

import { evaluateProbeOutput } from './prove-claude-local-engine-lib.mjs';

const PROBE = 'server/services/isolation/claude-local-engine.header-echo.test.ts';

/** The CLI to prove: the argument, else `claude` on PATH. */
function claudeBinary() {
  if (process.argv[2]) return fs.realpathSync(process.argv[2]);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'claude');
    if (dir && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  throw new Error('claude CLI not found on PATH');
}

const bin = claudeBinary();
const versionOut = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).stdout ?? '';
const version = /(\d+\.\d+\.\d+)/u.exec(versionOut)?.[1];
if (!version) {
  console.error('prove-claude-local-engine: cannot read the CLI version');
  process.exit(2);
}
const run = spawnSync(process.execPath, ['scripts/run-isolated-node-tests.mjs', 'server', PROBE], {
  encoding: 'utf8',
  env: { ...process.env, TMPDIR: process.env.TMPDIR || '/var/tmp', NASSAJ_TEST_RELEASE_GATE: '1', NASSAJ_TEST_CLAUDE_BIN: bin },
  timeout: 15 * 60_000,
});
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
const verdict = evaluateProbeOutput(output, run.status);
if (!verdict.proven) {
  process.stdout.write(output);
  console.error(`prove-claude-local-engine: claude ${version} NOT proven`);
  process.exit(1);
}
recordProvenVersion(version, { probe: path.basename(PROBE), pass: verdict.pass });
console.log(`prove-claude-local-engine: claude ${version} proven (${verdict.pass} header-echo cases)`);
