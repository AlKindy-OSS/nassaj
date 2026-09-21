/** Laboratory-only HTTPS health facade. Never installs a host trust anchor. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import {spawnSync} from 'node:child_process';

/** Refuse host execution before creating a key, opening a socket or accepting a lab path. */
export function assertRecoveryLabBoundary(lab) {
    if(process.pid!==1||process.getuid()===0||!/^.*\/\.artifacts\/t1772-bridge-rehearsal\/run-[^/]+$/.test(lab)
        ||fs.realpathSync(lab)!==lab||process.cwd()!==lab||process.env.PM2_HOME!==path.join(process.env.HOME,'.pm2')
        ||process.env.DATABASE_PATH!==path.join(lab,'data/auth.db'))throw Error('local_recovery_lab_boundary');
    for(const [key,name] of [['USER','user'],['MOUNT','mnt'],['NET','net'],['PID','pid']]) {
        const parent=process.env[`NASSAJ_LAB_PARENT_${key}_NS`];
        if(!parent||fs.readlinkSync(`/proc/self/ns/${name}`)===parent)throw Error('local_recovery_lab_namespace');
    }
    if(Object.keys(os.networkInterfaces()).some(name=>name!=='lo'))throw Error('local_recovery_lab_network');
    const status=fs.readFileSync('/proc/self/status','utf8');
    for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])
        if(!new RegExp(`^${key}:\\s+0000000000000000$`,'m').test(status))throw Error('local_recovery_lab_capabilities');
    if(!/^NoNewPrivs:\s+1$/m.test(status)||fs.existsSync('/put_old'))throw Error('local_recovery_lab_privilege');
}

/** Use the existing test-suite OpenSSL pattern, but only after the private-root boundary passes. */
export function prepareRecoveryLabTls(lab) {
    assertRecoveryLabBoundary(lab);
    const directory=path.join(lab,'test-tls');fs.mkdirSync(directory,{mode:0o700});
    const key=path.join(directory,'loopback.key.pem'),cert=path.join(directory,'loopback.cert.pem');
    const result=spawnSync('/usr/bin/openssl',['req','-config','/dev/null','-x509','-newkey','rsa:2048','-nodes','-days','1',
        '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{encoding:'utf8',timeout:10000});
    if(result.status!==0)throw Error('local_recovery_lab_tls_generation_failed');
    fs.chmodSync(key,0o600);fs.chmodSync(cert,0o600);
    return {key,cert};
}

/** Serve only the real private application's /health; failures remain failures, never synthetic success. */
export async function startRecoveryLabTlsHealth(lab,{key,cert},port=3004) {
    assertRecoveryLabBoundary(lab);
    if(!Number.isInteger(port)||port<1024||port>65535)throw Error('local_recovery_lab_port');
    const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},async(request,response)=>{
        if(request.method!=='GET'||request.url!=='/health'){response.writeHead(404);response.end();return;}
        try {
            const upstream=await fetch(`http://127.0.0.1:${port}/health`,{redirect:'error',signal:AbortSignal.timeout(2000)});
            response.writeHead(upstream.status,{'Content-Type':'application/json','Cache-Control':'no-store'});
            response.end(await upstream.text());
        } catch {response.writeHead(503);response.end('{}');}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    return {url:`https://127.0.0.1:${server.address().port}/health`,cert,
        close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
