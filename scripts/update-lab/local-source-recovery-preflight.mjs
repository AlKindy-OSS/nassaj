/** Read-only capacity and boundary checks for the source-recovery/full-next-update rehearsal. */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {probeTripleIsolation} from './triple-rehearsal.mjs';
import {recoveryLabScope} from './local-source-recovery-scope.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const GiB=1024**3;
// Contract: scripts/lib/client-publication-archive.mjs assertClientPublicationCapacity default.
// The actual production guard is exercised by the boundary contract test; do not lower this for a lab.
const archiveReserve=16*GiB;

/** Account for copy allocation (including small files), without following aliases or sparse extents. */
export function measureRecoveryTree(directory) {
    const result={apparentBytes:0,allocatedCopyBytes:0,files:0,directories:0,links:0};
    function walk(file) {
        const stat=fs.lstatSync(file);
        if(stat.isSymbolicLink()){result.links++;result.apparentBytes+=stat.size;result.allocatedCopyBytes+=4096;return;}
        if(stat.isDirectory()){result.directories++;result.allocatedCopyBytes+=4096;for(const name of fs.readdirSync(file))walk(path.join(file,name));return;}
        if(!stat.isFile())throw Error('local_recovery_lab_special_file');
        result.files++;result.apparentBytes+=stat.size;result.allocatedCopyBytes+=Math.ceil(stat.size/4096)*4096;
    }
    walk(directory);return result;
}

/** Conservatively retain both candidates and backups, so success does not depend on cleanup. */
export function recoveryLabCapacity(input) {
    const names=['availableBytes','sourceBytes','dependencyBytes','artifactBytes','cacheBytes','publicMaterialBytes','livePreparationBytes'];
    for(const name of names)if(!Number.isSafeInteger(input[name])||input[name]<0)throw Error(`local_recovery_lab_capacity_invalid:${name}`);
    const {sourceBytes:S,dependencyBytes:D,artifactBytes:A}=input;
    const allocations={
        livePreparation:input.livePreparationBytes,
        oldPrivateRuntime:D+A+S,
        firstCandidate:S*2+D*2+A*3,
        firstRollbackBackup:D+A,
        secondCandidate:S*2+D*2+A*3,
        secondRollbackBackup:D+A,
        privateNpmCache:input.cacheBytes,
        publicInstallMaterial:input.publicMaterialBytes,
        retainedClientAssets:A*2,
        rootfsMetadataLogsAndFixtureDatabase:256*1024**2,
        reserve:2*GiB,
    };
    const requiredBytes=Object.values(allocations).reduce((a,b)=>a+b,0);
    return {schema:'nassaj-local-source-recovery-lab-capacity/v1',allocations,requiredBytes,
        availableBytes:input.availableBytes,remainingBytes:input.availableBytes-requiredBytes,
        allowed:input.availableBytes>=requiredBytes,
        basis:'Conservative simultaneous retention; source/candidate installation and build copies counted independently.'};
}

/** Inspect present filesystem inputs; this never materializes candidate files or reads any runtime database. */
export function inspectRecoveryLab({expectedOid=null,livePreparationBytes,cacheRoot,publicMaterialRoot}) {
    if(expectedOid!==null&&!/^[a-f0-9]{40}$/.test(expectedOid))throw Error('local_recovery_lab_exact_oid_required');
    const git=args=>execFileSync('/usr/bin/git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024**2}).trim();
    if(git(['symbolic-ref','HEAD'])!=='refs/heads/main')throw Error('local_recovery_lab_main_required');
    const oid=git(['rev-parse','HEAD']);if(expectedOid&&oid!==expectedOid)throw Error('local_recovery_lab_main_changed');
    const sourceBytes=git(['ls-tree','-rlz',oid]).split('\0').filter(Boolean).reduce((sum,row)=>{
        const match=row.match(/^\d+ blob [a-f0-9]+\s+(\d+)\t/);if(!match)throw Error('local_recovery_lab_source_entry');
        return sum+Math.ceil(Number(match[1])/4096)*4096+4096;
    },0);
    const dependencies=measureRecoveryTree(path.join(root,'node_modules'));
    const server=measureRecoveryTree(path.join(root,'dist-server')),client=measureRecoveryTree(path.join(root,'dist'));
    const cache=measureRecoveryTree(cacheRoot),publicMaterial=measureRecoveryTree(publicMaterialRoot);
    const storage=fs.statfsSync(root);if(Number(storage.type)===0x01021994)throw Error('local_recovery_lab_tmpfs_forbidden');
    const capacity=recoveryLabCapacity({availableBytes:storage.bavail*storage.bsize,sourceBytes,
        dependencyBytes:dependencies.allocatedCopyBytes,artifactBytes:server.allocatedCopyBytes+client.allocatedCopyBytes,
        cacheBytes:cache.allocatedCopyBytes,publicMaterialBytes:publicMaterial.allocatedCopyBytes,livePreparationBytes});
    return {observedAt:new Date().toISOString(),oid,finalOidPinned:expectedOid!==null,dependencies,server,client,cache,publicMaterial,capacity,
        state:expectedOid===null?'awaiting_final_oid':capacity.allowed?'preflight_only':'blocked_capacity',
        limitations:['No cache completeness claim; offline npm ci must prove it.','No full boot or candidate build has run.','Live preparation budget must be remeasured before materialization.']};
}

/** Reuse the approved isolation probe; this creates only small synthetic scratch files. */
export function probeRecoveryLabIsolation() {
    const result=probeTripleIsolation();
    if(result.status!==0)throw Error(`local_recovery_lab_isolation_failed:${result.stderr}`);
    return {...result,proof:JSON.parse(result.stdout.trim())};
}

/** Model real rename/exchange lifetimes; first candidate remains outside lab as the reviewed production artifact. */
export function recoveryLabPhases(input) {
    const rehearsalScope=recoveryLabScope(input.rehearsalScope);
    recoveryLabCapacity({...input,livePreparationBytes:0});
    if(!Number.isSafeInteger(input.incomingClientAssetBytes)||input.incomingClientAssetBytes<0||input.incomingClientAssetBytes>GiB)
        throw Error('local_recovery_lab_archive_measurement_invalid');
    const {sourceBytes:S,dependencyBytes:D,artifactBytes:A,cacheBytes:C,publicMaterialBytes:P}=input;
    const reserve=2*GiB,overhead=256*1024**2;
    const retainedCandidate=S+D+A;
    const shared={retainedLiveCandidate:retainedCandidate,privateOldRuntime:S+D+A,
        labFirstCandidate:S+D+A,privateNpmCache:C,publicInstallMaterial:P,
        retainedClientAssets:2*A,rootfsLogsTlsFixtureDatabase:overhead,reserve};
    const phases={
        buildLiveCandidate:{sourceAndInstalledDependencies:S+D,artifactBuildPeak:3*A,privateNpmCache:C,installTransientAllowance:D,metadata:overhead,reserve},
        laboratoryFirstBoot:{...shared},
        laboratoryNextBuild:{...shared,secondSourceAndSnapshot:2*S,secondDependencies:D,secondArtifactBuildPeak:3*A,installTransientAllowance:D},
        laboratoryNextArchivePreparation:{...shared,reserve:archiveReserve,secondSourceAndSnapshot:2*S,
            secondSealedDependencies:D,secondArtifacts:A,archiveIncomingHeadroom:3*input.incomingClientAssetBytes},
        laboratoryNextActivation:{...shared,secondSourceAndSnapshot:2*S,secondSealedDependencies:D,secondArtifacts:A,secondDependencyExchangeClone:D},
        liveActivationAfterOwnedLabCleanup:{retainedLiveCandidate:retainedCandidate,snapshotBudget:64*1024**2,metadata:overhead,reserve},
    };
    return {schema:'nassaj-local-source-recovery-phased-capacity/v2',availableBytes:input.availableBytes,rehearsalScope,
        archiveContract:{source:'scripts/lib/client-publication-archive.mjs:assertClientPublicationCapacity',
            reserveBytes:archiveReserve,incomingClientAssetBytes:input.incomingClientAssetBytes,incomingMultiplier:3},
        phases:Object.fromEntries(Object.entries(phases).filter(([name])=>rehearsalScope==='full'||name==='laboratoryFirstBoot').map(([name,allocations])=>{
            const requiredBytes=Object.values(allocations).reduce((a,b)=>a+b,0);
            return [name,{allocations,requiredBytes,remainingBytes:input.availableBytes-requiredBytes,allowed:input.availableBytes>=requiredBytes}];
        })),
        assumptions:['D/A are provisional until exact sealed candidate allocation is measured; no heavy action is authorized by this estimate.',
            'Source activation uses mv --exchange --no-copy; previous trees replace candidate slots, no separate tree backup copy.',
            'Both producers move staged node_modules into candidate slots; no retained source dependency duplicate.',
            'Triple activation creates one real dependency-exchanges copy in addition to sealed dependency-candidates.',
            'Archive preparation precedes dependency exchange; its 16 GiB default reserve replaces, never adds to, the 2 GiB general reserve.',
            'The next private fixture commit changes only one non-client marker file. Sealed client inventory bounds its unchanged assets; different next inputs require fresh measurement and budgeting.',
            'Live candidate bytes remain untouched; laboratory manifest binds copies to its own real linked worktree and old process.',
            'Only this task owned lab scratch may be removed after evidence export; no pre-existing baseline cleanup.']};
}
