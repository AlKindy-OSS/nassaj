/**
 * ADR-227 Consequences / T-2098 qa item 3 — credential behaviour is CLI-version
 * dependent, so a local Claude run is admitted only on a Claude CLI version whose
 * header-echo proof passed. The proof is a runnable acceptance step
 * (scripts/prove-local-engine.mjs) that records the version; in release-gate
 * mode a skipped header-echo counts as failure.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { evaluateProbeOutput } from '../../../scripts/prove-local-engine-lib.mjs';

import { applyClaudeLocalEngineEnv } from './apply-claude-local-engine-env.js';
import {
  isClaudeLocalVersionProven, isLocalCliVersionProven, provenVersionsFile, readProvenVersions, recordProvenVersion,
} from './claude-local-cli-proof.js';

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't2098-proof-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a version is proven only after it is recorded; null and unknown are not', () => {
  const file = path.join(root, 'proven.json');
  assert.equal(isClaudeLocalVersionProven('2.1.312', file), false);
  assert.equal(isClaudeLocalVersionProven(null, file), false);
  recordProvenVersion('2.1.312', { pass: 7, probe: 'header-echo' }, file);
  assert.equal(isClaudeLocalVersionProven('2.1.312', file), true);
  assert.equal(isClaudeLocalVersionProven('2.1.313', file), false);
  assert.equal(readProvenVersions(file)['2.1.312'].pass, 7);
  fs.writeFileSync(file, '{not json');
  assert.equal(isClaudeLocalVersionProven('2.1.312', file), false, 'a corrupt registry proves nothing');
});

test('the shipped registry lists only well-formed versions and admits the proven 2.1.312', () => {
  for (const version of Object.keys(readProvenVersions())) assert.match(version, /^\d+\.\d+\.\d+$/u);
  assert.equal(isClaudeLocalVersionProven('2.1.312'), true);
});

const SERVER = {
  id: '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11', ownerId: 7, providerId: 'nassaj_local_0b9c6a3e6f1e4c419a4e2f1b9e0c7d11',
  baseUrl: 'http://192.168.8.137:8080/v1', verifiedAddresses: ['192.168.8.137'],
  models: [{ id: 'gpt-oss-20b', contextWindow: 32768 }],
};
const deps = (proven: boolean) => ({
  enabled: () => true, runnable: () => true, listServers: () => [SERVER], getSecret: () => null,
  resolvePrivate: async () => ({ address: '192.168.8.137', family: 4 }),
  cliVersionProven: async () => proven,
});

test('an unproven installed Claude CLI refuses the local spawn, env untouched', async () => {
  const env: NodeJS.ProcessEnv = { KEEP: '1' };
  const verdict = await applyClaudeLocalEngineEnv(env, { userId: 7, requestedModel: `${SERVER.providerId}/gpt-oss-20b` }, deps(false));
  assert.deepEqual(verdict, { status: 'unavailable', provider: 'local', reason: 'cli_version_unproven' });
  assert.deepEqual(env, { KEEP: '1' });
  const ok = await applyClaudeLocalEngineEnv({}, { userId: 7, requestedModel: `${SERVER.providerId}/gpt-oss-20b` }, deps(true));
  assert.equal(ok.status, 'applied');
});

test('probe output: only a clean, non-skipped, passing run proves a version', () => {
  const run = (pass: number, fail: number, skipped: number) => `ℹ tests ${pass + fail + skipped}\nℹ pass ${pass}\nℹ fail ${fail}\nℹ skipped ${skipped}\n`;
  assert.deepEqual(evaluateProbeOutput(run(5, 0, 0), 0), { proven: true, pass: 5 });
  assert.equal(evaluateProbeOutput(run(4, 0, 1), 0).proven, false);
  assert.equal(evaluateProbeOutput(run(4, 1, 0), 1).proven, false);
  assert.equal(evaluateProbeOutput(run(0, 0, 0), 0).proven, false);
  assert.equal(evaluateProbeOutput('garbage', 0).proven, false);
  assert.equal(evaluateProbeOutput(run(5, 0, 0), 1).proven, false, 'a non-zero exit never proves');
});

test('release-gate mode turns a header-echo SKIP into a failure', () => {
  const file = 'server/services/isolation/claude-local-engine.header-echo.test.ts';
  const base = { ...process.env, PATH: path.dirname(process.execPath) };
  delete base.NASSAJ_TEST_CLAUDE_BIN;
  // Inside node:test a child `--test` run reports to the parent and exits 0; detach it.
  delete base.NODE_TEST_CONTEXT;
  const run = (gate: boolean) => spawnSync(process.execPath, ['--import', 'tsx', '--test', file], {
    env: { ...base, ...(gate ? { NASSAJ_TEST_RELEASE_GATE: '1' } : {}) }, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(run(false).status, 0, 'without the gate a missing CLI is a skip');
  const gated = run(true);
  assert.notEqual(gated.status, 0, 'with the gate a missing CLI fails');
  assert.match(gated.stdout, /release gate/u);
});

test('T-2107: the Codex registry is separate and admits the proven codex-cli 0.166.0 only', () => {
  const file = path.join(root, 'codex-proven.json');
  recordProvenVersion('0.166.0', { pass: 6, probe: 'codex-header-echo' }, file);
  assert.equal(isLocalCliVersionProven('codex', '0.166.0', file), true);
  assert.equal(isLocalCliVersionProven('codex', '0.166.1', file), false);
  assert.equal(isLocalCliVersionProven('codex', '0.166.0'), true, 'shipped Codex registry');
  assert.equal(isLocalCliVersionProven('claude', '0.166.0'), false, 'a Codex version never admits Claude');
  assert.equal(isLocalCliVersionProven('codex', '2.1.312'), false, 'a Claude version never admits Codex');
  assert.throws(() => provenVersionsFile('agy'));
});
