import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hashOidPairTree, inspectOidTripleGenerationPlan, assertOidTripleRuntime, runOidTripleNativeProbe, validateOidTriplePm2Slot, validateOidTriplePm2Dump, validateOidPairTerminal, readOidPairServingReceipt, assertOidTripleEffectiveMode, prepareOidTripleDependencyExchange, oidTripleDependencySlot } from './oid-control-capsule.mjs';
import { hashDependencyTreeV2 } from './lib/dependency-tree-identity-v2.mjs';
import { computeOidTripleTargetDigest } from './lib/oid-triple-target.mjs';

test('real three-directory exchange without receipts reconciles backwards and UNKNOWN blocks downgrade', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-triple-generation-'));
    try {
        const target = { schema: 'nassaj-oid-triple-target/v2', generationNames: ['nodeModules', 'server', 'client'],
            installRuntime: { nodeBinarySha256: 'a'.repeat(64), nodeVersion: process.version, nodeModuleAbi: process.versions.modules,
                napi: process.versions.napi, platform: process.platform, arch: process.arch, npmVersion: '12.0.2', npmCliSha256: 'a'.repeat(64) } };
        for (const name of ['clientBuildId', 'serverBuildId', 'dependencyContractSha256', 'packageJsonSha256', 'packageLockSha256', 'installPolicySha256', 'controlManifestSha256']) target[name] = 'a'.repeat(64);
        const previous = {}, locations = {};
        for (const [name, liveName] of [['nodeModules', 'node_modules'], ['server', 'dist-server'], ['client', 'dist']]) {
            const live = path.join(root, liveName), temporary = path.join(root, `candidate-${name}`);
            fs.mkdirSync(live); fs.mkdirSync(temporary);
            fs.writeFileSync(path.join(live, 'generation'), 'old'); fs.writeFileSync(path.join(temporary, 'generation'), 'new');
            if (name === 'nodeModules') { fs.chmodSync(temporary, 0o700); fs.chmodSync(path.join(temporary, 'generation'), 0o444); }
            const hash = name === 'nodeModules' ? file => hashDependencyTreeV2(file).sha256 : hashOidPairTree;
            previous[`${name}TreeSha256`] = hash(live); target[`${name}TreeSha256`] = hash(temporary);
            const parent = path.join(root, '.nassaj-local-preview', name === 'nodeModules' ? 'dependency-candidates' : `${name}-candidates`);
            fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
            // Candidate parents must be private regardless of the runner umask.
            fs.chmodSync(path.join(root, '.nassaj-local-preview'), 0o700); fs.chmodSync(parent, 0o700);
            const candidate = path.join(parent, name === 'nodeModules' ? target.nodeModulesTreeSha256 : target[`${name}BuildId`]);
            fs.renameSync(temporary, candidate); locations[name] = { live, candidate };
        }
        let transaction = { schema: 'nassaj-oid-control-transaction/v2', generationNames: target.generationNames, transactionNonce: 'e'.repeat(64),
            pair: { target, previous, targetDigest: 'f'.repeat(64), databaseState: 'PRE_CANDIDATE' } };
        transaction = prepareOidTripleDependencyExchange(root, path.join(root, 'journal.json'), transaction);
        locations.nodeModules.candidate = oidTripleDependencySlot(root, transaction);
        assert.equal(inspectOidTripleGenerationPlan(root, transaction, 'forward').state, 'verified');
        for (const name of target.generationNames) {
            const { live, candidate } = locations[name];
            assert.equal(spawnSync('/usr/bin/mv', ['--exchange', '--no-copy', '-T', live, candidate]).status, 0);
            const recovery = inspectOidTripleGenerationPlan(root, transaction, 'rollback');
            assert.equal(recovery.state, 'verified');
            assert.equal(recovery.steps.find(step => step.name === name).operation, 'exchange');
        }
        transaction.pair.databaseState = 'UNKNOWN';
        assert.equal(inspectOidTripleGenerationPlan(root, transaction, 'rollback').reason, 'database_downgrade_forbidden');
        assert.ok(inspectOidTripleGenerationPlan(root, transaction, 'forward').steps.every(step => step.operation === 'attest'));
        fs.writeFileSync(path.join(locations.server.candidate, 'generation'), 'foreign');
        assert.deepEqual(inspectOidTripleGenerationPlan(root, transaction, 'forward').steps, []);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runtime ABI mismatch refuses before candidate execution', () => {
    assert.throws(() => assertOidTripleRuntime({ nodeVersion: 'v0.0.0' }), /runtime_mismatch/);
});

test('child effective mode observes current .env and preserves strict service precedence', () => {
    const root=fs.mkdtempSync(path.join(process.env.TMPDIR||'/var/tmp','oid-triple-mode-'));
    try {
        const file=path.join(root,'.env');
        fs.writeFileSync(file,'NASSAJ_UPDATE_MODE=local-main\n',{mode:0o600});
        assert.equal(assertOidTripleEffectiveMode(root,{}),true);
        fs.writeFileSync(file,'NASSAJ_UPDATE_MODE=release\n');
        assert.throws(()=>assertOidTripleEffectiveMode(root,{}),/mode_changed/);
        assert.equal(assertOidTripleEffectiveMode(root,{NASSAJ_UPDATE_MODE:'local-main'}),true);
        assert.throws(()=>assertOidTripleEffectiveMode(root,{NASSAJ_UPDATE_MODE:''}),/mode_changed/);
        fs.writeFileSync(file,'NASSAJ_UPDATE_MODE=local-main\nNASSAJ_UPDATE_MODE=local-main\n');
        assert.throws(()=>assertOidTripleEffectiveMode(root,{}),/mode_changed/);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('supervisor guard refuses missing, reused and non-stopped slots without a create fallback', () => {
    const expected = { root: '/srv/test', name: 'test', pmId: 7, pid: 123 };
    const slot = { name: 'test', pm_id: 7, pid: 123, pm2_env: { pm_exec_path: '/srv/test/dist-server/server/index.js',
        pm_cwd: '/srv/test', status: 'online', treekill: false, kill_timeout: 86400000 } };
    assert.equal(validateOidTriplePm2Slot([slot], expected), slot);
    const canonicalString = { ...slot, pm2_env: { ...slot.pm2_env, kill_timeout: '86400000' } };
    const original = JSON.stringify(canonicalString);
    assert.equal(validateOidTriplePm2Slot([canonicalString], expected), canonicalString);
    assert.equal(JSON.stringify(canonicalString), original, 'raw PM2 identity must remain unchanged');
    const numberSaved = { ...slot.pm2_env, name: slot.name }, stringSaved = { ...canonicalString.pm2_env, name: slot.name };
    assert.equal(validateOidTriplePm2Dump([numberSaved], slot), true);
    assert.equal(validateOidTriplePm2Dump([stringSaved], canonicalString), true);
    // Save reconciliation binds raw identity; accepting either input is not permission to relabel a dump.
    assert.throws(() => validateOidTriplePm2Dump([numberSaved], canonicalString), /dump_slot_changed/);
    assert.throws(() => validateOidTriplePm2Dump([stringSaved], slot), /dump_slot_changed/);

    for (const invalid of [300000, '300000', '86400000 ', ' 86400000', '+86400000', '086400000', '86400000.0', '8.64e7', '86400000ms', null, true, 86400000.1]) {
        assert.throws(() => validateOidTriplePm2Slot([{ ...slot, pm2_env: { ...slot.pm2_env, kill_timeout: invalid } }], expected), /slot_changed/);
    }

    assert.throws(() => validateOidTriplePm2Slot([], expected), /ambiguous/);
    assert.throws(() => validateOidTriplePm2Slot([slot, { ...slot, pm_id: 8 }], expected), /ambiguous/);
    assert.throws(() => validateOidTriplePm2Slot([{ ...slot, pid: 456 }], expected), /changed/);
    const stopped = { ...slot, pid: 0, pm2_env: { ...slot.pm2_env, status: 'stopped' } };
    assert.equal(validateOidTriplePm2Slot([stopped], expected, 'stopped'), stopped);
    assert.throws(() => validateOidTriplePm2Slot([{ ...stopped, pid: 456 }], expected, 'stopped'), /changed/);
    assert.throws(() => validateOidTriplePm2Slot([{ ...stopped, pm_id: 8 }], expected, 'stopped'), /changed/);
});

test('historical triple serving requires typed terminal and dependency proof without a route-supplied hash', () => {
    const root=fs.mkdtempSync(path.join(process.env.TMPDIR||'/var/tmp','oid-triple-receipt-'));
    try {
        assert.equal(spawnSync('git',['init'],{cwd:root}).status,0);
        const target={schema:'nassaj-oid-triple-target/v2',generationNames:['nodeModules','server','client'],installRuntime:{
            nodeBinarySha256:'a'.repeat(64),nodeVersion:process.version,nodeModuleAbi:process.versions.modules,napi:process.versions.napi,
            platform:process.platform,arch:process.arch,npmVersion:'12.0.2',npmCliSha256:'b'.repeat(64)}};
        for(const key of ['clientBuildId','serverBuildId','clientTreeSha256','serverTreeSha256','nodeModulesTreeSha256','dependencyContractSha256','packageJsonSha256','packageLockSha256','installPolicySha256','controlManifestSha256'])target[key]='c'.repeat(64);
        const sequence=1,group='event-0000000000000001',oid='d'.repeat(40),transactionNonce='e'.repeat(64);
        const targetDigest=computeOidTripleTargetDigest({sequence,group,sourceOid:oid,target});
        const receipt={schema:'nassaj-oid-triple-terminal/v2',generationNames:target.generationNames,nodeModulesTreeSha256:target.nodeModulesTreeSha256,
            outcome:'activated',transactionNonce,targetDigest,clientBuildId:target.clientBuildId,serverBuildId:target.serverBuildId,pid:123,startTime:'456'};
        const transaction={schema:'nassaj-oid-control-transaction/v2',generationNames:target.generationNames,sequence,group,oid,transactionNonce,
            state:'pair_served',actionId:'12345678-1234-1234-1234-123456789abc',pair:{targetDigest,target,receipt}};
        transaction.bootNonce='f'.repeat(64);
        transaction.persistence={online:{state:'verified',status:'online',dumpSha256:'a'.repeat(64),pid:receipt.pid,startTime:receipt.startTime,bootNonce:transaction.bootNonce}};
        const recordTerminal=()=>{
            const bytes=JSON.stringify(transaction.pair.receipt);transaction.pair.receiptSha256=createHash('sha256').update(bytes).digest('hex');
            fs.writeFileSync(path.join(root,'.git',`nassaj-oid-pair-receipt-${transactionNonce}.json`),bytes,{mode:0o600});
            fs.writeFileSync(path.join(root,'.git',`nassaj-oid-control-transaction-1-${transactionNonce}.json`),JSON.stringify(transaction),{mode:0o600});
        };
        recordTerminal();assert.equal(validateOidPairTerminal(root,transaction),true);
        const served={...receipt,schema:'nassaj-oid-triple-serving/v2',outcome:'served',sequence,actionId:transaction.actionId,servedAt:Date.now()};
        const servingFile=path.join(root,'.git',`nassaj-oid-pair-serving-${transactionNonce}.json`);
        fs.writeFileSync(servingFile,JSON.stringify(served),{mode:0o600});
        assert.equal(readOidPairServingReceipt(root,{sequence,transactionNonce,targetDigest}).nodeModulesTreeSha256,target.nodeModulesTreeSha256);
        fs.writeFileSync(servingFile,JSON.stringify({...served,schema:'nassaj-oid-pair-serving/v1'}));
        assert.throws(()=>readOidPairServingReceipt(root,{sequence,transactionNonce,targetDigest}),/triple_serving_receipt_invalid/);
        transaction.pair.receipt={...receipt,nodeModulesTreeSha256:'f'.repeat(64)};recordTerminal();assert.equal(validateOidPairTerminal(root,transaction),false);
        transaction.pair.receipt={...receipt,schema:'nassaj-oid-pair-terminal/v1'};recordTerminal();assert.equal(validateOidPairTerminal(root,transaction),false);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('native proc mount selects mount2 only for that command and mount failure stops the namespace', () => {
    const root=fs.mkdtempSync(path.join(process.env.TMPDIR||'/var/tmp','oid-native-mount-scope-'));
    try {
        const source=fs.readFileSync(new URL('./oid-control-capsule.source.mjs',import.meta.url),'utf8');
        const script=source.match(/const OID_NATIVE_PROBE_NAMESPACE = `([\s\S]*?)`;/)?.[1];
        assert.ok(script);
        assert.equal(script.split('LIBMOUNT_FORCE_MOUNT2').length-1,1);
        const log=path.join(root,'mount-calls.jsonl');
        fs.writeFileSync(path.join(root,'mount'),`#!/usr/bin/node\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,selector:process.env.LIBMOUNT_FORCE_MOUNT2||null})+'\\n');if(args.includes('proc'))process.exit(42);`,{mode:0o700});
        const result=spawnSync('/usr/bin/bash',['-c',script,'native-scope','/unreachable-native-root','/unreachable-deps','unused',process.env.HOME,process.execPath],{
            encoding:'utf8',env:{PATH:root,HOME:process.env.HOME},timeout:3000,
        });
        assert.equal(result.status,42,result.stderr);
        const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line));
        assert.equal(calls.at(-1).selector,'always');
        assert.deepEqual(calls.at(-1).args,['-t','proc','-o','ro,nosuid,nodev,noexec','proc','/unreachable-native-root/proc']);
        assert.ok(calls.slice(0,-1).every(call=>call.selector===null));
    } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('native probe boundary cannot read host data, inherit secrets or modify sealed dependencies', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-native-boundary-'));
    const runtime = { nodeVersion: process.version, nodeModuleAbi: process.versions.modules, napi: process.versions.napi,
        platform: process.platform, arch: process.arch,
        nodeBinarySha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') };
    try {
        assert.equal(spawnSync('git', ['init'], { cwd: root }).status, 0);
        const dependencies = path.join(root, 'node_modules'); fs.mkdirSync(dependencies);
        const sentinel = path.join(root, 'synthetic-auth.db'); fs.writeFileSync(sentinel, 'must-remain-private');
        const sibling=path.join(dependencies,'native-probe-sibling');fs.mkdirSync(sibling);
        fs.writeFileSync(path.join(sibling,'index.js'),'module.exports={identity:"hoisted-sibling"};',{mode:0o444});
        const hostOnly=path.join(root,'outside-generation/node_modules/native-probe-host-only');fs.mkdirSync(hostOnly,{recursive:true});
        fs.writeFileSync(path.join(hostOnly,'index.js'),'module.exports="outside-generation";');
        // Stub package entries test namespace security only; actual native ABI coverage is a separate artifact rehearsal.
        for (const name of ['bcrypt','argon2','better-sqlite3','esbuild','sharp','@vscode/ripgrep','node-pty','unrs-resolver']) {
            const directory = path.join(dependencies, name); fs.mkdirSync(directory, { recursive: true });
            const prefix = `const assert=require('node:assert/strict'),fs=require('node:fs');
assert.equal(require('native-probe-sibling').identity,'hoisted-sibling');
assert.throws(()=>require('native-probe-host-only'),{code:'MODULE_NOT_FOUND'});
assert.equal(fs.existsSync(${JSON.stringify(hostOnly)}),false);
assert.throws(()=>fs.readFileSync(${JSON.stringify(sentinel)}));
assert.throws(()=>fs.writeFileSync('/deps/node_modules/forbidden','x'));
assert.ok(fs.existsSync('/deps/node_modules/native-probe-sibling/index.js'));
assert.equal(process.env.DATABASE_PATH,undefined);assert.equal(process.env.NODE_OPTIONS,undefined);
assert.equal(process.env.NODE_PATH,undefined);
assert.equal(process.env.LIBMOUNT_FORCE_MOUNT2,undefined);
assert.equal(process.env.HOME,${JSON.stringify(process.env.HOME)});
assert.equal(fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:\\s*(.+)$/m)[1],'0000000000000000');
const proc=fs.readFileSync('/proc/self/mountinfo','utf8').split(String.fromCharCode(10)).map(line=>line.split(' ')).find(fields=>fields[4]==='/proc');
for(const flag of ['ro','nosuid','nodev','noexec'])assert.ok(proc[5].split(',').includes(flag));
`;
            const body = name === 'bcrypt' ? 'module.exports={hashSync:()=>"ok",compareSync:()=>true};'
                : name === 'better-sqlite3' ? 'module.exports=class {constructor(file){assert.equal(file,":memory:")} prepare(){return {get:()=>({ok:1})}} close(){}};'
                    : 'module.exports={};';
            fs.writeFileSync(path.join(directory, 'index.js'), prefix + body, { mode: 0o444 });
        }
        function seal(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) seal(path.join(directory, entry.name)); fs.chmodSync(directory, 0o555); }
        seal(dependencies);
        fs.chmodSync(dependencies, 0o700);
        const expected = { transactionNonce: 'f'.repeat(64), nodeModulesTreeSha256: hashDependencyTreeV2(dependencies, { requireSealed: true }).sha256, installRuntime: runtime };
        const result = runOidTripleNativeProbe(root, dependencies, expected);
        assert.equal(result.processExited, true); assert.equal(result.loaded.length, 8);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must-remain-private');
        assert.equal(hashDependencyTreeV2(dependencies, { requireSealed: true }).sha256, expected.nodeModulesTreeSha256);
    } finally {
        function writable(directory) { fs.chmodSync(directory, 0o700); for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) writable(path.join(directory, entry.name)); }
        writable(root); fs.rmSync(root, { recursive: true, force: true });
    }
});


test('killing native probe owner kills unshare, namespace PID1 and its descendants', { timeout: 20000 }, async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'oid-native-owner-death-'));
    let owner; const observed = new Map();
    const identity = pid => {
        try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return { state: stat[0], start: stat[19] }; }
        catch { return null; }
    };
    const descendants = pid => {
        let children = [];
        try { children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
        return children.flatMap(child => [child, ...descendants(child)]);
    };
    const waitUntil = async predicate => { const deadline = Date.now() + 10000; while (!predicate()) { assert.ok(Date.now() < deadline, 'process lifetime checkpoint timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
    try {
        assert.equal(spawnSync('git', ['init'], { cwd: root }).status, 0);
        const dependencies = path.join(root, 'node_modules'); fs.mkdirSync(dependencies, { mode: 0o700 });
        const bcrypt = path.join(dependencies, 'bcrypt'); fs.mkdirSync(bcrypt, { mode: 0o755 });
        fs.writeFileSync(path.join(bcrypt, 'index.js'), `require('node:child_process').spawn('/usr/bin/sleep',['120'],{stdio:'ignore'}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120000);`, { mode: 0o444 });
        fs.chmodSync(bcrypt, 0o555);
        const expected = { transactionNonce: 'f'.repeat(64), nodeModulesTreeSha256: hashDependencyTreeV2(dependencies, { requireSealed: true }).sha256,
            installRuntime: { nodeVersion: process.version, nodeModuleAbi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch,
                nodeBinarySha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') } };
        const moduleUrl = new URL('./oid-control-capsule.mjs', import.meta.url).href;
        owner = spawn(process.execPath, ['--input-type=module', '-e', `import {runOidTripleNativeProbe} from ${JSON.stringify(moduleUrl)}; runOidTripleNativeProbe(${JSON.stringify(root)},${JSON.stringify(dependencies)},${JSON.stringify(expected)},{timeoutMs:120000});`], { stdio: ['ignore','ignore','pipe'] });
        let errors = ''; owner.stderr.on('data', chunk => { errors += chunk; });
        await waitUntil(() => {
            assert.equal(owner.exitCode, null, errors);
            const processes = descendants(owner.pid);
            for (const pid of processes) { const stat = identity(pid); if (stat) observed.set(pid, stat.start); }
            return processes.some(pid => { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'sleep'; } catch { return false; } });
        });
        assert.ok(observed.size >= 3, 'unshare, namespace PID1 and native descendant observed');
        const exited = new Promise(resolve => owner.once('exit', resolve)); owner.kill('SIGKILL'); await exited;
        await waitUntil(() => [...observed].every(([pid,start]) => { const stat=identity(pid); return !stat || stat.start !== start || stat.state === 'Z'; }));
    } finally {
        if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
        for (const [pid,start] of observed) { const stat=identity(pid); if (stat?.start === start && stat.state !== 'Z') { try { process.kill(pid,'SIGKILL'); } catch {} } }
        fs.chmodSync(path.join(root,'node_modules','bcrypt'),0o700);
        fs.rmSync(root,{recursive:true,force:true});
    }
});
