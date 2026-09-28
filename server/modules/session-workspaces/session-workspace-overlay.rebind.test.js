/**
 * Declared session handover at the overlay layer (agy spawn key -> brain UUID).
 * Locks qa M2: additive first (`to` alias + manifest, then ledger, then remove
 * `from`), reverting or failing closed on every failure, never leaving two live
 * aliases, and a crash at each step resolves to a fail-closed resume.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  bindSessionWorkspace,
  createSessionWorkspace,
  rebindSessionWorkspace,
  resolveSessionWorkspaceForLaunch,
} from './session-workspace-overlay.js';

const FROM = 'agy_1790531982349_26187fb5';
const TO = 'e70cd70d-8a4f-4694-9304-37f6e440249e';
const PRINCIPAL = '7';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const repo = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'overlay-rebind-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Rebind Test');
  git(repo, 'config', 'user.email', 'rebind@example.test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'chore: base');
  const launchKey = `launch-${crypto.randomUUID()}`;
  const created = createSessionWorkspace({ projectPath: repo, launchKey, principalId: PRINCIPAL });
  const bound = bindSessionWorkspace({ projectPath: repo, launchKey, sessionId: FROM, principalId: PRINCIPAL });
  const stateRoot = path.join(repo, '.git', 'nassaj-session-overlays');
  const aliasOf = (id) => path.join(stateRoot, 'aliases', 'session',
    `${crypto.createHash('sha256').update(id).digest('hex')}.json`);
  const cleanup = () => {
    git(repo, 'worktree', 'remove', '--force', created.cwd);
    fs.rmSync(repo, { recursive: true, force: true });
  };
  return { repo, launchKey, created, bound, aliasOf, stateRoot, cleanup };
}

const resume = (repo, sessionId) => resolveSessionWorkspaceForLaunch({
  projectPath: repo, sessionId, principalId: PRINCIPAL,
});

test('accepted rebind: `to` resumes the same overlay and generation, `from` is gone', () => {
  const f = fixture();
  try {
    let ledgerCalls = 0;
    const steps = [];
    const rebound = rebindSessionWorkspace({
      projectPath: f.repo, launchKey: f.launchKey, fromSessionId: FROM, toSessionId: TO,
      principalId: PRINCIPAL, commitLedger: () => { ledgerCalls += 1; }, onStep: (s) => steps.push(s),
    });
    assert.equal(ledgerCalls, 1);
    assert.deepEqual(steps, ['workspace_written', 'ledger_committed']);
    assert.equal(rebound.overlayId, f.bound.overlayId);
    assert.equal(rebound.generation, f.bound.generation);
    const resumed = resume(f.repo, TO);
    assert.equal(resumed.cwd, f.created.cwd);
    assert.equal(resumed.sessionId, TO);
    assert.equal(fs.existsSync(f.aliasOf(FROM)), false, 'the source alias is removed last');
    assert.throws(() => resume(f.repo, FROM), /no isolated workspace/);
  } finally {
    f.cleanup();
  }
});

test('ledger refusal reverts: `from` still resumes, `to` has no alias', () => {
  const f = fixture();
  try {
    assert.throws(() => rebindSessionWorkspace({
      projectPath: f.repo, launchKey: f.launchKey, fromSessionId: FROM, toSessionId: TO,
      principalId: PRINCIPAL, commitLedger: () => { throw new Error('ledger says no'); },
    }), /ledger says no/);
    assert.equal(resume(f.repo, FROM).cwd, f.created.cwd);
    assert.equal(fs.existsSync(f.aliasOf(TO)), false);
  } finally {
    f.cleanup();
  }
});

test('a target that already has an alias is refused before any write', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.dirname(f.aliasOf(TO)), { recursive: true });
    fs.writeFileSync(f.aliasOf(TO), '{"schema":1,"overlayId":"x"}');
    let ledgerCalls = 0;
    assert.throws(() => rebindSessionWorkspace({
      projectPath: f.repo, launchKey: f.launchKey, fromSessionId: FROM, toSessionId: TO,
      principalId: PRINCIPAL, commitLedger: () => { ledgerCalls += 1; },
    }), /already bound/);
    assert.equal(ledgerCalls, 0);
    assert.equal(resume(f.repo, FROM).cwd, f.created.cwd);
  } finally {
    f.cleanup();
  }
});

test('a foreign principal or another launch cannot rebind the overlay', () => {
  const f = fixture();
  try {
    const attempt = (overrides) => rebindSessionWorkspace({
      projectPath: f.repo, launchKey: f.launchKey, fromSessionId: FROM, toSessionId: TO,
      principalId: PRINCIPAL, commitLedger: () => {}, ...overrides,
    });
    assert.throws(() => attempt({ principalId: '8' }), /principal mismatch/);
    assert.throws(() => attempt({ launchKey: 'launch-other' }), /not this launch overlay/);
    assert.equal(resume(f.repo, FROM).cwd, f.created.cwd);
  } finally {
    f.cleanup();
  }
});

test('fault after step 1 (workspace written) reverts before the ledger is touched', () => {
  const f = fixture();
  try {
    let ledgerCalls = 0;
    assert.throws(() => rebindSessionWorkspace({
      projectPath: f.repo, launchKey: f.launchKey, fromSessionId: FROM, toSessionId: TO,
      principalId: PRINCIPAL, commitLedger: () => { ledgerCalls += 1; },
      onStep: (step) => { if (step === 'workspace_written') throw new Error('injected'); },
    }), /injected/);
    assert.equal(ledgerCalls, 0);
    assert.equal(resume(f.repo, FROM).cwd, f.created.cwd);
    assert.equal(fs.existsSync(f.aliasOf(TO)), false);
  } finally {
    f.cleanup();
  }
});

test('hard crash after step 1 (no revert ran): `from` resume fails closed', () => {
  const f = fixture();
  try {
    // Capture the on-disk state at the crash point, let the revert run, then
    // put the crash-point state back — exactly what a killed process leaves.
    const snapshot = new Map();
    assert.throws(() => rebindSessionWorkspace({
      projectPath: f.repo, launchKey: f.launchKey, fromSessionId: FROM, toSessionId: TO,
      principalId: PRINCIPAL, commitLedger: () => {},
      onStep: (step) => {
        if (step !== 'workspace_written') return;
        const manifest = path.join(f.stateRoot, 'instances', f.bound.overlayId, 'manifest.json');
        for (const file of [manifest, f.aliasOf(TO)]) snapshot.set(file, fs.readFileSync(file));
        throw new Error('crash');
      },
    }), /crash/);
    for (const [file, content] of snapshot) fs.writeFileSync(file, content);
    assert.throws(() => resume(f.repo, FROM), /manifest mismatch/, 'the spawn key fails closed');
    assert.equal(resume(f.repo, TO).cwd, f.created.cwd, 'the durable id is the only live binding');
  } finally {
    f.cleanup();
  }
});

test('fault after step 2 (ledger committed): no revert, `from` fails closed, `to` resumes', () => {
  const f = fixture();
  try {
    assert.throws(() => rebindSessionWorkspace({
      projectPath: f.repo, launchKey: f.launchKey, fromSessionId: FROM, toSessionId: TO,
      principalId: PRINCIPAL, commitLedger: () => {},
      onStep: (step) => { if (step === 'ledger_committed') throw new Error('crash'); },
    }), /crash/);
    assert.equal(fs.existsSync(f.aliasOf(FROM)), true, 'crash left the inert source alias');
    assert.throws(() => resume(f.repo, FROM), /manifest mismatch/);
    assert.equal(resume(f.repo, TO).cwd, f.created.cwd);
  } finally {
    f.cleanup();
  }
});
