/** A real job stranded after activation claim, before handoff; no worker/download state is introduced. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

/** Use the existing job repository, then reproduce only the persisted crash boundary. */
export async function seedBridgeStrandedJob(lab,target) {
    assert.equal(process.pid,1);assert.equal(process.env.DATABASE_PATH,path.join(lab,'data/auth.db'));
    const base=path.join(lab,'app/dist-server/server/modules/database');
    const connection=await import(pathToFileURL(path.join(base,'connection.js')));
    const {sourceUpdateJobsDb,hashSourceUpdateIdempotencyKey,sourceUpdateRequestFingerprint}=await import(pathToFileURL(path.join(base,'repositories/source-update-jobs.db.js')));
    try {
        const db=connection.getConnection(),ownerId=db.prepare('SELECT id FROM users WHERE username=?').get('bridgeowner').id;
        const id=randomUUID(),strategy='git-checkout-v2',version='1.47.0.19';
        sourceUpdateJobsDb.createOrReuse({id,ownerId,expectedVersion:version,strategy,idempotencyKeyHash:hashSourceUpdateIdempotencyKey(id),
            requestFingerprint:sourceUpdateRequestFingerprint(ownerId,version,strategy)});
        const raw=fs.readFileSync('/proc/self/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
        const workerId=randomUUID(),claimed=sourceUpdateJobsDb.claim({workerId,pid:process.pid,startTicks:fields[19],
            bootId:fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pgid:Number(fields[2])},Date.now(),15000);
        assert.equal(claimed?.id,id);
        const transactionId='bridge-stranded-'+id,identity=createHash('sha256').update(id).digest('hex');
        db.prepare("UPDATE source_update_jobs SET state='restart_queued',transaction_id=?,activation_identity_sha256=?,release_commit=? WHERE id=?")
            .run(transactionId,identity,target.oid,id);
        assert.equal(sourceUpdateJobsDb.release(id,workerId,claimed.worker_fence),true);
        db.prepare("UPDATE source_update_jobs SET state='activating' WHERE id=?").run(id);
        fs.writeFileSync(path.join(lab,'source-job-fixture.json'),JSON.stringify({id,transactionId,identity}),{mode:0o600});
    } finally {connection.closeConnection();}
    return readBridgeStrandedJob(lab);
}

/** Inspect state and real receipt presence without reconciling or changing the job. */
export function readBridgeStrandedJob(lab) {
    const fixture=JSON.parse(fs.readFileSync(path.join(lab,'source-job-fixture.json')));
    const db=new DatabaseSync(path.join(lab,'data/auth.db'),{readOnly:true});
    try {
        const row=db.prepare('SELECT state,error_code,transaction_id,activation_identity_sha256 FROM source_update_jobs WHERE id=?').get(fixture.id);
        assert.equal(row.transaction_id,fixture.transactionId);assert.equal(row.activation_identity_sha256,fixture.identity);
        return {jobId:fixture.id,state:row.state,errorCode:row.error_code,
            activeJobId:db.prepare('SELECT active_job_id FROM source_update_control WHERE singleton=1').get().active_job_id,
            receipts:db.prepare('SELECT phase,kind,facts_json FROM source_update_receipts WHERE job_id=? ORDER BY sequence').all(fixture.id)
                .map(value=>({phase:value.phase,kind:value.kind,code:JSON.parse(value.facts_json).code}))};
    } finally {db.close();}
}
