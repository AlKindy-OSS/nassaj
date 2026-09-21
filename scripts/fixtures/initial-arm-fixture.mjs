import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture } from './startup-admission-fixture.mjs';
import { samplePm2Clock } from '../lib/pm2-typed-mutation.mjs';
import { armInitialProcess, makeInitialStartWindow } from '../lib/release-runtime-forward-supervisor.mjs';
import { inspectForwardChildIdentity, forwardValueSha256 as sha } from '../lib/release-runtime-forward-child-protocol.mjs';

// Only root file ownership and PM2 observations are seams. Signatures, journal CAS/fsync,
// child /proc identity and the admission handler are production code; no host PM2 is contacted.
export async function setupInitialArmFixture(t, options = {}) {
    const f = options.fixture || fixture(t, 'cutover'); const inodes = new Set();
    const lstat = fs.lstatSync, fstat = fs.fstatSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
        const info = lstat(file, ...args);
        if (String(file).startsWith(f.root)) { info.uid = 0; inodes.add(info.ino); }
        return info;
    });
    t.mock.method(fs, 'fstatSync', (...args) => { const info = fstat(...args); if (inodes.has(info.ino)) info.uid = 0; return info; });
    f.deps.ownerUid = 0; f.deps.effectiveUid = () => 0;
    const children = [];
    t.after(async () => { for (const child of children) { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; } } });
    const child = async () => { const value = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: f.root, stdio: 'ignore' }); children.push(value); await once(value, 'spawn'); return value; };
    const worker = options.workerChild || await child(), target = options.targetChild || await child();
    // B-920: a user namespace can map several distinct host groups to the same overflow GID.
    // Model membership as a set on BOTH sides of this fixture-only credential seam.
    // PID/start/boot and every other /proc field remain real; production validators are unchanged.
    const groupSet = [...new Set(process.getgroups())].sort((a, b) => a - b);
    if (groupSet.length !== process.getgroups().length) {
        // The separate signed-root endpoint fixture needs the same membership projection.
        const endpoint = path.join(f.root, 'dispatcher.mjs');
        if (fs.existsSync(endpoint)) {
            const marker = 'const inspectProcess=pid=>{const actual=inspectForwardChildIdentity(pid);';
            const source = fs.readFileSync(endpoint, 'utf8');
            if (source.split(marker).length !== 2) throw Error('fixture_group_endpoint_shape_changed');
            fs.writeFileSync(endpoint, source.replace(marker, marker + 'actual.supplementaryGids=[...new Set(actual.supplementaryGids)].sort((a,b)=>a-b);'));
            const descriptor = f.read('descriptor.json');
            descriptor.dispatcher.sha256 = createHash('sha256').update(fs.readFileSync(endpoint)).digest('hex');
            f.write('descriptor.json', descriptor);
            if (f.descriptor) f.descriptor.dispatcher.sha256 = descriptor.dispatcher.sha256;
        }
        const readFile = fs.readFileSync; const owned = new Set([process.pid, worker.pid, target.pid]);
        t.mock.method(fs, 'readFileSync', (file, ...args) => {
            const value = readFile(file, ...args); const match = typeof file === 'string' && /^\/proc\/([0-9]+)\/status$/.exec(file);
            if (!match || !owned.has(Number(match[1]))) return value;
            const text = value.toString().replace(/^Groups:\s*(.*)$/m, (_line, groups) =>
                `Groups:\t${[...new Set(groups.trim().split(/\s+/).filter(Boolean).map(Number))].sort((a, b) => a - b).join(' ')} `);
            return Buffer.isBuffer(value) ? Buffer.from(text) : text;
        });
    }
    const operator = inspectForwardChildIdentity(process.pid), observed = inspectForwardChildIdentity(target.pid);
    f.config.forwardMigration.serviceIdentity = { uid: process.getuid(), gid: process.getgid(), supplementaryGids: groupSet };
    f.config.oldProcess = { pid: 1, startTicks: '1' };
    Object.assign(f.caller, { uid: process.getuid(), pid: target.pid, startTicks: observed.startTicks, bootId: observed.bootId });
    f.deps.inspectProcess = pid => { const actual = inspectForwardChildIdentity(pid); return pid === process.pid ? { ...actual, uids: [0,0,0,0] } : actual; };
    f.deps.bootMs = () => Math.floor(Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0])*1000);
    const transactionId = f.read('first-cutover.json').transactionId;
    const intent = { transactionId, phase:'start', attemptId:'attempt-one', attemptNonce:'a'.repeat(64), operator:{pid:operator.pid,startTicks:operator.startTicks,bootId:operator.bootId} };
    const descriptor = { name:'fixture',namespace:'fixture',pm_exec_path:'/fixture/app.mjs',pm_cwd:'/fixture',exec_interpreter:'/usr/bin/node',exec_mode:'fork_mode',
        uid:process.getuid(),gid:process.getgid(),pm_out_log_path:'/fixture/out',pm_err_log_path:'/fixture/err',pm_pid_path:'/fixture/pid',status:'stopped',autostart:true,
        autorestart:false,watch:false,pmx:false,vizion:false,wait_ready:false,restart_time:0,unstable_restarts:0,prev_restart_delay:0,env:{} };
    const uuid='12345678-1234-4234-8234-123456789abc';
    const baseline={...descriptor,env:{unique_id:uuid},pm_id:44,vizion_running:false};
    const daemon={pid:999,startTicks:'1',bootId:operator.bootId};
    const binding={schema:'nassaj-prepared-pm2-slot/v1',operationId:transactionId,attemptId:intent.attemptId,
        daemonIdentitySha256:sha(daemon),namespaceSha256:sha('fixture'),targetDescriptorSha256:sha(descriptor),allocatedPmId:44,preparedEntrySha256:sha(baseline)};
    const frame={schema:'nassaj-pm2-execution-intent/v1',operationId:transactionId,attemptId:intent.attemptId,attemptNonce:intent.attemptNonce,
        step:'start-target',expectedSlotDigest:sha(baseline),daemonIdentitySha256:sha(daemon),slotDigest:sha(baseline),payloadDigest:sha(44),requestId:'c'.repeat(32)};
    const journal={...f.read('first-cutover.json'),phase:'target_start_intent',startupClaim:{state:'awaiting_process'},forwardAdmission:{generationEpoch:1},
        forwardSupervisorIntent:intent,forwardSupervisorAttempts:[{attemptId:intent.attemptId,attemptNonce:intent.attemptNonce,
            worker:inspectForwardChildIdentity(worker.pid),steps:[{step:'start-target',state:'possibly_sent',intent:frame}]}],targetSlotBinding:binding};
    delete journal.initialTargetProcess;
    const window=makeInitialStartWindow(journal,intent,frame); journal.initialStartWindow=window;
    f.write('first-cutover.json',journal); const state=f.read('startup-admission.json'); delete state.initialTargetProcessSha256; f.write('startup-admission.json',state);
    f.write('first-cutover.lock',{schema:'nassaj-cutover-lock/v1',pid:process.pid,startTime:operator.startTicks});
    const clock=samplePm2Clock();
    const env={...baseline,status:'online',unique_id:uuid,version:'fixture',created_at:clock.wall,pm_uptime:clock.wall,
        axm_actions:[],axm_monitor:{},axm_options:{},axm_dynamic:{}};
    const context={observer:{},targetDescriptor:descriptor,slot:{baseline},metadata:{version:'fixture',nodeVersion:process.versions.node}};
    const observation={daemon,observationSha256:'d'.repeat(64)};
    const response={observation,privateEntries:[{pid:target.pid,pm_id:44,pm2_env:env}]};
    return {...f,intent,worker,target,context,window,clock,response,
        arm: observePrivateRuntime => armInitialProcess(f.config,intent,worker,context,window,clock,{observePrivateRuntime:observePrivateRuntime|| (async()=>response)})};
}
