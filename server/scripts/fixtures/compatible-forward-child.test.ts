// Test-only dedicated process. This verifier is deliberately not a production host capability.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { migrateCompatibleForwardPermissionReceipt } from '@/modules/database/compatible-forward-permission-receipt.migration.js';

import { observeCompatibleForwardDatabase, runCompatibleForwardMigration, readCompatibleForwardTarget } from '../release-database-migration.js';

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const [scenario, root = ''] = process.argv.slice(2);
const filename = path.join(root, 'fixture.sqlite');
const fixture = JSON.parse(fs.readFileSync(new URL('./compatible-forward-schema-v1.json', import.meta.url), 'utf8'));
const childArgs = (mode: string) => ['--import', 'tsx', fileURLToPath(import.meta.url), mode, root];

if (scenario === 'lock') {
  const db = new Database(filename); db.exec('BEGIN IMMEDIATE');
  process.send?.('locked'); process.on('message', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
} else if (scenario) {
  await exercise();
}

async function exercise() {
  if (scenario !== 'crash-after-commit') initialize();
  const { request, contract } = JSON.parse(fs.readFileSync(path.join(root, 'context.json'), 'utf8'));
  const accepted = { requestSha256: digest(request), transactionId: request.transactionId,
    databaseContractSha256: request.databaseContractSha256 };
  // Reading this fixture file models verified host input only; it is NOT an authorization implementation.
  const verify = () => ({ contract, requestSha256: digest(request),
    priorAcceptedIntent: fs.existsSync(path.join(root, 'accepted.json'))
      ? JSON.parse(fs.readFileSync(path.join(root, 'accepted.json'), 'utf8')) : undefined });
  const run = () => runCompatibleForwardMigration(request, verify);
  if (scenario === 'crash-after-commit') { run(); process.exit(73); }
  if (scenario === 'observation-seed') {
    const result = run(); fs.chmodSync(filename, 0o600);
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    fs.writeFileSync(path.join(root, 'seed-result.json'), JSON.stringify({ result, process: {pid:process.pid,
      startTicks:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19], bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()} }), {mode:0o600});
  } else if (scenario.startsWith('observe-')) {
    run(); fs.chmodSync(filename, 0o600);
    if (scenario === 'observe-identity') request.database.inode = String(BigInt(request.database.inode) + 1n);
    if (scenario === 'observe-drift') { const changed = new Database(filename); changed.exec('CREATE TABLE observation_drift(id INTEGER)'); changed.close(); }
    if (scenario === 'observe-hot-journal') fs.writeFileSync(`${filename}-journal`, 'hot');
    if (scenario === 'observe-hardlink') fs.linkSync(filename, `${filename}-wal`);
    if (scenario === 'observe-symlink') fs.symlinkSync(filename, `${filename}-wal`);
    if (scenario === 'observe-mode') fs.writeFileSync(`${filename}-wal`, '', {mode:0o644});
    if (scenario === 'observe-sidecars') {
      const wal = new Database(filename); wal.pragma('journal_mode = WAL'); wal.close();
      assert.equal(fs.existsSync(`${filename}-wal`), false);
    }
    if (scenario === 'observe-postmode') {
      const original = fs.fstatSync;
      fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => {
        const value = Reflect.apply(original, fs, args);
        if (String(value.ino) === request.database.inode) fs.chmodSync(filename, 0o644);
        return value;
      }) as typeof fs.fstatSync;
    }
    const bytesBefore = fs.readFileSync(filename);
    if (scenario === 'observe-target' || scenario === 'observe-sidecars') {
      const observed = readCompatibleForwardTarget(request, verify);
      assert.deepEqual(observed.observedTarget, contract.target);
      assert.equal(observed.schema, 'nassaj-compatible-forward-target-observation/v1');
      assert.deepEqual(fs.readFileSync(filename), bytesBefore);
      if (scenario === 'observe-sidecars') for (const suffix of ['-wal', '-shm']) {
        const stat = fs.lstatSync(filename + suffix); assert.ok(stat.isFile()); assert.equal(stat.nlink, 1); assert.equal(stat.mode & 0o777, 0o600);
      }
    } else assert.throws(() => readCompatibleForwardTarget(request, verify), /identity_changed|target_drift|rollback_journal|existing_startup_/);
  } else if (scenario === 'applied') {
    assert.equal(run().outcome, 'applied');
    assert.throws(run, /target_without_original_intent/);
    fs.writeFileSync(path.join(root, 'accepted.json'), JSON.stringify({ ...accepted, transactionId: 'different-transaction' }));
    assert.throws(run, /target_without_original_intent/);
    fs.writeFileSync(path.join(root, 'accepted.json'), JSON.stringify(accepted));
    assert.equal(run().outcome, 'already_applied');
  } else if (scenario === 'old-contract') {
    contract.migrationId='pending-server-action-attempt-nonce/v1';
    contract.observationPolicy='nonce-metadata-presence/v1';
    request.databaseContractSha256=digest(contract);
    assert.throws(run,/verified_context_mismatch/);
    const db=new Database(filename);assert.deepEqual(observeCompatibleForwardDatabase(db),contract.source);db.close();
  } else if (scenario === 'crash') {
    fs.writeFileSync(path.join(root, 'accepted.json'), JSON.stringify(accepted));
    const fd = fs.openSync(path.join(root, 'accepted.json'), 'r'); fs.fsyncSync(fd); fs.closeSync(fd);
    const directoryFd = fs.openSync(root, 'r'); fs.fsyncSync(directoryFd); fs.closeSync(directoryFd);
    const result = spawnSync(process.execPath, childArgs('crash-after-commit'), { env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 73, result.stderr);
    assert.equal(run().outcome, 'already_applied');
  } else if (scenario === 'preexisting-fd') {
    const fd = fs.openSync(filename, 'r');
    try { assert.throws(run, /descriptor_preexisting/); } finally { fs.closeSync(fd); }
  } else if (scenario === 'ambiguity' || scenario === 'path-drift') {
    const original = fs.readdirSync; let inventories = 0; let extraFd: number | undefined;
    fs.readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
      if (args[0] === '/proc/self/fd' && ++inventories === 2) {
        if (scenario === 'ambiguity') extraFd = fs.openSync(filename, 'r');
        else { fs.renameSync(filename, `${filename}.old`); fs.writeFileSync(filename, 'replacement'); }
      }
      return Reflect.apply(original, fs, args);
    }) as typeof fs.readdirSync;
    try { assert.throws(run, scenario === 'ambiguity' ? /descriptor_ambiguous/ : /identity_changed/); }
    finally { fs.readdirSync = original; if (extraFd !== undefined) fs.closeSync(extraFd); }
  } else if (scenario === 'identity') {
    request.database.inode = (BigInt(request.database.inode) + 1n).toString();
    assert.throws(run, /identity_changed/);
  } else if (scenario === 'source-drift' || scenario === 'marker-drift' || scenario === 'nonce-drift') {
    const db = new Database(filename);
    if (scenario === 'source-drift') db.exec('CREATE INDEX fixture_drift ON app_config(key)');
    if (scenario === 'marker-drift') db.prepare('DELETE FROM app_config WHERE key = ?').run(fixture.markers[0].key);
    if (scenario === 'nonce-drift') db.exec('ALTER TABLE pending_server_actions ADD COLUMN execution_attempt_nonce INTEGER');
    db.close(); assert.throws(run, /source_drift/);
  } else if (scenario === 'target-drift') {
    contract.target.schemaDigest = '0'.repeat(64); request.databaseContractSha256 = digest(contract);
    assert.throws(run, /target_drift/);
    const db = new Database(filename);
    assert.deepEqual(observeCompatibleForwardDatabase(db), contract.source); db.close();
  } else if (scenario === 'busy') {
    const lock = spawn(process.execPath, childArgs('lock'), { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    try {
      await new Promise<void>((resolve, reject) => { lock.once('message', () => resolve()); lock.once('error', reject);
        lock.once('exit', code => reject(new Error(`lock child exited ${code}`))); });
      assert.throws(run, /migration_deferred/);
    } finally { lock.send('release'); await new Promise(resolve => lock.once('exit', resolve)); }
    assert.equal(run().outcome, 'applied');
  } else if (scenario === 'metadata-only') {
    const db = new Database(filename); const before = observeCompatibleForwardDatabase(db);
    db.prepare('UPDATE app_config SET value = ?').run('different-private-value');
    db.prepare('INSERT INTO sessions(session_id, custom_name) VALUES (?, ?)').run('fixture-session', 'private session name');
    db.prepare('UPDATE sessions SET custom_name = ? WHERE session_id = ?').run('changed private name', 'fixture-session');
    db.prepare('INSERT INTO app_config(key,value) VALUES (?,?)').run('irrelevant-private-setting', 'private');
    assert.deepEqual(observeCompatibleForwardDatabase(db), before); db.close();
    assert.equal(run().outcome, 'applied');
    const after = new Database(filename);
    assert.deepEqual(after.prepare('SELECT custom_name FROM sessions WHERE session_id = ?').get('fixture-session'),
      { custom_name: 'changed private name' }); after.close();
  } else throw new Error(`Unknown fixture scenario ${scenario}`);
}

function initialize() {
  const db = new Database(filename);
  for (const type of ['table', 'index', 'view', 'trigger']) {
    for (const object of fixture.objects.filter((row: { type: string }) => row.type === type)) db.exec(object.sql);
  }
  for (const marker of fixture.markers) {
    if (marker.present) db.prepare('INSERT INTO app_config(key,value) VALUES (?,?)').run(marker.key, 'fixture-only');
  }
  const source = observeCompatibleForwardDatabase(db);
  assert.equal(source.schemaDigest, fixture.sourceSchemaDigest);
  assert.equal(fixture.objects.length, 349);
  db.exec('BEGIN'); migrateCompatibleForwardPermissionReceipt(db);
  const target = observeCompatibleForwardDatabase(db); db.exec('ROLLBACK'); db.close();
  const contract = { schema: 'nassaj-database-release-contract/v2', releaseIdentitySha256: '1'.repeat(64),
    migrationClosureSha256: '3'.repeat(64), migrationId: 'permission-receipt-forward/v1', observationPolicy: 'permission-receipt-metadata/v1', source, target,
    startup: { policyId: 'existing-security-state/v1', closureSha256: '2'.repeat(64) } };
  const stat = fs.statSync(filename, { bigint: true });
  const request = { schema: 'nassaj-compatible-forward-request/v1', transactionId: 'fixture-transaction-0001',
    releaseIdentitySha256: contract.releaseIdentitySha256, databaseContractSha256: digest(contract),
    database: { realpath: fs.realpathSync(filename), device: String(stat.dev), inode: String(stat.ino) }, expectedPhase: 'migration' };
  fs.writeFileSync(path.join(root, 'context.json'), JSON.stringify({ request, contract }));
}
