import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {measureRecoveryTree,recoveryLabCapacity} from './local-source-recovery-preflight.mjs';
import {recoveryLabPhases} from './local-source-recovery-preflight.mjs';
import {assertClientPublicationCapacity} from '../lib/client-publication-archive.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const input={availableBytes:100*1024**3,sourceBytes:100,dependencyBytes:1000,artifactBytes:50,cacheBytes:500,publicMaterialBytes:25,livePreparationBytes:3000};

test('capacity refuses one byte short and includes both candidates and rollback generations',()=>{
    const value=recoveryLabCapacity(input);
    assert.equal(value.allocations.firstCandidate,2350);
    assert.equal(value.allocations.secondCandidate,2350);
    assert.equal(value.allocations.firstRollbackBackup,1050);
    assert.equal(value.allocations.secondRollbackBackup,1050);
    assert.equal(value.allocations.livePreparation,3000);
    assert.equal(recoveryLabCapacity({...input,availableBytes:value.requiredBytes}).allowed,true);
    assert.equal(recoveryLabCapacity({...input,availableBytes:value.requiredBytes-1}).allowed,false);
});

test('capacity refuses omitted, negative, fractional and unsafe measurements',()=>{
    for(const name of Object.keys(input))for(const invalid of [undefined,-1,NaN,Infinity,0.1,Number.MAX_SAFE_INTEGER+1])
        assert.throws(()=>recoveryLabCapacity({...input,[name]:invalid}),/capacity_invalid/);
});

test('measurement counts small-file allocation without following outside symlinks',t=>{
    const directory=fs.mkdtempSync(path.join(root,'.artifacts/local-recovery-size-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    fs.writeFileSync(path.join(directory,'small'),'x');fs.writeFileSync(path.join(directory,'block-plus-one'),Buffer.alloc(4097));
    fs.symlinkSync('/unreachable-and-never-read',path.join(directory,'alias'));
    const value=measureRecoveryTree(directory);
    assert.equal(value.files,2);assert.equal(value.directories,1);assert.equal(value.links,1);
    assert.equal(value.allocatedCopyBytes,4096*5);
    assert.equal(value.apparentBytes,4098+Buffer.byteLength('/unreachable-and-never-read'));
});

test('phased budget counts real dependency exchange only after archive and one reserve per phase',()=>{
    const report=recoveryLabPhases({...input,incomingClientAssetBytes:40});
    const first=report.phases.laboratoryFirstBoot.allocations,next=report.phases.laboratoryNextActivation.allocations;
    assert.equal(first.retainedLiveCandidate,1150);assert.equal(first.labFirstCandidate,1150);
    assert.equal(Object.hasOwn(first,'firstRollbackBackup'),false);
    assert.equal(next.secondDependencyExchangeClone,1000);assert.equal(next.secondSealedDependencies,1000);
    const archive=report.phases.laboratoryNextArchivePreparation.allocations;
    assert.equal(archive.reserve,16*1024**3);assert.equal(archive.archiveIncomingHeadroom,120);
    assert.equal(Object.hasOwn(archive,'secondDependencyExchangeClone'),false);
    for(const [name,phase] of Object.entries(report.phases))if(name!=='laboratoryNextArchivePreparation')assert.equal(phase.allocations.reserve,2*1024**3);
});

test('budget previously sufficient for build and exchange refuses the actual archive gate',()=>{
    const report=recoveryLabPhases({...input,incomingClientAssetBytes:40});
    const oldRequired=Math.max(...Object.entries(report.phases).filter(([name])=>name!=='laboratoryNextArchivePreparation').map(([,phase])=>phase.requiredBytes));
    const constrained=recoveryLabPhases({...input,incomingClientAssetBytes:40,availableBytes:oldRequired});
    assert.equal(constrained.phases.laboratoryNextBuild.allowed,true);
    assert.equal(constrained.phases.laboratoryNextActivation.allowed,true);
    assert.equal(constrained.phases.laboratoryNextArchivePreparation.allowed,false);
});

test('archive phase boundary matches actual production default without double counting reserves',t=>{
    const directory=fs.mkdtempSync(path.join(root,'.artifacts/recovery-archive-boundary-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const incoming=1234,report=recoveryLabPhases({...input,incomingClientAssetBytes:incoming});
    const phase=report.phases.laboratoryNextArchivePreparation;
    const beforeGate=phase.requiredBytes-phase.allocations.reserve-phase.allocations.archiveIncomingHeadroom;
    const original=fs.statfsSync;
    try {
        for(const difference of [-1,0,1]) {
            const availableBytes=phase.requiredBytes+difference,freeAtGate=availableBytes-beforeGate;
            fs.statfsSync=()=>({bavail:freeAtGate,bsize:1});
            const modeled=recoveryLabPhases({...input,incomingClientAssetBytes:incoming,availableBytes}).phases.laboratoryNextArchivePreparation;
            if(difference<0){assert.equal(modeled.allowed,false);assert.throws(()=>assertClientPublicationCapacity(directory,incoming),/capacity_exceeded/);}
            else {assert.equal(modeled.allowed,true);assert.equal(assertClientPublicationCapacity(directory,incoming).reserveBytes,phase.allocations.reserve);}
        }
    } finally {fs.statfsSync=original;}
});

test('archive measurement must be present, finite, safe and within the production asset limit',()=>{
    for(const incomingClientAssetBytes of [undefined,-1,NaN,Infinity,0.1,1024**3+1])
        assert.throws(()=>recoveryLabPhases({...input,incomingClientAssetBytes}),/archive_measurement_invalid/);
});

test('first-boot scope budgets only its executed phase while full default still refuses missing archive reserve',()=>{
    const measurement={...input,incomingClientAssetBytes:40},full=recoveryLabPhases(measurement);
    const availableBytes=full.phases.laboratoryFirstBoot.requiredBytes;
    const first=recoveryLabPhases({...measurement,availableBytes,rehearsalScope:'first-boot-only'});
    assert.equal(first.rehearsalScope,'first-boot-only');assert.deepEqual(Object.keys(first.phases),['laboratoryFirstBoot']);
    assert.equal(first.phases.laboratoryFirstBoot.allowed,true);
    assert.deepEqual(first.phases.laboratoryFirstBoot.allocations,full.phases.laboratoryFirstBoot.allocations);
    assert.equal(first.phases.laboratoryFirstBoot.allocations.privateNpmCache,input.cacheBytes);
    const defaultFull=recoveryLabPhases({...measurement,availableBytes});
    assert.equal(defaultFull.rehearsalScope,'full');assert.equal(defaultFull.phases.laboratoryNextArchivePreparation.allowed,false);
    assert.equal(defaultFull.phases.laboratoryNextArchivePreparation.allocations.reserve,16*1024**3);
    assert.equal(recoveryLabPhases({...measurement,availableBytes:availableBytes-1,rehearsalScope:'first-boot-only'}).phases.laboratoryFirstBoot.allowed,false);
    assert.throws(()=>recoveryLabPhases({...measurement,rehearsalScope:'first'}),/scope_invalid/);
});
