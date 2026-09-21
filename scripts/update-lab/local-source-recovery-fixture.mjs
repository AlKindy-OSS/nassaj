/** Bind exact copied production artifacts to an honest, separate laboratory source operation. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {assertRecoveryLabBoundary} from './local-source-recovery-tls.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const write=(file,value)=>fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});

/** Seal a lab manifest with lab-only process/authority binding; do not alter artifact contents. */
export async function prepareRecoveryLabPacket(lab,meta,health,publicHealthUrl) {
    assertRecoveryLabBoundary(lab);
    const root=path.join(lab,'app'),load=name=>import(pathToFileURL(path.join(root,'scripts',name)));
    const producer=await load('local-source-recovery-candidate.mjs');
    const {hashTree}=await load('lib/source-update-tree-identity.mjs');
    const {recoveryDatabaseSchemaSha256}=await load('local-source-recovery-operator.mjs');
    const db=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});
    const ownerId=db.prepare("SELECT id FROM users WHERE username='bridgeowner' AND role='owner'").get().id;
    const dbStat=fs.statSync(process.env.DATABASE_PATH);
    const database={path:process.env.DATABASE_PATH,dev:dbStat.dev,ino:dbStat.ino,uid:dbStat.uid,schemaSha256:recoveryDatabaseSchemaSha256(db)};db.close();
    const transactionId='lab-'+randomUUID(),actionId=randomUUID(),jobId=randomUUID();
    const control=path.join(root,'.git/nassaj-source-update'),candidate=path.join(control,'candidates',transactionId);
    fs.mkdirSync(candidate,{recursive:true,mode:0o700});
    const original=fs.readFileSync(path.join(root,'.env'),'utf8');assert.doesNotMatch(original,/^NASSAJ_UPDATE_MODE=/m);
    const proposal=original+'NASSAJ_UPDATE_MODE=local-main\n';
    const config={schema:'nassaj-local-recovery-config/v1',id:'lab-mode-'+randomUUID(),root,transactionId,actionId,
        originalEnvSha256:sha(original),proposalEnvSha256:sha(proposal),approvalReference:'test-only:isolated-recovery-consent',reservationReference:'test-only:exclusive-private-root'};
    const proposalEnvPath=path.join(candidate,'local-recovery-proposal.env'),configReceiptPath=path.join(candidate,'local-recovery-config.json');
    write(proposalEnvPath,proposal);write(configReceiptPath,config);
    const operationBinding={schema:'nassaj-local-source-recovery-operation/v1',root,nodeIdentity:os.hostname(),jobId,actionId,transactionId,ownerId,
        approvalReference:config.approvalReference,reservationReference:config.reservationReference,previousSourceOid:meta.sourceOid,
        previousRuntime:{oid:health.serverLoadedOid,serverBuildId:health.serverLoadedBuildId,clientBuildId:health.clientBuildIdServed,
            pid:health.pid,startTicks:health.serverProcessStartTicks,controlManifestSha256:sha(fs.readFileSync(path.join(root,'dist-server/OID_CONTROL_MANIFEST.json'))),
            actualTrees:{client:hashTree(path.join(root,'dist')),server:hashTree(path.join(root,'dist-server')),nodeModules:hashTree(path.join(root,'node_modules'))}},
        modeTransition:{from:'release',to:'local-main',configReceiptId:config.id,configBindingSha256:sha(JSON.stringify(config)),
            originalEnvSha256:config.originalEnvSha256,proposalEnvSha256:config.proposalEnvSha256}};
    const prepared=await producer.prepareLocalSourceRecoveryCandidate({root,expectedOid:meta.sourceOid,txId:transactionId,operationBinding});
    const plan=JSON.parse(fs.readFileSync(prepared.planFile));
    for(const [name,key] of [['client','client'],['server','server'],['node_modules','nodeModules']]) {
        fs.renameSync(path.join(lab,'reviewed-candidate',name),plan.outputs[key]);
        assert.deepEqual(hashTree(plan.outputs[key]),meta.sealedManifest.trees[key]);
    }
    const source=fs.statSync(plan.sourceRoot);
    const manifest={...meta.sealedManifest,txId:transactionId,createdAt:new Date().toISOString(),localSource:plan.localSource,operationBinding,
        sourceIdentity:{dev:source.dev,ino:source.ino,ctimeMs:source.ctimeMs}};
    write(plan.outputs.manifest,manifest);
    const receipt=producer.readPreparedLocalRecoveryCandidate(prepared.planFile,{root});
    assert.deepEqual(receipt.trees,meta.sealedManifest.trees);
    const packet={schema:'nassaj-local-source-recovery-packet/v1',operation:'register-prepared-recovery',root,nodeIdentity:os.hostname(),serviceUid:process.getuid(),
        operationBinding,database,proposalEnvPath,configReceiptPath,privateHealthUrl:`http://127.0.0.1:${meta.port}/health`,publicHealthUrl,
        planPath:prepared.planFile,manifestSha256:receipt.manifestSha256,loadedValidatorSha256:sha(fs.readFileSync(path.join(root,'dist-server/scripts/lib/source-update-activation.mjs')))};
    const packetPath=path.join(control,'laboratory-packet.json');write(packetPath,packet);
    return {packetPath,packetSha256:sha(fs.readFileSync(packetPath)),receipt,jobId,actionId,transactionId,root};
}

/** Use the actual operator in a CA-trusting child, keeping the parent's HTTPS facade responsive. */
export async function registerRecoveryLabPacket(lab,packet,cert) {
    assertRecoveryLabBoundary(lab);
    return await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[path.join(packet.root,'scripts/local-source-recovery-operator.mjs'),'--register','--root',packet.root,
            '--packet',packet.packetPath,'--packet-sha256',packet.packetSha256],{cwd:packet.root,
            env:{...process.env,NODE_EXTRA_CA_CERTS:cert},stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
        child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(stdout.trim())):reject(Error('lab_registration_failed:'+stderr.trim())));
    });
}
