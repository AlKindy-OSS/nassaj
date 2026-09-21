/** Child-pipe integration fixture: real signatures/CAS and observed parent PID, simulated root filesystem/sudo only. */
import { spawn } from 'node:child_process';
import { createHash, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LOCAL_BUILD_KIND, localBuildIdentitySha256 } from '../lib/local-reviewed-build-identity.mjs';
import { computeReleaseFileTreeSha256 } from '../lib/update-release-asset.mjs';
import { createMeasuredPermissionReleaseContract } from '../lib/permission-release-contract.mjs';
import { fixture } from './startup-admission-fixture.mjs';
import {inspectForwardChildIdentity} from '../lib/release-runtime-forward-child-protocol.mjs';
const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const PUBLIC = '/etc/nassaj/startup-admission-client.json';

/** Prepare a signed forward context fixture before sealing; callers may supply their complete isolated release root. */
export function createBootstrapContextHarness(t, options = {}) {
    if(options.offerVariant!==undefined && !['wrong-mode','wrong-authority'].includes(options.offerVariant)) throw Error('fixture_offer_variant_invalid');
    const childTimeoutMs = options.childTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(childTimeoutMs) || childTimeoutMs < 1_000 || childTimeoutMs > 60_000) throw Error('fixture_child_timeout_invalid');
    const measured = options.measuredRelease;
    const f = fixture(t, 'cutover', {}, {phase: options.phase});
    const releaseRoot = options.releaseRoot || path.join(f.root, 'release');
    if (!options.releaseRoot) {
        // Release directories are 0755 regardless of the runner umask.
        fs.mkdirSync(path.join(releaseRoot, 'dist-server/server'), { recursive: true, mode: 0o755 });
        for (const name of ['bootstrap.js', 'bootstrap-startup-context.js']) fs.copyFileSync(path.join(PROJECT, 'server', name), path.join(releaseRoot, 'dist-server/server', name));
        fs.writeFileSync(path.join(releaseRoot, 'dist-server/server/bootstrap-release-profile.js'), "export const ROOT_ADMISSION_REQUIRED = true;\nexport const PROFILE_ID = 'local-forward-349/v2';\n");
    }
    if (!options.releaseRoot) {
        fs.mkdirSync(path.join(releaseRoot,'dist-server/scripts/lib'),{recursive:true,mode:0o755});
        fs.copyFileSync(path.join(PROJECT,'scripts/lib/local-reviewed-build-identity.mjs'),path.join(releaseRoot,'dist-server/scripts/lib/local-reviewed-build-identity.mjs'));
    }
    const records = options.files || ['server/bootstrap.js', 'server/bootstrap-startup-context.js', 'server/bootstrap-release-profile.js','scripts/lib/local-reviewed-build-identity.mjs'].map(name => {
        const relative = `dist-server/${name}`; const file = path.join(releaseRoot, relative); const metadata = fs.statSync(file);
        return { path: relative, size: metadata.size, mode: metadata.mode & 0o777, sha256: sha(fs.readFileSync(file)) };
    }).sort((a, b) => a.path < b.path ? -1 : 1);
    const material = measured?.material || options.material || { schema: 'nassaj-startup-closure/v1', profileId: 'local-forward-349/v2',
        modePolicy: 'release-file-mode-normalization/v1', roots: records.map(record => record.path), files: records };
    if (!measured) fs.writeFileSync(path.join(releaseRoot, 'dist-server/STARTUP_CLOSURE.json'), JSON.stringify(material));
    const materialFile = path.join(releaseRoot, 'dist-server/STARTUP_CLOSURE.json'); const info = fs.statSync(materialFile);
    const files = [...records, { path: 'dist-server/STARTUP_CLOSURE.json', size: info.size, mode: info.mode & 0o777, sha256: sha(fs.readFileSync(materialFile)) }]
        .sort((a, b) => a.path < b.path ? -1 : 1);
    let manifest = { ...f.manifest, schemaVersion: 2, updaterProtocol: 2, repo: 'fixture/nassaj', releaseId: 123,
        tag: 'v1.47.0.3', version: '1.47.0.3', commit: 'a'.repeat(40), serverBuildId: 'a'.repeat(64),
        clientBuildId: 'a'.repeat(64), bundleBuildId: 'a'.repeat(64), files };
    let identity = sha(canonical(Object.fromEntries(['repo', 'releaseId', 'tag', 'version', 'commit', 'serverBuildId', 'clientBuildId', 'bundleBuildId'].map(key => [key, manifest[key]]))));
    if (options.localBuild && !measured) {
        const build={kind:LOCAL_BUILD_KIND,projectId:'nassaj-dev',commit:'a'.repeat(40),version:'1.47.0.3',profileId:'local-forward-349/v2',
            sourceTreeSha256:computeReleaseFileTreeSha256(files),inputManifestSha256:'a'.repeat(64),serverBuildId:'a'.repeat(64),clientBuildId:'a'.repeat(64),bundleBuildId:'a'.repeat(64)};
        manifest={schema:'nassaj-local-build-manifest/v1',build,bundleManifestSha256:'a'.repeat(64),
            ...createMeasuredPermissionReleaseContract(build.serverBuildId),databaseContract:manifest.databaseContract,
            runtimeCompatibility:{},targetRuntime:{},runtimeClosure:{},npmBinLinksExcluded:{},files};
        identity=localBuildIdentitySha256(build);
    }
    if (measured) { manifest = measured.manifest; identity = localBuildIdentitySha256(measured.build); }
    if (options.databaseTarget && !measured) manifest.databaseContract.target = { ...options.databaseTarget };
    if(measured){if(manifest.databaseContract.releaseIdentitySha256!==identity||manifest.databaseContract.startup.closureSha256!==sha(canonical(material)))throw Error('fixture_measured_contract_mismatch');}
    else{manifest.databaseContract.releaseIdentitySha256 = identity;
        manifest.databaseContract.startup.closureSha256 = sha(canonical(material));}
    const database = options.databasePath || path.join(f.root, 'database.sqlite');
    if (!options.databasePath) fs.writeFileSync(database, 'context-only fixture; not a SQL readiness proof');
    const databaseInfo = fs.statSync(database, { bigint: true }); const assetSha256 = measured?.artifact.archiveSha256 || 'a'.repeat(64);
    Object.assign(f.identity, { releaseIdentitySha256: identity, startupClosureSha256: manifest.databaseContract.startup.closureSha256,
        databaseContractSha256: sha(canonical(manifest.databaseContract)), databaseDev: String(databaseInfo.dev), databaseIno: String(databaseInfo.ino),
        generationId: options.localBuild ? `local-forward-${assetSha256}` : `${manifest.version}-${manifest.commit.slice(0, 12)}-forward-${assetSha256}` });
    Object.assign(f.config.expected, { releaseIdentitySha256: identity, databaseContractSha256: f.identity.databaseContractSha256, generationId: f.identity.generationId });
    const manifestBytes = measured?.manifestBytes || Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(path.join(f.root, 'manifest.json'), manifestBytes, {mode:0o600});
    // The admitted runtime refuses group/world-writable manifests.  The fixture must model the
    // sealed release artifact, independent of the developer's permissive umask.
    if (!measured) fs.writeFileSync(path.join(releaseRoot, 'RELEASE_ASSET_MANIFEST.json'), manifestBytes, { mode: 0o644 });
    f.config.bootstrapClaim.releaseManifestSha256 = sha(manifestBytes);
    const localArtifact=measured?.artifact || (options.localBuild ? {kind:LOCAL_BUILD_KIND,buildIdentitySha256:identity,
        archiveName:`nassaj-local-forward-${manifest.build.commit}.tar.gz`,archiveSha256:assetSha256,archiveSize:1,
        manifestName:'LOCAL_BUILD_MANIFEST.json',manifestSha256:sha(JSON.stringify(manifest)),manifestSize:Buffer.byteLength(JSON.stringify(manifest)),
        startupClosureSha256:f.identity.startupClosureSha256,databaseContractSha256:f.identity.databaseContractSha256} : null);
    if(localArtifact) Object.assign(f.config.expected,{artifactPolicy:LOCAL_BUILD_KIND,localBuild:manifest.build,localArtifact,assetSha256});

    if (measured) Object.assign(f.config.expected, { serverBuildId:measured.build.serverBuildId,
        clientBuildId:measured.build.clientBuildId, targetSchemaDigest:manifest.databaseContract.target.schemaDigest });
    const approval = f.read('approval.json'); delete approval.signature;
    approval.expectedSha256 = sha(canonical(f.config.expected)); approval.startupAdmission = f.identity;
    const signed = { ...approval, signature: sign(null, Buffer.from(canonical(approval)), f.keys.privateKey).toString('base64url') };
    f.write('approval.json', signed);
    const journal = f.read('first-cutover.json'); journal.expected = f.config.expected; journal.approvalSha256 = sha(canonical(signed));
    if (options.phase !== 'pre-migration') Object.assign(journal.forwardReceipts.schema, { releaseIdentitySha256: identity, databaseContractSha256: f.identity.databaseContractSha256,
        databaseDev: f.identity.databaseDev, databaseIno: f.identity.databaseIno,
        ...(measured?{targetSchemaDigest:manifest.databaseContract.target.schemaDigest}:{}) }); f.write('first-cutover.json', journal);
    const state = f.read('startup-admission.json'); state.identity = f.identity; state.approvalSha256 = journal.approvalSha256; f.write('startup-admission.json', state);
    const host = f.read('host-dispatch-state.json');
    host.gateInstallIntent.identitySeal = sha(JSON.stringify(['nodeInstanceId', 'hostIdentitySha256', 'releaseIdentitySha256', 'migrationIdentitySha256', 'pm2SnapshotSha256', 'databaseContractSha256', 'assetSha256'].map(key => [key, f.config.expected[key]])));
    f.write('host-dispatch-state.json', host);
    f.write('config.json', f.config);
    const endpoint = path.join(f.root, 'dispatcher.mjs');
    fs.writeFileSync(endpoint, endpointSource(f.root, options.simulateInitialOperator ? inspectForwardChildIdentity(process.pid) : null, options.offerVariant), { mode: 0o755 });
    const executable = file => ({ path: fs.realpathSync(file), sha256: sha(fs.readFileSync(file)) });
    const descriptor = { schema: options.localBuild ? 'nassaj-startup-admission-client/v2' : 'nassaj-startup-admission-client/v1', nodeInstanceId: f.identity.nodeInstanceId, profileId: measured?.material.profileId || 'local-forward-349/v2',
        dispatcher: executable(endpoint), sudo: executable('/usr/bin/sudo'), node: executable(process.execPath),
        ...(options.localBuild ? {artifact:{...localArtifact,build:manifest.build}} : {release: { repo: manifest.repo, releaseId: manifest.releaseId, assetId: 124, assetName: `nassaj-runtime-forward-v${manifest.version}.tar.gz`,
            assetSha256, manifestAssetId: 125, manifestAssetName: 'RELEASE_ASSET_MANIFEST.forward.json', manifestSha256: sha(JSON.stringify(manifest)),
            tag: manifest.tag, commit: manifest.commit, generationId: f.identity.generationId }}),
        startupClosureSha256: f.identity.startupClosureSha256, databaseContractSha256: f.identity.databaseContractSha256,
        databasePath: fs.realpathSync(database), databaseDev: f.identity.databaseDev, databaseIno: f.identity.databaseIno };
    if (measured && descriptor.profileId !== measured.build.profileId) throw Error('fixture_measured_profile_mismatch');
    if (options.phase === 'pre-migration') {
        const admission = f.read('startup-admission.json');
        const migrationJournal = f.read('first-cutover.json');
        migrationJournal.forwardAdmission = { generationEpoch: admission.generationEpoch, revision: admission.revision, sha256: sha(canonical(admission)) };
        f.write('first-cutover.json', migrationJournal);
    }
    f.write('descriptor.json', descriptor); fs.chmodSync(path.join(f.root, 'descriptor.json'), 0o644);
    const hook = path.join(f.root, 'fixture-hook.mjs'); fs.writeFileSync(hook, hookSource(f.root, descriptor, options.archiveBoundary));
    return { ...f, releaseRoot, descriptor, material, manifest,
        start: source => startChild(f.root, hook, source, childTimeoutMs),
        async waitForSecurity() {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) { if (f.read('startup-admission.json').securityStartup) return; await delay(10); }
            throw Error('fixture_security_timeout');
        } };
}
function endpointSource(root, operator, offerVariant) {
    return `import fs from 'node:fs';
import { mock as mutexMock } from 'node:test';
import { installFixedStateMutexAuthority } from ${JSON.stringify(new URL('./fixed-state-mutex-authority.mjs', import.meta.url).href)};
import { inspectForwardChildIdentity } from ${JSON.stringify(new URL('../lib/release-runtime-forward-child-protocol.mjs', import.meta.url).href)};
const operator=${JSON.stringify(operator)};
const inspectProcess=pid=>{const actual=inspectForwardChildIdentity(pid);
if(operator && ['pid','startTicks','bootId'].every(key=>actual[key]===operator[key]))return {...actual,uids:[0,0,0,0]};return actual;};
import { handleBootstrapStartupAdmission } from ${JSON.stringify(new URL('../lib/release-runtime-startup-admission.mjs', import.meta.url).href)};
import { readHostDispatcherInput } from ${JSON.stringify(new URL('../release-runtime-host-dispatcher.mjs', import.meta.url).href)};
const root = ${JSON.stringify(root)};
if (process.argv[2] !== 'claimBootstrapStartup' || process.argv.length !== 3) process.exit(78);
// This dispatcher is a real separate process: admission now runs under the fixed root state
// mutex, so it installs the same measured authority the parent test installed for itself.
installFixedStateMutexAuthority({ mock: mutexMock }, root, JSON.parse(fs.readFileSync(root + '/config.json')), { file: root + '/config.json' });
const observe = () => { const pid = process.ppid; const stat = fs.readFileSync('/proc/' + pid + '/stat','utf8');
const status = fs.readFileSync('/proc/' + pid + '/status','utf8');
return { uid: Number(/^Uid:\\s+(\\d+)/m.exec(status)[1]), pid, startTicks: stat.slice(stat.lastIndexOf(')')+2).trim().split(' ')[19],
bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim() }; };
try { const result = {...handleBootstrapStartupAdmission(JSON.parse(fs.readFileSync(root+'/config.json')), await readHostDispatcherInput(process.stdin), observe,
{ ownerUid: process.getuid(), effectiveUid: () => process.getuid(), readRootFile: file => fs.readFileSync(file), inspectProcess })};
if(result.reason==='initial_process_not_armed') fs.writeFileSync(root+'/initial-pending-observed.json',JSON.stringify({challenge:result.challenge,remainingMs:result.remainingMs,expiresAtBootMs:result.expiresAtBootMs}));
if(result.decision==='offered' && ${JSON.stringify(offerVariant)}==='wrong-mode'){result.mode='steady';delete result.initialTargetProcessSha256;delete result.startIntentSha256;}
if(result.decision==='offered' && ${JSON.stringify(offerVariant)}==='wrong-authority') result.authorityId='unrelated-authority';
process.stdout.write(JSON.stringify(result)); }
catch (error) { process.stderr.write(error.message); process.exitCode = 78; }
`;
}
function hookSource(root, descriptor, archiveBoundary) {
    return `import fs from 'node:fs'; import childProcess from 'node:child_process'; import path from 'node:path'; import { syncBuiltinESMExports } from 'node:module';
const root=${JSON.stringify(root)}, publicPath=${JSON.stringify(PUBLIC)}, actualDescriptor=path.join(root,'descriptor.json');
const original={lstat:fs.lstatSync,realpath:fs.realpathSync,open:fs.openSync,spawn:childProcess.spawn,read:fs.readFileSync};
const archiveBoundary=${JSON.stringify(archiveBoundary || null)};
if(archiveBoundary){
 const {restrictColdArchiveImports}=await import(${JSON.stringify(new URL('../../server/modules/database/__tests__/forward-cold-archive-input.mjs',import.meta.url).href)});
 restrictColdArchiveImports(archiveBoundary.root);
 const envFile=path.join(archiveBoundary.root,'.env');
 const readOnly=flags=>flags==='r'||(typeof flags==='number'&&(flags&3)===0&&!(flags&(fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)));
 fs.readFileSync=(file,...args)=>{if(file===envFile){if(!readOnly(args[0]?.flag??'r'))throw Error('cold_env_write_denied');file=archiveBoundary.envFile;}return original.read(file,...args);};
 fs.openSync=(file,flags,...args)=>{if(file===envFile){if(!readOnly(flags))throw Error('cold_env_write_denied');file=archiveBoundary.envFile;}return original.open(file,flags,...args);};
}

const operator='/usr/local/lib/nassaj-release-operator';
const pendingChildren=new Map();let stopping=false;
async function stopChildren(){if(stopping)return;stopping=true;const waiting=[...pendingChildren].map(async([child,closed])=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),500);try{await closed;}finally{clearTimeout(timer);}});await Promise.all(waiting);process.exit(0);}
process.once('SIGTERM',stopChildren);process.once('SIGINT',stopChildren);
const mapped=file=>file===publicPath?actualDescriptor:file==='/etc/nassaj'?root:typeof file==='string'&&(file===operator||file.startsWith(operator+'/'))?path.join(root,'installed-support',file.slice(operator.length)):file;
const trusted=new Set();
// Fixed descriptor/executable metadata is the explicit simulated-root seam, also inside a mapped user namespace.
for(const file of [publicPath,operator+'/scripts/release-runtime-host-dispatcher.mjs',${JSON.stringify(descriptor.dispatcher.path)},${JSON.stringify(descriptor.sudo.path)},${JSON.stringify(descriptor.node.path)}]) {
trusted.add(file);for(let parent=path.dirname(file);parent!==path.dirname(parent);parent=path.dirname(parent))trusted.add(parent);
}
fs.realpathSync=(file,...args)=>mapped(file)!==file?(original.realpath(mapped(file),...args),file):original.realpath(file,...args);
const mappedOpen=fs.openSync;fs.openSync=(file,...args)=>mappedOpen(mapped(file),...args);
fs.lstatSync=(file,...args)=>{const actual=mapped(file);
const value=original.lstat(actual,...args); if(file===publicPath||file===${JSON.stringify(descriptor.dispatcher.path)}||trusted.has(file)){
value.uid=0; value.mode=file===publicPath?(value.mode&~0o777)|0o644:value.mode&~0o022;}return value;};
childProcess.spawn=(file,args,options)=>{
if(file===${JSON.stringify(descriptor.sudo.path)}){if(stopping)throw Error('fixture_stopping');const dispatcher=JSON.parse(fs.readFileSync(actualDescriptor)).dispatcher.path;
if(![${JSON.stringify(descriptor.dispatcher.path)},operator+'/scripts/release-runtime-host-dispatcher.mjs'].includes(dispatcher)||JSON.stringify(args)!==JSON.stringify(['-n','--',dispatcher,'claimBootstrapStartup']))throw Error('fixture_unexpected_sudo');const prefix='/usr/local/lib/nassaj-release-operator/';
const actual=dispatcher.startsWith(prefix)?path.join(root,'installed-support',dispatcher.slice(prefix.length)):dispatcher;
const child=original.spawn(process.execPath,[actual,'claimBootstrapStartup'],options);const closed=new Promise(resolve=>child.once('close',resolve));pendingChildren.set(child,closed);closed.then(()=>pendingChildren.delete(child));return child;}return original.spawn(file,args,options);};
syncBuiltinESMExports();
`;
}
function startChild(root, hook, source, childTimeoutMs) {
    const entry = path.join(root, `child-${Date.now()}.mjs`); fs.writeFileSync(entry, source);
    const child = spawn(process.execPath, ['--import', hook, entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = new Promise((resolve, reject) => {
        let stdout = ''; let stderr = ''; const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Error('fixture_child_timeout')); }, childTimeoutMs);
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject); child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    });
    return { child, result };
}
