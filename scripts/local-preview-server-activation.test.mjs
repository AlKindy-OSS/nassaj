import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  exchangePreviousGeneration,
  installExactCandidate,
  runRollbackRestart,
  waitForLoadedBuildId,
  waitForRestartOrReadiness,
} from './local-preview-server-activation.mjs';
import {
  prepareActivationTransaction,
  transitionActivationTransaction,
} from '../server/services/local-preview-server-control.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const CONTROL_FILES = new Map([
  ['scripts/local-preview-server-activation.mjs', 'activation-control'],
  ['scripts/local-preview-ledger.mjs', 'ledger-control'],
  ['scripts/safe-restart.sh', 'restart-control'],
]);

function inputManifest(contents) {
  const inputs = [
    { path: 'server/modules/projects/services/base.ts', sha256: contents.repeat(64) },
    ...[...CONTROL_FILES].map(([file, value]) => ({
      path: file, sha256: crypto.createHash('sha256').update(value).digest('hex'),
    })),
  ];
  const digest = crypto.createHash('sha256');
  for (const entry of [...inputs].sort((left, right) => left.path.localeCompare(right.path))) {
    digest.update(entry.path).update('\0').update(entry.sha256).update('\0');
  }
  return { schemaVersion: 1, buildId: digest.digest('hex'), inputs };
}

function artifact(directory, manifest) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', buildId: manifest.buildId }));
  fs.writeFileSync(path.join(directory, 'SERVER_INPUT_MANIFEST.json'), JSON.stringify(manifest));
  for (const [file, contents] of CONTROL_FILES) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), contents);
  }
}

function simulateAtomicExchange(command, args) {
  // Test double only: production keeps using fail-closed kernel exchange.
  assert.equal(command, 'mv');
  assert.deepEqual(args.slice(0, 3), ['--exchange', '--no-copy', '-T']);
  const [left, right] = args.slice(3);
  const temporary = `${left}.test-exchange`;
  fs.renameSync(left, temporary);
  fs.renameSync(right, left);
  fs.renameSync(temporary, right);
  return { status: 0, stdout: '', stderr: '' };
}

test('readiness requires the exact expected loaded build id', async () => {
  let calls = 0;
  const ready = await waitForLoadedBuildId(B, {
    timeoutMs: 100,
    intervalMs: 1,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: 'ok', serverLoadedBuildId: ++calls > 1 ? B : A }),
    }),
  });
  assert.equal(ready, true);
  assert.ok(calls >= 2);

  assert.equal(await waitForLoadedBuildId(B, {
    timeoutMs: 5,
    intervalMs: 1,
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok', serverLoadedBuildId: A }) }),
  }), false);
});

test('delayed autorestart readiness wins after two seconds without restart_spawned', async () => {
  let clock = 0;
  let probes = 0;
  const transaction = { expectedServerBuildId: B, state: 'candidate_installed' };
  const result = await waitForRestartOrReadiness(B, {
    timeoutMs: 10_000,
    intervalMs: 1_000,
    now: () => clock,
    delay: async (ms) => { clock += ms; },
    readTransaction: () => transaction,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: 'ok', serverLoadedBuildId: ++probes >= 4 ? B : A }),
    }),
  });
  assert.deepEqual(result, { kind: 'ready' });
  assert.equal(clock, 3_000, 'readiness arrived after the old two-second blind boundary');
});

test('candidate-installed race times out only when neither readiness nor restart state arrives', async () => {
  let clock = 0;
  const transaction = { expectedServerBuildId: B, state: 'candidate_installed' };
  const result = await waitForRestartOrReadiness(B, {
    timeoutMs: 3_000,
    intervalMs: 1_000,
    now: () => clock,
    delay: async (ms) => { clock += ms; },
    readTransaction: () => transaction,
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok', serverLoadedBuildId: A }) }),
  });
  assert.equal(result.kind, 'timeout');
  assert.equal(result.transaction, transaction);
});

test('candidate install uses activating slot, is crash-resumable, and restores keyed candidate on rollback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-runner-'));
  try {
    execFileSync('git', ['init', '--quiet', root]); // controls live in the common Git dir
    const loaded = inputManifest('a');
    const candidate = inputManifest('b');
    artifact(path.join(root, 'dist-server'), loaded);
    const candidateDir = path.join(root, '.nassaj-local-preview', 'server-candidates', candidate.buildId);
    artifact(candidateDir, candidate);
    fs.writeFileSync(path.join(root, '.git', 'nassaj-local-preview-ledger-v1.json'), JSON.stringify({
      schemaVersion: 1, serverSourceGeneration: 3, serverState: 'built',
      serverSourceBuildId: candidate.buildId, serverCandidateBuildId: candidate.buildId,
      serverPromotedBuildId: loaded.buildId, serverLoadedBuildId: loaded.buildId,
    }));
    prepareActivationTransaction({
      allowed: true, expectedServerBuildId: candidate.buildId, loadedBuildId: loaded.buildId, generation: 3,
    }, 'runner-test', root);
    assert.equal(installExactCandidate(root, simulateAtomicExchange), 'installed');
    assert.equal(installExactCandidate(root, simulateAtomicExchange), 'already_installed');
    assert.equal(fs.existsSync(candidateDir), false, 'candidate store must never contain A under B key');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), 'utf8')).buildId, candidate.buildId);
    transitionActivationTransaction(candidate.buildId, ['prepared'], { state: 'rolling_back' }, root);

    assert.equal(exchangePreviousGeneration(root, simulateAtomicExchange), 'exchanged');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), 'utf8')).buildId, loaded.buildId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(candidateDir, 'BUILD_PROVENANCE.json'), 'utf8')).buildId, candidate.buildId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate install fails closed when atomic exchange is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-no-exchange-'));
  try {
    execFileSync('git', ['init', '--quiet', root]); // controls live in the common Git dir
    const loaded = inputManifest('a');
    const candidate = inputManifest('b');
    artifact(path.join(root, 'dist-server'), loaded);
    const candidateDir = path.join(root, '.nassaj-local-preview', 'server-candidates', candidate.buildId);
    artifact(candidateDir, candidate);
    fs.writeFileSync(path.join(root, '.git', 'nassaj-local-preview-ledger-v1.json'), JSON.stringify({
      schemaVersion: 1, serverSourceGeneration: 3, serverState: 'built',
      serverSourceBuildId: candidate.buildId, serverCandidateBuildId: candidate.buildId,
      serverPromotedBuildId: loaded.buildId, serverLoadedBuildId: loaded.buildId,
    }));
    prepareActivationTransaction({
      allowed: true, expectedServerBuildId: candidate.buildId, loadedBuildId: loaded.buildId, generation: 3,
    }, 'unsupported-exchange-test', root);

    assert.throws(
      () => installExactCandidate(root, () => ({ status: 1, stderr: 'mv: unrecognized option --exchange' })),
      /candidate_atomic_install_failed/,
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), 'utf8')).buildId, loaded.buildId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate install rejects a symlinked activating parent before moving the candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-symlink-'));
  try {
    execFileSync('git', ['init', '--quiet', root]); // controls live in the common Git dir
    const loaded = inputManifest('a');
    const candidate = inputManifest('b');
    artifact(path.join(root, 'dist-server'), loaded);
    const candidateDir = path.join(root, '.nassaj-local-preview', 'server-candidates', candidate.buildId);
    artifact(candidateDir, candidate);
    fs.mkdirSync(path.join(root, 'outside'));
    fs.symlinkSync(path.join(root, 'outside'), path.join(root, '.nassaj-local-preview', 'server-activating'));
    fs.writeFileSync(path.join(root, '.git', 'nassaj-local-preview-ledger-v1.json'), JSON.stringify({
      schemaVersion: 1, serverSourceGeneration: 3, serverState: 'built',
      serverSourceBuildId: candidate.buildId, serverCandidateBuildId: candidate.buildId,
      serverPromotedBuildId: loaded.buildId, serverLoadedBuildId: loaded.buildId,
    }));
    prepareActivationTransaction({
      allowed: true, expectedServerBuildId: candidate.buildId, loadedBuildId: loaded.buildId, generation: 3,
    }, 'symlink-test', root);
    assert.throws(() => installExactCandidate(root), /candidate_exchange_path_not_regular/);
    assert.equal(fs.existsSync(candidateDir), true, 'candidate must remain keyed after fail-closed rejection');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rc4 automatically selects the fixed, QA-gated rollback recovery argv', () => {
  const calls = [];
  const statuses = [4, 0];
  const run = (cmd, args) => { calls.push([cmd, args]); return { status: statuses.shift() }; };
  assert.equal(runRollbackRestart(run).status, 0);
  assert.deepEqual(calls, [
    ['bash', ['dist-server/scripts/safe-restart.sh', '--exec']],
    ['bash', ['dist-server/scripts/safe-restart.sh', '--rollback-recovery', '--exec']],
  ]);
});
