import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const project = path.resolve(import.meta.dirname, '..');
test('B936 real flock contention and parent death under B899 confinement', t => {
    const root = fs.mkdtempSync(path.join(project, '.artifacts', 'state-mutex-isolation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const launcher = path.join(root, 'isolate');
    const compile = spawnSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror',
        path.join(project, 'scripts/fixtures/cold-startup-mount-isolation.c'), '-o', launcher],
    { encoding: 'utf8', env: { ...process.env, TMPDIR: root } });
    assert.equal(compile.status, 0, compile.stderr);
    const entry = path.join(root, 'entry.mjs');
    fs.writeFileSync(entry, `
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
assert.equal(process.pid,1);assert.equal(process.cwd(),${JSON.stringify(root)});
assert.notEqual(fs.readlinkSync('/proc/self/ns/mnt'),${JSON.stringify(fs.readlinkSync('/proc/self/ns/mnt'))});
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),${JSON.stringify(fs.readlinkSync('/proc/self/ns/net'))});
for(const line of fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n')){
 const f=line.split(' ');assert.equal(f[5].split(',').includes('rw'),f[4]===${JSON.stringify(root)});
}
const root=${JSON.stringify(root)},control=root+'/control';fs.mkdirSync(control,{mode:0o700});
const config={schema:'nassaj-release-runtime-host-config/v1',controlRoot:control,stateLock:{schema:'nassaj-cutover-state-lock/v2',flock:{path:'/usr/bin/flock',sha256:createHash('sha256').update(fs.readFileSync('/usr/bin/flock')).digest('hex')}}};
fs.writeFileSync(root+'/config.json',JSON.stringify(config),{mode:0o600});
const actor=root+'/actor.mjs';
fs.writeFileSync(actor,${JSON.stringify(`
import fs from 'node:fs';import assert from 'node:assert/strict';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const root=process.argv[2],control=root+'/control',fixed='/etc/nassaj/release-runtime-host.json';
// Metadata/path seams only: all lock descriptors, helper processes and process death are real.
const native={lstat:fs.lstatSync,fstat:fs.fstatSync,open:fs.openSync,realpath:fs.realpathSync,spawn:cp.spawnSync};
// Model a legacy installation completely: optional forward authority files
// are absent inside the fixture, never observed from the real host.
const map=p=>p===fixed?root+'/config.json':p==='/etc/nassaj/release-host-support-attestation.json'?root+'/attestation.json':p==='/etc/nassaj/startup-admission-client.json'?root+'/startup-client.json':p==='/etc/nassaj'?control:p;
fs.lstatSync=(p,...a)=>{const s=native.lstat(map(p),...a);s.uid=0;if(s.isDirectory())s.mode&=~0o022;return s;};
fs.fstatSync=(...a)=>{const s=native.fstat(...a);s.uid=0;if(s.isDirectory())s.mode&=~0o022;return s;};
fs.openSync=(p,...a)=>native.open(map(p),...a);
fs.realpathSync=(p,...a)=>{if(map(p)!==p){native.realpath(map(p),...a);return p;}return native.realpath(p,...a);};
process.geteuid=()=>0;
const action=process.argv[3];
cp.spawnSync=(file,args,options)=>{
 if(file==='/usr/bin/flock')fs.appendFileSync(root+'/helper-calls','1');
 if(file==='/usr/bin/flock'&&action==='ipc-contender')fs.writeSync(1,'waiting\\n');
 if(file==='/usr/bin/flock'&&(action==='busy-error'||action==='admission-helper-error'))return {status:75,error:{code:'EIO'}};
 if(file==='/usr/bin/flock'&&action==='busy-signal')return {status:75,signal:'SIGKILL'};
 if(file==='/usr/bin/flock'&&action==='helper-failure')return {status:1};
 if(file==='/usr/bin/flock'&&action==='helper-timeout')return {status:null,error:{code:'ETIMEDOUT'}};
 if(file==='/usr/bin/flock'&&action==='before-helper')process.exit(79);
 if(file==='/usr/bin/flock'&&action==='stopped-helper'){
  // The real helper waits behind the outer holder under the production two-second policy.
  // A separate real process SIGSTOPs that blocked /usr/bin/flock; core timeout must SIGKILL it.
  const watcher=cp.spawn(process.execPath,[root+'/stop-watcher.mjs',String(process.pid),root],{stdio:'ignore'});
  const result=native.spawn(file,args,options);
  try{watcher.kill('SIGKILL');}catch{}
  return result;
 }
 const result=native.spawn(file,args,options);
 if(file==='/usr/bin/flock'&&action==='after-helper')process.exit(79);
 if(file==='/usr/bin/flock'&&action==='config-drift'){
  const config=JSON.parse(fs.readFileSync(root+'/config.json'));config.changed=true;fs.writeFileSync(root+'/config.json',JSON.stringify(config));
 }
 if(file==='/usr/bin/flock'&&action==='mutex-replace'){
  fs.renameSync(control+'/first-cutover-state.flock',control+'/retained.flock');fs.writeFileSync(control+'/first-cutover-state.flock','',{mode:0o600});
 }
 return result;
};syncBuiltinESMExports();
const {withVerifiedCutoverStateMutex:lock,isCutoverStateAcquisitionBusy:isBusy}=await import(${JSON.stringify(new URL('./lib/release-runtime-state-mutex.mjs', import.meta.url).href)});
if(action==='idle'){fs.writeFileSync(root+'/survivor.pid',String(process.pid));setInterval(()=>{},1000);}
else if(action.startsWith('admission-')){
 const {handleBootstrapStartupAdmission}=await import(${JSON.stringify(new URL('./lib/release-runtime-startup-admission.mjs', import.meta.url).href)});
 const kind=action.slice('admission-'.length);
 const {inspectForwardChildIdentity}=await import(${JSON.stringify(new URL('./lib/release-runtime-forward-child-protocol.mjs', import.meta.url).href)});
 const actual=inspectForwardChildIdentity(process.pid);let calls=0;
 const caller={uid:actual.uids[0],pid:actual.pid,startTicks:actual.startTicks,bootId:actual.bootId};
 const observe=()=>{calls++;return {...caller,pid:caller.pid+(kind==='foreign-caller'||(kind==='changing-caller'&&calls>1)?1:0)};};
 const schemas={offer:'nassaj-bootstrap-admission-offer-request/v1',consume:'nassaj-bootstrap-admission-consume-request/v1',security:'nassaj-startup-security-admission-request/v1'};
 const request={schema:schemas[kind]||'nassaj-startup-serving-confirmation-request/v1',challenge:'a'.repeat(64),pid:process.pid,
  startTicks:actual.startTicks,bootId:actual.bootId,releaseIdentitySha256:'b'.repeat(64),startupClosureSha256:'c'.repeat(64)};
 if(kind==='consume')Object.assign(request,{offerId:'offer',offerNonce:'d'.repeat(64),expectedRevision:1,generationEpoch:1});
 else if(kind!=='offer')Object.assign(request,{claimId:'11111111-1111-1111-1111-111111111111',generationEpoch:1,databaseContractSha256:'d'.repeat(64)});
 try{
  const result=handleBootstrapStartupAdmission(JSON.parse(fs.readFileSync(root+'/config.json')),request,observe,{
   readRootFile:()=>{if(kind==='nested')return lock(control,()=>assert.fail('nested entered'));assert.fail('journal read outside mutex');}
  });
  assert.deepEqual(result,{...request,schema:'nassaj-startup-serving-busy/v1',decision:'busy',reason:'state_lock_contended',retryAfterMs:100});
  assert.equal(calls,2);process.stdout.write(JSON.stringify(result));
 }catch(error){process.stderr.write(error.message);process.exitCode=isBusy(error)?75:78;}
}
else {
 try {
  if(action==='async')lock(control,async()=>assert.fail('async callback ran'));
  if(action==='thenable')lock(control,()=>({then(){}}));
  lock(control,()=>{
   if(action==='ipc-holder'){fs.writeSync(1,'ready\\n');fs.readSync(0,Buffer.alloc(1),0,1,null);}
   if(action==='callback-busy-text')throw Error('cutover_state_busy');
   if(action==='inside')process.exit(79);
   if(action==='survivor'){cp.spawn(process.execPath,[process.argv[1],root,'idle'],{stdio:'ignore'});process.exit(79);}
   if(action==='nested')assert.throws(()=>lock(control,()=>assert.fail('nested entered')),/state_busy/);
   if(action==='stop-timeout-holder'){
    const started=Date.now();const other=native.spawn(process.execPath,[process.argv[1],root,'stopped-helper'],{encoding:'utf8',timeout:5000});
    assert.equal(other.status,78,other.stderr);assert.match(other.stderr,/helper_failed/);
    assert.ok(Date.now()-started<4500);assert.equal(fs.readFileSync(root+'/stopped','utf8'),'yes');
   }
   if(action==='concurrent'){
    const other=native.spawn(process.execPath,[process.argv[1],root,'normal'],{encoding:'utf8'});
    assert.equal(other.status,75,other.stderr);
   }
   fs.appendFileSync(root+'/callback','1');
  });
 }catch(error){process.stderr.write(error.message);process.exitCode=isBusy(error)?75:78;}
}
`)});
fs.writeFileSync(root+'/stop-watcher.mjs',${JSON.stringify(`
import fs from 'node:fs';const parent=process.argv[2],root=process.argv[3];
const until=Date.now()+3000;
while(Date.now()<until){
 for(const value of fs.readFileSync('/proc/'+parent+'/task/'+parent+'/children','utf8').trim().split(' ')){
  const pid=Number(value);if(!pid||pid===process.pid)continue;
  try{if(fs.realpathSync('/proc/'+pid+'/exe')==='/usr/bin/flock'){process.kill(pid,'SIGSTOP');fs.writeFileSync(root+'/stopped','yes');process.exit(0);}}catch{}
 }
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
}
process.exit(78);
`)});
const run=action=>spawnSync(process.execPath,[actor,root,action],{encoding:'utf8',timeout:10000});
// Present malformed authority must still fail closed through the real reader.
fs.writeFileSync(root+'/attestation.json','{}',{mode:0o600});
const malformed=run('normal');assert.equal(malformed.status,78);assert.match(malformed.stderr,/installed_config/);
fs.rmSync(root+'/attestation.json');
for(const kind of ['file','dangling','directory']){
 const legacy=control+'/first-cutover-state.lock';
 if(kind==='file')fs.writeFileSync(legacy,'');else if(kind==='dangling')fs.symlinkSync(control+'/missing',legacy);else fs.mkdirSync(legacy);
 const denied=run('normal');assert.equal(denied.status,78,denied.stderr);
 assert.equal(fs.existsSync(control+'/first-cutover-state.flock'),false);
 assert.equal(fs.existsSync(root+'/helper-calls'),false);
 fs.rmSync(legacy,{recursive:true,force:true});
}
for(const invalid of ['missing','pin','control','extra','mode']){
 const original=fs.readFileSync(root+'/config.json');
 const next=JSON.parse(original);
 if(invalid==='missing')delete next.stateLock;
 if(invalid==='pin')next.stateLock.flock.sha256='0'.repeat(64);
 if(invalid==='control')next.controlRoot=control+'/other';
 if(invalid==='extra')next.stateLock.extra=true;
 fs.writeFileSync(root+'/config.json',JSON.stringify(next));if(invalid==='mode')fs.chmodSync(root+'/config.json',0o644);
 const denied=run('normal');assert.equal(denied.status,78,denied.stderr);
 assert.equal(fs.existsSync(control+'/first-cutover-state.flock'),false);assert.equal(fs.existsSync(root+'/helper-calls'),false);
 fs.writeFileSync(root+'/config.json',original);fs.chmodSync(root+'/config.json',0o600);
}
for(const action of ['normal','nested','concurrent','stop-timeout-holder']){const r=run(action);assert.equal(r.status,0,r.stderr);}
const file=control+'/first-cutover-state.flock',inode=fs.lstatSync(file).ino;
for(const action of ['before-helper','after-helper','inside','survivor']){
 const dead=run(action);assert.equal(dead.status,79,dead.stderr);
 const next=run('normal');assert.equal(next.status,0,next.stderr);assert.equal(fs.lstatSync(file).ino,inode);
 if(action==='survivor'){
  for(let i=0;i<100&&!fs.existsSync(root+'/survivor.pid');i++)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  const pid=Number(fs.readFileSync(root+'/survivor.pid','utf8'));process.kill(pid,0);process.kill(pid,'SIGKILL');
 }
}
for(const action of ['async','thenable','helper-failure','helper-timeout','busy-error','busy-signal','callback-busy-text','config-drift','mutex-replace']){
 const original=fs.readFileSync(root+'/config.json');fs.rmSync(root+'/callback',{force:true});
 const denied=run(action);assert.equal(denied.status,78,denied.stderr);assert.equal(fs.existsSync(root+'/callback'),false);
 fs.writeFileSync(root+'/config.json',original);
 const recovered=run('normal');assert.equal(recovered.status,0,recovered.stderr);
}
const start=action=>{
 const child=spawn(process.execPath,[actor,root,action],{stdio:['pipe','pipe','pipe']});let output='',errors='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
 const done=new Promise(resolve=>child.on('close',code=>resolve({code,output,errors})));
 const waitFor=token=>new Promise((resolve,reject)=>{
  if(output.includes(token))return resolve();
  const timer=setTimeout(()=>reject(Error('fixture IPC timeout: '+errors)),5000);
  child.stdout.on('data',()=>{if(output.includes(token)){clearTimeout(timer);resolve();}});
 });return {child,done,waitFor};
};
{
 const holder=start('ipc-holder');await holder.waitFor('ready');
 fs.rmSync(root+'/callback',{force:true});const contender=start('ipc-contender');await contender.waitFor('waiting');
 holder.child.stdin.end('x');assert.equal((await holder.done).code,0);
 const result=await contender.done;assert.equal(result.code,0,result.errors);
 assert.equal(fs.readFileSync(root+'/callback','utf8'),'11','holder and contender each enter once');
}
for(const drift of ['none','config','inode','legacy']){
 const holder=start('ipc-holder');await holder.waitFor('ready');
 fs.rmSync(root+'/callback',{force:true});const contender=start('ipc-contender');await contender.waitFor('waiting');
 const oldConfig=fs.readFileSync(root+'/config.json');
 if(drift==='config')fs.writeFileSync(root+'/config.json',JSON.stringify({...JSON.parse(oldConfig),drift:true}));
 if(drift==='inode'){fs.renameSync(file,file+'.old');fs.writeFileSync(file,'',{mode:0o600});}
 if(drift==='legacy')fs.symlinkSync(control+'/absent',control+'/first-cutover-state.lock');
 const result=await contender.done;assert.equal(result.code,drift==='none'?75:78,result.errors);
 assert.equal(fs.existsSync(root+'/callback'),false,'pre-callback timeout/drift must not enter');
 if(drift==='config')fs.writeFileSync(root+'/config.json',oldConfig);
 if(drift==='inode'){fs.unlinkSync(file);fs.renameSync(file+'.old',file);}
 if(drift==='legacy')fs.unlinkSync(control+'/first-cutover-state.lock');
 holder.child.stdin.end('x');assert.equal((await holder.done).code,0);
}
for(const kind of ['serving','offer','consume','security','foreign-caller','changing-caller']){
 const holder=start('ipc-holder');await holder.waitFor('ready');
 const result=run('admission-'+kind);assert.equal(result.status,kind==='serving'?0:['foreign-caller','changing-caller'].includes(kind)?78:75,result.stderr);
 if(kind==='serving')assert.equal(JSON.parse(result.stdout).schema,'nassaj-startup-serving-busy/v1');
 else assert.equal(result.stdout,'');
 holder.child.stdin.end('x');assert.equal((await holder.done).code,0);
}
for(const action of ['admission-nested','admission-helper-error']){
 const result=run(action);assert.equal(result.status,action==='admission-nested'?75:78,result.stderr);assert.equal(result.stdout,'');
}
for(const kind of ['symlink','hardlink']){
 const current=control+'/first-cutover-state.flock',kept=control+'/original-'+kind;
 fs.renameSync(current,kept);
 if(kind==='symlink')fs.symlinkSync(kept,current);else fs.linkSync(kept,current);
 fs.rmSync(root+'/callback',{force:true});const denied=run('normal');assert.equal(denied.status,78,denied.stderr);assert.equal(fs.existsSync(root+'/callback'),false);
 fs.unlinkSync(current);fs.renameSync(kept,current);
}
assert.equal(fs.existsSync(control+'/first-cutover-state.lock'),false);
process.stdout.write(JSON.stringify({contention:true,parentDeath:['before-helper','after-helper','inside'],survivorDoesNotInherit:true,permanentInode:inode}));
`);
    const env = { ...process.env, TMPDIR: root }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync('/usr/bin/unshare', ['--user', '--map-current-user', '--mount', '--net', '--pid',
        '--keep-caps', '--fork', '--kill-child', launcher, fs.readlinkSync('/proc/self/ns/mnt'), root, process.execPath, entry],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, env });
    fs.writeFileSync(path.join(project, '.artifacts', 'state-mutex-kernel.log'), result.stdout + '\n' + result.stderr);
    assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
});
