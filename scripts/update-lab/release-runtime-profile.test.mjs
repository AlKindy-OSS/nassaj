/** Namespace-only profile contract; never starts PM2, installs, or activates an update. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hashDependencyTreeV2} from '../lib/dependency-tree-identity-v2.mjs';
import {prepareBridgeWorkspace,runBridgeIsolated} from './bridge-rehearsal.mjs';

test('public fleet runtime profile preserves private paths and read-only interpreter mounts',()=>{
    const lab=prepareBridgeWorkspace(),entry=path.join(lab,'harness/release-profile.mjs');
    const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const hostNode=sha('/usr/bin/node'),hostMounts=fs.readFileSync('/proc/self/mountinfo','utf8');
    const publicRoot=path.join(lab,'../run-Mx3eDp/tooling/usr'),expectedNode=sha(path.join(publicRoot,'bin/node')),expectedNpm=hashDependencyTreeV2(path.join(publicRoot,'lib/node_modules/npm'));
    fs.copyFileSync(new URL('../lib/dependency-tree-identity-v2.mjs',import.meta.url),path.join(lab,'harness/dependency-tree-identity-v2.mjs'));
    fs.writeFileSync(entry,`import assert from 'node:assert/strict';import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';import {hashDependencyTreeV2} from './dependency-tree-identity-v2.mjs';
const lab=${JSON.stringify(lab)};
assert.equal(process.execPath,'/usr/bin/node');assert.equal(createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),${JSON.stringify(expectedNode)});
assert.equal(fs.realpathSync('/usr/bin/npm'),'/usr/lib/node_modules/npm/bin/npm-cli.js');assert.deepEqual(hashDependencyTreeV2('/usr/lib/node_modules/npm'),${JSON.stringify(expectedNpm)});
assert.equal(fs.existsSync(${JSON.stringify(path.resolve('data'))}),false);assert.equal(fs.existsSync(lab+'/node/app'),true);
assert.equal(process.pid,1);assert.notEqual(process.getuid(),0);assert.equal(process.version,'v24.17.0');
assert.equal(process.env.HOME,${JSON.stringify(process.env.HOME)});assert.equal(process.env.PM2_HOME,process.env.HOME+'/.pm2');
assert.equal(process.env.DATABASE_PATH,lab+'/node/data/auth.db');assert.equal(process.env.NASSAJ_UPDATE_LAB_ROOT,lab);assert.equal(process.env.TMPDIR,'/var/tmp');
const status=fs.readFileSync('/proc/self/status','utf8');for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(status,new RegExp('^'+key+':\\\\s+0+$','m'));assert.match(status,/^NoNewPrivs:\\s+1$/m);
for(const p of ['/usr/bin/node','/usr/lib/node_modules/npm/package.json'])assert.throws(()=>{const fd=fs.openSync(p,'r+');fs.closeSync(fd);});
assert.equal(fs.existsSync(process.env.HOME+'/.pm2/dump.pm2'),false);assert.equal(fs.existsSync('/put_old'),false);
fs.writeFileSync('/var/tmp/profile-proof','private');assert.equal(fs.readFileSync(lab+'/var-tmp/profile-proof','utf8'),'private');
const npm=spawnSync('/usr/bin/npm',['--version'],{encoding:'utf8'});assert.equal(npm.status,0,npm.stderr);assert.equal(npm.stdout.trim(),'12.0.2');
console.log(JSON.stringify({execPath:process.execPath,nodeSha256:${JSON.stringify(expectedNode)},npmTreeSha256:${JSON.stringify(expectedNpm.sha256)},node:process.version,npm:npm.stdout.trim(),pid:process.pid,uid:process.getuid(),capabilitiesZero:true,noNewPrivs:true,interpreterReadOnly:true,privatePaths:true}));`);
    const result=runBridgeIsolated(lab,entry,{privateDependencies:true,runtimeProfile:'fleet-public-24.17-npm12'});
    assert.equal(sha('/usr/bin/node'),hostNode);assert.equal(fs.readFileSync('/proc/self/mountinfo','utf8'),hostMounts);
    assert.equal(result.status,0,result.stderr);const proof=JSON.parse(result.stdout);
    fs.writeFileSync(path.join(lab,'release-profile-proof.json'),JSON.stringify(proof));
    assert.equal(proof.node,'v24.17.0');
});
