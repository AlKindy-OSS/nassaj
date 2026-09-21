import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {spawnRecoveryLabConsumer} from './local-source-recovery-next-update.mjs';
import {launchClientPublicationConsumer} from '../client-publication-consumer-launcher.mjs';

test('real launcher rejects externally supplied repo before retaining or spawning anything',async()=>{
    for(const args of [['--repo','/unused'],['--repo=/unused']])
        await assert.rejects(launchClientPublicationConsumer('/does-not-exist',args),/client_consumer_root_override_refused/);
    await assert.rejects(launchClientPublicationConsumer('/does-not-exist',[]),error=>error.code==='ENOENT');
});

test('next update launches service entry from app cwd without overriding launcher-owned repo',()=>{
    const app='/private-lab/app',ownedChild={pid:123},calls=[];
    const child=spawnRecoveryLabConsumer(app,19,(...args)=>{calls.push(args);return ownedChild;});
    assert.equal(child,ownedChild);assert.equal(calls.length,1);
    const [executable,args,options]=calls[0];assert.equal(executable,process.execPath);
    assert.deepEqual(args,[path.join(app,'scripts/client-publication-consumer-launcher.mjs')]);
    assert.equal(options.cwd,app);assert.deepEqual(options.stdio,['ignore',19,19]);
    assert.equal(options.env.NASSAJ_UPDATE_MODE,'local-main');
    assert.equal(options.env.NASSAJ_PREVIEW_OID_ENFORCEMENT,'1');
    assert.equal(options.env.NASSAJ_PREVIEW_OID_DOMAINS,'client,server');
});
