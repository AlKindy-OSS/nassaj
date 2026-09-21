/** B899-only authority fixture. Archive bytes stay immutable. PM2/systemd are simulated.
 * Holder evidence covers the reaped fixture seed and operator FDs, not a host-wide scan. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { installFixedStateMutexAuthority } from './fixed-state-mutex-authority.mjs';
import { FIXTURE_OPERATOR_ROOT, FIXTURE_ATTESTATION, FIXTURE_PUBLIC } from './installed-config-authority.mjs';
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const sha = value => hash(canonical(value));
const pin = file => ({path: fs.realpathSync(file), sha256: hash(fs.readFileSync(file))});
const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value), {mode: 0o600});

/** Prepare only test root/retirement facts; actual production parent generates migration authority. */
export function prepareArchivedMigrationAuthority(t, f, measured, releaseRoot, databasePath, evidenceRoot) {
  assert.ok(process.env.NASSAJ_TEST_TMP, 'B899 scratch required');
  assert.equal(f.read('first-cutover.json').phase, 'retirement_verified');
  const control = f.root, config = f.config, wrapper = path.join(releaseRoot, 'scripts/release-runtime-forward-child.mjs');
  const entry = path.join(releaseRoot, 'dist-server/server/scripts/release-database-migration.js');
  const protocol = path.join(releaseRoot, 'scripts/lib/release-runtime-forward-child-protocol.mjs');
  const parent = path.join(releaseRoot, 'scripts/lib/release-runtime-forward-parent.mjs');
  const marker = path.join(control, 'migration-operator.pid'), audit = path.join(evidenceRoot, `${path.basename(control)}-migration-protocol.jsonl`);
  const hook = path.join(control, 'migration-authority-hook.mjs');
  const dbStat = fs.statSync(databasePath, {bigint: true});
  const request = {schema:'nassaj-compatible-forward-request/v1',transactionId:f.read('first-cutover.json').transactionId,
    releaseIdentitySha256:f.identity.releaseIdentitySha256,databaseContractSha256:f.identity.databaseContractSha256,
    database:{realpath:fs.realpathSync(databasePath),device:String(dbStat.dev),inode:String(dbStat.ino)},expectedPhase:'migration'};
  put(path.join(control,'migration-request.json'),request); put(path.join(control,'migration-contract.json'),measured.manifest.databaseContract);
  const closureFiles = measured.manifest.files.filter(record => record.path.startsWith('scripts/')).map(record => path.join(releaseRoot,record.path));
  closureFiles.push(entry);
  assert.ok(closureFiles.includes(wrapper)); assert.ok(closureFiles.includes(protocol));
  put(path.join(control,'migration-closure.json'),{schema:'nassaj-forward-child-closure/v1',files:[...new Set(closureFiles)].sort().map(pin)});
  config.databaseFile=databasePath;
  config.forwardMigration={node:pin(process.execPath),wrapper:pin(wrapper),entry:pin(entry),closure:pin(path.join(control,'migration-closure.json')),
    request:pin(path.join(control,'migration-request.json')),contract:pin(path.join(control,'migration-contract.json')),
    serviceIdentity:{uid:process.getuid(),gid:process.getgid(),supplementaryGids:[...new Set(process.getgroups())].sort((a,b)=>a-b)}};
  const dump=path.join(control,'retired-dump.json'); put(dump,[]);
  const systemctl=path.join(control,'fixture-systemctl');
  fs.writeFileSync(systemctl,"#!/bin/sh\nprintf '%s\\n' 'Id=fixture.service' 'LoadState=masked' 'ActiveState=inactive' 'UnitFileState=masked' 'ControlGroup='\n",{mode:0o755});
  const source={sourceId:'dump',path:dump,format:'pm2-dump-json'};
  const values={Id:'fixture.service',LoadState:'masked',ActiveState:'inactive',UnitFileState:'masked',ControlGroup:''};
  const supervisorPlan={sources:[source],slot:{name:'fixture',namespace:'fixture'},pm2:{observer:{}}};
  const mutatorPlan={systemctl:pin(systemctl),sources:[{sourceId:'unit',scope:'system',unit:'fixture.service'}],inventory:[{kind:'file',path:systemctl,sha256:pin(systemctl).sha256}]};
  config.forwardActivation={...config.forwardActivation,supervisorPlan,mutatorPlan};
  Object.assign(config.expected,{forwardExecutableClosureSha256:config.forwardMigration.closure.sha256,supervisorPlanSha256:sha(supervisorPlan),mutatorPlanSha256:sha(mutatorPlan)});
  const retired=spawnSync(process.execPath,['--input-type=module','-e',`import {inspectForwardChildIdentity} from ${JSON.stringify(pathToFileURL(protocol).href)};console.log(JSON.stringify(inspectForwardChildIdentity(process.pid)));`],{encoding:'utf8'});
  assert.equal(retired.status,0,retired.stderr);
  const retiredProcess=JSON.parse(retired.stdout);
  assert.equal(fs.existsSync(`/proc/${retiredProcess.pid}`),false);
  const retirement={schema:'nassaj-forward-retirement/v1',transactionId:request.transactionId,supervisorPlanSha256:sha(supervisorPlan),mutatorPlanSha256:sha(mutatorPlan),
    sources:[{...source,afterSha256:pin(dump).sha256,unaffectedEntriesSha256:sha([]),oldTargetAbsent:true,durable:true}],
    inhibitors:[{sourceId:'unit',proofSha256:sha({sourceId:'unit',scope:'system',user:null,values})}],runtime:{namespaceSha256:sha([])},retiredProcess};
  retirement.factsSha256=sha(retirement);
  const journal=f.read('first-cutover.json'); journal.forwardRetirement=retirement;
  const payload={...f.read('approval.json'),expectedSha256:sha(config.expected),startupAdmission:f.identity,issuedAt:Date.now()-1000,expiresAt:Date.now()+290000};delete payload.signature;
  const approval={...payload,signature:sign(null,Buffer.from(canonical(payload)),f.keys.privateKey).toString('base64url')};
  f.write('approval.json',approval);journal.expected=config.expected;journal.approvalSha256=sha(approval);journal.approvalAcceptedAt=Date.now();
  const state=f.read('startup-admission.json');state.approvalSha256=journal.approvalSha256;f.write('startup-admission.json',state);
  journal.forwardAdmission={generationEpoch:state.generationEpoch,revision:state.revision,sha256:sha(state)};f.write('first-cutover.json',journal);
  installFixedStateMutexAuthority(t,control,config,{file:path.join(control,'config.json')});
  const settings={control,database:databasePath,releaseRoot,wrapper,marker,audit,operator:FIXTURE_OPERATOR_ROOT,attestation:FIXTURE_ATTESTATION,descriptor:FIXTURE_PUBLIC,
    uid:config.forwardMigration.serviceIdentity.uid,gid:config.forwardMigration.serviceIdentity.gid,groups:config.forwardMigration.serviceIdentity.supplementaryGids};
  fs.writeFileSync(hook,authorityHookSource(settings),{mode:0o600});
  const driver=path.join(control,'migration-operator.mjs');
  fs.writeFileSync(driver,`import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {spawn} from 'node:child_process';
fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));await import(${JSON.stringify(pathToFileURL(hook).href)});
const {prepareForwardMigrationIntent,runForwardMigrationChild,observeForwardTargetForResume}=await import(${JSON.stringify(pathToFileURL(parent).href)});
const {inspectForwardChildIdentity,forwardValueSha256:sha}=await import(${JSON.stringify(pathToFileURL(protocol).href)});
const control=${JSON.stringify(control)},config=JSON.parse(fs.readFileSync(control+'/config.json')),read=()=>JSON.parse(fs.readFileSync(control+'/first-cutover.json'));
const own=inspectForwardChildIdentity(process.pid);let journal=read();journal.operator={pid:own.pid,startTicks:own.startTicks,bootId:own.bootId};
fs.writeFileSync(control+'/first-cutover.json',JSON.stringify(journal));fs.writeFileSync(control+'/first-cutover.lock',JSON.stringify({schema:'nassaj-cutover-lock/v1',pid:own.pid,startTime:own.startTicks}),{mode:0o600});
const retirement={observeRuntime:async()=>({entries:[],observationSha256:sha([])}),verifyNoHolders:()=>{
 assert.equal(fs.existsSync('/proc/${retiredProcess.pid}'),false);
 for(const fd of fs.readdirSync('/proc/self/fd')){try{const stat=fs.fstatSync(Number(fd));assert.notEqual(String(stat.ino),${JSON.stringify(request.database.inode)});}catch(e){if(e.code!=='EBADF')throw e;}}
}};
const before=createHash('sha256').update(fs.readFileSync(config.databaseFile)).digest('hex');
await prepareForwardMigrationIntent(config,{retirement});
assert.equal(createHash('sha256').update(fs.readFileSync(config.databaseFile)).digest('hex'),before);
const original=read().forwardMigrationIntent;
for(const kind of ['missing','invalid']) {
 const child=spawn(config.forwardMigration.node.path,[config.forwardMigration.wrapper.path],{cwd:'/',env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LC_ALL:'C'},stdio:['ignore','pipe','pipe','pipe','pipe']});
 let ready=false,diagnostic='',timedOut=false;child.stderr.on('data',bytes=>{diagnostic+=bytes.toString();});
 const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},12000);
 child.stdio[4].once('data',()=>{ready=true;child.stdio[3].end(kind==='invalid'?'{"schema":"invalid"}\\n':'');});
 try{const ended=await exit;assert.equal(timedOut,false,'negative child timeout');assert.equal(ended.signal,null);assert.equal(ended.code,78,diagnostic);assert.equal(ready,true,diagnostic);assert.equal(diagnostic.trimEnd(),kind==='missing'?'forward_child_frame_trailing':'forward_child_frame_invalid');}finally{clearTimeout(timer);}
 const audit=fs.readFileSync(${JSON.stringify(audit)},'utf8').trim().split('\\n').map(line=>JSON.parse(line));
 assert.equal(audit.filter(row=>row.pid===child.pid&&row.event==='sqlite-open').length,0);
 assert.equal(createHash('sha256').update(fs.readFileSync(config.databaseFile)).digest('hex'),before);
 assert.deepEqual(read().forwardMigrationIntent,original);assert.equal(read().forwardChildAuthorization,undefined);
}
await runForwardMigrationChild(config,'migration',{retirement});
const applied=read().forwardMigrationResult;assert.equal(applied.result.outcome,'applied');
assert.deepEqual(applied.result.observedBefore,${JSON.stringify(measured.manifest.databaseContract.source)});
assert.deepEqual(applied.result.observedAfter,${JSON.stringify(measured.manifest.databaseContract.target)});
const targetHash=createHash('sha256').update(fs.readFileSync(config.databaseFile)).digest('hex');
await observeForwardTargetForResume(config,{retirement});
assert.deepEqual(read().forwardMigrationIntent,original);assert.deepEqual(read().forwardMigrationResult,applied);
assert.equal(createHash('sha256').update(fs.readFileSync(config.databaseFile)).digest('hex'),targetHash);
console.log(JSON.stringify({applied:applied.result,targetObservation:read().forwardTargetObservation,originalIntent:original}));
`,{mode:0o600});
  return {
    runArchivedMigration() {
      const result=spawnSync(process.execPath,[driver],{encoding:'utf8',timeout:60000,maxBuffer:2*1024*1024,env:{...process.env,TMPDIR:control}});
      fs.writeFileSync(path.join(evidenceRoot,`${path.basename(control)}-migration-operator.log`),result.stdout+'\n'+result.stderr);
      assert.equal(result.status,0,result.stderr);
      const events=fs.readFileSync(audit,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      const opened=events.filter(event=>event.event==='sqlite-open');
      assert.equal(opened.length,2,'one migration and one readonly target observation');
      assert.deepEqual(opened.map(event=>event.readonly),[false,true]);
      for(const event of opened) { assert.equal(event.permit,true); assert.equal(event.dropped,true); assert.equal(event.path,databasePath); }
      const observation=JSON.parse(result.stdout.trim());
      assert.equal(String(fs.statSync(databasePath,{bigint:true}).ino),request.database.inode);
      return observation;
    },
    prepareInitialStartupFromMigration() {
      const current=f.read('first-cutover.json'),result=current.forwardMigrationResult?.result;
      assert.equal(result?.outcome,'applied');assert.deepEqual(result.observedAfter,measured.manifest.databaseContract.target);
      assert.ok(current.forwardTargetObservation);
      current.phase='startup_claim_pending';current.startupClaim={state:'pending'};
      current.forwardReceipts={schema:{schema:'nassaj-compatible-forward-schema/v1',transactionId:current.transactionId,
        targetSchemaDigest:result.observedAfter.schemaDigest,releaseIdentitySha256:request.releaseIdentitySha256,
        databaseContractSha256:request.databaseContractSha256,databaseDev:request.database.device,databaseIno:request.database.inode,observedAt:Date.now()}};
      f.write('first-cutover.json',current);
    },
  };
}

/** Narrow test-only root filesystem projection and exact child --import injection, never replacement frames. */
function authorityHookSource(settings) {
  return `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports,createRequire,registerHooks} from 'node:module';import {fileURLToPath} from 'node:url';
const s=${JSON.stringify(settings)},native={lstat:fs.lstatSync,fstat:fs.fstatSync,open:fs.openSync,realpath:fs.realpathSync,read:fs.readFileSync};
const inside=url=>typeof url==='string'&&url.startsWith('file:')&&(fileURLToPath(url)===s.releaseRoot||fileURLToPath(url).startsWith(s.releaseRoot+'/'));
registerHooks({resolve(specifier,context,next){const result=next(specifier,context);if(inside(context.parentURL)&&!result.url.startsWith('node:')&&!inside(result.url))throw Error('fixture_archive_dependency_escape');return result;}});
const owned=new Set();let dropped=false,permit=false;const isChild=process.argv[1]===s.wrapper;
const map=p=>p==='/etc/nassaj/release-runtime-host.json'?s.control+'/config.json':p==='/etc/nassaj'?s.control:p===s.attestation?s.control+'/release-host-support-attestation.json':p===s.descriptor?s.control+'/descriptor.json':typeof p==='string'&&(p===s.operator||p.startsWith(s.operator+'/'))?s.control+'/installed-support'+p.slice(s.operator.length):p;
const database=p=>typeof p==='string'&&(p===s.database||p.startsWith(s.database+'-')||p===${JSON.stringify(path.dirname(settings.database))});
fs.lstatSync=(p,...a)=>{const v=native.lstat(map(p),...a);if(!database(p)){v.uid=typeof v.uid==='bigint'?0n:0;if(v.isDirectory())v.mode=typeof v.mode==='bigint'?v.mode&~18n:v.mode&~18;owned.add(String(v.ino));}return v;};
fs.fstatSync=(...a)=>{const v=native.fstat(...a);if(owned.has(String(v.ino)))v.uid=typeof v.uid==='bigint'?0n:0;return v;};
fs.openSync=(p,...a)=>{if(isChild&&database(p)&&!permit)throw Error('fixture_database_open_before_permit');const fd=native.open(map(p),...a);if(!database(p))owned.add(String(native.fstat(fd).ino));return fd;};
fs.realpathSync=(p,...a)=>map(p)!==p?(native.realpath(map(p),...a),p):native.realpath(p,...a);
fs.readFileSync=(p,...a)=>{const v=native.read(map(p),...a);const parent=Number(native.read(s.marker,'utf8'));if(p==='/proc/'+parent+'/status'||p==='/proc/'+process.pid+'/status'||typeof p==='string'&&p.endsWith('/status')&&v.toString().split('\\n').some(l=>l.startsWith('PPid:')&&Number(l.slice(5))===parent)){let text=v.toString().replace(/^Groups:.*$/m,'Groups:\\t'+s.groups.join(' '));if(p==='/proc/'+parent+'/status')text=text.replace(/^Uid:.*$/m,'Uid:\\t0\\t0\\t0\\t0');return Buffer.isBuffer(v)?Buffer.from(text):text;}return v;};
process.getuid=()=>dropped?s.uid:0;process.geteuid=()=>dropped?s.uid:0;
process.setgroups=v=>{if(JSON.stringify(v)!==JSON.stringify(s.groups))throw Error('fixture_groups_mismatch');};process.setgid=v=>{if(v!==s.gid)throw Error('fixture_gid_mismatch');};process.setuid=v=>{if(v!==s.uid)throw Error('fixture_uid_mismatch');dropped=true;};
const audit=value=>fs.appendFileSync(s.audit,JSON.stringify({pid:process.pid,...value})+'\\n');
const writeStream=fs.createWriteStream;fs.createWriteStream=(p,o)=>{const stream=writeStream(p,o);if(isChild&&o?.fd===4){const write=stream.write.bind(stream);stream.write=(bytes,...args)=>{for(const fd of fs.readdirSync('/proc/self/fd')){try{const stat=native.fstat(Number(fd));if(String(stat.ino)===String(native.lstat(s.database).ino)&&String(stat.dev)===String(native.lstat(s.database).dev))throw Error('fixture_ready_has_database_fd');}catch(e){if(e.code!=='EBADF')throw e;}}audit({event:'ready',dropped,frame:JSON.parse(bytes)});return write(bytes,...args);};}return stream;};
const readStream=fs.createReadStream;fs.createReadStream=(p,o)=>{const stream=readStream(p,o);if(isChild&&o?.fd===3)stream.on('data',bytes=>{permit=true;audit({event:'permit-delivered',bytes:bytes.length});});return stream;};
const spawn=cp.spawn;cp.spawn=(file,args,options)=>{if(file===${JSON.stringify(fs.realpathSync(process.execPath))}){if(args?.[0]===s.wrapper){if(JSON.stringify(options.stdio)!==JSON.stringify(['ignore','pipe','pipe','pipe','pipe']))throw Error('fixture_fd_contract_changed');const child=spawn(file,['--import',import.meta.url,...args],options);child.stderr.on('data',bytes=>audit({event:'child-diagnostic',childPid:child.pid,text:bytes.toString().slice(0,1000)}));child.once('close',(code,signal)=>audit({event:'child-exit',childPid:child.pid,code,signal}));return child;}}return spawn(file,args,options);};
if(isChild){const require=createRequire(s.releaseRoot+'/package.json'),addon=require(s.releaseRoot+'/node_modules/better-sqlite3/build/Release/better_sqlite3.node');const Database=addon.Database;addon.Database=new Proxy(Database,{construct(target,args){audit({event:'sqlite-open',permit,dropped,path:args[0],readonly:args[3]});if(!permit||!dropped)throw Error('fixture_sqlite_before_permit');return Reflect.construct(target,args);}});}
syncBuiltinESMExports();`;
}
