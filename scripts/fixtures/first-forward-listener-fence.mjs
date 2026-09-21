/** Actual nft/socket fixture, reachable only after the reviewed isolated launcher. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {buildListenerFenceRules} from '../lib/release-runtime-listener-boundary.mjs';

const [mode,launcher,hostNet,sentinel,hostPort,hostUnix]=process.argv.slice(2);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const capEvidence=()=>Object.fromEntries(['CapEff','CapPrm','CapInh','CapBnd','CapAmb'].map(key=>[key,new RegExp('^'+key+':\\s+(\\w+)$','m').exec(fs.readFileSync('/proc/self/status','utf8'))?.[1]]));
const status=fs.readFileSync('/proc/self/status','utf8');
assert.match(status,/^NoNewPrivs:\s+1$/m);
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),hostNet);
if(mode==='probe'||mode==='peer') {
  for(const key of ['CapEff','CapPrm','CapInh','CapAmb'])assert.match(status,new RegExp(`^${key}:\\s+0+$`,'m'));
  const request=(host,port)=>new Promise(resolve=>{
    const req=http.get({host,port,agent:false,timeout:1500},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));});
    req.on('timeout',()=>req.destroy(Error('probe_timeout')));req.on('error',error=>resolve({error:error.code||error.message}));
  });
  if(mode==='peer'){
    const remote=http.createServer((_req,res)=>res.end('REMOTE'));await new Promise(resolve=>remote.listen(3004,'10.203.0.2',resolve));
    const control=http.createServer(async(_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({external:await request('10.203.0.1',3004),caps:capEvidence(),networkNamespace:fs.readlinkSync('/proc/self/ns/net')}));});await new Promise(resolve=>control.listen(3006,'10.203.0.2',resolve));
  }else{
  let conntrackDenied=null;if(process.env.NASSAJ_TEST_CONNTRACK_BINARY){const result=spawnSync(process.env.NASSAJ_TEST_CONNTRACK_BINARY,['-D','-p','tcp','--orig-dst','127.0.0.1','--dport','3004'],{encoding:'utf8'});conntrackDenied={status:result.status,stdout:result.stdout,stderr:result.stderr};assert.notEqual(result.status,0);assert.doesNotMatch(result.stderr,/0 flow entries have been deleted/);assert.match(result.stderr,/CAP_NET_ADMIN|Operation not permitted/);}
  const values={uid:process.getuid(),caps:capEvidence(),conntrackDenied,remote:await request('10.203.0.2',3004),peer:await request('10.203.0.2',3006),ipv4:await request('127.0.0.1',3004),ipv6:await request('::1',3004),neighbor:await request('127.0.0.1',3005)};
  process.stdout.write(JSON.stringify(values)+'\n');}
} else if(mode==='established-ws'){
  for(const key of ['CapEff','CapPrm','CapInh','CapAmb'])assert.match(status,new RegExp(`^${key}:\\s+0+$`,'m'));
  const socket=new WebSocket('ws://127.0.0.1:3004/');let stage=0;let finished=false;
  const done=value=>{if(finished)return;finished=true;process.stdout.write(JSON.stringify(value)+'\n');socket.close();process.stdin.destroy();};
  socket.addEventListener('open',()=>socket.send('ping'));socket.addEventListener('message',()=>{if(stage===0){stage=1;process.stdout.write('READY\n');}else done({after:'APP'});});
  socket.addEventListener('error',()=>done({after:'blocked',error:'websocket_error'}));socket.addEventListener('close',()=>done({after:'blocked',error:'websocket_closed'}));
  process.stdin.once('data',()=>{stage=2;socket.send('ping');});setTimeout(()=>done({after:'timeout'}),5000).unref();
} else if(mode==='established') {
  for(const key of ['CapEff','CapPrm','CapInh','CapAmb'])assert.match(status,new RegExp(`^${key}:\\s+0+$`,'m'));
  const socket=net.createConnection({host:'127.0.0.1',port:3004});let body='';let stage=0;let finished=false;
  const done=value=>{if(finished)return;finished=true;process.stdout.write(JSON.stringify(value)+'\n');socket.destroy();process.stdin.destroy();};
  const request=()=>socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
  socket.on('connect',request);socket.on('data',chunk=>{body+=chunk;if(body.includes('APP')){body='';if(stage===0){stage=1;process.stdout.write('READY\n');}else done({after:'APP'});}});
  socket.on('error',error=>done({after:'blocked',error:error.code}));socket.on('close',()=>done({after:'blocked',error:'closed'}));
  process.stdin.once('data',()=>{stage=2;request();});setTimeout(()=>done({after:'timeout'}),5000).unref();
} else {
  assert.equal(mode,'orchestrate');assert.equal(process.pid,1);
  for(const key of ['CapEff','CapPrm','CapInh','CapBnd','CapAmb'])assert.match(status,new RegExp(`^${key}:\\s+0*1000$`,'m'));
  assert.throws(()=>fs.writeFileSync(sentinel,'changed'),error=>['EROFS','EACCES','EPERM'].includes(error.code));
  await assert.rejects(new Promise((resolve,reject)=>{const s=net.createConnection(hostUnix);s.on('connect',()=>{s.destroy();resolve();});s.on('error',reject);}),error=>error.code==='EPERM');
  await assert.rejects(fetch('http://127.0.0.1:'+hostPort),error=>error.cause?.code==='ECONNREFUSED');
  let conntrackEmpty=null;
  if(process.env.NASSAJ_TEST_CONNTRACK_BINARY){
    const file=process.env.NASSAJ_TEST_CONNTRACK_BINARY;const args=['-D','-p','tcp','--orig-dst','127.0.0.1','--dport','3004'];
    const result=spawnSync(file,args,{encoding:'utf8'});conntrackEmpty={file,sha256:hash(fs.readFileSync(file)),args,status:result.status,stdout:result.stdout,stderr:result.stderr};
    assert.equal(result.status,1,JSON.stringify(conntrackEmpty));assert.equal(result.stdout,'');assert.match(result.stderr,/0 flow entries have been deleted/);
  }
  const servers=[];
  const serve=async(host,port,code,body)=>{const server=http.createServer((_req,res)=>{res.writeHead(code,{'Content-Length':Buffer.byteLength(body)});res.end(body);});server.on('upgrade',(req,socket)=>{const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');socket.on('data',data=>{if((data[0]&15)===8)socket.end(Buffer.from([0x88,0]));else socket.write(Buffer.from([0x81,3,65,80,80]));});socket.on('error',()=>{});});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});servers.push(server);};
  await serve('127.0.0.1',3004,200,'APP');await serve('10.203.0.1',3004,200,'APP');await serve('::1',3004,200,'APP');await serve('127.0.0.1',3311,503,'MAINT');await serve('127.0.0.1',3005,200,'NEIGHBOR');
  const fixture=process.argv[1];const childArgs=kind=>['--drop-net-admin',process.execPath,fixture,kind,launcher,hostNet];
  const asyncProbe=()=>new Promise((resolve,reject)=>{const child=spawn(launcher,childArgs('probe'),{stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.once('error',reject);child.once('close',code=>{try{assert.equal(code,0,err);resolve(JSON.parse(out));}catch(e){reject(e);}});});
  for(let i=0;i<30;i++){try{await fetch('http://10.203.0.2:3006');break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  const baseline=await asyncProbe();assert.equal(baseline.remote.status,200);assert.equal(JSON.parse(baseline.peer.body).external.status,200);assert.equal(baseline.ipv4.status,200);assert.equal(baseline.ipv6.status,200);assert.equal(baseline.neighbor.status,200);
  const persistent=spawn(launcher,childArgs('established'),{stdio:['pipe','pipe','pipe']});let persistentErrors='';persistent.stderr.on('data',x=>persistentErrors+=x);
  const lines=readline.createInterface({input:persistent.stdout});const iterator=lines[Symbol.asyncIterator]();assert.equal((await iterator.next()).value,'READY');
  const ws=spawn(launcher,childArgs('established-ws'),{stdio:['pipe','pipe','pipe']});let wsErrors='';ws.stderr.on('data',x=>wsErrors+=x);const wsLines=readline.createInterface({input:ws.stdout});const wsIterator=wsLines[Symbol.asyncIterator]();assert.equal((await wsIterator.next()).value,'READY',wsErrors);
  const config={health:{privateUrl:'http://127.0.0.1:3004/health'},maintenance:{boundary:{mode:'local-origin-listener/v1',originHost:'127.0.0.1',originPort:3004},cloudflared:{originHost:'127.0.0.1',originPort:3004},responderPort:3311}};
  const rules=buildListenerFenceRules(config);
  // nft 1.0.9 resolves '-' to /dev/stdin, which rejects a pipe in this sandbox.
  const rulesFile=path.join(path.dirname(launcher),'listener-fence-rules.nft');
  try {
    fs.writeFileSync(rulesFile,rules,{flag:'wx',mode:0o600});
    assert.equal(fs.statSync(rulesFile).isFile(),true);
    const applied=spawnSync('/usr/sbin/nft',['-f',rulesFile],{encoding:'utf8'});assert.equal(applied.status,0,applied.stderr);
  } finally { fs.rmSync(rulesFile,{force:true}); }
  persistent.stdin.write('after-fence\n');const persistentResult=JSON.parse((await iterator.next()).value);lines.close();
  ws.stdin.write('after-fence\n');const wsResult=JSON.parse((await wsIterator.next()).value);wsLines.close();
  const closed=await asyncProbe();assert.equal(closed.neighbor.status,200);assert.equal(closed.remote.status,200);const peer=JSON.parse(closed.peer.body);assert.ok(peer.external.error);assert.notEqual(peer.networkNamespace,fs.readlinkSync('/proc/self/ns/net'));for(const key of ['CapEff','CapPrm','CapInh','CapAmb'])assert.match(peer.caps[key],/^0+$/);
  if(process.getuid()===0){assert.equal(closed.ipv4.status,200);assert.equal(closed.ipv6.status,200);assert.equal(persistentResult.after,'APP');assert.equal(wsResult.after,'APP');}
  else {assert.equal(closed.ipv4.status,503);assert.ok(closed.ipv6.error);assert.equal(persistentResult.after,'blocked',JSON.stringify(persistentResult));assert.equal(wsResult.after,'blocked');}
  const removed=spawnSync('/usr/sbin/nft',['delete','table','inet','nassaj_cutover'],{encoding:'utf8'});assert.equal(removed.status,0,removed.stderr);
  const reopened=await asyncProbe();assert.equal(JSON.parse(reopened.peer.body).external.status,200);assert.equal(reopened.ipv4.status,200);assert.equal(reopened.ipv6.status,200);
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  process.stdout.write(JSON.stringify({uid:process.getuid(),baseline,closed,persistentResult,wsResult,reopened,rulesSha256:hash(rules),hostFilesystemAndIpcDenied:true,networkNamespace:fs.readlinkSync('/proc/self/ns/net'),conntrackCliUsed:Boolean(conntrackEmpty),conntrackEmpty,coverage:'Separate UID run; local IPv4/IPv6, existing TCP/WebSocket, external veth INPUT, remote same-port and local neighbor.'})+'\n');
}
