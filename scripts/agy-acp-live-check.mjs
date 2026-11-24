#!/usr/bin/env node
/**
 * T-2094 / ADR-232 — live exit gate for NASSAJ_AGY_ACP. SKIPPED BY DEFAULT.
 *
 * Runs the real `agy` against a TEST member account (never the owner's
 * credentials) in a fresh directory under /var/tmp, and proves:
 *   1. no history replay on resume (the process is killed between turns);
 *   2. the transcript is complete on disk at end_turn;
 *   3. tool parity with `agy -p`: a file-read tool and a shell tool;
 *   4. authenticated RSS of the ACP process after two turns.
 *
 * Usage (the owner, on the host):
 *   AGY_ACP_LIVE_HOME=/path/to/test-member-home \
 *     node scripts/agy-acp-live-check.mjs --i-am-using-a-test-account
 * AGY_ACP_LIVE_HOME must already hold the TEST account's agy login
 * (~/.gemini/antigravity-cli/antigravity-oauth-token). Optional AGY_BIN.
 * The work directory is deleted at the end. Exit 0 = gate passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAcpSessionClient } from '../server/modules/providers/shared/acp/acp-session-client.js';

const FLAG = '--i-am-using-a-test-account';
const AGY = process.env.AGY_BIN || path.join(os.homedir(), '.local', 'bin', 'agy');
const ACP_ARGS = ['acp', '--dangerously-skip-permissions', '--disable-telemetry'];

/** Refuses anything but an explicit test HOME distinct from the operator's. */
function resolveTestHome() {
  if (!process.argv.includes(FLAG)) return null;
  const home = process.env.AGY_ACP_LIVE_HOME;
  if (!home || !fs.existsSync(home)) throw new Error('AGY_ACP_LIVE_HOME must name an existing TEST member home.');
  const real = fs.realpathSync(home);
  if (real === fs.realpathSync(os.userInfo().homedir)) throw new Error('Refusing the operator home: use a TEST member account.');
  const token = path.join(real, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  if (!fs.existsSync(token)) throw new Error('The test home has no agy login (antigravity-oauth-token).');
  return real;
}

/** Starts one `agy acp` child + client in `cwd` under the test HOME. */
function startAcp(home, cwd) {
  const child = spawn(AGY, [...ACP_ARGS, '--add-dir', cwd], { cwd, env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  const updates = [];
  const client = createAcpSessionClient({ input: child.stdout, output: child.stdin });
  child.stdout.on('data', (b) => { if (String(b).includes('session/update')) updates.push(Date.now()); });
  return { child, client, updates };
}

/** One prompt; returns the streamed text and the stopReason. */
async function ask(acp, sessionId, text) {
  let reply = '';
  const stopReason = await acp.client.prompt({ sessionId, text, onEvent: (e) => { if (e.type === 'text') reply += e.text; } });
  return { reply, stopReason };
}

function stop(acp) {
  acp.client.dispose();
  acp.child.kill('SIGKILL');
}

/** Planner replies on disk for `sessionId` (DONE steps only). */
function transcriptReplies(home, sessionId) {
  const file = path.join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  return lines.map((l) => JSON.parse(l)).filter((s) => s.type === 'PLANNER_RESPONSE' && s.status === 'DONE').map((s) => String(s.content));
}

function rssKb(pid) {
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  return match ? Number(match[1]) : null;
}

/** Checks 1, 2 and 4: two turns with a restart, replay counted, transcript and RSS read. */
async function checkResume(home, cwd) {
  const first = startAcp(home, cwd);
  await first.client.withAuth(() => first.client.initialize(), () => null);
  const { sessionId } = await first.client.withAuth(() => first.client.newSession({ cwd }), () => 'oauth-personal');
  const one = await ask(first, sessionId, 'Reply with exactly the word ALPHA and nothing else.');
  const onDisk = transcriptReplies(home, sessionId).some((r) => r.includes('ALPHA'));
  stop(first);
  const second = startAcp(home, cwd);
  await second.client.initialize();
  const before = second.updates.length;
  await second.client.withAuth(() => second.client.openExistingSession({ sessionId, cwd }), () => 'oauth-personal');
  const replayedUpdates = second.updates.length - before;
  const two = await ask(second, sessionId, 'Reply with exactly the word BRAVO and nothing else.');
  const rss = rssKb(second.child.pid);
  stop(second);
  return {
    noReplay: two.reply.includes('BRAVO') && !two.reply.includes('ALPHA'),
    transcriptCompleteAtEndTurn: one.stopReason === 'end_turn' && onDisk,
    replayedUpdatesSuppressed: replayedUpdates,
    authenticatedRssKbAfterTwoTurns: rss,
    replies: [one.reply, two.reply],
  };
}

const TOOL_PROMPTS = {
  fileRead: 'Use your file-reading tool to read probe.txt in the workspace and reply with its exact content only.',
  shell: 'Use your shell tool to run `echo parity-$((6*7))` and reply with its exact output only.',
};

function askPrint(home, cwd, text) {
  const r = spawnSync(AGY, ['-p', text, '--dangerously-skip-permissions', '--add-dir', cwd], { cwd, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 300_000 });
  return String(r.stdout || '');
}

/** Check 3: the same tool prompts through ACP and through `-p`. */
async function checkToolParity(home, cwd) {
  const acp = startAcp(home, cwd);
  await acp.client.initialize();
  const results = {};
  for (const [name, text] of Object.entries(TOOL_PROMPTS)) {
    const { sessionId } = await acp.client.withAuth(() => acp.client.newSession({ cwd }), () => 'oauth-personal');
    const viaAcp = (await ask(acp, sessionId, text)).reply;
    const viaPrint = askPrint(home, cwd, text);
    const expected = name === 'fileRead' ? 'probe-content-7f3a' : 'parity-42';
    results[name] = { acp: viaAcp.includes(expected), print: viaPrint.includes(expected) };
  }
  stop(acp);
  return results;
}

async function main() {
  const home = resolveTestHome();
  if (!home) {
    console.log(`agy-acp-live-check: skipped (pass ${FLAG} with AGY_ACP_LIVE_HOME set to a TEST member home).`);
    return 0;
  }
  const cwd = fs.mkdtempSync('/var/tmp/agy-acp-live-');
  try {
    fs.writeFileSync(path.join(cwd, 'probe.txt'), 'probe-content-7f3a\n');
    const resume = await checkResume(home, cwd);
    const tools = await checkToolParity(home, cwd);
    const passed = resume.noReplay && resume.transcriptCompleteAtEndTurn
      && Object.values(tools).every((t) => t.acp && t.acp === t.print);
    console.log(JSON.stringify({ passed, resume, tools }, null, 2));
    return passed ? 0 : 1;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code), (error) => {
  console.error(`agy-acp-live-check: ${error.message}`);
  process.exit(2);
});
