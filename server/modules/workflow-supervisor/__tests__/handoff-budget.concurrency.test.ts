/**
 * T-823 condition 6 — the budget counter is race-safe under REAL concurrency.
 * The prior design read-modify-wrote a single total file; two concurrent
 * deliveries could each read the same total and one overwrite the other's
 * increment (qa-critic البؤرة 5: "لضاعت زيادات العدّاد ⇒ نقص عدّ"). The append-only
 * delta log fixes this: each recordSpend is one atomic O_APPEND, so no increment
 * is ever lost.
 *
 * PROOF: spawn N independent OS processes (the real cross-process concurrency the
 * supervisor would exhibit if delivery were ever parallelized), each appending M
 * deltas to the SAME (user,day) counter, then assert the summed total is EXACTLY
 * N*M — no loss. This test FAILS on the old RMW design and PASSES on append-only.
 * Uses the SHIPPED recordSpend/readSpend (via tsx), not a reimplementation.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { readSpend } from '@/modules/workflow-supervisor/handoff-budget.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.resolve(TEST_DIR, '..'); // workflow-supervisor/
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..'); // repo root
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const TSCONFIG = path.join(REPO_ROOT, 'server', 'tsconfig.json');
const BUDGET_MODULE = path.join(MODULE_DIR, 'handoff-budget.ts');

const NOW = Date.parse('2026-07-10T12:00:00Z');
const TOKENS_PER = 3;

/** A tiny worker: import the SHIPPED recordSpend and append M deltas for user 1. */
const WORKER_SRC = `
const mod = process.env.BUDGET_MODULE;
const { recordSpend } = await import(mod);
const m = Number(process.env.M);
const now = Number(process.env.NOW);
for (let i = 0; i < m; i++) {
  recordSpend(process.env, { userId: 1, conversationId: 'cc', tokens: ${TOKENS_PER} }, now);
}
`;

function runWorker(workerPath: string, root: string, m: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, ['--tsconfig', TSCONFIG, workerPath], {
      env: {
        ...process.env,
        BUDGET_MODULE,
        WORKFLOW_SUPERVISOR_STATE_DIR: root,
        M: String(m),
        NOW: String(NOW),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`worker exit ${String(code)}: ${err.slice(0, 400)}`)),
    );
  });
}

test('N concurrent processes each append M deltas ⇒ EXACT sum, zero lost increments', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 't823-bud-conc-'));
  const workerPath = path.join(root, 'worker.mts');
  const N = 8;
  const M = 40;
  try {
    await writeFile(workerPath, WORKER_SRC, 'utf8');
    // Launch all N at once so their append loops overlap (the race window).
    await Promise.all(Array.from({ length: N }, () => runWorker(workerPath, root, M)));

    const readEnv: NodeJS.ProcessEnv = { ...process.env, WORKFLOW_SUPERVISOR_STATE_DIR: root };
    const userSpend = readSpend(readEnv, 'user', 1, NOW);
    assert.equal(userSpend.turns, N * M, `expected ${N * M} turns, got ${userSpend.turns}`);
    assert.equal(
      userSpend.tokens,
      N * M * TOKENS_PER,
      `expected ${N * M * TOKENS_PER} tokens, got ${userSpend.tokens} (a shortfall = lost increments = the RMW race)`,
    );
    // The conversation counter accumulated the same set independently.
    const convSpend = readSpend(readEnv, 'conv', 'cc', NOW);
    assert.equal(convSpend.turns, N * M);
    assert.equal(convSpend.tokens, N * M * TOKENS_PER);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
