/** Namespace-only external observation of immutable capsule bytes; no evaluation or injected application behavior. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const checkpoints=[
    {name:'clone-published',marker:'injectFailure("triple_clone_after_publish")'},
    {name:'old-stopped',marker:'injectFailure("triple_after_old_stop")'},
    {name:'after-exchange',marker:'_after_exchange`)'},
    {name:'candidate-start-intent',marker:'injectFailure(rollback ? "triple_before_previous_start" : "triple_before_candidate_start")'},
    {name:'terminal-created',marker:'injectFailure("triple_after_terminal")'},
];
const failurePoints=new Set(['clone-published','old-stopped','candidate-start-intent','terminal-created',
    'forward_nodeModules-exchanged','forward_server-exchanged','forward_client-exchanged']);

/** Reject misspelled crash checkpoints before discovering or signalling any process. */
export function validateObserverFailurePoint(failAt) {
    if(failAt!==null&&!failurePoints.has(failAt))throw Error('triple_observer_unknown_failure_point');
}

/** Bound the WebSocket opening handshake and remove every temporary listener. */
export function waitForObserverSocket(socket,timeoutMs=5000) {
    return new Promise((resolve,reject)=>{
        const finish=error=>{clearTimeout(timer);socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);socket.removeEventListener('close',closed);error?reject(error):resolve();};
        const opened=()=>finish(),failed=()=>finish(Error('triple_observer_socket_error')),closed=()=>finish(Error('triple_observer_socket_closed'));
        const timer=setTimeout(()=>finish(Error('triple_observer_socket_open_timeout')),timeoutMs);
        socket.addEventListener('open',opened,{once:true});socket.addEventListener('error',failed,{once:true});socket.addEventListener('close',closed,{once:true});
    });
}

/** A requested crash is complete only after the exact checkpoint and verified process death. */
export function assertObserverComplete({failAt=null,events=[],killed=null,failure=null}) {
    validateObserverFailurePoint(failAt);if(failure)throw failure;
    if(failAt!==null){if(killed?.name!==failAt||killed.signal!=='SIGKILL'||killed.deathVerified!==true)throw Error('triple_observer_crash_not_proven_inconclusive');return;}
    if(!events.some(event=>event.name==='old-stopped')||!events.some(event=>event.name==='terminal-created'))throw Error('triple_observer_missed_control_checkpoint_inconclusive');
}

const allowed=new Set(['Debugger.enable','Debugger.getScriptSource','Debugger.setBreakpoint','Debugger.resume']);
function read(file){return JSON.parse(fs.readFileSync(file));}
function processIdentity(pid) {
    try {const fields=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ');return {startTime:fields[19],state:fields[0]};}catch(error){if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;}
}
function alive(owner){const current=processIdentity(owner.pid);return current&&current.state!=='Z'&&current.startTime===owner.startTime;}

/** Wait for the actual admitted capsule and pin its retained source before sending SIGUSR1. */
async function findCapsule(lab,sequence,targetDigest,deadline) {
    const root=path.join(lab,'app'),git=path.join(root,'.git');
    while(Date.now()<deadline) {
        try {
            const maintenance=read(path.join(git,'nassaj-source-update/journal.json')),identity=maintenance.identity?.oid;
            if(identity?.sequence!==sequence||identity.targetDigest!==targetDigest){await sleep(20);continue;}
            const journalFile=path.join(git,identity.journalBasename),transaction=read(journalFile),owner=transaction.owner;
            if(transaction.schema!=='nassaj-oid-control-transaction/v2'||transaction.pair.targetDigest!==targetDigest
                ||maintenance.owner.pid!==owner.pid||maintenance.owner.startTime!==owner.startTime||!alive(owner))throw Error('triple_observer_owner_unverified');
            const args=fs.readFileSync(`/proc/${owner.pid}/cmdline`,'utf8').split('\0').filter(Boolean);
            if(args.length!==3||args[1]!=='--input-type=module'||args[2]!=='-'||fs.readlinkSync(`/proc/${owner.pid}/cwd`)!==root)throw Error('triple_observer_process_not_capsule');
            const directory=path.join(git,'nassaj-oid-recovery',transaction.transactionNonce,'executor');
            const descriptorBytes=fs.readFileSync(path.join(directory,'executor-manifest.json'));
            if(sha(descriptorBytes)!==transaction.recoveryReference.executorManifestSha256)throw Error('triple_observer_executor_changed');
            const descriptor=JSON.parse(descriptorBytes),item=descriptor.files.find(file=>file.name==='capsule.mjs');
            const bytes=fs.readFileSync(path.join(directory,'capsule.mjs'));
            if(!item||sha(bytes)!==item.sha256||bytes.length!==item.size||descriptor.targetDigest!==targetDigest)throw Error('triple_observer_capsule_changed');
            return {owner,transactionNonce:transaction.transactionNonce,journalFile,bytes,sha256:item.sha256};
        } catch(error) {if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
        await sleep(20);
    }
    throw Error('triple_observer_capsule_not_found_inconclusive');
}

/** SIGUSR1/inspect is identical in control and crash cases; missed checkpoints are inconclusive. */
export async function observeTripleCapsule({lab,sequence,targetDigest,failAt=null,timeoutMs=60000}) {
    validateObserverFailurePoint(failAt);
    if(process.pid!==1||process.cwd()!==lab||!lab.includes('/.artifacts/t1772-bridge-rehearsal/run-'))throw Error('triple_observer_not_isolated');
    const capsule=await findCapsule(lab,sequence,targetDigest,Date.now()+timeoutMs),events=[],pending=new Map(),scripts=new Map(),locations=new Map();
    const verifier=await import(`data:text/javascript;base64,${capsule.bytes.toString('base64')}`);
    if(fs.readlinkSync('/proc/self/ns/net')===process.env.NASSAJ_LAB_PARENT_NET_NS)throw Error('triple_observer_host_network_refused');
    for(const file of ['/proc/net/tcp','/proc/net/tcp6']) {
        const listeners=fs.readFileSync(file,'utf8').trim().split('\n').slice(1).map(line=>line.trim().split(/\s+/));
        if(listeners.some(fields=>fields[1].endsWith(':240D')&&fields[3]==='0A'))throw Error('triple_observer_port_already_owned');
    }
    if(!alive(capsule.owner))throw Error('triple_observer_owner_changed');
    process.kill(capsule.owner.pid,'SIGUSR1');
    let target;const until=Date.now()+5000;
    while(Date.now()<until&&!target) {try {const rows=await(await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(200)})).json();if(rows.length!==1)throw Error('triple_observer_targets_ambiguous');target=rows[0];}catch(error){if(!String(error.message).includes('fetch')&&!String(error.message).includes('timeout'))throw error;await sleep(20);}}
    if(!target)throw Error('triple_observer_inspector_unavailable');
    const endpoint=new URL(target.webSocketDebuggerUrl);if(endpoint.hostname!=='127.0.0.1'||endpoint.port!=='9229')throw Error('triple_observer_not_private');
    const socket=new WebSocket(endpoint);let nextId=0,failure,killed=null;
    let transferred=false,closed=false,onMessage;
    const cleanup=()=>{if(closed)return;closed=true;if(onMessage)socket.removeEventListener('message',onMessage);for(const request of pending.values()){clearTimeout(request.timer);request.reject(Error('triple_observer_closed'));}pending.clear();socket.close();};
    try {
    await waitForObserverSocket(socket);
    function command(method,params={}) {
        if(!allowed.has(method))throw Error('triple_observer_command_forbidden');
        const id=++nextId;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('triple_observer_command_timeout'));},5000);pending.set(id,{resolve,reject,timer});try{socket.send(JSON.stringify({id,method,params}));}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}});
    }
    async function paused(event) {
        const frame=event.callFrames[0],key=`${frame.location.scriptId}:${frame.location.lineNumber}`,point=locations.get(key);
        if(!point)throw Error('triple_observer_unexpected_pause_inconclusive');
        const actual=await command('Debugger.getScriptSource',{scriptId:frame.location.scriptId});
        if(sha(actual.scriptSource)!==capsule.sha256||!alive(capsule.owner))throw Error('triple_observer_frame_changed');
        const transaction=read(capsule.journalFile);
        if(transaction.owner.pid!==capsule.owner.pid||transaction.transactionNonce!==capsule.transactionNonce)throw Error('triple_observer_transaction_changed');
        const name=point.name==='after-exchange'?transaction.state.replace(/^triple_/,'').replace(/_intent$/,'-exchanged'):point.name;
        const proof={name,scriptSha256:capsule.sha256,scriptId:frame.location.scriptId,line:frame.location.lineNumber+1,column:frame.location.columnNumber,
            functionName:frame.functionName,owner:capsule.owner,journalState:transaction.state,databaseState:transaction.pair.databaseState,transactionNonce:capsule.transactionNonce};
        if(point.name==='after-exchange') {
            proof.generationPlan=verifier.inspectOidTripleGenerationPlan(path.join(lab,'app'),transaction,'forward');
            const generation=transaction.state.match(/^triple_forward_(nodeModules|server|client)_intent$/)?.[1];
            if(!generation||proof.generationPlan.state!=='verified'
                ||proof.generationPlan.steps.find(step=>step.name===generation)?.position!=='exchanged')throw Error('triple_observer_exchange_not_proven_inconclusive');
        }
        events.push(proof);
        if(name===failAt) {
            process.kill(capsule.owner.pid,'SIGKILL');const until=Date.now()+5000;while(alive(capsule.owner)&&Date.now()<until)await sleep(20);
            if(alive(capsule.owner))throw Error('triple_observer_death_unverified');
            killed={...proof,signal:'SIGKILL',deathVerified:true};socket.close();
        } else await command('Debugger.resume');
    }
    onMessage=event=>{
        let message;try{message=JSON.parse(String(event.data));}catch{failure=Error('triple_observer_protocol_invalid');cleanup();return;}
        if(message.id){const request=pending.get(message.id);if(!request)return;clearTimeout(request.timer);pending.delete(message.id);message.error?request.reject(Error('triple_observer_protocol_error')):request.resolve(message.result);return;}
        if(message.method==='Debugger.scriptParsed')scripts.set(message.params.scriptId,message.params);
        if(message.method==='Debugger.paused')void paused(message.params).catch(error=>{failure=error;cleanup();});
    }
    socket.addEventListener('message',onMessage);
    await command('Debugger.enable');
    let script;
    for(const parsed of scripts.values()) {
        if(!parsed.url.endsWith('/[eval1]'))continue;
        const {scriptSource}=await command('Debugger.getScriptSource',{scriptId:parsed.scriptId});
        if(sha(scriptSource)===capsule.sha256){script={...parsed,source:scriptSource};break;}
    }
    if(!script)throw Error('triple_observer_source_not_found_inconclusive');
    const lines=script.source.split('\n');
    for(const point of checkpoints) {
        const matching=lines.flatMap((line,index)=>line.includes(point.marker)?[index]:[]);
        if(matching.length!==1)throw Error('triple_observer_checkpoint_ambiguous:'+point.name);
        const result=await command('Debugger.setBreakpoint',{location:{scriptId:script.scriptId,lineNumber:matching[0]}});
        if(result.actualLocation.lineNumber!==matching[0])throw Error('triple_observer_checkpoint_shifted_inconclusive');
        locations.set(`${script.scriptId}:${matching[0]}`,point);
    }
    transferred=true;
    return {events,get killed(){return killed;},assertHealthy(){if(failure)throw failure;},close:cleanup,
        assertControlComplete(){assertObserverComplete({failAt,events,killed,failure});},
        assertComplete(){assertObserverComplete({failAt,events,killed,failure});}};
    } finally {if(!transferred)cleanup();}
}
