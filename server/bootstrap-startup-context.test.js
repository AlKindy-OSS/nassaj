import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

import {setupInitialArmFixture} from '../scripts/fixtures/initial-arm-fixture.mjs';
import { createBootstrapContextHarness } from '../scripts/fixtures/bootstrap-context-harness.mjs';
import { installFixedStateMutexAuthority } from '../scripts/fixtures/fixed-state-mutex-authority.mjs';

test('actual context obtains signed-root claim and security phase over a fresh child pipe before serving', async t => {
    const f = createBootstrapContextHarness(t,{simulateInitialOperator:true});
    const module = pathToFileURL(path.join(f.releaseRoot, 'dist-server/server/bootstrap-startup-context.js')).href;
    const go=path.join(f.root,'context-go');
    const running = f.start(`import {setTimeout as delay} from 'node:timers/promises';import existsFs from 'node:fs';
        while(!existsFs.existsSync(${JSON.stringify(go)}))await delay(5);
        import {establishStartupAdmission,admitSecurityStartup,confirmStartupServing,readVerifiedStartupContext,requireStartupAdmission} from ${JSON.stringify(module)};
        const context=await establishStartupAdmission();
        if (!Object.isFrozen(context.databaseTarget) || !context.databaseTarget.schemaDigest) throw Error('target_missing');
        const fs=await import('node:fs'); const read=fs.default.readFileSync;
        fs.default.readFileSync=function(file,...args){if(String(file).endsWith('RELEASE_ASSET_MANIFEST.json')) throw Error('manifest_hot_read');return read.call(this,file,...args)};
        for(let i=0;i<100;i++) requireStartupAdmission();
        await admitSecurityStartup(); await confirmStartupServing();
        console.log(JSON.stringify({phase:readVerifiedStartupContext().phase,pid:process.pid}));`);
    t.after(()=>running.child.kill('SIGKILL'));
    const armed=await setupInitialArmFixture(t,{fixture:f,targetChild:running.child});
    // The root arm runs under the fixed state mutex, which measures the installed config path.
    installFixedStateMutexAuthority(t,f.root,f.config,{file:path.join(f.root,'config.json')});
    f.write('config.json',f.config);await armed.arm();fs.writeFileSync(go,'go');
    await f.waitForSecurity(); f.commit();
    const result = await running.result; assert.equal(result.code, 0, result.stderr);
    const response = JSON.parse(result.stdout); assert.equal(response.phase, 'serving'); assert.equal(response.pid, running.child.pid);
    assert.equal(f.read('startup-admission.json').lastClaim.pid, running.child.pid);
});

test('missing mandatory manifest fails before any claim and cannot fall through to default startup', async t => {
    const f = createBootstrapContextHarness(t); fs.unlinkSync(path.join(f.releaseRoot, 'RELEASE_ASSET_MANIFEST.json'));
    const module = pathToFileURL(path.join(f.releaseRoot, 'dist-server/server/bootstrap-startup-context.js')).href;
    const result = await f.start(`import {establishStartupAdmission} from ${JSON.stringify(module)};await establishStartupAdmission();`).result;
    assert.notEqual(result.code, 0); assert.match(result.stderr, /root_startup_manifest_required/);
    assert.equal(f.read('startup-admission.json').lastClaim, null);
});


test('local descriptor v2 reaches actual context claim and rejects a GitHub version label before admission', async t => {
    const f=createBootstrapContextHarness(t,{localBuild:true,simulateInitialOperator:true});
    const module=pathToFileURL(path.join(f.releaseRoot,'dist-server/server/bootstrap-startup-context.js')).href;
    const go=path.join(f.root,'local-go');
    const running=f.start(`import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
        import {establishStartupAdmission} from ${JSON.stringify(module)};
        while(!fs.existsSync(${JSON.stringify(go)}))await delay(5);
        const value=await establishStartupAdmission();console.log(JSON.stringify({generationId:value.generationId}));`);
    t.after(()=>running.child.kill('SIGKILL'));
    const armed=await setupInitialArmFixture(t,{fixture:f,targetChild:running.child});
    installFixedStateMutexAuthority(t,f.root,f.config,{file:path.join(f.root,'config.json')});
    f.write('config.json',f.config);await armed.arm();fs.writeFileSync(go,'go');
    const result=await running.result;assert.equal(result.code,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).generationId,`local-forward-${f.descriptor.artifact.archiveSha256}`);
    const g=createBootstrapContextHarness(t,{localBuild:true});
    g.descriptor.schema='nassaj-startup-admission-client/v1';g.write('descriptor.json',g.descriptor);
    const other=pathToFileURL(path.join(g.releaseRoot,'dist-server/server/bootstrap-startup-context.js')).href;
    const denied=await g.start(`import {establishStartupAdmission} from ${JSON.stringify(other)};await establishStartupAdmission();`).result;
    assert.notEqual(denied.code,0);assert.equal(g.read('startup-admission.json').lastClaim,null);
});
