import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { planForwardDefinitionRetirement, retireForwardSavedDefinition, installForwardSavedDefinition } from './lib/release-runtime-forward-saved-definitions.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('real durable retirement preserves unrelated entries, file ownership and mode under umask077', t => {
    const root = fs.mkdtempSync(path.join(path.resolve(import.meta.dirname, '../.artifacts'), 'forward-definitions-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'dump.pm2'); const sibling = { name: 'another-app', args: ['literal', '$(never execute)'], env: { FIXTURE: 'value' } };
    fs.writeFileSync(file, JSON.stringify([{ name: 'nassaj-dev', namespace: 'default' }, sibling]), { mode: 0o640 }); fs.chmodSync(file, 0o640);
    const before = fs.statSync(file); const previous = process.umask(0o077);
    try {
        const receipt = retireForwardSavedDefinition({ sourceId: 'primary', path: file, format: 'pm2-dump-json', beforeSha256: sha(fs.readFileSync(file)) }, { name: 'nassaj-dev', namespace: 'default' });
        assert.deepEqual(JSON.parse(fs.readFileSync(file)), [sibling]); const after = fs.statSync(file);
        assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid); assert.equal(after.mode & 0o777, 0o640);
        assert.equal(receipt.afterSha256, sha(fs.readFileSync(file))); assert.equal(receipt.oldTargetAbsent, true);
    } finally { process.umask(previous); }
});
test('duplicates and a different namespace cannot be retired by the planned slot name', () => {
    const slot = { name: 'nassaj-dev', namespace: 'default' };
    for (const entries of [[{ name: slot.name }, { name: slot.name }], [{ name: slot.name, namespace: 'other' }]]) {
        assert.throws(() => planForwardDefinitionRetirement(Buffer.from(JSON.stringify(entries)), 'pm2-dump-json', slot), /ambiguous/);
    }
});

test('new target is durably installed into each independent retired fallback without copying siblings',t=>{
    const root=fs.mkdtempSync(path.resolve('.artifacts/forward-fallbacks-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const slot={name:'nassaj-dev',namespace:'default'};
    const target={...slot,status:'online',pmx:false,vizion:false,wait_ready:false,pm_id:44,instances:1,prev_restart_delay:0,
        pm_exec_path:'/pinned/new/launcher.mjs',env:{SERVICE:'literal'},restart_time:0};
    for(const [index,format] of ['pm2-dump-json','pm2-dump-json','pm2-ecosystem-json'].entries()){
        const file=path.join(root,`source-${index}.json`);const sibling={name:`independent-${index}`,env:{PRIVATE:`preserve-${index}`}};
        fs.writeFileSync(file,JSON.stringify(format==='pm2-dump-json'?[sibling]:{custom:'preserve',apps:[sibling]}),{mode:0o640});
        const source={sourceId:`source-${index}`,path:file,format,beforeSha256:sha(fs.readFileSync(file))};
        const receipt=installForwardSavedDefinition(source,slot,target);
        const content=JSON.parse(fs.readFileSync(file));const rows=format==='pm2-dump-json'?content:content.apps;
        assert.deepEqual(rows[0],sibling);assert.equal(rows[1].pm_exec_path,target.pm_exec_path);
        for(const key of ['pm_id','instances','prev_restart_delay'])assert.equal(Object.hasOwn(rows[1],key),false);
        assert.equal(receipt.targetInstalled,true);assert.equal(receipt.afterSha256,sha(fs.readFileSync(file)));
        assert.equal(fs.statSync(file).mode&0o777,0o640);
        assert.throws(()=>installForwardSavedDefinition({...source,beforeSha256:receipt.afterSha256},slot,target),/target_invalid/);
    }
});
