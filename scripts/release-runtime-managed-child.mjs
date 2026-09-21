#!/usr/bin/env node
/** Fixed service child: root-private verification, exact privilege drop, kernel-ready, one-use permit, then safe script. */
import fs from 'node:fs';
import { readInstalledHostConfiguration } from './lib/release-runtime-installed-config.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readPinnedPm2RuntimeMetadata } from './lib/pm2-readonly-observer.mjs';
import { applyPinnedPm2Operation } from './lib/pm2-typed-mutation.mjs';
import { readManagedRootFile, readVerifiedManagedRestart, verifyManagedRestartExecutable, managedCanonical } from './lib/release-runtime-managed-admission.mjs';
import { assertForwardFrameKeys, assertForwardServiceIdentity, dropForwardChildPrivileges,
    inspectForwardChildIdentity, readForwardPermitFrame } from './lib/release-runtime-forward-child-protocol.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
function deny(reason) { throw Error(`managed_child_${reason}`); }
/** Read and pin the fixed child inputs before losing root access. No full private config crosses the pipes. */
export function readManagedChildMaterial() {
    if (process.geteuid?.() !== 0 || process.argv.length !== 2) deny('invocation_invalid');
    const config = readInstalledHostConfiguration().value;
    const settings = config.managedRestart;
    const record = JSON.parse(readManagedRootFile(path.join(config.controlRoot, 'managed-restart.json')));
    const journal = readVerifiedManagedRestart(config, record.operationId);
    if (!['ingress_closed', 'prepared'].includes(journal.phase) || !journal.launchIntent
        || !['check','execute'].includes(journal.launchIntent.kind)) deny('launch_intent_missing');
    for (const [file, digest] of [[settings.nodeExecutable, settings.nodeSha256], [settings.bashPath, settings.bashSha256],
        [settings.safeRestartPath, settings.safeRestartSha256], [settings.managedClientPath, settings.managedClientSha256],
        [settings.wrapper.path, settings.wrapper.sha256], [settings.closure.path, settings.closure.sha256]]) verifyManagedRestartExecutable(file, digest);
    if (settings.wrapper.path !== fileURLToPath(import.meta.url) || fs.realpathSync(process.execPath) !== settings.nodeExecutable) deny('wrapper_placement_invalid');
    const closure = JSON.parse(fs.readFileSync(settings.closure.path)); assertForwardFrameKeys(closure, 'schema,files');
    if (closure.schema !== 'nassaj-forward-child-closure/v1' || !Array.isArray(closure.files)) deny('closure_invalid');
    let previous = ''; const files = new Set();
    for (const item of closure.files) {
        assertForwardFrameKeys(item, 'path,sha256'); if (item.path <= previous) deny('closure_order_invalid');
        verifyManagedRestartExecutable(item.path, item.sha256); previous = item.path; files.add(item.path);
    }
    for (const file of [settings.wrapper.path, settings.nodeExecutable, settings.safeRestartPath, settings.managedClientPath,
        fileURLToPath(new URL('./lib/release-runtime-managed-admission.mjs', import.meta.url)),
        fileURLToPath(new URL('./lib/pm2-typed-mutation.mjs', import.meta.url)),
        fileURLToPath(new URL('./lib/pm2-readonly-observer.mjs', import.meta.url)),
        fileURLToPath(new URL('./lib/release-runtime-forward-child-protocol.mjs', import.meta.url))]) if (!files.has(file)) deny('closure_incomplete');
    return { attemptId:journal.attempts.at(-1).attemptId, operationId: journal.operationId, nonce: journal.launchIntent.nonce, kind: journal.launchIntent.kind,
        launchIntentSha256: sha(managedCanonical(journal.launchIntent)), serviceIdentity: settings.serviceIdentity,
        bashPath: settings.bashPath, safeRestartPath: settings.safeRestartPath,
        mutation: {...settings.mutation,slot:{...settings.mutation.slot,process:journal.oldProcess},
            metadata:readPinnedPm2RuntimeMetadata(settings.mutation.metadata),observer:settings.pm2Observer,attemptNonce:journal.launchIntent.nonce,permitChannel:{requestFd:5,responseFd:6}},
        cwd: settings.generationRoot, home: settings.home, operator: journal.operator };
}
/** Run one exact FD3/FD4 handshake; stdout and stderr are diagnostics only. */
export async function runManagedRestartChild(deps = {}) {
    const material = (deps.material || readManagedChildMaterial)();
    const identity = (deps.drop || dropForwardChildPrivileges)(material.serviceIdentity);
    const ready = { schema: 'nassaj-managed-child-ready/v1', operationId: material.operationId, nonce: material.nonce,
        challenge: randomBytes(32).toString('hex'), launchIntentSha256: material.launchIntentSha256,
        pid: identity.pid, startTicks: identity.startTicks, bootId: identity.bootId };
    const input = deps.input || fs.createReadStream(null, { fd: 3, autoClose: true });
    const output = deps.output || fs.createWriteStream(null, { fd: 4, autoClose: true });
    try {
        await new Promise((resolve, reject) => { output.once('error', reject); output.end(`${JSON.stringify(ready)}\n`, resolve); });
        const permit = await readForwardPermitFrame(input);
        assertForwardFrameKeys(permit, 'schema,operationId,nonce,challenge,launchIntentSha256,pid,startTicks,bootId,decision');
        if (permit.schema !== 'nassaj-managed-child-permit/v1' || permit.decision !== 'authorized'
            || Object.keys(ready).filter(key => key !== 'schema').some(key => permit[key] !== ready[key])) deny('permit_mismatch');
        const inspect = deps.inspect || inspectForwardChildIdentity; const current = inspect(identity.pid);
        assertForwardServiceIdentity(current, material.serviceIdentity);
        const parent = inspect(current.parentPid);
        if (parent.pid !== material.operator.pid || parent.startTicks !== material.operator.startTicks || parent.bootId !== material.operator.bootId) deny('parent_changed');
        return await executeManagedWorker(material,deps);
    } finally { input.destroy(); output.destroy(); }
}
/** Keep drain and mutation in the same pinned worker; never invoke a mutation for a deferred drain. */
export async function executeManagedWorker(material, deps = {}) {
    const drained=await (deps.runScript||runScript)(material);
    if(material.kind!=='execute'||drained.code===75)return drained;
    if(drained.code!==0||!drained.result||drained.result.outcome!=='ready')deny('drain_unproven');
    const request={operationId:material.operationId,attemptId:material.attemptId,step:'restart-same',
        expectedSlotDigest:material.mutation.slot.entrySha256};
    const receipt=await (deps.applyMutation||applyPinnedPm2Operation)(request,material.mutation);
    return {code:0,signal:null,result:{schema:'nassaj-managed-worker-result/v1',operationId:material.operationId,
        attemptId:material.attemptId,attemptNonce:material.nonce,drain:drained.result,mutation:receipt}};
}
/** Accept only the fixed script's bounded terminal drain result; exit alone is not no-effect evidence. */
export function validateManagedDrainResult(material, code, signal, output) {
    if (signal || ![0,75].includes(code) || Buffer.byteLength(output) > 16384) deny('drain_exit_invalid');
    let result; try { result=JSON.parse(output); } catch { deny('drain_frame_invalid'); }
    assertForwardFrameKeys(result,'schema,operationId,attemptId,outcome,reason,effects');
    if(result.schema!=='nassaj-safe-operation-result/v1'||result.operationId!==material.operationId
        ||result.attemptId!==material.attemptId||result.effects!=='none'
        ||(code===0?(result.outcome!=='ready'||result.reason!=='drained'):(result.outcome!=='deferred'||result.reason!=='live_work'))) deny('drain_result_invalid');
    return result;
}
function runScript(material) {
    return new Promise((resolve, reject) => {
        const child = spawn(material.bashPath, [material.safeRestartPath, '--managed-operation', material.operationId,
            ...(material.kind === 'execute' ? ['--exec'] : [])],
        { cwd: material.cwd, env: { PATH: '/usr/bin:/bin', HOME: material.home }, stdio: ['ignore','pipe','pipe'] });
        let size = 0; const chunks=[];
        child.stdout.on('data',bytes=>chunks.push(bytes));
        for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
            size += bytes.length; if (size > 65536) { stream.destroy(); reject(Error('managed_child_diagnostics_limit')); }
        });
        child.once('error', reject); child.once('close', (code, signal) => {
            try { resolve({code,signal,result:validateManagedDrainResult(material,code,signal,Buffer.concat(chunks).toString('utf8'))}); }
            catch(error){reject(error);}
        });
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runManagedRestartChild().then(result => { if(result.result)process.stdout.write(`${JSON.stringify(result.result)}\n`); process.exitCode = result.code === 0 ? 0 : result.code === 75 ? 75 : 78; }, error => {
        process.stderr.write(`${error.message}\n`); process.exitCode = 78;
    });
}
