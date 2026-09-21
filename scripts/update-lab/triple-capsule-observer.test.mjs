import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForObserverSocket,validateObserverFailurePoint,assertObserverComplete} from './triple-capsule-observer.mjs';
class SocketEvents extends EventTarget {
    listeners=new Map();
    addEventListener(name,fn,options){this.listeners.set(name,fn);super.addEventListener(name,fn,options);}
    removeEventListener(name,fn){this.listeners.delete(name);super.removeEventListener(name,fn);}
}
test('opening deadline rejects and removes temporary socket listeners',async()=>{
    const socket=new SocketEvents();
    await assert.rejects(waitForObserverSocket(socket,10),/socket_open_timeout/);
    assert.equal(socket.listeners.size,0);
});
test('opening failure and early close both remove listeners',async()=>{
    for(const event of ['error','close']){
        const socket=new SocketEvents(),opening=waitForObserverSocket(socket,1000);
        socket.dispatchEvent(new Event(event));await assert.rejects(opening,/socket_(error|closed)/);
        assert.equal(socket.listeners.size,0);
    }
});
test('successful opening removes timeout and temporary listeners',async()=>{
    const socket=new SocketEvents(),opening=waitForObserverSocket(socket,10);
    socket.dispatchEvent(new Event('open'));await opening;assert.equal(socket.listeners.size,0);
    await new Promise(resolve=>setTimeout(resolve,20));
});
test('unknown checkpoints reject and a requested crash requires matching verified death',()=>{
    assert.throws(()=>validateObserverFailurePoint('forward-nodeModules-exchanged'),/unknown_failure_point/);
    validateObserverFailurePoint('forward_nodeModules-exchanged');
    const failAt='old-stopped',events=[{name:failAt},{name:'terminal-created'}];
    assert.throws(()=>assertObserverComplete({failAt,events}),/crash_not_proven/);
    assert.throws(()=>assertObserverComplete({failAt,killed:{name:failAt,signal:'SIGKILL',deathVerified:false}}),/crash_not_proven/);
    assert.throws(()=>assertObserverComplete({failAt,killed:{name:'terminal-created',signal:'SIGKILL',deathVerified:true}}),/crash_not_proven/);
    assertObserverComplete({failAt,killed:{name:failAt,signal:'SIGKILL',deathVerified:true}});
    assertObserverComplete({events});
    assert.throws(()=>assertObserverComplete({events:[]}),/missed_control_checkpoint/);
});
