/** Builtin-only measured input preparation for the local-forward build namespace. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyCodexSdkImageOnlySync } from '../patch-codex-sdk-image-only.mjs';

export const LOCAL_KIND = 'owner-reviewed-local-build/v1';
export const LOCAL_PROFILE = 'local-forward-349/v2';
export const CANDIDATE_DIRECTORY = '.local-forward-candidate';
// T-1686: علامة «بناء جارٍ» في جذر المخرَج. تكتبها prepareLocalForwardWorkspace عند
// إنشاء outputRoot ويحذفها المُنشئ عند النجاح، فتعرف أداة الاستبقاء أن هذه الشجرة
// قيد الإنشاء لا بقيّة مهجورة. لا يقرأها شيء في مسار البناء نفسه.
export const BUILD_IN_PROGRESS_MARKER = '.build-in-progress';
const FIXED_GITLINK = Object.freeze({path:'plugins/starter',gitMode:'160000',materialization:'empty-directory',oid:'4895cd3fd33362471e739b786493aba048487bcc'});
const SHA = /^[a-f0-9]{64}$/;
const OS_PATHS = Object.freeze(['/usr/bin/node', '/usr/bin/env', '/usr/bin/tar', '/usr/bin/gzip', '/bin/sh',
    '/lib64/ld-linux-x86-64.so.2', ...['libdl.so.2','libstdc++.so.6','libm.so.6','libgcc_s.so.1',
        'libpthread.so.0','libc.so.6','ld-linux-x86-64.so.2','libacl.so.1','libselinux.so.1',
        'libresolv.so.2','libutil.so.1','librt.so.1','libpcre2-8.so.0'].map(name => `/lib/x86_64-linux-gnu/${name}`)]);
const same = (a,b) => ['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'].every(key => a[key] === b[key]);
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root,file) => file === root || file.startsWith(root + path.sep);
export const CONTROL_ENV = Object.freeze({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'});
function directoryPaths(root, excludedRoot=null) {
    const rows=[];
    function visit(directory) {
        for(const name of fs.readdirSync(directory).sort()) {
            if(directory===root&&name===excludedRoot)continue;
            const file=path.join(directory,name),info=fs.lstatSync(file);
            if(info.isDirectory()&&!info.isSymbolicLink()){rows.push(path.relative(root,file));visit(file);}
        }
    }
    visit(root);return rows.sort();
}
function parentDirectories(files) {
    const rows=new Set();
    for(const file of files)for(let directory=path.dirname(file.path);directory!=='.';directory=path.dirname(directory))rows.add(directory);
    return [...rows].sort();
}
function requireAbsent(file,code) {
    try{fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
    throw Error(code);
}
function gitlinkDirectory(root, link, mode) {
    const file=path.join(root,link.path),info=fs.lstatSync(file);
    if(!info.isDirectory()||info.isSymbolicLink()||fs.realpathSync(file)!==file||info.uid!==process.getuid()
        ||(info.mode&0o777)!==mode||fs.readdirSync(file).length)throw Error('build_gitlink_placeholder');
    const after=fs.lstatSync(file);
    if(!same(info,after))throw Error('build_gitlink_changed');
    return {path:link.path,dev:info.dev,ino:info.ino,uid:info.uid,mode:info.mode&0o777,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs};
}

/** Hash a stable regular file in bounded buffers without executing its contents. */
export function measuredFile(file, maximum = 384 * 1024 * 1024) {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw Error('build_input_file');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const sha = createHash('sha256'), blob = createHash('sha1').update(`blob ${before.size}\0`);
    let size = 0;
    try {
        if (!same(before, fs.fstatSync(fd))) throw Error('build_input_changed');
        const buffer = Buffer.alloc(256 * 1024);
        for (;;) {
            const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maximum - size + 1), null);
            if (!count) break;
            size += count; if (size > maximum) throw Error('build_input_limit');
            sha.update(buffer.subarray(0,count)); blob.update(buffer.subarray(0,count));
        }
        if (size !== before.size || !same(before,fs.fstatSync(fd)) || !same(before,fs.lstatSync(file))) throw Error('build_input_changed');
    } finally { fs.closeSync(fd); }
    return { size, sha256:sha.digest('hex'), blob:blob.digest('hex'), mode:before.mode & 0o777 };
}

/** Measure exact bytes and internal relative links; no dependency module is imported. */
export function measuredTree(root, linksAllowed = false, excludedRoot = null) {
    if (fs.realpathSync(root) !== path.resolve(root) || !fs.lstatSync(root).isDirectory()) throw Error('build_tree_root');
    const records = [];
    function visit(directory) {
        for (const name of fs.readdirSync(directory).sort()) {
            if(directory===root && name===excludedRoot)continue;
            const file = path.join(directory,name), info = fs.lstatSync(file), relative = path.relative(root,file);
            if (info.isSymbolicLink()) {
                const link = fs.readlinkSync(file);
                if (!linksAllowed || path.isAbsolute(link) || !inside(root,fs.realpathSync(file))) throw Error('build_input_link');
                records.push({ path:relative, link });
            } else if (info.isDirectory()) visit(file);
            else if (info.isFile()) records.push({ path:relative, ...measuredFile(file) });
            else throw Error('build_input_special');
        }
    }
    visit(root);
    return records.sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Reject legacy/default and unconstrained paths before any workspace effects. */
export function validateLocalBuildOptions(options) {
    if (options?.kind !== LOCAL_KIND || options.profile !== LOCAL_PROFILE) throw Error('build_local_forward_only');
    if (!/^[a-f0-9]{40}$/.test(options.oid || '')) throw Error('build_oid');
    const repo = fs.realpathSync(options.repoRoot);
    const output = path.join(repo,'.artifacts',`local-forward-build-${options.oid}`);
    if (options.outputRoot !== output) throw Error('build_output_location');
    return { repo, output, source:path.join(repo,'.nassaj-local-preview/oid-snapshots',options.oid) };
}

/** Bind every source byte to the unreplaced Git object in the exact local repository. */
export function verifyOidBuildSource(repo, source, oid, files) {
    const gitDir=path.join(repo,'.git');
    if (fs.realpathSync(gitDir)!==gitDir || !fs.lstatSync(gitDir).isDirectory()) throw Error('build_git_directory');
    const args=[`--git-dir=${gitDir}`,`--work-tree=${repo}`,'--no-replace-objects'];
    const common=spawnSync('/usr/bin/git',[...args,'rev-parse','--path-format=absolute','--git-common-dir'],{cwd:repo,env:CONTROL_ENV,encoding:'utf8'});
    if(common.status!==0 || common.stdout.trim()!==gitDir)throw Error('build_git_common_directory');
    const git = spawnSync('/usr/bin/git',[...args,'ls-tree','-rz','--full-tree',oid],{cwd:repo,env:CONTROL_ENV,encoding:'utf8',maxBuffer:16*1024*1024});
    if (git.status !== 0) throw Error('build_git_source');
    const sourceGitlinks=[];
    const entries = git.stdout.split('\0').filter(Boolean).flatMap(row => {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
        if(match) {
            if(match[3]===FIXED_GITLINK.path||match[3].startsWith(FIXED_GITLINK.path+'/'))throw Error('build_git_type');
            return [{path:match[3],blob:match[2],executable:match[1]==='100755'}];
        }
        if(row!==`${FIXED_GITLINK.gitMode} commit ${FIXED_GITLINK.oid}\t${FIXED_GITLINK.path}`)throw Error('build_git_type');
        sourceGitlinks.push({...FIXED_GITLINK,source:gitlinkDirectory(source,FIXED_GITLINK,0o555)});
        return [];
    });
    if (files.length !== entries.length) throw Error('build_source_inventory');
    const actual = new Map(files.map(file=>[file.path,file]));
    const directories=new Set([source]);
    for(const link of sourceGitlinks) {
        for(let directory=path.join(source,link.path);;directory=path.dirname(directory)) {
            directories.add(directory);if(directory===source)break;
        }
    }
    for (const entry of entries) {
        const file = actual.get(entry.path);
        if (!file || file.blob !== entry.blob || Boolean(file.mode & 0o111) !== entry.executable || file.mode & 0o222)
            throw Error('build_source_oid_mismatch');
        for(let directory=path.dirname(path.join(source,entry.path));inside(source,directory);directory=path.dirname(directory)) {
            directories.add(directory);if(directory===source)break;
        }
    }
    for(const directory of directories)if(fs.lstatSync(directory).mode&0o222)throw Error('build_source_directory_writable');
    if (fs.realpathSync(source) !== source) throw Error('build_source_path');
    return sourceGitlinks;
}

/** Check actual package boundaries while deeper manifests remain fully byte-pinned. */
export function verifyBuildDependencyLock(root, lock, records) {
    for (const [relative,entry] of Object.entries(lock.packages || {})) {
        if (!relative.startsWith('node_modules/')) continue;
        const file = path.join(root,relative.slice('node_modules/'.length),'package.json');
        if (!fs.existsSync(file)) { if (entry.optional) continue; throw Error('build_locked_dependency_missing'); }
        const value = JSON.parse(fs.readFileSync(file,'utf8'));
        if (value.version !== entry.version || !/^sha(256|384|512)-/.test(entry.integrity || '')) throw Error('build_dependency_lock');
    }
    for (const record of records.filter(file=>file.path.endsWith('/package.json'))) {
        // Package fixtures are permitted bytes, but cannot impersonate an installed package root.
        const directory = path.dirname(record.path);
        const suffix=directory.slice(directory.lastIndexOf('/node_modules/')>=0?directory.lastIndexOf('/node_modules/')+14:0);
        if (/^(?:@[^/]+\/)?[^/]+$/.test(suffix)) {
            if (!lock.packages[`node_modules/${directory}`]) throw Error('build_unlocked_dependency');
        }
    }
}

/** Measure only the reviewed local-forward OS file list, never a host directory. */
function measuredRootFile(file) {
        const canonical = fs.realpathSync(file), info = fs.statSync(canonical);
        if (info.uid !== 0 || info.mode & 0o022 || info.nlink !== 1) throw Error('build_os_file');
        for (let directory=path.dirname(canonical);;directory=path.dirname(directory)) {
            const parent=fs.lstatSync(directory);
            if (!parent.isDirectory() || parent.uid !== 0 || parent.mode & 0o022) throw Error('build_os_ancestor');
            if (directory === path.dirname(directory)) break;
        }
        return { path:file, canonical, ...measuredFile(canonical) };
}
export function measuredOperatingSystem() {
    return OS_PATHS.map(measuredRootFile);
}

function controlQuery(file,args) {
    measuredRootFile(file);
    const result=spawnSync(file,args,{cwd:'/',env:CONTROL_ENV,encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024});
    if(result.status!==0)throw Error('build_control_query');
    return result.stdout;
}

/** Pin the separate host compiler/unshare chain and exact C header/link inputs. */
export function measuredBuildControls(sourceFile) {
    try {fs.lstatSync('/etc/ld.so.preload');throw Error('build_control_preload_forbidden');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const files=new Set(['/etc/ld.so.cache','/usr/bin/cc','/usr/bin/as','/usr/bin/ld','/usr/bin/unshare','/usr/bin/readelf','/sbin/ldconfig','/usr/bin/git']);
    for(const tool of ['cc1','collect2'])files.add(controlQuery('/usr/bin/cc',[`-print-prog-name=${tool}`]).trim());
    if(controlQuery('/usr/bin/cc',['-print-file-name=specs']).trim()!=='specs')throw Error('build_control_external_specs');
    for(const file of ['crtbeginS.o','crtendS.o','libgcc.a','libgcc_s.so','liblto_plugin.so','Scrt1.o','crti.o','crtn.o','libc.so','libc_nonshared.a']) {
        const resolved=controlQuery('/usr/bin/cc',[`-print-file-name=${file}`]).trim();
        if(!path.isAbsolute(resolved))throw Error('build_control_link_input');files.add(path.resolve(resolved));
    }
    const headers=controlQuery('/usr/bin/cc',['-M',sourceFile]).replace(/\\\n/g,' ').split(/\s+/).filter(word=>path.isAbsolute(word)&&word!==sourceFile);
    for(const header of headers)files.add(header);
    const cache=new Map();
    for(const line of controlQuery('/sbin/ldconfig',['-p']).split('\n')) {
        const match=/^\s*(\S+) \(.*x86-64.*\) => (\S+)/.exec(line);if(match)cache.set(match[1],match[2]);
    }
    const queue=[...files],seen=new Set();
    while(queue.length) {
        const file=queue.shift(),canonical=fs.realpathSync(file);if(seen.has(canonical))continue;seen.add(canonical);
        const fd=fs.openSync(canonical,'r'),header=Buffer.alloc(4);try{fs.readSync(fd,header,0,4,0);}finally{fs.closeSync(fd);}
        if(!header.equals(Buffer.from([127,69,76,70])))continue;
        const elf=controlQuery('/usr/bin/readelf',['-l','-d',canonical]);
        for(const match of elf.matchAll(/\(NEEDED\).*?\[(.*?)\]|Requesting program interpreter: (.*?)\]/g)) {
            const dependency=match[2] || cache.get(match[1]);if(!dependency)throw Error('build_control_elf_dependency');
            if(!files.has(dependency)){files.add(dependency);queue.push(dependency);}
        }
    }
    return [...files].sort().map(measuredRootFile);
}

function verifySdkReference(options, dependencies) {
    const reference = options.sdkReference?.path === undefined && options.sdkReference?.sha256 === undefined
        ? { path: path.join(options.repoRoot, 'scripts/lib/codex-sdk-dependencies.json'),
            sha256: '0bf1ba7d8b72fec96f4655761cf2f59b82f3aad451fa0ea0af025df20e1764dd' }
        : options.sdkReference;
    if (!reference || Object.keys(reference).sort().join(',') !== 'path,sha256' || !SHA.test(reference.sha256 || '')
        || typeof reference.path!=='string' || !inside(options.repoRoot,reference.path)
        || fs.realpathSync(reference.path)!==reference.path) throw Error('build_sdk_reference');
    const bytes=readPinnedBytes(reference.path,reference.sha256,256*1024);
    const value=JSON.parse(bytes), files=new Map(dependencies.map(file=>[file.path,file]));
    if (value.schema !== 'b890-isolated-measurement-dependencies/v1' || value.records?.length !== 17) throw Error('build_sdk_reference_schema');
    const seen=new Set();
    for (const row of value.records) {
        const current=files.get(row.path);
        if (!/^@openai\/(codex-sdk|codex|codex-linux-x64)\//.test(row.path) || seen.has(row.path)
            || !current || current.sha256 !== row.sha256 || current.size !== row.size) throw Error('build_sdk_mismatch');
        seen.add(row.path);
    }
    return {path:reference.path,sha256:reference.sha256};
}

/** Produce a reviewable immutable input inventory; this performs no build or copy. */
export function planLocalForwardBuild(options) {
    const paths = validateLocalBuildOptions(options);
    requireAbsent(path.join(paths.source,CANDIDATE_DIRECTORY),'build_source_candidate_collision');
    const source = measuredTree(paths.source);
    if(source.some(file=>file.path.split('/')[0]===CANDIDATE_DIRECTORY))throw Error('build_source_candidate_collision');
    const sourceGitlinks=verifyOidBuildSource(paths.repo,paths.source,options.oid,source);
    verifyCodexSdkImageOnlySync(paths.repo);
    const dependencies = measuredTree(path.join(paths.repo,'node_modules'),true);
    const lock = JSON.parse(fs.readFileSync(path.join(paths.source,'package-lock.json'),'utf8'));
    verifyBuildDependencyLock(path.join(paths.repo,'node_modules'),lock,dependencies);
    const packageValue = JSON.parse(fs.readFileSync(path.join(paths.source,'package.json'),'utf8'));
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(packageValue.version)) throw Error('build_version');
    const sdkReference=verifySdkReference(options,dependencies);
    const directories={source:directoryPaths(paths.source),dependencies:directoryPaths(path.join(paths.repo,'node_modules'))};
    const expectedDirectories=[...new Set([...parentDirectories([...source,...sourceGitlinks]),...sourceGitlinks.map(link=>link.path)])].sort();
    if(JSON.stringify(directories.source)!==JSON.stringify(expectedDirectories))throw Error('build_source_extra_directory');
    const os=measuredOperatingSystem(),controls=measuredBuildControls(path.join(paths.source,'scripts/lib/release-build-isolation.c'));
    verifySourceGitlinks({sourceRoot:paths.source,sourceGitlinks});
    return {schema:'nassaj-local-forward-build-input/v1',kind:LOCAL_KIND,profile:LOCAL_PROFILE,oid:options.oid,
        repoRoot:paths.repo,sourceRoot:paths.source,outputRoot:paths.output,version:packageValue.version,
        source,sourceGitlinks,dependencies,directories,sdkReference,os,controls,publicVite:{}};
}

function copyRecords(source,target,records) {
    fs.mkdirSync(target,{recursive:true,mode:0o700});
    for (const record of records) {
        const from = path.join(source,record.path), to = path.join(target,record.path);
        fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o755});
        if (record.link) {
            if (fs.readlinkSync(from) !== record.link || !inside(source,fs.realpathSync(from))) throw Error('build_copy_link_drift');
            fs.symlinkSync(record.link,to); continue;
        }
        const current = measuredFile(from);
        if (current.sha256 !== record.sha256 || current.size !== record.size || current.mode !== record.mode) throw Error('build_copy_input_drift');
        fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL); fs.chmodSync(to,record.mode & 0o111 ? 0o755 : 0o644);
        if (measuredFile(to).sha256 !== record.sha256) throw Error('build_copy_bytes');
    }
}

/** Recheck the whole reviewed plan, then create only its task-owned artifact root. */
export function prepareLocalForwardWorkspace(plan) {
    if (JSON.stringify(planLocalForwardBuild(plan)) !== JSON.stringify(plan)) throw Error('build_reviewed_input_drift');
    const free=fs.statfsSync(plan.repoRoot);
    const inputBytes=[...plan.source,...plan.dependencies,...plan.os].reduce((sum,file)=>sum+(file.size || 0),0);
    if (free.bavail*free.bsize < inputBytes*2 + 3*1024**3 + 256*1024**2) throw Error('build_space_reserve');
    fs.mkdirSync(plan.outputRoot,{mode:0o700});
    fs.writeFileSync(path.join(plan.outputRoot,BUILD_IN_PROGRESS_MARKER),`${process.pid}\n`,{flag:'wx',mode:0o600});
    const root = path.join(plan.outputRoot,'build-root'); fs.mkdirSync(root,{mode:0o700});
    copyRecords(plan.sourceRoot,path.join(root,'workspace'),plan.source);
    for(const link of plan.sourceGitlinks) {
        const placeholder=path.join(root,'workspace',link.path);
        fs.mkdirSync(placeholder,{recursive:true,mode:0o755});fs.chmodSync(placeholder,0o755);
    }
    copyRecords(path.join(plan.repoRoot,'node_modules'),path.join(root,'workspace/node_modules'),plan.dependencies);
    for(const directory of plan.directories.dependencies)fs.mkdirSync(path.join(root,'workspace/node_modules',directory),{recursive:true,mode:0o755});
    for (const record of plan.os) {
        const to = path.join(root,record.path); fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o755});
        if (measuredFile(record.canonical).sha256 !== record.sha256) throw Error('build_os_changed');
        fs.copyFileSync(record.canonical,to,fs.constants.COPYFILE_EXCL); fs.chmodSync(to,record.mode);
    }
    for (const directory of ['output','scratch/home','scratch/tmp','proc','dev']) fs.mkdirSync(path.join(root,directory),{recursive:true,mode:0o700});
    for (const name of ['null','zero','random','urandom']) fs.writeFileSync(path.join(root,'dev',name),'',{flag:'wx'});
    const inputs={...plan,copiedGitlinks:plan.sourceGitlinks.map(link=>gitlinkDirectory(path.join(root,'workspace'),link,0o755))};
    const bytes = JSON.stringify(inputs); fs.writeFileSync(path.join(root,'INPUT.json'),bytes,{flag:'wx',mode:0o600});
    verifyWorkspaceInputs(inputs,root);
    if (JSON.stringify(planLocalForwardBuild(plan)) !== JSON.stringify(plan)) throw Error('build_input_copy_race');
    return {root,sha256:digest(bytes),inputs};
}

/** Verify the mounted copy before any non-builtin import and after every build phase. */
export function verifyWorkspaceInputs(plan, root = '/', phase = 'inputs') {
    if (plan.kind !== LOCAL_KIND || plan.profile !== LOCAL_PROFILE) throw Error('build_local_forward_only');
    if(!['inputs','candidate'].includes(phase))throw Error('build_input_phase');
    const links=plan.sourceGitlinks || [],copies=plan.copiedGitlinks || [];
    if(links.length!==copies.length)throw Error('build_gitlink_copy_identity');
    for(let index=0;index<links.length;index++) {
        const link=links[index];
        if(link.path!==FIXED_GITLINK.path||link.oid!==FIXED_GITLINK.oid||link.gitMode!==FIXED_GITLINK.gitMode||link.materialization!==FIXED_GITLINK.materialization
            ||JSON.stringify(gitlinkDirectory(path.join(root,'workspace'),link,0o755))!==JSON.stringify(copies[index]))throw Error('build_gitlink_copy_identity');
    }
    if(phase==='inputs')requireAbsent(path.join(root,'workspace',CANDIDATE_DIRECTORY),'build_source_candidate_collision');
    if(phase==='candidate') {
        const directory=path.join(root,'workspace',CANDIDATE_DIRECTORY),info=fs.lstatSync(directory);
        if(!info.isDirectory()||info.isSymbolicLink()||fs.realpathSync(directory)!==directory
            ||JSON.stringify(fs.readdirSync(directory).sort())!==JSON.stringify(['client','server']))throw Error('build_candidate_layout');
        for(const name of ['client','server']) {
            const child=path.join(directory,name),metadata=fs.lstatSync(child);
            if(!metadata.isDirectory()||metadata.isSymbolicLink())throw Error('build_candidate_layout');
            measuredTree(child,true);
        }
    }
    const expectedPaths=[...plan.source.map(file=>file.path),...plan.dependencies.map(file=>`node_modules/${file.path}`)].sort();
    const actual=measuredTree(path.join(root,'workspace'),true,phase==='candidate'?CANDIDATE_DIRECTORY:null);
    if (JSON.stringify(actual.map(file=>file.path)) !== JSON.stringify(expectedPaths)) throw Error('build_copy_extra_or_missing');
    const expectedDirectories=[...(plan.directories?.source || parentDirectories(plan.source)),'node_modules',
        ...(plan.directories?.dependencies || parentDirectories(plan.dependencies)).map(directory=>`node_modules/${directory}`)].sort();
    if(JSON.stringify(directoryPaths(path.join(root,'workspace'),phase==='candidate'?CANDIDATE_DIRECTORY:null))!==JSON.stringify(expectedDirectories))throw Error('build_copy_extra_directory');
    const inventory=new Map(actual.map(file=>[file.path,file]));
    for (const [directory,records] of [['workspace',plan.source],['workspace/node_modules',plan.dependencies]]) {
        for (const record of records) {
            const file = path.join(root,directory,record.path);
            if (record.link) { if (fs.readlinkSync(file) !== record.link || !inside(path.join(root,directory),fs.realpathSync(file))) throw Error('build_copy_link'); continue; }
            const value = inventory.get(path.relative(path.join(root,'workspace'),file));
            if (value.sha256 !== record.sha256 || value.size !== record.size || value.mode !== (record.mode & 0o111 ? 0o755 : 0o644)) throw Error('build_copy_changed');
        }
    }
    const topLevels=new Set(['workspace','output','scratch','proc','dev','INPUT.json',...plan.os.map(file=>file.path.split('/')[1])]);
    if(fs.readdirSync(root).some(name=>!topLevels.has(name)))throw Error('build_root_extra');
    const osInventory=[...new Set(plan.os.map(file=>file.path.split('/')[1]))].flatMap(directory=>
        measuredTree(path.join(root,directory)).map(file=>({...file,path:`/${directory}/${file.path}`})));
    if(JSON.stringify(osInventory.map(file=>file.path).sort())!==JSON.stringify(plan.os.map(file=>file.path).sort()))throw Error('build_os_extra_or_missing');
    for(const directory of new Set(plan.os.map(file=>file.path.split('/')[1]))) {
        const expected=parentDirectories(plan.os.filter(file=>file.path.startsWith(`/${directory}/`)).map(file=>({path:file.path.slice(directory.length+2)})));
        if(JSON.stringify(directoryPaths(path.join(root,directory)))!==JSON.stringify(expected))throw Error('build_os_extra_directory');
    }
    for (const record of plan.os) if (measuredFile(path.join(root,record.path)).sha256 !== record.sha256) throw Error('build_os_changed');
}

/** Recheck host control bytes immediately around compilation and namespace launch. */
export function verifyBuildControls(records) {
    try{fs.lstatSync('/etc/ld.so.preload');throw Error('build_control_preload_forbidden');}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const record of records)if(JSON.stringify(measuredRootFile(record.path))!==JSON.stringify(record))throw Error('build_control_changed');
}

/** Original and copied gitlink directory identities are checked separately, never equated. */
export function verifySourceGitlinks(plan) {
    for(const link of plan.sourceGitlinks || [])
        if(JSON.stringify(gitlinkDirectory(plan.sourceRoot,link,0o555))!==JSON.stringify(link.source))throw Error('build_gitlink_source_identity');
}

/** Read an independently pinned plan without permitting an unbounded request. */
export function readBuildPlan(file, expectedSha256) {
    return JSON.parse(readPinnedBytes(file,expectedSha256,32*1024*1024));
}

function readPinnedBytes(file,expectedSha256,maximum) {
    if (!SHA.test(expectedSha256 || '')) throw Error('build_plan_digest');
    const before=fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size>maximum) throw Error('build_plan_limit');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),bytes=Buffer.alloc(before.size+1);
    let count=0;
    try {
        if (!same(before,fs.fstatSync(fd))) throw Error('build_plan_changed');
        while(count<bytes.length) {const got=fs.readSync(fd,bytes,count,bytes.length-count,null);if(!got)break;count+=got;}
        if(count!==before.size || !same(before,fs.fstatSync(fd)) || !same(before,fs.lstatSync(file))) throw Error('build_plan_changed');
    } finally {fs.closeSync(fd);}
    const exact=bytes.subarray(0,count);
    if(digest(exact)!==expectedSha256)throw Error('build_plan_digest');
    return exact;
}
