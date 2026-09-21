import assert from 'node:assert/strict';
import test from 'node:test';
import {recoveryLabScope,finishRecoveryLabScope} from './local-source-recovery-scope.mjs';

test('omitting scope executes next update and retains full-cycle acceptance',async()=>{
    let calls=0;assert.equal(recoveryLabScope(),'full');
    const result=await finishRecoveryLabScope(undefined,async()=>{calls++;});
    assert.equal(calls,1);assert.equal(result.state,'source_recovery_and_next_button_update_verified');
    assert.equal(result.nextUpdateVerified,true);assert.equal(result.stage,'complete');
});

test('first-boot-only never invokes next preparation or claims full-cycle success',async()=>{
    const result=await finishRecoveryLabScope('first-boot-only',()=>assert.fail('next update must not execute'));
    assert.equal(result.state,'source_recovery_first_boot_only_verified');
    assert.equal(result.nextUpdateVerified,false);assert.equal(result.stage,'first-boot-only-complete');
});

test('unknown scope and failed next update cannot produce a successful result',async()=>{
    for(const scope of [null,'','first','FULL',true,{}]) {
        assert.throws(()=>recoveryLabScope(scope),/scope_invalid/);
        await assert.rejects(finishRecoveryLabScope(scope,()=>assert.fail('invalid scope must not execute')),/scope_invalid/);
    }
    await assert.rejects(finishRecoveryLabScope('full',()=>{throw Error('next update failed');}),/next update failed/);
});
