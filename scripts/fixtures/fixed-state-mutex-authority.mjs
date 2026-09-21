/** Test-only root ownership/path seam; kernel FD/flock, hashes, fsync and callbacks remain real. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {resolveForwardBashPath} from '../lib/release-runtime-forward-child-protocol.mjs';
import {syncBuiltinESMExports} from 'node:module';
export { isCutoverStateAcquisitionBusy } from '../lib/release-runtime-state-mutex.mjs';
import { stageFixtureInstalledSupport, attestFixtureInstalledConfig, writeMeasuredFile, FIXTURE_OPERATOR_ROOT, FIXTURE_ATTESTATION, FIXTURE_PUBLIC } from './installed-config-authority.mjs';

// One process-wide bottom layer instead of per-install wrappers. Nested `replace` chains
// restored in registration order (node runs `t.after` FIFO), which resurrected a dead
// fixture's wrapper whenever two authorities lived in the same test. The layer stack below
// is order independent: a released authority is spliced out wherever it sits, and with an
// empty stack every wrapper is a pure pass-through to the captured native call.
const NATIVE={lstat:fs.lstatSync,fstat:fs.fstatSync,open:fs.openSync,realpath:fs.realpathSync};
/** The real syscalls, for fixtures that must read this seam's own material as its true owner. */
export const NATIVE_FILE_SYSTEM=Object.freeze({lstatSync:NATIVE.lstat,fstatSync:NATIVE.fstat,openSync:NATIVE.open,realpathSync:NATIVE.realpath});
const layers=[];
const active=()=>layers[layers.length-1];
const zero=value=>typeof value==='bigint'?0n:0;
const key=info=>`${String(info.dev)}:${String(info.ino)}`;
function wire(){
    fs.lstatSync=(p,...a)=>{
        const layer=active(); if(!layer)return NATIVE.lstat(p,...a);
        const info=NATIVE.lstat(layer.map(p),...a);
        if(layer.owned(p)){
            info.uid=zero(info.uid); layer.ids.add(key(info));
            if(info.isDirectory()&&layer.ancestors.has(p)&&p!==layer.root){
                info.mode=typeof info.mode==='bigint'?info.mode&~0o022n:info.mode&~0o022;
            }
        }
        return info;
    };
    fs.fstatSync=(...a)=>{
        const layer=active(); const info=NATIVE.fstat(...a);
        if(layer&&layer.ids.has(key(info)))info.uid=zero(info.uid);
        return info;
    };
    fs.openSync=(p,...a)=>{
        const layer=active(); if(!layer)return NATIVE.open(p,...a);
        const fd=NATIVE.open(layer.map(p),...a);
        if(layer.owned(p))layer.ids.add(key(NATIVE.fstat(fd)));
        return fd;
    };
    const realpath=(p,...a)=>{
        const layer=active(); if(!layer)return NATIVE.realpath(p,...a);
        return layer.map(p)!==p?(NATIVE.realpath(layer.map(p),...a),p):NATIVE.realpath(p,...a);
    };
    realpath.native=NATIVE.realpath.native; fs.realpathSync=realpath;
}
// Wire at import so the seam is always the bottom layer: a later `t.mock.method` composes
// over it and restores cleanly, instead of clobbering it for the rest of the file.
wire();

/**
 * Publish a child process's own `node:fs` named exports while the natives are in place, so modules
 * that import `{ lstatSync }` keep the real ownership view the parent test process gives them.
 * The seam stays on the `fs` object itself, which is what the state mutex reads.
 */
export function withNativeBuiltinExports(apply) {
    const seam={lstatSync:fs.lstatSync,fstatSync:fs.fstatSync,openSync:fs.openSync,realpathSync:fs.realpathSync};
    Object.assign(fs,{lstatSync:NATIVE.lstat,fstatSync:NATIVE.fstat,openSync:NATIVE.open,realpathSync:NATIVE.realpath});
    try { apply(); syncBuiltinESMExports(); } finally { Object.assign(fs,seam); }
}

/** Install one fixture's measured authority at the production fixed CONFIG path, released with the test. */
export function installFixedStateMutexAuthority(t, root, config, options={}) {
    const fixed='/etc/nassaj/release-runtime-host.json';
    const local=options.file || path.join(root,'mutex-host.json');
    const forward = Boolean(config.bootstrapClaim || config.forwardActivation || config.forwardMigration || config.managedRestart);
    const support = forward ? stageFixtureInstalledSupport(root,fs.existsSync(path.join(root,'dispatcher.mjs'))?path.join(root,'dispatcher.mjs'):undefined) : null;
    const descriptorFile = path.join(root, 'descriptor.json');
    if (support) {
        config.bootstrapClaim ||= {};
        if (!config.bootstrapClaim.releaseManifestFile) {
            const manifestFile = path.join(root, 'mutex-release-manifest.json');
            const bytes = Buffer.from(JSON.stringify({ fixture: 'mutex-authority-only', identity: config.bootstrapClaim.identity || null }));
            writeMeasuredFile(manifestFile, bytes, 0o600);
            config.bootstrapClaim.releaseManifestFile = manifestFile;
            config.bootstrapClaim.releaseManifestSha256 = createHash('sha256').update(bytes).digest('hex');
        }
        // A config that carries a forward activation must carry its pinned shell too, or the
        // startup-authority producer rejects the very config this fixture just installed.
        const bash = resolveForwardBashPath();
        config.forwardActivation = { ...config.forwardActivation, dispatcher: support.dispatcher,
            bash: { path: bash, sha256: createHash('sha256').update(fs.readFileSync(bash)).digest('hex') } };
        Object.assign(config.bootstrapClaim, { dispatcherExecutable: support.dispatcher.path, dispatcherSha256: support.dispatcher.sha256 });
        const descriptor = fs.existsSync(descriptorFile) ? JSON.parse(fs.readFileSync(descriptorFile)) : {};
        descriptor.dispatcher = support.dispatcher; writeMeasuredFile(descriptorFile, JSON.stringify(descriptor), 0o644);
    }
    const ancestors=new Set(['/etc/nassaj','/etc','/usr','/usr/bin','/usr/local','/usr/local/lib']);
    for(let p=root;;p=path.dirname(p)){ancestors.add(p);if(p==='/')break;}
    const map=p=>p===fixed?local:p==='/etc/nassaj'?root:p===FIXTURE_ATTESTATION?path.join(root,'release-host-support-attestation.json')
        :p===FIXTURE_PUBLIC?descriptorFile:support&&typeof p==='string'&&(p===FIXTURE_OPERATOR_ROOT||p.startsWith(`${FIXTURE_OPERATOR_ROOT}/`))
            ?path.join(support.directory,p.slice(FIXTURE_OPERATOR_ROOT.length)):p;
    // `measuredOnly` projects root ownership onto exactly the material the root authority measures.
    // The default also projects the whole control root, which some suites rely on (they run with
    // ownerUid 0); but a fixture that keeps real service-owned data under the same root — a database,
    // a PM2 dump — must not have that ownership rewritten under it (`forward_prepare_database`).
    const direct=new Set([local,'/usr/bin/flock',fixed,path.join(root,'first-cutover-state.flock'),path.join(root,'first-cutover-state.lock'),
        path.join(root,'release-host-support-attestation.json'),descriptorFile]);
    if(config.bootstrapClaim?.releaseManifestFile)direct.add(config.bootstrapClaim.releaseManifestFile);
    const owned=p=>typeof p==='string'&&(map(p)!==p||direct.has(p)||ancestors.has(p)
        ||(!options.measuredOnly&&(p===root||p.startsWith(root+'/'))));
    Object.assign(config,{schema:'nassaj-release-runtime-host-config/v1',controlRoot:root,
        stateLock:{schema:'nassaj-cutover-state-lock/v2',flock:{path:'/usr/bin/flock',
            sha256:createHash('sha256').update(fs.readFileSync('/usr/bin/flock')).digest('hex')}}});
    writeMeasuredFile(local,JSON.stringify(config),0o600);
    if(support)attestFixtureInstalledConfig(root,support,local,descriptorFile);
    const euid=t.mock.method(process,'geteuid',()=>0);
    const layer={root,map,owned,ancestors,ids:new Set()};
    layers.push(layer);
    const release=()=>{const index=layers.indexOf(layer);if(index>=0)layers.splice(index,1);};
    if(t.after)t.after(release);else process.once('exit',release);
    return {file:local,release,
        // The production euid guard is ambient, so a test that asserts it must drop this seam first.
        restoreEffectiveUid:()=>euid.mock?.restore(),
        write:value=>{writeMeasuredFile(local,JSON.stringify(value),0o600);if(support)attestFixtureInstalledConfig(root,support,local,descriptorFile);}};
}
