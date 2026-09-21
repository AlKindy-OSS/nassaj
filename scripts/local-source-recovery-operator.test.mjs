import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectLocalRecoveryRegistration } from './local-source-recovery-operator.mjs';
import { openVerifiedRecoveryDatabase, recoveryDatabaseSchemaSha256 } from './local-source-recovery-operator.mjs';
import { createRequire } from 'node:module';
const Database = createRequire(import.meta.url)('better-sqlite3');

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(project, '.artifacts/recovery-operator-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const control = path.join(root, '.git/nassaj-source-update'); fs.mkdirSync(control, { recursive: true, mode: 0o700 });
    const packetPath = path.join(control, 'packet.json');
    const packet = { schema: 'nassaj-local-source-recovery-packet/v1', root, nodeIdentity: os.hostname(),
        serviceUid: process.getuid(), operation: 'register-prepared-recovery',
        operationBinding: { root, nodeIdentity: os.hostname(), previousRuntime: { pid: process.pid, startTicks: 'wrong' } } };
    const write = () => {
        const bytes = `${JSON.stringify(packet)}\n`; fs.writeFileSync(packetPath, bytes, { mode: 0o600 });
        return { root, packetPath, packetSha256: sha(bytes) };
    };
    return { root, packetPath, packet, write };
}

test('operator requires separately pinned bytes and exact registration scope', async t => {
    const value = fixture(t), original = value.write();
    await assert.rejects(inspectLocalRecoveryRegistration({ ...original, packetSha256: '0'.repeat(64) }), /file_changed/);
    value.packet.operation = 'restart';
    await assert.rejects(inspectLocalRecoveryRegistration(value.write()), /packet_scope/);
    value.packet.operation = 'register-prepared-recovery'; value.packet.nodeIdentity = 'foreign-node';
    await assert.rejects(inspectLocalRecoveryRegistration(value.write()), /packet_scope/);
});

test('operator refuses alias packet, permissive permissions and PID reuse before candidate or DB work', async t => {
    const value = fixture(t), options = value.write();
    await assert.rejects(inspectLocalRecoveryRegistration(options), /process_changed/);
    fs.chmodSync(value.packetPath, 0o644);
    await assert.rejects(inspectLocalRecoveryRegistration(options), /unsafe_file/);
    fs.chmodSync(value.packetPath, 0o600);
    const alias = `${value.packetPath}.alias`; fs.symlinkSync(value.packetPath, alias);
    await assert.rejects(inspectLocalRecoveryRegistration({ ...options, packetPath: alias }), /unsafe_file/);
    assert.deepEqual(fs.readdirSync(path.dirname(value.packetPath)).sort(), ['packet.json', 'packet.json.alias']);
});

test('existing-only SQLite opening enables FK without app_config, migration or journal conversion', t => {
    const value = fixture(t), file = path.join(value.root, 'private.sqlite'), original = new Database(file);
    for (const table of ['users','source_update_jobs','source_update_receipts','source_update_effects','source_update_control','pending_server_actions'])
        original.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    const schemaSha256 = recoveryDatabaseSchemaSha256(original), journal = original.pragma('journal_mode', { simple: true }); original.close();
    fs.chmodSync(file, 0o600); const stat = fs.statSync(file), before = fs.readFileSync(file);
    const identity = { path: file, dev: stat.dev, ino: stat.ino, uid: stat.uid, schemaSha256 };
    const db = openVerifiedRecoveryDatabase(identity);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('journal_mode', { simple: true }), journal);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='app_config'").get(), undefined); db.close();
    assert.deepEqual(fs.readFileSync(file), before);
    assert.throws(() => openVerifiedRecoveryDatabase({ ...identity, path: `${file}.missing` }));
    assert.equal(fs.existsSync(`${file}.missing`), false);
    assert.throws(() => openVerifiedRecoveryDatabase({ ...identity, ino: identity.ino + 1 }), /database_file_changed/);
    assert.throws(() => openVerifiedRecoveryDatabase({ ...identity, schemaSha256: '0'.repeat(64) }), /database_schema_changed/);
    fs.symlinkSync(file, `${file}-wal`);
    assert.throws(() => openVerifiedRecoveryDatabase(identity), /database_file_changed/);
    assert.deepEqual(fs.readFileSync(file), before);
});
