/** Prepare the full recovery rehearsal only after the coordinator pins a sealed production candidate. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {captureBridgeBaseline,prepareBridgeBaseline,runBridgeIsolated} from './bridge-rehearsal.mjs';
import {copyTree,probeTripleIsolation} from './triple-rehearsal.mjs';
import {hashTree} from '../lib/source-update-tree-identity.mjs';
import {readPreparedLocalRecoveryCandidate} from '../local-source-recovery-candidate.mjs';
import {measureRecoveryTree,recoveryLabPhases} from './local-source-recovery-preflight.mjs';
import {captureRecoveryLockBaseline,initializeRecoveryLockBaseline} from './local-source-recovery-locks.mjs';
import {inspectClientPublicationTree} from '../lib/client-publication-artifacts.mjs';
import {captureRecoveryPm2DumpBaseline,initializeRecoveryPm2Dump,assertRecoveryPm2DumpBaseline} from './local-source-recovery-pm2-baseline.mjs';
import {recoveryLabScope} from './local-source-recovery-scope.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const git=(args,cwd=root)=>execFileSync('/usr/bin/git',args,{cwd,encoding:'utf8',maxBuffer:128*1024**2}).trim();
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2),{mode:0o600});

/** Define the private PM2 slot using the real capsule shutdown contract and fork entry. */
export function recoveryLabPm2Configuration(lab,env) {
    return {apps:[{name:'nassaj-dev',cwd:path.join(lab,'app'),script:'dist-server/server/index.js',args:['--port','3004'],
        interpreter:process.execPath,node_args:[`--title=node ${path.join(lab,'app/dist-server/server/index.js')}`],
        instances:1,exec_mode:'fork',autorestart:true,treekill:false,kill_timeout:'86400000',
        out_file:path.join(lab,'logs/old-out.log'),error_file:path.join(lab,'logs/old-error.log'),env}]};
}

/** Read actual sealed-tree allocation; never replace measured candidate sizes with the source OID. */
export function inspectSealedRecoveryLab({expectedOid,planPath,cacheRoot,publicMaterialRoot,rehearsalScope}) {
    if(!/^[a-f0-9]{40}$/.test(expectedOid||'')||git(['rev-parse','refs/heads/main'])!==expectedOid)throw Error('recovery_lab_final_oid_required');
    rehearsalScope=recoveryLabScope(rehearsalScope);
    const receipt=readPreparedLocalRecoveryCandidate(planPath,{root,existingOnly:true});
    if(receipt.localSource.oid!==expectedOid)throw Error('recovery_lab_candidate_oid_changed');
    const candidate=path.dirname(receipt.manifestPath),manifest=JSON.parse(fs.readFileSync(receipt.manifestPath));
    const incomingClientAssetBytes=inspectClientPublicationTree(path.join(candidate,'client')).totalBytes;
    const size=name=>measureRecoveryTree(path.join(candidate,name)).allocatedCopyBytes;
    const oldD=measureRecoveryTree(path.join(root,'node_modules')).allocatedCopyBytes;
    const oldA=['dist','dist-server'].reduce((sum,name)=>sum+measureRecoveryTree(path.join(root,name)).allocatedCopyBytes,0);
    const storage=fs.statfsSync(root),capacity=recoveryLabPhases({availableBytes:storage.bavail*storage.bsize,rehearsalScope,
        sourceBytes:size('source'),dependencyBytes:Math.max(oldD,size('node_modules')),artifactBytes:Math.max(oldA,size('client')+size('server')),incomingClientAssetBytes,
        cacheBytes:measureRecoveryTree(cacheRoot).allocatedCopyBytes,publicMaterialBytes:measureRecoveryTree(publicMaterialRoot).allocatedCopyBytes+measureRecoveryTree(path.join(os.homedir(),'.cache/node-gyp',process.versions.node)).allocatedCopyBytes});
    // The retained live candidate already exists in availableBytes; subtract it exactly once.
    const allocatedCandidate=measureRecoveryTree(candidate).allocatedCopyBytes;
    for(const [name,phase] of Object.entries(capacity.phases))if(name.startsWith('laboratory')) {
        phase.allocations.retainedLiveCandidate=0;phase.requiredBytes=Object.values(phase.allocations).reduce((a,b)=>a+b,0);
        phase.remainingBytes=capacity.availableBytes-phase.requiredBytes;phase.allowed=phase.remainingBytes>=0;
    }
    return {receipt,manifest,candidate,allocatedCandidate,capacity};
}

/** Copy exact reviewed trees into private scratch; this function does not register or activate on the host. */
export function prepareLocalRecoveryLab(options) {
    if(options.materialize!==true)throw Error('recovery_lab_materialization_not_requested');
    const inspected=inspectSealedRecoveryLab(options);
    if(Object.entries(inspected.capacity.phases).some(([name,value])=>name.startsWith('laboratory')&&!value.allowed))throw Error('recovery_lab_capacity_refused');
    const controlLocks=captureRecoveryLockBaseline(path.join(root,'.git'));
    const pm2Dump=captureRecoveryPm2DumpBaseline(path.join(os.homedir(),'.pm2'));
    const isolation=probeTripleIsolation();if(isolation.status!==0)throw Error('recovery_lab_isolation_refused');
    const baseline=captureBridgeBaseline({expectedOid:'af8d3a1627ba8cc97a849de490ce09adc920681d'});
    const prepared=prepareBridgeBaseline(baseline,{healthPolicy:'full'}),{lab}=prepared,app=path.join(lab,'app');
    const fixtureLocks=initializeRecoveryLockBaseline(path.join(app,'.git'),controlLocks);
    write(path.join(lab,'control-lock-baseline.json'),{baseline:controlLocks,fixture:fixtureLocks});
    const fixtureDump=initializeRecoveryPm2Dump(path.join(lab,'home/.pm2'),pm2Dump);
    write(path.join(lab,'pm2-dump-baseline.json'),{baseline:pm2Dump,fixture:fixtureDump});
    const archive=execFileSync('/usr/bin/git',['archive',options.expectedOid],{cwd:root,maxBuffer:128*1024**2});
    execFileSync('/usr/bin/tar',['--no-same-owner','-xf','-','-C',app],{input:archive});
    fs.writeFileSync(path.join(app,'.git/objects/info/alternates'),path.join(root,'.git/objects')+'\n');
    git(['read-tree',options.expectedOid],app);git(['update-ref','refs/heads/main',options.expectedOid],app);
    git(['config','user.name','Local recovery lab'],app);git(['config','user.email','local-recovery@example.invalid'],app);
    copyTree(path.join(root,'node_modules'),path.join(app,'node_modules'));
    if(JSON.stringify(hashTree(path.join(root,'node_modules')))!==JSON.stringify(hashTree(path.join(app,'node_modules'))))throw Error('recovery_lab_old_dependency_copy_changed');
    const imported=path.join(lab,'reviewed-candidate');fs.mkdirSync(imported,{mode:0o700});
    for(const [name,tree] of [['client','client'],['server','server'],['node_modules','nodeModules']]) {
        copyTree(path.join(inspected.candidate,name),path.join(imported,name));
        if(JSON.stringify(hashTree(path.join(imported,name)))!==JSON.stringify(inspected.manifest.trees[tree]))throw Error('recovery_lab_candidate_copy_changed');
    }
    copyTree(options.cacheRoot,path.join(lab,'cache'));
    fs.writeFileSync(path.join(lab,'home/.npmrc'),`cache=${path.join(lab,'cache')}\noffline=true\nupdate-notifier=false\n`,{mode:0o600});
    copyTree(options.publicMaterialRoot,path.join(lab,'public-material'));
    const headers=path.join(os.homedir(),'.cache/node-gyp',process.versions.node);
    fs.mkdirSync(path.join(lab,'home/.cache/node-gyp'),{recursive:true,mode:0o700});
    copyTree(headers,path.join(lab,'home/.cache/node-gyp',process.versions.node));
    const meta=JSON.parse(fs.readFileSync(path.join(lab,'scenario.json')));
    Object.assign(meta,{port:3004,processName:'nassaj-dev',localSourceRecovery:true,sourceOid:options.expectedOid,rehearsalScope:inspected.capacity.rehearsalScope,
        sealedManifest:inspected.manifest,productionManifestSha256:inspected.receipt.manifestSha256,capacity:inspected.capacity});
    write(path.join(lab,'scenario.json'),meta);
    const configuration=fs.readFileSync(path.join(app,'.env'),'utf8').replaceAll('3194','3004').replaceAll('nassaj-bridge-rehearsal','nassaj-dev');
    fs.writeFileSync(path.join(app,'.env'),configuration,{mode:0o600});
    const env=Object.fromEntries(configuration.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
    fs.writeFileSync(path.join(lab,'ecosystem.config.cjs'),'module.exports='+JSON.stringify(recoveryLabPm2Configuration(lab,env))+';\n',{mode:0o600});
    for(const name of ['local-source-recovery-child.mjs','local-source-recovery-assets.mjs','local-source-recovery-tls.mjs','local-source-recovery-fixture.mjs','local-source-recovery-next-update.mjs','local-source-recovery-scope.mjs','bridge-data-fixture.mjs','triple-terminal-observation.mjs'])
        fs.copyFileSync(path.join(root,'scripts/update-lab',name),path.join(lab,'harness',name));
    fs.writeFileSync(path.join(app,'.git/objects/info/alternates'),path.join(lab,'git-objects')+'\n');
    write(path.join(lab,'preparation.json'),{schema:'nassaj-local-recovery-lab-preparation/v1',baseline,rehearsalScope:inspected.capacity.rehearsalScope,productionManifestSha256:inspected.receipt.manifestSha256,trees:inspected.manifest.trees});
    return {lab,entry:path.join(lab,'harness/local-source-recovery-child.mjs'),baseline};
}

/** Run only a prepared private child; the caller must preserve its evidence before owned-scratch cleanup. */
export function runLocalRecoveryLab(prepared) {
    const dumpProof=JSON.parse(fs.readFileSync(path.join(prepared.lab,'pm2-dump-baseline.json')));
    assertRecoveryPm2DumpBaseline(dumpProof.baseline);
    assertRecoveryPm2DumpBaseline(dumpProof.fixture);
    return runBridgeIsolated(prepared.lab,prepared.entry,{privateDependencies:true,timeout:2400000});
}
