import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const project=path.resolve(fileURLToPath(new URL('../../../',import.meta.url)));

/** Full fixture authority, application and HTTP verifier share one kernel isolation domain. */
test('compiled forward startup under reviewed filesystem and IPC isolation',t=>{
  const archiveInput=process.env.NASSAJ_FORWARD_COLD_INPUT || '';
  if(archiveInput) assert.equal(fs.realpathSync(archiveInput),archiveInput);
  // A clean checkout has no `.artifacts`; never depend on a previous run having created it.
  const artifacts=path.join(project,'.artifacts');fs.mkdirSync(artifacts,{recursive:true});
  const sandbox=fs.mkdtempSync(path.join(artifacts,'full-cold-isolation-'));
  t.after(()=>fs.rmSync(sandbox,{recursive:true,force:true}));
  const launcher=path.join(sandbox,'isolate');
  const compile=spawnSync('/usr/bin/cc',['-Wall','-Wextra','-Werror',path.join(project,'scripts/fixtures/cold-startup-mount-isolation.c'),'-o',launcher],{
    encoding:'utf8',env:{...process.env,TMPDIR:sandbox}});
  assert.equal(compile.status,0,compile.stderr);
  const entry=path.join(sandbox,'entry.mjs');
  const fixture=fileURLToPath(new URL('./__tests__/bootstrap-forward-runtime.fixture.mjs',import.meta.url));
  fs.writeFileSync(entry,`
    import fs from 'node:fs';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
    const expected=${JSON.stringify(sandbox)};
    assert.equal(process.cwd(),expected);assert.equal(process.pid,1);
    const status=fs.readFileSync('/proc/self/status','utf8');
    for(const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb']) assert.match(status,new RegExp('^'+field+':\\\\s+0+$','m'));
    assert.match(status,/^NoNewPrivs:\\s+1$/m);assert.match(status,/^Seccomp:\\s+2$/m);
    const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').trim().split('\\n').map(line=>{const p=line.split(' ');return{point:p[4],options:p[5]}});
    for(const mount of mounts)assert.equal(mount.options.split(',').includes('rw'),mount.point===expected);
    const namespaces=Object.fromEntries(['mnt','pid','net','user'].map(name=>[name,fs.readlinkSync('/proc/self/ns/'+name)]));
    assert.notEqual(namespaces.mnt,${JSON.stringify(fs.readlinkSync('/proc/self/ns/mnt'))});
    assert.notEqual(namespaces.net,${JSON.stringify(fs.readlinkSync('/proc/self/ns/net'))});
    process.env.NASSAJ_TEST_TMP=expected;
    fs.mkdirSync(expected+'/evidence');fs.writeFileSync(expected+'/evidence/isolation.json',JSON.stringify({status,mounts,namespaces},null,2));
    await import(pathToFileURL(${JSON.stringify(fixture)}));
  `);
  const childEnvironment={...process.env,TMPDIR:sandbox};delete childEnvironment.NODE_TEST_CONTEXT;
  const result=spawnSync('/usr/bin/unshare',['--user','--map-current-user','--mount','--net','--pid','--keep-caps','--fork','--kill-child',launcher,fs.readlinkSync('/proc/self/ns/mnt'),sandbox,process.execPath,entry,project,archiveInput],{
    encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,stdio:['pipe','pipe','pipe'],env:childEnvironment});
  fs.writeFileSync(path.join(project,'.artifacts','bootstrap-forward-runtime-child.log'),result.stdout+'\n'+result.stderr);
  if(fs.existsSync(path.join(sandbox,'evidence'))) for(const name of fs.readdirSync(path.join(sandbox,'evidence'))){
    fs.copyFileSync(path.join(sandbox,'evidence',name),path.join(project,'.artifacts','full-cold-'+name));
  }
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
});
