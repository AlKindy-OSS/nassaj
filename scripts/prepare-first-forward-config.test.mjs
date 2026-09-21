import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {generateFirstForwardConfiguration} from './lib/prepare-first-forward-config.mjs';
import {installUpdateRuntimeBundle} from './lib/update-runtime-bundle.mjs';
import {collectForwardExecutableClosure} from './build-release-asset.mjs';
import {FORWARD_EXECUTABLE_MANIFEST_PATH} from './lib/update-release-asset.mjs';
import {createBootstrapContextHarness} from './fixtures/bootstrap-context-harness.mjs';
import {forwardValueSha256 as digest} from './lib/release-runtime-forward-child-protocol.mjs';
import {mintCutoverApproval} from './mint-cutover-approval.mjs';
import {preflightFirstForwardConfiguration} from './lib/release-runtime-forward-initialization.mjs';
const root=path.resolve(import.meta.dirname,'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const pin=file=>({path:fs.realpathSync(file),sha256:sha(fs.readFileSync(file))});
function fixture(t){
    const f=createBootstrapContextHarness(t,{localBuild:true});
    const generation=path.join(f.root,`local-forward-${f.descriptor.artifact.archiveSha256}`);fs.renameSync(f.releaseRoot,generation);
    const closure=collectForwardExecutableClosure(root);
    for(const record of closure.files){const dst=path.join(generation,record.path);fs.mkdirSync(path.dirname(dst),{recursive:true,mode:0o755});fs.copyFileSync(path.join(root,record.path),dst);fs.chmodSync(dst,record.mode);}
    const executableMaterial={schema:'nassaj-forward-executable-files/v1',roots:closure.roots,
        files:closure.files.map(({path,mode,size,sha256})=>({path,mode,size,sha256}))};
    const executableBytes=Buffer.from(`${JSON.stringify(executableMaterial)}\n`);
    fs.writeFileSync(path.join(generation,FORWARD_EXECUTABLE_MANIFEST_PATH),executableBytes,{mode:0o644});
    f.manifest.files=[...f.manifest.files,...executableMaterial.files,{path:FORWARD_EXECUTABLE_MANIFEST_PATH,
        mode:0o644,size:executableBytes.length,sha256:sha(executableBytes)}].sort((a,b)=>a.path<b.path?-1:1);
    installUpdateRuntimeBundle(root,path.join(generation,'dist-server'));
    fs.writeFileSync(path.join(generation,'package.json'),'{"version":"fixture"}');fs.chmodSync(path.join(generation,'package.json'),0o644);
    const entry=path.join(generation,'dist-server/server/scripts/release-database-migration.js');fs.mkdirSync(path.dirname(entry),{recursive:true,mode:0o755});fs.writeFileSync(entry,'export const fixture=true;');fs.chmodSync(entry,0o644);
    const {build,...artifact}=f.descriptor.artifact;
    f.manifest.databaseContract.migrationEntrySha256=pin(entry).sha256;
    artifact.databaseContractSha256=digest(f.manifest.databaseContract);
    const manifestBytes=Buffer.from(JSON.stringify(f.manifest));artifact.manifestSha256=sha(manifestBytes);artifact.manifestSize=manifestBytes.length;
    fs.writeFileSync(path.join(generation,'RELEASE_ASSET_MANIFEST.json'),manifestBytes);fs.chmodSync(path.join(generation,'RELEASE_ASSET_MANIFEST.json'),0o644);
    const permissions=Object.fromEntries(Object.entries(f.manifest).filter(([key])=>key.startsWith('permission')||key==='minimumPermissionBuild'));
    const identity={strategy:'release-layout-v2',updaterProtocol:2,generationId:path.basename(generation),kind:build.kind,profile:'forward',build,artifact,
        bundleManifestSha256:f.manifest.bundleManifestSha256,...permissions};
    fs.writeFileSync(path.join(generation,'runtime-generation.json'),JSON.stringify({schemaVersion:2,state:'sealed',identity}),{mode:0o600});
    const saved=path.join(f.root,'dump.json');fs.writeFileSync(saved,JSON.stringify([{name:'nassaj-dev',namespace:'default'}]),{mode:0o600});
    const unit={Id:'fixture.service',LoadState:'loaded',ActiveState:'active',UnitFileState:'enabled',ControlGroup:'/fixture',FragmentPath:'/fixture.service',DropInPaths:'',ExecStart:'/fixture',ExecStartPre:''};
    const serviceIdentity={uid:process.getuid(),gid:process.getgid(),supplementaryGids:[...new Set(process.getgroups())].sort((a,b)=>a-b)};
    const old={pid:4242,startTicks:'5',bootId:'12345678-1234-1234-1234-123456789012',uids:Array(4).fill(serviceIdentity.uid),gids:Array(4).fill(serviceIdentity.gid),supplementaryGids:serviceIdentity.supplementaryGids,capabilities:['0','0','0']};
    const exe=pin(process.execPath);
    const ingressConfig=path.join(f.root,'cloudflared.yml');fs.writeFileSync(ingressConfig,'service: http://127.0.0.1:3004',{mode:0o644});
    const unitFile=path.join(f.root,'fixture.service');fs.writeFileSync(unitFile,'[Service]\nExecStart=/usr/bin/false',{mode:0o644});
    const input={schema:'nassaj-forward-preparation-input/v1',operationId:'fixture-operation-0001',nodeInstanceId:f.identity.nodeInstanceId,generationRoot:generation,build,artifact,
        observer:{daemon:{pid:process.pid}},slot:{pm2Id:4,name:'nassaj-dev',namespace:'default'},
        definitions:[{sourceId:'dump',path:saved,format:'pm2-dump-json',writerSourceIds:['writer']}],
        controllers:[{sourceId:'writer',scope:'system',user:null,unit:unit.Id,cgroupPath:'/fixture',optional:false,creationSourceIds:[]}],
        inventory:[{kind:'file',path:saved}],serviceIdentity,
        targetPolicy:{exec_mode:'fork_mode',pm_out_log_path:path.join(f.root,'out'),pm_err_log_path:path.join(f.root,'err'),pm_pid_path:path.join(f.root,'pid'),
            status:'stopped',autostart:true,autorestart:false,watch:false,pmx:false,vizion:false,wait_ready:false,restart_time:0,unstable_restarts:0,prev_restart_delay:0,env:{}},
        hostIdentityFiles:[saved],policies:{health:{privateUrl:'http://127.0.0.1:3004/health',publicUrl:'https://fixture.invalid/health'},
            maintenance:{nonce:'nassaj-maintenance-v1',retryAfterSeconds:30,responderUnit:'fixture-maintenance.service',responderPort:3311,cloudflared:{unit:'fixture-ingress.service',configFile:ingressConfig,originHost:'127.0.0.1',originPort:3004}},probeTimeoutMs:1000},
        executables:{node:exe,sudo:pin('/usr/bin/sudo'),dispatcher:pin(path.join(generation,'dist-server/UPDATE_RUNTIME_BUNDLE/scripts/release-runtime-host-dispatcher.mjs')),systemctl:pin('/usr/bin/systemctl'),zeroWorkProbe:exe,nft:exe,conntrack:exe},
        locations:{outputRoot:path.join(f.root,'prepared'),controlRoot:f.root,databaseFile:f.descriptor.databasePath,approvalFile:path.join(f.root,'fresh-approval.json'),ownerPublicKeyFile:f.config.bootstrapClaim.ownerApprovalPublicKeyFile}};
    const deps={observe:async()=>({privateEntries:[{pm_id:4,name:'nassaj-dev',pid:old.pid,pm2_env:{namespace:'default',status:'online'}}]}),inspectProcess:()=>old,metadata:()=>({version:'fixture',nodeVersion:process.versions.node}),
        trustedFile:file=>pin(file),inspectIngress:()=>({...old,startTicks:'12345678'}),ingressExecutable:()=>exe.path,
        maintenance:{ingressProcessIdentity:()=>({pid:old.pid,startTime:'12345678'}),readIngressProc:file=>file.endsWith('/status')?`Uid:\t${serviceIdentity.uid}\n`:'0::/system.slice/fixture-ingress.service',ingressExecutable:()=>exe.path},
        exec:(_file,args)=>args.includes('--property=MainPID')?String(old.pid):args.includes('--value')?unitFile:Object.entries(unit).map(([k,v])=>`${k}=${v}`).join('\n'),startup:{effectiveUid:()=>0,readRootBytes:file=>fs.readFileSync(file)}};
    return {f,input,deps};
}
test('producer feeds actual startup preparation, mint and read-only facade preflight without a hand-built host config',async t=>{
    const {f,input,deps}=fixture(t);const result=await generateFirstForwardConfiguration(input,deps);
    assert.equal(result.complete,true,JSON.stringify(result.report));
    const configFile=path.join(result.outputRoot,'release-runtime-host.forward.json'),config=JSON.parse(fs.readFileSync(configFile));
    assert.equal(digest(config.forwardActivation.supervisorPlan),config.expected.supervisorPlanSha256);
    const rows=config.forwardActivation.hostIdentity.files;
    assert.equal(config.forwardActivation.hostIdentity.schema,'nassaj-forward-host-identity/v1');
    assert.equal(rows[0].path,input.hostIdentityFiles[0]);
    assert.equal(fs.statSync(rows[0].path).uid,input.serviceIdentity.uid);
    assert.equal(config.bootstrapClaim.applicationUid,input.serviceIdentity.uid);
    for(const row of rows){assert.deepEqual(Object.keys(row),['path','sha256','size']);assert.deepEqual(row,{...pin(row.path),size:fs.statSync(row.path).size});}
    assert.equal(config.expected.hostIdentitySha256,sha(JSON.stringify(rows)));
    const privateKey=path.join(f.root,'fixture-private.pem');fs.writeFileSync(privateKey,f.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    const minted=mintCutoverApproval({forwardConfig:configFile,privateKeyFile:privateKey,out:input.locations.approvalFile});
    assert.ok(minted);
    const request=preflightFirstForwardConfiguration(config,{pin:p=>fs.readFileSync(p.path),pinnedRecord:p=>JSON.parse(fs.readFileSync(p.path)),exec:deps.exec});
    assert.equal(request.transactionId,input.operationId);
});
test('B951 host identity preserves input order and rejects aliases, cycles, owners and pre-read limits',async t=>{
    for(const mode of ['order','duplicate','symlink','hardlink','output-cycle','attestation-cycle','config-cycle','descriptor-cycle','other-owner','count','row-size','aggregate-size','changed-path','unsafe-parent','parent-drift'])await t.test(mode,async child=>{
        const {input,deps}=fixture(child),files=[];
        const hostDirectory=path.join(path.dirname(input.locations.outputRoot),'identity-data');fs.mkdirSync(hostDirectory,{mode:0o700});
        for(let index=0;index<3;index++){const file=path.join(hostDirectory,`host-${index}`);fs.writeFileSync(file,`identity-${index}`,{mode:0o600});files.push(file);}
        input.hostIdentityFiles=[files[2],files[0],files[1]];
        let expected;
        if(mode==='duplicate'){input.hostIdentityFiles.push(files[0]);expected='host_identity';}
        if(mode==='symlink'){const alias=files[0]+'-alias';fs.symlinkSync(files[0],alias);input.hostIdentityFiles=[alias];expected='host_identity_path';}
        if(mode==='hardlink'){fs.linkSync(files[0],files[0]+'-alias');expected='host_identity_file';}
        if(mode==='output-cycle'){input.hostIdentityFiles=[path.join(input.locations.outputRoot,'GENERATION_REPORT.json')];expected='host_identity_cycle';}
        for(const [name,file] of [['attestation-cycle','release-host-support-attestation.json'],['config-cycle','release-runtime-host.json'],['descriptor-cycle','startup-admission-client.json']])if(mode===name){input.hostIdentityFiles=[`/etc/nassaj/${file}`];expected='host_identity_cycle';}
        if(mode==='count'){input.hostIdentityFiles=Array.from({length:513},(_,index)=>`/unread-${index}`);expected='host_identity';}
        if(mode==='unsafe-parent'){fs.chmodSync(hostDirectory,0o722);expected='host_identity_ancestor';}
        if(mode==='parent-drift'){
            const original=fs.lstatSync;let visits=0;fs.lstatSync=(file,...args)=>{const info=original(file,...args);if(file===hostDirectory&&++visits>3)info.ino++;return info;};
            child.after(()=>{fs.lstatSync=original;});expected='host_identity_ancestor_changed';
        }
        if(['other-owner','row-size','aggregate-size','changed-path'].includes(mode)){
            const original=fs.lstatSync;let visits=0;
            fs.lstatSync=(file,...args)=>{const info=original(file,...args);if(files.includes(file)){
                if(mode==='other-owner')info.uid=input.serviceIdentity.uid+1;
                if(mode==='row-size')info.size=384*1024*1024+1;
                if(mode==='aggregate-size')info.size=384*1024*1024;
                if(mode==='changed-path'&&file===files[2]&&++visits>1)info.ino++;
            }return info;};child.after(()=>{fs.lstatSync=original;});
            expected=mode==='other-owner'?'host_identity_file':mode==='changed-path'?'host_identity_changed':'host_identity_limit';
        }
        const result=await generateFirstForwardConfiguration(input,deps);
        if(mode==='order'){
            assert.equal(result.complete,true,JSON.stringify(result.report));
            const config=JSON.parse(fs.readFileSync(path.join(result.outputRoot,'release-runtime-host.forward.json')));
            assert.deepEqual(config.forwardActivation.hostIdentity.files.slice(0,3).map(row=>row.path),input.hostIdentityFiles);
            assert.equal(config.expected.hostIdentitySha256,sha(JSON.stringify(config.forwardActivation.hostIdentity.files)));
        }else{assert.equal(result.complete,false);assert.deepEqual(result.report.missing,[`forward_prepare_${expected}`]);
            assert.equal(fs.existsSync(path.join(result.outputRoot,'release-runtime-host.forward.json')),false);}
    });
});
test('B947 producer preserves measured raw manifest in private copy without changing generation0644',async t=>{
    const {input,deps}=fixture(t);
    const generationManifest=path.join(input.generationRoot,'RELEASE_ASSET_MANIFEST.json');
    const raw=Buffer.concat([fs.readFileSync(generationManifest),Buffer.from('\n'+' '.repeat(270000))]);
    fs.writeFileSync(generationManifest,raw);fs.chmodSync(generationManifest,0o644);
    input.artifact.manifestSha256=sha(raw);input.artifact.manifestSize=raw.length;
    const recordFile=path.join(input.generationRoot,'runtime-generation.json');
    const record=JSON.parse(fs.readFileSync(recordFile));record.identity.artifact=input.artifact;
    fs.writeFileSync(recordFile,JSON.stringify(record));
    const seen=[];deps.startup.readRootBytes=(file,privateFile,maximum)=>{
        if(path.basename(file)==='release-manifest.json'){
            seen.push(file);assert.equal(privateFile,true);assert.equal(maximum,32*1024*1024);
            assert.equal(fs.statSync(file).mode&0o777,0o600);assert.deepEqual(fs.readFileSync(file),raw);
        }
        return fs.readFileSync(file);
    };
    const result=await generateFirstForwardConfiguration(input,deps);
    assert.equal(result.complete,true,JSON.stringify(result.report));assert.ok(seen.length>=2);
    const config=JSON.parse(fs.readFileSync(path.join(result.outputRoot,'release-runtime-host.forward.json')));
    assert.equal(config.bootstrapClaim.releaseManifestFile,path.join(result.outputRoot,'release-manifest.json'));
    assert.equal(config.bootstrapClaim.releaseManifestSha256,sha(raw));
    assert.equal(config.expected.localArtifact.manifestSize,raw.length);
    assert.equal(config.expected.localArtifact.manifestSha256,sha(raw));
    assert.equal(fs.statSync(result.outputRoot).mode&0o777,0o700);
    assert.equal(fs.statSync(generationManifest).mode&0o777,0o644);assert.deepEqual(fs.readFileSync(generationManifest),raw);
});
test('B947 producer copies the buffer measured before async observations without rereading generation',async t=>{
    const {input,deps}=fixture(t),file=path.join(input.generationRoot,'RELEASE_ASSET_MANIFEST.json');
    const original=fs.readFileSync(file),observe=deps.observe;
    deps.observe=async(...args)=>{fs.writeFileSync(file,'changed after measurement');return observe(...args);};
    const result=await generateFirstForwardConfiguration(input,deps);
    assert.equal(result.complete,true,JSON.stringify(result.report));
    assert.deepEqual(fs.readFileSync(path.join(result.outputRoot,'release-manifest.json')),original);
    assert.equal(fs.readFileSync(file,'utf8'),'changed after measurement');
});
test('B947 private manifest tamper before startup preparation never emits final config',async t=>{
    const {input,deps}=fixture(t);
    deps.startup.readRootBytes=file=>{
        if(path.basename(file)==='release-manifest.json')fs.appendFileSync(file,'tamper');
        return fs.readFileSync(file);
    };
    const result=await generateFirstForwardConfiguration(input,deps);
    assert.equal(result.complete,false);assert.deepEqual(result.report.missing,['public_descriptor_pin_mismatch']);
    assert.equal(fs.existsSync(path.join(result.outputRoot,'release-runtime-host.forward.json')),false);
});
test('missing observation or unknown fields leave only an incomplete report, never a final config',async t=>{
    const {input,deps}=fixture(t);input.extraAuthority=true;
    const result=await generateFirstForwardConfiguration(input,deps);
    assert.equal(result.complete,false);assert.equal(fs.existsSync(path.join(result.outputRoot,'release-runtime-host.forward.json')),false);
    assert.ok(result.report.missing.length);
});

test('unknown or drifting measurements refuse publication without accepting caller overrides',async t=>{
    for(const mode of ['observer','duplicate','unit','pin','target-override','absent-policy','missing-systemctl','untrusted-executable','missing-cloudflared','cloudflared-tamper','unit-tamper'])await t.test(mode,async child=>{
        const {input,deps}=fixture(child);
        if(mode==='observer')deps.observe=async()=>{throw Error('private_peer_unknown');};
        if(mode==='duplicate'){const old=deps.observe;deps.observe=async()=>{const x=await old();return {privateEntries:[...x.privateEntries,...x.privateEntries]};};}
        if(mode==='unit')deps.exec=()=> 'Id=wrong';
        if(mode==='pin')input.executables.systemctl.sha256='0'.repeat(64);
        if(mode==='target-override')input.targetPolicy.pm_exec_path='/caller/program';
        if(mode==='absent-policy')delete input.policies.health;
        if(mode==='missing-systemctl')delete input.executables.systemctl;
        if(mode==='untrusted-executable')input.executables.systemctl=input.executables.node;
        if(mode==='missing-cloudflared')delete input.policies.maintenance.cloudflared.configFile;
        if(mode==='cloudflared-tamper')fs.writeFileSync(input.policies.maintenance.cloudflared.configFile,'service: http://127.0.0.1:6666');
        if(mode==='unit-tamper'){const oldExec=deps.exec;let calls=0;deps.exec=(file,args)=>args.includes('--value')&&++calls>3?'/missing/unit':oldExec(file,args);}

        const result=await generateFirstForwardConfiguration(input,deps);
        assert.equal(result.complete,false);assert.ok(result.report.missing.length);
        assert.equal(fs.existsSync(path.join(result.outputRoot,'release-runtime-host.forward.json')),false);
        assert.throws(()=>mintCutoverApproval({forwardConfig:path.join(result.outputRoot,'release-runtime-host.forward.json')}));
    });
});
test('an existing output directory is never reused or overwritten',async t=>{
    const {input,deps}=fixture(t);fs.mkdirSync(input.locations.outputRoot);fs.writeFileSync(path.join(input.locations.outputRoot,'sentinel'),'keep');
    await assert.rejects(()=>generateFirstForwardConfiguration(input,deps),/output_not_new/);
    assert.equal(fs.readFileSync(path.join(input.locations.outputRoot,'sentinel'),'utf8'),'keep');
});

test('late startup rejection leaves no complete or signable intermediate config',async t=>{
    const {input,deps}=fixture(t);deps.startup.effectiveUid=()=>1000;
    const result=await generateFirstForwardConfiguration(input,deps);assert.equal(result.complete,false);
    const files=fs.readdirSync(result.outputRoot);
    assert.ok(!files.includes('release-runtime-host.forward.json'));
    assert.ok(!files.includes('release-runtime-host.prepared.INCOMPLETE.json'));
    assert.throws(()=>mintCutoverApproval({forwardConfig:path.join(result.outputRoot,'release-runtime-host.INCOMPLETE.json')}),/startup_identity_invalid/);
});
test('a fixture-owned executable cannot pass the production trust boundary and no command is run',async t=>{
    const {input,deps}=fixture(t);delete deps.trustedFile;let calls=0;deps.exec=()=>{calls++;throw Error('unexpected_spawn');};
    const result=await generateFirstForwardConfiguration(input,deps);
    assert.equal(result.complete,false);assert.equal(calls,0);
});

test('B941 consumer plan refusals prevent COMPLETE and any prepared output',async t=>{
    const cases=[
        ['duplicate-controller','inventory_order',input=>input.controllers.push({...input.controllers[0]})],
        ['duplicate-definition','inventory_order',input=>input.definitions.push({...input.definitions[0]})],
        ['optional-empty','absent_creation_uncontrolled',input=>{input.controllers[0].optional=true;}],
        ['optional-unknown','absent_creation_uncontrolled',input=>{input.controllers[0].optional=true;input.controllers[0].creationSourceIds=['missing'];}],
        ['optional-self','absent_creation_uncontrolled',input=>{input.controllers[0].optional=true;input.controllers[0].creationSourceIds=['writer'];}],
        ['embedded-cloudflared','unsupported_inhibitor',(input,deps)=>{
            input.controllers[0].unit='fixture-cloudflared.service';const exec=deps.exec;
            deps.exec=(file,args)=>exec(file,args).replace('Id=fixture.service','Id=fixture-cloudflared.service');
        }],
        ['parent-cgroup','unsupported_inhibitor',(input,deps)=>{
            input.controllers[0].cgroupPath='/fixture/../other';const exec=deps.exec;
            deps.exec=(file,args)=>exec(file,args).replace('ControlGroup=/fixture','ControlGroup=/fixture/../other');
        }],
    ];
    for(const [name,reason,mutate] of cases)await t.test(name,async child=>{
        const {input,deps}=fixture(child);mutate(input,deps);
        const result=await generateFirstForwardConfiguration(input,deps);
        assert.equal(result.complete,false);assert.deepEqual(result.report.missing,[`forward_initialization_${reason}`]);
        assert.deepEqual(fs.readdirSync(result.outputRoot),['GENERATION_REPORT.json']);
        assert.throws(()=>mintCutoverApproval({forwardConfig:path.join(result.outputRoot,'release-runtime-host.forward.json')}));
    });
});

function listenerFixture(t, scope = 'user') {
    const context = fixture(t), {input, deps, f} = context, uid = input.serviceIdentity.uid;
    const account = fs.readFileSync('/etc/passwd', 'utf8').split('\n').map(row => row.split(':')).find(row => Number(row[2]) === uid)[0];
    const source = input.policies.maintenance.cloudflared, root = path.join(f.root, 'mutable-routing');
    fs.mkdirSync(root, {mode: 0o771}); fs.chmodSync(root, 0o771);
    source.configFile = path.join(root, 'config.yml'); fs.writeFileSync(source.configFile, 'service: http://127.0.0.1:3004', {mode: 0o600});
    const unitFile = path.join(root, 'cloudflared.service'); fs.writeFileSync(unitFile, '[Service]\nExecStart=/usr/bin/false', {mode: 0o644});
    source.manager = {scope, user: scope === 'user' ? account : null, managerUid: scope === 'user' ? uid : 0, unit: source.unit};
    input.policies.maintenance.boundary = {mode: 'local-origin-listener/v1', originHost: '127.0.0.1', originPort: 3004};
    input.targetPolicy.env = {HOST: '127.0.0.1', PORT: '3004'};
    const cgroup = scope === 'user' ? `/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/${source.unit}` : `/system.slice/${source.unit}`;
    deps.maintenance.readIngressProc = file => file.endsWith('/status') ? `Uid:\t${Array(4).fill(uid).join('\t')}\n` : `0::${cgroup}`;
    const originalExec = deps.exec; context.commands = [];
    deps.exec = (file, args, options) => {
        context.commands.push(args);
        if (args.includes(source.unit)) {
            assert.equal(args.includes('--user'), scope === 'user');
            if (args.includes('--property=MainPID')) return '4242';
            if (args.includes('--property=ControlGroup')) return cgroup;
            return unitFile;
        }
        return originalExec(file, args, options);
    };
    deps.listener = {
        read: file => file === '/proc/sys/kernel/random/boot_id' ? '12345678-1234-1234-1234-123456789012' : file.endsWith('/stat') ? `4242 (fixture) S ${Array(18).fill('0').join(' ')} 5`
            : file.endsWith('/status') ? `Uid:\t${Array(4).fill(uid).join('\t')}\n`
                : file === '/proc/self/net/tcp' ? `header\n0: 0100007F:0BBC 00000000:0000 0A 0 0 0 ${uid} 0 98765\n` : 'header\n',
        readlink: file => file.includes('/ns/net') ? 'net:[fixture]' : 'socket:[98765]', readdir: () => ['3'],
    };
    return context;
}
test('B816 producer measures user and system routing independently and binds protected loopback target', async t => {
    for (const scope of ['user', 'system']) await t.test(scope, async child => {
        const {input, deps, commands, f} = listenerFixture(child, scope);
        const result = await generateFirstForwardConfiguration(input, deps);
        assert.equal(result.complete, true, JSON.stringify(result.report));
        const configFile = path.join(result.outputRoot, 'release-runtime-host.forward.json'), config = JSON.parse(fs.readFileSync(configFile));
        assert.equal(config.maintenance.cloudflared.manager.scope, scope);
        assert.equal(config.maintenance.cloudflared.routingEvidence.kind, 'mutable-routing-observation/v1');
        assert.equal(config.maintenance.originListener.inode, '98765');
        assert.equal(config.forwardActivation.supervisorPlan.mutation.targetDescriptor.env.HOST, '127.0.0.1');
        assert.equal(config.forwardActivation.hostIdentity.files.some(row => row.path.includes('mutable-routing')), false);
        assert.equal(commands.some(args => args.some(arg => ['start', 'stop', 'restart', 'mask', 'enable'].includes(arg))), false);
        const privateKey = path.join(path.dirname(input.locations.outputRoot), 'scoped-private.pem');
        fs.writeFileSync(privateKey, (await import('node:crypto')).generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}), {mode:0o600});
        // A mismatching real key cannot mint authority from mutable routing observations.
        assert.throws(() => mintCutoverApproval({forwardConfig:configFile,privateKeyFile:privateKey,out:input.locations.approvalFile}));
        fs.writeFileSync(privateKey, f.keys.privateKey.export({type:'pkcs8',format:'pem'}));
        assert.ok(mintCutoverApproval({forwardConfig:configFile,privateKeyFile:privateKey,out:input.locations.approvalFile}));
        const request = preflightFirstForwardConfiguration(config, {pin:p=>fs.readFileSync(p.path),pinnedRecord:p=>JSON.parse(fs.readFileSync(p.path)),exec:deps.exec});
        assert.equal(request.transactionId, input.operationId);
    });
});
test('B816 preparation rejects inactive user manager, target widening and sibling sockets before publication', async t => {
    for (const variant of ['manager-unavailable', 'wildcard-target', 'port-change', 'sibling', 'manager-uid']) await t.test(variant, async child => {
        const {input, deps} = listenerFixture(child);
        if (variant === 'manager-unavailable') { const exec = deps.exec; deps.exec = (file,args,options) => args.includes('--user') && args.includes('--property=MainPID') ? '0' : exec(file,args,options); }
        if (variant === 'wildcard-target') input.targetPolicy.env.HOST = '0.0.0.0';
        if (variant === 'port-change') input.targetPolicy.env.PORT = '3005';
        if (variant === 'manager-uid') input.policies.maintenance.cloudflared.manager.managerUid++;
        if (variant === 'sibling') { const read = deps.listener.read; deps.listener.read = file => file === '/proc/self/net/tcp6' ? `header\n0: 00000000000000000000000001000000:0BBC 0:0 0A 0 0 0 ${input.serviceIdentity.uid} 0 98766\n` : read(file); }
        const result = await generateFirstForwardConfiguration(input, deps);
        assert.equal(result.complete, false); assert.equal(fs.existsSync(path.join(result.outputRoot, 'release-runtime-host.forward.json')), false);
        assert.match(result.report.missing.join(','), /ingress_pid|listener_target_policy|listener_topology|manager_account_mismatch/);
    });
});
