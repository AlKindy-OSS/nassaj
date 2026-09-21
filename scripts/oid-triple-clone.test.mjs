import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { prepareOidTripleDependencyExchange, oidTripleDependencySlot, oidTripleCloneBudget } from './oid-control-capsule.mjs';
import { hashDependencyTreeV2 } from './lib/dependency-tree-identity-v2.mjs';

function fixture() {
    const root=fs.mkdtempSync(path.join(process.env.TMPDIR||'/var/tmp','oid-triple-clone-'));
    fs.mkdirSync(path.join(root,'node_modules'),{mode:0o700});
    fs.writeFileSync(path.join(root,'node_modules','old'),'previous',{mode:0o444});
    const temporary=path.join(root,'candidate');fs.mkdirSync(temporary,{mode:0o700});
    for(const dir of ['.bin','pkg','empty'])fs.mkdirSync(path.join(temporary,dir),{mode:0o755});
    fs.writeFileSync(path.join(temporary,'pkg','cli'),'#!/usr/bin/env node\n',{mode:0o555});
    fs.writeFileSync(path.join(temporary,'pkg','binding.node'),Buffer.from([0,1,2,3]),{mode:0o444});
    fs.symlinkSync('../pkg/cli',path.join(temporary,'.bin','tool'));
    for(const dir of ['.bin','pkg','empty'])fs.chmodSync(path.join(temporary,dir),0o555);
    const identity=hashDependencyTreeV2(temporary,{requireSealed:true});
    const store=path.join(root,'.nassaj-local-preview','dependency-candidates');fs.mkdirSync(store,{recursive:true,mode:0o700});fs.chmodSync(store,0o700);
    const source=path.join(store,identity.sha256);fs.renameSync(temporary,source);
    const target={schema:'nassaj-oid-triple-target/v2',generationNames:['nodeModules','server','client'],installRuntime:{
        nodeBinarySha256:'a'.repeat(64),nodeVersion:process.version,nodeModuleAbi:process.versions.modules,napi:process.versions.napi,
        platform:process.platform,arch:process.arch,npmVersion:'12.0.2',npmCliSha256:'b'.repeat(64)}};
    for(const key of ['clientBuildId','serverBuildId','clientTreeSha256','serverTreeSha256','dependencyContractSha256','packageJsonSha256','packageLockSha256','installPolicySha256','controlManifestSha256'])target[key]='c'.repeat(64);
    target.nodeModulesTreeSha256=identity.sha256;
    const transaction={schema:'nassaj-oid-control-transaction/v2',transactionNonce:'d'.repeat(64),pair:{target,targetDigest:'e'.repeat(64),databaseState:'PRE_CANDIDATE'}};
    return {root,source,identity,transaction,file:path.join(root,'journal.json')};
}
function cleanup(root) {function walk(dir){fs.chmodSync(dir,0o700);for(const entry of fs.readdirSync(dir,{withFileTypes:true}))if(entry.isDirectory())walk(path.join(dir,entry.name));}walk(root);fs.rmSync(root,{recursive:true,force:true});}

test('dependency candidate fixture stays private with a group-permissive umask',()=>{
    let f;const previous=process.umask(0o002);
    try { f=fixture(); }
    finally { process.umask(previous); }
    try { assert.equal(fs.statSync(path.dirname(f.source)).mode&0o777,0o700); }
    finally { cleanup(f.root); }
});

test('canonical stays immutable through independent transaction copies with the same tree and different contracts',()=>{
    const f=fixture();
    try {
        let first=prepareOidTripleDependencyExchange(f.root,f.file,f.transaction);
        const slot=oidTripleDependencySlot(f.root,first), sourceInode=fs.statSync(path.join(f.source,'pkg','binding.node')).ino;
        assert.notEqual(fs.statSync(path.join(slot,'pkg','binding.node')).ino,sourceInode);
        assert.equal(fs.readlinkSync(path.join(slot,'.bin','tool')),'../pkg/cli');
        const journalBytes=fs.readFileSync(f.file);
        assert.equal(spawnSync('/usr/bin/mv',['--exchange','--no-copy','-T',path.join(f.root,'node_modules'),slot]).status,0);
        const oldAtSlot=hashDependencyTreeV2(slot).sha256;
        const second={...f.transaction,transactionNonce:'f'.repeat(64),pair:{...f.transaction.pair,targetDigest:'a'.repeat(64),target:{...f.transaction.pair.target,dependencyContractSha256:'b'.repeat(64)}}};
        const prepared=prepareOidTripleDependencyExchange(f.root,path.join(f.root,'second.json'),second);
        assert.equal(hashDependencyTreeV2(oidTripleDependencySlot(f.root,prepared),{requireSealed:true}).sha256,f.identity.sha256);
        assert.deepEqual(fs.readFileSync(f.file),journalBytes);
        assert.equal(hashDependencyTreeV2(slot).sha256,oldAtSlot);
        assert.deepEqual(hashDependencyTreeV2(f.source,{requireSealed:true}),f.identity);
        assert.equal(fs.statSync(path.join(f.source,'pkg','binding.node')).ino,sourceInode);
        assert.equal(spawnSync('/usr/bin/mv',['--exchange','--no-copy','-T',path.join(f.root,'node_modules'),slot]).status,0);
        assert.equal(hashDependencyTreeV2(slot,{requireSealed:true}).sha256,f.identity.sha256);
    } finally {cleanup(f.root);}
});

for(const seam of ['triple_clone_after_intent','triple_clone_after_copy','triple_clone_after_publish'])test(`actual owner death at ${seam} preserves live and either verifies publication or refuses partial`,()=>{
    const f=fixture();
    try {
        const before=hashDependencyTreeV2(path.join(f.root,'node_modules'));
        const moduleUrl=new URL('./oid-control-capsule.mjs',import.meta.url).href;
        const result=spawnSync(process.execPath,['--input-type=module','-e',`import {prepareOidTripleDependencyExchange} from ${JSON.stringify(moduleUrl)};prepareOidTripleDependencyExchange(${JSON.stringify(f.root)},${JSON.stringify(f.file)},${JSON.stringify(f.transaction)});`],
            {env:{...process.env,NODE_ENV:'test',NASSAJ_OID_CAPSULE_CRASH_AT:seam},encoding:'utf8'});
        assert.equal(result.signal,'SIGKILL',result.stderr);
        const interrupted=JSON.parse(fs.readFileSync(f.file));assert.equal(interrupted.oldStopIntentAt,undefined);
        assert.deepEqual(hashDependencyTreeV2(path.join(f.root,'node_modules')),before);
        if(seam==='triple_clone_after_copy')assert.throws(()=>prepareOidTripleDependencyExchange(f.root,f.file,interrupted),/partial_requires_review/);
        else assert.equal(prepareOidTripleDependencyExchange(f.root,f.file,interrupted).dependencyExchange.phase,'ready');
        assert.deepEqual(hashDependencyTreeV2(f.source,{requireSealed:true}),f.identity);
    } finally {cleanup(f.root);}
});

test('space and inode insufficiency refuse before copying; unknown or missing slot never becomes canonical',()=>{
    const f=fixture();
    try {
        assert.throws(()=>oidTripleCloneBudget(f.source,{bsize:4096,bavail:1,ffree:100000}),/storage_unavailable/);
        assert.throws(()=>oidTripleCloneBudget(f.source,{bsize:4096,bavail:100000,ffree:1}),/storage_unavailable/);
        assert.throws(()=>oidTripleCloneBudget(f.source,{bsize:4096,bavail:100000,ffree:100000},NaN),/budget_unknown/);
        assert.throws(()=>oidTripleDependencySlot(f.root,f.transaction),/slot_unverified/);
        const prepared=prepareOidTripleDependencyExchange(f.root,f.file,f.transaction),slot=oidTripleDependencySlot(f.root,prepared);
        fs.renameSync(slot,path.join(path.dirname(slot),'retained'));
        const pathOnly=oidTripleDependencySlot(f.root,prepared);assert.equal(fs.existsSync(pathOnly),false);
        assert.throws(()=>prepareOidTripleDependencyExchange(f.root,f.file,{...prepared,oldStopIntentAt:Date.now()}),/after_stop_forbidden/);
        assert.throws(()=>prepareOidTripleDependencyExchange(f.root,f.file,prepared),/partial_requires_review/);
    } finally {cleanup(f.root);}
});

test('clone rejects shared hardlinks, unsafe ancestors and changed transaction parent identity',()=>{
    for(const variant of ['hardlink','ancestor-mode','ancestor-link','parent-identity']) {
        const f=fixture();
        try {
            if(variant==='hardlink') { fs.linkSync(path.join(f.source,'pkg','binding.node'),path.join(f.root,'shared'));assert.throws(()=>prepareOidTripleDependencyExchange(f.root,f.file,f.transaction),/shared_hardlink/); }
            if(variant==='ancestor-mode') { fs.chmodSync(path.dirname(f.source),0o777);assert.throws(()=>prepareOidTripleDependencyExchange(f.root,f.file,f.transaction),/parent_unsafe/); }
            if(variant==='ancestor-link') {
                const store=path.dirname(f.source),moved=path.join(f.root,'foreign-store');fs.renameSync(store,moved);fs.symlinkSync(moved,store);
                assert.throws(()=>prepareOidTripleDependencyExchange(f.root,f.file,f.transaction),/parent_unsafe/);
            }
            if(variant==='parent-identity') {
                const prepared=prepareOidTripleDependencyExchange(f.root,f.file,f.transaction),slot=oidTripleDependencySlot(f.root,prepared),parent=path.dirname(slot);
                fs.renameSync(parent,`${parent}-retained`);fs.mkdirSync(parent,{mode:0o700});
                assert.throws(()=>oidTripleDependencySlot(f.root,prepared),/slot_unverified/);
            }
        } finally {cleanup(f.root);}
    }
});


test('verified internal aliases become independent clone inodes without changing identity',()=>{
    const f=fixture();
    try {
        fs.chmodSync(path.join(f.source,'pkg'),0o755);
        fs.linkSync(path.join(f.source,'pkg','binding.node'),path.join(f.source,'pkg','binding-alias.node'));
        fs.chmodSync(path.join(f.source,'pkg'),0o555);
        const identity=hashDependencyTreeV2(f.source,{requireSealed:true});
        const destination=path.join(path.dirname(f.source),identity.sha256);fs.renameSync(f.source,destination);
        f.transaction.pair.target.nodeModulesTreeSha256=identity.sha256;
        const prepared=prepareOidTripleDependencyExchange(f.root,f.file,f.transaction),slot=oidTripleDependencySlot(f.root,prepared);
        assert.deepEqual(hashDependencyTreeV2(slot,{requireSealed:true}),identity);
        assert.equal(fs.statSync(path.join(destination,'pkg','binding.node')).nlink,2);
        assert.equal(fs.statSync(path.join(slot,'pkg','binding.node')).nlink,1);
        assert.equal(fs.statSync(path.join(slot,'pkg','binding-alias.node')).nlink,1);
        assert.notEqual(fs.statSync(path.join(slot,'pkg','binding.node')).ino,fs.statSync(path.join(slot,'pkg','binding-alias.node')).ino);
    } finally {cleanup(f.root);}
});

test('durable executor readiness precedes a delayed clone and never grants stop',async()=>{
    const f=fixture();let child;
    try {
        const nonce=f.transaction.transactionNonce,handshake=path.join(f.root,`nassaj-oid-control-handshake-${nonce}.json`);
        const transaction={...f.transaction,state:'triple_prepared',sequence:1,oid:'a'.repeat(40),actionId:'11111111-1111-4111-8111-111111111111'};
        const record={repoRoot:f.root,transactionNonce:nonce,actionId:transaction.actionId,pair:{targetDigest:transaction.pair.targetDigest},handshakePath:handshake};
        fs.writeFileSync(f.file,JSON.stringify(transaction),{mode:0o600});const marker=path.join(f.root,'clone-blocked'),release=path.join(f.root,'clone-release');
        const url=new URL('./oid-control-capsule.mjs',import.meta.url).href;
        const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.fsyncSync;let paused=false;
fs.fsyncSync=fd=>{const target=fs.readlinkSync('/proc/self/fd/'+fd);if(!paused&&target.includes('/dependency-exchanges/')){paused=true;fs.writeFileSync(${JSON.stringify(marker)},'blocked');const until=Date.now()+5000;while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>until)throw Error('test_clone_delay_timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}return original(fd);};syncBuiltinESMExports();
const {prepareOidTripleClaimedDependencyExchange}=await import(${JSON.stringify(url)});prepareOidTripleClaimedDependencyExchange(${JSON.stringify(f.root)},${JSON.stringify(f.file)},${JSON.stringify(transaction)},${JSON.stringify(record)});`;
        child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>{stderr+=b;});
        const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code));});
        const until=Date.now()+5000;while(!fs.existsSync(marker)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(fs.existsSync(marker),stderr);
        assert.equal(JSON.parse(fs.readFileSync(handshake)).state,'executor_ready');const during=JSON.parse(fs.readFileSync(f.file));
        assert.equal(during.oldStopIntentAt,undefined);assert.notEqual(during.dependencyExchange?.phase,'ready');assert.ok(fs.existsSync(path.join(f.root,'node_modules/old')));
        fs.writeFileSync(release,'continue');assert.equal(await completion,0,stderr);
        const done=JSON.parse(fs.readFileSync(f.file));assert.equal(done.dependencyExchange.phase,'ready');assert.equal(done.oldStopIntentAt,undefined);
    } finally {child?.kill('SIGKILL');cleanup(f.root);}
});
