#!/usr/bin/env node
/** Build one reviewed local-forward release in a private filesystem, never live dist. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { LOCAL_KIND, LOCAL_PROFILE, digest, measuredFile, planLocalForwardBuild,
    prepareLocalForwardWorkspace, readBuildPlan, verifyWorkspaceInputs, verifyBuildControls, CONTROL_ENV,
    CANDIDATE_DIRECTORY, verifySourceGitlinks, BUILD_IN_PROGRESS_MARKER } from './lib/release-build-workspace.mjs';

/** Return the exact independent file-pin shape consumed by cold tests and installers. */
export function measureLocalForwardOutput(buildRoot, file) {
    if(typeof file!=='string' || !file.startsWith('/output/') || path.resolve(file)!==file)throw Error('build_output_path');
    const target=path.join(buildRoot,file);
    if(fs.realpathSync(target)!==target)throw Error('build_output_path');
    const {size,sha256}=measuredFile(target);
    return {path:target,size,sha256};
}

/** Start only the fixed local-forward build child after rechecking its reviewed bytes. */
export function executeLocalForwardBuild(plan) {
    if (plan.kind !== LOCAL_KIND || plan.profile !== LOCAL_PROFILE) throw Error('build_local_forward_only');
    const prepared = prepareLocalForwardWorkspace(plan);
    const source = path.join(prepared.root,'workspace/scripts/lib/release-build-isolation.c');
    const launcher = path.join(plan.outputRoot,'build-isolate');
    verifyBuildControls(plan.controls);
    verifySourceGitlinks(plan);
    const compilation = spawnSync('/usr/bin/cc',['-Wall','-Wextra','-Werror','-O2',source,'-o',launcher],{
        cwd:prepared.root,env:{...CONTROL_ENV,TMPDIR:path.join(prepared.root,'scratch/tmp')},encoding:'utf8',timeout:30000});
    if (compilation.status !== 0) throw Error('build_isolation_compile');
    verifyBuildControls(plan.controls);verifyWorkspaceInputs(prepared.inputs,prepared.root);
    const launcherPin = measuredFile(launcher);
    const result = spawnSync('/usr/bin/unshare',['--user','--map-current-user','--mount','--net','--pid','--keep-caps',
        '--fork','--kill-child',launcher,fs.readlinkSync('/proc/self/ns/mnt'),prepared.root,prepared.sha256,'build'],{
        encoding:'utf8',timeout:20*60*1000,maxBuffer:4*1024*1024,
        env:{PATH:'/usr/bin:/bin',HOME:'/scratch/home',TMPDIR:'/scratch/tmp',NODE_ENV:'production',LANG:'C',LC_ALL:'C'},
    });
    if (measuredFile(launcher).sha256 !== launcherPin.sha256) throw Error('build_isolation_changed');
    verifyBuildControls(plan.controls);
    verifySourceGitlinks(plan);
    if (result.status !== 0) throw Error(`build_namespace_failed:${result.status}:${String(result.stderr || '').slice(-2048)}`);
    verifyWorkspaceInputs(prepared.inputs,prepared.root,'candidate');
    const built=JSON.parse(fs.readFileSync(path.join(prepared.root,'output/RESULT.json'),'utf8'));
    const external=file=>measureLocalForwardOutput(prepared.root,file);
    // T-1686: البناء نجح، فترفع العلامة ولا تبقى الشجرة معفاة من الاستبقاء إلى الأبد.
    fs.rmSync(path.join(plan.outputRoot,BUILD_IN_PROGRESS_MARKER),{force:true});
    return {outputRoot:plan.outputRoot,oid:plan.oid,runtime:{archive:external(built.runtime.asset),
        manifest:external(built.runtime.publishedManifest),expected:{kind:LOCAL_KIND,build:built.runtime.manifest.build,artifact:built.runtime.preparedArtifact}},
        installer:{archive:external(built.installer.asset)}};
}

async function insideBuild(hash, phase) {
    if (phase !== 'build' || process.pid !== 1) throw Error('build_private_entry');
    const status = fs.readFileSync('/proc/self/status','utf8');
    if (!/^NoNewPrivs:\s+1$/m.test(status) || !/^CapEff:\s+0+$/m.test(status)) throw Error('build_private_capabilities');
    const plan = readBuildPlan('/INPUT.json',hash);
    verifyWorkspaceInputs(plan);
    const sourceRoot = '/workspace', candidateRoot = path.join(sourceRoot,CANDIDATE_DIRECTORY);
    const { buildReleaseCandidate } = await import(pathToFileURL('/workspace/scripts/build-release-candidate.mjs'));
    const candidate = await buildReleaseCandidate({sourceRoot,candidateRoot,version:plan.version,commit:plan.oid,
        publicVite:{},profile:LOCAL_PROFILE});
    verifyWorkspaceInputs(plan,'/','candidate');
    const { buildReleaseAsset } = await import(pathToFileURL('/workspace/scripts/build-release-asset.mjs'));
    const runtime = buildReleaseAsset({kind:LOCAL_KIND,profile:LOCAL_PROFILE,projectId:'nassaj-dev',sourceRoot,
        version:plan.version,commit:plan.oid,clientArtifact:candidate.client.outputRoot,serverArtifact:candidate.server.outputRoot,
        temporaryRoot:'/scratch/tmp',outputDirectory:'/output/runtime'});
    verifyWorkspaceInputs(plan,'/','candidate');
    const { buildReleaseInstaller } = await import(pathToFileURL('/workspace/scripts/build-release-installer.mjs'));
    const installer = buildReleaseInstaller({profile:'forward',sourceRoot,version:plan.version,commit:plan.oid,
        runtime:{kind:LOCAL_KIND,build:runtime.manifest.build,artifact:runtime.preparedArtifact},
        temporaryRoot:'/scratch/tmp',outputDirectory:'/output/installer'});
    verifyWorkspaceInputs(plan,'/','candidate');
    fs.writeFileSync('/output/RESULT.json',JSON.stringify({oid:plan.oid,candidate,runtime,installer})+'\n',{flag:'wx',mode:0o600});
}

function parseArguments(argv) {
    const values = {}, allowed = new Set(['--kind','--profile','--repo','--oid','--output','--plan','--sha256','--sdk-manifest','--sdk-sha256']);
    for (let index=1;index<argv.length;index+=2) {
        if (!allowed.has(argv[index]) || values[argv[index]] !== undefined || !argv[index+1]) throw Error('build_arguments');
        values[argv[index]] = argv[index+1];
    }
    return values;
}

async function main(argv) {
    if (argv[0] === '--inside' && argv.length === 3) return insideBuild(argv[1],argv[2]);
    const values = parseArguments(argv);
    if (argv[0] === 'plan') {
        const required=['--kind','--profile','--repo','--oid','--output','--plan','--sdk-manifest','--sdk-sha256'];
        if(Object.keys(values).length!==required.length || required.some(key=>!values[key]))throw Error('build_arguments');
        const plan = planLocalForwardBuild({kind:values['--kind'],profile:values['--profile'],repoRoot:values['--repo'],
            oid:values['--oid'],outputRoot:values['--output'],sdkReference:{path:values['--sdk-manifest'],sha256:values['--sdk-sha256']}});
        const target=path.join(plan.repoRoot,'.artifacts',`local-forward-build-${plan.oid}.plan.json`);
        if(values['--plan']!==target)throw Error('build_plan_path');
        const bytes = JSON.stringify(plan);fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
        process.stdout.write(JSON.stringify({planFile:target,sha256:digest(bytes),size:Buffer.byteLength(bytes)})+'\n');
    } else if (argv[0] === 'build') {
        if (Object.keys(values).sort().join(',') !== '--plan,--sha256') throw Error('build_arguments');
        process.stdout.write(JSON.stringify(executeLocalForwardBuild(readBuildPlan(values['--plan'],values['--sha256'])))+'\n');
    } else throw Error('build_arguments');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).catch(error=>{console.error(`[local-forward-build] ${error.message}`);process.exitCode=1;});
}
