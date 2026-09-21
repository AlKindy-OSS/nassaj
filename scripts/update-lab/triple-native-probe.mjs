/** Re-run an unchanged artifact native probe against a private copy of sealed lab dependencies. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareBridgeWorkspace,runBridgeIsolated} from './bridge-rehearsal.mjs';
import {copyTree} from './triple-rehearsal.mjs';
import {hashDependencyTreeV2} from '../lib/dependency-tree-identity-v2.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Keep the original probe bytes and runtime checks; never manufacture its receipt. */
export function probePreparedTripleNative(sourceLab,{serverBuildId}={}) {
    const previous=fs.realpathSync(sourceLab);
    if(!previous.startsWith(path.join(root,'.artifacts/t1772-bridge-rehearsal/run-')))throw Error('private_lab_required');
    const meta=JSON.parse(fs.readFileSync(path.join(previous,'scenario.json')));
    const selectedBuild=serverBuildId||meta.bridge.serverBuildId;
    if(!/^[a-f0-9]{64}$/.test(selectedBuild))throw Error('exact_probe_artifact_required');
    const parent=path.join(previous,'app/.nassaj-local-preview/oid-builds',meta.targetOid);
    const nonces=fs.readdirSync(parent).filter(value=>/^[a-f0-9]{64}$/.test(value));
    if(nonces.length!==1)throw Error('exact_native_build_required');
    const source=path.join(parent,nonces[0],'node_modules'),identity=hashDependencyTreeV2(source,{requireSealed:true});
    const lab=prepareBridgeWorkspace(),dependencies=path.join(lab,'app/node_modules');
    copyTree(source,dependencies);
    if(JSON.stringify(hashDependencyTreeV2(dependencies,{requireSealed:true}))!==JSON.stringify(identity)
        || JSON.stringify(hashDependencyTreeV2(source,{requireSealed:true}))!==JSON.stringify(identity))throw Error('private_native_identity_changed');
    const git=spawnSync('/usr/bin/git',['init','--quiet',path.join(lab,'app')],{encoding:'utf8'});
    if(git.status!==0)throw Error('native_fixture_git_failed');
    const capsule=path.join(root,'.nassaj-local-preview/server-candidates',selectedBuild,'OID_CONTROL_CAPSULE.mjs');
    const bytes=fs.readFileSync(capsule);fs.writeFileSync(path.join(lab,'harness/capsule.mjs'),bytes);
    const literal=name=>{
        const marker=`var ${name} = \``,start=bytes.toString().indexOf(marker);
        if(start<0)throw Error('fixed_native_literal_missing');
        const value=bytes.toString().slice(start+marker.length).split('`')[0];
        if(value.includes('\\')||value.includes('${'))throw Error('fixed_native_literal_requires_parser');
        return value;
    };
    const program=literal('OID_NATIVE_PROBE_PROGRAM'),namespace=literal('OID_NATIVE_PROBE_NAMESPACE');
    const installRuntime={nodeVersion:process.version,nodeModuleAbi:process.versions.modules,napi:process.versions.napi,
        platform:process.platform,arch:process.arch,nodeBinarySha256:sha(fs.readFileSync(process.execPath))};
    const expected={transactionNonce:nonces[0],nodeModulesTreeSha256:identity.sha256,installRuntime};
    const entry=path.join(lab,'harness/native-product-probe.mjs');
    fs.writeFileSync(entry,`import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';import {runOidTripleNativeProbe} from './capsule.mjs';
const check=()=>{const status=fs.readFileSync('/proc/self/status','utf8');for(const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.equal(status.split(String.fromCharCode(10)).find(line=>line.startsWith(key+':')).split(':')[1].trim(),'0000000000000000');assert.equal(status.split(String.fromCharCode(10)).find(line=>line.startsWith('NoNewPrivs:')).split(':')[1].trim(),'1');};
try{check();const proof=runOidTripleNativeProbe(${JSON.stringify(path.join(lab,'app'))},${JSON.stringify(dependencies)},${JSON.stringify(expected)});check();console.log(JSON.stringify({state:'native_product_probe_pass',outerCap0BeforeAndAfter:true,proof}));}catch(error){
const directory=${JSON.stringify(path.join(lab,'native-diagnostic-root'))};fs.mkdirSync(directory,{mode:0o700});
for(const name of ['usr','deps/node_modules','proc','dev','tmp',process.env.HOME.slice(1)])fs.mkdirSync(path.join(directory,name),{recursive:true,mode:0o700});
for(const name of ['lib','lib64','bin','sbin'])fs.symlinkSync(fs.readlinkSync('/'+name),path.join(directory,name));
for(const name of ['null','zero','random','urandom'])fs.writeFileSync(path.join(directory,'dev',name),'',{mode:0o600});
const diagnostic=spawnSync('/usr/bin/setpriv',['--pdeathsig=SIGKILL','/usr/bin/bash','-c','[ "$PPID" -eq "$1" ] || exit 97; shift; exec /usr/bin/unshare "$@"','oid-native-parent',String(process.pid),'--user','--map-root-user','--mount','--net','--pid','--fork','--kill-child=SIGKILL','/usr/bin/bash','-c',${JSON.stringify(namespace)},'oid-native-probe',directory,${JSON.stringify(dependencies)},${JSON.stringify(program)},process.env.HOME,process.execPath],{cwd:directory,env:{PATH:'/usr/bin:/usr/sbin',HOME:process.env.HOME,TMPDIR:'/tmp',LANG:'C.UTF-8'},encoding:'utf8',timeout:30000,killSignal:'SIGKILL'});
check();console.log(JSON.stringify({state:'failed',error:error.message,diagnosticOnly:{status:diagnostic.status,signal:diagnostic.signal,stderr:diagnostic.stderr,stdout:diagnostic.stdout}}));process.exitCode=1;}`);
    const result=runBridgeIsolated(lab,entry,{timeout:120000,privateDependencies:true});
    const report={lab,serverBuildId:selectedBuild,capsuleSha256:sha(bytes),dependencyIdentity:identity,status:result.status,stdout:result.stdout,stderr:result.stderr};
    fs.writeFileSync(path.join(lab,'native-product-probe-result.json'),JSON.stringify(report));
    return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    const report=probePreparedTripleNative(process.argv[2],{serverBuildId:process.argv[3]});console.log(JSON.stringify(report));if(report.status!==0)process.exitCode=1;
}
