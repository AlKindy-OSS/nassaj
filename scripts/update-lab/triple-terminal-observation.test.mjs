import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readTripleFailedTerminal} from './triple-terminal-observation.mjs';
test('failed terminal observed immediately with exact binding and no state writes',()=>{
    const dir=fs.mkdtempSync(path.resolve('.artifacts/triple-terminal-test-'));
    try{
        const nonce='a'.repeat(64),digest='b'.repeat(64),file=path.join(dir,`nassaj-oid-control-transaction-1-${nonce}.json`);
        fs.mkdirSync(path.join(dir,'nassaj-source-update'));
        const maintenance=path.join(dir,'nassaj-source-update/journal.json');
        const expected={sequence:1,targetDigest:digest};assert.equal(readTripleFailedTerminal(dir,expected),null);
        const value={schema:'nassaj-oid-control-transaction/v2',sequence:1,transactionNonce:nonce,pair:{targetDigest:digest,databaseState:'PRE_CANDIDATE'},state:'triple_prepared'};
        fs.writeFileSync(file,JSON.stringify(value));assert.equal(readTripleFailedTerminal(dir,expected),null);
        for(const state of ['restart_deferred_restored','pair_rolled_back','manual_recovery_required']){
            value.state=state;fs.writeFileSync(file,JSON.stringify(value));const before=fs.readFileSync(file);
            fs.writeFileSync(maintenance,JSON.stringify({state:'MAINTENANCE',gateClosed:true}));assert.equal(readTripleFailedTerminal(dir,expected),null);
            fs.writeFileSync(maintenance,JSON.stringify(state==='manual_recovery_required'?{state:'MANUAL',gateClosed:false}:{state:'OPEN',gateClosed:false,oidAdmissionIntent:{sequence:1}}));
            assert.equal(readTripleFailedTerminal(dir,expected),null);
            fs.writeFileSync(maintenance,JSON.stringify(state==='manual_recovery_required'?{state:'MANUAL',gateClosed:true}:{state:'OPEN',gateClosed:false,oidAdmissionIntent:null}));
            assert.equal(readTripleFailedTerminal(dir,expected).state,state);assert.deepEqual(fs.readFileSync(file),before);
        }
        assert.throws(()=>readTripleFailedTerminal(dir,{...expected,targetDigest:'c'.repeat(64)}),/mismatch/);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
