#!/usr/bin/env node
/** Fixed-artifact bridge rehearsal entry; preparation and probes write only to its private scratch. */
import {applyLabHealthPolicy} from './lab-health-policy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
import {hashOidPairTree} from '../oid-control-capsule.mjs';
import {hashDependencyTreeV2} from '../lib/dependency-tree-identity-v2.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const base=path.join(root,'.artifacts/t1772-bridge-rehearsal');

/** Create only a disk-backed, private child workspace; never provision/install dependencies. */
export function prepareBridgeWorkspace() {
    fs.mkdirSync(base,{recursive:true,mode:0o700});
    if(fs.realpathSync(base)!==base || Number(fs.statfsSync(base).type)===0x01021994)throw Error('bridge_scratch_unsafe');
    const lab=fs.mkdtempSync(path.join(base,'run-'));
    for(const name of ['home/.pm2','empty','harness','app/node_modules','git-objects','pm2','tmp','data','workflows','logs','dev','var-tmp'])fs.mkdirSync(path.join(lab,name),{recursive:true,mode:0o700});
    for(const name of ['null','zero','random','urandom','full'])fs.writeFileSync(path.join(lab,'dev',name),'');
    fs.symlinkSync('/proc/self/fd',path.join(lab,'dev/fd'));
    fs.mkdirSync(path.join(lab,'home',path.relative(process.env.HOME,lab)),{recursive:true,mode:0o700});
    return lab;
}

/** Execute a fixed child under separate user/mount/net/PID namespaces, preserving HOME's value. */
export function runBridgeIsolated(lab,entry,{timeout=30000,privateDependencies=false,runtimeProfile='host-local'}={}) {
    if(!lab.startsWith(`${base}/run-`) || fs.realpathSync(lab)!==lab || !entry.startsWith(`${lab}/harness/`))throw Error('bridge_entry_unsafe');
    if(!['host-local','fleet-public-24.17-npm12'].includes(runtimeProfile) || (runtimeProfile!=='host-local'&&!privateDependencies))throw Error('bridge_runtime_profile_invalid');
    const environment=Object.fromEntries(['PATH','HOME','LANG','LC_ALL'].filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]]));
    for(const [key,name] of [['USER','user'],['MOUNT','mnt'],['NET','net'],['PID','pid']])environment[`NASSAJ_LAB_PARENT_${key}_NS`]=fs.readlinkSync(`/proc/self/ns/${name}`);
    const tooling=path.join(base,'run-Mx3eDp/tooling/usr');
    const runtimeIdentity=()=>({nodeSha256:createHash('sha256').update(fs.readFileSync(path.join(tooling,'bin/node'))).digest('hex'),npmTree:hashDependencyTreeV2(path.join(tooling,'lib/node_modules/npm'))});
    const pinnedRuntime=runtimeProfile==='host-local'?null:runtimeIdentity();
    const result=spawnSync('/usr/bin/unshare',['--user',...(privateDependencies?['--map-current-user','--keep-caps']:['--map-root-user']),'--mount','--net','--pid','--fork','--kill-child=SIGKILL','--mount-proc',
        path.join(root,'scripts/update-lab',privateDependencies?'triple-namespace.sh':'bridge-namespace.sh'),lab,process.env.HOME,path.join(root,'node_modules'),entry,path.join(root,'.git/objects'),runtimeProfile],
    {env:environment,encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:1024*1024});
    if(pinnedRuntime){
        if(JSON.stringify(runtimeIdentity())!==JSON.stringify(pinnedRuntime))throw Error('bridge_public_runtime_changed');
        fs.writeFileSync(path.join(lab,'runtime-profile-proof.json'),JSON.stringify({runtimeProfile,...pinnedRuntime,sourceUnchanged:true,status:result.status,signal:result.signal,errorCode:result.error?.code??null}),{mode:0o600});
    }
    return result;
}

/** Probe writable boundaries and namespace identity before starting any laboratory application. */
export function probeBridgeIsolation() {
    const lab=prepareBridgeWorkspace(),entry=path.join(lab,'harness/isolation-probe.mjs');
    fs.writeFileSync(entry,`import fs from 'node:fs';import assert from 'node:assert/strict';\nconst lab=${JSON.stringify(lab)};\nassert.equal(process.env.HOME,${JSON.stringify(process.env.HOME)});\nfor(const file of ['/etc/nassaj-lab-write-test','/tmp/nassaj-lab-write-test','/run/nassaj-lab-write-test',lab+'/app/node_modules/.nassaj-lab-write-test',lab+'/git-objects/.nassaj-lab-write-test'])assert.throws(()=>fs.writeFileSync(file,'forbidden'), 'writable boundary: '+file);\nassert.equal(fs.existsSync(process.env.HOME+'/.pm2/dump.pm2'),false);\nfs.writeFileSync(lab+'/isolation-ok','verified');\nconsole.log(JSON.stringify({state:'isolated',pid:process.pid,pm2Home:process.env.PM2_HOME,homeValuePreserved:true}));\n`);
    const result=runBridgeIsolated(lab,entry);
    return {lab,status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr};
}
/** Copy immutable build products only; refuse any embedded database or environment file. */
function copyBridgeArtifact(source,destination) {
    const before=hashOidPairTree(source);
    const modes=artifactModes(source);
    fs.cpSync(source,destination,{recursive:true,preserveTimestamps:true,filter:file=>{
        const name=path.basename(file);
        if(name==='.env' || /\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$/.test(name))throw Error('bridge_artifact_contains_private_state');
        return true;
    }});
    if(hashOidPairTree(source)!==before || hashOidPairTree(destination)!==before)throw Error('bridge_artifact_copy_changed');
    if(JSON.stringify(artifactModes(source))!==JSON.stringify(modes) || JSON.stringify(artifactModes(destination))!==JSON.stringify(modes))throw Error('bridge_artifact_modes_changed');
    return before;
}

function artifactModes(directory) {
    const entries=[];
    function walk(dir,prefix='') {for(const name of fs.readdirSync(dir).sort()) {
        const file=path.join(dir,name),stat=fs.lstatSync(file),relative=prefix+name;
        if(stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))throw Error('bridge_artifact_entry_unsafe');
        entries.push([relative,stat.mode&0o777]);if(stat.isDirectory())walk(file,relative+'/');
    }}
    walk(directory);return entries;
}

/** Capture one old generation for reuse; subsequent cases consume this sealed laboratory copy. */
export function captureBridgeBaseline({serverSource=path.join(root,'dist-server'),clientSource=path.join(root,'dist'),expectedOid=null}={}) {
    fs.mkdirSync(base,{recursive:true,mode:0o700});
    const directory=fs.mkdtempSync(path.join(base,'baseline-'));
    const hashes={server:copyBridgeArtifact(serverSource,path.join(directory,'dist-server')),
        client:copyBridgeArtifact(clientSource,path.join(directory,'dist'))};
    const old=JSON.parse(fs.readFileSync(path.join(directory,'dist-server/BUILD_PROVENANCE.json')));
    if(expectedOid && old.commit!==expectedOid)throw Error('bridge_baseline_oid_mismatch');
    for(const relative of ['package.json','server/bin/claude']) {
        const read=spawnSync('/usr/bin/git',['show',`${old.commit}:${relative}`],{cwd:root,maxBuffer:1024*1024});
        if(read.status!==0)throw Error('bridge_old_support_source_missing');
        fs.mkdirSync(path.dirname(path.join(directory,relative)),{recursive:true});
        fs.writeFileSync(path.join(directory,relative),read.stdout,{mode:relative.endsWith('/claude')?0o755:0o644});
    }
    hashes.support=hashOidPairTree(path.join(directory,'server'));
    hashes.package=createHash('sha256').update(fs.readFileSync(path.join(directory,'package.json'))).digest('hex');
    const modes={server:artifactModes(path.join(directory,'dist-server')),client:artifactModes(path.join(directory,'dist'))};
    fs.writeFileSync(path.join(directory,'baseline.json'),JSON.stringify({oldOid:old.commit,hashes,modes}),{mode:0o400});
    // The namespace masks the host HOME containing this baseline. Preserve every
    // artifact mode: launcher pins those modes independently of the content hash.
    fs.chmodSync(directory,0o500);
    return directory;
}

/** Prepare actual old application bytes with a fresh synthetic database; does not start the host service. */
export function prepareBridgeBaseline(baseline=captureBridgeBaseline(),{observed=false,bridge=false,target=null,failure=null,externalUnknown=false,strandedSourceJob=false,healthPolicy='bridge-fault'}={}) {
    const evidence=JSON.parse(fs.readFileSync(path.join(baseline,'baseline.json')));
    if(hashOidPairTree(path.join(baseline,'server'))!==evidence.hashes.support
        || createHash('sha256').update(fs.readFileSync(path.join(baseline,'package.json'))).digest('hex')!==evidence.hashes.package)throw Error('bridge_baseline_support_changed');
    for(const [key,dir] of [['server','dist-server'],['client','dist']]) {
        if(hashOidPairTree(path.join(baseline,dir))!==evidence.hashes[key]
            || JSON.stringify(artifactModes(path.join(baseline,dir)))!==JSON.stringify(evidence.modes[key]))throw Error('bridge_baseline_changed');
    }
    const lab=prepareBridgeWorkspace(),app=path.join(lab,'app');
    copyBridgeArtifact(path.join(baseline,'dist-server'),path.join(app,'dist-server'));
    copyBridgeArtifact(path.join(baseline,'dist'),path.join(app,'dist'));
    copyBridgeArtifact(path.join(baseline,'server/bin'),path.join(app,'server/bin'));
    fs.copyFileSync(path.join(baseline,'package.json'),path.join(app,'package.json'));
    const initialized=spawnSync('/usr/bin/git',['init','-q','-b','main',app],{encoding:'utf8'});
    if(initialized.status!==0)throw Error('bridge_fixture_git_init_failed');
    fs.writeFileSync(path.join(app,'.git/objects/info/alternates'),path.join(lab,'git-objects')+'\n');
    const old=JSON.parse(fs.readFileSync(path.join(app,'dist-server/BUILD_PROVENANCE.json')));
    const manifest=JSON.parse(fs.readFileSync(path.join(app,'dist-server/OID_CONTROL_MANIFEST.json')));
    const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if(digest(path.join(app,'dist-server/OID_CONTROL_CAPSULE.mjs'))!==manifest.capsuleSha256
        || digest(path.join(app,'dist-server/scripts/safe-restart.sh'))!==manifest.safeRestartSha256)throw Error('bridge_old_control_changed');
    if(failure && !['before-application-import','after-startup-reconciliation'].includes(failure))throw Error('bridge_failure_checkpoint_invalid');
    if(externalUnknown && bridge)throw Error('bridge_rejection_fixture_cannot_activate');
    const meta={observed,failure,externalUnknown,strandedSourceJob,baseline,baselineEvidence:JSON.parse(fs.readFileSync(path.join(baseline,'baseline.json'))),port:3194,processName:'nassaj-bridge-rehearsal',old:{oid:old.commit,buildId:old.buildId,
        capsuleSha256:manifest.capsuleSha256,safeRestartSha256:manifest.safeRestartSha256}};
    if(bridge){
        const oid=target?.oid,buildId=target?.buildId;
        if(!/^[a-f0-9]{40}$/.test(oid||'') || !/^[a-f0-9]{64}$/.test(buildId||''))throw Error('bridge_exact_target_required');
        const candidate=path.join('.nassaj-local-preview/server-candidates',buildId);
        copyBridgeArtifact(path.join(root,candidate),path.join(app,candidate));
        const snapshot=path.join('.nassaj-local-preview/oid-snapshots',oid);
        copyBridgeArtifact(path.join(root,snapshot),path.join(app,snapshot));
        meta.target={oid,buildId,controlManifestSha256:digest(path.join(app,candidate,'OID_CONTROL_MANIFEST.json'))};
        if(target.clientBuildId){
            if(!/^[a-f0-9]{64}$/.test(target.clientBuildId))throw Error('bridge_client_target_invalid');
            const client=path.join('.nassaj-local-preview/client-candidates',target.clientBuildId);
            copyBridgeArtifact(path.join(root,client),path.join(app,client));
            meta.target.clientBuildId=target.clientBuildId;
        }
    }
    fs.writeFileSync(path.join(lab,'scenario.json'),JSON.stringify(meta),{mode:0o600});
    const env={NODE_ENV:'production',HOST:'127.0.0.1',SERVER_PORT:String(meta.port),DATABASE_PATH:path.join(lab,'data/auth.db'),
        JWT_SECRET:randomBytes(32).toString('hex'),BOOTSTRAP_OWNER_USERNAME:'bridgeowner',BOOTSTRAP_OWNER_PASSWORD:`Bridge-${randomBytes(18).toString('base64url')}`,
        PM2_HOME:path.join(process.env.HOME,'.pm2'),WF_BASE:path.join(lab,'workflows'),TMPDIR:path.join(lab,'tmp'),PROC_NAME:meta.processName,
        NASSAJ_PROCESS_NAME:meta.processName,NASSAJ_PREVIEW_HEALTH_URL:`http://127.0.0.1:${meta.port}/health`,HEALTH_URL:`http://127.0.0.1:${meta.port}/health`,HEALTH_PORT:String(meta.port),WARM_PUBLIC_ORIGIN:`http://127.0.0.1:${meta.port}`};
    Object.assign(env,applyLabHealthPolicy(env,healthPolicy));
    if(observed)env.NODE_OPTIONS='--inspect-brk=127.0.0.1:9237';
    fs.writeFileSync(path.join(app,'.env'),Object.entries(env).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600});
    fs.writeFileSync(path.join(lab,'data/auth.db'),'',{mode:0o600});
    fs.writeFileSync(path.join(lab,'ecosystem.config.cjs'),'module.exports='+JSON.stringify({apps:[{name:meta.processName,script:'dist-server/server/index.js',cwd:app,
        interpreter:process.execPath,instances:1,exec_mode:'fork',autorestart:false,treekill:false,kill_timeout:86400000,out_file:path.join(lab,'logs/old-out.log'),
        error_file:path.join(lab,'logs/old-error.log'),env}]})+';\n',{mode:0o600});
    const entry=path.join(lab,'harness/bridge-baseline-child.mjs');
    fs.copyFileSync(path.join(root,'scripts/update-lab/bridge-baseline-child.mjs'),entry);
    fs.copyFileSync(path.join(root,'scripts/update-lab/bridge-data-fixture.mjs'),path.join(lab,'harness/bridge-data-fixture.mjs'));
    fs.copyFileSync(path.join(root,'scripts/update-lab/bridge-startup-observer.mjs'),path.join(lab,'harness/bridge-startup-observer.mjs'));
    fs.copyFileSync(path.join(root,'scripts/update-lab/bridge-action-fixture.mjs'),path.join(lab,'harness/bridge-action-fixture.mjs'));
    fs.copyFileSync(path.join(root,'scripts/prepare-local-update-bridge-config.mjs'),path.join(lab,'prepare-local-update-bridge-config.mjs'));
    fs.copyFileSync(path.join(root,'scripts/update-lab/bridge-source-job-fixture.mjs'),path.join(lab,'harness/bridge-source-job-fixture.mjs'));
    return {lab,entry};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    let result;
    if(process.argv[2]==='--probe-isolation') result=probeBridgeIsolation();
    else if(process.argv[2]==='--old-baseline'){const {lab,entry}=prepareBridgeBaseline();const output=runBridgeIsolated(lab,entry,{timeout:90000});result={lab,status:output.status,stdout:output.stdout,stderr:output.stderr};}
    else if(process.argv[2]==='--old-admission-rejection'){const {lab,entry}=prepareBridgeBaseline(undefined,{externalUnknown:true});const output=runBridgeIsolated(lab,entry,{timeout:90000});result={lab,status:output.status,stdout:output.stdout,stderr:output.stderr};}
    else if(process.argv[2]==='--observed-old-baseline'){const {lab,entry}=prepareBridgeBaseline(undefined,{observed:true});const output=runBridgeIsolated(lab,entry,{timeout:90000});result={lab,status:output.status,stdout:output.stdout,stderr:output.stderr};}
    else if(['--bridge-success','--bridge-timeout','--bridge-source-job'].includes(process.argv[2])){const {lab,entry}=prepareBridgeBaseline(undefined,{observed:true,bridge:true,target:{oid:process.argv[3],buildId:process.argv[4],clientBuildId:process.argv[5]},failure:process.argv[2]==='--bridge-timeout'?process.argv[6]:null,strandedSourceJob:process.argv[2]==='--bridge-source-job'});const output=runBridgeIsolated(lab,entry,{timeout:180000});result={lab,status:output.status,stdout:output.stdout,stderr:output.stderr};}
    else throw Error('bridge_rehearsal_scenario_not_selected');
    console.log(JSON.stringify(result));if(result.status!==0)process.exitCode=1;
}
