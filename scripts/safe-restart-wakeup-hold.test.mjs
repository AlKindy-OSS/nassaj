#!/usr/bin/env node
// ============================================================================
// scripts/safe-restart-wakeup-hold.test.mjs  (B-1699, qa veto C1)
// ----------------------------------------------------------------------------
// A claude run held ONLY for a scheduled wake-up (`/loop`) must not count as a
// live session in the safe-restart scan: the drain releases it at its start, so
// counting it blocked safe-restart and the update button for as long as the loop
// lived. The server publishes those CLI pids (with its own pid) on /health for
// direct local callers; the scan honours the list only for the server it walks.
//
// Integration: a stand-in "server" process with a real `claude`-named child, a
// stand-in /health, and the script's OWN scan functions (`_read_wakeup_holds` and
// `_scan_session_json`, cut verbatim from safe-restart.sh and sourced by bash) — the
// whole script stops earlier on a host whose process is not in pm2. Read-only.
//
// Run: node scripts/safe-restart-wakeup-hold.test.mjs   (exit 0 = pass)
// ============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'safe-restart.sh');
let pass = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); return; }
  failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
};

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'b1699-sr-'));
const claudeBin = path.join(dir, 'claude');
// A node script named `claude`: its cmdline is `node …/claude`, which the scan reads as claude.
fs.writeFileSync(claudeBin, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });

// The stand-in server: a node process whose direct child is `claude` (as the SDK spawns it).
const server = spawn(process.execPath, ['-e',
  `const c=require('child_process').spawn(${JSON.stringify(claudeBin)},[],{stdio:'ignore'});`
  + 'process.stdout.write(String(c.pid)+"\\n");setInterval(()=>{},1000);'], { stdio: ['ignore', 'pipe', 'ignore'] });
const claudePid = await new Promise((resolve) => server.stdout.once('data', d => resolve(Number(String(d).trim()))));
await new Promise(resolve => setTimeout(resolve, 300)); // let the child exec

let health = {};
const healthServer = http.createServer((req, res) => { res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', ...health })); });
await new Promise(resolve => healthServer.listen(0, '127.0.0.1', resolve));
const healthUrl = `http://127.0.0.1:${healthServer.address().port}/health`;

// The two functions, verbatim from the script (from `_read_wakeup_holds() {` to the
// closing brace after the scan's NODE heredoc).
const source = fs.readFileSync(SCRIPT, 'utf8');
const from = source.indexOf('_read_wakeup_holds() {');
const to = source.indexOf('\nNODE\n}\n', source.indexOf('_scan_session_json() {'));
if (from < 0 || to < 0) throw new Error('scan functions not found in safe-restart.sh');
const functionsFile = path.join(dir, 'scan-functions.sh');
fs.writeFileSync(functionsFile, `${source.slice(from, to + '\nNODE\n}\n'.length)}\n_scan_session_json\n`);

/** The scan's JSON for the stand-in server, through the script's own functions. */
// Asynchronous on purpose: the stand-in /health runs in this process's event loop.
async function scan() {
  const child = spawn('bash', [functionsFile], { cwd: path.join(here, '..'),
    env: { ...process.env, SERVER_PID: String(server.pid), HEALTH_URL: healthUrl } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise(resolve => child.on('close', resolve));
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  let json = null;
  try { json = JSON.parse(line); } catch { /* reported below */ }
  return { code, json, stderr };
}

try {
  console.log('# safe-restart: wake-up-only holds are not live sessions (B-1699 C1)');
  ok('the stand-in claude child is alive', Number.isInteger(claudePid) && fs.existsSync(`/proc/${claudePid}`));

  health = {};
  const counted = await scan();
  ok('without a hold list the held claude counts as a live session (fail-closed)',
    counted.json?.sessionCount === 1, JSON.stringify(counted.json)?.slice(0, 200) || counted.stderr.slice(-300));

  health = { serverPid: server.pid, claudeWakeupHoldPids: [claudePid] };
  const exempt = await scan();
  ok('a pid the server holds only for a wake-up is not counted', exempt.json?.sessionCount === 0,
    JSON.stringify(exempt.json)?.slice(0, 300));
  ok('it is listed as a wake-up hold instead',
    exempt.json?.wakeupHoldSessions?.some(s => s.pid === claudePid) === true);
  ok('and the safe-restart deferral reads sessionCount from this scan',
    /SESSION_COUNT="\$\(printf '%s' "\$SESSION_JSON" \| node -e [^\n]*sessionCount/.test(source)
      && /SESSION_JSON="\$\(_scan_session_json\)"/.test(source));

  health = { serverPid: server.pid + 1, claudeWakeupHoldPids: [claudePid] };
  const foreign = await scan();
  ok('a list from another server pid is ignored', foreign.json?.sessionCount === 1);

  health = { serverPid: server.pid, claudeWakeupHoldPids: [claudePid + 100000] };
  const other = await scan();
  ok('a pid that is not the session is not exempted', other.json?.sessionCount === 1);
} finally {
  healthServer.close();
  try { process.kill(claudePid, 'SIGKILL'); } catch { /* gone */ }
  server.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures.length ? 'FAIL' : 'PASS'}: ${pass} ok, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error(`  - ${f}`); process.exit(1); }
