import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { initializeDatabase, closeConnection, getConnection, userDb, sessionsDb, participantsDb, projectsDb, messageCoordinationDb } from '@/modules/database/index.js';

import router from './provider.routes.js';

let owner = 0;
let other = 0;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let url = '';
before(async () => {
  await initializeDatabase();
  owner = userDb.createUser('delivery-owner', 'hash', 'user').id;
  other = userDb.createUser('delivery-other', 'hash', 'user').id;
  const project = projectsDb.createProjectPath('/delivery-private', 'Private receipt fixture', owner);
  projectsDb.setProjectVisibility(project.project!.project_id, 'private');
  sessionsDb.createSession('delivery-session', 'codex', '/delivery-private');
  // No active project row: this session is participant-only under ADR-089.
  sessionsDb.createSession('delivery-other-session', 'codex', '/delivery-hidden');
  getConnection().prepare('UPDATE projects SET isArchived = 1 WHERE project_path = ?').run('/delivery-hidden');
  participantsDb.recordSpawn('delivery-session', owner);
  participantsDb.recordSpawn('delivery-other-session', owner);
  participantsDb.recordSpawn('delivery-session', other);
  messageCoordinationDb.claim({sessionId:'delivery-session',clientMsgId:'cmid_exact',userId:owner,provider:'codex',canonicalContent:'موافق',coordinationLevel:'delegate'});
  const app = express();
  app.use((req, _res, next) => {
    const id = Number(req.headers['x-test-user']);
    if (id) Object.assign(req, {user:{id}});
    next();
  });
  app.use('/api/providers', router);
  app.use((error: {statusCode?:number}, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({error:'Request failed'});
  });
  server = app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve => server.once('listening',resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/sessions`;
});
after(async () => { await new Promise<void>(resolve=>server.close(()=>resolve())); closeConnection(); });
function setEvidence(status:string, verdict:unknown) {
  getConnection().prepare('UPDATE message_coordination_ingress SET lifecycle_status = ?, verdict_json = ? WHERE client_msg_id = ?')
    .run(status,typeof verdict === 'string' ? verdict : verdict === null ? null : JSON.stringify(verdict),'cmid_exact');
}
const complete = {kind:'complete',provider:'codex',sessionId:'delivery-session',clientMsgId:'cmid_exact'};
async function read(user=owner, session='delivery-session', id='cmid_exact',provider='codex') {
  return fetch(`${url}/${session}/message-delivery/${id}?provider=${provider}`,{headers:{'x-test-user':String(user)}});
}
test('legacy complete and started retain exact owned content without exposing raw verdict',async()=>{
  for(const [status,verdict] of [['terminal',complete],['started',null]] as const) {
    setEvidence(status,verdict);
    const response=await read();
    assert.equal(response.headers.get('cache-control'),'no-store');
    const body=await response.json();
    assert.equal(body.status,'accepted');
    assert.deepEqual(Object.keys(body.receipt).sort(),['clientMsgId','content','createdAt','provider','sessionId','source']);
    assert.equal(body.receipt.content,'موافق');
    assert.equal(body.receipt.clientMsgId,'cmid_exact');
    assert.equal(body.receipt.source,'ingress_receipt');
  }
});
test('claimed, legacy null, malformed and contradictory verdicts never confirm delivery',async()=>{
  for(const [status,verdict] of [
    ['claimed',null],['terminal',null],['terminal','{'],['terminal',[]],
    ...[{kind:'error'},{code:'spawn_failed'},{error:'failure'},{notStarted:true},{success:false},{exitCode:1},
      {sameClientMsgIdRetryable:true},{clientMsgId:'other'},{sessionId:'other'},{provider:'claude'},{actualSessionId:'other'}]
      .map(fields=>['terminal',{...complete,...fields}]),
  ] as Array<[string,unknown]>) {
    setEvidence(status,verdict);
    const body=await (await read()).json();
    assert.equal(body.status,'unknown');
    assert.equal(body.receipt,undefined);
  }
});
test('receipt scope includes the owner even for a participant with session access',async()=>{
  setEvidence('terminal',complete);
  for(const args of [[other], [owner,'delivery-other-session'],[owner,'delivery-session','missing'],[owner,'delivery-session','cmid_exact','claude']] as const) {
    const body=await (await read(...args)).json();
    assert.equal(body.status,'unknown');
    assert.equal(body.receipt,undefined);
  }
  assert.equal((await read(0)).status,401);
  assert.equal((await read(other,'delivery-other-session')).status,404);
});
test('invalid inputs fail closed and repeated GET never changes ledger',async()=>{
  const beforeRows=getConnection().prepare('SELECT * FROM message_coordination_ingress').all();
  assert.equal((await read(owner,'delivery-session','x'.repeat(129))).status,400);
  assert.equal((await read(owner,'delivery-session','cmid_exact',"codex%27")).status,400);
  await read(); await read();
  assert.deepEqual(getConnection().prepare('SELECT * FROM message_coordination_ingress').all(),beforeRows);
});


test('durable activity remains accepted after failure, abort and corrupt terminal verdict', async () => {
  setEvidence('claimed', null);
  const scope = { userId: owner, provider: 'codex', sessionId: 'delivery-session', clientMsgId: 'cmid_exact' };
  assert.equal(messageCoordinationDb.markStarted(scope), true);
  for (const verdict of [{ kind: 'error', code: 'aborted' }, { kind: 'complete', success: false }, '{']) {
    setEvidence('terminal', verdict);
    assert.equal((await (await read()).json()).status, 'accepted');
    assert.equal((await (await read(other)).json()).status, 'unknown');
    assert.equal((await (await read(owner, 'delivery-session', 'cmid_exact', 'claude')).json()).status, 'unknown');
  }
});
