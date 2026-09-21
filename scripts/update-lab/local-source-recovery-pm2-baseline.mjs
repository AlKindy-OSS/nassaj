/** Private PM2 dump fixture baseline; live dump contents are never copied into the lab. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Capture regular, owned, private dump identity without exposing saved process environments. */
export function captureRecoveryPm2DumpBaseline(home) {
    if(!path.isAbsolute(home)||fs.realpathSync(home)!==home)throw Error('recovery_pm2_home_unsafe');
    const file=path.join(home,'dump.pm2'),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.nlink!==1
        ||(stat.mode&0o7777)!==0o600)throw Error('recovery_pm2_dump_baseline_unsafe');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {
        const held=fs.fstatSync(fd),bytes=fs.readFileSync(fd),after=fs.lstatSync(file);
        for(const key of ['dev','ino','uid','nlink','mode','size','mtimeMs','ctimeMs'])
            if(stat[key]!==held[key]||stat[key]!==after[key])throw Error('recovery_pm2_dump_baseline_changed');
        return {schema:'nassaj-recovery-pm2-dump-baseline/v1',file,dev:stat.dev,ino:stat.ino,
            uid:stat.uid,nlink:stat.nlink,mode:stat.mode&0o7777,size:bytes.length,sha256:sha(bytes)};
    }finally{fs.closeSync(fd);}
}

/** Recheck the same live identity immediately before launching an isolated recovery rehearsal. */
export function assertRecoveryPm2DumpBaseline(baseline) {
    if(baseline?.schema!=='nassaj-recovery-pm2-dump-baseline/v1'||typeof baseline.file!=='string')throw Error('recovery_pm2_dump_baseline_invalid');
    const current=captureRecoveryPm2DumpBaseline(path.dirname(baseline.file));
    if(JSON.stringify(current)!==JSON.stringify(baseline))throw Error('recovery_pm2_dump_baseline_changed');
    return current;
}

/** Exclusively seed empty JSON in a fresh private PM2 home before its first start or save. */
export function initializeRecoveryPm2Dump(home,baseline) {
    assertRecoveryPm2DumpBaseline(baseline);
    if(!path.isAbsolute(home)||fs.realpathSync(home)!==home||path.join(home,'dump.pm2')===baseline.file)throw Error('recovery_pm2_destination_unsafe');
    const parent=fs.lstatSync(home);
    if(!parent.isDirectory()||parent.uid!==process.getuid()||(parent.mode&0o7777)!==0o700)throw Error('recovery_pm2_destination_unsafe');
    const fd=fs.openSync(path.join(home,'dump.pm2'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try {fs.writeFileSync(fd,'[]\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    return captureRecoveryPm2DumpBaseline(home);
}
