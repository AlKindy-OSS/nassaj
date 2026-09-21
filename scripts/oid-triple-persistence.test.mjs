import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { persistOidTriplePm2Slot, validateOidTriplePm2Dump, validateOidTriplePm2AuthorityChain, captureOidTriplePm2Authority, assertOidTriplePm2Authority } from './oid-control-capsule.mjs';
import { oidTriplePm2TransportFixture, attachOidTripleSocketFixture } from './oid-triple-test-fixtures.mjs';

function fixture() {
    const root=fs.mkdtempSync(path.resolve('.artifacts/oid-triple-persistence-'));
    const child={pid:process.pid,startTime:fs.readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ')[19],bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
    const transaction={schema:'nassaj-oid-control-transaction/v2',sequence:1,actionId:'fixture',targetDigest:'c'.repeat(64),transactionNonce:'a'.repeat(64),bootNonce:'b'.repeat(64),state:'triple_candidate_start_intent',pair:{databaseState:'UNKNOWN',targetDigest:'c'.repeat(64)}};
    transaction.supervisor=oidTriplePm2TransportFixture(root,child,transaction);
    return {root,child,transaction,file:path.join(root,'journal.json')};
}

test('PM2 dump validator rejects duplicate, status, script and nonce drift; dump has no persisted process id',()=>{
    const f=fixture();
    try {
        const slot=JSON.parse(fs.readFileSync(path.join(f.transaction.supervisor.pm2Home,'slots.json')))[0];
        const saved={...slot.pm2_env,name:slot.name};
        assert.equal(validateOidTriplePm2Dump([saved],slot),true);
        for(const rows of [[saved,saved],[{...saved,status:'stopped'}],[{...saved,pm_exec_path:'/foreign/index.js'}],[{...saved,pm_id:4}],
            [{...saved,env:{...saved.env,NASSAJ_PREVIEW_BOOT_NONCE:'foreign'}}]])assert.throws(()=>validateOidTriplePm2Dump(rows,slot),/dump_|environment_shadow/);
    } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('dump CAS preserves other definitions and reconciles lost receipt without PM2 save', async t => {
    const f=fixture(), close=await attachOidTripleSocketFixture(f.transaction.supervisor);
    t.after(async()=>{await close();fs.rmSync(f.root,{recursive:true,force:true});});
    const home=f.transaction.supervisor.pm2Home, dump=path.join(home,'dump.pm2');
    const rows=JSON.parse(fs.readFileSync(dump));rows.push({name:'untouched',env:{PRIVATE:'preserved'},metadata:{module:true}});
    fs.writeFileSync(dump,JSON.stringify(rows));
    const {createHash}=await import('node:crypto');const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
    f.transaction.supervisor.dumpSha256=sha(fs.readFileSync(dump));
    f.transaction.persistence={stopped:{dumpSha256:f.transaction.supervisor.dumpSha256}};
    fs.writeFileSync(f.file,JSON.stringify(f.transaction),{mode:0o600});
    const result=await persistOidTriplePm2Slot(f.root,f.file,f.transaction,'online',f.child);
    assert.equal(result.persistence.online.state,'verified');
    assert.deepEqual(JSON.parse(fs.readFileSync(dump))[1],rows[1]);
    assert.equal(fs.existsSync(path.join(home,'commands')),false);
    const interrupted={...result,persistence:{...result.persistence,online:{...result.persistence.online,state:'intent'}}};
    fs.writeFileSync(f.file,JSON.stringify(interrupted));
    assert.equal((await persistOidTriplePm2Slot(f.root,f.file,interrupted,'online',f.child)).persistence.online.state,'verified');
    fs.writeFileSync(dump,'not json');
    await assert.rejects(persistOidTriplePm2Slot(f.root,f.file,result,'online',f.child),/dump_cas_changed/);
});

test('stopped persistence proves old death and rejects changed environment before CAS', async t => {
    const f=fixture(), close=await attachOidTripleSocketFixture(f.transaction.supervisor);
    t.after(async()=>{await close();fs.rmSync(f.root,{recursive:true,force:true});});
    const ended=spawnSync(process.execPath,['-e','process.stdout.write(require("node:fs").readFileSync("/proc/self/stat","utf8").split(") ")[1].split(" ")[19])'],{encoding:'utf8'});
    f.transaction.pair={...f.transaction.pair,databaseState:'PRE_CANDIDATE',previous:{runtime:{pid:ended.pid,startTime:ended.stdout,bootId:f.child.bootId}}};
    const file=path.join(f.transaction.supervisor.pm2Home,'slots.json'),rows=JSON.parse(fs.readFileSync(file));
    rows[0].pid=0;rows[0].pm2_env.status='stopped';fs.writeFileSync(file,JSON.stringify(rows));
    fs.writeFileSync(f.file,JSON.stringify(f.transaction),{mode:0o600});
    const result=await persistOidTriplePm2Slot(f.root,f.file,f.transaction,'stopped');
    assert.equal(result.persistence.stopped.state,'verified');
    rows[0].pm2_env.env.NASSAJ_UPDATE_MODE='release';fs.writeFileSync(file,JSON.stringify(rows));
    await assert.rejects(persistOidTriplePm2Slot(f.root,f.file,result,'stopped'),/stop_changed/);
});


test('effective PM2 authority allows a private service boundary and rejects exposed writable ancestors',()=>{
    const record=(path,uid,mode)=>({path,uid,gid:uid,mode,dev:'1',ino:String(path.length)});
    const chain=[record('/',0,0o755),record('/srv',0,0o755),record('/srv/fixture-service',1000,0o700),record('/srv/fixture-service/.pm2',1000,0o775)];
    assert.equal(validateOidTriplePm2AuthorityChain(chain,1000),true);
    assert.throws(()=>validateOidTriplePm2AuthorityChain(chain.map(entry=>entry.path==='/srv/fixture-service'?{...entry,mode:0o755}:entry),1000),/exposed_write/);
    assert.throws(()=>validateOidTriplePm2AuthorityChain(chain.map(entry=>entry.path==='/srv'?{...entry,mode:0o775}:entry),1000),/exposed_write/);
    assert.throws(()=>validateOidTriplePm2AuthorityChain(chain.map(entry=>entry.path.endsWith('.pm2')?{...entry,uid:1001}:entry),1000),/authority_invalid/);
    assert.equal(validateOidTriplePm2AuthorityChain(chain.map(entry=>entry.path==='/srv/fixture-service'?{...entry,mode:0o755}:entry).map(entry=>entry.path.endsWith('.pm2')?{...entry,mode:0o755}:entry),1000),true);
});

test('real authority pins detect private-boundary mode drift and parent replacement',()=>{
    const root=fs.mkdtempSync(path.resolve('.artifacts/oid-pm2-authority-'));
    try {
        const privateHome=path.join(root,'private'),pm2Home=path.join(privateHome,'.pm2');
        fs.mkdirSync(privateHome,{mode:0o700});fs.mkdirSync(pm2Home,{mode:0o775});fs.chmodSync(pm2Home,0o775);
        const supervisor={pm2Home,authority:captureOidTriplePm2Authority(pm2Home)};
        assert.equal(assertOidTriplePm2Authority(supervisor),true);
        fs.chmodSync(privateHome,0o755);assert.throws(()=>assertOidTriplePm2Authority(supervisor),/authority_changed/);
        fs.chmodSync(privateHome,0o700);assert.equal(assertOidTriplePm2Authority(supervisor),true);
        fs.renameSync(pm2Home,`${pm2Home}-previous`);fs.mkdirSync(pm2Home,{mode:0o775});fs.chmodSync(pm2Home,0o775);
        assert.throws(()=>assertOidTriplePm2Authority(supervisor),/authority_changed/);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
});

for (const point of ['triple_before_dump_cas','triple_after_dump_cas']) test(`real crash at ${point} reconciles one journaled CAS`, async t => {
    const f=fixture(), close=await attachOidTripleSocketFixture(f.transaction.supervisor);
    t.after(async()=>{await close();fs.rmSync(f.root,{recursive:true,force:true});});
    f.transaction.persistence={stopped:{dumpSha256:f.transaction.supervisor.dumpSha256}};
    fs.writeFileSync(f.file,JSON.stringify(f.transaction),{mode:0o600});
    const moduleUrl=new URL('./oid-control-capsule.mjs',import.meta.url).href;
    const program=`import {persistOidTriplePm2Slot} from ${JSON.stringify(moduleUrl)};await persistOidTriplePm2Slot(${JSON.stringify(f.root)},${JSON.stringify(f.file)},${JSON.stringify(f.transaction)},'online',${JSON.stringify(f.child)});`;
    const crashed=spawnSync(process.execPath,['--input-type=module','-e',program],{env:{...process.env,NODE_ENV:'test',NASSAJ_OID_CAPSULE_CRASH_AT:point},encoding:'utf8'});
    assert.equal(crashed.signal,'SIGKILL',crashed.stderr);
    const interrupted=JSON.parse(fs.readFileSync(f.file));
    assert.equal(interrupted.persistence.online.state,'intent');
    const result=await persistOidTriplePm2Slot(f.root,f.file,interrupted,'online',f.child);
    assert.equal(result.persistence.online.state,'verified');
    assert.equal(fs.existsSync(path.join(f.transaction.supervisor.pm2Home,'commands')),false);
});

test('competing writer between final read and exchange is preserved and never verified', async t => {
    const f=fixture(), close=await attachOidTripleSocketFixture(f.transaction.supervisor);
    t.after(async()=>{await close();fs.rmSync(f.root,{recursive:true,force:true});});
    const home=f.transaction.supervisor.pm2Home;
    f.transaction.persistence={stopped:{dumpSha256:f.transaction.supervisor.dumpSha256}};
    fs.writeFileSync(f.file,JSON.stringify(f.transaction),{mode:0o600});
    const competing=Buffer.from(JSON.stringify([{name:'another-service',env:{KEY:'must-survive'}}]));
    fs.writeFileSync(path.join(home,'competing-dump-fixture.json'),competing,{mode:0o600});
    const moduleUrl=new URL('./oid-control-capsule.mjs',import.meta.url).href;
    const program=`import {persistOidTriplePm2Slot} from ${JSON.stringify(moduleUrl)};try{await persistOidTriplePm2Slot(${JSON.stringify(f.root)},${JSON.stringify(f.file)},${JSON.stringify(f.transaction)},'online',${JSON.stringify(f.child)});}catch(e){process.stdout.write(e.message);process.exitCode=3;}`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',program],{env:{...process.env,NODE_ENV:'test',NASSAJ_OID_CAPSULE_FAIL_AT:'triple_dump_competing_writer'},encoding:'utf8'});
    assert.equal(result.status,3);assert.equal(result.stdout,'oid_triple_dump_cas_unknown');
    const journal=JSON.parse(fs.readFileSync(f.file)),intent=journal.persistence.online;
    assert.equal(intent.state,'unknown');
    assert.deepEqual(fs.readFileSync(path.join(home,intent.dumpCAS.stagedBasename)),competing);
    await assert.rejects(persistOidTriplePm2Slot(f.root,f.file,journal,'online',f.child),/dump_cas_/);
    assert.deepEqual(fs.readFileSync(path.join(home,intent.dumpCAS.stagedBasename)),competing);
});
