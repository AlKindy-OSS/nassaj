/** Preserve existing control-lock permissions in a fresh recovery fixture. */
import fs from 'node:fs';
import path from 'node:path';

const names=['nassaj-preview-event-mutation.lock','nassaj-local-preview-build.lock','nassaj-client-build.lock'];
const safeMode=mode=>Number.isInteger(mode)&&mode>=0&&mode<=0o777&&(mode&0o022)===0&&(mode&0o600)===0o600;

/** Inspect only regular, owned baseline locks; never repair their permissions. */
export function captureRecoveryLockBaseline(directory) {
    if(fs.realpathSync(directory)!==directory)throw Error('recovery_lock_directory_unsafe');
    const locks=names.map(name=>{
        const file=path.join(directory,name),stat=fs.lstatSync(file),mode=stat.mode&0o7777;
        if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||!safeMode(mode))throw Error('recovery_lock_baseline_unsafe');
        return {name,mode,uid:stat.uid,gid:stat.gid,dev:stat.dev,ino:stat.ino};
    });
    return {schema:'nassaj-recovery-lock-baseline/v1',directory,locks};
}

/** Create empty, exclusive fixture locks; existing entries are never overwritten or chmodded. */
export function initializeRecoveryLockBaseline(directory,baseline) {
    if(fs.realpathSync(directory)!==directory||directory===baseline?.directory)throw Error('recovery_lock_destination_unsafe');
    if(baseline?.schema!=='nassaj-recovery-lock-baseline/v1'||baseline.locks?.length!==names.length
        ||baseline.locks.some((lock,index)=>lock.name!==names[index]||lock.uid!==process.getuid()||!safeMode(lock.mode)))throw Error('recovery_lock_baseline_unsafe');
    for(const name of names) {
        try {fs.lstatSync(path.join(directory,name));throw Error('recovery_lock_destination_exists');}
        catch(error){if(error.code!=='ENOENT')throw error;}
    }
    for(const lock of baseline.locks) {
        const fd=fs.openSync(path.join(directory,lock.name),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,lock.mode);
        // Only this newly created descriptor is adjusted, preserving exact mode under any inherited umask.
        try {fs.fchmodSync(fd,lock.mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    return captureRecoveryLockBaseline(directory);
}
