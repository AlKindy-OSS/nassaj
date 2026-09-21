import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { prepareLocalSourceRecoveryCandidate, buildLocalSourceRecoveryCandidate } from '../../../scripts/local-source-recovery-candidate.mjs';
import { hashTree } from '../../../scripts/lib/source-update-tree-identity.mjs';
import { recoveryDatabaseSchemaSha256, inspectLocalRecoveryRegistration, registerLocalRecoveryPacket } from '../../../scripts/local-source-recovery-operator.mjs';
import { reconcileLocalRecoveryRollback } from '../../../scripts/local-source-recovery-reconcile.mjs';

const project = process.cwd(), sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const serverBuild = 'c'.repeat(64), clientBuild = 'b'.repeat(64), oldBuild = 'd'.repeat(64);
const write = (file: string, value: string) => fs.writeFileSync(file, value, { mode: 0o600 });

function fixtureRoot(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'operator-full-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  write(path.join(root, 'package.json'), '{"version":"2.2.0.1"}'); write(path.join(root, 'package-lock.json'), '{}');
  write(path.join(root, '.gitignore'), '.env\nnode_modules\ndist\ndist-server\n.nassaj-local-preview\nprivate.sqlite*\nready.json\n');
  git('add', 'package.json', 'package-lock.json', '.gitignore');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  for (const name of ['dist', 'dist-server', 'node_modules']) { fs.mkdirSync(path.join(root, name)); write(path.join(root, name, 'fixture'), 'old'); }
  fs.mkdirSync(path.join(root, 'dist-server/scripts'));
  fs.cpSync(path.join(project, 'dist-server/scripts/lib'), path.join(root, 'dist-server/scripts/lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist-server/server/services'), { recursive: true });
  write(path.join(root, 'dist-server/server/services/update-maintenance-gate.js'), `export * from ${JSON.stringify(pathToFileURL(path.join(project, 'dist-server/server/services/update-maintenance-gate.js')).href)};`);
  write(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), '{}');
  for (const name of ['dist', 'dist-server']) write(path.join(root, name, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: 'e'.repeat(40), buildId: oldBuild }));
  return { root, git, oid: git('rev-parse', 'HEAD') };
}

async function privateDatabase(root: string) {
  const previous = process.env.DATABASE_PATH, file = path.join(root, 'private.sqlite');
  closeConnection(); write(file, ''); process.env.DATABASE_PATH = file;
  try {
    await initializeDatabase(); const db = getConnection();
    const ownerId = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES ('fixture-owner','fixture','owner')").run().lastInsertRowid);
    const schemaSha256 = recoveryDatabaseSchemaSha256(db), stat = fs.statSync(file);
    return { ownerId, database: { path: file, dev: stat.dev, ino: stat.ino, uid: stat.uid, schemaSha256 } };
  } finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; }
}

async function runtime(t: test.TestContext, root: string, database: string, port = 0) {
  const ready = path.join(root, 'ready.json');
  if (fs.existsSync(ready)) fs.unlinkSync(ready);
  const code = `const fs=require('fs'),http=require('http');fs.openSync(process.argv[1],'r');const ticks=fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19];const health={status:'ok',pid:process.pid,serverProcessStartTicks:ticks,serverLoadedOid:'${'e'.repeat(40)}',serverLoadedBuildId:'${oldBuild}',serverBuildIdOnDisk:'${oldBuild}',clientBuildIdServed:'${oldBuild}',normalAdmissionReady:true,updateMode:'release'};const server=http.createServer((q,r)=>r.end(JSON.stringify(health)));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,startTicks:ticks,url:'http://127.0.0.1:'+server.address().port+'/health'})));`;
  const child = spawn(process.execPath, ['-e', code.replace("server.listen(0,", `server.listen(${port},`), database, ready], { cwd: root, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let count = 0; count < 100 && !fs.existsSync(ready); count++) await new Promise(resolve => setTimeout(resolve, 20));
  return { ...JSON.parse(fs.readFileSync(ready, 'utf8')), child };
}

function builds(root: string) {
  const artifact = (domain: string, options: { outputRoot: string; releaseCommit: string; version: string }) => {
    fs.mkdirSync(options.outputRoot);
    write(path.join(options.outputRoot, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: options.releaseCommit, version: options.version, buildId: domain === 'client' ? clientBuild : serverBuild }));
    if (domain === 'server') {
      const folder = path.join(options.outputRoot, 'server/modules/database/repositories'); fs.mkdirSync(folder, { recursive: true });
      for (const name of ['source-update-recovery', 'source-update-jobs']) write(path.join(folder, `${name}.db.js`),
        `export * from ${JSON.stringify(pathToFileURL(path.join(project, `server/modules/database/repositories/${name}.db.ts`)).href)};`);
    }
    return { buildId: domain === 'client' ? clientBuild : serverBuild };
  };
  return { root,
    run(executable: string, args: string[], options: { cwd: string }) {
      if (executable === 'git') return { status: 0, stdout: execFileSync(executable, args, { cwd: options.cwd, encoding: 'utf8' }) };
      if (args[0] === 'ci') { fs.mkdirSync(path.join(options.cwd, 'node_modules')); write(path.join(options.cwd, 'node_modules/fixture'), 'new'); }
      return { status: 0, stdout: '{}' };
    }, buildClient: (options: Parameters<typeof artifact>[1]) => artifact('client', options),
    buildServer: (options: Parameters<typeof artifact>[1]) => artifact('server', options) };
}

test('packet verification and registration reuse one exact candidate with real loaded validator and process identity', async t => {
  const value = fixtureRoot(t), { root, oid } = value, { ownerId, database } = await privateDatabase(root);
  const processIdentity = await runtime(t, root, database.path);
  const control = path.join(root, '.git/nassaj-source-update'); fs.mkdirSync(control, { mode: 0o700 });
  const configRoot = path.join(control, 'candidates/tx-1'); fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
  const original = 'FIXTURE_SETTING=preserved\n', proposal = `${original}NASSAJ_UPDATE_MODE=local-main\n`;
  write(path.join(root, '.env'), original);
  const proposalEnvPath = path.join(configRoot, 'local-recovery-proposal.env'); write(proposalEnvPath, proposal);
  const configReceiptPath = path.join(configRoot, 'local-recovery-config.json');
  const config = { schema: 'nassaj-local-recovery-config/v1', id: 'config-1', root, transactionId: 'tx-1', actionId: 'action-1',
    originalEnvSha256: sha(original), proposalEnvSha256: sha(proposal), approvalReference: 'synthetic:test-only', reservationReference: 'synthetic:test-only' };
  write(configReceiptPath, JSON.stringify(config));
  const operationBinding = { schema: 'nassaj-local-source-recovery-operation/v1', root, nodeIdentity: os.hostname(),
    jobId: 'job-1', actionId: 'action-1', transactionId: 'tx-1', ownerId, approvalReference: config.approvalReference,
    reservationReference: config.reservationReference, previousSourceOid: oid,
    previousRuntime: { oid: 'e'.repeat(40), serverBuildId: oldBuild, clientBuildId: oldBuild,
      pid: processIdentity.pid, startTicks: processIdentity.startTicks, controlManifestSha256: sha('{}'),
      actualTrees: { client: hashTree(path.join(root, 'dist')), server: hashTree(path.join(root, 'dist-server')), nodeModules: hashTree(path.join(root, 'node_modules')) } },
    modeTransition: { from: 'release', to: 'local-main', configReceiptId: config.id, configBindingSha256: sha(JSON.stringify(config)),
      originalEnvSha256: config.originalEnvSha256, proposalEnvSha256: config.proposalEnvSha256 } };
  const prepared = await prepareLocalSourceRecoveryCandidate({ root, expectedOid: oid, txId: 'tx-1', operationBinding });
  const receipt = await buildLocalSourceRecoveryCandidate(prepared.planFile, builds(root));
  const db = new Database(database.path); t.after(() => db.close());
  db.exec("CREATE TABLE fixture_registration_failure (fail INTEGER); INSERT INTO fixture_registration_failure VALUES(1)");
  db.exec("CREATE TRIGGER fail_action BEFORE INSERT ON pending_server_actions WHEN EXISTS(SELECT 1 FROM fixture_registration_failure) BEGIN SELECT RAISE(ABORT,'fixture_registration_interruption'); END");
  database.schemaSha256 = recoveryDatabaseSchemaSha256(db);
  const packet = { schema: 'nassaj-local-source-recovery-packet/v1', operation: 'register-prepared-recovery', root,
    nodeIdentity: os.hostname(), serviceUid: process.getuid(), operationBinding, database, proposalEnvPath, configReceiptPath,
    privateHealthUrl: processIdentity.url, publicHealthUrl: 'https://fixture.invalid/health', planPath: prepared.planFile,
    manifestSha256: receipt.manifestSha256, loadedValidatorSha256: sha(fs.readFileSync(path.join(root, 'dist-server/scripts/lib/source-update-activation.mjs'))) };
  const packetPath = path.join(control, 'packet.json'), bytes = JSON.stringify(packet); write(packetPath, bytes);
  const options = { root, packetPath, packetSha256: sha(bytes), operation: 'register-prepared-recovery' };
  const fetchOriginal = globalThis.fetch;
  let beforePublicHealthReply: (() => void) | null = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const response = await fetchOriginal(url === packet.publicHealthUrl ? packet.privateHealthUrl : url, init);
    if (url === packet.publicHealthUrl) beforePublicHealthReply?.();
    return response;
  });
  const inspected = await inspectLocalRecoveryRegistration(options);
  assert.equal(Object.keys(inspected.action).length, 8);
  assert.equal(inspected.action.originalHead, inspected.action.targetCommit);
  assert.notEqual(inspected.action.originalHead, inspected.registration.operationBinding.previousRuntime.oid);
  write(path.join(root, '.env'), `${original}CHANGED=1\n`);
  await assert.rejects(registerLocalRecoveryPacket(options), /file_changed/);
  write(path.join(root, '.env'), original);
  await assert.rejects(registerLocalRecoveryPacket(options), /fixture_registration_interruption/);
  assert.equal((db.prepare('SELECT count(*) AS n FROM source_update_jobs').get() as { n: number }).n, 0);
  const actionFile = path.join(path.dirname(receipt.manifestPath), 'activation-action.json');
  const actionBefore = fs.readFileSync(actionFile);
  db.exec('DELETE FROM fixture_registration_failure');
  const result = await registerLocalRecoveryPacket(options);
  assert.equal(result.reused, false); assert.equal(result.job.state, 'restart_queued');
  assert.equal((await registerLocalRecoveryPacket(options)).reused, true);
  assert.deepEqual(fs.readFileSync(actionFile), actionBefore);
  assert.equal((db.prepare('SELECT count(*) AS n FROM source_update_receipts').get() as { n: number }).n, 1);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), original);
  assert.equal(value.git('rev-parse', 'HEAD'), oid);
  db.prepare("UPDATE source_update_jobs SET state='runtime_verifying' WHERE id='job-1'").run();
  const loaded = await import(pathToFileURL(path.join(project, 'dist-server/scripts/lib/source-update-activation.mjs')).href);
  const validation = loaded.validateCandidate({ projectRoot: root, candidateRoot: path.dirname(receipt.manifestPath), transactionId: 'tx-1',
    releaseCommit: oid, version: receipt.version, manifestPath: receipt.manifestPath, manifestSha256: receipt.manifestSha256 });
  loaded.exchangeGenerations(validation); loaded.rollbackGenerations(validation);
  const token = 'a'.repeat(43); write(path.join(control, 'token'), token);
  const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
  const journal = { schema: 'nassaj-source-update-maintenance/v1', sequence: 3, state: 'OPEN', phase: null, gateClosed: false,
    transactionId: null, identity: null, owner: null, recovery: 'ROLLED_BACK', databaseState: 'PRE_CANDIDATE', tokenDigest: sha(token) };
  write(path.join(control, 'journal.json'), JSON.stringify({ ...journal, checksum: sha(canonical(journal)) }));
  const oldResult = loaded.inspectGitRuntimeRecovery({ projectRoot: root, controlRoot: control,
    job: db.prepare("SELECT * FROM source_update_jobs WHERE id='job-1'").get(), journal,
    runtime: { commit: 'e'.repeat(40), serverBuildId: oldBuild, clientBuildId: oldBuild } });
  assert.equal(oldResult.next, null); assert.equal(oldResult.code, 'source_update_runtime_evidence_unresolved');
  const exited = new Promise(resolve => processIdentity.child.once('exit', resolve)); processIdentity.child.kill(); await exited;
  const restored = await runtime(t, root, database.path, Number(new URL(processIdentity.url).port));
  assert.notEqual(restored.pid, processIdentity.pid);
  const reconciliation = { schema: 'nassaj-local-source-recovery-reconciliation/v1', root, operation: 'reconcile-pre-candidate-rollback',
    nodeIdentity: os.hostname(), serviceUid: process.getuid(), registrationPacketPath: packetPath, registrationPacketSha256: sha(bytes),
    approvalReference: 'synthetic:metadata-reconciliation-only', restoredProcess: { pid: restored.pid, startTicks: restored.startTicks },
    journalSha256: sha(fs.readFileSync(path.join(control, 'journal.json'))),
    rollbackReceiptSha256: sha(fs.readFileSync(path.join(path.dirname(receipt.manifestPath), 'activation-receipt.json'))),
    controlSnapshotSha256: sha(JSON.stringify(db.prepare('SELECT * FROM source_update_control WHERE singleton=1').get())) };
  const reconcilePath = path.join(control, 'reconciliation.json'), reconcileBytes = JSON.stringify(reconciliation); write(reconcilePath, reconcileBytes);
  const reconcileOptions = { root, packetPath: reconcilePath, packetSha256: sha(reconcileBytes), operation: 'reconcile-pre-candidate-rollback' };
  const journalBefore = fs.readFileSync(path.join(control, 'journal.json'));
  const assertStillStranded = () => assert.equal((db.prepare("SELECT state FROM source_update_jobs WHERE id='job-1'").get() as { state: string }).state, 'runtime_verifying');
  for (const state of ['UNKNOWN', 'MANUAL']) {
    const bad = { ...journal, ...(state === 'UNKNOWN' ? { databaseState: state } : { state, gateClosed: true }) };
    write(path.join(control, 'journal.json'), JSON.stringify({ ...bad, checksum: sha(canonical(bad)) }));
    const changed = JSON.stringify({ ...reconciliation, journalSha256: sha(fs.readFileSync(path.join(control, 'journal.json'))) });
    write(reconcilePath, changed);
    await assert.rejects(reconcileLocalRecoveryRollback({ ...reconcileOptions, packetSha256: sha(changed) }), /rollback_gate_unproven/);
    assertStillStranded();
  }
  fs.writeFileSync(path.join(control, 'journal.json'), journalBefore); write(reconcilePath, reconcileBytes);
  write(path.join(control, 'bootstrap-handoff.json'), '{}');
  await assert.rejects(reconcileLocalRecoveryRollback(reconcileOptions), /handoff_unresolved/); assertStillStranded();
  fs.unlinkSync(path.join(control, 'bootstrap-handoff.json'));
  const staleProcess = JSON.stringify({ ...reconciliation, restoredProcess: { pid: processIdentity.pid, startTicks: processIdentity.startTicks } });
  write(reconcilePath, staleProcess);
  await assert.rejects(reconcileLocalRecoveryRollback({ ...reconcileOptions, packetSha256: sha(staleProcess) })); assertStillStranded();
  write(reconcilePath, reconcileBytes);
  const metadataSnapshot = () => ['source_update_jobs', 'source_update_receipts', 'pending_server_actions', 'source_update_control']
    .map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const preparedReceiptPath = path.join(path.dirname(receipt.manifestPath), 'local-source-recovery-receipt.json');
  const preparedReceiptBytes = fs.readFileSync(preparedReceiptPath); fs.unlinkSync(preparedReceiptPath);
  const absentReceiptDb = metadataSnapshot(), absentReceiptTree = hashTree(path.dirname(receipt.manifestPath));
  await assert.rejects(reconcileLocalRecoveryRollback(reconcileOptions), /ENOENT/);
  assert.deepEqual(metadataSnapshot(), absentReceiptDb);
  assert.deepEqual(hashTree(path.dirname(receipt.manifestPath)), absentReceiptTree);
  assert.equal(fs.existsSync(preparedReceiptPath), false);
  fs.writeFileSync(preparedReceiptPath, preparedReceiptBytes, { mode: 0o600 });
  for (const extra of ['oid','serverBuildId','clientBuildId']) {
    const altered = JSON.stringify({ ...reconciliation, restoredProcess: { ...reconciliation.restoredProcess, [extra]: 'foreign' } });
    const before = metadataSnapshot(); write(reconcilePath, altered);
    await assert.rejects(reconcileLocalRecoveryRollback({ ...reconcileOptions, packetSha256: sha(altered) }), /packet_identity/);
    assert.deepEqual(metadataSnapshot(), before);
  }
  write(reconcilePath, reconcileBytes);
  for (const [mutate, restore] of [
    ["UPDATE source_update_jobs SET release_commit='changed' WHERE id='job-1'", `UPDATE source_update_jobs SET release_commit='${oid}' WHERE id='job-1'`],
    ["UPDATE pending_server_actions SET expected_server_build_id='changed' WHERE id='action-1'", `UPDATE pending_server_actions SET expected_server_build_id='${serverBuild}' WHERE id='action-1'`],
    ["UPDATE source_update_control SET active_job_id='new-job' WHERE singleton=1", 'UPDATE source_update_control SET active_job_id=NULL WHERE singleton=1'],
  ]) {
    let raced: unknown;
    beforePublicHealthReply = () => { db.exec(mutate); raced = metadataSnapshot(); };
    await assert.rejects(reconcileLocalRecoveryRollback(reconcileOptions), /reconciliation_job_changed|reconciliation_action_changed|control_changed/);
    assert.deepEqual(metadataSnapshot(), raced); beforePublicHealthReply = null; db.exec(restore);
  }
  const settled = await reconcileLocalRecoveryRollback(reconcileOptions); assert.equal(settled.reused, false);
  assert.equal((await reconcileLocalRecoveryRollback(reconcileOptions)).reused, true);
  assert.equal((db.prepare("SELECT state FROM source_update_jobs WHERE id='job-1'").get() as { state: string }).state, 'rolled_back');
  assert.equal((db.prepare("SELECT status FROM pending_server_actions WHERE id='action-1'").get() as { status: string }).status, 'superseded');
  assert.equal((db.prepare('SELECT count(*) AS n FROM source_update_receipts').get() as { n: number }).n, 2);
  db.exec("UPDATE source_update_control SET active_job_id='new-job' WHERE singleton=1");
  const newerReservation = metadataSnapshot();
  assert.equal((await reconcileLocalRecoveryRollback(reconcileOptions)).reused, true);
  assert.deepEqual(metadataSnapshot(), newerReservation);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), original);
});
