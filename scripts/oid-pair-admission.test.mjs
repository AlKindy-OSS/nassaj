import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createUpdateMaintenanceGate } from '../server/services/update-maintenance-gate.js';
import { beginOidPairAdmission, completeOidPairAdmission, hashOidPairTree, hashOidPairDependencyTree, captureOidPairSnapshot } from './oid-control-capsule.mjs';
import { readDatabaseSnapshot } from './lib/source-update-database-snapshot.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function fixture(t) {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-pair-admission-'));
    t.after(() => {
        try { process.kill(JSON.parse(fs.readFileSync(path.join(root, 'child-ready.json'))).pid, 'SIGTERM'); } catch {}
        fs.rmSync(root, { recursive: true, force: true });
    });
    git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
    fs.writeFileSync(path.join(root, 'a'), 'a');
    fs.writeFileSync(path.join(root, 'package.json'), '{}'); fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    git(root, 'add', 'a', 'package.json', 'package-lock.json'); git(root, 'commit', '-qm', 'initial');
    fs.mkdirSync(path.join(root, 'node_modules'));
    const oid = git(root, 'rev-parse', 'HEAD');
    for (const [directory, artifact, buildId] of [['dist', 'client', 'a'.repeat(64)], ['dist-server', 'server', 'b'.repeat(64)]]) {
        fs.mkdirSync(path.join(root, directory));
        fs.writeFileSync(path.join(root, directory, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact, commit: oid, baseCommit: oid, dirty: false, buildId }));
    }
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const nonce = 'c'.repeat(64);
    const identity = { sequence: 1, group: 'event-0000000000000001', oid, transactionNonce: nonce, targetDigest: 'd'.repeat(64),
        journalBasename: `nassaj-oid-control-transaction-1-${nonce}.json`, targetClientBuildId: 'a'.repeat(64), targetServerBuildId: 'b'.repeat(64) };
    const target = { clientBuildId: identity.targetClientBuildId, serverBuildId: identity.targetServerBuildId,
        clientTreeSha256: hashOidPairTree(path.join(root, 'dist')), serverTreeSha256: hashOidPairTree(path.join(root, 'dist-server')) };
    const journal = { schema: 'nassaj-oid-control-transaction/v1', sequence: 1, oid, transactionNonce: nonce, state: 'pair_prepared',
        pair: { targetDigest: identity.targetDigest, target } };
    const journalFile = path.join(root, '.git', identity.journalBasename);
    fs.writeFileSync(journalFile, JSON.stringify(journal), { mode: 0o600 });
    const oldMode = process.env.NASSAJ_UPDATE_MODE; process.env.NASSAJ_UPDATE_MODE = 'local-main';
    t.after(() => { if (oldMode === undefined) delete process.env.NASSAJ_UPDATE_MODE; else process.env.NASSAJ_UPDATE_MODE = oldMode; });
    return { root, gate, identity, journal, journalFile };
}

test('activity held by a previous writer blocks quiescence without creating a deadlock', async t => {
    const v = fixture(t);
    const writer = await v.gate.acquireWriterLease({ kind: 'test-reader' });
    const pending = beginOidPairAdmission(v.root, v.identity, { waitMs: 1500 });
    await new Promise(resolve => setTimeout(resolve, 70));
    assert.equal(v.gate.readPublicStatus().gateClosed, true);
    writer.release();
    const handle = await pending;
    try {
        assert.equal(handle.journal.phase, 'OID_QUIESCENT');
        assert.equal((await v.gate.recoverOrDeclareManual()).reason, 'oid_pair_owner_alive_or_unknown');
        await assert.rejects(v.gate.claimBootstrapOwnership(), /oid_pair_source_path_refused/);
        await assert.rejects(v.gate.reopenOnPreviousGeneration(), /oid_pair_source_path_refused/);
    } finally { handle.release(); }
});

test('OPEN requires terminal receipt and unchanged pair; completion is idempotent', async t => {
    const v = fixture(t), handle = await beginOidPairAdmission(v.root, v.identity);
    try {
        assert.throws(() => completeOidPairAdmission(v.root, handle), /terminal_required/);
        v.journal.state = 'pair_served';
        v.journal.pair.receipt = { outcome: 'activated', transactionNonce: v.identity.transactionNonce,
            targetDigest: v.identity.targetDigest, clientBuildId: v.identity.targetClientBuildId, serverBuildId: v.identity.targetServerBuildId };
        const receiptFile = path.join(v.root, '.git', `nassaj-oid-pair-receipt-${v.identity.transactionNonce}.json`);
        const bytes = JSON.stringify(v.journal.pair.receipt);
        fs.writeFileSync(receiptFile, bytes, { mode: 0o600 });
        v.journal.pair.receiptSha256 = sha(bytes);
        fs.writeFileSync(v.journalFile, JSON.stringify(v.journal));
        const opened = completeOidPairAdmission(v.root, handle);
        assert.equal(opened.gateClosed, false);
        assert.deepEqual(completeOidPairAdmission(v.root, handle), opened);
        fs.writeFileSync(v.journalFile, '{}');
        assert.throws(() => v.gate.readPublicStatus(), /counterpart_mismatch/);
    } finally { handle.release(); }
});

test('sealed SQLite snapshot is readable by existing capture contract and checks current owner', async t => {
    const { DatabaseSync } = await import('node:sqlite');
    const v = fixture(t), file = path.join(v.root, 'db.sqlite');
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,status TEXT); INSERT INTO users VALUES(1,'owner',1,'active');");
    db.close(); fs.chmodSync(file, 0o600);
    const identity = { ...v.identity, ownerId: '1', actionId: 'a-test-action' };
    const snapshot = await captureOidPairSnapshot(file, identity);
    const read = readDatabaseSnapshot({ databasePath: file, snapshotRoot: path.dirname(snapshot.snapshotDir),
        transactionId: identity.transactionNonce, targetCommit: identity.oid, actionId: identity.actionId });
    assert.equal(read.snapshotFingerprint.sha256, snapshot.snapshotFingerprint.sha256);
    await assert.rejects(captureOidPairSnapshot(file, { ...identity, ownerId: '2', transactionNonce: 'f'.repeat(64) }), /owner_not_authorized/);
});

async function preparedTransaction(t) {
    const { DatabaseSync } = await import('node:sqlite');
    const { prepareLocalUpdate, completeLocalUpdatePreparation, confirmLocalUpdate } = await import('./lib/local-update-control.mjs');
    const v = fixture(t);
    fs.unlinkSync(v.journalFile);
    const manifest = { capabilities: { oidPairAdmissionV1: true }, oid: v.identity.oid, runtimeDependenciesSha256: hashOidPairDependencyTree(path.join(v.root, 'node_modules')) };
    fs.writeFileSync(path.join(v.root, 'dist-server/OID_CONTROL_MANIFEST.json'), JSON.stringify(manifest), { mode: 0o444 });
    for (const [domain, buildId] of [['client', 'e'.repeat(64)], ['server', 'f'.repeat(64)]]) {
        const dir = path.join(v.root, '.nassaj-local-preview', `${domain}-candidates`, buildId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: domain, commit: v.identity.oid,
            baseCommit: v.identity.oid, dirty: false, buildId }));
        fs.writeFileSync(path.join(dir, 'new-version'), domain);
        if (domain === 'server') fs.writeFileSync(path.join(dir, 'OID_CONTROL_MANIFEST.json'), JSON.stringify(manifest), { mode: 0o444 });
    }
    const state = await prepareLocalUpdate(v.root, { mode: 'local-main', expectedOid: v.identity.oid, ownerId: '1', idempotencyKey: 'pair-request' });
    const prepared = await completeLocalUpdatePreparation(v.root, state.sequence, { clientBuildId: 'e'.repeat(64), serverBuildId: 'f'.repeat(64) });
    await confirmLocalUpdate(v.root, { mode: 'local-main', sequence: state.sequence, expectedRevision: prepared.revision, targetDigest: prepared.targetDigest, ownerId: '1' });
    const databasePath = path.join(v.root, 'db.sqlite'), db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,status TEXT); INSERT INTO users VALUES(1,'owner',1,'active');");
    db.close(); fs.chmodSync(databasePath, 0o600);
    const record = { repoRoot: v.root, liveRoot: path.join(v.root, 'dist-server'), transactionNonce: v.identity.transactionNonce,
        actionId: '11111111-1111-1111-1111-111111111111', pair: { sequence: state.sequence, ownerId: '1', targetDigest: prepared.targetDigest, databasePath },
        handshakePath: path.join(v.root, '.git', 'nassaj-test-pair-handshake.json'), capsuleModeAbi: 'nassaj-capsule-roots/v1' };
    const http = await import('node:http');
    let previousHealthy = true;
    const previousServer = http.createServer((req,res) => {
        if(req.url === '/test-shutdown') { res.end('bye'); previousServer.close(); return; }
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({ pid: previousHealthy ? process.pid : -1,
            serverProcessStartTicks: fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19],
            serverLoadedOid: v.identity.oid, serverLoadedBuildId:'b'.repeat(64), clientBuildIdServed:'a'.repeat(64) }));
    });
    await new Promise(resolve => previousServer.listen(0,'127.0.0.1',resolve));
    const oldHealth = process.env.NASSAJ_PREVIEW_HEALTH_URL;
    process.env.NASSAJ_PREVIEW_HEALTH_URL = `http://127.0.0.1:${previousServer.address().port}/health`;
    t.after(() => { previousServer.closeAllConnections(); previousServer.close();
        if (oldHealth === undefined) delete process.env.NASSAJ_PREVIEW_HEALTH_URL; else process.env.NASSAJ_PREVIEW_HEALTH_URL=oldHealth; });
    return { ...v, record, previousPort: previousServer.address().port, invalidatePreviousRuntime: () => { previousHealthy = false; } };
}

test('failure after first exchange restores the proven previous pair without starting candidate DB', async t => {
    const { runOidPairTransaction } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    const oldEnv = process.env.NODE_ENV, oldPoint = process.env.NASSAJ_OID_CAPSULE_FAIL_AT;
    process.env.NODE_ENV = 'test'; process.env.NASSAJ_OID_CAPSULE_FAIL_AT = 'pair_after_client_exchange';
    try {
        await assert.rejects(runOidPairTransaction(v.record, Buffer.from('exit 1\n')), /injected_failure/);
        assert.equal(v.gate.readPublicStatus().gateClosed, false);
        assert.equal(v.gate.readRecoveryEvidence().databaseState, 'PRE_CANDIDATE');
        assert.equal(JSON.parse(fs.readFileSync(path.join(v.root, 'dist-server/BUILD_PROVENANCE.json'))).buildId, 'b'.repeat(64));
    } finally {
        if (oldEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldEnv;
        if (oldPoint === undefined) delete process.env.NASSAJ_OID_CAPSULE_FAIL_AT; else process.env.NASSAJ_OID_CAPSULE_FAIL_AT = oldPoint;
    }
});

test('restart failure after UNKNOWN never rolls back either binary or opens admission', async t => {
    const { runOidPairTransaction } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    await assert.rejects(runOidPairTransaction(v.record, Buffer.from('exit 1\n')), /restart_unverified/);
    assert.equal(v.gate.readPublicStatus().gateClosed, true);
    assert.equal(v.gate.readRecoveryEvidence().databaseState, 'UNKNOWN');
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.root, 'dist-server/BUILD_PROVENANCE.json'))).buildId, 'f'.repeat(64));
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.root, 'dist/BUILD_PROVENANCE.json'))).buildId, 'e'.repeat(64));
});

test('revoked owner cannot exchange generations and pre-effect refusal restores admission', async t => {
    const { DatabaseSync } = await import('node:sqlite');
    const { runOidPairTransaction } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t), db = new DatabaseSync(v.record.pair.databasePath);
    db.exec('UPDATE users SET is_active=0 WHERE id=1'); db.close();
    await assert.rejects(runOidPairTransaction(v.record, Buffer.from('exit 1\n')), /owner_not_authorized/);
    assert.equal(v.gate.readPublicStatus().gateClosed, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.root, 'dist/BUILD_PROVENANCE.json'))).buildId, 'a'.repeat(64));
});

test('health-only child grant does not reacquire parent EX locks and waits for a verified OPEN', async t => {
    const { spawn } = await import('node:child_process');
    const v = fixture(t);
    fs.mkdirSync(path.join(v.root, 'dist-server/server'));
    fs.writeFileSync(path.join(v.root, 'dist-server/server/application.js'), 'export {};');
    const manifest = JSON.stringify({ capabilities: { oidPairAdmissionV1: true }, oid: v.identity.oid, runtimeDependenciesSha256: hashOidPairDependencyTree(path.join(v.root, 'node_modules')) });
    fs.writeFileSync(path.join(v.root, 'dist-server/OID_CONTROL_MANIFEST.json'), manifest, { mode: 0o444 });
    v.journal.pair.target.serverTreeSha256 = hashOidPairTree(path.join(v.root, 'dist-server'));
    v.journal.pair.target.controlManifestSha256 = sha(manifest);
    v.journal.state = 'pair_bootstrap_verifying'; v.journal.pair.databaseState = 'UNKNOWN';
    const { DatabaseSync } = await import('node:sqlite');
    const databasePath = path.join(v.root, 'child-db.sqlite'), db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,status TEXT); INSERT INTO users VALUES(1,'owner',1,'active');");
    db.close(); fs.chmodSync(databasePath, 0o600);
    v.journal.pair.snapshot = await captureOidPairSnapshot(databasePath, { ...v.identity, actionId: 'child-test-action', ownerId: '1' });
    fs.writeFileSync(v.journalFile, JSON.stringify(v.journal));
    const handle = await beginOidPairAdmission(v.root, v.identity);
    handle.transition({ phase: 'OID_BOOTSTRAP_VERIFYING', databaseState: 'UNKNOWN' });
    const moduleUrl = new URL('./oid-control-capsule.mjs', import.meta.url).href;
    const script = `import {inspectOidBootstrapAdmission} from ${JSON.stringify(moduleUrl)};
        const c=inspectOidBootstrapAdmission(process.env.TEST_ROOT,process.env.TEST_ROOT+'/dist-server/server/application.js',process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE,{databasePath:process.env.TEST_DATABASE});
        process.stdout.write('granted\\n'); await c.waitForOpen({timeoutMs:5000}); process.stdout.write('open\\n');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TEST_ROOT: v.root,
        NASSAJ_PREVIEW_TRANSACTION_NONCE: v.identity.transactionNonce, TEST_DATABASE: databasePath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { error += data; });
    const ended = new Promise(resolve => child.once('exit', code => resolve(code)));
    try {
        const deadline = Date.now() + 2000;
        while (!output.includes('granted') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.match(output, /granted/, error);
        assert.equal(output.includes('open'), false);
        const grant = JSON.parse(fs.readFileSync(path.join(handle.paths.controlRoot, `oid-child-${v.identity.transactionNonce}.json`)));
        assert.equal(grant.pid, child.pid);
        v.journal.state = 'pair_served';
        v.journal.pair.receipt = { outcome: 'activated', transactionNonce: v.identity.transactionNonce, targetDigest: v.identity.targetDigest,
            clientBuildId: v.identity.targetClientBuildId, serverBuildId: v.identity.targetServerBuildId };
        const bytes = JSON.stringify(v.journal.pair.receipt);
        fs.writeFileSync(path.join(v.root, '.git', `nassaj-oid-pair-receipt-${v.identity.transactionNonce}.json`), bytes, { mode: 0o600 });
        v.journal.pair.receiptSha256 = sha(bytes);
        fs.writeFileSync(v.journalFile, JSON.stringify(v.journal));
        completeOidPairAdmission(v.root, handle);
        assert.equal(await ended, 0, error);
        assert.match(output, /open/);
    } finally { handle.release(); if (child.exitCode === null) child.kill(); }
});

test('installed dependency drift is refused before admission or exchange', async t => {
    const { runOidPairTransaction } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    fs.writeFileSync(path.join(v.root, 'node_modules', 'changed-module.js'), 'changed');
    await assert.rejects(runOidPairTransaction(v.record, Buffer.from('exit 1\n')), /dependency_baseline_unverified/);
    assert.equal(v.gate.readPublicStatus().gateClosed, false);
});

test('dependency baseline contains internal executable links and rejects escaping links', t => {
    const v = fixture(t), modules = path.join(v.root, 'node_modules');
    fs.mkdirSync(path.join(modules, 'pkg')); fs.mkdirSync(path.join(modules, '.bin'));
    fs.writeFileSync(path.join(modules, 'pkg', 'cli.js'), 'code');
    fs.symlinkSync('../pkg/cli.js', path.join(modules, '.bin', 'cli'));
    const before = hashOidPairDependencyTree(modules);
    fs.writeFileSync(path.join(modules, 'pkg', 'cli.js'), 'changed');
    assert.notEqual(hashOidPairDependencyTree(modules), before);
    fs.symlinkSync('../../package.json', path.join(modules, 'pkg', 'escape'));
    assert.throws(() => hashOidPairDependencyTree(modules), /dependency_link_unsafe/);
});

test('version-only changes preserve dependency contract while dependency changes do not', async () => {
    const { oidPairDependencyContract } = await import('./oid-control-capsule.mjs');
    const before = oidPairDependencyContract('{"version":"1","dependencies":{"a":"1"}}', '{"version":"1","packages":{"":{"version":"1"},"node_modules/a":{"version":"1"}}}');
    const after = oidPairDependencyContract('{"version":"2","dependencies":{"a":"1"}}', '{"version":"2","packages":{"":{"version":"2"},"node_modules/a":{"version":"1"}}}');
    assert.equal(before, after);
    assert.notEqual(before, oidPairDependencyContract('{"version":"2","dependencies":{"a":"2"}}', '{}'));
});

async function crashCapsule(value, point, safeBytes = 'exit 1\n', extraEnv = {}) {
    const { spawn } = await import('node:child_process');
    const url = new URL('./oid-control-capsule.mjs', import.meta.url).href;
    const source = `import {runOidPairTransaction} from ${JSON.stringify(url)}; await runOidPairTransaction(JSON.parse(process.env.TEST_PAIR_RECORD),Buffer.from(process.env.TEST_SAFE_BYTES));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: value.root,
        env: { ...process.env, NODE_ENV: 'test', NASSAJ_OID_CAPSULE_CRASH_AT: point, TEST_PAIR_RECORD: JSON.stringify(value.record), TEST_SAFE_BYTES: safeBytes, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', data => { error += data; });
    const result = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, error })));
    return result;
}

test('actual owner death after client exchange automatically restores both exact previous generations', async t => {
    const { recoverOidPairAdmission } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    const result = await crashCapsule(v, 'pair_after_client_exchange');
    assert.equal(result.signal, 'SIGKILL', result.error);
    assert.equal(v.gate.readPublicStatus().gateClosed, true);
    const recovered = await recoverOidPairAdmission(v.root);
    assert.equal(recovered.state, 'OPEN');
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.root, 'dist/BUILD_PROVENANCE.json'))).buildId, 'a'.repeat(64));
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.root, 'dist-server/BUILD_PROVENANCE.json'))).buildId, 'b'.repeat(64));
});

async function pairedProcessFixture(t) {
    const v = await preparedTransaction(t);
    const port = v.previousPort;
    const url = new URL('./oid-control-capsule.mjs', import.meta.url).href;
    const script = path.join(v.root, 'paired-child.mjs');
    const app = path.join(v.root, '.nassaj-local-preview/server-candidates', 'f'.repeat(64), 'server');
    fs.mkdirSync(app); fs.writeFileSync(path.join(app, 'application.js'), 'export {};');
    // Re-seal the fixture after adding its bootstrap application entry.
    const eventFile = path.join(v.root, '.git', 'nassaj-preview-oid-event-control-0000000000000001.json');
    const event = JSON.parse(fs.readFileSync(eventFile));
    event.localUpdate.target.serverTreeSha256 = hashOidPairTree(path.dirname(app));
    const state = event.localUpdate;
    state.targetDigest = sha(JSON.stringify({sequence:state.sequence,group:state.group,oid:state.oid,domains:state.domains,target:state.target}));
    state.consent.targetDigest = state.targetDigest; v.record.pair.targetDigest = state.targetDigest;
    fs.writeFileSync(eventFile, JSON.stringify(event));
    fs.writeFileSync(script, `import http from 'node:http'; import fs from 'node:fs'; import {DatabaseSync} from 'node:sqlite';
import {bootstrapServer} from ${JSON.stringify(new URL('../server/bootstrap.js',import.meta.url).href)};
import {createUpdateMaintenanceGate} from ${JSON.stringify(new URL('../server/services/update-maintenance-gate.js',import.meta.url).href)};
const root=process.env.TEST_CHILD_ROOT;process.env.DATABASE_PATH=root+'/db.sqlite';
const gate=createUpdateMaintenanceGate({projectPath:root});
await bootstrapServer({projectPath:root,gateModule:{createUpdateMaintenanceGate:()=>({...gate,
inspectOidBootstrapAdmission:()=>gate.inspectOidBootstrapAdmission(root+'/dist-server/server/application.js')})},loadServer:async()=>{
const grant=globalThis[Symbol.for('nassaj.oidPair.bootstrapAdmission.v1')];
if(!grant || grant.isOpen())throw Error('expected health-only grant before OPEN');
const db=new DatabaseSync(root+'/db.sqlite'); db.exec('CREATE TABLE IF NOT EXISTS candidate_init(value INTEGER)'); db.close();
let ready=false;
const ticks=fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19];
const server=http.createServer((req,res)=>{ if(req.url!='/health'){res.writeHead(ready?200:503);res.end('application');return;}
res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',pid:process.pid,normalAdmissionReady:ready,
serverLoadedOid:${JSON.stringify(v.identity.oid)},serverLoadedBuildId:'f'.repeat(64),clientBuildIdServed:'e'.repeat(64),serverProcessStartTicks:ticks,
serverTransactionNonce:process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE,serverBootNonce:process.env.NASSAJ_PREVIEW_BOOT_NONCE,oidPairTargetDigest:grant.targetDigest,oidPairTransactionNonce:process.env.NASSAJ_PREVIEW_TRANSACTION_NONCE}));});
await new Promise(resolve=>server.listen(${port},'127.0.0.1',resolve));fs.writeFileSync(root+'/child-ready.json',JSON.stringify({pid:process.pid}));
await grant.waitForOpen({timeoutMs:10000});ready=true;fs.writeFileSync(root+'/child-serving','true');
}});
`);
    const runner = path.join(v.root, 'paired-restart.mjs');
    fs.writeFileSync(runner, `import{spawn}from'node:child_process';import fs from'node:fs';const env={...process.env,TEST_CHILD_ROOT:${JSON.stringify(v.root)}};
const args=process.argv.slice(2);for(let i=0;i<args.length;i++)if(args[i]==='--set'){const[k,...v]=args[++i].split('=');if(!['TMPDIR','NASSAJ_PREVIEW_TRANSACTION_NONCE','NASSAJ_PREVIEW_BOOT_NONCE'].includes(k))throw Error('unexpected key');env[k]=v.join('=');}
await fetch('http://127.0.0.1:${port}/test-shutdown');
const child=spawn(process.execPath,[${JSON.stringify(script)}],{env,detached:true,stdio:'ignore'});child.unref();
for(let i=0;i<200;i++){if(fs.existsSync(${JSON.stringify(path.join(v.root,'child-ready.json'))}))process.exit(0);await new Promise(r=>setTimeout(r,20));}process.exit(1);
`);
    t.after(() => {
        try { const child=JSON.parse(fs.readFileSync(path.join(v.root,'child-ready.json')));process.kill(child.pid,'SIGTERM'); } catch {}
    });
    return { ...v, origin: `http://127.0.0.1:${port}`, safeBytes: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(runner)} "$@"\n` };
}

for (const crash of [false, true]) test(`real paired child serves only after OPEN${crash ? ' despite owner death at terminal seam' : ''}`, async t => {
    const v = await pairedProcessFixture(t);
    const result = await crashCapsule(v, crash ? 'pair_after_terminal' : '', v.safeBytes, { NASSAJ_PREVIEW_HEALTH_URL: `${v.origin}/health` });
    assert.equal(crash ? result.signal : result.code, crash ? 'SIGKILL' : 0, result.error);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(v.root,'child-serving')) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(fs.existsSync(path.join(v.root,'child-serving')),true);
    const proof=await (await fetch(`${v.origin}/health`)).json();
    assert.equal(proof.normalAdmissionReady,true);
    const { writeOidPairServingReceipt, readOidPairServingReceipt, reconcileOidPairServingReceipt } = await import('./oid-control-capsule.mjs');
    const outcome = JSON.parse(fs.readFileSync(v.journalFile));
    const controlFile = path.join(v.root,'.git','nassaj-preview-oid-event-control-0000000000000001.json');
    const beforeServing = JSON.parse(fs.readFileSync(controlFile));
    assert.equal(beforeServing.localUpdate.phase, 'awaiting_serving');
    const receipt = await writeOidPairServingReceipt(v.root, outcome, proof);
    assert.equal(readOidPairServingReceipt(v.root, receipt).outcome, 'served');
    assert.throws(() => readOidPairServingReceipt(v.root, {...receipt, actionId: 'wrong'}), /invalid/);
    fs.writeFileSync(controlFile, JSON.stringify(beforeServing));
    await reconcileOidPairServingReceipt(v.root, receipt);
    assert.equal(JSON.parse(fs.readFileSync(controlFile)).localUpdate.phase, 'activated');
    const proofFile = path.join(v.root,'.git',`nassaj-oid-pair-serving-${receipt.transactionNonce}.json`);
    const proofBytes = fs.readFileSync(proofFile);
    fs.writeFileSync(proofFile,JSON.stringify({...receipt,targetDigest:'0'.repeat(64)}));
    assert.throws(()=>readOidPairServingReceipt(v.root,{...receipt,targetDigest:'0'.repeat(64)}),/invalid/);
    fs.writeFileSync(proofFile,proofBytes);
    assert.equal(v.gate.readPublicStatus().gateClosed,false);
    assert.equal((await fetch(`${v.origin}/`)).status,200);
});

test('actual owner death after UNKNOWN keeps admission closed and never restores binaries', async t => {
    const { recoverOidPairAdmission } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    const result = await crashCapsule(v, 'pair_before_bootstrap');
    assert.equal(result.signal, 'SIGKILL', result.error);
    const recovery = await recoverOidPairAdmission(v.root);
    assert.equal(recovery.reason, 'oid_pair_database_unknown');
    assert.equal(v.gate.readPublicStatus().gateClosed, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.root,'dist/BUILD_PROVENANCE.json'))).buildId, 'e'.repeat(64));
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.root,'dist-server/BUILD_PROVENANCE.json'))).buildId, 'f'.repeat(64));
});

test('pre-candidate recovery cannot open after the exact previous runtime disappears', async t => {
    const { recoverOidPairAdmission } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    const result = await crashCapsule(v, 'pair_after_client_exchange');
    assert.equal(result.signal, 'SIGKILL');
    v.invalidatePreviousRuntime();
    await assert.rejects(recoverOidPairAdmission(v.root), /previous_runtime_unverified/);
    assert.equal(v.gate.readPublicStatus().gateClosed, true);
    assert.notEqual(JSON.parse(fs.readFileSync(v.journalFile)).state, 'pair_rolled_back');
});

for (const point of ['pair_after_admission_intent','pair_after_draining','pair_after_quiescent']) test(`durable pre-effect intent recovers ${point} with the exact previous runtime`, async t => {
    const { recoverOidPairAdmission } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    const result = await crashCapsule(v, point);
    assert.equal(result.signal, 'SIGKILL');
    const recovery = await recoverOidPairAdmission(v.root);
    assert.equal(recovery.reason, 'oid_pair_admission_aborted_before_effects');
    assert.equal(v.gate.readPublicStatus().gateClosed, false);
    assert.equal(JSON.parse(fs.readFileSync(v.journalFile)).state, 'pair_rolled_back');
    assert.equal(JSON.parse(fs.readFileSync(path.join(v.root,'dist/BUILD_PROVENANCE.json'))).buildId, 'a'.repeat(64));
});

test('rollback terminal resume refuses OPEN when the previous runtime disappeared', async t => {
    const { recoverOidPairAdmission } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    const result = await crashCapsule(v, 'pair_after_rollback_receipt', Buffer.from('exit 1\n'), {NASSAJ_OID_CAPSULE_FAIL_AT:'pair_after_client_exchange'});
    assert.equal(result.signal,'SIGKILL',result.error);
    assert.equal(JSON.parse(fs.readFileSync(v.journalFile)).state,'pair_rolled_back');
    v.invalidatePreviousRuntime();
    await assert.rejects(recoverOidPairAdmission(v.root),/previous_runtime_unverified/);
    assert.equal(v.gate.readPublicStatus().gateClosed,true);
});

test('missing previous runtime is rejected before creating admission intent', async t => {
    const { runOidPairTransaction } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    v.invalidatePreviousRuntime();
    await assert.rejects(runOidPairTransaction(v.record,Buffer.from('exit 1\n')),/previous_runtime_unverified/);
    assert.equal(v.gate.readPublicStatus().gateClosed,false);
    assert.equal(fs.existsSync(v.journalFile),false);
});

for (const point of ['pair_after_admission_intent','pair_after_draining']) test(`durable admission intent stays closed when the previous runtime disappears at ${point}`, async t => {
    const { recoverOidPairAdmission } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    await crashCapsule(v,point);
    v.invalidatePreviousRuntime();
    await assert.rejects(recoverOidPairAdmission(v.root),/previous_runtime_unverified/);
    assert.equal(v.gate.readPublicStatus().gateClosed,true);
});

for (const disappears of [false,true]) test(`admission rollback receipt resumes safely with previous disappears=${disappears}`, async t => {
    const { spawn } = await import('node:child_process');
    const { recoverOidPairAdmission } = await import('./oid-control-capsule.mjs');
    const v = await preparedTransaction(t);
    await crashCapsule(v,'pair_after_draining');
    const url = new URL('./oid-control-capsule.mjs',import.meta.url).href;
    const script = `import{recoverOidPairAdmission}from ${JSON.stringify(url)};await recoverOidPairAdmission(${JSON.stringify(v.root)});`;
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,NODE_ENV:'test',NASSAJ_OID_CAPSULE_CRASH_AT:'pair_after_admission_rollback_receipt'},stdio:'ignore'});
    const result=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
    assert.equal(result.signal,'SIGKILL');
    if (disappears) {
        v.invalidatePreviousRuntime();
        await assert.rejects(recoverOidPairAdmission(v.root),/previous_runtime_unverified/);
        assert.equal(v.gate.readPublicStatus().gateClosed,true);
    } else {
        assert.equal((await recoverOidPairAdmission(v.root)).state,'OPEN');
        assert.equal(v.gate.readPublicStatus().gateClosed,false);
    }
});

test('actual bootstrap entry recovers pre-drain intent before loading application', async t => {
    const { bootstrapServer } = await import('../server/bootstrap.js');
    const v = await preparedTransaction(t);
    const result = await crashCapsule(v,'pair_after_admission_intent');
    assert.equal(result.signal,'SIGKILL');
    assert.equal(v.gate.hasPendingOidAdmissionIntent(),true);
    let loaded=false;
    await bootstrapServer({projectPath:v.root,loadServer:async()=>{
        assert.equal(v.gate.hasPendingOidAdmissionIntent(),false);
        assert.equal(v.gate.readPublicStatus().gateClosed,false);
        assert.equal(JSON.parse(fs.readFileSync(v.journalFile)).state,'pair_rolled_back');
        loaded=true;
    }});
    assert.equal(loaded,true);
});

// Materialize a triple pre-effect terminal over the real dead-owner admission fixture.
async function deferredFullWaiterFixture(t) {
    const v = await preparedTransaction(t);
    assert.equal((await crashCapsule(v, 'pair_after_quiescent')).signal, 'SIGKILL');
    const maintenanceFile = path.join(v.root, '.git/nassaj-source-update/journal.json');
    const maintenance = JSON.parse(fs.readFileSync(maintenanceFile));
    const transaction = maintenance.oidAdmissionIntent.transaction;
    transaction.schema = 'nassaj-oid-control-transaction/v2';
    transaction.fullUpdateWaiter = { schema: 'nassaj-full-update-waiter/v1', sequence: transaction.sequence,
        requestId: `local-update:${transaction.sequence}`, revision: 2, transactionNonce: transaction.transactionNonce,
        phase: 'effects_started', effect: 'started' };
    const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
        : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
    delete maintenance.checksum; maintenance.checksum = sha(canonical(maintenance));
    fs.writeFileSync(maintenanceFile, JSON.stringify(maintenance));
    const terminal = { ...transaction, state: 'restart_deferred_restored' };
    fs.writeFileSync(v.journalFile, JSON.stringify(terminal), { mode: 0o600 });
    const eventFile = path.join(v.root, '.git/nassaj-preview-oid-event-control-0000000000000001.json');
    const event = JSON.parse(fs.readFileSync(eventFile));
    event.fullUpdateWaiter = transaction.fullUpdateWaiter;
    fs.writeFileSync(eventFile, JSON.stringify(event));
    return { ...v, eventFile, terminal };
}

for (const point of ['terminal', 'full_waiter_after_disposition_receipt', 'full_waiter_after_disposition_event']) {
    test(`pre-effect full waiter recovery resumes durable ${point} through admission and opens once`, async t => {
        const { recoverOidPairAdmission } = await import('./oid-control-capsule.mjs');
        const { spawn } = await import('node:child_process');
        const v = await deferredFullWaiterFixture(t);
        if (point !== 'terminal') {
            const url = new URL('./oid-control-capsule.mjs', import.meta.url).href;
            const child = spawn(process.execPath, ['--input-type=module', '-e',
                `import {recoverOidPairAdmission} from ${JSON.stringify(url)};await recoverOidPairAdmission(${JSON.stringify(v.root)});`],
            { env: { ...process.env, NODE_ENV: 'test', NASSAJ_OID_CAPSULE_CRASH_AT: point }, stdio: ['ignore', 'ignore', 'pipe'] });
            let errors = ''; child.stderr.on('data', data => { errors += data; });
            const result = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
            assert.equal(result.signal, 'SIGKILL', errors);
        }
        assert.equal(v.gate.readPublicStatus().gateClosed, true);
        assert.equal((await recoverOidPairAdmission(v.root)).state, 'OPEN');
        assert.equal(v.gate.readPublicStatus().gateClosed, false);
        assert.equal(JSON.parse(fs.readFileSync(v.eventFile)).fullUpdateWaiter.phase, 'released');
        assert.equal(JSON.parse(fs.readFileSync(v.journalFile)).state, 'restart_deferred_restored');
        assert.equal((await recoverOidPairAdmission(v.root)).recovered, false);
    });
}

for (const mutation of ['unknown', 'activation', 'revision', 'previous', 'stop', 'child']) {
    test(`pre-effect full waiter recovery refuses ${mutation}`, async t => {
        const { recoverOidPairAdmission } = await import('./oid-control-capsule.mjs');
        const v = await deferredFullWaiterFixture(t);
        const event = JSON.parse(fs.readFileSync(v.eventFile));
        if (mutation === 'unknown') v.terminal.pair.databaseState = 'UNKNOWN';
        if (mutation === 'activation') event.localUpdate.activation = { transactionNonce: v.terminal.transactionNonce };
        if (mutation === 'revision') event.fullUpdateWaiter.revision += 1;
        if (mutation === 'previous') v.invalidatePreviousRuntime();
        if (mutation === 'stop') v.terminal.oldStopIntentAt = Date.now();
        if (mutation === 'child') fs.writeFileSync(path.join(v.root, '.git/nassaj-source-update', `oid-child-${v.terminal.transactionNonce}.json`), '{}');
        fs.writeFileSync(v.journalFile, JSON.stringify(v.terminal)); fs.writeFileSync(v.eventFile, JSON.stringify(event));
        await assert.rejects(recoverOidPairAdmission(v.root), /effect_possible|cas_conflict|runtime_unverified|bootstrap_observed/);
        assert.equal(v.gate.readPublicStatus().gateClosed, true);
        assert.equal(JSON.parse(fs.readFileSync(v.eventFile)).fullUpdateWaiter.phase, 'effects_started');
    });
}
