/** Kernel-effect test: never invoke nft outside an owned B899-derived namespace. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import test from 'node:test';
import {makeShortSocketDir} from './lib/short-socket-dir.mjs';

const project=path.resolve(import.meta.dirname,'..');
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('actual listener fence redirects connectors, cuts TCP/WS, fences external INPUT and preserves root/neighbor/remote',async t=>{
  assert.notEqual(process.getuid(),0,'Test launcher expects the unprivileged host user.');
  const root=fs.mkdtempSync(path.join(project,'.artifacts/listener-fence-kernel-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const writable=path.join(root,'writable');fs.mkdirSync(writable,{mode:0o700});
  const sentinel=path.join(root,'host-sentinel');fs.writeFileSync(sentinel,'unchanged',{mode:0o600});const before=sha(sentinel);
  let hostHttpConnections=0,hostUnixConnections=0;
  const hostHttp=http.createServer((_req,res)=>res.end('HOST'));hostHttp.on('connection',()=>hostHttpConnections++);
  const hostUnix=net.createServer(socket=>{hostUnixConnections++;socket.end();});
  t.after(async()=>{await new Promise(resolve=>hostHttp.close(()=>resolve()));await new Promise(resolve=>hostUnix.close(()=>resolve()));});
  const socketRoot=makeShortSocketDir('ffl-','host.sock');t.after(()=>fs.rmSync(socketRoot,{recursive:true,force:true}));
  const socketPath=path.join(socketRoot,'host.sock');
  const listen=(server,...args)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(...args,resolve);});
  await listen(hostHttp,0,'127.0.0.1');await listen(hostUnix,socketPath);
  assert.equal(await(await fetch('http://127.0.0.1:'+hostHttp.address().port)).text(),'HOST');
  await new Promise((resolve,reject)=>{const socket=net.createConnection(socketPath);socket.on('close',resolve);socket.on('error',reject);});
  assert.equal(hostHttpConnections,1);assert.equal(hostUnixConnections,1);hostHttpConnections=0;hostUnixConnections=0;
  const launcher=path.join(writable,'isolate');
  const source=path.join(project,'scripts/fixtures/first-forward-listener-net-admin-isolation.c');
  const build=spawnSync('/usr/bin/cc',['-Wall','-Wextra','-Werror',`-DNASSAJ_TEST_HOST_UID=${process.getuid()}`,source,'-o',launcher],{encoding:'utf8',env:{...process.env,TMPDIR:writable}});
  assert.equal(build.status,0,build.stderr);
  const fixture=path.join(project,'scripts/fixtures/first-forward-listener-fence.mjs');
  const boundFiles=[source,fixture,import.meta.filename,path.join(project,'scripts/lib/release-runtime-listener-boundary.mjs')];
  const sourceBindings=boundFiles.map(file=>({path:path.relative(project,file),sha256:sha(file)}));
  const evidence=[];const hostNetworkNamespace=fs.readlinkSync('/proc/self/ns/net');
  for(const uid of [0,1000,1001]) {
    const args=['--user',`--map-user=${uid}`,`--map-group=${uid}`,'--mount','--net','--pid','--keep-caps','--fork','--kill-child',launcher,fs.readlinkSync('/proc/self/ns/mnt'),writable,process.execPath,fixture,'orchestrate',launcher,hostNetworkNamespace,sentinel,String(hostHttp.address().port),socketPath];
    const result=await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/unshare',args,{stdio:['pipe','pipe','pipe'],timeout:15000});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.once('error',reject);child.once('close',(status,signal)=>resolve({status,signal,stdout,stderr}));});
    assert.equal(result.status,0,JSON.stringify({uid,...result}));evidence.push(JSON.parse(result.stdout));
  }
  assert.equal(sha(sentinel),before);assert.equal(hostHttpConnections,0);assert.equal(hostUnixConnections,0);
  assert.equal(fs.readlinkSync('/proc/self/ns/net'),hostNetworkNamespace);
  for(const binding of sourceBindings)assert.equal(sha(path.join(project,binding.path)),binding.sha256,'tested source changed during run');
  fs.writeFileSync(path.join(project,'.artifacts/first-forward-listener-fence-kernel-result.json'),JSON.stringify({measuredAt:new Date().toISOString(),separateUidRuns:true,sourceBindings,hostSentinels:{httpConnections:hostHttpConnections,unixConnections:hostUnixConnections,fileUnchanged:true,namespaceUnchanged:true},evidence},null,2)+'\n',{mode:0o600});
});
