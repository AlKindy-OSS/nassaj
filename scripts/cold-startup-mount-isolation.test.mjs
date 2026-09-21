import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import {makeShortSocketDir} from './lib/short-socket-dir.mjs';

const project=process.cwd();
const launcherSource=path.join(project,'scripts/fixtures/cold-startup-mount-isolation.c');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const metadata=file=>{const s=fs.statSync(file,{bigint:true});return {hash:hash(file),mode:String(s.mode),uid:String(s.uid),gid:String(s.gid),size:String(s.size),ino:String(s.ino),mtimeNs:String(s.mtimeNs),ctimeNs:String(s.ctimeNs)}};

test('private readonly namespace denies native host mutations and confines descendants to exact fixture', async t=>{
  const root=fs.mkdtempSync(path.join(project,'.artifacts','mount-negative-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const writable=path.join(root,'writable'); fs.mkdirSync(writable,{mode:0o700});
  const sentinel=path.join(root,'sentinel'); fs.writeFileSync(sentinel,'unchanged',{mode:0o600});
  const dbPath=path.join(root,'sentinel.sqlite'); const db=new Database(dbPath); db.exec('CREATE TABLE sentinel(value TEXT)'); db.prepare('INSERT INTO sentinel VALUES (?)').run('unchanged'); db.close();
  let hostHttpConnections=0,hostUnixConnections=0;
  const httpSentinel=http.createServer((_req,res)=>{res.end('host-sentinel')});
  httpSentinel.on('connection',()=>{hostHttpConnections++});
  const unixSentinel=net.createServer(socket=>{hostUnixConnections++;socket.end()});
  t.after(async()=>{await new Promise(resolve=>httpSentinel.close(()=>resolve()));await new Promise(resolve=>unixSentinel.close(()=>resolve()))});
  const ipcRoot=makeShortSocketDir('csmi-','outside.sock');
  t.after(()=>fs.rmSync(ipcRoot,{recursive:true,force:true}));
  const unixPath=path.join(ipcRoot,'outside.sock');
  const listen=(server,...args)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(...args,resolve)});
  await listen(httpSentinel,0,'127.0.0.1');
  await listen(unixSentinel,unixPath);
  const hostPort=httpSentinel.address().port;
  await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:hostPort,agent:false},response=>{response.resume();response.on('end',resolve)}).on('error',reject));
  await new Promise((resolve,reject)=>{const socket=net.createConnection(unixPath);socket.on('close',resolve);socket.on('error',reject)});
  assert.equal(hostHttpConnections,1);assert.equal(hostUnixConnections,1);
  hostHttpConnections=0;hostUnixConnections=0;
  const nativeSource=path.join(writable,'probe.c'),native=path.join(writable,'probe');
  fs.writeFileSync(nativeSource,`#define _GNU_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <sys/un.h>
#include <sys/syscall.h>
#include <linux/io_uring.h>
#include <string.h>
int main(int argc,char**argv){
 const char*p=argv[1]; struct stat s; if(stat(p,&s))return 80;
 int failed=0; errno=0;
 int unixfd=socket(AF_UNIX,SOCK_STREAM,0);if(unixfd!=-1||errno!=EPERM)return 82;
 unixfd=socket(AF_UNIX,SOCK_DGRAM,0);if(unixfd!=-1||errno!=EPERM)return 83;
 int pair[2];errno=0;if(socketpair(AF_UNIX,SOCK_DGRAM,0,pair)!=-1||errno!=EPERM)return 84;
 struct io_uring_params params={0};errno=0;if(syscall(SYS_io_uring_setup,2,&params)!=-1||errno!=EPERM)return 87;
 if(socketpair(AF_UNIX,SOCK_STREAM,0,pair))return 88;
 struct sockaddr_un local={.sun_family=AF_UNIX};if(strlen(argv[4])>=sizeof(local.sun_path))return 89;strcpy(local.sun_path,argv[4]);
 if(connect(pair[0],(struct sockaddr*)&local,sizeof(local))!=-1)return 90;close(pair[0]);close(pair[1]);
 int inetfd=socket(AF_INET,SOCK_STREAM,0);if(inetfd<0)return 85;
 struct sockaddr_in address={.sin_family=AF_INET,.sin_port=htons(atoi(argv[3]))};inet_pton(AF_INET,"127.0.0.1",&address.sin_addr);
 if(connect(inetfd,(struct sockaddr*)&address,sizeof(address))!=-1)return 86;close(inetfd);
 #define DENY(expr) do {errno=0;int r=(expr);if(r!=-1 || (errno!=EROFS && errno!=EACCES && errno!=EPERM)){fprintf(stderr,"not denied: %s errno=%d\\n",#expr,errno);failed=1;}}while(0)
 DENY(chmod(p,0644)); DENY(chown(p,s.st_uid,s.st_gid)); DENY(utimensat(AT_FDCWD,p,NULL,0));
 int readfd=open(p,O_RDONLY);if(readfd<0)return 81;
 DENY(fchmod(readfd,0644)); DENY(fchown(readfd,s.st_uid,s.st_gid)); DENY(futimens(readfd,NULL)); close(readfd);
 DENY(truncate(p,0)); DENY(rename(p,argv[2])); DENY(unlink(p));
 int fd=open(p,O_WRONLY|O_TRUNC);if(fd!=-1){close(fd);failed=1;}
 return failed;
}`);
  const build=spawnSync('/usr/bin/cc',[nativeSource,'-o',native],{encoding:'utf8',env:{...process.env,TMPDIR:writable}});assert.equal(build.status,0,build.stderr);
  const launcher=path.join(writable,'isolate');
  const buildLauncher=spawnSync('/usr/bin/cc',['-Wall','-Wextra','-Werror',launcherSource,'-o',launcher],{encoding:'utf8',env:{...process.env,TMPDIR:writable}});
  assert.equal(buildLauncher.status,0,buildLauncher.stderr);
  const probe=path.join(writable,'probe.mjs');
  fs.writeFileSync(probe,`import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import net from 'node:net';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';import Database from 'better-sqlite3';
const writable=${JSON.stringify(writable)},sentinel=${JSON.stringify(sentinel)},dbPath=${JSON.stringify(dbPath)};
const status=fs.readFileSync('/proc/self/status','utf8');
for(const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(status,new RegExp('^'+field+':\\\\s+0+$','m'));
assert.match(status,/^NoNewPrivs:\\s+1$/m);
const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n').map(line=>{const p=line.split(' ');return{point:p[4],options:p[5]}});
for(const m of mounts)if(m.point!==writable)assert.ok(m.options.split(',').includes('ro'),'writable mount outside fixture: '+JSON.stringify(m));
assert.ok(mounts.some(m=>m.point===writable&&m.options.split(',').includes('rw')));
assert.equal(fs.readlinkSync('/proc/self/ns/mnt')===${JSON.stringify(fs.readlinkSync('/proc/self/ns/mnt'))},false);
const descriptors=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try{return[{fd,target:fs.readlinkSync('/proc/self/fd/'+fd)}]}catch{return[]}});
assert.equal(process.pid,1);
for(const {target} of descriptors) assert.ok(target==='/dev/null'||['socket:','pipe:','anon_inode:'].some(prefix=>target.startsWith(prefix)),'unexpected inherited descriptor '+target);
const denied=fn=>assert.throws(fn,error=>['EROFS','EACCES','EPERM'].includes(error.code));
denied(()=>fs.writeFileSync(sentinel,'bad'));denied(()=>fs.chmodSync(sentinel,0o644));
await assert.rejects(fs.promises.writeFile(sentinel,'bad'),error=>['EROFS','EACCES','EPERM'].includes(error.code));
const handle=await fs.promises.open(sentinel,'r');
await assert.rejects(handle.chmod(0o644),error=>['EROFS','EACCES','EPERM'].includes(error.code)); await handle.close();
fs.symlinkSync(sentinel,path.join(writable,'outside-link'));denied(()=>fs.writeFileSync(path.join(writable,'outside-link'),'bad'));
assert.throws(()=>fs.linkSync(sentinel,path.join(writable,'outside-hardlink')),error=>['EXDEV','EROFS','EPERM'].includes(error.code));
fs.writeFileSync(path.join(writable,'positive'),'allowed');
const own=new Database(path.join(writable,'positive.sqlite'));own.exec('CREATE TABLE ok(value TEXT)');own.prepare('INSERT INTO ok VALUES (?)').run('allowed');own.close();
let sqliteDenied=false;try{const outside=new Database(dbPath);try{outside.prepare('INSERT INTO sentinel VALUES (?)').run('bad')}finally{outside.close()}}catch(error){sqliteDenied=/READONLY|CANTOPEN|IOERR/.test(error.code)}assert.ok(sqliteDenied);
const child=spawnSync(${JSON.stringify(native)},[sentinel,sentinel+'.renamed',${JSON.stringify(String(hostPort))},${JSON.stringify(unixPath)}],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
const shell=spawnSync('/bin/sh',['-c','printf bad > "$1"','probe',sentinel],{encoding:'utf8'});assert.notEqual(shell.status,0);
const descendant=spawnSync(process.execPath,['--input-type=module','-e','import fs from "node:fs";fs.chmodSync(process.argv[1],0o644)',sentinel],{encoding:'utf8'});assert.notEqual(descendant.status,0);
const remount=spawnSync('/usr/bin/unshare',['--user','--map-root-user','--mount','/usr/bin/mount','-o','remount,bind,rw','/','/'],{encoding:'utf8'});assert.notEqual(remount.status,0);
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'),${JSON.stringify(fs.readlinkSync('/proc/self/ns/net'))});
const unixDenied=()=>new Promise((resolve,reject)=>{const socket=net.createConnection(${JSON.stringify(unixPath)});socket.on('connect',()=>{socket.destroy();reject(Error('host_unix_connected'))});socket.on('error',error=>{assert.equal(error.code,'EPERM');resolve()})});
await unixDenied();
await assert.rejects(fetch('http://127.0.0.1:'+${JSON.stringify(hostPort)}),error=>error.cause?.code==='ECONNREFUSED');
const unixChild=spawnSync(process.execPath,['--input-type=module','-e', 'import net from "node:net";const s=net.createConnection(process.argv[1]);s.on("connect",()=>process.exit(90));s.on("error",e=>process.exit(e.code==="EPERM"?0:91))',${JSON.stringify(unixPath)}],{encoding:'utf8'});assert.equal(unixChild.status,0,unixChild.stderr);
const httpChild=spawnSync(process.execPath,['--input-type=module','-e','fetch(process.argv[1]).then(()=>process.exit(90),e=>process.exit(e.cause?.code==="ECONNREFUSED"?0:91))','http://127.0.0.1:'+${JSON.stringify(hostPort)}],{encoding:'utf8'});assert.equal(httpChild.status,0,httpChild.stderr);
const internal=http.createServer((_req,res)=>res.end('private-health'));await new Promise(resolve=>internal.listen(0,'127.0.0.1',resolve));assert.equal(await (await fetch('http://127.0.0.1:'+internal.address().port)).text(),'private-health');await new Promise(resolve=>internal.close(resolve));
const pipe=spawnSync('/bin/cat',[],{input:'direct-pipe',encoding:'utf8'});assert.equal(pipe.stdout,'direct-pipe');assert.equal(pipe.status,0);
process.stdout.write(JSON.stringify({networkNamespace:fs.readlinkSync('/proc/self/ns/net'),hostUnixDenied:true,hostHttpDenied:true,ioUringDenied:true,descendantIpcDenied:true,internalHttp:true,directPipes:true,remountDenied:true,mounts,status,descriptors,nativeDenied:true,sqliteDenied,positiveWrites:true}));
`);
  const before={sentinel:metadata(sentinel),database:metadata(dbPath)};
  const result=await new Promise((resolve,reject)=>{const child=spawn('/usr/bin/unshare',['--user','--map-current-user','--mount','--net','--pid','--keep-caps','--fork','--kill-child',launcher,fs.readlinkSync('/proc/self/ns/mnt'),writable,process.execPath,probe],{timeout:15000,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.once('error',reject);child.once('close',status=>resolve({status,stdout,stderr}));});
  assert.equal(result.status,0,result.stderr);
  assert.equal(hostHttpConnections,0);assert.equal(hostUnixConnections,0);
  const evidence=JSON.parse(result.stdout);evidence.hostSentinelConnections={http:hostHttpConnections,unix:hostUnixConnections};evidence.parentPositiveControls={http:1,unix:1};assert.deepEqual(metadata(sentinel),before.sentinel);assert.deepEqual(metadata(dbPath),before.database);
  assert.equal(fs.readFileSync(path.join(writable,'positive'),'utf8'),'allowed');
  const after={sentinel:metadata(sentinel),database:metadata(dbPath)};
  const sharedNetwork=spawnSync('/usr/bin/unshare',['--user','--map-current-user','--mount','--pid','--keep-caps','--fork','--kill-child',launcher,fs.readlinkSync('/proc/self/ns/mnt'),writable,process.execPath,probe],{encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']});
  assert.equal(sharedNetwork.status,78);assert.match(sharedNetwork.stderr,/network_namespace_not_owned_by_private_user_namespace/);assert.equal(sharedNetwork.stdout,'');
  evidence.sharedNetworkRejectedBeforeMount=true;
  fs.unlinkSync(path.join(writable,'outside-link'));
  fs.linkSync(sentinel,path.join(writable,'preexisting-hardlink'));
  const alias=spawnSync('/usr/bin/unshare',['--user','--map-current-user','--mount','--net','--pid','--keep-caps','--fork','--kill-child',launcher,fs.readlinkSync('/proc/self/ns/mnt'),writable,process.execPath,probe],{encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']});
  assert.equal(alias.status,78);assert.match(alias.stderr,/fixture_external_alias_or_special_file/);assert.equal(alias.stdout,'');
  fs.unlinkSync(path.join(writable,'preexisting-hardlink'));
  assert.equal(hash(sentinel),before.sentinel.hash);
  evidence.preexistingHardlinkRejectedBeforeMount=true;
  fs.writeFileSync(path.join(project,'.artifacts','cold-mount-isolation-evidence.json'),JSON.stringify({observedAt:new Date().toISOString(),evidence,before,after},null,2));
});
