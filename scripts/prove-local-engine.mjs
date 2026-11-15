#!/usr/bin/env node
/**
 * Acceptance step for a body's CLI version on the local-engine path (ADR-227,
 * T-2098 qa item 3; T-2107 for Codex; T-2108 for DSH, through its corrector, the real
 * acp profile and policy plugin). Runs the body's header-echo proof against
 * the installed CLI through the isolated test runner in release-gate mode (a skip
 * fails), and on success records the version in that body's committed registry
 * (server/services/isolation/<body>-local-proven-versions.json). Commit that file
 * to admit the version. Dummy credentials only; the CLI runs in a loopback-only
 * network namespace.
 *
 *   node scripts/prove-local-engine.mjs [claude|codex] [path-to-cli]
 *   node scripts/prove-local-engine.mjs dsh <path-to-dsh-lib/bin.js>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { provenVersionsFile, recordProvenVersion } from '../server/services/isolation/claude-local-cli-proof.js';

import { evaluateProbeOutput } from './prove-local-engine-lib.mjs';

/** Per body: the CLI name, its header-echo proof, the env knob the proof reads the binary from. */
const BODIES = Object.freeze({
  claude: { cli: 'claude', probe: 'server/services/isolation/claude-local-engine.header-echo.test.ts', binEnv: 'NASSAJ_TEST_CLAUDE_BIN' },
  codex: { cli: 'codex', probe: 'server/services/isolation/codex-local-engine.header-echo.test.ts', binEnv: 'NASSAJ_TEST_CODEX_BIN' },
  // dsh is a node script inside its package: the version is its package.json's (a prerelease tag included).
  dsh: { cli: 'dsh', probe: 'server/services/isolation/dsh-local-engine.header-echo.test.ts', binEnv: 'NASSAJ_TEST_DSH_BIN',
    version: (bin) => JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(bin)), 'package.json'), 'utf8')).version },
});

/** The CLI's version: the body's own reader, else `<cli> --version`. */
function cliVersion(spec, bin) {
  if (spec.version) return spec.version(bin);
  const out = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).stdout ?? '';
  return /(\d+\.\d+\.\d+)/u.exec(out)?.[1];
}

/** The CLI to prove: the argument, else the body's CLI on PATH. */
function cliBinary(name, argument) {
  if (argument) return fs.realpathSync(argument);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (dir && fs.existsSync(candidate)) return fs.realpathSync(candidate);
  }
  throw new Error(`${name} CLI not found on PATH`);
}

const [first, second] = process.argv.slice(2);
const bodyName = Object.hasOwn(BODIES, first ?? '') ? first : 'claude';
const body = BODIES[bodyName];
const bin = cliBinary(body.cli, bodyName === first ? second : first);
const version = cliVersion(body, bin);
if (!version) {
  console.error(`prove-local-engine: cannot read the ${bodyName} CLI version`);
  process.exit(2);
}
const run = spawnSync(process.execPath, ['scripts/run-isolated-node-tests.mjs', 'server', body.probe], {
  encoding: 'utf8',
  env: { ...process.env, TMPDIR: process.env.TMPDIR || '/var/tmp', NASSAJ_TEST_RELEASE_GATE: '1', [body.binEnv]: bin },
  timeout: 15 * 60_000,
});
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
const verdict = evaluateProbeOutput(output, run.status);
if (!verdict.proven) {
  process.stdout.write(output);
  console.error(`prove-local-engine: ${bodyName} ${version} NOT proven`);
  process.exit(1);
}
recordProvenVersion(version, { probe: path.basename(body.probe), pass: verdict.pass }, provenVersionsFile(bodyName));
console.log(`prove-local-engine: ${bodyName} ${version} proven (${verdict.pass} header-echo cases)`);
