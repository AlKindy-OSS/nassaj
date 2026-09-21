/** Synthetic private packet fixture; never an operational approval. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const Database = createRequire(import.meta.url)('better-sqlite3');
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { enqueuePreviewEvent } from '../preview-oid-consumer.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const writeFixtureFile = (file, bytes) => fs.writeFileSync(file, bytes, { mode: 0o644 });
export function bootstrapFixture(t) {
    const root = fs.mkdtempSync('/var/tmp/bootstrap-publication-'); fs.chmodSync(root, 0o700);
    t.after(() => { stopBootstrapTestRuntime(root); fs.rmSync(root, { recursive: true, force: true }); });
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Synthetic Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    writeFixtureFile(path.join(root, 'input'), 'fixture'); git('add', 'input'); git('commit', '-qm', 'fixture');
    const oid = git('rev-parse', 'HEAD'), sequence = 31, group = `event-${String(sequence).padStart(16, '0')}`;
    writeFixtureFile(path.join(root, '.env'), 'NASSAJ_UPDATE_MODE=release\n');
    const { scope, packet, packetFile, writePacket } = writeBootstrapTestPacket(root, { oid, sequence });
    enqueuePreviewEvent(root, { sequence, oid, domains: ['client', 'server'] });
    return { root, oid, sequence, group, scope, packet, packetFile, writePacket, git };
}

/** Bind an existing synthetic Git fixture to an explicit bootstrap target. */
export function writeBootstrapTestPacket(root, { oid, sequence, clientBuildId = hash('client'), serverBuildId = hash('server') }) {
    const group = `event-${String(sequence).padStart(16, '0')}`;
    const folder = path.join(root, 'private-packet'); fs.mkdirSync(folder, { mode: 0o700, recursive: true });
    const packetFile = path.join(folder, 'packet.json');
    const databaseDirectory = fs.mkdtempSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.artifacts/bootstrap-test-db-'));
    fs.chmodSync(databaseDirectory, 0o700);
    const database = path.join(databaseDirectory, 'synthetic.sqlite');
    const db = new Database(database);
    db.exec('CREATE TABLE IF NOT EXISTS pending_server_actions (id TEXT PRIMARY KEY, action_type TEXT, expected_server_build_id TEXT, status TEXT)');
    db.prepare('INSERT OR REPLACE INTO pending_server_actions VALUES (?, ?, ?, ?)').run(`synthetic-action-${sequence}`, 'safe-restart', serverBuildId, 'pending'); db.close();
    fs.chmodSync(database, 0o600); const dbStat = fs.statSync(database);
    const dependencies = path.join(root, 'node_modules');
    if (!fs.existsSync(dependencies)) fs.symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules'), dependencies, 'dir');
    const configBinding = { schema: 'nassaj-bootstrap-config-binding/v1', root, oid,
        approvalReference: 'synthetic:test-only', reservationReference: 'synthetic:test-only',
        database: { path: database, dev: dbStat.dev, ino: dbStat.ino, uid: dbStat.uid } };
    const runtime = startBootstrapTestRuntime(root, database);
    const scope = { schema: 'nassaj-bootstrap-publication/v1', root, oid, sequence, group,
        serviceUid: process.getuid(), nodeIdentity: os.hostname(), ...runtime, clientBuildId, serverBuildId,
        oldLoadedBuildId: hash('old'), oldCapsuleSha256: hash('capsule'), oldSafeRestartSha256: hash('safe'),
        configBindingSha256: hash(JSON.stringify(configBinding)), approvalReference: configBinding.approvalReference, reservationReference: configBinding.reservationReference };
    const packet = { schema: 'nassaj-bootstrap-operation-packet/v1', configBinding, bootstrapPublication: scope };
    const writePacket = () => fs.writeFileSync(packetFile, `${JSON.stringify(packet)}\n`, { mode: 0o600 }); writePacket();
    return { scope, packet, packetFile, writePacket };
}

const runtimes = new Map();
process.once('exit', () => { for (const root of runtimes.keys()) stopBootstrapTestRuntime(root); });
/** Stop only the synthetic HTTP child created for this fixture. */
export function stopBootstrapTestRuntime(root) {
    const value = runtimes.get(root); value?.child.kill();
    if (value?.databaseDirectory) fs.rmSync(value.databaseDirectory, { recursive: true, force: true });
    runtimes.delete(root);
}
function startBootstrapTestRuntime(root, database) {
    if (runtimes.has(root)) return runtimes.get(root).identity;
    const live = path.join(root, 'dist-server'); fs.mkdirSync(path.join(live, 'scripts'), { recursive: true, mode: 0o755 });
    writeFixtureFile(path.join(live, 'OID_CONTROL_CAPSULE.mjs'), 'capsule');
    writeFixtureFile(path.join(live, 'scripts/safe-restart.sh'), 'safe');
    writeFixtureFile(path.join(live, 'BUILD_PROVENANCE.json'), JSON.stringify({ buildId: hash('old') }));
    writeFixtureFile(path.join(live, 'OID_CONTROL_MANIFEST.json'), JSON.stringify({ serverBuildId: hash('old'), capsuleSha256: hash('capsule'), safeRestartSha256: hash('safe') }));
    const ready = path.join(root, 'private-packet/runtime-ready.json');
    // Publish complete JSON before the parent can observe the readiness path.
    const code = `const fs=require('fs'),http=require('http');fs.openSync(process.argv[3],'r');const ticks=fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19];const server=http.createServer((q,r)=>{r.end(JSON.stringify({status:'ok',pid:process.pid,serverProcessStartTicks:ticks,serverLoadedBuildId:process.argv[2]}));});server.listen(0,'127.0.0.1',()=>{const pending=process.argv[1]+'.tmp';fs.writeFileSync(pending,JSON.stringify({oldPid:process.pid,oldStartTicks:ticks,healthOrigin:'http://127.0.0.1:'+server.address().port}),{flag:'wx',mode:0o644});fs.renameSync(pending,process.argv[1]);});`;
    const child = spawn(process.execPath, ['-e', code, ready, hash('old'), database], { cwd: root, stdio: 'ignore' }); child.unref();
    const end = Date.now() + 3000;
    while (!fs.existsSync(ready) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (!fs.existsSync(ready)) { child.kill(); throw Error('synthetic runtime did not start'); }
    const identity = JSON.parse(fs.readFileSync(ready)); runtimes.set(root, { child, identity, databaseDirectory: path.dirname(database) }); return identity;
}
