// Recording-only ACP client for dsh (T-2086 S1). Not shipped.
// Usage: node acp-recorder.mjs <plan.json> <trafficLog> -- <command> [args...]
// The plan is a list of steps: {method, params} | {wait:ms} | {permission:'allow-once'|'reject-once'}.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const sep = process.argv.indexOf('--');
const [planFile, logFile] = process.argv.slice(2, sep);
const [command, ...args] = process.argv.slice(sep + 1);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'pipe'], env: process.env, cwd: process.env.REC_CWD });
const log = (dir, msg) => fs.appendFileSync(logFile, `${JSON.stringify({ dir, msg })}\n`);
child.stderr.on('data', (d) => fs.appendFileSync(`${logFile}.stderr`, d));

let nextId = 0;
const pending = new Map();
const permissionQueue = [];
let session = null;
const send = (msg) => { log('client->agent', msg); child.stdin.write(`${JSON.stringify(msg)}\n`); };
const request = (method, params) => new Promise((resolve) => {
  const id = (nextId += 1);
  pending.set(id, resolve);
  send({ jsonrpc: '2.0', id, method, params });
});

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { log('agent-stdout-raw', line); return; }
  log('agent->client', msg);
  if (msg.id !== undefined && msg.method === undefined) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'session/request_permission') {
    const optionId = permissionQueue.shift() ?? 'reject-once';
    send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId } } });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `client does not implement ${msg.method}` } });
  }
});

// T-2089 S0 probe additions: socket and fd inventory of the dsh pid.
const probeOut = `${logFile}.proc`;
const snap = (label) => {
  const ss = spawnSync('ss', ['-H', '-ltunp'], { encoding: 'utf8' }).stdout ?? '';
  const mine = ss.split('\n').filter((l) => l.includes(`pid=${child.pid},`));
  let fds = [];
  try { fds = fs.readdirSync(`/proc/${child.pid}/fd`).map((f) => `${f}->${fs.readlinkSync(`/proc/${child.pid}/fd/${f}`)}`); } catch {}
  const lsof = spawnSync('lsof', ['-a', '-p', String(child.pid), '-i'], { encoding: 'utf8' });
  fs.appendFileSync(probeOut, `${JSON.stringify({ label, pid: child.pid, listening: mine, lsofInet: lsof.stdout ?? lsof.error?.code, fds })}\n`);
};

const fill = (value) => JSON.parse(JSON.stringify(value).replaceAll('$SESSION', session ?? ''));
for (const step of plan) {
  if (step.wait) { await new Promise((r) => setTimeout(r, step.wait)); continue; }
  if (step.permission) { permissionQueue.push(step.permission); continue; }
  if (step.notify) { send({ jsonrpc: '2.0', method: step.notify, params: fill(step.params) }); continue; }
  if (step.noWait) { request(step.method, fill(step.params)).then(() => snap('prompt-settled')); continue; }
  const reply = await Promise.race([
    request(step.method, fill(step.params)),
    new Promise((r) => setTimeout(() => r({ timeout: step.method }), step.timeoutMs ?? 60000)),
  ]);
  if (reply.timeout) { log('recorder', { timeout: reply.timeout }); break; }
  if (step.method === 'session/new' && reply.result?.sessionId) { session = reply.result.sessionId; snap('after-session-new'); }
  if (step.method === 'session/prompt') snap('after-prompt');
  if (step.saveSessionTo && session) fs.writeFileSync(step.saveSessionTo, session);
}
child.stdin.end();
const killer = setTimeout(() => child.kill('SIGTERM'), 10000);
child.on('exit', (code, signal) => { clearTimeout(killer); log('recorder', { exit: code, signal }); });
