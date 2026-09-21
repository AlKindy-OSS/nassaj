import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readColdArchiveRequest,verifyColdArchiveInput,restrictColdArchiveImports,coldGitEnvironment,assertColdGitFixture} from './__tests__/forward-cold-archive-input.mjs';
import {createBootstrapContextHarness} from '../../../scripts/fixtures/bootstrap-context-harness.mjs';

const project=path.resolve(import.meta.dirname,'../../..');
const pin=file=>({path:file,size:fs.statSync(file).size,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
function fixture(t){
    assert.ok(process.env.NASSAJ_TEST_TMP);
    const root=fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP,'cold-input-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
test('cold input reads exact bounded canonical JSON and rejects symlinks, links and writable modes',t=>{
    const root=fixture(t),file=path.join(root,'request.json');fs.writeFileSync(file,'{"external":true}',{mode:0o600});
    assert.deepEqual(readColdArchiveRequest(file),{external:true});
    fs.symlinkSync(file,file+'.symlink');assert.throws(()=>readColdArchiveRequest(file+'.symlink'));
    fs.linkSync(file,file+'.link');assert.throws(()=>readColdArchiveRequest(file));fs.unlinkSync(file+'.link');
    fs.chmodSync(file,0o666);assert.throws(()=>readColdArchiveRequest(file));fs.chmodSync(file,0o600);
    fs.writeFileSync(file,' '.repeat(65537));assert.throws(()=>readColdArchiveRequest(file));
});
test('cold archive rejects unknown authority, writable extraction, bad pins and detached/archive disagreement',t=>{
    const root=fixture(t),embedded=path.join(root,'RELEASE_ASSET_MANIFEST.json'),detached=path.join(root,'manifest.json'),archive=path.join(root,'fixture.tar.gz');
    const bytes=Buffer.from('{"files":[]}');fs.writeFileSync(embedded,bytes,{mode:0o644});fs.writeFileSync(detached,bytes,{mode:0o644});
    const tar=spawnSync('/usr/bin/tar',['--format=ustar','-czf',archive,'-C',root,'RELEASE_ASSET_MANIFEST.json'],{encoding:'utf8'});assert.equal(tar.status,0,tar.stderr);
    const input={archive:pin(archive),manifest:pin(detached),extractedRoot:project,expected:{kind:'owner-reviewed-local-build/v1',artifact:{},build:{}}};
    assert.throws(()=>verifyColdArchiveInput({...input,override:true}));
    assert.throws(()=>verifyColdArchiveInput({...input,extractedRoot:root}),/read-only/);
    assert.throws(()=>verifyColdArchiveInput({...input,archive:{...input.archive,sha256:'0'.repeat(64)}}));
    assert.throws(()=>verifyColdArchiveInput({...input,archive:{...input.archive,size:384*1024*1024+1}}));
    // Matching archive/detached inventories advance to the existing local-identity validator.
    assert.throws(()=>verifyColdArchiveInput(input),/Local build core identity/);
    fs.writeFileSync(detached,'{"files":[],"different":true}');
    assert.throws(()=>verifyColdArchiveInput({...input,manifest:pin(detached)}),/deep-equal/);
});
test('cold env fixture maps only the exact read target and refuses write flags',async t=>{
    const root=fixture(t),candidate=path.join(project,'scripts'),envFile=path.join(root,'fixture.env');
    fs.writeFileSync(envFile,'FIXTURE=measured',{mode:0o600});
    const f=createBootstrapContextHarness(t,{archiveBoundary:{root:candidate,envFile}});
    const result=await f.start(`import fs from 'node:fs';import assert from 'node:assert/strict';
        const target=${JSON.stringify(path.join(candidate,'.env'))};
        assert.equal(fs.readFileSync(target,'utf8'),'FIXTURE=measured');
        assert.throws(()=>fs.readFileSync(target,{flag:'w'}),/cold_env_write_denied/);
        assert.throws(()=>fs.openSync(target,'w'),/cold_env_write_denied/);
        assert.throws(()=>fs.openSync(target,fs.constants.O_RDWR),/cold_env_write_denied/);
        assert.throws(()=>fs.writeFileSync(target,'changed'),/EROFS|cold_env_write_denied/);
        assert.throws(()=>fs.readFileSync(target+'.other'),/ENOENT/);
    `).result;
    assert.equal(result.code,0,result.stderr);assert.equal(fs.readFileSync(envFile,'utf8'),'FIXTURE=measured');
});
test('cold dependency resolution admits archive-local and builtin imports but rejects ESM/CJS host fallbacks',async t=>{
    const root=fixture(t),candidate=path.join(root,'candidate');fs.mkdirSync(candidate);
    fs.writeFileSync(path.join(candidate,'package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(candidate,'local.mjs'),'export const value=1;');
    fs.writeFileSync(path.join(candidate,'good.mjs'),"import fs from 'node:fs';export {value} from './local.mjs';export const core=!!fs;");
    fs.writeFileSync(path.join(root,'outside.mjs'),'export default true;');
    fs.writeFileSync(path.join(candidate,'escape.mjs'),"import '../outside.mjs';");
    const hook=restrictColdArchiveImports(candidate);try{
        assert.equal((await import(pathToFileURL(path.join(candidate,'good.mjs')))).value,1);
        await assert.rejects(import(pathToFileURL(path.join(candidate,'escape.mjs'))),/cold_archive_dependency_escape/);
        assert.throws(()=>createRequire(path.join(candidate,'package.json'))('better-sqlite3'),/cold_archive_dependency_escape/);
    }finally{hook.deregister();}
});
test('cold Git fixture scrubs inherited authority and positively verifies worktree and common directory',t=>{
    const root=fixture(t),repo=path.join(root,'repo');fs.mkdirSync(repo);
    const inherited=process.env.GIT_COMMON_DIR;process.env.GIT_COMMON_DIR=path.join(project,'.git');
    try {
        const env=coldGitEnvironment(repo);assert.equal(env.GIT_COMMON_DIR,undefined);
        delete env.GIT_DIR;delete env.GIT_WORK_TREE;
        const init=spawnSync('/usr/bin/git',['init','-q',repo],{env,encoding:'utf8'});assert.equal(init.status,0,init.stderr);
        const verified=assertColdGitFixture(repo);assert.equal(verified.GIT_DIR,path.join(repo,'.git'));assert.equal(verified.GIT_WORK_TREE,repo);
        fs.writeFileSync(path.join(repo,'.git','commondir'),path.join(project,'.git'));
        assert.throws(()=>assertColdGitFixture(repo));
    }finally{if(inherited===undefined)delete process.env.GIT_COMMON_DIR;else process.env.GIT_COMMON_DIR=inherited;}
});
