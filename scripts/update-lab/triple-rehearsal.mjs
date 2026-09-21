/** Actual-artifact triple rehearsal preparation. Writes only private project scratch. */
import fs from 'node:fs';
import path from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {captureBridgeBaseline,prepareBridgeBaseline,prepareBridgeWorkspace,runBridgeIsolated} from './bridge-rehearsal.mjs';
import {hashDependencyTreeV2} from '../lib/dependency-tree-identity-v2.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function execute(program,args,options={}) {
    const result=spawnSync(program,args,{encoding:'utf8',maxBuffer:128*1024*1024,...options});
    if(result.status!==0)throw Error(`triple_fixture_command_failed:${path.basename(program)}:${result.stderr?.slice(-1000)}`);
    return result.stdout?.trim();
}
/** Copy lab inputs with exact per-path modes, leaving symlink targets untouched. */
export function copyTree(source,destination) {
    fs.cpSync(source,destination,{recursive:true,preserveTimestamps:true,verbatimSymlinks:true});
    const restoreModes=(from,to)=>{
        const original=fs.lstatSync(from),copied=fs.lstatSync(to);
        if(original.isSymbolicLink()) {
            if(!copied.isSymbolicLink() || fs.readlinkSync(from)!==fs.readlinkSync(to))throw Error('triple_copy_link_changed');
            return;
        }
        if(copied.isSymbolicLink() || original.isDirectory()!==copied.isDirectory())throw Error('triple_copy_type_changed');
        if(original.isDirectory())for(const name of fs.readdirSync(from))restoreModes(path.join(from,name),path.join(to,name));
        fs.chmodSync(to,original.mode&0o777);
    };
    restoreModes(source,destination);
}

/** Pin a reviewed bridge, private mutable dependencies and a public-cache-only native fixture source. */
export function prepareTripleRehearsal({oid,serverBuildId,clientBuildId}) {
    if(!/^[a-f0-9]{40}$/.test(oid||'') || ![serverBuildId,clientBuildId].every(value=>/^[a-f0-9]{64}$/.test(value||'')))throw Error('triple_exact_artifacts_required');
    const storage=fs.statfsSync(root);if(storage.bavail*storage.bsize<16*1024**3)throw Error('triple_lab_disk_budget_refused');
    const baseline=captureBridgeBaseline({serverSource:path.join(root,'.nassaj-local-preview/server-candidates',serverBuildId),
        clientSource:path.join(root,'.nassaj-local-preview/client-candidates',clientBuildId),expectedOid:oid});
    const prepared=prepareBridgeBaseline(baseline,{healthPolicy:'full'}),{lab}=prepared,app=path.join(lab,'app');
    const originalModules=hashDependencyTreeV2(path.join(root,'node_modules'));
    copyTree(path.join(root,'node_modules'),path.join(app,'node_modules'));
    if(JSON.stringify(hashDependencyTreeV2(path.join(root,'node_modules')))!==JSON.stringify(originalModules)
        || JSON.stringify(hashDependencyTreeV2(path.join(app,'node_modules')))!==JSON.stringify(originalModules))throw Error('triple_private_dependency_copy_changed');
    fs.writeFileSync(path.join(lab,'private-dependencies.json'),JSON.stringify({schema:'triple-private-dependencies/v1',identity:originalModules,sourceReadOnly:true}),{mode:0o600});
    fs.writeFileSync(path.join(app,'.git/objects/info/alternates'),path.join(root,'.git/objects')+'\n');
    const archive=spawnSync('/usr/bin/git',['archive',oid],{cwd:root,maxBuffer:128*1024*1024});
    if(archive.status!==0)throw Error('triple_private_source_archive_failed');
    execute('/usr/bin/tar',['--no-same-owner','-xf','-','-C',app],{input:archive.stdout});
    execute('/usr/bin/git',['read-tree',oid],{cwd:app});execute('/usr/bin/git',['update-ref','refs/heads/main',oid],{cwd:app});
    execute('/usr/bin/git',['config','user.name','Isolated triple fixture'],{cwd:app});
    execute('/usr/bin/git',['config','user.email','triple-fixture@example.invalid'],{cwd:app});
    const material=path.join(root,'.artifacts/native-upgrade-material-zwYWO0');
    execute(process.execPath,[path.join(material,'apply-fixture.mjs'),'--source-root',app,'--expected-base-commit',oid]);
    execute('/usr/bin/git',['add','package.json','package-lock.json'],{cwd:app});
    execute('/usr/bin/git',['-c','core.hooksPath=/dev/null','commit','-qm','test: isolated better-sqlite3 12.8.0 target'],{cwd:app});
    const targetOid=execute('/usr/bin/git',['rev-parse','HEAD'],{cwd:app});
    const shared=path.join(root,'.artifacts/t1772-bridge-rehearsal/run-Mx3eDp');
    copyTree(path.join(shared,'cache'),path.join(lab,'cache'));
    fs.cpSync(path.join(material,'cache'),path.join(lab,'cache'),{recursive:true,verbatimSymlinks:true});
    fs.mkdirSync(path.join(lab,'home/.cache/node-gyp'),{recursive:true,mode:0o700});
    copyTree(path.join(homedir(),'.cache/node-gyp/24.18.1'),path.join(lab,'home/.cache/node-gyp/24.18.1'));
    fs.writeFileSync(path.join(lab,'home/.npmrc'),`cache=${path.join(lab,'cache')}\noffline=true\nupdate-notifier=false\n`,{mode:0o600});
    const ripgrep=path.join(shared,'tmp/vscode-ripgrep-cache-1.17.1/ripgrep-v15.0.1-x86_64-unknown-linux-musl.tar.gz');
    fs.mkdirSync(path.join(lab,'public-material'),{mode:0o700});
    fs.copyFileSync(ripgrep,path.join(lab,'public-material/ripgrep.tar.gz'));
    const meta=JSON.parse(fs.readFileSync(path.join(lab,'scenario.json')));
    Object.assign(meta,{triple:true,targetOid,bridge:{oid,serverBuildId,clientBuildId},nativeMaterialSha256:sha(path.join(material,'readiness.json')),
        ripgrepSha256:sha(ripgrep),privateDependencies:originalModules});
    fs.writeFileSync(path.join(lab,'scenario.json'),JSON.stringify(meta),{mode:0o600});
    fs.appendFileSync(path.join(app,'.env'),'NASSAJ_UPDATE_MODE=local-main\n');
    fs.writeFileSync(path.join(app,'.git/objects/info/alternates'),path.join(lab,'git-objects')+'\n');
    const entry=path.join(lab,'harness/triple-child.mjs');
    fs.copyFileSync(path.join(root,'scripts/update-lab/triple-child.mjs'),entry);
    fs.copyFileSync(path.join(root,'scripts/update-lab/triple-terminal-observation.mjs'),path.join(lab,'harness/triple-terminal-observation.mjs'));
    fs.copyFileSync(path.join(root,'scripts/update-lab/lab-health-policy.mjs'),path.join(lab,'harness/lab-health-policy.mjs'));
    return {lab,entry,targetOid,baseline};
}

/** Verify the non-root private-root boundary before installing or launching any application. */
export function probeTripleIsolation() {
    const lab=prepareBridgeWorkspace(),entry=path.join(lab,'harness/triple-isolation.mjs');
    const whichTargetSha256=sha('/usr/bin/which.debianutils');
    const outside=fs.mkdtempSync(path.join(root,'.artifacts/t1772-private-root-proof-'));
    fs.writeFileSync(path.join(outside,'sentinel'),'host-only synthetic sentinel',{mode:0o600});
    fs.writeFileSync(entry,`import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
const lab=${JSON.stringify(lab)};
assert.equal(process.getuid(),${process.getuid()});assert.notEqual(process.getuid(),0);assert.equal(process.pid,1);
assert.equal(process.env.HOME,${JSON.stringify(process.env.HOME)});
assert.equal(fs.statSync('/').uid,process.getuid());assert.equal(fs.statSync('/home').uid,process.getuid());
const status=fs.readFileSync('/proc/self/status','utf8');
for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.equal(status.split(String.fromCharCode(10)).find(line=>line.startsWith(key+':')).split(':')[1].trim(),'0000000000000000');
assert.equal(status.split(String.fromCharCode(10)).find(line=>line.startsWith('NoNewPrivs:')).split(':')[1].trim(),'1');
assert.equal(fs.existsSync(${JSON.stringify(path.join(outside,'sentinel'))}),false);
assert.equal(fs.existsSync(process.env.HOME+'/.pm2/dump.pm2'),false);
for(const file of ['/etc/forbidden','/usr/forbidden','/host-modules/forbidden',lab+'/git-objects/forbidden'])assert.throws(()=>fs.writeFileSync(file,'x'));
fs.writeFileSync(lab+'/app/node_modules/private-write','owned');fs.writeFileSync('/var/tmp/owned','owned');
assert.deepEqual(Object.keys(os.networkInterfaces()),['lo']);
for(const name of fs.readdirSync('/proc/self/fd')){if(Number(name)<=2)continue;let link;try{link=fs.readlinkSync('/proc/self/fd/'+name);}catch{continue;}if(link.startsWith('/'))assert.ok(link==='/dev/null'||link.startsWith(lab+'/'),'external FD: '+link);}
const npm=spawnSync('/usr/bin/npm',['--version'],{encoding:'utf8'});assert.equal(npm.status,0,npm.stderr);
assert.equal(fs.readlinkSync('/usr/bin/which'),'/etc/alternatives/which');assert.equal(fs.realpathSync('/usr/bin/which'),'/usr/bin/which.debianutils');
assert.equal(createHash('sha256').update(fs.readFileSync('/usr/bin/which.debianutils')).digest('hex'),${JSON.stringify(whichTargetSha256)});
const which=spawnSync('/usr/bin/which',['pm2'],{encoding:'utf8'});assert.equal(which.status,0,which.stderr);assert.equal(fs.realpathSync(which.stdout.trim()),fs.realpathSync('/usr/bin/pm2'));
const mountinfo=fs.readFileSync('/proc/self/mountinfo','utf8');assert.equal(mountinfo.includes('/put_old'),false);assert.equal(fs.existsSync('/put_old'),false);
const mounts=mountinfo.trim().split(String.fromCharCode(10)).map(line=>line.split(' '));
const procMount=mounts.find(fields=>fields[4]==='/proc');assert.ok(procMount);for(const flag of ['rw','nosuid','nodev','noexec'])assert.ok(procMount[5].split(',').includes(flag));
const reference=mounts.find(fields=>fields[4]==='/proc-reference');assert.ok(reference);for(const flag of ['ro','nosuid','nodev','noexec'])assert.ok(reference[5].split(',').includes(flag));
assert.equal(fs.readlinkSync('/proc-reference/self/ns/pid'),fs.readlinkSync('/proc/self/ns/pid'));
for(const control of ['sys','irq','bus','fs','sysrq-trigger']) {
  const fields=mounts.find(item=>item[4]==='/proc/'+control);assert.ok(fields);assert.ok(fields[5].split(',').includes('ro'));
}
// Opening without truncation or writing proves denial without changing a control.
for(const control of ['/proc/sys/kernel/hostname','/proc/sysrq-trigger','/proc-reference/sys/kernel/hostname','/proc-reference/sysrq-trigger'])assert.throws(()=>fs.openSync(control,fs.constants.O_WRONLY),error=>['EROFS','EACCES','EPERM'].includes(error.code));
assert.equal(mounts.some(fields=>fields[3]==='/'&&fields.includes('ext4')),false);
const rootStat=fs.statSync('/');
for(const pid of fs.readdirSync('/proc').filter(name=>/^[0-9]+$/.test(name))) {
  const actual=fs.statSync('/proc/'+pid+'/root');assert.equal(actual.dev,rootStat.dev);assert.equal(actual.ino,rootStat.ino);
  const cwd=fs.readlinkSync('/proc/'+pid+'/cwd');assert.ok(cwd==='/'||cwd.startsWith(lab));
}
const nsKeys=['user','mnt','net','pid'];const previous=nsKeys.map(key=>fs.readlinkSync('/proc/self/ns/'+key));
const nested=spawnSync('/usr/bin/unshare',['--user','--map-root-user','--mount','--net','--pid','--fork','--kill-child=SIGKILL','/usr/bin/node','--input-type=module','-e',"import fs from 'node:fs';console.log(JSON.stringify(['user','mnt','net','pid'].map(key=>fs.readlinkSync('/proc/self/ns/'+key))));"],{encoding:'utf8'});
assert.equal(nested.status,0,nested.stderr);const created=JSON.parse(nested.stdout);created.forEach((value,index)=>assert.notEqual(value,previous[index]));
const remount=spawnSync('/usr/bin/unshare',['--user','--map-root-user','--mount','--fork','--kill-child=SIGKILL','/usr/bin/mount','-o','remount,rw','/proc-reference'],{encoding:'utf8'});assert.notEqual(remount.status,0);assert.ok(remount.stderr.includes('permission denied')||remount.stderr.includes('Operation not permitted'));
fs.writeFileSync(lab+'/pivot-mountinfo-after-detach.txt',mountinfo);
console.log(JSON.stringify({state:'isolated',uid:process.getuid(),pid:process.pid,node:process.version,npm:npm.stdout.trim(),capabilities:'all-zero',noNewPrivs:true,hostDataAbsent:true,hostModulesReadOnly:true,privateModulesWritable:true,oldRootDetached:true,processRootsContained:true,which:{status:which.status,target:fs.realpathSync('/usr/bin/which'),sha256:createHash('sha256').update(fs.readFileSync('/usr/bin/which')).digest('hex'),pm2CanonicalMatched:true},nestedNamespaces:{previous,created}}));`);
    const hostMounts=fs.readFileSync('/proc/self/mountinfo','utf8');
    try {const result=runBridgeIsolated(lab,entry,{privateDependencies:true,timeout:30000});if(fs.readFileSync('/proc/self/mountinfo','utf8')!==hostMounts)throw Error('triple_host_mounts_changed');return {lab,status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr};}
    finally {fs.rmSync(outside,{recursive:true,force:true});}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    if(process.argv[2]==='--probe-isolation'){const result=probeTripleIsolation();console.log(JSON.stringify(result));if(result.status!==0)process.exitCode=1;} else {
    const prepared=prepareTripleRehearsal({oid:process.argv[2],serverBuildId:process.argv[3],clientBuildId:process.argv[4]});
    console.log(JSON.stringify({state:'prepared',...prepared}));
    if(process.argv[5]==='--run') {
        const result=runBridgeIsolated(prepared.lab,prepared.entry,{timeout:2400000,privateDependencies:true});
        console.log(JSON.stringify({lab:prepared.lab,status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr}));
        if(result.status!==0)process.exitCode=1;
    }
    }
}
