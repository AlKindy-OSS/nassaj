import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareBridgeWorkspace,runBridgeIsolated} from './bridge-rehearsal.mjs';
import {assertRecoveryLabBoundary,prepareRecoveryLabTls} from './local-source-recovery-tls.mjs';
const modulePath=fileURLToPath(new URL('./local-source-recovery-tls.mjs',import.meta.url));

test('TLS helper refuses the host before any key write',()=>{
    assert.throws(()=>assertRecoveryLabBoundary(process.cwd()),/boundary/);
    assert.throws(()=>prepareRecoveryLabTls(process.cwd()),/boundary/);
});

test('private TLS verifies its local CA, rejects untrusted clients and preserves upstream failures',()=>{
    const lab=prepareBridgeWorkspace(),entry=path.join(lab,'harness/local-source-recovery-tls-probe.mjs');
    fs.copyFileSync(modulePath,path.join(lab,'harness/local-source-recovery-tls.mjs'));
    fs.writeFileSync(entry,`import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import {spawn} from 'node:child_process';
import {prepareRecoveryLabTls,startRecoveryLabTlsHealth} from './local-source-recovery-tls.mjs';
const lab=process.cwd(),material=prepareRecoveryLabTls(lab);
let status=200;const upstream=http.createServer((q,r)=>{r.writeHead(status);r.end(JSON.stringify({realUpstream:true}));});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const proxy=await startRecoveryLabTlsHealth(lab,material,upstream.address().port);
const call=trusted=>new Promise(resolve=>{const env={...process.env};delete env.NODE_TLS_REJECT_UNAUTHORIZED;delete env.NODE_EXTRA_CA_CERTS;if(trusted)env.NODE_EXTRA_CA_CERTS=material.cert;
const child=spawn(process.execPath,['--input-type=module','-e',"try{const r=await fetch(process.argv[1]);console.log(JSON.stringify({status:r.status,body:await r.json()}));}catch(e){console.error(e.cause?.code||e.message);process.exitCode=1;}",proxy.url],{env,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('exit',code=>resolve({code,out,err}));});
try {const untrusted=await call(false);assert.notEqual(untrusted.code,0);assert.match(untrusted.err,/SELF_SIGNED|CERT/);
const trusted=await call(true);assert.equal(trusted.code,0,trusted.err);assert.deepEqual(JSON.parse(trusted.out),{status:200,body:{realUpstream:true}});
status=503;const unavailable=await call(true);assert.equal(JSON.parse(unavailable.out).status,503);
assert.equal(fs.statSync(material.key).mode&511,384);
console.log(JSON.stringify({schema:'nassaj-local-recovery-tls-proof/v1',trustedTls:true,untrustedRejected:true,upstream503Preserved:true,hostTrustModified:false}));
}finally{await proxy.close();await new Promise(r=>upstream.close(r));}
`,{mode:0o600});
    const result=runBridgeIsolated(lab,entry,{privateDependencies:true,timeout:20000});
    assert.equal(result.status,0,result.stderr);const proof=JSON.parse(result.stdout.trim());
    assert.equal(proof.trustedTls,true);
    const report=path.resolve(path.dirname(modulePath),'../../.artifacts/t1772-current-readiness-20260919/local-source-recovery-lab-tls.json');
    fs.writeFileSync(report,JSON.stringify({lab,...proof},null,2),{mode:0o600});
});
