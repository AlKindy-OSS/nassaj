/** Fixture-only producer bridge. Measurements use the same private PM2 fixture and real files;
 * systemd/ingress ownership metadata remains the declared host seam. No authority is patched after mint. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
import { createHash } from 'node:crypto';
import { generateFirstForwardConfiguration } from '../lib/prepare-first-forward-config.mjs';
import { mintCutoverApproval } from '../mint-cutover-approval.mjs';
import { localBuildIdentitySha256 } from '../lib/local-reviewed-build-identity.mjs';
import { computeReleaseFileTreeSha256, FORWARD_EXECUTABLE_MANIFEST_PATH } from '../lib/update-release-asset.mjs';
import { collectForwardExecutableClosure } from '../build-release-asset.mjs';
import { inspectForwardChildIdentity, forwardValueSha256 as digest } from '../lib/release-runtime-forward-child-protocol.mjs';
import { stageFixtureInstalledSupport, attestFixtureInstalledConfig, FIXTURE_DISPATCHER, FIXTURE_OPERATOR_ROOT } from './installed-config-authority.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const pin = file => ({ path: fs.realpathSync(file), sha256: sha(fs.readFileSync(file)) });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const sealForwardFixtureFile = (file, mode = 0o644) => fs.chmodSync(file, mode);
function relocateHooks(fixture, wired) {
    const { generation, outer } = fixture;
    fs.mkdirSync(path.join(generation, 'scripts/fixtures'), { recursive: true });
    for (const name of ['root-hook', 'transport', 'contention']) {
        const old = path.join(generation, `fixture-${name}.mjs`), target = path.join(generation, `scripts/fixtures/forward-facade-${name}.mjs`);
        fs.writeFileSync(target, fs.readFileSync(old, 'utf8').replaceAll("'./facade-map.json'", "'../../facade-map.json'")
            .replaceAll("'./scripts/lib/", "'../lib/"));
        sealForwardFixtureFile(target);
    }
    const files = [wired.parent, path.join(generation, 'scripts/release-runtime-forward-child.mjs'), path.join(generation, 'scripts/lib/pm2-readonly-observer.mjs')];
    for (const file of files) fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
        .replaceAll("'../fixture-root-hook.mjs'", "'./fixtures/forward-facade-root-hook.mjs'")
        .replaceAll("'../fixture-contention.mjs'", "'./fixtures/forward-facade-contention.mjs'")
        .replaceAll("'../../fixture-transport.mjs'", "'../fixtures/forward-facade-transport.mjs'"));
    for (const file of files) sealForwardFixtureFile(file);
    const mapFile = path.join(generation, 'facade-map.json'), map = JSON.parse(fs.readFileSync(mapFile));
    Object.assign(map, { tlsCaFile: path.join(outer, 'public-cert.pem'), systemctl: wired.systemctl }); write(mapFile, map);
}
function sealFixtureMaterial(fixture, wired) {
    const { f, generation } = fixture;
    const bootstrap = path.join(generation, 'dist-server/server/bootstrap.js');
    fs.writeFileSync(bootstrap, fs.readFileSync(wired.target, 'utf8').replace("'./dist-server/server/bootstrap-startup-context.js'", "'./bootstrap-startup-context.js'"));
    sealForwardFixtureFile(bootstrap);
    const material = f.material;
    material.files = material.files.map(record => { const file = path.join(generation, record.path); sealForwardFixtureFile(file); return { ...record, mode: 0o644,
        size: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) }; });
    const materialFile = path.join(generation, 'dist-server/STARTUP_CLOSURE.json'); write(materialFile, material);
    f.manifest.files = f.manifest.files.map(record => { const file = path.join(generation, record.path); sealForwardFixtureFile(file); return { ...record, mode: 0o644,
        size: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) }; });
    const closure = collectForwardExecutableClosure(generation);
    const executableMaterial = { schema: 'nassaj-forward-executable-files/v1', roots: closure.roots,
        files: closure.files.map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 })) };
    for (const record of executableMaterial.files) fs.chmodSync(path.join(generation, record.path), record.mode);
    const executableBytes = Buffer.from(`${JSON.stringify(executableMaterial)}\n`);
    fs.writeFileSync(path.join(generation, FORWARD_EXECUTABLE_MANIFEST_PATH), executableBytes, { mode: 0o644 });
    const measured = new Map(f.manifest.files.map(record => [record.path, record]));
    for (const record of executableMaterial.files) measured.set(record.path, record);
    measured.set(FORWARD_EXECUTABLE_MANIFEST_PATH, { path: FORWARD_EXECUTABLE_MANIFEST_PATH,
        mode: 0o644, size: executableBytes.length, sha256: sha(executableBytes) });
    f.manifest.files = [...measured.values()].sort((a, b) => a.path < b.path ? -1 : 1);
    const build = f.manifest.build;
    build.sourceTreeSha256 = computeReleaseFileTreeSha256(f.manifest.files);
    const contract = f.manifest.databaseContract;
    contract.releaseIdentitySha256 = localBuildIdentitySha256(build);
    contract.startup.closureSha256 = digest(material);
    contract.migrationEntrySha256 = pin(path.join(generation, 'dist-server/server/scripts/release-database-migration.js')).sha256;
    const artifact = { ...f.config.expected.localArtifact, buildIdentitySha256: localBuildIdentitySha256(build),
        startupClosureSha256: digest(material), databaseContractSha256: digest(contract) };
    const bytes = JSON.stringify(f.manifest); artifact.manifestSha256 = sha(bytes); artifact.manifestSize = Buffer.byteLength(bytes);
    const manifestFile = path.join(generation, 'RELEASE_ASSET_MANIFEST.json');
    fs.writeFileSync(manifestFile, bytes); sealForwardFixtureFile(manifestFile);
    const permissions = Object.fromEntries(Object.entries(f.manifest).filter(([key]) => key.startsWith('permission') || key === 'minimumPermissionBuild'));
    write(path.join(generation, 'runtime-generation.json'), { schemaVersion: 2, state: 'sealed', identity: {
        strategy: 'release-layout-v2', updaterProtocol: 2, generationId: path.basename(generation), kind: build.kind, profile: 'forward', build, artifact,
        bundleManifestSha256: f.manifest.bundleManifestSha256, ...permissions } });
    return { build, artifact };
}
function unifiedDispatcher(fixture) {
    const { f, generation, outer } = fixture;
    const file = path.join(generation, 'dist-server/UPDATE_RUNTIME_BUNDLE/scripts/release-runtime-host-dispatcher.mjs');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `import ${JSON.stringify(path.join(generation, 'scripts/fixtures/forward-facade-root-hook.mjs'))};
import fs from 'node:fs';
import {inspectForwardChildIdentity} from ${JSON.stringify(new URL('../lib/release-runtime-forward-child-protocol.mjs', import.meta.url).href)};
import {handleBootstrapStartupAdmission} from ${JSON.stringify(new URL('../lib/release-runtime-startup-admission.mjs', import.meta.url).href)};
import {dispatchReleaseRuntimeHostOperation} from ${JSON.stringify(new URL('../lib/release-runtime-host-operations.mjs', import.meta.url).href)};
import {readHostDispatcherInput} from ${JSON.stringify(new URL('../release-runtime-host-dispatcher.mjs', import.meta.url).href)};
const root=${JSON.stringify(f.root)};const config=JSON.parse(fs.readFileSync(root+'/config.json'));
const observe=()=>{const p=inspectForwardChildIdentity(process.ppid);return {uid:p.uids[0],pid:p.pid,startTicks:p.startTicks,bootId:p.bootId};};
const deps={attestMaintenancePrerequisites:()=>({fixtureHostMetadata:true}),exec:(_file,args)=>{if(JSON.stringify(args)!==JSON.stringify(['start','fixture-maintenance.service']))throw Error('fixture_system_effect');return '';},
installMaintenanceGate:()=>fs.writeFileSync(${JSON.stringify(wiredRoute(outer))},JSON.stringify({closed:true})),removeMaintenanceGate:()=>fs.writeFileSync(${JSON.stringify(wiredRoute(outer))},JSON.stringify({closed:false}))};
try{const request=await readHostDispatcherInput(process.stdin);const result=process.argv[2]==='claimBootstrapStartup'
?handleBootstrapStartupAdmission(config,request,observe,{ownerUid:0,readRootFile:file=>fs.readFileSync(file),inspectProcess:inspectForwardChildIdentity})
:await dispatchReleaseRuntimeHostOperation(config,process.argv[2],request,deps);process.stdout.write(JSON.stringify(result));}
catch(error){fs.appendFileSync(${JSON.stringify(path.join(outer,'producer-dispatch-errors'))},String(error.message)+'\\n');process.stderr.write(error.stack);process.exitCode=78;}`);
    sealForwardFixtureFile(file, 0o755);
    const hook = path.join(f.root, 'fixture-hook.mjs');
    fs.writeFileSync(hook, fs.readFileSync(hook, 'utf8').replaceAll(path.join(f.root, 'dispatcher.mjs'), file));
    return file;
}
const wiredRoute = outer => path.join(outer, 'routing.json');
/** Run the actual producer and signer, replacing the discovery-only configuration before any operator starts. */
export async function prepareProducedFacade(fixture, wired) {
    const { f, generation, outer, ready, observer } = fixture;
    relocateHooks(fixture, wired);
    const { build, artifact } = sealFixtureMaterial(fixture, wired);
    const dispatcher = unifiedDispatcher(fixture);
    const support = stageFixtureInstalledSupport(f.root, dispatcher);
    const hookFile = path.join(f.root, 'fixture-hook.mjs');
    fs.writeFileSync(hookFile, fs.readFileSync(hookFile, 'utf8').replaceAll(dispatcher, FIXTURE_DISPATCHER));
    const mapFile = path.join(generation, 'facade-map.json'), fixtureMap = JSON.parse(fs.readFileSync(mapFile));
    fixtureMap.installedOperatorRoot = support.directory; write(mapFile, fixtureMap);
    const unit = { ...wired.unit, ControlGroup: '/fixture-unused' };
    write(path.join(outer, 'unit.json'), unit);
    const unitFile = path.join(outer, 'prepared-unit.service'), ingressFile = path.join(outer, 'cloudflared.yml');
    fs.writeFileSync(unitFile, '[Service]\nExecStart=/usr/bin/false\n'); fs.writeFileSync(ingressFile, 'service: http://127.0.0.1:3312\n');
    sealForwardFixtureFile(unitFile); sealForwardFixtureFile(ingressFile);
    const expected = wired.config.forwardActivation.supervisorPlan;
    const targetPolicy = { ...expected.mutation.targetDescriptor };
    for (const key of ['name','namespace','pm_exec_path','pm_cwd','exec_interpreter','uid','gid']) delete targetPolicy[key];
    const serviceIdentity = wired.config.forwardMigration.serviceIdentity;
    const input = { schema:'nassaj-forward-preparation-input/v1', operationId:'fixture-transaction-0001', nodeInstanceId:f.identity.nodeInstanceId,
        generationRoot:generation, build, artifact, observer, slot:expected.slot,
        definitions:[{sourceId:'dump',path:wired.saved,format:'pm2-dump-json',writerSourceIds:['writer']}],
        controllers:[{sourceId:'writer',scope:'system',user:null,unit:unit.Id,cgroupPath:'/fixture-unused',optional:false,creationSourceIds:[]}],
        inventory:[{kind:'file',path:wired.systemctl}],serviceIdentity,targetPolicy,hostIdentityFiles:[wired.saved,...support.records.map(record=>record.path)],
        policies:{health:wired.config.health,probeTimeoutMs:1000,maintenance:{nonce:'nassaj-maintenance-v1',retryAfterSeconds:30,
            responderUnit:'fixture-maintenance.service',responderPort:3311,cloudflared:{unit:'fixture-ingress.service',configFile:ingressFile,originHost:'127.0.0.1',originPort:3312}}},
        executables:{systemctl:pin('/usr/bin/systemctl'),dispatcher:support.dispatcher,sudo:pin('/usr/bin/sudo'),node:pin(process.execPath),
            zeroWorkProbe:pin(wired.config.zeroWorkProbe.file),nft:pin(wired.config.maintenance.nft.binary),conntrack:pin(wired.config.maintenance.conntrack.binary)},
        locations:{outputRoot:path.join(outer,'prepared'),controlRoot:f.root,databaseFile:wired.config.databaseFile,
            approvalFile:path.join(f.root,'approval.json'),ownerPublicKeyFile:f.config.bootstrapClaim.ownerApprovalPublicKeyFile} };
    const processIdentity = pid => { const value=inspectForwardChildIdentity(pid); value.supplementaryGids=[...new Set(value.supplementaryGids)].sort((a,b)=>a-b); return value; };
    const diagnostics=[];
    const copiedObserver=await import(pathToFileURL(path.join(generation,'scripts/lib/pm2-readonly-observer.mjs')).href);
    const observe=async()=>{
        const original=net.createConnection;
        net.createConnection=(options,...args)=>options?.path===observer.socketPath?original({host:'127.0.0.1',port:ready.port},...args):original(options,...args);
        try{return await copiedObserver.observePinnedPm2PrivateRuntime(observer,{ownerUid:0,effectiveUid:()=>0});}
        catch(error){diagnostics.push(error.message);throw error;}
        finally{net.createConnection=original;}
    };
    const deps={observe,metadata:settings=>copiedObserver.readPinnedPm2RuntimeMetadata(settings,{ownerUid:0,effectiveUid:()=>0}),inspectProcess:processIdentity,trustedFile:pin,
        inspectIngress:()=>processIdentity(ready.daemonPid),ingressExecutable:()=>fs.realpathSync(process.execPath),
        maintenance:{ingressProcessIdentity:()=>({pid:ready.daemonPid,startTime:processIdentity(ready.daemonPid).startTicks}),
            readIngressProc:file=>file.endsWith('/status')?`Uid:\t${serviceIdentity.uid}\n`:'0::/system.slice/fixture-ingress.service',ingressExecutable:()=>fs.realpathSync(process.execPath)},
        exec:(_file,args)=>args.includes('--property=MainPID')?String(ready.daemonPid):args.includes('--value')?unitFile:Object.entries(unit).map(([key,value])=>`${key}=${value}`).join('\n'),
        startup:{effectiveUid:()=>0,readRootBytes:file=>fs.readFileSync(file)}};
    // The B899 user map reports host-root SDK files as overflow UID. Only these
    // fixed system paths/ancestors receive the same explicit metadata seam as the operator.
    const originalLstat=fs.lstatSync,originalStat=fs.statSync,originalFstat=fs.fstatSync,originalOpen=fs.openSync,originalRead=fs.readFileSync,originalRealpath=fs.realpathSync;const hostInodes=new Set();
    const mapInstalled=file=>typeof file==='string'&&(file===FIXTURE_OPERATOR_ROOT||file.startsWith(`${FIXTURE_OPERATOR_ROOT}/`))
        ?path.join(support.directory,file.slice(FIXTURE_OPERATOR_ROOT.length)):file;
    const ancestors=new Set();for(let dir=generation;;dir=path.dirname(dir)){ancestors.add(dir);if(dir===path.dirname(dir))break;}
    const isHost=file=>typeof file==='string'&&(ancestors.has(file)||file==='/usr'||file.startsWith('/usr/')||file.startsWith(generation+'/'));
    fs.lstatSync=(file,...args)=>{const info=originalLstat(mapInstalled(file),...args);if(isHost(file)){info.uid=0;if(info.isDirectory())info.mode&=~0o022;hostInodes.add(String(info.ino));}return info;};
    fs.fstatSync=(...args)=>{const info=originalFstat(...args);if(hostInodes.has(String(info.ino)))info.uid=0;return info;};
    fs.openSync=(file,...args)=>originalOpen(mapInstalled(file),...args);
    fs.statSync=(file,...args)=>originalStat(mapInstalled(file),...args);
    fs.readFileSync=(file,...args)=>originalRead(mapInstalled(file),...args);
    fs.realpathSync=(file,...args)=>mapInstalled(file)!==file?(originalRealpath(mapInstalled(file),...args),file):originalRealpath(file,...args);
    syncBuiltinESMExports();
    let produced;
    try{produced=await generateFirstForwardConfiguration(input,deps);}
    finally{fs.lstatSync=originalLstat;fs.statSync=originalStat;fs.fstatSync=originalFstat;fs.openSync=originalOpen;fs.readFileSync=originalRead;fs.realpathSync=originalRealpath;syncBuiltinESMExports();}
    if(!produced.complete)throw Error(`fixture_producer_incomplete:${JSON.stringify({report:produced.report,diagnostics})}`);
    const configFile=path.join(produced.outputRoot,'release-runtime-host.forward.json');
    const config=JSON.parse(fs.readFileSync(configFile));
    const privateKey=path.join(outer,'fixture-owner-private.pem');
    fs.writeFileSync(privateKey,f.keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
    fs.unlinkSync(input.locations.approvalFile);
    mintCutoverApproval({forwardConfig:configFile,privateKeyFile:privateKey,out:input.locations.approvalFile});
    fs.copyFileSync(configFile,path.join(f.root,'config.json'));
    fs.copyFileSync(path.join(produced.outputRoot,'startup-admission-client.json'),path.join(f.root,'descriptor.json'));
    attestFixtureInstalledConfig(f.root,support,path.join(f.root,'config.json'),path.join(f.root,'descriptor.json'));
    return { config, report:produced.report };
}
