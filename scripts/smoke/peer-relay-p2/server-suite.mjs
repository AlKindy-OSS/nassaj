/**
 * ADR-219 P2a-min live AT-1 / AT-1b on the real server (§8): two members' real
 * sessions on the targets' model, a real cross-member SendMessage held for A,
 * A approving over HTTP, the delivery as a resume turn under F2, A answering the
 * Write prompt through the UI path (AT-1, `default`) or no prompt (AT-1b,
 * `acceptEdits`), and a1's reply held on B's side, approved by B, delivered to b1.
 * Acts only through UI routes and the UI's own WebSocket messages.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { isPeerDeliveryProof } from '../../../server/modules/peer-relay/peer-wire.ts';

import { findValueInTree } from './safeguards.mjs';
import { answerPrompts, api, humanTurn, login, memberSocket, seedMembers, startServer } from './server/stack.mjs';

// Ref'd on purpose: an unref'd wait lets node exit silently once the server closes its sockets.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const GOVERNANCE = path.join(process.env.HOME, '.claude', 'CLAUDE.md');

async function poll(fn, ms, every = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(every);
  }
  return null;
}

async function setup(run, cliPath, credentials, tag) {
  const dirs = {};
  for (const key of ['a1', 'b1']) { dirs[key] = path.join(run.dir, `${key}-${tag}`); fs.mkdirSync(dirs[key], { mode: 0o700 }); }
  const server = await startServer({ run, cliPath, credentials, tag });
  const seeded = seedMembers({ run, server, dirs, credentials, governancePath: GOVERNANCE });
  const tokens = { a: await login(server.origin, 'p2_a', seeded.members.a.password),
    b: await login(server.origin, 'p2_b', seeded.members.b.password) };
  const socks = { a: await memberSocket(server.origin, tokens.a), b: await memberSocket(server.origin, tokens.b) };
  run.onCleanup(() => { socks.a.close(); socks.b.close(); });
  return { server, seeded, tokens, socks, dirs };
}

const heldFor = (ctx, who, fromSession) => poll(async () => {
  const { json } = await api(ctx.server.origin, ctx.tokens[who], 'GET', '/api/peer-relay/holds');
  return (json.holds ?? []).find((h) => h.fromSessionId === fromSession) ?? null;
}, 240_000);

const messageView = async (ctx, who, sessionId, id) => {
  const { json } = await api(ctx.server.origin, ctx.tokens[who], 'GET', `/api/sessions/${sessionId}/peer-messages`);
  return (json.data?.messages ?? json.messages ?? []).find((m) => m.id === id) ?? null;
};

async function approveAndDeliver(ctx, who, hold, targetSession) {
  const res = await api(ctx.server.origin, ctx.tokens[who], 'POST', `/api/peer-relay/holds/${hold.id}/approve`,
    { expectedHoldVersion: hold.holdVersion, expectedTextHash: hold.bodySha256, expectedTargetMode: hold.targetMode });
  if (res.status !== 200) return { approve: res.status, code: res.json.code ?? null };
  const replay = await api(ctx.server.origin, ctx.tokens[who], 'POST', `/api/peer-relay/holds/${hold.id}/approve`,
    { expectedHoldVersion: hold.holdVersion, expectedTextHash: hold.bodySha256, expectedTargetMode: hold.targetMode });
  const stopPrompts = answerPrompts(ctx.socks[who], targetSession, true);
  await fetch(`${ctx.server.origin}/__test/peer-relay/dispatcher/tick`, { method: 'POST' }).catch(() => null);
  const done = await poll(async () => {
    const view = await messageView(ctx, who, targetSession, res.json.messageId);
    return view && ['delivered', 'failed', 'refused'].includes(view.state) ? view : null;
  }, 900_000, 3000);
  const answered = await stopPrompts();
  return { approve: 200, replay: replay.status, message: done, answered };
}

function transcriptsOf(ctx) {
  // Transcripts are shared under the server HOME's .claude/projects (per-user dirs link to it).
  const root = ctx.server.home;
  const files = [];
  const walk = (dir) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(full);
      else if (e.isFile() && full.endsWith('.jsonl')) files.push(full);
    }
  };
  walk(root);
  return files;
}

/** Proof lines (and the frame they carried) for a session id, across every member's transcripts. */
function proofsFor(ctx, sessionId) {
  const lines = transcriptsOf(ctx).filter((f) => path.basename(f) === `${sessionId}.jsonl`)
    .flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }));
  return lines.filter((l) => l && typeof l.message?.content === 'string' && l.message.content.includes('<nassaj-peer-message '))
    .map((l) => ({ proofShape: /ref="([A-Z2-7]{26})"/u.test(l.message.content)
      && isPeerDeliveryProof(l, /ref="([A-Z2-7]{26})"/u.exec(l.message.content)[1]),
    f2: l.message.content.includes('Your user read it and chose to deliver it to you.'),
    sameOwner: l.message.content.includes('same owner') }));
}

const step = (msg) => process.stderr.write(`[p2-live] ${new Date().toISOString()} ${msg}\n`);

/**
 * The AT-1 / AT-1b verdict over a recorded run: card label, approve 200 then replay 409,
 * delivered, READY.txt = OK, A answered the Write prompt (default) or none was raised
 * (acceptEdits), the reply held for B and delivered to b1, F2 proof lines in both transcripts.
 */
export function at1Verdict(r) {
  const answered = r.leg1?.promptsAnsweredByA ?? [];
  const promptOk = r.mode === 'default' ? answered.some((a) => a.toolName === 'Write') : answered.length === 0;
  const f2Proof = (list) => (list ?? []).some((p) => p.proofShape && p.f2 && !p.sameOwner);
  // Every recorded answer on a1's relay turn is A's, interactive and admitted; nothing else answered.
  const ownAnswersOnly = (list, owner, sent) => (list ?? []).length === sent.length
    && (list ?? []).every((d) => d.userId === owner && INTERACTIVE.has(d.requesterAuthKind) && d.admitted && d.requesterIsOwner
      && sent.some((a) => a.requestId === d.requestId) && d.toolName !== 'ExitPlanMode');
  const decisionsOk = ownAnswersOnly(r.decisions?.a1, r.members?.a, answered)
    && ownAnswersOnly(r.decisions?.b1, r.members?.b, r.leg2?.promptsAnsweredByB ?? []);
  const charged = r.leg1?.chargedUsd > 0 && r.leg2?.chargedUsd > 0 && r.leg1?.deliveredAt < r.leg2?.deliveredAt;
  const resume = r.leg1?.deliveryPath === 'resume' && r.leg2?.deliveryPath === 'resume';
  return r.card?.targetModeLabel === `${r.mode} (this session's last run)` && r.leg1?.approve === 200
    && r.leg1?.replay === 409 && r.leg1?.state === 'delivered' && r.ready === 'OK' && promptOk
    && r.replyHeldForB === true && r.leg2?.approve === 200 && r.leg2?.state === 'delivered'
    && f2Proof(r.proofs?.a1) && f2Proof(r.proofs?.b1) && decisionsOk && charged && resume;
}

const INTERACTIVE = new Set(['session', 'device_session']);

/** Prompt answers the server recorded for a session's relay turns (read-only on the run's test DB). */
function promptDecisions(ctx, sessionId) {
  const db = new Database(ctx.server.db, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT user_id AS userId, metadata FROM audit_log WHERE action = 'peer_relay_prompt_decided'").all()
      .map((row) => ({ userId: row.userId, ...JSON.parse(row.metadata) })).filter((d) => d.sessionId === sessionId)
      .map(({ userId, requestId, toolName, admitted, allow, requesterAuthKind, requesterIsOwner }) =>
        ({ userId, requestId, toolName, admitted, allow, requesterAuthKind, requesterIsOwner }));
  } finally {
    db.close();
  }
}

/** One AT-1 (mode 'default') or AT-1b (mode 'acceptEdits') run. */
export async function runAt1Once(ctx, { mode, model, index }) {
  const a1 = await humanTurn(ctx.socks.a, { cwd: ctx.dirs.a1, command: 'Reply with exactly the word: ready', permissionMode: mode, model });
  step(`a1 ${a1.sessionId} ready`);
  const b1 = await humanTurn(ctx.socks.b, { cwd: ctx.dirs.b1, command: 'Reply with exactly the word: ready', permissionMode: mode, model });
  const ask = `Use the SendMessage tool exactly once with to="nassaj:${a1.sessionId}" and message="Please create a file `
    + `named READY.txt in your current directory containing exactly OK, then send me the word done with SendMessage `
    + `to nassaj:${b1.sessionId}." Then reply: sent.`;
  step(`b1 ${b1.sessionId} ready; B sends`);
  await humanTurn(ctx.socks.b, { cwd: ctx.dirs.b1, sessionId: b1.sessionId, command: ask, permissionMode: mode, model });
  const card = await heldFor(ctx, 'a', b1.sessionId);
  step(`card for A: ${card ? card.id : 'none'}`);
  if (!card) return { index, mode, pass: false, failure: 'no card for A' };
  const leg1 = await approveAndDeliver(ctx, 'a', card, a1.sessionId);
  step(`leg1 ${JSON.stringify({ approve: leg1.approve, state: leg1.message?.state, answered: leg1.answered?.length })}`);
  const readyPath = path.join(ctx.dirs.a1, 'READY.txt');
  const ready = fs.existsSync(readyPath) ? fs.readFileSync(readyPath, 'utf8').trim() : null;
  const reply = await heldFor(ctx, 'b', a1.sessionId);
  step(`reply for B: ${reply ? reply.id : 'none'}`);
  const leg2 = reply ? await approveAndDeliver(ctx, 'b', reply, b1.sessionId) : null;
  const proofsA = proofsFor(ctx, a1.sessionId);
  const proofsB = proofsFor(ctx, b1.sessionId);
  const result = {
    index, mode, card: { fromMemberName: card.fromMemberName, fromName: card.fromName, targetModeLabel: card.targetModeLabel,
      body: card.body, toUserId: card.toUserId },
    members: { a: ctx.seeded.members.a.id, b: ctx.seeded.members.b.id },
    leg1: { approve: leg1.approve, replay: leg1.replay, state: leg1.message?.state, cause: leg1.message?.cause,
      chargedUsd: leg1.message?.costUsdCharged ?? null, deliveryPath: leg1.message?.deliveryPath ?? null,
      deliveredAt: leg1.message?.deliveredAt ?? null, promptsAnsweredByA: leg1.answered ?? [] },
    ready, replyHeldForB: Boolean(reply), replyBody: reply?.body ?? null,
    leg2: leg2 && { approve: leg2.approve, state: leg2.message?.state, chargedUsd: leg2.message?.costUsdCharged ?? null,
      deliveryPath: leg2.message?.deliveryPath ?? null, deliveredAt: leg2.message?.deliveredAt ?? null,
      promptsAnsweredByB: leg2.answered ?? [] },
    decisions: { a1: promptDecisions(ctx, a1.sessionId), b1: promptDecisions(ctx, b1.sessionId) },
    proofs: { a1: proofsA, b1: proofsB },
  };
  result.pass = at1Verdict(result);
  return result;
}

/** AT-1 then AT-1b on a fresh stack each; `--runs n` repeats. Bait scanned across the run. */
export async function runServerSuite({ run, credentials, cliPath, bait, model = 'opus', runs = 1, only = ['default', 'acceptEdits'] }) {
  const results = [];
  for (let i = 1; i <= runs; i++) {
    for (const mode of only) {
      const ctx = await setup(run, cliPath, credentials, `${mode === 'default' ? 'd' : 'e'}${i}`);
      results.push(await runAt1Once(ctx, { mode, model, index: i }).catch((error) => ({ index: i, mode, pass: false,
        failure: error instanceof Error ? error.message : String(error) })));
      ctx.server.child.kill('SIGTERM');
      await sleep(2000);
    }
  }
  const baitHits = findValueInTree([run.dir], bait.value, { exclude: [path.dirname(bait.path)] });
  for (const r of results) process.stdout.write(`${JSON.stringify({ test: r.mode === 'default' ? 'AT-1' : 'AT-1b', ...r })}\n`);
  return { test: 'server', pass: results.every((r) => r.pass) && baitHits.length === 0,
    at1: `${results.filter((r) => r.mode === 'default' && r.pass).length}/${results.filter((r) => r.mode === 'default').length}`,
    at1b: `${results.filter((r) => r.mode === 'acceptEdits' && r.pass).length}/${results.filter((r) => r.mode === 'acceptEdits').length}`,
    baitHits: baitHits.length };
}
