import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, openSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { oidExecutorCodeClosure, launchOidCapsule, parseProcessStartTicks, pinnedBytes, resolveAttemptNonce, retainOidTripleExecutor, readOidTripleRetainedExecutor, observeOidSupervisorStartup, waitOidSupervisorHandshake, waitOidSupervisorOutcome } from './preview-oid-capsule-launcher.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('supervisor early exit drains bounded stderr and emits only an explicit code',async()=>{
    const root=mkdtempSync(path.join(process.env.TMPDIR||'/var/tmp','oid-startup-diagnostic-'));
    const child=spawn(process.execPath,['-e','process.stderr.write("oid_triple_pm2_name_invalid\\n"+"synthetic-secret=".repeat(150000),()=>process.exit(23));'],{stdio:['ignore','ignore','pipe']});
    const startup=observeOidSupervisorStartup(child);
    try {
        await assert.rejects(waitOidSupervisorHandshake(path.join(root,'missing'), 'a'.repeat(64),400,startup.failure),
            error=>error.message==='oid_supervisor_exit_before_handshake:exit=23:signal=none:reason=oid_triple_pm2_name_invalid');
    } finally {startup.close();child.kill();rmSync(root,{recursive:true,force:true});}
    assert.equal(child.listenerCount('exit'),0);assert.equal(child.listenerCount('error'),0);assert.equal(child.stderr.listenerCount('data'),0);
});

for (const reason of ['oid_pair_lock_unsafe', 'oid_pair_lock_contended']) {
    test(`actual capsule admission failure is returned safely before handshake: ${reason}`, async () => {
        const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-actual-lock-diagnostic-'));
        const control = path.join(root, '.git/nassaj-source-update'), nonce = 'a'.repeat(64);
        let heldFd, child, startup;
        try {
            assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
            mkdirSync(control, { mode: 0o700 });
            const lock = path.join(control, 'admission.lock'); writeFileSync(lock, '', { mode: 0o600 });
            if (reason === 'oid_pair_lock_unsafe') chmodSync(lock, 0o664);
            else {
                heldFd = openSync(lock, 'r+');
                assert.equal(spawnSync('/usr/bin/flock', ['-x', '3'], { stdio: ['ignore', 'ignore', 'ignore', heldFd] }).status, 0);
            }
            const identity = { oid: 'b'.repeat(40), targetDigest: 'c'.repeat(64), transactionNonce: nonce,
                sequence: 1, group: 'event-0000000000000001', targetClientBuildId: 'd'.repeat(64), targetServerBuildId: 'e'.repeat(64),
                journalBasename: `nassaj-oid-control-transaction-1-${nonce}.json` };
            const capsule = new URL('./oid-control-capsule.mjs', import.meta.url).href;
            const source = `import {beginOidPairAdmission} from ${JSON.stringify(capsule)};try{await beginOidPairAdmission(${JSON.stringify(root)},${JSON.stringify(identity)},{waitMs:25});process.exit(99);}catch(error){process.stderr.write(error.message+'\\n'+'synthetic-secret-detail',()=>process.exit(31));}`;
            child = spawn(process.execPath, ['--input-type=module', '-e', source], {
                env: { PATH: process.env.PATH, NASSAJ_UPDATE_MODE: 'local-main' }, stdio: ['ignore', 'ignore', 'pipe'],
            });
            startup = observeOidSupervisorStartup(child);
            await assert.rejects(waitOidSupervisorHandshake(path.join(root, 'missing'), nonce, 400, startup.failure),
                error => error.message === `oid_supervisor_exit_before_handshake:exit=31:signal=none:reason=${reason}`);
        } finally {
            startup?.close(); child?.kill(); if (heldFd !== undefined) closeSync(heldFd);
            rmSync(root, { recursive: true, force: true });
        }
    });
}

test('actual archive reserve refusal returns a safe capacity code without stderr details', async () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-archive-diagnostic-'));
    let child, startup;
    try {
        const archive = new URL('./lib/client-publication-archive.mjs', import.meta.url).href;
        const source = `import fs from 'node:fs';import {assertClientPublicationCapacity} from ${JSON.stringify(archive)};
fs.statfsSync=()=>({bavail:16*1024**3-1,bsize:1});
try{assertClientPublicationCapacity(${JSON.stringify(root)},0);process.exit(99);}
catch(error){process.stderr.write(error.message+'\\n'+'synthetic-private-archive-path',()=>process.exit(32));}`;
        child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
        startup = observeOidSupervisorStartup(child);
        await assert.rejects(waitOidSupervisorHandshake(path.join(root, 'missing'), 'f'.repeat(64), 400, startup.failure),
            error => error.message === 'oid_supervisor_exit_before_handshake:exit=32:signal=none:reason=client_publication_capacity_exceeded');
    } finally { startup?.close(); child?.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('supervisor diagnostic rejects arbitrary stderr, over-limit codes and spawn paths',async()=>{
    const root=mkdtempSync(path.join(process.env.TMPDIR||'/var/tmp','oid-startup-redaction-'));
    try {
        const child=spawn(process.execPath,['-e','process.stderr.write("sensitive-prefix".repeat(1000)+"\\noid_triple_pm2_name_invalid\\n",()=>process.exit(7));'],{stdio:['ignore','ignore','pipe']});
        const startup=observeOidSupervisorStartup(child);
        try {await assert.rejects(waitOidSupervisorHandshake(path.join(root,'missing'),'b'.repeat(64),400,startup.failure),/exit=7:signal=none:reason=unknown$/);}finally{startup.close();child.kill();}
        const absent=spawn(path.join(root,'private-spawn-path'),[],{stdio:['ignore','ignore','pipe']}),failure=observeOidSupervisorStartup(absent);
        try {await assert.rejects(waitOidSupervisorHandshake(path.join(root,'missing'),'b'.repeat(64),400,failure.failure),/exit=none:signal=none:reason=ENOENT$/);}finally{failure.close();}
    } finally {rmSync(root,{recursive:true,force:true});}
});

test('a durable exact handshake wins over an already observed successful exit',async()=>{
    const root=mkdtempSync(path.join(process.env.TMPDIR||'/var/tmp','oid-startup-handshake-')),file=path.join(root,'handshake'),nonce='c'.repeat(64);
    const child=spawn(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(file)},JSON.stringify({state:'executor_ready',launcherNonce:${JSON.stringify(nonce)}}));`],{stdio:['ignore','ignore','pipe']});
    const startup=observeOidSupervisorStartup(child);
    try {
        await new Promise(resolve=>child.once('exit',resolve));
        assert.equal((await waitOidSupervisorHandshake(file,nonce,1,startup.failure)).state,'executor_ready');
    }finally{startup.close();rmSync(root,{recursive:true,force:true});}
});

test('startup timeout releases stderr event-loop reference without killing its live child',async()=>{
    const root=mkdtempSync(path.join(process.env.TMPDIR||'/var/tmp','oid-startup-unref-'));
    const moduleUrl=new URL('./preview-oid-capsule-launcher.mjs',import.meta.url).href;
    const childProgram='process.stderr.write("ready\\n");setInterval(()=>{},1000);';
    const source=`import {spawn} from 'node:child_process';import {observeOidSupervisorStartup,waitOidSupervisorHandshake} from ${JSON.stringify(moduleUrl)};
const child=spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{detached:true,stdio:['ignore','ignore','pipe']});child.unref();
const startup=observeOidSupervisorStartup(child);try{await waitOidSupervisorHandshake(${JSON.stringify(path.join(root,'missing'))},'nonce',2,startup.failure);}catch(error){if(error.message!=='oid_supervisor_handshake_timeout')throw error;}finally{startup.close();}console.log(JSON.stringify({child:child.pid}));`;
    const parent=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',childPid,timer;
    parent.stdout.on('data',data=>{stdout+=data;});parent.stderr.on('data',data=>{stderr+=data;});
    try {
        const code=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('observer_parent_retained_by_child_pipe')),2000);parent.once('exit',resolve);});
        clearTimeout(timer);assert.equal(code,0,stderr);childPid=JSON.parse(stdout).child;
        assert.doesNotThrow(()=>process.kill(childPid,0));
    } finally {
        clearTimeout(timer);parent.kill('SIGKILL');
        if(!childPid&&stdout.trim())childPid=JSON.parse(stdout).child;
        if(childPid)try{process.kill(childPid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
        rmSync(root,{recursive:true,force:true});
    }
});

test('launcher reads field 22 after a Linux comm value containing spaces or a closing parenthesis', () => {
    const stat = `123 (node /srv/example runtime) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 7730317 999`;
    assert.equal(parseProcessStartTicks(stat), '7730317');
    const closingParenthesis = `123 (node ) worker /srv/example runtime) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(' ')} 7730318 999`;
    assert.equal(parseProcessStartTicks(closingParenthesis), '7730318');
    assert.equal(parseProcessStartTicks('123 no-parenthesized-command'), null);
});

test('pinned byte loader rejects content, mode, target symlink and parent symlink tamper', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-launcher-'));
    try {
        const scripts = path.join(root, 'scripts');
        mkdirSync(scripts);
        const file = path.join(scripts, 'safe-restart.sh');
        const bytes = Buffer.from('safe bytes');
        writeFileSync(file, bytes, { mode: 0o555 });
        assert.deepEqual(pinnedBytes(root, file, { sha256: sha(bytes), size: bytes.length, mode: 0o555 }, 'safe'), bytes);
        assert.throws(() => pinnedBytes(root, file, {
            sha256: '0'.repeat(64), size: bytes.length, mode: 0o555,
        }, 'safe'), /content_mismatch/);
        chmodSync(file, 0o755);
        assert.throws(() => pinnedBytes(root, file, {
            sha256: sha(bytes), size: bytes.length, mode: 0o555,
        }, 'safe'), /metadata_mismatch/);
        chmodSync(file, 0o555);
        const target = path.join(root, 'target');
        writeFileSync(target, bytes, { mode: 0o555 });
        rmSync(file);
        symlinkSync(target, file);
        assert.throws(() => pinnedBytes(root, file, {
            sha256: sha(bytes), size: bytes.length, mode: 0o555,
        }, 'safe'));
        rmSync(scripts, { recursive: true });
        const external = path.join(root, 'external');
        mkdirSync(external);
        writeFileSync(path.join(external, 'safe-restart.sh'), bytes, { mode: 0o555 });
        symlinkSync(external, scripts, 'dir');
        assert.throws(() => pinnedBytes(root, path.join(scripts, 'safe-restart.sh'), {
            sha256: sha(bytes), size: bytes.length, mode: 0o555,
        }, 'safe'), /parent_unsafe/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mutable source-tree launcher has no control authority', async () => {
    await assert.rejects(() => launchOidCapsule(), /not_loaded_runtime/);
});

test('broken OID request symlink fails closed instead of entering the legacy path', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-wrapper-'));
    try {
        mkdirSync(path.join(root, 'scripts'));
        assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }).status, 0);
        copyFileSync(new URL('./preview-safe-restart.sh', import.meta.url), path.join(root, 'scripts', 'preview-safe-restart.sh'));
        symlinkSync(path.join(root, 'missing-request'), path.join(root, '.git', 'nassaj-preview-oid-control-request-v1.json'));
        const result = spawnSync('/usr/bin/bash', [path.join(root, 'scripts', 'preview-safe-restart.sh'), '--exec'], {
            cwd: root, encoding: 'utf8',
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /dist-server\/scripts\/preview-oid-capsule-launcher/);
        assert.doesNotMatch(result.stderr, /preview-oid-owner-action/);
        const gate = spawnSync('/usr/bin/bash', [path.join(root, 'scripts', 'preview-safe-restart.sh'), '--json'], {
            cwd: root, encoding: 'utf8',
        });
        assert.equal(gate.status, 2);
        assert.match(gate.stderr, /root fallback refused/);
        assert.doesNotMatch(gate.stderr, /preview-oid-owner-action/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('launcher binds an action to the exact persisted attempt nonce and rejects legacy or malformed claims', () => {
    const actionId = '12345678-1234-1234-1234-123456789abc';
    const nonce = 'a'.repeat(64);
    assert.equal(resolveAttemptNonce(actionId, nonce), nonce);
    assert.throws(() => resolveAttemptNonce(actionId, undefined), /attempt_identity_invalid/);
    assert.throws(() => resolveAttemptNonce(actionId, '../secret'), /attempt_identity_invalid/);
    assert.throws(() => resolveAttemptNonce('malformed', nonce), /attempt_identity_invalid/);
    assert.match(resolveAttemptNonce(null, null), /^[a-f0-9]{64}$/);
    assert.notEqual(resolveAttemptNonce(null, null), resolveAttemptNonce(null, null));
});

test('retained executor is exclusive, complete and independent from the removed live generation', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-retained-'));
    try {
        assert.equal(spawnSync('git', ['init'], { cwd: root }).status, 0);
        const record = { repoRoot: root, actionId: '12345678-1234-1234-1234-123456789abc', transactionNonce: 'd'.repeat(64), pair: { targetDigest: 'e'.repeat(64) } };
        const capsule = Buffer.from('capsule bytes'), safeRestart = Buffer.from('safe bytes'), launcher = Buffer.from('launcher bytes');
        const manifest = { capabilities: { oidTripleAdmissionV2: true } };
        for (const [name, bytes] of [['capsule', capsule], ['safeRestart', safeRestart], ['launcher', launcher]]) {
            manifest[`${name}Sha256`] = sha(bytes); manifest[`${name}Size`] = bytes.length;
        }
        const input = { record, manifestBytes: Buffer.from(JSON.stringify(manifest)), capsule, safeRestart, launcher };
        const reference = retainOidTripleExecutor(root, input);
        const expected = { ...reference, actionId: record.actionId, targetDigest: record.pair.targetDigest };
        const verified = readOidTripleRetainedExecutor(root, expected);
        assert.deepEqual(verified.bytes['launcher.mjs'], launcher);
        assert.deepEqual(verified.bytes['capsule.mjs'], capsule);
        assert.deepEqual(verified.descriptor.codeClosure, oidExecutorCodeClosure(input));
        const recordFile = path.join(verified.executor, 'record.json'), recordBytes = readFileSync(recordFile);
        writeFileSync(recordFile, JSON.stringify({ ...record, transactionNonce: 'f'.repeat(64) }));
        assert.throws(() => readOidTripleRetainedExecutor(root, expected), /mismatch/);
        writeFileSync(recordFile, recordBytes);
        assert.throws(() => retainOidTripleExecutor(root, input), /EEXIST/);
        assert.throws(() => readOidTripleRetainedExecutor(root, { ...expected, actionId: 'different' }), /manifest_mismatch/);
        const file = path.join(verified.executor, 'capsule.mjs');
        linkSync(file, path.join(root, 'external-hardlink'));
        assert.throws(() => readOidTripleRetainedExecutor(root, expected), /file_unsafe/);
        rmSync(path.join(root, 'external-hardlink'));
        writeFileSync(file, Buffer.from('tampered bytes'));
        assert.throws(() => readOidTripleRetainedExecutor(root, expected), /mismatch/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual retained launcher entry uses captured stdin and rejects a tampered closure before executing', () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-resume-entry-'));
    try {
        assert.equal(spawnSync('git', ['init'], { cwd: root }).status, 0);
        const record = { repoRoot: root, actionId: '12345678-1234-1234-1234-123456789abc', transactionNonce: 'a'.repeat(64), pair: { sequence: 1, targetDigest: 'b'.repeat(64) } };
        // A bounded transport fixture, not an activation/PM2 recovery claim.
        const capsule = Buffer.from('import fs from "node:fs"; const record=JSON.parse(fs.readFileSync(4)); fs.readFileSync(3); fs.writeFileSync(record.repoRoot+"/transport-proof",record.resume.permissionRef);');
        const safeRestart = Buffer.from('exit 0\n'), launcher = readFileSync(new URL('./preview-oid-capsule-launcher.mjs', import.meta.url));
        const manifest = { capabilities: { oidTripleAdmissionV2: true } };
        for (const [name, bytes] of [['capsule',capsule],['safeRestart',safeRestart],['launcher',launcher]]) {
            manifest[`${name}Sha256`] = sha(bytes); manifest[`${name}Size`] = bytes.length;
        }
        const reference = retainOidTripleExecutor(root, { record, manifestBytes: Buffer.from(JSON.stringify(manifest)), capsule, safeRestart, launcher });
        const journal = { schema: 'nassaj-oid-control-transaction/v2', transactionNonce: record.transactionNonce, actionId: record.actionId,
            pair: { targetDigest: record.pair.targetDigest }, recoveryReference: reference,
            supervisor: { node: { path: realpathSync(process.execPath), sha256: sha(readFileSync(process.execPath)) } } };
        writeFileSync(path.join(root,'.git',`nassaj-oid-control-transaction-1-${record.transactionNonce}.json`),JSON.stringify(journal),{mode:0o600});
        const executor = path.join(root,'.git','nassaj-oid-recovery',record.transactionNonce,'executor');
        const run = () => spawnSync(process.execPath,[path.join(executor,'launcher.mjs'),'--resume-transaction',record.transactionNonce], {
            cwd:root,env:{...process.env,NASSAJ_OID_RESUME_PERMISSION_REF:'test-explicit-permission'},encoding:'utf8',timeout:5000,
        });
        const accepted = run(); assert.equal(accepted.status,0,accepted.stderr);
        assert.equal(readFileSync(path.join(root,'transport-proof'),'utf8'),'test-explicit-permission');
        rmSync(path.join(root,'transport-proof'));
        writeFileSync(path.join(executor,'capsule.mjs'),'changed');
        const rejected = run(); assert.notEqual(rejected.status,0); assert.match(rejected.stderr,/mismatch/);
        assert.throws(()=>readFileSync(path.join(root,'transport-proof')),/ENOENT/);
    } finally { rmSync(root,{recursive:true,force:true}); }
});

for (const triple of [false,true]) test(`outcome wait is bounded and leaves unresolved journal untouched, triple=${triple}`,async()=>{
    const root=mkdtempSync(path.join(process.env.TMPDIR||'/var/tmp','oid-outcome-wait-'));
    try {
        spawnSync('/usr/bin/git',['init','-q',root]);const nonce='c'.repeat(64),file=path.join(root,'.git',`nassaj-oid-control-transaction-1-${nonce}.json`);
        const bytes=JSON.stringify({transactionNonce:nonce,state:'triple_prepared',sentinel:'unchanged'});writeFileSync(file,bytes,{mode:0o600});let elapsed=0;
        await assert.rejects(waitOidSupervisorOutcome(root,1,nonce,{triple,sleep:async ms=>{elapsed+=ms;}}),/oid_supervisor_outcome_timeout/);
        assert.equal(elapsed,triple?900000:120000);assert.equal(readFileSync(file,'utf8'),bytes);
    } finally {rmSync(root,{recursive:true,force:true});}
});


test('code closure has no transaction cycle and pins every executable and external runtime digest', () => {
    const input = { manifestBytes: Buffer.from('manifest'), capsule: Buffer.from('capsule'),
        safeRestart: Buffer.from('safe'), launcher: Buffer.from('launcher'),
        externalRuntimeClosures: [{kind:'node',sha256:'a'.repeat(64)},{kind:'python-peer-reader',sha256:'b'.repeat(64)}] };
    const original = oidExecutorCodeClosure(input);
    assert.deepEqual(oidExecutorCodeClosure({...input, record:{nonce:'different'}, ticket:{sha256:'ignored'}}), original);
    assert.deepEqual(oidExecutorCodeClosure({...input, externalRuntimeClosures:[...input.externalRuntimeClosures].reverse()}),original);
    assert.equal(JSON.stringify(original.descriptor).includes(original.sha256),false);
    for (const name of ['manifestBytes','capsule','safeRestart','launcher']) {
        assert.notEqual(oidExecutorCodeClosure({...input,[name]:Buffer.from('changed')}).sha256,original.sha256);
    }
    assert.notEqual(oidExecutorCodeClosure({...input, externalRuntimeClosures:[{kind:'node',sha256:'c'.repeat(64)}]}).sha256,original.sha256);
    assert.throws(()=>oidExecutorCodeClosure({...input,externalRuntimeClosures:[{kind:'arbitrary-executable',sha256:'a'.repeat(64)}]}),/runtime_invalid/);
    assert.throws(()=>oidExecutorCodeClosure({...input,externalRuntimeClosures:[input.externalRuntimeClosures[0],input.externalRuntimeClosures[0]]}),/runtime_duplicate/);
});
