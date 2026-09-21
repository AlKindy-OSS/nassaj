import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareLocalRecoveryLab,inspectSealedRecoveryLab} from './local-source-recovery-rehearsal.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

test('full rehearsal refuses materialization until explicitly requested and final main OID is exact',()=>{
    const scratch=path.join(root,'.artifacts/t1772-bridge-rehearsal'),before=fs.readdirSync(scratch).sort();
    assert.throws(()=>prepareLocalRecoveryLab({}),/materialization_not_requested/);
    assert.throws(()=>prepareLocalRecoveryLab({materialize:true}),/final_oid_required/);
    assert.throws(()=>inspectSealedRecoveryLab({expectedOid:'0'.repeat(40)}),/final_oid_required/);
    assert.deepEqual(fs.readdirSync(scratch).sort(),before);
});

test('private PM2 configuration satisfies actual capsule online/stopped and saved-slot contracts',async()=>{
    const {recoveryLabPm2Configuration}=await import('./local-source-recovery-rehearsal.mjs');
    const {validateOidTriplePm2Slot,validateOidTriplePm2Dump}=await import('../oid-control-capsule.mjs');
    const lab='/private-lab',env={FIXTURE:'only'},config=recoveryLabPm2Configuration(lab,env).apps[0];
    assert.equal(config.instances,1);assert.equal(config.exec_mode,'fork');assert.equal(config.autorestart,true);
    assert.deepEqual(config.args,['--port','3004']);assert.equal(config.interpreter,process.execPath);
    assert.deepEqual(config.node_args,[`--title=node ${path.join(lab,'app/dist-server/server/index.js')}`]);
    assert.equal(config.treekill,false);assert.equal(typeof config.kill_timeout,'string');
    const expected={root:config.cwd,name:config.name,pmId:1,pid:123};
    const slot={name:config.name,pm_id:1,pid:123,pm2_env:{...config,exec_mode:'fork_mode',pm_cwd:config.cwd,
        pm_exec_path:path.join(config.cwd,config.script),status:'online',env}};
    assert.equal(validateOidTriplePm2Slot([slot],expected),slot);
    const numeric={...slot,pm2_env:{...slot.pm2_env,kill_timeout:86400000}};
    assert.equal(validateOidTriplePm2Slot([numeric],expected),numeric);
    assert.equal(validateOidTriplePm2Dump([{...slot.pm2_env,name:slot.name}],slot),true);
    const stopped={...slot,pid:0,pm2_env:{...slot.pm2_env,status:'stopped'}};
    assert.equal(validateOidTriplePm2Slot([stopped],expected,'stopped'),stopped);
    for(const patch of [{kill_timeout:300000},{kill_timeout:'86400000.0'},{treekill:true},{pm_cwd:'/foreign'},{pm_exec_path:'/foreign'},{status:'stopped'}])
        assert.throws(()=>validateOidTriplePm2Slot([{...slot,pm2_env:{...slot.pm2_env,...patch}}],expected),/slot_changed/);
    assert.throws(()=>validateOidTriplePm2Dump([{...slot.pm2_env,name:slot.name,kill_timeout:'86400000.0'}],slot),/dump_slot_changed/);
    assert.throws(()=>validateOidTriplePm2Slot([slot,{...slot,pm_id:2}],expected),/slot_ambiguous/);
});
