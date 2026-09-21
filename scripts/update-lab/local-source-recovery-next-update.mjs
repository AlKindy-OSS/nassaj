/** Actual second owner update through the installed consumer and application prepare/confirm endpoints. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readTripleFailedTerminal} from './triple-terminal-observation.mjs';
import {assertRecoveryLabBoundary} from './local-source-recovery-tls.mjs';
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Create a one-file main commit using a separate index so pre-existing staged fixture bytes survive. */
export function advanceRecoveryLabMain(lab) {
    assertRecoveryLabBoundary(lab);const app=path.join(lab,'app'),index=path.join(lab,'next-source.index');
    const git=(args,input)=>{const r=spawnSync('/usr/bin/git',args,{cwd:app,input,encoding:'utf8',env:{...process.env,GIT_INDEX_FILE:index}});
        if(r.status!==0)throw Error('lab_next_main_failed:'+r.stderr);return r.stdout.trim();};
    const parent=git(['rev-parse','HEAD']);git(['read-tree',parent]);
    const blob=git(['hash-object','-w','--stdin'],'isolated second update; dependencies unchanged\n');
    git(['update-index','--add','--cacheinfo',`100644,${blob},local-recovery-lab-marker.txt`]);
    const tree=git(['write-tree']),oid=git(['commit-tree',tree,'-p',parent,'-m','test: isolated next local main update']);
    git(['update-ref','refs/heads/main',oid,parent]);
    fs.writeFileSync(path.join(app,'local-recovery-lab-marker.txt'),'isolated second update; dependencies unchanged\n');
    assert.deepEqual(git(['diff','--name-only',parent,oid]).split('\n'),['local-recovery-lab-marker.txt']);
    return oid;
}

/** Use the same launcher argv/cwd as the installed service; the launcher owns --repo. */
export function spawnRecoveryLabConsumer(app,log,spawnProcess=spawn) {
    return spawnProcess(process.execPath,[path.join(app,'scripts/client-publication-consumer-launcher.mjs')],{
        cwd:app,env:{...process.env,NASSAJ_UPDATE_MODE:'local-main',NASSAJ_PREVIEW_OID_ENFORCEMENT:'1',NASSAJ_PREVIEW_OID_DOMAINS:'client,server'},
        stdio:['ignore',log,log]});
}

/** Exercise preparation, user consent, installation and typed terminal receipt; prepared alone never passes. */
export async function runRecoveryLabNextUpdate(lab,meta,{headers,waitHealth}) {
    assertRecoveryLabBoundary(lab);const app=path.join(lab,'app'),oid=advanceRecoveryLabMain(lab);
    const beforeIndex=sha(fs.readFileSync(path.join(app,'.git/index')));
    const base=`http://127.0.0.1:${meta.port}/api/system/update/local`;
    const response=await fetch(base+'/prepare',{method:'POST',headers:{...headers,'Idempotency-Key':'local-recovery-lab-next-0001'},body:JSON.stringify({expectedOid:oid})});
    const requested=await response.json();assert.equal(response.status,202,JSON.stringify(requested));
    const sequence=requested.update.sequence,eventFile=path.join(app,'.git',`nassaj-preview-oid-event-control-${String(sequence).padStart(16,'0')}.json`);
    let consumer,timer;
    try {
        const seeded=new Set();timer=setInterval(()=>{
            const builds=path.join(app,'.nassaj-local-preview/oid-builds',oid);if(!fs.existsSync(builds))return;
            for(const nonce of fs.readdirSync(builds)) {
                if(!/^[a-f0-9]{64}$/.test(nonce)||seeded.has(nonce))continue;
                const temporary=path.join(builds,nonce,'tmp');if(!fs.existsSync(temporary))continue;
                const cache=path.join(temporary,'vscode-ripgrep-cache-1.17.1');fs.mkdirSync(cache,{recursive:true,mode:0o700});
                const name='ripgrep-v15.0.1-x86_64-unknown-linux-musl.tar.gz';
                fs.copyFileSync(path.join(lab,'public-material',name),path.join(cache,name));seeded.add(nonce);
            }
        },50);
        const log=fs.openSync(path.join(lab,'logs/local-next-consumer.log'),'w');
        consumer=spawnRecoveryLabConsumer(app,log);fs.closeSync(log);
        let prepared;const until=Date.now()+900000;
        while(Date.now()<until) {
            if(consumer.exitCode!==null)throw Error('lab_installed_consumer_exited:'+consumer.exitCode);
            const local=JSON.parse(fs.readFileSync(eventFile)).localUpdate;
            if(local.phase==='prepared'){prepared=local;break;}
            if(['failed','cancelled','superseded'].includes(local.phase))throw Error('lab_next_prepare_failed:'+local.phase);
            await tick(500);
        }
        if(!prepared)throw Error('lab_next_prepare_timeout');
        clearInterval(timer);timer=null;
        const confirmation=await fetch(`${base}/${sequence}/confirm`,{method:'POST',headers,body:JSON.stringify({expectedRevision:prepared.revision,targetDigest:prepared.targetDigest})});
        assert.equal(confirmation.status,202,await confirmation.text());
        const health=await waitHealth(oid,900000,()=>{
            const failure=readTripleFailedTerminal(path.join(app,'.git'),{sequence,targetDigest:prepared.targetDigest});
            if(failure)throw Error('lab_next_terminal_failed:'+failure.state);
        });
        assert.equal(health.serverLoadedBuildId,prepared.target.serverBuildId);
        assert.equal(health.clientBuildIdServed,prepared.target.clientBuildId);
        assert.equal(health.oidNodeModulesTreeSha256,prepared.target.nodeModulesTreeSha256);
        let journal;const settle=Date.now()+60000;
        while(Date.now()<settle) {
            if(JSON.parse(fs.readFileSync(eventFile)).localUpdate.phase==='activated') {
                const names=fs.readdirSync(path.join(app,'.git')).filter(name=>name.startsWith(`nassaj-oid-control-transaction-${sequence}-`)&&name.endsWith('.json'));
                assert.equal(names.length,1);journal=JSON.parse(fs.readFileSync(path.join(app,'.git',names[0])));break;
            }await tick(250);
        }
        assert.ok(journal);assert.equal(journal.state,'pair_served');assert.equal(journal.persistence.online.state,'verified');
        const serving=JSON.parse(fs.readFileSync(path.join(app,'.git',`nassaj-oid-pair-serving-${journal.transactionNonce}.json`)));
        assert.equal(serving.schema,'nassaj-oid-triple-serving/v2');assert.equal(serving.nodeModulesTreeSha256,prepared.target.nodeModulesTreeSha256);
        assert.equal(journal.pair.receipt.pid,health.pid);assert.equal(beforeIndex,sha(fs.readFileSync(path.join(app,'.git/index'))));
        return {oid,sequence,target:prepared.target,health,terminalState:journal.state,serving,indexPreserved:true};
    } finally {if(timer)clearInterval(timer);if(consumer&&consumer.exitCode===null){const ended=new Promise(resolve=>consumer.once('exit',resolve));consumer.kill('SIGTERM');await ended;}}
}
