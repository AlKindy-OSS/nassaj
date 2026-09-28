import test from 'node:test';
import assert from 'node:assert/strict';
import { installCodexImageOnlyTestFixture } from './lib/codex-image-only-test-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { digest, measuredFile, measuredTree, measuredOperatingSystem, validateLocalBuildOptions,
    readBuildPlan, verifyWorkspaceInputs, verifyOidBuildSource, measuredBuildControls, CONTROL_ENV,
    planLocalForwardBuild, prepareLocalForwardWorkspace, verifyBuildDependencyLock, verifySourceGitlinks,
    BUILD_IN_PROGRESS_MARKER } from './lib/release-build-workspace.mjs';
import { materializePreviewSnapshot } from './preview-oid-pipeline.mjs';
import { measureLocalForwardOutput } from './build-local-forward-artifacts.mjs';
import { collectUpdateRuntimeClosure } from './lib/update-runtime-bundle.mjs';

const ROOT = path.resolve(import.meta.dirname,'..');
function write(file,bytes) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,bytes,{mode:0o644}); }

test('fixture files stay non-writable to the group with a permissive umask', t=>{
    const root=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-umask-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const previous=process.umask(0o002),file=path.join(root,'fixture.json');
    try { write(file,'fixture'); }
    finally { process.umask(previous); }
    assert.equal(fs.statSync(file).mode&0o777,0o644);
});
test('default and GitHub build profiles refuse before any path lookup or copy',()=>{
    for (const input of [{},{kind:'github-release/v1',profile:'default'},
        {kind:'owner-reviewed-local-build/v1',profile:'default'}]) {
        assert.throws(()=>validateLocalBuildOptions({...input,repoRoot:'/nonexistent'}),/build_local_forward_only/);
    }
    const result=spawnSync(process.execPath,[path.join(ROOT,'scripts/build-local-forward-artifacts.mjs'),'plan',
        '--kind','owner-reviewed-local-build/v1','--profile','default','--repo','/missing','--oid','a'.repeat(40),
        '--output','/missing','--plan','/missing','--sdk-manifest','/missing','--sdk-sha256','a'.repeat(64)],{encoding:'utf8',env:CONTROL_ENV});
    assert.equal(result.status,1);assert.match(result.stderr,/build_local_forward_only/);assert.doesNotMatch(result.stderr,/ENOENT/);
});
test('dependency inventory refuses escaping links without changing their source', t=>{
    const root=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-inventory-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    write(path.join(root,'input'),'unchanged');fs.symlinkSync('/usr/bin/node',path.join(root,'escape'));
    const before=measuredFile(path.join(root,'input'));
    assert.throws(()=>measuredTree(root,true),/build_input_link/);
    assert.deepEqual(measuredFile(path.join(root,'input')),before);
});

test('actual namespace confines TS Vite and child Node while all source input bytes stay unchanged', {timeout:60000}, t=>{
    const scratch=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-kernel-'));
    t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
    const root=path.join(scratch,'root');fs.mkdirSync(root,{mode:0o700});
    const launcher=path.join(scratch,'isolate');
    const compiled=spawnSync('/usr/bin/cc',['-Wall','-Wextra','-Werror','-O2',path.join(ROOT,'scripts/lib/release-build-isolation.c'),'-o',launcher],{encoding:'utf8',env:{...CONTROL_ENV,TMPDIR:scratch}});
    assert.equal(compiled.status,0,compiled.stderr);
    for(const file of measuredOperatingSystem()) {
        const target=path.join(root,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.copyFileSync(file.canonical,target);fs.chmodSync(target,file.mode);
    }
    const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
    // Actual installed tool bytes are isolated copies; no compilation or import on the host.
    fs.cpSync(path.join(ROOT,'node_modules'),path.join(workspace,'node_modules'),{recursive:true,verbatimSymlinks:true});
    write(path.join(workspace,'package.json'),'{"type":"module"}');
    write(path.join(workspace,'tsconfig.json'),'{"compilerOptions":{"noEmit":true,"skipLibCheck":true,"types":[]},"files":["input.ts"]}');
    write(path.join(workspace,'input.ts'),'declare const __BUILD_ID__: string; (globalThis as any).fixture=__BUILD_ID__; const proof: number = 42;\n');
    write(path.join(workspace,'index.html'),'<script type="module" src="/input.ts"></script>');
    write(path.join(workspace,'vite.config.mjs'),"export default {build:{outDir:'/output/client',emptyOutDir:true}};\n");
    write(path.join(workspace,'vite.config.js'),`export default {build:{outDir:process.env.NASSAJ_CLIENT_OUT_DIR,emptyOutDir:true},
define:{__BUILD_ID__:JSON.stringify(process.env.NASSAJ_BUILD_ID)},plugins:[{name:'fixture-version',generateBundle(){this.emitFile({type:'asset',fileName:'version.json',source:JSON.stringify({buildId:process.env.NASSAJ_BUILD_ID})});}}]};`);
    const clientClosure = collectUpdateRuntimeClosure(ROOT, ['scripts/client-build-atomic.mjs']);
    for (const required of ['client-publication-artifacts.mjs', 'client-publication-lineage.mjs', 'node-update-mode.mjs'])
        assert.ok(clientClosure.includes(`scripts/lib/${required}`));
    for (const file of clientClosure)
        write(path.join(workspace, file), fs.readFileSync(path.join(ROOT, file)));
    const hostPaths = { sourceRoot: fs.realpathSync(ROOT), home: fs.realpathSync(homedir()),
        typescript: fs.realpathSync(path.join(ROOT, 'node_modules/typescript/lib/typescript.js')) };
    for (const file of Object.values(hostPaths)) assert.equal(fs.existsSync(file), true);
    write(path.join(workspace, 'host-input-paths.json'), JSON.stringify(hostPaths));
    const entry=path.join(workspace,'scripts/build-local-forward-artifacts.mjs');
    write(entry, String.raw`
import fs from 'node:fs';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
assert.equal(process.pid,1);assert.match(fs.readFileSync('/proc/self/status','utf8'),/^NoNewPrivs:\s+1$/m);
assert.throws(()=>fs.writeFileSync('/workspace/input.ts','changed'),/EROFS|EBUSY/);
assert.throws(()=>fs.unlinkSync('/workspace/input.ts'),/EROFS|EBUSY/);
assert.throws(()=>fs.writeFileSync('/workspace/node_modules/typescript/lib/typescript.js','changed'),/EROFS/);
const hostPaths=JSON.parse(fs.readFileSync('/workspace/host-input-paths.json','utf8'));
assert.equal(fs.existsSync(hostPaths.sourceRoot),false);
assert.equal(fs.existsSync('/usr/share/nodejs'),false);assert.equal(fs.existsSync('/usr/lib/node_modules'),false);
assert.equal(spawnSync('git',['--version']).error?.code,'ENOENT');
const child=spawnSync(process.execPath,['--input-type=module','-e',"import fs from 'node:fs';import {pathToFileURL} from 'node:url';const hostPaths=JSON.parse(process.argv[1]);if(fs.existsSync(hostPaths.home)||fs.existsSync('/usr/share/nodejs'))process.exit(20);try{await import(pathToFileURL(hostPaths.typescript).href);process.exit(21)}catch{}",JSON.stringify(hostPaths)],{encoding:'utf8'});
assert.equal(child.status,0,child.stderr);
const {createServer}=await import('node:http');const server=createServer((_request,response)=>response.end('private-smoke'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{const response=await fetch('http://127.0.0.1:'+server.address().port,{signal:AbortSignal.timeout(2000)});assert.equal(await response.text(),'private-smoke');}
finally{await new Promise(resolve=>server.close(resolve));}
const {buildClientReleaseCandidate}=await import('/workspace/scripts/client-build-atomic.mjs');
const candidate='/workspace/.local-forward-candidate';fs.mkdirSync(candidate);
const built=await buildClientReleaseCandidate({sourceRoot:'/workspace',candidateRoot:candidate,outputRoot:candidate+'/client',releaseCommit:'a'.repeat(40),version:'1.2.3.4',publicVite:{}});
assert.equal(fs.existsSync(built.outputRoot+'/index.html'),true);
assert.equal(JSON.parse(fs.readFileSync(built.outputRoot+'/BUILD_PROVENANCE.json')).buildId,built.buildId);
fs.writeFileSync('/output/proof.json',JSON.stringify({ts:true,vite:true,childBoundary:true,gitAbsent:true,actualClientCandidate:true,privateHttp:true}));
`);
    for(const directory of ['output','scratch/home','scratch/tmp','proc','dev'])fs.mkdirSync(path.join(root,directory),{recursive:true});
    for(const device of ['null','zero','random','urandom'])write(path.join(root,'dev',device),'');
    const before=digest(fs.readFileSync(path.join(workspace,'input.ts'))), original=digest(fs.readFileSync(path.join(ROOT,'node_modules/typescript/lib/typescript.js')));
    const raceSource=path.join(scratch,'race.c'),raceLauncher=path.join(scratch,'race-isolate');
    write(raceSource,`#define _GNU_SOURCE
#include <sys/syscall.h>
#include <sys/mount.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#ifndef SWAP_LEAF
#define SWAP_LEAF 0
#endif
int fixture_mount(const char *s,const char *t,const char *type,unsigned long flags,const void *data) {
static int done;char moved[8192],actual[4096];
if(!done && (flags==MS_BIND || (type && !strcmp(type,"proc")))){ssize_t length=readlink(t,actual,sizeof(actual)-1);if(length<0)return -1;actual[length]=0;
if((SWAP_LEAF==1 && !strstr(actual,"/dev/null")) || (SWAP_LEAF==2 && strcmp(actual+strlen(actual)-5,"/proc")))return syscall(SYS_mount,s,t,type,flags,data);
done=1;snprintf(moved,sizeof(moved),"%s.moved",actual);if(rename(actual,moved)||symlink(moved,actual))return -1;}
return syscall(SYS_mount,s,t,type,flags,data);
}`);
    const raceCompile=spawnSync('/usr/bin/cc',['-Wall','-Wextra','-Werror','-Dmount=fixture_mount',path.join(ROOT,'scripts/lib/release-build-isolation.c'),raceSource,'-o',raceLauncher],
        {encoding:'utf8',env:{...CONTROL_ENV,TMPDIR:scratch}});
    assert.equal(raceCompile.status,0,raceCompile.stderr);
    const race=spawnSync('/usr/bin/unshare',['--user','--map-current-user','--mount','--net','--pid','--keep-caps','--fork','--kill-child',
        raceLauncher,fs.readlinkSync('/proc/self/ns/mnt'),root,'fixture','probe'],{encoding:'utf8',timeout:5000,env:CONTROL_ENV});
    assert.equal(race.status,78,race.stderr);assert.match(race.stderr,/build_mount_target_changed/);
    assert.equal(fs.existsSync(path.join(root,'output/proof.json')),false);
    fs.unlinkSync(root);fs.renameSync(root+'.moved',root);
    for(const [kind,relative]of [[1,'dev/null'],[2,'proc']]) {
        const compiledLeaf=spawnSync('/usr/bin/cc',['-Wall','-Wextra','-Werror','-Dmount=fixture_mount',`-DSWAP_LEAF=${kind}`,
            path.join(ROOT,'scripts/lib/release-build-isolation.c'),raceSource,'-o',raceLauncher],{encoding:'utf8',env:{...CONTROL_ENV,TMPDIR:scratch}});
        assert.equal(compiledLeaf.status,0,compiledLeaf.stderr);
        const raced=spawnSync('/usr/bin/unshare',['--user','--map-current-user','--mount','--net','--pid','--keep-caps','--fork','--kill-child',
            raceLauncher,fs.readlinkSync('/proc/self/ns/mnt'),root,'fixture','probe'],{encoding:'utf8',timeout:5000,env:CONTROL_ENV});
        assert.equal(raced.status,78,raced.stderr);assert.match(raced.stderr,/build_device_target_identity|build_private_proc_identity/);
        assert.equal(fs.existsSync(path.join(root,'output/proof.json')),false);
        const target=path.join(root,relative);fs.unlinkSync(target);fs.renameSync(target+'.moved',target);
    }
    const result=spawnSync('/usr/bin/unshare',['--user','--map-current-user','--mount','--net','--pid','--keep-caps','--fork','--kill-child',
        launcher,fs.readlinkSync('/proc/self/ns/mnt'),root,'fixture','probe'],{encoding:'utf8',timeout:45000,maxBuffer:1024*1024,
        env:{PATH:'/usr/bin:/bin',HOME:'/scratch/home',TMPDIR:'/scratch/tmp',NODE_ENV:'production',LANG:'C',LC_ALL:'C'}});
    assert.equal(digest(fs.readFileSync(path.join(workspace,'input.ts'))),before);
    assert.equal(digest(fs.readFileSync(path.join(ROOT,'node_modules/typescript/lib/typescript.js'))),original);
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'output/proof.json'))),{ts:true,vite:true,childBoundary:true,gitAbsent:true,actualClientCandidate:true,privateHttp:true});
});

test('reviewed plan reads the measured FD and refuses a pathname swap before parse',t=>{
    const root=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-plan-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const file=path.join(root,'plan.json'),bytes=JSON.stringify({kind:'original'});write(file,bytes);
    assert.deepEqual(readBuildPlan(file,digest(bytes)),{kind:'original'});
    const read=fs.readSync;let changed=false;
    t.mock.method(fs,'readSync',(...args)=>{const count=read(...args);if(!changed){changed=true;fs.renameSync(file,file+'.old');write(file,'{"kind":"changed"}');}return count;});
    assert.throws(()=>readBuildPlan(file,digest(bytes)),/build_plan_changed/);
});

test('exact copy inventory refuses extra source dependency and OS bytes before entry execution',t=>{
    const root=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-exact-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const source=path.join(root,'workspace/source.js'),dependency=path.join(root,'workspace/node_modules/pkg/index.js'),os=path.join(root,'usr/bin/node');
    for(const file of [source,dependency,os])write(file,'same');
    const plan={kind:'owner-reviewed-local-build/v1',profile:'local-forward-349/v2',
        source:[{path:'source.js',...measuredFile(source)}],dependencies:[{path:'pkg/index.js',...measuredFile(dependency)}],os:[{path:'/usr/bin/node',...measuredFile(os)}]};
    verifyWorkspaceInputs(plan,root);
    const candidate=path.join(root,'workspace/.local-forward-candidate');fs.mkdirSync(candidate);
    assert.throws(()=>verifyWorkspaceInputs(plan,root),/build_source_candidate_collision/);
    for(const name of ['client','server'])fs.mkdirSync(path.join(candidate,name));
    verifyWorkspaceInputs(plan,root,'candidate');
    write(path.join(candidate,'unexpected'),'no');assert.throws(()=>verifyWorkspaceInputs(plan,root,'candidate'),/build_candidate_layout/);
    fs.rmSync(candidate,{recursive:true});
    for(const relative of ['workspace/extra.js','workspace/node_modules/extra/index.js','usr/share/nodejs/extra.js']) {
        const extra=path.join(root,relative);write(extra,'shadow');
        assert.throws(()=>verifyWorkspaceInputs(plan,root),/build_copy_extra_or_missing|build_os_extra_or_missing/);
        fs.rmSync(extra);
        for(let directory=path.dirname(extra);directory!==root&&fs.readdirSync(directory).length===0;directory=path.dirname(directory))fs.rmdirSync(directory);
        assert.equal(fs.readFileSync(source,'utf8'),'same');
    }
    write(os,'evil');assert.throws(()=>verifyWorkspaceInputs(plan,root),/build_os_changed/);
});

test('handoff archive and manifest pins contain exactly path size sha256',t=>{
    const root=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-handoff-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const target=path.join(root,'output/file');write(target,'reviewed');
    assert.deepEqual(measureLocalForwardOutput(root,'/output/file'),{path:target,size:8,sha256:digest('reviewed')});
    fs.symlinkSync(target,path.join(root,'output/link'));assert.throws(()=>measureLocalForwardOutput(root,'/output/link'),/build_output_path/);
});

test('Git source verification ignores inherited repository and replacement authorities',t=>{
    const root=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-git-'));t.after(()=>{spawnSync('/usr/bin/chmod',['-R','u+w',root]);fs.rmSync(root,{recursive:true,force:true});});
    const git=(args)=>{const r=spawnSync('/usr/bin/git',args,{cwd:root,encoding:'utf8',env:{...CONTROL_ENV,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@invalid',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@invalid'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
    git(['init','-q']);write(path.join(root,'input'),'original');git(['add','input']);git(['commit','-qm','first']);const oid=git(['rev-parse','HEAD']);
    write(path.join(root,'input'),'replacement');git(['add','input']);git(['commit','-qm','second']);const other=git(['rev-parse','HEAD']);
    git(['replace',oid,other]);const source=path.join(root,'source');write(path.join(source,'input'),'original');fs.chmodSync(path.join(source,'input'),0o444);fs.chmodSync(source,0o555);
    const inherited={GIT_DIR:process.env.GIT_DIR,GIT_WORK_TREE:process.env.GIT_WORK_TREE};process.env.GIT_DIR='/untrusted';process.env.GIT_WORK_TREE='/untrusted';
    try {verifyOidBuildSource(root,source,oid,measuredTree(source));}
    finally {for(const [key,value]of Object.entries(inherited)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
    fs.chmodSync(path.join(source,'input'),0o644);write(path.join(source,'input'),'replacement');fs.chmodSync(path.join(source,'input'),0o444);
    assert.throws(()=>verifyOidBuildSource(root,source,oid,measuredTree(source)),/build_source_oid_mismatch/);
});

test('compiler control inventory uses closed environment and pins actual compiler headers and ELF dependencies',()=>{
    const old=process.env.COMPILER_PATH;process.env.COMPILER_PATH='/untrusted';
    try {
        const controls=measuredBuildControls(path.join(ROOT,'scripts/lib/release-build-isolation.c'));
        for(const suffix of ['/cc1','/collect2','/usr/bin/as','/usr/bin/ld','/usr/bin/unshare','/usr/include/stdio.h'])
            assert.ok(controls.some(row=>row.path.endsWith(suffix)),suffix);
        assert.ok(controls.every(row=>/^[a-f0-9]{64}$/.test(row.sha256)));
    } finally {if(old===undefined)delete process.env.COMPILER_PATH;else process.env.COMPILER_PATH=old;}
});

test('actual Git materializer feeds measured plan and workspace copy; stale source SDK and OS pins reject before output',async t=>{
    const root=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-plan-roundtrip-'));
    t.after(()=>{spawnSync('/usr/bin/chmod',['-R','u+w',root]);fs.rmSync(root,{recursive:true,force:true});});
    const git=args=>{const r=spawnSync('/usr/bin/git',args,{cwd:root,encoding:'utf8',env:{...CONTROL_ENV,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@invalid',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@invalid'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
    write(path.join(root,'package.json'),'{"version":"1.2.3.4"}');
    write(path.join(root,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{},'node_modules/@openai/codex-sdk':{version:'0.153.2',integrity:'sha512-YQ=='}}}));
    write(path.join(root,'scripts/lib/release-build-isolation.c'),fs.readFileSync(path.join(ROOT,'scripts/lib/release-build-isolation.c')));
    git(['init','-q']);git(['add','package.json','package-lock.json','scripts/lib/release-build-isolation.c']);git(['update-index','--add','--cacheinfo','160000,4895cd3fd33362471e739b786493aba048487bcc,plugins/starter']);git(['commit','-qm','fixture']);const oid=git(['rev-parse','HEAD']);
    await materializePreviewSnapshot(root,oid);fs.mkdirSync(path.join(root,'.artifacts'));
    const sdk=path.join(root,'node_modules/@openai/codex-sdk');installCodexImageOnlyTestFixture(root);
    for(let i=0;i<15;i++)write(path.join(sdk,`fixture-${i}.js`),'fixture reference only');
    const records=measuredTree(path.join(root,'node_modules')).map(file=>({path:file.path,size:file.size,sha256:file.sha256}));
    const reference=path.join(root,'.artifacts/sdk.json');write(reference,JSON.stringify({schema:'b890-isolated-measurement-dependencies/v1',records}));
    const options={kind:'owner-reviewed-local-build/v1',profile:'local-forward-349/v2',repoRoot:root,oid,
        outputRoot:path.join(root,'.artifacts',`local-forward-build-${oid}`),sdkReference:{path:reference,sha256:digest(fs.readFileSync(reference))}};
    const plan=planLocalForwardBuild(options),sourceBefore=measuredTree(plan.sourceRoot);
    const stale=structuredClone(plan);stale.os[0].sha256='a'.repeat(64);
    assert.throws(()=>prepareLocalForwardWorkspace(stale),/build_reviewed_input_drift/);assert.equal(fs.existsSync(options.outputRoot),false);
    const sdkFile=path.join(sdk,'fixture-0.js');write(sdkFile,'drift');
    assert.throws(()=>prepareLocalForwardWorkspace(plan),/build_sdk_mismatch/);assert.equal(fs.existsSync(options.outputRoot),false);write(sdkFile,'fixture reference only');
    fs.chmodSync(plan.sourceRoot,0o755);fs.mkdirSync(path.join(plan.sourceRoot,'extra-empty'),{mode:0o555});fs.chmodSync(plan.sourceRoot,0o555);
    assert.throws(()=>planLocalForwardBuild(options),/build_source_extra_directory/);
    fs.chmodSync(plan.sourceRoot,0o755);fs.rmdirSync(path.join(plan.sourceRoot,'extra-empty'));fs.chmodSync(plan.sourceRoot,0o555);
    const prepared=prepareLocalForwardWorkspace(plan);verifyWorkspaceInputs(prepared.inputs,prepared.root);
    // T-1686: علامة «بناء جارٍ» موجودة ما دام المخرَج غير مكتمل (يحذفها المُنشئ عند النجاح).
    assert.equal(fs.existsSync(path.join(options.outputRoot,BUILD_IN_PROGRESS_MARKER)),true);
    assert.deepEqual(measuredTree(plan.sourceRoot),sourceBefore);
    assert.equal(digest(fs.readFileSync(path.join(prepared.root,'INPUT.json'))),prepared.sha256);
    assert.equal(plan.sourceGitlinks[0].materialization,'empty-directory');
    assert.equal(plan.sourceGitlinks[0].source.mode,0o555);
    assert.equal(prepared.inputs.copiedGitlinks[0].mode,0o755);
    assert.notEqual(plan.sourceGitlinks[0].source.ino,prepared.inputs.copiedGitlinks[0].ino);
    const wrongMaterialization=structuredClone(prepared.inputs);wrongMaterialization.sourceGitlinks[0].materialization='fetch';
    assert.throws(()=>verifyWorkspaceInputs(wrongMaterialization,prepared.root),/build_gitlink_copy_identity/);
    const copy=path.join(prepared.root,'workspace/plugins/starter');
    write(path.join(copy,'unexpected'),'reject');
    assert.throws(()=>verifyWorkspaceInputs(prepared.inputs,prepared.root),/build_gitlink/);
    fs.unlinkSync(path.join(copy,'unexpected'));
    fs.chmodSync(copy,0o700);
    assert.throws(()=>verifyWorkspaceInputs(prepared.inputs,prepared.root),/build_gitlink/);
    fs.chmodSync(copy,0o755);
    assert.throws(()=>verifyWorkspaceInputs(prepared.inputs,prepared.root),/build_gitlink_copy_identity/);
    const original=path.join(plan.sourceRoot,'plugins/starter');
    fs.chmodSync(original,0o755);
    assert.throws(()=>verifySourceGitlinks(plan),/build_gitlink/);

});

test('package roots use the final node_modules boundary while deeper manifests stay pinned',t=>{
    const root=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-package-boundary-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const packages=['plain','@scope/top','plain/node_modules/nested','plain/node_modules/@scope/nested'];
    const lock={packages:{}};
    for(const name of packages) {
        write(path.join(root,name,'package.json'),'{"version":"1.0.0"}');
        write(path.join(root,name,'dist/cjs/package.json'),'{"type":"commonjs"}');
        lock.packages[`node_modules/${name}`]={version:'1.0.0',integrity:'sha512-YQ=='};
    }
    const records=measuredTree(root);
    assert.equal(records.length,8);
    verifyBuildDependencyLock(root,lock,records);
    for(const name of packages) {
        const bad=structuredClone(lock);delete bad.packages[`node_modules/${name}`];
        assert.throws(()=>verifyBuildDependencyLock(root,bad,records),/build_unlocked_dependency/);
    }
    lock.packages['node_modules/plain'].version='2.0.0';
    assert.throws(()=>verifyBuildDependencyLock(root,lock,records),/build_dependency_lock/);
});

test('fixed Gitlink rejects alternate metadata and unsafe or nonempty placeholders',async t=>{
    const root=fs.mkdtempSync(path.join(ROOT,'.artifacts/b952-gitlinks-'));
    t.after(()=>{spawnSync('/usr/bin/chmod',['-R','u+w',root]);fs.rmSync(root,{recursive:true,force:true});});
    const git=args=>{const r=spawnSync('/usr/bin/git',args,{cwd:root,encoding:'utf8',env:{...CONTROL_ENV,GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@invalid',GIT_COMMITTER_NAME:'fixture',GIT_COMMITTER_EMAIL:'fixture@invalid'}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
    git(['init','-q']);write(path.join(root,'input'),'fixed');git(['add','input']);
    const fixed='4895cd3fd33362471e739b786493aba048487bcc';
    for(const [name,oid] of [['plugins/other',fixed],['plugins/starter','a'.repeat(40)],['plugins/starter',fixed]]) {
        git(['read-tree','--empty']);git(['add','input']);git(['update-index','--add','--cacheinfo',`160000,${oid},${name}`]);
        git(['commit','-qm',name+oid]);const commit=git(['rev-parse','HEAD']);
        const result=await materializePreviewSnapshot(root,commit);
        const source=path.join(root,'.nassaj-local-preview/oid-snapshots',commit);
        void result;
        if(name!=='plugins/starter'||oid!==fixed) {
            assert.throws(()=>verifyOidBuildSource(root,source,commit,measuredTree(source)),/build_git_type/);continue;
        }
        const links=verifyOidBuildSource(root,source,commit,measuredTree(source));
        assert.equal(links[0].materialization,'empty-directory');
        const placeholder=path.join(source,name);fs.chmodSync(placeholder,0o755);write(path.join(placeholder,'child'),'x');fs.chmodSync(placeholder,0o555);
        assert.throws(()=>verifyOidBuildSource(root,source,commit,measuredTree(source)),/build_gitlink/);
        fs.chmodSync(placeholder,0o755);fs.unlinkSync(path.join(placeholder,'child'));fs.chmodSync(path.dirname(placeholder),0o755);
        fs.rmdirSync(placeholder);fs.symlinkSync('../',placeholder);
        assert.throws(()=>verifyOidBuildSource(root,source,commit,[]),/build_gitlink/);
    }
    git(['read-tree','--empty']);git(['add','input']);const blob=git(['hash-object','input']);
    git(['update-index','--add','--cacheinfo',`100644,${blob},plugins/starter`]);git(['commit','-qm','wrong type']);
    const commit=git(['rev-parse','HEAD']);await materializePreviewSnapshot(root,commit);
    const source=path.join(root,'.nassaj-local-preview/oid-snapshots',commit);
    assert.throws(()=>verifyOidBuildSource(root,source,commit,measuredTree(source)),/build_git_type/);
});
