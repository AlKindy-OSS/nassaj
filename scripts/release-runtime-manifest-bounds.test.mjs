import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import { RELEASE_ASSET_LIMITS, validateCompatibleForwardDatabaseContract } from './lib/update-release-asset.mjs';
import * as local from './lib/local-reviewed-build-identity.mjs';
import { createBootstrapContextHarness } from './fixtures/bootstrap-context-harness.mjs';
import { NATIVE_FILE_SYSTEM } from './fixtures/fixed-state-mutex-authority.mjs';
const project=path.resolve(import.meta.dirname,'..');
const read=name=>fs.readFileSync(path.join(project,name),'utf8');
const source={root:read('scripts/lib/release-runtime-startup-admission.mjs'),
    public:read('scripts/lib/release-runtime-public-descriptor.mjs'),
    producer:read('scripts/lib/prepare-first-forward-config.mjs'),bootstrap:read('server/bootstrap-startup-context.js')};
const fn=(text,name,next)=>text.slice(text.indexOf(`function ${name}(`),text.indexOf(`\nfunction ${next}(`));
const pieces={root:fn(source.root,'rootFile','writeRecord'),public:fn(source.public,'rootBytes','pinned'),
    producer:fn(source.producer,'readGenerationManifest','filePin'),bootstrap:fn(source.bootstrap,'readTargetManifestBytes','readRootFile')};
const maximum=RELEASE_ASSET_LIMITS.manifestBytes;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'
    ?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
function compile(kind,filesystem=fs,extra={}){
    const context={Buffer,path,fs:filesystem,...filesystem,...crypto,...local,RELEASE_ASSET_LIMITS,TARGET_MANIFEST_MAX_BYTES:maximum,
        validateCompatibleForwardDatabaseContract,digest:sha,canonical,equal:(a,b)=>canonical(a)===canonical(b),
        deny:code=>{throw Error(`startup_admission_${code}`);},requireValue:(ok,code)=>{if(!ok)throw Error(`public_descriptor_${code}`);},...extra};
    return vm.runInNewContext(`${pieces[kind]}\n${kind==='root'?'rootFile':kind==='public'?'rootBytes':kind==='producer'?'readGenerationManifest':'readTargetManifestBytes'}`,context);
}
function modeledFs({size=1,mode=0o600,growth=false,drift=false}={}){
    let bytes=0,reads=0,opened=0,closed=0,stats=0;
    const meta={size,mode,uid:0,gid:0,dev:1,ino:2,mtimeMs:1,ctimeMs:1,isFile:()=>true,isSymbolicLink:()=>false};
    const fake={constants:fs.constants,realpathSync:f=>f,lstatSync:f=>f==='/safe/file'?meta:
        {...meta,isDirectory:()=>true,mode:0o755},openSync:()=>{opened++;return 7;},closeSync:()=>closed++,
    fstatSync:()=>({...meta,ino:drift&&stats++?3:2}),readSync:(_fd,buffer,offset,length)=>{
        reads++;const count=growth?length:Math.min(length,size-bytes);buffer.fill(32,offset,offset+count);bytes+=count;return count;
    },readFileSync:()=>assert.fail('unbounded content read')};
    return {fake,calls:()=>({bytes,reads,opened,closed})};
}
const call=(kind,reader,limit=maximum)=>kind==='root'?reader('/safe/file',0,limit):kind==='public'?reader('/safe/file',true,limit):reader('/safe/file');
test('pure bootstrap manifest bound equals release validator without importing release tooling',()=>{
    const declared=/const TARGET_MANIFEST_MAX_BYTES = ([^;]+);/.exec(source.bootstrap)[1];
    assert.equal(vm.runInNewContext(declared),maximum);
    assert.doesNotMatch(source.bootstrap,/import[^\n]*update-release-asset/);
});
for(const kind of Object.keys(pieces)){
    test(`${kind} rejects oversized metadata before content open/read`,()=>{
        const m=modeledFs({size:maximum+1});assert.throws(()=>call(kind,compile(kind,m.fake)),/unsafe/);
        assert.deepEqual(m.calls(),{bytes:0,reads:0,opened:0,closed:0});
    });
    test(`${kind} grow-after-stat reads at most max+1 and closes FD`,()=>{
        const m=modeledFs({growth:true});assert.throws(()=>call(kind,compile(kind,m.fake)),/changed/);
        assert.equal(m.calls().bytes,maximum+1);assert.equal(m.calls().closed,1);
    });
    test(`${kind} denies descriptor identity drift after read`,()=>{
        const m=modeledFs({drift:true});assert.throws(()=>call(kind,compile(kind,m.fake)),/changed/);assert.equal(m.calls().closed,1);
    });
}
test('root private default stays256KiB; public config explicit cap stays256KiB; manifest private mode remains strict',()=>{
    const m=modeledFs({size:256*1024+1});assert.throws(()=>compile('root',m.fake)('/safe/file',0),/unsafe/);
    assert.throws(()=>compile('public',m.fake)('/safe/file',true,256*1024),/unsafe/);
    for(const kind of ['root','public'])for(const mode of [0o644,0o400,0o660])
        assert.throws(()=>call(kind,compile(kind,modeledFs({mode}).fake)),/unsafe/);
});
test('actual signed ownerAuthority accepts raw private manifest >256KiB and rejects tamper/mode',t=>{
    const f=createBootstrapContextHarness(t,{localBuild:true});
    const raw=Buffer.from(JSON.stringify(f.manifest)+'\n'+' '.repeat(270000));
    const file=f.config.bootstrapClaim.releaseManifestFile;fs.writeFileSync(file,raw);fs.chmodSync(file,0o600);
    Object.assign(f.config.expected.localArtifact,{manifestSha256:sha(raw),manifestSize:raw.length});
    f.config.bootstrapClaim.releaseManifestSha256=sha(raw);
    const approval=f.read('approval.json');delete approval.signature;approval.expectedSha256=sha(canonical(f.config.expected));
    approval.signature=crypto.sign(null,Buffer.from(canonical(approval)),f.keys.privateKey).toString('base64url');
    f.write('approval.json',approval);
    const journal=f.read('first-cutover.json');journal.approvalSha256=sha(canonical(approval));
    // Shared checkout ancestors are writable in this test installation. Normalize
    // directory permission metadata only; all file ownership/modes/FDs and bytes stay real.
    // Read through the real syscalls: another fixture's root-ownership seam is installed on `fs`,
    // and this test asserts the manifest's actual service ownership and mode.
    const rootReader=compile('root',{...fs,...NATIVE_FILE_SYSTEM,lstatSync:(name,...args)=>{
        const info=NATIVE_FILE_SYSTEM.lstatSync(name,...args);if(info.isDirectory())info.mode&=~0o022;return info;
    }});const calls=[];
    const reader=(name,uid,limit)=>{calls.push({name,limit});return rootReader(name,uid,limit);};
    const owner=vm.runInNewContext(`(${fn(source.root,'ownerAuthority','defaultProcessGone')})`,{
        Buffer,...crypto,...local,RELEASE_ASSET_LIMITS,validateCompatibleForwardDatabaseContract,
        digest:sha,canonical,equal:(a,b)=>canonical(a)===canonical(b),
        readRecord:(name,uid,r)=>JSON.parse(r(name,uid)),deny:code=>{throw Error(`startup_admission_${code}`);}
    });
    const run=()=>owner(f.config,f.identity,journal,process.getuid(),Date.now(),reader);
    assert.equal(run(),journal.approvalSha256);assert.ok(raw.length>256*1024);
    assert.equal(calls.find(c=>c.name===file).limit,maximum);
    assert.ok(calls.filter(c=>c.name!==file).every(c=>c.limit===undefined));
    fs.writeFileSync(file,Buffer.from(raw).fill(32,0,1));assert.throws(run,/manifest_changed/);
    fs.writeFileSync(file,raw);fs.chmodSync(file,0o644);assert.throws(run,/file_unsafe/);
});
