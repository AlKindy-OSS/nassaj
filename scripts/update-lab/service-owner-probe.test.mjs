/** Exercise the exact privileged-probe parsers without running its PM2 path. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const source=fs.readFileSync(new URL('./service-owner-probe.mjs',import.meta.url),'utf8');
test('probe NoNewPrivs parser accepts actual proc formatting and rejects zero',()=>{
    const expression=source.match(/assert\.match\(status,(\/\^NoNewPrivs:.*?\/m)\)/)[1];
    const parser=Function(`return ${expression}`)();
    const status=fs.readFileSync('/proc/self/status','utf8');
    assert.equal(parser.test(status.replace(/^NoNewPrivs:\s+\d+$/m,'NoNewPrivs:\t1')),true);
    assert.equal(parser.test(status.replace(/^NoNewPrivs:\s+\d+$/m,'NoNewPrivs:\t0')),false);
});
test('probe startTicks parser reads the actual Linux stat field',()=>{
    const separator=source.match(/\.split\((\/.*?\/)\)\[19\]/)[1];
    const parser=Function(`return ${separator}`)();
    const raw=fs.readFileSync('/proc/self/stat','utf8');
    const start=raw.slice(raw.lastIndexOf(')')+2).trim().split(parser)[19];
    assert.match(start,/^[0-9]+$/);
    assert.equal(Number.isSafeInteger(Number(start)),true);
});

test('probe final report fails when daemon identity rejects after transport capture',async()=>{
    // Execute the exact report try/catch/finally with only external I/O and import replaced.
    const reportCode=source.slice(source.indexOf('let report='))
        .replace("await import('./capsule.mjs')",'capsuleFixture');
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    const run=new AsyncFunction('pm2','fs','path','process','capsuleFixture','assert','app','name','lab','ecosystem',reportCode);
    for(const daemonUid of [0,1000]){
        let output;
        const fakeProcess={env:{},getuid:()=>1000,exitCode:0};
        const fakeFs={readFileSync:()=>`42 (idle) ${Array(20).fill('1').join(' ')}`,
            writeFileSync:(_file,data)=>{output=JSON.parse(data);}};
        await run(()=>JSON.stringify([{name:'fixture',pid:42}]),fakeFs,{join:(...parts)=>parts.join('/')},
            fakeProcess,{captureOidTripleSupervisor:async()=>({daemon:{pid:30},observer:{daemon:{uid:daemonUid}}})},
            assert,'/fixture/app','fixture','/fixture','/fixture/ecosystem.cjs');
        assert.equal(output.state,daemonUid===1000?'peer_transport_verified':'failed');
        assert.equal(fakeProcess.exitCode,daemonUid===1000?0:1);
        if(daemonUid===0) assert.ok(output.error);
    }
});
