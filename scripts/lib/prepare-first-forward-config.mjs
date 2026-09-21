import { ingressManager, ingressShowArgs, readRoutingEvidence, observeOriginListener, listenerBoundary } from './release-runtime-listener-boundary.mjs';
/** Read-only measured preparation; never signs, installs, initializes or mutates a service. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonicalForwardValue as canonical, forwardValueSha256 as digest, resolveForwardBashPath,
    inspectForwardChildIdentity, assertForwardServicePolicy, assertForwardServiceIdentity } from './release-runtime-forward-child-protocol.mjs';
import { observePinnedPm2PrivateRuntime, readPinnedPm2RuntimeMetadata } from './pm2-readonly-observer.mjs';
import { validatePm2TargetDescriptor } from './pm2-typed-mutation.mjs';
import { planForwardDefinitionRetirement } from './release-runtime-forward-saved-definitions.mjs';
import { validateLocalManifestHeader, validateLocalPreparedArtifact, localBuildIdentitySha256, LOCAL_BUILD_KIND } from './local-reviewed-build-identity.mjs';
import { prepareForwardStartupAuthority } from './release-runtime-public-descriptor.mjs';
import { validateFirstForwardPlans } from './release-runtime-forward-plan-validation.mjs';
import { attestPreparedMaintenance } from './release-runtime-host-operations.mjs';
import { RELEASE_ASSET_LIMITS, validateCompatibleForwardDatabaseContract, verifyForwardExecutableManifest } from './update-release-asset.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const exact=(v,keys)=>{if(!v||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.split(',').sort().join(','))throw Error('forward_prepare_fields');};
function readGenerationManifest(file) {
    const maximum=RELEASE_ASSET_LIMITS.manifestBytes;
    if(!path.isAbsolute(file)||fs.realpathSync(file)!==file)throw Error('forward_prepare_manifest_path');
    const before=fs.lstatSync(file);
    if(!before.isFile()||before.isSymbolicLink()||before.mode&0o022||before.size<1||before.size>maximum)throw Error('forward_prepare_manifest_unsafe');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const same=info=>['dev','ino','uid','gid','mode','size','mtimeMs','ctimeMs'].every(key=>info[key]===before[key]);
    try {
        if(!same(fs.fstatSync(fd)))throw Error('forward_prepare_manifest_changed');
        const chunks=[];let total=0;
        while(total<=maximum){const chunk=Buffer.alloc(Math.min(65536,maximum+1-total));
            const count=fs.readSync(fd,chunk,0,chunk.length,null);if(!count)break;chunks.push(chunk.subarray(0,count));total+=count;}
        if(total>maximum||total!==before.size||!same(fs.fstatSync(fd)))throw Error('forward_prepare_manifest_changed');
        return Buffer.concat(chunks,total);
    }finally{fs.closeSync(fd);}
}
function filePin(file) {
    if(!path.isAbsolute(file||'')||fs.realpathSync(file)!==file)throw Error('forward_prepare_path');
    const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.mode&0o022)throw Error('forward_prepare_file');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {const opened=fs.fstatSync(fd);if(['dev','ino','uid','gid','mode','size','mtimeMs','ctimeMs'].some(k=>opened[k]!==before[k]))throw Error('forward_prepare_race');
        return {path:file,sha256:sha(fs.readFileSync(fd))};}finally{fs.closeSync(fd);}
}
function hostIdentityPaths(input, required) {
    const supplied=input.hostIdentityFiles;
    if(!Array.isArray(supplied)||!supplied.length||supplied.length>512||new Set(supplied).size!==supplied.length)throw Error('forward_prepare_host_identity');
    const files=[...new Set([...supplied,...required])];
    if(files.length>512)throw Error('forward_prepare_host_identity_limit');
    const forbidden=new Set(['/etc/nassaj/release-host-support-attestation.json','/etc/nassaj/release-runtime-host.json','/etc/nassaj/startup-admission-client.json']);
    const output=path.resolve(input.locations.outputRoot);
    return files.map(file=>{
        if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file||/[\x00-\x1f]/.test(file))throw Error('forward_prepare_host_identity_path');
        if(forbidden.has(file)||file===output||file.startsWith(`${output}/`))throw Error('forward_prepare_host_identity_cycle');
        if(fs.realpathSync(file)!==file)throw Error('forward_prepare_host_identity_path');
        return file;
    });
}
function hostIdentityAncestors(file, uid) {
    const rows=[];
    for(let directory=path.dirname(file);;directory=path.dirname(directory)){
        const info=fs.lstatSync(directory);
        if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o022||![0,uid].includes(info.uid)||fs.realpathSync(directory)!==directory)throw Error('forward_prepare_host_identity_ancestor');
        rows.push({directory,info});if(directory===path.dirname(directory))break;
    }
    return rows;
}
function assertHostIdentityAncestors(rows, uid) {
    const actual=hostIdentityAncestors(path.join(rows[0].directory,'identity'),uid);
    if(actual.length!==rows.length||actual.some((row,index)=>row.directory!==rows[index].directory
        ||['dev','ino','uid','gid','mode'].some(key=>row.info[key]!==rows[index].info[key])))throw Error('forward_prepare_host_identity_ancestor_changed');
}
function measureHostIdentity(input, required) {
    const files=hostIdentityPaths(input,required),identities=new Set();let planned=0,total=0;
    const rows=files.map(file=>{
        const before=fs.lstatSync(file);
        if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.mode&0o022
            ||![0,input.serviceIdentity.uid].includes(before.uid))throw Error('forward_prepare_host_identity_file');
        if(!Number.isSafeInteger(before.size)||before.size<0||before.size>RELEASE_ASSET_LIMITS.archiveBytes
            ||(planned+=before.size)>RELEASE_ASSET_LIMITS.expandedBytes)throw Error('forward_prepare_host_identity_limit');
        const identity=`${before.dev}:${before.ino}`;
        if(identities.has(identity))throw Error('forward_prepare_host_identity_alias');identities.add(identity);
        return {file,before,ancestors:hostIdentityAncestors(file,input.serviceIdentity.uid)};
    });
    return rows.map(({file,before,ancestors})=>{
        const same=info=>['dev','ino','uid','gid','mode','size','nlink','mtimeMs','ctimeMs'].every(key=>info[key]===before[key]);
        assertHostIdentityAncestors(ancestors,input.serviceIdentity.uid);
        const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),hash=createHash('sha256');let size=0;
        try {
            if(!same(fs.fstatSync(fd)))throw Error('forward_prepare_host_identity_changed');
            const buffer=Buffer.alloc(65536);
            for(;;){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,before.size+1-size),null);if(!count)break;
                size+=count;total+=count;if(size>before.size||total>RELEASE_ASSET_LIMITS.expandedBytes)throw Error('forward_prepare_host_identity_limit');
                hash.update(buffer.subarray(0,count));}
            if(size!==before.size||!same(fs.fstatSync(fd))||!same(fs.lstatSync(file))||fs.realpathSync(file)!==file)throw Error('forward_prepare_host_identity_changed');
            assertHostIdentityAncestors(ancestors,input.serviceIdentity.uid);
            return {path:file,sha256:hash.digest('hex'),size};
        } finally {fs.closeSync(fd);}
    });
}
function trustedFilePin(file, executable=false) {
    const pin=filePin(file),stat=fs.lstatSync(file);
    if(stat.uid!==0||(executable&&!(stat.mode&0o111)))throw Error('forward_prepare_untrusted_file');
    for(let parent=path.dirname(file);;parent=path.dirname(parent)){
        const info=fs.lstatSync(parent);
        if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0||info.mode&0o022)throw Error('forward_prepare_untrusted_ancestor');
        if(parent===path.dirname(parent))break;
    }
    return pin;
}
function reviewedPin(pin,read=trustedFilePin) {exact(pin,'path,sha256');const actual=read(pin.path);if(actual.sha256!==pin.sha256)throw Error('forward_prepare_reviewed_pin');return actual;}
function systemReader(pin,fixtureExec) {
    if(pin.path!=='/usr/bin/systemctl')throw Error('forward_prepare_systemctl_path');
    return (file,args,options={})=>{
        if(file!==pin.path||!(args[0]==='show'||(args[0]==='--user'&&/^--machine=[a-z_][a-z0-9_-]{0,31}@\.host$/.test(args[1])&&args[2]==='show'))||args.some(x=>typeof x!=='string'))throw Error('forward_prepare_systemctl_request');
        const actual=trustedFilePin(file,true);if(actual.sha256!==pin.sha256)throw Error('forward_prepare_systemctl_drift');
        const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
        try{
            const info=fs.fstatSync(fd);
            if(info.uid!==0||info.mode&0o022||!(info.mode&0o111)||sha(fs.readFileSync(fd))!==pin.sha256)throw Error('forward_prepare_systemctl_drift');
            if(fixtureExec)return fixtureExec(file,args,options);
            return execFileSync('/proc/self/fd/3',args,{encoding:'utf8',timeout:10000,maxBuffer:262144,
                env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LC_ALL:'C'},stdio:['ignore','pipe','pipe',fd]});
        }catch{throw Error('forward_prepare_systemctl_failed');}finally{fs.closeSync(fd);}
    };
}
function measuredUnit(unit,exec,read,manager=null){
    if(!/^[A-Za-z0-9_.@-]+\.service$/.test(unit))throw Error('forward_prepare_maintenance_unit');
    const raw=exec('/usr/bin/systemctl',manager?ingressShowArgs(manager,['FragmentPath','DropInPaths']):['show',unit,'--property=FragmentPath','--property=DropInPaths','--value']);
    const files=raw.trim().split(/\s+/).filter(Boolean).sort();
    if(!files.length||new Set(files).size!==files.length)throw Error('forward_prepare_unit_files');
    const records=files.map(file=>{const record=read(file);return {path:record.path,sha256:record.sha256,size:record.size??fs.statSync(file).size};});
    return {files,sha256:sha(JSON.stringify(records))};
}
function measureMaintenance(input,pins,exec,deps,oldProcess,supervisorPlan){
    const policy=input.policies.maintenance;
    exact(policy,`nonce,retryAfterSeconds,responderUnit,responderPort,cloudflared${policy.boundary?',boundary':''}`);
    const source=policy.cloudflared;exact(source,`unit,configFile,originHost,originPort${policy.boundary?',manager':''}`);
    const manager=policy.boundary?ingressManager(source.manager):null;
    if(manager&&manager.unit!==source.unit)throw Error('forward_prepare_ingress_manager');
    const read=deps.trustedFile||trustedFilePin;
    const raw=exec('/usr/bin/systemctl',manager?ingressShowArgs(manager,['MainPID']):['show',source.unit,'--property=MainPID','--value']).trim();
    if(!/^[1-9][0-9]*$/.test(raw))throw Error('forward_prepare_ingress_pid');
    const pid=Number(raw),identity=(deps.inspectIngress||inspectForwardChildIdentity)(pid);
    const routingRead=file=>readRoutingEvidence(file,identity.uids[0]);
    const effectiveUnit=measuredUnit(source.unit,exec,manager?routingRead:read,manager);
    const responderEffectiveUnit=measuredUnit(policy.responderUnit,exec,read);
    const executable=(deps.ingressExecutable||fs.realpathSync)(`/proc/${pid}/exe`);
    const executablePin=read(executable,true),configPin=manager?readRoutingEvidence(source.configFile,identity.uids[0]):read(source.configFile);
    const cloudflared={...source,pid,uid:identity.uids[0],startTime:identity.startTicks,
        executable,executableSha256:executablePin.sha256,configSha256:configPin.sha256,effectiveUnit,
        ...(manager?{routingEvidence:{kind:'mutable-routing-observation/v1',controlGroup:exec('/usr/bin/systemctl',ingressShowArgs(manager,['ControlGroup'])).trim()}}:{})};
    const maintenance={...policy,cloudflared,responderEffectiveUnit,
        nft:{binary:pins.nft.path,sha256:pins.nft.sha256},conntrack:{binary:pins.conntrack.path,sha256:pins.conntrack.sha256}};
    const config={maintenance,health:input.policies.health,forwardActivation:{supervisorPlan}};
    if(listenerBoundary(config))maintenance.originListener=observeOriginListener(config,oldProcess,deps.listener);
    attestPreparedMaintenance(config,{...deps.maintenance,exec});
    return maintenance;
}
function measureInventory(entries) {
    if(!Array.isArray(entries)||entries.length<1||entries.length>128)throw Error('forward_prepare_inventory');
    return entries.map(entry=>{exact(entry,'kind,path');if(entry.kind==='file')return {...filePin(entry.path),kind:'file'};
        if(entry.kind!=='directory'||fs.realpathSync(entry.path)!==entry.path||!fs.lstatSync(entry.path).isDirectory())throw Error('forward_prepare_inventory_path');
        return {kind:'directory',path:entry.path,entriesSha256:digest(fs.readdirSync(entry.path).sort())};});
}
function controllers(inputs, systemctl, exec) {
    if(!Array.isArray(inputs)||inputs.length<1||inputs.length>64)throw Error('forward_prepare_controllers');
    return inputs.map(source=>{
        exact(source,'sourceId,scope,user,unit,cgroupPath,optional,creationSourceIds');
        if(!/^[A-Za-z0-9._-]{1,128}$/.test(source.sourceId)||!['system','user'].includes(source.scope)
            ||!/^[A-Za-z0-9_.@-]+\.(service|timer)$/.test(source.unit)||/^(pm2-|cloudflared)/.test(source.unit)
            ||typeof source.optional!=='boolean'||!Array.isArray(source.creationSourceIds)
            ||(source.scope==='system'&&source.user!==null)||(source.scope==='user'&&!/^[a-z_][a-z0-9_-]{0,31}$/.test(source.user||'')))throw Error('forward_prepare_controller');
        const properties='Id,LoadState,ActiveState,UnitFileState,ControlGroup,FragmentPath,DropInPaths,ExecStart,ExecStartPre';
        const args=[...(source.scope==='user'?['--user',`--machine=${source.user}@.host`]:[]),'show',`--property=${properties}`,'--no-pager',source.unit];
        const raw=exec(systemctl.path,args,{encoding:'utf8',timeout:10000,maxBuffer:262144,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LC_ALL:'C'}});
        const facts=Object.fromEntries(raw.trim().split('\n').map(line=>{const at=line.indexOf('=');if(at<1)throw Error('forward_prepare_unit_output');return [line.slice(0,at),line.slice(at+1)];}));
        exact(facts,properties);if(facts.Id!==source.unit||facts.LoadState==='not-found')throw Error('forward_prepare_controller_evidence_missing');
        if(facts.ControlGroup!==source.cgroupPath||!source.cgroupPath.startsWith('/')||source.cgroupPath==='/')throw Error('forward_prepare_cgroup');
        return {...source,configurationSha256:digest(facts)};
    }).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
}
/** Return measured material in memory. Missing evidence cannot yield a signable configuration. */
export async function prepareFirstForwardConfig(input, deps={}) {
    const report={schema:'nassaj-forward-preparation-report/v1',complete:false,measured:[],missing:[]};
    try {
        exact(input,'schema,operationId,nodeInstanceId,generationRoot,build,artifact,observer,slot,definitions,controllers,inventory,serviceIdentity,targetPolicy,hostIdentityFiles,policies,executables,locations');
        if(input.schema!=='nassaj-forward-preparation-input/v1'||!/^[A-Za-z0-9_-]{16,128}$/.test(input.operationId))throw Error('forward_prepare_input');
        const root=fs.realpathSync(input.generationRoot);if(root!==input.generationRoot)throw Error('forward_prepare_generation');
        const manifestFile=path.join(root,'RELEASE_ASSET_MANIFEST.json'),manifestBytes=readGenerationManifest(manifestFile),manifest=JSON.parse(manifestBytes);
        const build=validateLocalManifestHeader(manifest,{kind:LOCAL_BUILD_KIND,build:input.build});const artifact=validateLocalPreparedArtifact(input.artifact,build);
        if(sha(manifestBytes)!==artifact.manifestSha256||manifestBytes.length!==artifact.manifestSize||path.basename(root)!==`local-forward-${artifact.archiveSha256}`)throw Error('forward_prepare_artifact');
        validateCompatibleForwardDatabaseContract(manifest.databaseContract,localBuildIdentitySha256(build),artifact.startupClosureSha256);
        if(digest(manifest.databaseContract)!==artifact.databaseContractSha256)throw Error('forward_prepare_contract');
        report.measured.push('local-artifact');
        exact(input.executables,'systemctl,dispatcher,sudo,node,zeroWorkProbe,nft,conntrack');
        if(input.executables.systemctl.path!=='/usr/bin/systemctl'||input.executables.sudo.path!=='/usr/bin/sudo')throw Error('forward_prepare_fixed_executable');
        const pins=Object.fromEntries(Object.entries(input.executables).map(([name,pin])=>[name,reviewedPin(pin,deps.trustedFile||trustedFilePin)]));
        const exec=systemReader(pins.systemctl,deps.exec);
        if(pins.node.path!==fs.realpathSync(process.execPath)||pins.dispatcher.sha256!==filePin(path.join(root,'dist-server/UPDATE_RUNTIME_BUNDLE/scripts/release-runtime-host-dispatcher.mjs')).sha256)throw Error('forward_prepare_fixed_executable');
        const bash=trustedFilePin(resolveForwardBashPath(),true);
        assertForwardServicePolicy(input.serviceIdentity);
        exact(input.slot,'pm2Id,name,namespace');
        const observed=await (deps.observe||observePinnedPm2PrivateRuntime)(input.observer);
        const entries=observed.privateEntries.filter(e=>e.pm_id===input.slot.pm2Id||(e.name===input.slot.name&&e.pm2_env?.namespace===input.slot.namespace));
        if(entries.length!==1||entries[0].pm_id!==input.slot.pm2Id||entries[0].name!==input.slot.name||entries[0].pm2_env?.namespace!==input.slot.namespace||entries[0].pm2_env.status!=='online')throw Error('forward_prepare_pm2_slot');
        const current=entries[0],processIdentity=(deps.inspectProcess||inspectForwardChildIdentity)(current.pid);
        assertForwardServiceIdentity(processIdentity,input.serviceIdentity);
        const oldProcess={uid:input.serviceIdentity.uid,pid:processIdentity.pid,startTicks:processIdentity.startTicks,bootId:processIdentity.bootId};
        report.measured.push('kernel-pm2-slot');
        exact(input.targetPolicy,'exec_mode,pm_out_log_path,pm_err_log_path,pm_pid_path,status,autostart,autorestart,watch,pmx,vizion,wait_ready,restart_time,unstable_restarts,prev_restart_delay,env');
        const target=validatePm2TargetDescriptor({...input.targetPolicy,name:input.slot.name,namespace:input.slot.namespace,
            pm_exec_path:path.join(root,'dist-server/server/bootstrap.js'),pm_cwd:root,exec_interpreter:pins.node.path,
            uid:input.serviceIdentity.uid,gid:input.serviceIdentity.gid});
        const metadata={entryPath:target.pm_exec_path,packageJson:filePin(path.join(root,'package.json')),node:pins.node};
        (deps.metadata||readPinnedPm2RuntimeMetadata)(metadata);
        const sources=input.definitions.map(source=>{exact(source,'sourceId,path,format,writerSourceIds');
            const pin=filePin(source.path);planForwardDefinitionRetirement(fs.readFileSync(pin.path),source.format,input.slot);
            return {...source,beforeSha256:pin.sha256};}).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
        const mutatorPlan={systemctl:pins.systemctl,sources:controllers(input.controllers,pins.systemctl,exec),inventory:measureInventory(input.inventory)};
        if(!sources.length||sources.some(s=>!s.writerSourceIds.length||s.writerSourceIds.some(id=>!mutatorPlan.sources.some(m=>m.sourceId===id))))throw Error('forward_prepare_writer_inventory');
        const supervisorPlan={slot:input.slot,pm2:{observer:input.observer},sources,mutation:{oldSlot:{pmId:input.slot.pm2Id,baseline:current.pm2_env,entrySha256:digest(current.pm2_env),process:oldProcess},targetDescriptor:target,metadata}};
        report.measured.push('controller-definition-plans');
        const maintenance=measureMaintenance(input,pins,exec,deps,oldProcess,supervisorPlan);report.measured.push('maintenance-static-kernel-sources');
        const built=buildMaterial(input,{manifest,manifestBytes,pins,bash,oldProcess,supervisorPlan,mutatorPlan,maintenance});
        validateFirstForwardPlans(built.config);
        report.measured.push('consumer-plan-validation','root-executable-closure','database-inode','owner-key','expected-bindings');
        report.complete=true;return {report,...built};
    }catch(error){report.missing.push(/^(forward_prepare_|forward_initialization_|host_ingress_|host_cloudflared_|public_descriptor_)[a-z0-9_]{1,100}$/.test(error.message)?error.message:'forward_prepare_evidence_invalid');return {report};}
}

function buildMaterial(input,m) {
    exact(input.locations,'outputRoot,controlRoot,databaseFile,approvalFile,ownerPublicKeyFile');
    for(const value of Object.values(input.locations))if(!path.isAbsolute(value)||/[\x00-\x1f]/.test(value))throw Error('forward_prepare_location');
    exact(input.policies,'health,maintenance,probeTimeoutMs');
    if(!Number.isSafeInteger(input.policies.probeTimeoutMs)||input.policies.probeTimeoutMs<1||input.policies.probeTimeoutMs>30000)throw Error('forward_prepare_probe_timeout');
    exact(input.policies.health,'privateUrl,publicUrl');
    const privateUrl=new URL(input.policies.health.privateUrl),publicUrl=new URL(input.policies.health.publicUrl);
    if(privateUrl.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(privateUrl.hostname)||publicUrl.protocol!=='https:')throw Error('forward_prepare_health_policy');
    exact(input.policies.maintenance,`nonce,retryAfterSeconds,responderUnit,responderPort,cloudflared${input.policies.maintenance.boundary?',boundary':''}`);
    const root=input.generationRoot,loc=input.locations,contract=m.manifest.databaseContract;
    const database=fs.realpathSync(loc.databaseFile),stat=fs.lstatSync(database,{bigint:true});
    if(database!==loc.databaseFile||!stat.isFile()||stat.uid!==BigInt(input.serviceIdentity.uid)||stat.gid!==BigInt(input.serviceIdentity.gid))throw Error('forward_prepare_database');
    const closureFiles=verifyForwardExecutableManifest(root,m.manifest).files
        .map(record=>({path:path.join(root,record.path),sha256:record.sha256}));
    const entry=filePin(path.join(root,'dist-server/server/scripts/release-database-migration.js'));
    if(entry.sha256!==contract.migrationEntrySha256)throw Error('forward_prepare_migration_entry_binding');
    const closure={schema:'nassaj-forward-child-closure/v1',files:[...closureFiles,entry,m.pins.node].sort((a,b)=>a.path.localeCompare(b.path))};
    const request={schema:'nassaj-compatible-forward-request/v1',transactionId:input.operationId,expectedPhase:'migration',
        releaseIdentitySha256:localBuildIdentitySha256(input.build),databaseContractSha256:digest(contract),
        database:{realpath:database,device:String(stat.dev),inode:String(stat.ino)}};
    const material={ 'forward-request.json':request,'forward-contract.json':contract,'forward-executable-closure.json':closure };
    const materialPin=name=>({path:path.join(loc.outputRoot,name),sha256:sha(`${canonical(material[name])}\n`)});
    const key=createPublicKey(fs.readFileSync(loc.ownerPublicKeyFile));if(key.asymmetricKeyType!=='ed25519')throw Error('forward_prepare_owner_key');
    if(!Array.isArray(input.hostIdentityFiles)||!input.hostIdentityFiles.length)throw Error('forward_prepare_host_identity');
    const flock=trustedFilePin('/usr/bin/flock',true);
    const flockStat=fs.lstatSync(flock.path);if(flockStat.uid!==0||!(flockStat.mode&0o111))throw Error('forward_prepare_flock_executable');
    const stateLock={schema:'nassaj-cutover-state-lock/v2',flock};
    const maintenanceFiles=[m.maintenance.cloudflared.executable,...(m.maintenance.boundary?[]:[m.maintenance.cloudflared.configFile,...m.maintenance.cloudflared.effectiveUnit.files]),...m.maintenance.responderEffectiveUnit.files];
    const host=measureHostIdentity(input,[flock.path,m.bash.path,...Object.values(m.pins).map(pin=>pin.path),...maintenanceFiles]);
    const expected={nodeInstanceId:input.nodeInstanceId,generationId:path.basename(root),artifactPolicy:LOCAL_BUILD_KIND,
        localBuild:input.build,localArtifact:input.artifact,hostIdentitySha256:sha(JSON.stringify(host)),
        releaseIdentitySha256:request.releaseIdentitySha256,migrationIdentitySha256:entry.sha256,
        databaseContractSha256:digest(contract),assetSha256:input.artifact.archiveSha256,
        pm2SnapshotSha256:digest(m.supervisorPlan.mutation.oldSlot.baseline),targetSchemaDigest:contract.target.schemaDigest,
        serverBuildId:input.build.serverBuildId,clientBuildId:input.build.clientBuildId,
        ownerApprovalKeySha256:sha(key.export({type:'spki',format:'der'})),supervisorPlanSha256:digest(m.supervisorPlan),
        mutatorPlanSha256:digest(m.mutatorPlan),forwardExecutableClosureSha256:materialPin('forward-executable-closure.json').sha256};
    const config={schema:'nassaj-release-runtime-host-config/v1',controlRoot:loc.controlRoot,stateLock,databaseFile:database,oldProcess:m.oldProcess,expected,
        forwardActivation:{hostIdentity:{schema:'nassaj-forward-host-identity/v1',files:host},supervisorPlan:m.supervisorPlan,mutatorPlan:m.mutatorPlan,bash:m.bash,
            safeRestart:filePin(path.join(root,'scripts/safe-restart.sh')),dispatcher:m.pins.dispatcher},
        forwardMigration:{node:m.pins.node,parent:filePin(path.join(root,'scripts/release-runtime-forward-parent.mjs')),
            wrapper:filePin(path.join(root,'scripts/release-runtime-forward-child.mjs')),entry,closure:materialPin('forward-executable-closure.json'),
            request:materialPin('forward-request.json'),contract:materialPin('forward-contract.json'),serviceIdentity:input.serviceIdentity},
        health:input.policies.health,maintenance:m.maintenance,
        zeroWorkProbe:{file:m.pins.zeroWorkProbe.path,sha256:m.pins.zeroWorkProbe.sha256,args:[],timeoutMs:input.policies.probeTimeoutMs}};
    return {config,material,pins:m.pins,manifestBytes:m.manifestBytes};
}
function writeExclusive(file,bytes,mode=0o600) {
    const fd=fs.openSync(file,'wx',mode);try{fs.writeFileSync(fd,bytes);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
/** Publish final config last in a new private output directory; partial runs never emit a ready config. */
export async function generateFirstForwardConfiguration(input,deps={}) {
    const out=input?.locations?.outputRoot;
    if(!path.isAbsolute(out||'')||fs.existsSync(out)||fs.realpathSync(path.dirname(out))!==path.dirname(out))throw Error('forward_prepare_output_not_new');
    fs.mkdirSync(out,{mode:0o700});
    const result=await prepareFirstForwardConfig(input,deps);
    let preparedConfig;
    try {
        if(result.report.complete){
            for(const [name,value] of Object.entries(result.material))writeExclusive(path.join(out,name),`${canonical(value)}\n`);
            const manifestFile=path.join(out,'release-manifest.json');writeExclusive(manifestFile,result.manifestBytes);
            const reviewed=path.join(out,'release-runtime-host.INCOMPLETE.json');writeExclusive(reviewed,`${canonical(result.config)}\n`);
            const options={reviewedHostConfigFile:reviewed,reviewedHostConfigSha256:filePin(reviewed).sha256,
                releaseManifestFile:manifestFile,releaseManifestSha256:sha(result.manifestBytes),
                generationRecordFile:path.join(input.generationRoot,'runtime-generation.json'),generationRecordSha256:filePin(path.join(input.generationRoot,'runtime-generation.json')).sha256,
                startupClosureSha256:input.artifact.startupClosureSha256,applicationUid:input.serviceIdentity.uid,
                approvalFile:input.locations.approvalFile,ownerApprovalPublicKeyFile:input.locations.ownerPublicKeyFile,
                dispatcherExecutable:result.pins.dispatcher.path,dispatcherSha256:result.pins.dispatcher.sha256,
                sudoExecutable:result.pins.sudo.path,sudoSha256:result.pins.sudo.sha256,nodeExecutable:result.pins.node.path,nodeSha256:result.pins.node.sha256};
            const prepared=prepareForwardStartupAuthority(options,deps.startup);
            writeExclusive(path.join(out,'startup-admission-client.json'),prepared.publicDescriptor,0o644);
            preparedConfig=prepared.privateConfig;
        }
    }catch(error){result.report.complete=false;result.report.missing.push(/^(forward_prepare_|forward_initialization_|host_ingress_|host_cloudflared_|public_descriptor_)[a-z0-9_]{1,100}$/.test(error.message)?error.message:'forward_prepare_publication_failed');}
    writeExclusive(path.join(out,'GENERATION_REPORT.json'),`${JSON.stringify(result.report,null,2)}\n`);
    if(result.report.complete && preparedConfig)writeExclusive(path.join(out,'release-runtime-host.forward.json'),preparedConfig);
    const fd=fs.openSync(out,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    return {complete:result.report.complete,report:result.report,outputRoot:out};
}
