/** External debugger observation only: no evaluation, application patching, or synthetic health. */
import {createHash} from 'node:crypto';
import fs from 'node:fs';

const ALLOWED=new Set(['Debugger.enable','Debugger.setBreakpointByUrl','Debugger.getScriptSource','Debugger.resume','Runtime.runIfWaitingForDebugger']);

/** Attach to the namespace-local inspector and pin each requested compiled checkpoint to exact bytes. */
export async function observeBridgeStartup({port,checkpoints,onPause}) {
    if(process.pid!==1 || !process.cwd().includes('/.artifacts/t1772-bridge-rehearsal/run-'))throw Error('bridge_observer_not_isolated');
    if(!Number.isInteger(port) || port<1024 || port>65535)throw Error('bridge_inspector_port_invalid');
    const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)})).json();
    if(targets.length!==1)throw Error('bridge_inspector_target_ambiguous');
    const address=new URL(targets[0].webSocketDebuggerUrl);
    if(address.hostname!=='127.0.0.1' || Number(address.port)!==port)throw Error('bridge_inspector_not_private');
    const socket=new WebSocket(address),pending=new Map(),scripts=new Map(),resolved=new Map();
    let sequence=0,failure;
    const events=[];
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    function command(method,params={}) {
        if(!ALLOWED.has(method))throw Error('bridge_observer_command_forbidden');
        const id=++sequence;
        return new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{pending.delete(id);reject(Error('bridge_inspector_command_timeout'));},5000);
            pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
        });
    }
    async function paused(event) {
        const frame=event.callFrames[0],script=scripts.get(frame.location.scriptId);
        const checkpoint=checkpoints.find(value=>value.url===script?.url && value.line===frame.location.lineNumber+1);
        if(!checkpoint){events.push({kind:'initial-pause',reason:event.reason});await command('Debugger.resume');return;}
        const {scriptSource}=await command('Debugger.getScriptSource',{scriptId:frame.location.scriptId});
        const actual=createHash('sha256').update(scriptSource).digest('hex');
        if(actual!==checkpoint.sha256)throw Error('bridge_checkpoint_script_changed');
        const resolution=[...resolved.values()].find(location=>location.scriptId===frame.location.scriptId && location.lineNumber===frame.location.lineNumber);
        if(!resolution)throw Error('bridge_checkpoint_not_resolved');
        const evidence={kind:'checkpoint',name:checkpoint.name,url:script.url,line:frame.location.lineNumber+1,
            column:frame.location.columnNumber,scriptSha256:actual,functionName:frame.functionName};
        events.push(evidence);
        const action=await onPause(evidence);
        if(action==='resume')await command('Debugger.resume');
        else if(action!=='hold')throw Error('bridge_observer_action_invalid');
    }
    socket.addEventListener('message',event=>{
        const message=JSON.parse(String(event.data));
        if(message.id){const request=pending.get(message.id);if(!request)return;clearTimeout(request.timer);pending.delete(message.id);
            if(message.error)request.reject(Error(`bridge_inspector_error:${message.error.code}`));else request.resolve(message.result);return;}
        if(message.method==='Debugger.scriptParsed')scripts.set(message.params.scriptId,message.params);
        if(message.method==='Debugger.breakpointResolved')resolved.set(message.params.breakpointId,message.params.location);
        if(message.method==='Debugger.paused')void paused(message.params).catch(error=>{failure=error;socket.close();});
    });
    await command('Debugger.enable');
    for(const checkpoint of checkpoints){
        if(!checkpoint.url.startsWith(`file://${process.cwd()}/app/dist-server/`) || !Number.isInteger(checkpoint.line) || checkpoint.line<1)throw Error('bridge_checkpoint_invalid');
        const bytes=fs.readFileSync(new URL(checkpoint.url));
        if(createHash('sha256').update(bytes).digest('hex')!==checkpoint.sha256)throw Error('bridge_checkpoint_file_changed');
        const breakpoint=await command('Debugger.setBreakpointByUrl',{url:checkpoint.url,lineNumber:checkpoint.line-1});
        for(const location of breakpoint.locations)resolved.set(breakpoint.breakpointId,location);
    }
    await command('Runtime.runIfWaitingForDebugger');
    return {events,assertHealthy(){if(failure)throw failure;},close(){socket.close();}};
}
