/** Private full old-runtime → source handoff → local-main → next owner-button update rehearsal. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {assertRecoveryLabBoundary,prepareRecoveryLabTls,startRecoveryLabTlsHealth} from './local-source-recovery-tls.mjs';
import {prepareRecoveryLabPacket,registerRecoveryLabPacket} from './local-source-recovery-fixture.mjs';
import {resolveRecoveryLabAsset,verifyRecoveryLabAssetBytes} from './local-source-recovery-assets.mjs';
import {runRecoveryLabNextUpdate} from './local-source-recovery-next-update.mjs';
import {recoveryLabScope,finishRecoveryLabScope} from './local-source-recovery-scope.mjs';
import {seedBridgeData,assertBridgeData,assertBridgeAuthentication} from './bridge-data-fixture.mjs';
const lab=process.cwd();assertRecoveryLabBoundary(lab);
const app=path.join(lab,'app'),meta=JSON.parse(fs.readFileSync(path.join(lab,'scenario.json')));
assert.equal(meta.localSourceRecovery,true);assert.equal(meta.port,3004);assert.equal(meta.processName,'nassaj-dev');
const report={schema:'nassaj-local-source-recovery-full-lab/v1',state:'running',rehearsalScope:recoveryLabScope(meta.rehearsalScope),sourceOid:meta.sourceOid,productionManifestSha256:meta.productionManifestSha256,trees:meta.sealedManifest.trees};
const write=()=>fs.writeFileSync(path.join(lab,'local-source-recovery-result.json'),JSON.stringify(report,null,2),{mode:0o600});
const checkpoint=stage=>{report.stage=stage;report.observedAt=new Date().toISOString();write();};
const sha=value=>createHash('sha256').update(value).digest('hex');
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const command=(program,args)=>{const r=spawnSync(program,args,{cwd:app,env:process.env,encoding:'utf8',timeout:30000});if(r.status!==0)throw Error('lab_command_failed:'+path.basename(program)+':'+r.stderr);return r.stdout.trim();};
const pm2=args=>command('/usr/bin/pm2',args);
const readDb=callback=>{const db=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});try{return callback(db);}finally{db.close();}};
async function waitHealth(oid,timeout=90000,observe=()=>{}) {
    const until=Date.now()+timeout;
    while(Date.now()<until) {
        observe();
        try {const response=await fetch(`http://127.0.0.1:${meta.port}/health`,{signal:AbortSignal.timeout(1000)});
            if(response.ok){const value=await response.json();if(value.serverLoadedOid===oid&&value.normalAdmissionReady===true)return value;}}
        catch {}
        await tick(250);
    }throw Error('lab_health_timeout:'+oid);
}
async function login() {
    const env=fs.readFileSync(path.join(app,'.env'),'utf8'),password=env.split('\n').find(line=>line.startsWith('BOOTSTRAP_OWNER_PASSWORD=')).slice('BOOTSTRAP_OWNER_PASSWORD='.length);
    const response=await fetch(`http://127.0.0.1:${meta.port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'bridgeowner',password})});
    assert.equal(response.status,200);return {'Content-Type':'application/json',Authorization:`Bearer ${(await response.json()).token}`};
}
async function assertAssets(expectedBuildId) {
    const dist=path.join(app,'dist'),manifest=JSON.parse(fs.readFileSync(path.join(dist,'CLIENT_ASSET_MANIFEST.json')));
    const html=await (await fetch(`http://127.0.0.1:${meta.port}/`)).text();
    const urls=[...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match=>match[1]);assert.ok(urls.length>0);
    const checked=[];
    for(const url of [...new Set(urls)]) {
        const asset=resolveRecoveryLabAsset(dist,url,manifest,expectedBuildId);
        const response=await fetch(`http://127.0.0.1:${meta.port}${url}`);assert.equal(response.status,200);
        checked.push({url,...verifyRecoveryLabAssetBytes(asset,fs.readFileSync(asset.file),Buffer.from(await response.arrayBuffer()))});
    }return checked;
}
function dirtyFixture() {
    const staged=path.join(app,'local-recovery-staged.txt'),untracked=path.join(app,'local-recovery-untracked.txt'),tracked=path.join(app,'README.md');
    fs.writeFileSync(staged,'preserve staged fixture\n');command('/usr/bin/git',['add','--','local-recovery-staged.txt']);
    fs.writeFileSync(untracked,'preserve untracked fixture\n');fs.appendFileSync(tracked,'\n<!-- private local recovery fixture -->\n');
    const files=[staged,untracked,tracked,path.join(app,'.git/index')];return {files,hashes:files.map(file=>sha(fs.readFileSync(file))),head:command('/usr/bin/git',['rev-parse','HEAD'])};
}
let tlsHealth;
try {
    checkpoint('starting-actual-old-runtime');
    pm2(['start',path.join(lab,'ecosystem.config.cjs')]);await waitHealth(meta.old.oid);
    pm2(['stop',meta.processName]);await seedBridgeData(lab);pm2(['restart',meta.processName]);
    const old=await waitHealth(meta.old.oid);pm2(['save']);
    assert.equal(old.serverLoadedBuildId,meta.old.buildId);assert.equal(old.updateMode,'release');
    const slot=JSON.parse(pm2(['jlist'])).find(row=>row.name===meta.processName);
    assert.equal(slot.pm2_env.pm_exec_path,path.join(app,'dist-server/server/index.js'));assert.equal(slot.pm2_env.NASSAJ_UPDATE_MODE,undefined);
    const saved=JSON.parse(fs.readFileSync(path.join(process.env.PM2_HOME,'dump.pm2'))).find(row=>row.name===meta.processName);
    assert.equal(saved.NASSAJ_UPDATE_MODE,undefined);assert.equal(saved.env?.NASSAJ_UPDATE_MODE,undefined);
    report.old={pid:old.pid,startTicks:old.serverProcessStartTicks,oid:old.serverLoadedOid,buildId:old.serverLoadedBuildId};
    report.baselineData=await assertBridgeData(lab);report.baselineAuth=await assertBridgeAuthentication(lab,meta.port);
    const material=prepareRecoveryLabTls(lab);tlsHealth=await startRecoveryLabTlsHealth(lab,material,meta.port);
    const packet=await prepareRecoveryLabPacket(lab,meta,old,tlsHealth.url);
    const dirty=dirtyFixture();
    report.registration=await registerRecoveryLabPacket(lab,packet,material.cert);
    const queued=readDb(db=>db.prepare('SELECT * FROM source_update_jobs WHERE id=?').get(packet.jobId));
    assert.equal(queued.state,'restart_queued');assert.equal(queued.auto_activate,0);
    checkpoint('actual-source-candidate-registered');
    const headers=await login();
    const confirmation=await fetch(`http://127.0.0.1:${meta.port}/api/system/update/jobs/${packet.jobId}/confirm`,{
        method:'POST',headers,body:JSON.stringify({expectedVersion:packet.receipt.version,targetDigest:queued.activation_identity_sha256})});
    assert.equal(confirmation.status,202,await confirmation.text());checkpoint('source-button-consent-confirmed');
    const first=await waitHealth(meta.sourceOid,180000);
    assert.equal(first.updateMode,'local-main');assert.equal(first.serverLoadedBuildId,meta.sealedManifest.serverBuildId);
    assert.equal(first.clientBuildIdServed,meta.sealedManifest.clientBuildId);assert.notEqual(first.pid,old.pid);
    const until=Date.now()+30000;let activated;
    while(Date.now()<until){activated=readDb(db=>db.prepare('SELECT * FROM source_update_jobs WHERE id=?').get(packet.jobId));if(activated.state==='activated')break;await tick(250);}
    assert.equal(activated.state,'activated');
    const journal=JSON.parse(fs.readFileSync(path.join(app,'.git/nassaj-source-update/journal.json')));
    assert.equal(journal.state,'OPEN');assert.equal(journal.gateClosed,false);
    assert.deepEqual(dirty.files.map(file=>sha(fs.readFileSync(file))),dirty.hashes);assert.equal(command('/usr/bin/git',['rev-parse','HEAD']),dirty.head);
    const {hashTree}=await import(pathToFileURL(path.join(app,'scripts/lib/source-update-tree-identity.mjs')));
    const servedTrees={client:hashTree(path.join(app,'dist')),server:hashTree(path.join(app,'dist-server')),nodeModules:hashTree(path.join(app,'node_modules'))};
    assert.deepEqual(servedTrees,meta.sealedManifest.trees);
    report.firstBoot={health:first,jobState:activated.state,gateState:journal.state,dirtyIndexPreserved:true,servedTrees};
    report.firstAssets=await assertAssets(first.clientBuildIdServed);report.firstData=await assertBridgeData(lab);report.firstAuth=await assertBridgeAuthentication(lab,meta.port);
    checkpoint('actual-source-bootstrap-complete');
    const completion=await finishRecoveryLabScope(report.rehearsalScope,async()=>{
        report.next=await runRecoveryLabNextUpdate(lab,meta,{headers:await login(),waitHealth});
        report.nextAssets=await assertAssets(report.next.target.clientBuildId);report.nextData=await assertBridgeData(lab);report.nextAuth=await assertBridgeAuthentication(lab,meta.port);
    });
    Object.assign(report,completion);checkpoint(completion.stage);
} catch(error){report.state='failed';report.error=error.stack||error.message;process.exitCode=1;}
finally {if(tlsHealth)await tlsHealth.close();try{pm2(['kill']);}catch{}write();console.log(JSON.stringify(report));}
