/**
 * dsh-pipeline.real.test — T-2091 S4 against the REAL dsh: the offline contract suite on a
 * real install, and (opt-in, network) the whole pipeline installing a real candidate.
 *   NASSAJ_TEST_DSH_LIVE_BIN=<fresh /var/tmp install>/node_modules/@deepseek-ai/dsh/lib/bin.js  → contract suite
 *   + NASSAJ_TEST_DSH_PIPELINE_REAL=1 → npm install of that version into a fresh /var/tmp root, contract, switch
 * Rerun on every dsh bump (bump checklist in descriptors.ts).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveDshNode } from '../../list/dsh/dsh-launch.js';

import { installDshCandidate } from './dsh-candidate-install.js';
import { runDshContractSuite } from './dsh-contract-run.js';
import { auditSignatures, registryPublishedAt } from './dsh-pipeline-update.js';
import { createDshUpdatePipeline } from './dsh-update-pipeline.js';
import { DSH_NPM_LOCK_SOURCE, isReviewedVersion, loadReviewedPin } from './pins.js';

const BIN = process.env.NASSAJ_TEST_DSH_LIVE_BIN ?? '';
const SKIP = BIN ? false : 'set NASSAJ_TEST_DSH_LIVE_BIN to a real dsh lib/bin.js (fresh /var/tmp install)';
const FULL = process.env.NASSAJ_TEST_DSH_PIPELINE_REAL === '1' ? false : 'set NASSAJ_TEST_DSH_PIPELINE_REAL=1 (network: npm install)';
const installDir = BIN ? path.resolve(path.dirname(BIN), '..', '..', '..', '..') : '';
const version = BIN ? JSON.parse(fs.readFileSync(path.join(path.dirname(BIN), '..', 'package.json'), 'utf8')).version : '';
const scratch = fs.mkdtempSync(path.join(fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir(), 'nassaj-dsh-pipeline-real-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** A minimal runCommand (the harness-update one needs a job context). */
function runCommand(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv, cwd?: string, timeoutMs: number }) {
  return new Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>((resolve) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut: false }); });
  });
}

describe('T-2091 offline contract suite on real dsh', { skip: SKIP }, () => {
  it('the pinned version passes every check (P1–P4, mapped tools, conformance, security rows)', async () => {
    const work = fs.mkdtempSync(path.join(scratch, 'contract-'));
    const result = await runDshContractSuite({ version, dir: installDir }, { node: resolveDshNode(), workRoot: work });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.report?.changedRows, ['llm-deepseek']);
    // 16 mapped tools + the subagent's own bash call reached Nassaj's decision.
    assert.ok(Number(result.report?.decisions) >= 17, JSON.stringify(result.report));
  });
});

describe('T-2091 the whole pipeline on a real candidate (network)', { skip: SKIP || FULL }, () => {
  it('installs the exact version, passes the contract, switches atomically and records a reviewed result', async () => {
    const home = fs.mkdtempSync(path.join(scratch, 'home-'));
    const source = { ...DSH_NPM_LOCK_SOURCE, reviewedPins: [], installRoot: () => path.join(home, 'dsh'), launcher: () => path.join(home, 'bin', 'dsh') };
    const node = resolveDshNode();
    const pipeline = createDshUpdatePipeline({ root: source.installRoot(), activeLink: source.launcher(), binRel: source.binRel,
      freeBytes: (dir) => { const st = fs.statfsSync(dir); return st.bavail * st.bsize; },
      install: (job) => installDshCandidate(job, { node, runCommand, buildEnv: () => ({ PATH: '/usr/bin:/bin' }) }),
      contractSuite: (job) => runDshContractSuite(job, { node, workRoot: path.dirname(job.dir) }),
      publishedAt: (v) => registryPublishedAt(source as never, { runCommand, buildEnv: () => ({ PATH: '/usr/bin:/bin' }), home } as never, v),
      verifySignatures: (job) => auditSignatures(node, { runCommand, buildEnv: () => ({ PATH: '/usr/bin:/bin' }) } as never, job.dir) });
    const result = await pipeline.run({ version });
    assert.equal(result.status, 'green', JSON.stringify(result));
    assert.equal(fs.readlinkSync(source.launcher()), path.join(source.installRoot(), 'versions', version, source.binRel));
    assert.equal(await pipeline.verifyActive(), null);
    assert.equal(isReviewedVersion(source as never, home, version), true);
    assert.equal(loadReviewedPin(source as never, home, version).manifest.version, version);
    assert.deepEqual(fs.readdirSync(path.join(source.installRoot(), 'staging')), [], 'staging is removed');
  });
});
