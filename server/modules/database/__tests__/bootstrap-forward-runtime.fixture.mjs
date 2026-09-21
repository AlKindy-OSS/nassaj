import {readColdArchiveRequest,verifyColdArchiveInput,restrictColdArchiveImports,coldGitEnvironment,assertColdGitFixture} from './forward-cold-archive-input.mjs';
import {createRequire} from 'node:module';
import {installFixedStateMutexAuthority} from '../../../../scripts/fixtures/fixed-state-mutex-authority.mjs';
import {assertStartupSqlTrace} from './startup-sql-trace-contract.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import net from 'node:net';
import webPush from 'web-push';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import {recordForwardTargetHealth} from '../../../../scripts/lib/release-runtime-forward-receipts.mjs';
import {finalizeCommittedStartupAdmission} from '../../../../scripts/lib/release-runtime-startup-admission.mjs';

import { prepareArchivedMigrationAuthority } from '../../../../scripts/fixtures/cold-forward-migration-authority.mjs';
import { createBootstrapContextHarness } from '../../../../scripts/fixtures/bootstrap-context-harness.mjs';
import { setupInitialArmFixture } from '../../../../scripts/fixtures/initial-arm-fixture.mjs';

const project = process.argv[2];
const sandbox = process.cwd();
const inputFile=process.argv[3] || '';
const archiveInput=inputFile?readColdArchiveRequest(inputFile):null;
const evidenceRoot=path.join(sandbox,'evidence');
fs.mkdirSync(path.join(sandbox,'.artifacts'),{recursive:true});
fs.mkdirSync(evidenceRoot,{recursive:true});
const load = file => import(pathToFileURL(file).href);

/** Prepare pre-existing legacy control records as fixture data; admission remains unclaimed. */
function seedPreviousUpdateControl(gitRoot) {
  const control=path.join(gitRoot,'.git','nassaj-source-update');
  assert.equal(fs.existsSync(control),false);
  fs.mkdirSync(control,{mode:0o700});
  const token='cold-fixture-previous-generation-token';
  const journal={schema:'nassaj-source-update-maintenance/v1',sequence:0,state:'OPEN',phase:null,
    gateClosed:false,transactionId:null,owner:null,identity:null,
    tokenDigest:createHash('sha256').update(token).digest('hex'),updatedAt:new Date().toISOString()};
  const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`
    :value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    :JSON.stringify(value);
  const checksum=createHash('sha256').update(canonical(journal)).digest('hex');
  for(const [name,content] of Object.entries({token,'journal.json':JSON.stringify({...journal,checksum}),
    'admission.lock':'','activity.lock':''})) fs.writeFileSync(path.join(control,name),content,{flag:'wx',mode:0o600});
}

// Invoked only inside the reviewed kernel isolation launcher, including fixture authority and verifier.
for(const failCleanup of [false,true]) test(`cold compiled bootstrap ${failCleanup ? 'closes listener on post-confirm cleanup failure' : 'gates HTTP/WS until current claim serves'}`, async t => {
  const measured=archiveInput?verifyColdArchiveInput(archiveInput):null;
  const dependencyHook=measured?restrictColdArchiveImports(archiveInput.extractedRoot):null;
  const Database=measured?createRequire(path.join(archiveInput.extractedRoot,'package.json'))('better-sqlite3'):(await import('better-sqlite3')).default;
  let running;
  const root = fs.mkdtempSync(path.join(sandbox, '.artifacts', 'cold-forward-runtime-'));
  t.after(async () => {if(running){if(running.child.exitCode===null&&running.child.signalCode===null)running.child.kill('SIGTERM');
    const timer=setTimeout(()=>running.child.kill('SIGKILL'),1000);try{await running.result;}finally{clearTimeout(timer);}}
    if(measured){try{verifyColdArchiveInput(archiveInput);}finally{dependencyHook.deregister();}}
    fs.rmSync(root,{recursive:true,force:true});});
  const releaseRoot=measured?archiveInput.extractedRoot:root;
  const compiled = path.join(releaseRoot, 'dist-server');
  if(!measured) for (const [tool, args] of [
    ['tsc', ['--project', 'server/tsconfig.json', '--outDir', compiled]],
    ['tsc-alias', ['--project', 'server/tsconfig.json', '--outDir', compiled]],
  ]) {
    const result = spawnSync(path.join(project, 'node_modules/.bin', tool), args, {cwd:project,encoding:'utf8',env:{...process.env,TMPDIR:root}});
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const server = path.join(compiled, 'server');
  if(!measured){fs.mkdirSync(path.join(server,'bin'),{recursive:true});
  fs.copyFileSync(path.join(project,'server/bin/claude'),path.join(server,'bin/claude'));
  fs.chmodSync(path.join(server,'bin/claude'),0o755);}
  // Prepare fixture security with default v1 modules before sealing the forward profile.
  const {migrateConnectorAuthSchema} = await load(path.join(server, 'modules/database/connector-auth.migration.js'));
  const {migrateConnectorPolicyV2Substrate} = await load(path.join(server, 'modules/database/connector-policy-v2.migration.js'));
  const {openOrCreateConnectorRuntimeAuthorityRoot} = await load(path.join(server, 'modules/connectors/connector-runtime-authority-root.js'));
  const {reinstallConnectorRuntimeFence} = await load(path.join(server, 'modules/connectors/connector-runtime-fence.js'));
  const {observeCompatibleForwardDatabase} = await load(path.join(server, 'modules/database/compatible-forward-observation.js'));
  const directory = path.join(root, 'db-private'); fs.mkdirSync(directory, {mode:0o700});
  const databasePath = path.join(directory, 'fixture.sqlite');
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  const baselineBytes=fs.readFileSync(path.join(project,'server/scripts/fixtures/compatible-forward-schema-v1.json'));
  assert.equal(createHash('sha256').update(baselineBytes).digest('hex'),'0bb67fea8559d5413d5c4944352a003c73439684a4d8df15f9ab42c911760960');
  const schema=JSON.parse(baselineBytes);
  for(const type of ['table','index','view']) for(const object of schema.objects.filter(row=>row.type===type && !['connector_runtime_anchor','connector_runtime_control','connector_runtime_writer_lease'].includes(row.name))) db.exec(object.sql);
  db.prepare('INSERT INTO users(id,username,password_hash,role,status,is_active) VALUES (?, ?, ?, ?, ?, ?)').run(7,'fixture','fixture-hash','owner','active',1);
  db.prepare('INSERT INTO app_config(key,value) VALUES (?, ?)').run('jwt_secret','fixture-only-'.repeat(5));
  for(const marker of schema.markers) if(marker.present) db.prepare('INSERT INTO app_config(key,value) VALUES (?, ?)').run(marker.key,'fixture');
  const vapid=webPush.generateVAPIDKeys();
  db.prepare('INSERT INTO vapid_keys(public_key,private_key) VALUES (?, ?)').run(vapid.publicKey,vapid.privateKey);
  migrateConnectorAuthSchema(db);
  const installation = migrateConnectorPolicyV2Substrate(db);
  db.prepare('INSERT INTO connector_m5_installation_origin VALUES (?, ?, ?)').run(installation,'https://existing.example',Date.now());
  const authority = openOrCreateConnectorRuntimeAuthorityRoot(databasePath + '.connector-runtime-authority.json').authority;
  reinstallConnectorRuntimeFence(db, authority);
  if(!measured) {
    const {migrateCompatibleForwardPermissionReceipt}=await load(path.join(server,'modules/database/compatible-forward-permission-receipt.migration.js'));
    db.transaction(() => migrateCompatibleForwardPermissionReceipt(db))();
  }
  for(const object of schema.objects.filter(row=>row.type==='trigger')) {
    if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?").get(object.name)) db.exec(object.sql);
  }
  const oldColumns=Object.fromEntries(schema.objects.filter(item=>item.type==='table').map(item=>[item.name,db.pragma(`table_info("${item.name}")`).map(column=>column.name)]));
  const projectRows=connection=>Object.fromEntries(Object.entries(oldColumns).map(([table,columns])=>[table,connection.prepare(`SELECT ${columns.map(column=>`"${column}"`).join(',')} FROM "${table}"`).all()]));
  const oldRows=projectRows(db);
  const observedSeed = observeCompatibleForwardDatabase(db);
  if(measured)assert.deepEqual(observedSeed,measured.manifest.databaseContract.source);
  const target = measured ? measured.manifest.databaseContract.target : observedSeed;
  db.close(); fs.chmodSync(databasePath,0o600);
  const gitRoot=measured?path.join(root,'git-fixture'):root;fs.mkdirSync(gitRoot,{recursive:true});
  const initialGitEnv=Object.fromEntries(Object.entries(coldGitEnvironment(gitRoot)).filter(([key])=>!['GIT_DIR','GIT_WORK_TREE'].includes(key)));
  const git=spawnSync('/usr/bin/git',['init','-q',gitRoot],{encoding:'utf8',env:initialGitEnv});assert.equal(git.status,0,git.stderr);
  assertColdGitFixture(gitRoot);
  const {createUpdateMaintenanceGate}=await load(path.join(server,'services/update-maintenance-gate.js'));
  assertColdGitFixture(gitRoot);
  const gateOptions={projectPath:gitRoot,
    commandRunner:(file,args,options)=>{assert.equal(file,'git');return spawnSync('/usr/bin/git',args,{...options,env:assertColdGitFixture(gitRoot)});}};
  if(measured) {
    // A sealed archive cannot initialize legacy state before its real root claim.
    // Seed the previous-generation fixture state, not a verified startup context.
    assert.throws(()=>createUpdateMaintenanceGate(gateOptions),/root_startup_admission_required/);
    seedPreviousUpdateControl(gitRoot);
  } else {
    const gate=createUpdateMaintenanceGate(gateOptions);
    for(const lock of [gate.paths.admissionLock,gate.paths.activityLock]) fs.writeFileSync(lock,'',{mode:0o600});
  }
  if(!measured){fs.copyFileSync(path.join(project,'package.json'),path.join(root,'package.json'));
  const {installReleaseBootstrapEntry}=await import('../../../../scripts/server-build-atomic.mjs');
  installReleaseBootstrapEntry(compiled);
  fs.writeFileSync(path.join(server,'bootstrap-release-profile.js'), "export const ROOT_ADMISSION_REQUIRED=true;\nexport const PROFILE_ID='local-forward-349/v2';\n");
  // Real file measurements use fixture build identities, sealed before startup.
  fs.writeFileSync(path.join(compiled,'BUILD_PROVENANCE.json'),JSON.stringify({buildId:'a'.repeat(64)}));
  fs.mkdirSync(path.join(root,'dist'));
  fs.writeFileSync(path.join(root,'dist/version.json'),JSON.stringify({buildId:'a'.repeat(64)}));}
  const clientVersion=path.join(releaseRoot,'dist/version.json');
  const files = measured?[...measured.manifest.files]:[];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
      const file = path.join(directory,entry.name);
      if (entry.isDirectory()) collect(file);
      else { const metadata=fs.statSync(file); files.push({path:path.relative(root,file),size:metadata.size,mode:metadata.mode&0o777,
        sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}); }
    }
  }
  if(!measured){collect(compiled); files.sort((a,b)=>a.path.localeCompare(b.path,'en'));}
  const probe=net.createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
  const envPath=path.join(root,'.env');
  fs.writeFileSync(envPath,`DATABASE_PATH=${databasePath}\nSERVER_PORT=${port}\nHOST=127.0.0.1\n`);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  const f=createBootstrapContextHarness(t,{releaseRoot,files,databasePath,databaseTarget:target,childTimeoutMs:30000,simulateInitialOperator:true,
    ...(measured?{phase:'pre-migration',localBuild:true,measuredRelease:measured,archiveBoundary:{root:releaseRoot,envFile:envPath}}:{})});
  Object.assign(f.config.bootstrapClaim,{applicationUid:process.getuid(),nodeExecutable:fs.realpathSync(process.execPath)});
  f.config.health={privateUrl:`http://127.0.0.1:${port}/health`,publicUrl:`http://127.0.0.1:${port}/health`};
  const initialHost=f.read('host-dispatch-state.json');
  initialHost.gateInstallIntent.publicUrl=f.config.health.publicUrl;
  f.write('host-dispatch-state.json',initialHost);
  f.write('config.json',f.config);
  if(measured) {
    const migration=prepareArchivedMigrationAuthority(t,f,measured,releaseRoot,databasePath,evidenceRoot);
    migration.runArchivedMigration();
    const migrated=new Database(databasePath,{readonly:true,fileMustExist:true});
    try { assert.deepEqual(projectRows(migrated),oldRows); assert.deepEqual(observeCompatibleForwardDatabase(migrated),target); } finally { migrated.close(); }
    migration.prepareInitialStartupFromMigration();
    verifyColdArchiveInput(archiveInput);
  }
  const bootstrap=pathToFileURL(path.join(server,'bootstrap.js')).href;
  const contextUrl=pathToFileURL(path.join(server,'bootstrap-startup-context.js')).href;
  const traceFile=path.join(root,'sql-trace.jsonl');
  const isolatedHome=path.join(root,'vendor-home'); fs.mkdirSync(isolatedHome,{mode:0o700});
  const beforeClaimHash=createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
  const gitSetup=measured?`
    const {assertColdGitFixture}=await import(${JSON.stringify(new URL('./forward-cold-archive-input.mjs',import.meta.url).href)});
    const coldEnv=assertColdGitFixture(${JSON.stringify(gitRoot)});for(const key of Object.keys(process.env))if(key.startsWith('GIT_'))delete process.env[key];
    for(const [key,value]of Object.entries(coldEnv))if(key.startsWith('GIT_'))process.env[key]=value;
  `:'';
  const beforeClaim=await f.start(`
    ${gitSetup}
    import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
    os.homedir=()=>${JSON.stringify(isolatedHome)};syncBuiltinESMExports();
    delete process.env.DATABASE_PATH;delete process.env.JWT_SECRET;
    delete process.env.NASSAJ_UNIVERSAL_CONVERSATIONS_SHADOW;
    await import(${JSON.stringify(pathToFileURL(path.join(server,'application.js')).href)});
  `).result;
  assert.notEqual(beforeClaim.code,0);assert.match(beforeClaim.stderr,/root_startup_admission_required/);
  assert.equal(f.read('startup-admission.json').lastClaim,null);
  assert.equal(createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex'),beforeClaimHash);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  const go=path.join(f.root,'cold-start-go');
  const databaseSpecifier=measured?pathToFileURL(createRequire(path.join(releaseRoot,'package.json')).resolve('better-sqlite3')).href:'better-sqlite3';
  running=f.start(`
    ${gitSetup}
    import fs from 'node:fs'; import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; import Database from ${JSON.stringify(databaseSpecifier)};
    import {setTimeout as delay} from 'node:timers/promises';
    while(!fs.existsSync(${JSON.stringify(go)}))await delay(5);
    import childProcess from 'node:child_process';
    const fixtureSpawn=childProcess.spawn;
    childProcess.spawn=(file,args,options)=>{
      const child=fixtureSpawn(file,args,options);
      if(file===${JSON.stringify(f.descriptor.sudo.path)}) {
        let diagnostic='';
        child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(0,256)});
        child.once('close',code=>{if(code!==0)fs.writeFileSync(${JSON.stringify(path.join(evidenceRoot,`dispatcher-${failCleanup?'cleanup':'normal'}.json`))},
          JSON.stringify({code,reason:/^[a-z][a-z0-9_]{0,127}$/.test(diagnostic)?diagnostic:'dispatcher_diagnostic_redacted'}));});
      }
      return child;
    };
    syncBuiltinESMExports();
    os.homedir=()=>${JSON.stringify(isolatedHome)};
    const rolePrefix='/var/tmp/nassaj-turn-supervisor-roles';
    for(const method of ['mkdir','readdir','readFile','rm','unlink','writeFile']) {
      const original=fs.promises[method];
      fs.promises[method]=function(file,...args) {
        if(typeof file==='string' && (file===rolePrefix||file.startsWith(rolePrefix+'/'))) {
          if(${JSON.stringify(failCleanup)} && method==='mkdir') throw Error('fixture_cleanup_failure');
          file=${JSON.stringify(root)}+'/role-fixture'+file.slice(rolePrefix.length);
        }
        return original.call(this,file,...args);
      };
    }
    syncBuiltinESMExports();
    process.env.WORKSPACES_ROOT=${JSON.stringify(isolatedHome)};
    const {readVerifiedStartupContext}=await import(${JSON.stringify(contextUrl)});
    let envChanged=false;
    const record=(method,sql)=>{
      const phase=readVerifiedStartupContext()?.phase;
      fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({phase,method,sql,shadow:process.env.NASSAJ_UNIVERSAL_CONVERSATIONS_SHADOW??null})+'\\n');
      if(phase==='claimed'&&!envChanged) {
        envChanged=true; fs.writeFileSync(${JSON.stringify(envPath)},'NASSAJ_UNIVERSAL_CONVERSATIONS_SHADOW=1\\n');
      }
    };
    for(const method of ['exec','pragma']) {
      const original=Database.prototype[method];
      Database.prototype[method]=function(sql,...args){record(method,sql);return original.call(this,sql,...args)};
    }
    const prepare=Database.prototype.prepare;
    Database.prototype.prepare=function(sql,...args){
      const statement=prepare.call(this,sql,...args);
      for(const method of ['run','get','all','iterate']) {
        const original=statement[method]; statement[method]=function(...params){record(method,sql);return original.apply(this,params)};
      }
      return statement;
    };
    delete process.env.DATABASE_PATH; delete process.env.JWT_SECRET;
    delete process.env.SERVER_PORT; delete process.env.HOST;
    delete process.env.NASSAJ_UNIVERSAL_CONVERSATIONS_SHADOW;
    const {bootstrapServer}=await import(${JSON.stringify(bootstrap)});
    await bootstrapServer();
  `);
  t.after(()=>running.child.kill('SIGKILL'));
  let ended; running.result.then(value=>{ended=value});
  const armed=await setupInitialArmFixture(t,{fixture:f,targetChild:running.child});
  const stateAuthority=installFixedStateMutexAuthority(t,f.root,f.config,{file:path.join(f.root,'config.json')});
  stateAuthority.write(f.config);
  const initialWindow=f.read('first-cutover.json').initialStartWindow;
  fs.writeFileSync(go,'go');
  const pending=path.join(f.root,'initial-pending-observed.json');
  const pendingDeadline=Date.now()+2000;
  while(!fs.existsSync(pending)&&Date.now()<pendingDeadline&&!ended)await delay(10);
  assert.ok(fs.existsSync(pending),ended?.stderr||'actual root pending response absent');
  assert.equal(f.read('startup-admission.json').lastClaim,null);
  assert.equal(createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex'),beforeClaimHash);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  await armed.arm();
  assert.deepEqual(f.read('first-cutover.json').initialStartWindow,initialWindow);
  let health;
  for(let attempt=0;attempt<100;attempt++) {
    if(ended) assert.fail(ended.stderr+'\n'+ended.stdout);
    try { const response=await fetch(`http://127.0.0.1:${port}/health`); if(response.ok) {health=await response.json(); break;} } catch {}
    await delay(100);
  }
  assert.ok(health,'private health never became available');
  assert.equal(health.normalAdmissionReady,false);
  assert.equal(health.pid,running.child.pid);
  assert.equal(health.claimId,f.read('startup-admission.json').lastClaim.claimId);
  const privateHealth=health;
  const claim=f.read('startup-admission.json').lastClaim;
  assert.equal(health.generationEpoch,claim.generationEpoch);
  assert.equal(health.startTicks,claim.startTicks); assert.equal(health.bootId,claim.bootId);
  const token=jwt.sign({userId:7},'fixture-only-'.repeat(5),{expiresIn:'1m',algorithm:'HS256'});
  const closed=await fetch(`http://127.0.0.1:${port}/api/auth/status`); assert.equal(closed.status,503);
  await new Promise((resolve,reject)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers:{Authorization:`Bearer ${token}`}});
    ws.on('open',()=>{ws.close();reject(Error('premature_ws_open'))});
    ws.on('error',()=>resolve());
  });
  // Only root ownership/effective UID are simulated; fetch and /proc listener/process checks are real.
  const recordPaths=new Set(['first-cutover.json','startup-admission.json','host-dispatch-state.json'].map(name=>path.join(f.root,name)));
  const receiptDeps={effectiveUid:()=>0,readRootRecord:file=>{
    assert.ok(recordPaths.has(file));return JSON.parse(fs.readFileSync(file,'utf8'));
  }};
  if(!measured){fs.writeFileSync(clientVersion,JSON.stringify({buildId:'b'.repeat(64)}));
  await assert.rejects(recordForwardTargetHealth(f.config,'private',receiptDeps),/forward_receipt_health_identity/);
  assert.equal(f.read('first-cutover.json').phase,'startup_security_authorized');
  fs.writeFileSync(clientVersion,JSON.stringify({buildId:'a'.repeat(64)}));}
  await recordForwardTargetHealth(f.config,'private',receiptDeps);
  // Public ingress switching is fixture-only; health observation still uses the actual listener.
  const host=f.read('host-dispatch-state.json');const boundaryAt=Date.now();
  f.write('host-dispatch-state.json',{...host,gateActive:false,
    publicBoundaryReady:{nonce:host.gateInstallIntent.nonce,at:boundaryAt},
    publicBoundaryOpened:{nonce:host.gateInstallIntent.nonce,at:boundaryAt}});
  f.write('first-cutover.json',{...f.read('first-cutover.json'),phase:'ingress_opened'});
  await recordForwardTargetHealth(f.config,'public',receiptDeps);
  finalizeCommittedStartupAdmission(f.config,{...f.deps,now:()=>Date.now()});
  function saveAndAssertSqlTrace() {
    const statements=fs.readFileSync(traceFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const prefix=failCleanup ? 'cleanup-failure-' : '';
    fs.writeFileSync(path.join(evidenceRoot,`${prefix}bootstrap-forward-sql-trace.json`),JSON.stringify(statements,null,2));
    const effects=assertStartupSqlTrace(statements);
    fs.writeFileSync(path.join(evidenceRoot,`${prefix}bootstrap-forward-security-effects.json`),JSON.stringify(effects,null,2));
  }
  if(failCleanup) {
    const result=await running.result;
    assert.notEqual(result.code,0); assert.match(result.stderr,/fixture_cleanup_failure/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/auth/status`));
    fs.writeFileSync(path.join(evidenceRoot,'cleanup-failure.json'),JSON.stringify({postConfirmCleanupFailure:true,listenerClosed:true,privateHealth,claimId:claim.claimId}));
    saveAndAssertSqlTrace();
    return;
  }
  for(let attempt=0;attempt<100;attempt++) {
    if(ended) assert.fail(ended.stderr+'\n'+ended.stdout);
    const response=await fetch(`http://127.0.0.1:${port}/health`); health=await response.json();
    if(health.normalAdmissionReady) {assert.equal(response.headers.get('cache-control'),'no-store');break;}
    await delay(100);
  }
  assert.equal(health.normalAdmissionReady,true);
  assert.equal(health.startupPhase,'serving');
  assert.equal(health.claimId,claim.claimId);
  const status=await fetch(`http://127.0.0.1:${port}/api/auth/status`); assert.equal(status.status,200);
  assert.equal((await status.json()).needsSetup,false);
  await new Promise((resolve,reject)=>{
    const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers:{Authorization:`Bearer ${token}`}});
    ws.on('open',()=>{ws.close();resolve()}); ws.on('error',reject);
  });
  fs.writeFileSync(path.join(evidenceRoot,'startup-health.json'),JSON.stringify({beforeClaim:'direct application import rejected; database bytes unchanged; no listener',privateHealth,servingHealth:health,httpBeforeConfirm:closed.status,httpAfterConfirm:status.status,authenticatedWsBeforeConfirm:'denied',authenticatedWsAfterConfirm:'opened',claim,rootMetadataAndSudo:'fixture simulation; public ingress transition simulated; HTTP health receipt producer, signatures/CAS/process/listener identities real inside namespace',healthReceipts:f.read('first-cutover.json').forwardReceipts,clientBuildTamper:measured?'baseline negative only; immutable archive actual identity verified':'actual HTTP consumer rejected'},null,2));
  running.child.kill('SIGKILL'); await running.result;
  saveAndAssertSqlTrace();
});
