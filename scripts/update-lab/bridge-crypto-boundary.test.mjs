import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {assertBridgeCryptoChildNamespace} from './bridge-data-fixture.mjs';
import {prepareBridgeWorkspace,runBridgeIsolated} from './bridge-rehearsal.mjs';
const program=lab=>`import fs from 'node:fs';import path from 'node:path';${assertBridgeCryptoChildNamespace.toString()};assertBridgeCryptoChildNamespace(${JSON.stringify(lab)});console.log('admitted');`;
test('host PID namespace and missing namespace proof refuse before database access',()=>{
    const lab=prepareBridgeWorkspace();
    for(const parent of ['',fs.readlinkSync('/proc/self/ns/pid')]){
        const child=spawnSync(process.execPath,['--input-type=module','-e',program(lab)],{cwd:lab,env:{...process.env,PM2_HOME:path.join(process.env.HOME,'.pm2'),NASSAJ_LAB_PARENT_PID_NS:parent},encoding:'utf8'});
        assert.notEqual(child.status,0);assert.match(child.stderr,/crypto_fixture_not_child/);assert.equal(child.stdout,'');
    }
});
test('isolated child admits only the exact lab cwd',()=>{
    const lab=prepareBridgeWorkspace(),entry=path.join(lab,'harness/crypto-boundary.mjs');
    fs.writeFileSync(entry,`import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const ok=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(program(lab))}],{cwd:${JSON.stringify(lab)},encoding:'utf8'});assert.equal(ok.status,0,ok.stderr);
const wrong=spawnSync(process.execPath,['--input-type=module','-e',${JSON.stringify(program(lab))}],{cwd:${JSON.stringify(lab+'/app')},encoding:'utf8'});assert.notEqual(wrong.status,0);assert.match(wrong.stderr,/crypto_fixture_not_child/);`);
    const result=runBridgeIsolated(lab,entry,{privateDependencies:true});assert.equal(result.status,0,result.stderr);
});
