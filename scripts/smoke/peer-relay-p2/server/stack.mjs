/**
 * Live suite stack: the REAL dev server (server/index.js) on a spare loopback
 * port with the run's fenced DB and HOME, members seeded and logged in over
 * HTTP, and one WebSocket client per member speaking the UI's own messages
 * (claude-command, get-pending-permissions, claude-permission-response).
 * Server output goes to `<run>/server.log` (scanned for the bait, never printed).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import WebSocket from 'ws';

import { assertDatabaseFence } from '../safeguards.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
// Ref'd on purpose: an unref'd wait lets node exit silently once the server closes its sockets.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function sparePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** Boots the server; refuses unless the DB passes the live-data fence. */
export async function startServer({ run, cliPath, credentials, tag }) {
  const home = path.join(run.dir, `home-srv-${tag}`);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true, mode: 0o700 });
  // The DB sits directly in the run dir: the server's own fence accepts nothing deeper.
  const db = assertDatabaseFence(path.join(run.dir, `db-${tag}.sqlite`), run.dir);
  const port = await sparePort();
  const env = {
    PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home, TMPDIR: '/var/tmp', NODE_ENV: 'development',
    ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    DATABASE_PATH: db, SERVER_PORT: String(port), HOST: '127.0.0.1', JWT_SECRET: randomBytes(48).toString('hex'),
    NASSAJ_PEER_RELAY_TEST_SEAMS: '1', CLAUDE_CLI_PATH: cliPath, WORKSPACES_ROOT: run.dir, NASSAJ_GRAPHIFY: '0',
    TSX_TSCONFIG_PATH: path.join(REPO, 'server/tsconfig.json'),
    ...(process.env.NASSAJ_LIVE_DATABASE_PATH ? { NASSAJ_LIVE_DATABASE_PATH: process.env.NASSAJ_LIVE_DATABASE_PATH } : {}),
    ...(credentials.mode === 'env' ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } : {}),
  };
  const log = fs.openSync(path.join(run.dir, `server-${tag}.log`), 'a', 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.js'], { cwd: REPO, env, stdio: ['ignore', log, log] });
  run.onCleanup(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('test server exited during boot (see run server.log)');
    try { if ((await fetch(`${origin}/health`)).ok) return { origin, port, home, db, env, child }; } catch { /* booting */ }
    await sleep(500);
  }
  throw new Error('test server did not become healthy');
}

/** Seeds members/projects through the repository (the server is up, WAL) and writes each member's credential home. */
export function seedMembers({ run, server, dirs, credentials, governancePath }) {
  const out = spawnSync('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', path.join(REPO, 'scripts/smoke/peer-relay-p2/server/seed-members.mts')],
    { cwd: REPO, encoding: 'utf8', env: { ...server.env, NASSAJ_PEER_RELAY_TEST_SEAMS: '', P2_DIRS: JSON.stringify(dirs) } });
  const line = (out.stdout || '').trim().split('\n').reverse().find((l) => l.startsWith('{"members"'));
  if (!line) throw new Error('seeding failed');
  const seeded = JSON.parse(line);
  fs.copyFileSync(fs.realpathSync(governancePath), path.join(server.home, '.claude', 'CLAUDE.md'));
  fs.symlinkSync(path.join(process.env.HOME, 'nassaj-core'), path.join(server.home, 'nassaj-core'));
  for (const { id } of Object.values(seeded.members)) {
    const dir = path.join(server.home, '.nassaj-users', String(id), '.claude');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(fs.realpathSync(governancePath), path.join(dir, 'CLAUDE.md'));
    if (credentials.mode === 'file') fs.writeFileSync(path.join(dir, '.credentials.json'), credentials.fileContents, { mode: 0o600 });
  }
  return seeded;
}

export async function login(origin, username, password) {
  const res = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }) });
  const body = await res.json();
  if (!res.ok || typeof body.token !== 'string') throw new Error(`login failed for ${username} (${res.status})`);
  return body.token;
}

/** JSON over HTTP as a logged-in member. */
export async function api(origin, token, method, route, body) {
  const res = await fetch(`${origin}${route}`, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** A member's UI socket: every frame recorded; helpers to send and wait. */
export async function memberSocket(origin, token) {
  const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`);
  const frames = [];
  ws.on('message', (data) => { try { frames.push({ at: Date.now(), f: JSON.parse(String(data)) }); } catch { /* binary */ } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const waitFor = async (pred, ms, since = 0) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = frames.find((e) => e.at >= since && pred(e.f));
      if (hit) return hit.f;
      await sleep(250);
    }
    return null;
  };
  return { ws, frames, send: (obj) => ws.send(JSON.stringify(obj)), waitFor, close: () => ws.close() };
}

/** One human turn through the UI's own `claude-command`; resolves with the session id once complete. */
export async function humanTurn(sock, { cwd, sessionId = null, command, permissionMode, model }) {
  const clientMsgId = `p2-${randomBytes(6).toString('hex')}`;
  const since = Date.now();
  sock.send({ type: 'claude-command', command, options: { projectPath: cwd, cwd, sessionId, resume: Boolean(sessionId),
    permissionMode, model, clientMsgId } });
  const created = sessionId ? null : await sock.waitFor((f) => f.kind === 'session_created', 180_000, since);
  const sid = sessionId ?? created?.newSessionId ?? null;
  const done = await sock.waitFor((f) => f.kind === 'complete' && (!sid || f.sessionId === sid), 600_000, since);
  if (!sid || !done) throw new Error('human turn did not complete');
  return { sessionId: sid, since };
}

/**
 * Answers every pending permission prompt of `sessionId` as this member, through
 * the UI's own path (get-pending-permissions → claude-permission-response).
 * Returns a stop() that resolves with the answered requests.
 */
export function answerPrompts(sock, sessionId, allow = true) {
  const answered = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      sock.send({ type: 'get-pending-permissions', sessionId });
      await sleep(1000);
      const lists = sock.frames.filter((e) => e.f.type === 'pending-permissions-response' && e.f.sessionId === sessionId);
      for (const entry of lists.at(-1)?.f.data ?? []) {
        if (!entry.requestId || answered.some((a) => a.requestId === entry.requestId)) continue;
        answered.push({ requestId: entry.requestId, toolName: entry.toolName ?? null });
        sock.send({ type: 'claude-permission-response', requestId: entry.requestId, allow });
      }
    }
  })();
  return async () => { stopped = true; await loop; return answered; };
}
