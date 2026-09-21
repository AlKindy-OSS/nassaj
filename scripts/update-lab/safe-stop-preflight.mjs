/** Read-only safe-script diagnostic on a fresh private baseline; no typed stop or candidate transaction. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {prepareBridgeBaseline,runBridgeIsolated} from './bridge-rehearsal.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
/** Run only ordinary --json and :memory: native checks; never claims typed-stop success. */
export function probeSafeStopPreflight(baseline) {
    if(!baseline.startsWith(root+'/.artifacts/t1772-bridge-rehearsal/baseline-')||fs.realpathSync(baseline)!==baseline)throw Error('preflight_baseline_invalid');
    const {lab}=prepareBridgeBaseline(baseline),app=path.join(lab,'app');
    fs.appendFileSync(path.join(app,'.env'),'NASSAJ_UPDATE_MODE=local-main\n');
    const entry=path.join(lab,'harness/safe-stop-preflight.mjs');
    fs.writeFileSync(entry,`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const lab=process.cwd(),app=lab+'/app',meta=JSON.parse(fs.readFileSync(lab+'/scenario.json'));assert.equal(process.pid,1);assert.equal(process.env.PM2_HOME,process.env.HOME+'/.pm2');
const pm2=args=>{const r=spawnSync('/usr/bin/pm2',args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,'private PM2 failed');return r.stdout;};
const report={schema:'safe-stop-readonly-preflight/v1',typedStopTested:false,clonePerformed:false,namespaceProfile:'existing-readonly-bridge',mappedUid:process.getuid()};
try {pm2(['start',lab+'/ecosystem.config.cjs']);let health;const until=Date.now()+60000;while(Date.now()<until){try{const r=await fetch('http://127.0.0.1:'+meta.port+'/health',{signal:AbortSignal.timeout(1000)});if(r.ok){const b=await r.json();if(b.normalAdmissionReady){health=b;break;}}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(health,'baseline readiness');
report.baseline={pid:health.pid,oid:health.serverLoadedOid,serverBuildId:health.serverLoadedBuildId,clientBuildId:health.clientBuildIdServed};
const native=spawnSync(process.execPath,['-e','const D=require("better-sqlite3");const d=new D(":memory:");try{if(d.prepare("SELECT 1 AS ok").get().ok!==1)process.exit(2);}finally{d.close();}'],{cwd:app,encoding:'utf8'});report.native={status:native.status,signal:native.signal};assert.equal(native.status,0);
const manifest=JSON.parse(fs.readFileSync(app+'/dist-server/OID_CONTROL_MANIFEST.json')),safe=app+'/dist-server/scripts/safe-restart.sh';const bytes=fs.readFileSync(safe);assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.safeRestartSha256);
const result=spawnSync('/usr/bin/bash',[safe,'--json'],{cwd:app,env:{...process.env,PROC_NAME:meta.processName,NASSAJ_PROCESS_NAME:meta.processName,NASSAJ_CAPSULE_MODE_ABI:'nassaj-capsule-roots/v1',NASSAJ_CAPSULE_REPO_ROOT:app,NASSAJ_CAPSULE_ARTIFACT_ROOT:app+'/dist-server'},encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
let parsed;try{parsed=JSON.parse(result.stdout);}catch{}report.safeJson={status:result.status,signal:result.signal,errorCode:result.error?.code??null,parsed:!!parsed,sessionCount:parsed?.sessionCount,stdoutSha256:createHash('sha256').update(result.stdout||'').digest('hex'),stderrSha256:createHash('sha256').update(result.stderr||'').digest('hex')};
}finally{fs.writeFileSync(lab+'/safe-stop-preflight-proof.json',JSON.stringify(report,null,2));pm2(['kill']);}console.log(JSON.stringify(report));`);
    const result=runBridgeIsolated(lab,entry,{privateDependencies:false,timeout:120000});return {lab,status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log(JSON.stringify(probeSafeStopPreflight(path.resolve(process.argv[2]))));
