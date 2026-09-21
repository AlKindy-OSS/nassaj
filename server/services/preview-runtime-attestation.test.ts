import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  captureServerRuntimeAttestation,
  parseProcessStartTicks,
  reconcileOidControlJournalAtStartup,
} from './preview-runtime-attestation.js';

const OID = 'a'.repeat(40);
const BUILD = 'b'.repeat(64);

function clearPreviewNonces() {
  const transaction = process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE;
  const boot = process.env.NASSAJ_PREVIEW_BOOT_NONCE;
  delete process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE;
  delete process.env.NASSAJ_PREVIEW_BOOT_NONCE;
  return () => {
    if (transaction === undefined) delete process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE;
    else process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE = transaction;
    if (boot === undefined) delete process.env.NASSAJ_PREVIEW_BOOT_NONCE;
    else process.env.NASSAJ_PREVIEW_BOOT_NONCE = boot;
  };
}

test('process start-time parser ignores spaces and internal closing parentheses in the Linux comm field', () => {
  const stat = `123 (node /srv/example runtime) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 424242 999`;
  assert.equal(parseProcessStartTicks(stat), '424242');
  const closingParenthesis = `123 (node ) worker /srv/example runtime) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 515151 999`;
  assert.equal(parseProcessStartTicks(closingParenthesis), '515151');
  assert.equal(parseProcessStartTicks('123 (broken stat)'), null);
});

test('runtime attestation accepts only compiled, clean, exact OID provenance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-attestation-'));
  const restoreNonces = clearPreviewNonces();
  try {
    const compiled = path.join(root, 'dist-server', 'server');
    fs.mkdirSync(compiled, { recursive: true });
    fs.writeFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify({
      artifact: 'server', commit: OID, baseCommit: OID, buildId: BUILD, dirty: false,
    }));
    const nested = captureServerRuntimeAttestation(root, path.join(compiled, 'services'));
    const direct = captureServerRuntimeAttestation(root, compiled);
    for (const value of [nested, direct]) {
      assert.equal(value.oid, OID);
      assert.equal(value.buildId, BUILD);
      assert.equal(value.controlProtocol, 1);
      assert.equal(value.launcherAbi, 'nassaj-oid-launcher/v1');
      assert.equal(value.transactionNonce, null);
      assert.equal(value.bootNonce, null);
      assert.equal(value.pid, process.pid);
      assert.ok(value.processStartTicks);
    }
    assert.deepEqual(captureServerRuntimeAttestation(root, path.join(root, 'server')), { oid: null, buildId: null });
  } finally {
    restoreNonces();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime attestation rejects symlink and dirty/mismatched provenance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-attestation-'));
  try {
    const compiled = path.join(root, 'dist-server', 'server');
    fs.mkdirSync(compiled, { recursive: true });
    const external = path.join(root, 'external.json');
    fs.writeFileSync(external, JSON.stringify({ artifact: 'server', commit: OID, baseCommit: OID, buildId: BUILD, dirty: false }));
    fs.symlinkSync(external, path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'));
    assert.deepEqual(captureServerRuntimeAttestation(root, compiled), { oid: null, buildId: null });
    fs.unlinkSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'));
    fs.writeFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify({
      artifact: 'server', commit: OID, baseCommit: 'c'.repeat(40), buildId: BUILD, dirty: false,
    }));
    assert.deepEqual(captureServerRuntimeAttestation(root, compiled), { oid: null, buildId: null });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('module-level attestation captures provenance from the real compiled services path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-attestation-module-'));
  const restoreNonces = clearPreviewNonces();
  try {
    const services = path.join(root, 'dist-server', 'server', 'services');
    const utils = path.join(root, 'dist-server', 'server', 'utils');
    fs.mkdirSync(services, { recursive: true });
    fs.mkdirSync(utils, { recursive: true });
    fs.copyFileSync(new URL('./preview-runtime-attestation.js', import.meta.url), path.join(services, 'preview-runtime-attestation.js'));
    fs.copyFileSync(new URL('../utils/runtime-paths.js', import.meta.url), path.join(utils, 'runtime-paths.js'));
    fs.writeFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify({
      artifact: 'server', commit: OID, baseCommit: OID, buildId: BUILD, dirty: false,
    }));
    const loaded = await import(`${pathToFileURL(path.join(services, 'preview-runtime-attestation.js')).href}?fixture=${Date.now()}`);
    assert.equal(loaded.SERVER_RUNTIME_ATTESTATION.oid, OID);
    assert.equal(loaded.SERVER_RUNTIME_ATTESTATION.buildId, BUILD);
    assert.equal(loaded.SERVER_RUNTIME_ATTESTATION.controlProtocol, 1);
    assert.equal(loaded.SERVER_RUNTIME_ATTESTATION.launcherAbi, 'nassaj-oid-launcher/v1');
    assert.equal(loaded.SERVER_RUNTIME_ATTESTATION.transactionNonce, null);
    assert.equal(loaded.SERVER_RUNTIME_ATTESTATION.bootNonce, null);
    assert.equal(loaded.SERVER_RUNTIME_ATTESTATION.pid, process.pid);
    assert.ok(loaded.SERVER_RUNTIME_ATTESTATION.processStartTicks);
  } finally {
    restoreNonces();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup recovery settles exact prepared and rollback seams but leaves ambiguity fenced', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-attestation-recovery-'));
  assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }).status, 0);
  const git = path.join(root, '.git');
  const live = path.join(root, 'dist-server');
  const candidate = path.join(root, '.nassaj-local-preview', 'server-candidates', 'candidate');
  fs.mkdirSync(live);
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(path.join(live, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: OID, buildId: BUILD }));
  fs.writeFileSync(path.join(candidate, 'BUILD_PROVENANCE.json'), JSON.stringify({
    commit: 'c'.repeat(40), buildId: 'd'.repeat(64),
  }));
  const attestation = {
    oid: OID, buildId: BUILD, transactionNonce: '1'.repeat(64), bootNonce: '2'.repeat(64),
    pid: 99, processStartTicks: '999',
  };
  try {
    const prepared = path.join(git, 'nassaj-oid-control-transaction-1-a.json');
    fs.writeFileSync(prepared, JSON.stringify({
      state: 'prepared', previousOid: OID, previousBuildId: BUILD, oldStartTicks: '1',
      oid: 'c'.repeat(40), buildId: 'd'.repeat(64), livePath: live, candidatePath: candidate,
    }));
    assert.equal(reconcileOidControlJournalAtStartup(root, attestation)?.state, 'restart_deferred_restored');
    const rollback = path.join(git, 'nassaj-oid-control-transaction-2-b.json');
    fs.writeFileSync(rollback, JSON.stringify({
      state: 'rollback_prepared', previousOid: OID, previousBuildId: BUILD,
      oid: 'c'.repeat(40), buildId: 'd'.repeat(64), livePath: live, candidatePath: candidate,
      transactionNonce: attestation.transactionNonce, rollbackBootNonce: attestation.bootNonce, oldStartTicks: '1',
    }));
    assert.equal(reconcileOidControlJournalAtStartup(root, attestation)?.state, 'rolled_back');
    fs.writeFileSync(path.join(git, 'nassaj-oid-control-transaction-3-c.json'), JSON.stringify({
      state: 'prepared', previousOid: OID, previousBuildId: BUILD, oldStartTicks: '1',
      oid: 'c'.repeat(40), buildId: 'd'.repeat(64), livePath: live, candidatePath: candidate,
    }));
    fs.writeFileSync(path.join(git, 'nassaj-oid-control-transaction-4-d.json'), JSON.stringify({
      state: 'prepared', previousOid: OID, previousBuildId: BUILD, oldStartTicks: '1',
      oid: 'c'.repeat(40), buildId: 'd'.repeat(64), livePath: live, candidatePath: candidate,
    }));
    assert.equal(reconcileOidControlJournalAtStartup(root, attestation), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('startup recovery reads an exact OID journal from a linked worktree common Git directory', () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-attestation-main-'));
  const linked = `${main}-linked`;
  const git = (cwd: string, args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(main, ['init']);
    git(main, ['config', 'user.email', 'test@example.invalid']);
    git(main, ['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(main, 'seed'), 'seed');
    git(main, ['add', 'seed']);
    git(main, ['commit', '-m', 'seed']);
    git(main, ['worktree', 'add', '--detach', linked]);
    assert.equal(fs.lstatSync(path.join(linked, '.git')).isFile(), true);
    const common = git(linked, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const live = path.join(linked, 'dist-server');
    const candidate = path.join(linked, '.nassaj-local-preview', 'server-candidates', 'candidate');
    fs.mkdirSync(live);
    fs.mkdirSync(candidate, { recursive: true });
    fs.writeFileSync(path.join(live, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: OID, buildId: BUILD }));
    fs.writeFileSync(path.join(candidate, 'BUILD_PROVENANCE.json'), JSON.stringify({
      commit: 'c'.repeat(40), buildId: 'd'.repeat(64),
    }));
    fs.writeFileSync(path.join(common, 'nassaj-oid-control-transaction-7-linked.json'), JSON.stringify({
      state: 'prepared', previousOid: OID, previousBuildId: BUILD, oldStartTicks: '1',
      oid: 'c'.repeat(40), buildId: 'd'.repeat(64), livePath: live, candidatePath: candidate,
    }));
    const attestation = {
      oid: OID, buildId: BUILD, transactionNonce: '1'.repeat(64), bootNonce: '2'.repeat(64),
      pid: 99, processStartTicks: '999',
    };
    assert.equal(reconcileOidControlJournalAtStartup(linked, attestation)?.state, 'restart_deferred_restored');
    const journal = JSON.parse(fs.readFileSync(path.join(common, 'nassaj-oid-control-transaction-7-linked.json'), 'utf8'));
    assert.equal(journal.recoveredAtStartup, true);
  } finally {
    fs.rmSync(linked, { recursive: true, force: true });
    fs.rmSync(main, { recursive: true, force: true });
  }
});
