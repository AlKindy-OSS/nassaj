import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { SOURCE_UPDATE_ACTIVE_STATES } from '@/modules/database/repositories/source-update-jobs.db.js';

import { prepareLocalSourceRecoveryCandidate, buildLocalSourceRecoveryCandidate } from '../../../scripts/local-source-recovery-candidate.mjs';
import { manualRollback, prepareRuntimeRebinding } from '../../../scripts/local-source-manual-rollback.mjs';
import { registerLocalRecoveryPacket, recoveryDatabaseSchemaSha256 } from '../../../scripts/local-source-recovery-operator.mjs';
import { MANUAL_ROLLBACK_ACTIVE_STATES } from '../../../scripts/lib/source-update-manual-rollback-db.mjs';
import { hashTree } from '../../../scripts/lib/source-update-tree-identity.mjs';

const project = process.cwd(), sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const oldBuild = 'd'.repeat(64), serverBuild = 'c'.repeat(64), clientBuild = 'b'.repeat(64);
const write = (file: string, value: string) => fs.writeFileSync(file, value, { mode: 0o600 });
const canonical = (value: any): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);

test('standalone manual rollback active states stay in exact repository parity', () => {
  assert.deepEqual(MANUAL_ROLLBACK_ACTIVE_STATES, SOURCE_UPDATE_ACTIVE_STATES);
});

function rootFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'manual-rollback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  write(path.join(root, 'package.json'), '{"version":"2.2.0.1"}'); write(path.join(root, 'package-lock.json'), '{}');
  write(path.join(root, '.gitignore'), '.env\nnode_modules\ndist\ndist-server\nprivate.sqlite*\nready.json\n');
  git('add', 'package.json', 'package-lock.json', '.gitignore');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  for (const name of ['dist', 'dist-server', 'node_modules']) { fs.mkdirSync(path.join(root, name)); write(path.join(root, name, 'fixture'), 'old'); }
  fs.mkdirSync(path.join(root, 'dist-server/scripts'));
  fs.cpSync(path.join(project, 'dist-server/scripts/lib'), path.join(root, 'dist-server/scripts/lib'), { recursive: true });
  write(path.join(root, 'dist-server/OID_CONTROL_MANIFEST.json'), '{}');
  for (const name of ['dist', 'dist-server']) write(path.join(root, name, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: 'e'.repeat(40), buildId: oldBuild }));
  return { root, git, oid: git('rev-parse', 'HEAD') };
}

async function databaseFixture(root: string) {
  const previous = process.env.DATABASE_PATH, file = path.join(root, 'private.sqlite');
  closeConnection(); write(file, ''); process.env.DATABASE_PATH = file;
  try {
    await initializeDatabase(); const db = getConnection();
    const ownerId = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES ('rollback-owner','fixture','owner')").run().lastInsertRowid);
    const stat = fs.statSync(file);
    return { ownerId, database: { path: file, dev: stat.dev, ino: stat.ino, uid: stat.uid, schemaSha256: recoveryDatabaseSchemaSha256(db) } };
  } finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; }
}

async function oldRuntime(t: test.TestContext, root: string, database: string) {
  const ready = path.join(root, 'ready.json');
  const code = `const fs=require('fs'),http=require('http');fs.openSync(process.argv[1],'r');const ticks=fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19];const health={status:'ok',pid:process.pid,serverProcessStartTicks:ticks,serverLoadedOid:'${'e'.repeat(40)}',serverLoadedBuildId:'${oldBuild}',serverBuildIdOnDisk:'${oldBuild}',clientBuildIdServed:'${oldBuild}',normalAdmissionReady:true,updateMode:'release'};const server=http.createServer((q,r)=>r.end(JSON.stringify(health)));server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],JSON.stringify({health,url:'http://127.0.0.1:'+server.address().port+'/health'})));`;
  const child = spawn(process.execPath, ['-e', code, database, ready], { cwd: root, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let count = 0; count < 100 && !fs.existsSync(ready); count++) await new Promise(resolve => setTimeout(resolve, 20));
  return { ...JSON.parse(fs.readFileSync(ready, 'utf8')), child };
}

function buildTools(root: string) {
  const artifact = (domain: string, options: { outputRoot: string; releaseCommit: string; version: string }) => {
    fs.mkdirSync(options.outputRoot);
    write(path.join(options.outputRoot, 'BUILD_PROVENANCE.json'), JSON.stringify({ commit: options.releaseCommit,
      version: options.version, buildId: domain === 'client' ? clientBuild : serverBuild }));
    if (domain === 'server') {
      const folder = path.join(options.outputRoot, 'server/modules/database/repositories'); fs.mkdirSync(folder, { recursive: true });
      // A real 84bd-era candidate does not export the new manual rollback API.
      write(path.join(folder, 'source-update-recovery.db.js'),
        `export {registerPreparedRecoveryCandidate} from ${JSON.stringify(pathToFileURL(path.join(project, 'server/modules/database/repositories/source-update-recovery.db.ts')).href)};`);
      write(path.join(folder, 'source-update-jobs.db.js'),
        `export {SOURCE_UPDATE_ACTIVE_STATES} from ${JSON.stringify(pathToFileURL(path.join(project, 'server/modules/database/repositories/source-update-jobs.db.ts')).href)};`);
    }
    return { buildId: domain === 'client' ? clientBuild : serverBuild };
  };
  return { root, run(executable: string, args: string[], options: { cwd: string }) {
    if (executable === 'git') return { status: 0, stdout: execFileSync(executable, args, { cwd: options.cwd, encoding: 'utf8' }) };
    if (args[0] === 'ci') { fs.mkdirSync(path.join(options.cwd, 'node_modules')); write(path.join(options.cwd, 'node_modules/fixture'), 'new'); }
    return { status: 0, stdout: '{}' };
  }, buildClient: (options: Parameters<typeof artifact>[1]) => artifact('client', options),
  buildServer: (options: Parameters<typeof artifact>[1]) => artifact('server', options) };
}

async function manualFixture(t: test.TestContext) {
  const source = rootFixture(t), { root, oid, git } = source, { ownerId, database } = await databaseFixture(root);
  const runtime = await oldRuntime(t, root, database.path);
  const control = path.join(root, '.git/nassaj-source-update'); fs.mkdirSync(control, { mode: 0o700 });
  for (const name of ['admission.lock', 'activity.lock']) write(path.join(control, name), '');
  const candidate = path.join(control, 'candidates/tx-manual'); fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const env = 'FIXTURE_SETTING=preserved\n', proposal = `${env}NASSAJ_UPDATE_MODE=local-main\n`; write(path.join(root, '.env'), env);
  const proposalEnvPath = path.join(candidate, 'local-recovery-proposal.env'); write(proposalEnvPath, proposal);
  const configReceiptPath = path.join(candidate, 'local-recovery-config.json');
  const config = { schema: 'nassaj-local-recovery-config/v1', id: 'config-manual', root, transactionId: 'tx-manual', actionId: 'action-manual',
    originalEnvSha256: sha(env), proposalEnvSha256: sha(proposal), approvalReference: 'synthetic:test', reservationReference: 'synthetic:test' };
  write(configReceiptPath, JSON.stringify(config));
  const binding = { schema: 'nassaj-local-source-recovery-operation/v1', root, nodeIdentity: os.hostname(), jobId: 'job-manual',
    actionId: 'action-manual', transactionId: 'tx-manual', ownerId, approvalReference: config.approvalReference,
    reservationReference: config.reservationReference, previousSourceOid: oid,
    previousRuntime: { oid: 'e'.repeat(40), serverBuildId: oldBuild, clientBuildId: oldBuild, pid: runtime.health.pid,
      startTicks: runtime.health.serverProcessStartTicks, controlManifestSha256: sha('{}'), actualTrees: {
        client: hashTree(path.join(root, 'dist')), server: hashTree(path.join(root, 'dist-server')), nodeModules: hashTree(path.join(root, 'node_modules')) } },
    modeTransition: { from: 'release', to: 'local-main', configReceiptId: config.id, configBindingSha256: sha(JSON.stringify(config)),
      originalEnvSha256: config.originalEnvSha256, proposalEnvSha256: config.proposalEnvSha256 } };
  const prepared = await prepareLocalSourceRecoveryCandidate({ root, expectedOid: oid, txId: binding.transactionId, operationBinding: binding });
  const receipt = await buildLocalSourceRecoveryCandidate(prepared.planFile, buildTools(root));
  const packet = { schema: 'nassaj-local-source-recovery-packet/v1', operation: 'register-prepared-recovery', root,
    nodeIdentity: os.hostname(), serviceUid: process.getuid(), operationBinding: binding, database, proposalEnvPath, configReceiptPath,
    privateHealthUrl: runtime.url, publicHealthUrl: 'https://fixture.invalid/health', planPath: prepared.planFile,
    manifestSha256: receipt.manifestSha256, loadedValidatorSha256: sha(fs.readFileSync(path.join(root, 'dist-server/scripts/lib/source-update-activation.mjs'))) };
  const packetPath = path.join(control, 'packet.json'), packetBytes = JSON.stringify(packet); write(packetPath, packetBytes);
  const options = { root, packetPath, packetSha256: sha(packetBytes) };
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => realFetch(url === packet.publicHealthUrl ? packet.privateHealthUrl : url, init));
  await registerLocalRecoveryPacket({ ...options, operation: 'register-prepared-recovery' });
  const activation = await import(pathToFileURL(path.join(root, 'dist-server/scripts/lib/source-update-activation.mjs')).href);
  const validation = activation.validateCandidate({ projectRoot: root, candidateRoot: candidate, transactionId: binding.transactionId,
    releaseCommit: oid, version: receipt.version, manifestPath: receipt.manifestPath, manifestSha256: receipt.manifestSha256 });
  activation.exchangeGenerations(validation);
  const currentHealth = () => ({ ...runtime.health,
    clientBuildIdServed: JSON.parse(fs.readFileSync(path.join(root, 'dist/BUILD_PROVENANCE.json'), 'utf8')).buildId,
    serverBuildIdOnDisk: JSON.parse(fs.readFileSync(path.join(root, 'dist-server/BUILD_PROVENANCE.json'), 'utf8')).buildId });
  const db = new Database(database.path); t.after(() => db.close());
  const fence = (db.prepare("SELECT worker_fence FROM source_update_jobs WHERE id='job-manual'").get() as { worker_fence: number }).worker_fence;
  const addReceipt = (sequence: number, phase: string, facts: object) => { const value = JSON.stringify(facts);
    db.prepare("INSERT INTO source_update_receipts(job_id,sequence,worker_fence,phase,kind,facts_json,facts_sha256) VALUES ('job-manual',?,? ,?,'recovery',?,?)")
      .run(sequence, fence, phase, value, sha(value)); };
  db.prepare("UPDATE source_update_jobs SET state='manual_recovery_required',auto_activate=1 WHERE id='job-manual'").run();
  db.prepare("UPDATE pending_server_actions SET status='failed',error='source_update_manual_recovery_required' WHERE id='action-manual'").run();
  addReceipt(2, 'restart_queued', { code: 'owner_activation_consent', ownerId, expectedVersion: receipt.version,
    targetDigest: (db.prepare("SELECT activation_identity_sha256 AS v FROM source_update_jobs WHERE id='job-manual'").get() as { v: string }).v });
  addReceipt(3, 'runtime_verifying', { code: 'update_database_state_unknown', failedPhase: 'runtime_verifying', intervention: 'human' });
  const manifest = JSON.parse(fs.readFileSync(receipt.manifestPath, 'utf8'));
  const journalBase = { schema: 'nassaj-source-update-maintenance/v1', sequence: 7, state: 'MANUAL', phase: 'RESTARTING_HANDOFF', gateClosed: true,
    transactionId: binding.transactionId, identity: { expectedVersion: receipt.version, originalHead: oid, targetCommit: oid,
      manifestSha256: receipt.manifestSha256 }, owner: null, databaseState: 'UNKNOWN', recoveryError: 'update_database_state_unknown' };
  write(path.join(control, 'journal.json'), JSON.stringify({ ...journalBase, checksum: sha(canonical(journalBase)) }));
  write(path.join(control, 'bootstrap-handoff.json'), JSON.stringify({ schema: 'nassaj-source-update-bootstrap/v1', transactionId: binding.transactionId }));
  write(path.join(root, 'recovery-note.txt'), 'operator recovery implementation\n');
  git('add', 'recovery-note.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '-qm', 'fix: add recovery operator');
  const operatorSourceOid = git('rev-parse', 'HEAD');
  const preparedRuntime = await prepareRuntimeRebinding(options, { readHealth: async () => currentHealth() });
  const runtimePacketPath = preparedRuntime.file, runtimePacketSha256 = preparedRuntime.sha256;
  assert.equal(runtimePacketPath, path.join(candidate, 'manual-rollback-runtime.json'));
  assert.equal(sha(fs.readFileSync(runtimePacketPath)), runtimePacketSha256);
  const rollbackOptions = { ...options, runtimePacketPath, runtimePacketSha256 };
  return { ...source, operatorSourceOid, db, database, runtime, control, candidate, packet, binding, manifest, currentHealth, preparedRuntime,
    options: rollbackOptions, execute: (injected: object = {}) => manualRollback({ ...rollbackOptions,
      ownerAck: preparedRuntime.ownerAck, exec: true },
      { readHealth: async () => currentHealth(), ...injected }) };
}

const metadata = (db: Database.Database) => ['source_update_jobs', 'source_update_receipts', 'pending_server_actions', 'source_update_control']
  .map(table => db.prepare(`SELECT * FROM ${table}`).all());

test('dry-run and stale PID are pre-effect; schema/tree/job/action drift fail closed', async t => {
  const v = await manualFixture(t), before = metadata(v.db), users = v.db.prepare('SELECT * FROM users ORDER BY id').all();
  const liveBefore = Object.fromEntries(['dist','dist-server','node_modules'].map(name => [name, hashTree(path.join(v.root, name))]));
  const dry = await manualRollback({ ...v.options, exec: false }, { readHealth: async () => v.currentHealth() });
  assert.equal(dry.dryRun, true); assert.deepEqual(metadata(v.db), before);
  assert.deepEqual(Object.fromEntries(['dist','dist-server','node_modules'].map(name => [name, hashTree(path.join(v.root, name))])), liveBefore);
  await assert.rejects(manualRollback({ ...v.options,
    ownerAck: `rollback:${v.binding.transactionId}:${v.options.packetSha256}:${v.options.runtimePacketSha256}`, exec: true },
    { readHealth: async () => ({ ...v.currentHealth(), serverProcessStartTicks: `${Number(v.runtime.health.serverProcessStartTicks) + 1}` }) }), /runtime_(target_changed|packet_identity)/);
  assert.deepEqual(metadata(v.db), before); assert.equal(JSON.parse(fs.readFileSync(path.join(v.candidate, 'activation-receipt.json'), 'utf8')).state, 'exchanged');
  const runtimeBytes = fs.readFileSync(v.options.runtimePacketPath), runtimeRecord = JSON.parse(runtimeBytes.toString('utf8'));
  assert.equal(runtimeRecord.operatorSourceOid, v.operatorSourceOid);
  assert.notEqual(runtimeRecord.operatorSourceOid, v.oid);
  await assert.rejects(manualRollback({ ...v.options, runtimePacketSha256: '0'.repeat(64), exec: false },
    { readHealth: async () => v.currentHealth() }), /runtime_packet_digest/);
  for (const [field, changed] of [['pid', process.pid + 100000], ['startTicks', '999999'], ['uid', process.getuid() + 1],
    ['cwd', path.dirname(v.root)], ['databaseIno', runtimeRecord.runtime.databaseIno + 1], ['bootId', 'changed-boot'],
    ['ppid', runtimeRecord.runtime.ppid + 100000], ['parentStartTicks', '999999'],
    ['parentUid', runtimeRecord.runtime.parentUid + 1], ['parentExe', '/changed-parent'],
    ['serverLoadedBuildId', '0'.repeat(64)], ['clientBuildIdServed', '0'.repeat(64)]]) {
    const altered = structuredClone(runtimeRecord); altered.runtime[field] = changed; const bytes = JSON.stringify(altered);
    write(v.options.runtimePacketPath, bytes);
    await assert.rejects(manualRollback({ ...v.options, runtimePacketSha256: sha(bytes), exec: false },
      { readHealth: async () => v.currentHealth() }), /runtime_(packet_identity|packet_claims|claims_changed|target_changed)/);
    fs.writeFileSync(v.options.runtimePacketPath, runtimeBytes, { mode: 0o600 });
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.candidate, 'activation-receipt.json'), 'utf8')).state, 'exchanged');
  }
  const changedSource = structuredClone(runtimeRecord); changedSource.operatorSourceOid = '0'.repeat(40);
  const changedSourceBytes = JSON.stringify(changedSource); write(v.options.runtimePacketPath, changedSourceBytes);
  await assert.rejects(manualRollback({ ...v.options, runtimePacketSha256: sha(changedSourceBytes), exec: false },
    { readHealth: async () => v.currentHealth() }), /source_head_changed/);
  fs.writeFileSync(v.options.runtimePacketPath, runtimeBytes, { mode: 0o600 });
  const target = path.join(v.root, 'dist/BUILD_PROVENANCE.json'), targetBytes = fs.readFileSync(target); write(target, 'tree-drift');
  await assert.rejects(manualRollback({ ...v.options, exec: false }, { readHealth: async () => v.currentHealth() }), /tree is absent/);
  fs.writeFileSync(target, targetBytes, { mode: 0o600 });
  v.db.exec("CREATE INDEX fixture_users_schema_drift ON users(username)");
  await assert.rejects(manualRollback({ ...v.options, exec: false }, { readHealth: async () => v.currentHealth() }), /database_schema_changed/);
  v.db.exec('DROP INDEX fixture_users_schema_drift');
  for (const [mutate, restore] of [
    ["UPDATE source_update_jobs SET auto_activate=0 WHERE id='job-manual'", "UPDATE source_update_jobs SET auto_activate=1 WHERE id='job-manual'"],
    ["UPDATE pending_server_actions SET release_commit='changed' WHERE id='action-manual'", `UPDATE pending_server_actions SET release_commit='${v.oid}' WHERE id='action-manual'`],
  ]) {
    v.db.exec(mutate); const state = metadata(v.db);
    await assert.rejects(v.execute(), /manual_rollback_(job|action)_changed/); assert.deepEqual(metadata(v.db), state); v.db.exec(restore);
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.candidate, 'activation-receipt.json'), 'utf8')).state, 'exchanged');
  }
  const activationFile = path.join(v.candidate, 'activation-receipt.json'), activationSha = sha(fs.readFileSync(activationFile));
  for (const [mutate, restore, error] of [
    ["UPDATE source_update_control SET active_job_id='foreign' WHERE singleton=1", "UPDATE source_update_control SET active_job_id=NULL WHERE singleton=1", 'worker_conflict'],
    ["INSERT INTO source_update_effects(job_id,effect_id,worker_fence,effect_kind,pid,start_ticks,boot_id,pgid,state) VALUES ('job-manual','foreign',1,'build',99,'1','boot',99,'running')", "DELETE FROM source_update_effects WHERE effect_id='foreign'", 'worker_conflict'],
    ["INSERT INTO source_update_jobs(id,expected_version,owner_id,idempotency_key_hash,request_fingerprint,strategy,state) VALUES ('foreign-job','1.0.0.0',1,'foreign-key','foreign-fingerprint','git-checkout-v2','accepted')", "DELETE FROM source_update_jobs WHERE id='foreign-job'", 'active_job_conflict'],
    ["INSERT INTO pending_server_actions(id,action_type,status) VALUES ('foreign-action','safe-restart','pending')", "DELETE FROM pending_server_actions WHERE id='foreign-action'", 'action_conflict'],
  ] as Array<[string, string, string]>) {
    v.db.exec(mutate);
    await assert.rejects(v.execute(), new RegExp(error));
    assert.equal(sha(fs.readFileSync(activationFile)), activationSha);
    assert.equal(JSON.parse(fs.readFileSync(activationFile, 'utf8')).state, 'exchanged');
    v.db.exec(restore);
  }
  assert.deepEqual(v.db.prepare('SELECT * FROM users ORDER BY id').all(), users);
});

test('operator source refuses tracked dirt, non-descendants, and clean HEAD drift exactly', async t => {
  await t.test('tracked worktree dirt', async child => {
    const v = await manualFixture(child);
    write(path.join(v.root, 'package.json'), '{"version":"dirty"}');
    await assert.rejects(prepareRuntimeRebinding(v.options, { readHealth: async () => v.currentHealth() }),
      /local_source_manual_rollback_source_tracked_dirty/);
  });
  await t.test('unrelated clean root', async child => {
    const v = await manualFixture(child), tree = v.git('write-tree');
    const unrelated = v.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit-tree', tree, '-m', 'unrelated root');
    v.git('reset', '--hard', unrelated);
    await assert.rejects(prepareRuntimeRebinding(v.options, { readHealth: async () => v.currentHealth() }),
      /local_source_manual_rollback_source_not_descendant/);
  });
  await t.test('clean descendant after packet creation', async child => {
    const v = await manualFixture(child);
    write(path.join(v.root, 'recovery-note-2.txt'), 'later recovery change\n');
    v.git('add', 'recovery-note-2.txt');
    v.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null',
      'commit', '-qm', 'fix: later recovery change');
    await assert.rejects(manualRollback({ ...v.options, exec: false }, { readHealth: async () => v.currentHealth() }),
      /local_source_manual_rollback_source_head_changed/);
  });
});

test('crashes at every boundary replay to one rollback without DB restore or restart', async t => {
  const v = await manualFixture(t), pid = v.runtime.health.pid, inode = fs.statSync(v.database.path).ino;
  const users = v.db.prepare('SELECT * FROM users ORDER BY id').all();
  for (const stage of ['physical_rollback', 'database_cas', 'handoff_removed', 'before_open']) {
    let thrown = false;
    await assert.rejects(v.execute({ afterStage(current: string) { if (!thrown && current === stage) { thrown = true; throw new Error(`crash:${stage}`); } } }),
      new RegExp(`crash:${stage}`));
    assert.equal(thrown, true); assert.equal(v.runtime.child.exitCode, null); assert.equal(fs.statSync(v.database.path).ino, inode);
  }
  const result = await v.execute(); assert.equal(result.dryRun, false);
  assert.equal((await v.execute()).reused, true); assert.equal(v.runtime.child.exitCode, null);
  assert.equal(fs.statSync(`/proc/${pid}`).isDirectory(), true); assert.equal(fs.statSync(v.database.path).ino, inode);
  assert.equal((v.db.prepare("SELECT state FROM source_update_jobs WHERE id='job-manual'").get() as { state: string }).state, 'rolled_back');
  assert.deepEqual(v.db.prepare('SELECT * FROM users ORDER BY id').all(), users);
  for (const [key, name] of Object.entries({ client: 'dist', server: 'dist-server', nodeModules: 'node_modules' }))
    assert.deepEqual(hashTree(path.join(v.root, name)), v.binding.previousRuntime.actualTrees[key]);
  const journal = JSON.parse(fs.readFileSync(path.join(v.control, 'journal.json'), 'utf8'));
  assert.equal(journal.state, 'OPEN'); assert.equal(journal.databaseState, 'PRE_CANDIDATE');
  assert.equal(fs.existsSync(path.join(v.control, 'bootstrap-handoff.json')), false);
});

test('every per-generation exchange and completion crash replays safely', async t => {
  for (const hook of ['afterExchange', 'afterStep'] as const) {
    for (const generation of ['client', 'server', 'nodeModules']) await t.test(`${hook}:${generation}`, async child => {
      const v = await manualFixture(child); let injected = false;
      await assert.rejects(v.execute({ [hook](name: string) { if (!injected && name === generation) {
        injected = true; throw new Error(`crash:${hook}:${generation}`); } } }), new RegExp(`crash:${hook}:${generation}`));
      assert.equal(injected, true); assert.equal(v.runtime.child.exitCode, null);
      await v.execute();
      assert.equal((v.db.prepare("SELECT state FROM source_update_jobs WHERE id='job-manual'").get() as { state: string }).state, 'rolled_back');
      for (const [key, name] of Object.entries({ client: 'dist', server: 'dist-server', nodeModules: 'node_modules' }))
        assert.deepEqual(hashTree(path.join(v.root, name)), v.binding.previousRuntime.actualTrees[key]);
    });
  }
});

test('health is re-read after rollback and immediately before opening the gate', async t => {
  await t.test('stale target health before CAS cannot settle metadata', async child => {
    const v = await manualFixture(child); let reads = 0;
    await assert.rejects(v.execute({ readHealth: async () => {
      reads += 1; const health = v.currentHealth();
      return reads === 2 ? { ...health, clientBuildIdServed: clientBuild } : health;
    } }), /runtime_previous_changed/);
    assert.equal(reads, 2);
    assert.equal((v.db.prepare("SELECT state FROM source_update_jobs WHERE id='job-manual'").get() as { state: string }).state, 'manual_recovery_required');
    await v.execute();
  });
  await t.test('changed process before OPEN leaves the gate closed and replays', async child => {
    const v = await manualFixture(child); let reads = 0;
    await assert.rejects(v.execute({ readHealth: async () => {
      reads += 1; const health = v.currentHealth();
      return reads === 3 ? { ...health, serverProcessStartTicks: `${Number(health.serverProcessStartTicks) + 1}` } : health;
    } }), /runtime_previous_changed/);
    assert.equal(reads, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.control, 'journal.json'), 'utf8')).state, 'MANUAL');
    await v.execute();
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.control, 'journal.json'), 'utf8')).state, 'OPEN');
  });
});
