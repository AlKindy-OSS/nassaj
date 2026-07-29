#!/usr/bin/env node
/**
 * nassaj doctor (T-1085) — pre-flight for "why won't this install boot?".
 *
 * Every check here exists because it actually cost someone hours: the
 * docker-group boot refusal on a deployed node (2026-07-29), devDependencies pruned
 * by NODE_ENV=production so `build` fails, a port already held by a stale
 * daemon, an unwritable DATABASE_PATH, a JWT_SECRET too short for auth.js.
 *
 * Contract: READ-ONLY. It never edits a file, installs anything, or touches the
 * host — it prints the exact command YOU run. Exit 1 if any check FAILS
 * (nassaj will not work), 0 if everything is ok or only WARNS.
 *
 *   npm run doctor
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GREEN = '[32m';
const YELLOW = '[33m';
const RED = '[31m';
const DIM = '[2m';
const RESET = '[0m';

/** @type {{ level: 'ok'|'warn'|'fail', name: string, detail: string, fix: string[] }[]} */
const results = [];

const ok = (name, detail) => results.push({ level: 'ok', name, detail, fix: [] });
const warn = (name, detail, ...fix) => results.push({ level: 'warn', name, detail, fix });
const fail = (name, detail, ...fix) => results.push({ level: 'fail', name, detail, fix });

/** Reads .env into a plain object without mutating process.env. */
function readDotEnv() {
  const file = path.join(ROOT, '.env');
  /** @type {Record<string, string>} */
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { exists: false, values: out, mode: null };
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  let mode = null;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* unreadable mode is not itself a finding */
  }
  return { exists: true, values: out, mode };
}

const env = readDotEnv();
/** .env wins for a doctor run: it is what the server will load at boot. */
const cfg = (key, fallback = undefined) => env.values[key] ?? process.env[key] ?? fallback;

// ---------------------------------------------------------------------------
// 1. Node runtime
// ---------------------------------------------------------------------------
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  let range = '>=22 <25';
  try {
    range = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines?.node ?? range;
  } catch {
    /* keep the documented default */
  }
  // engines is a simple ">=A <B" range in this repo; parse just that shape.
  const min = Number(/>=\s*(\d+)/.exec(range)?.[1] ?? 22);
  const maxExclusive = Number(/<\s*(\d+)/.exec(range)?.[1] ?? 99);
  if (major >= min && major < maxExclusive) {
    ok('node runtime', `v${process.versions.node} satisfies ${range}`);
  } else {
    fail(
      'node runtime',
      `v${process.versions.node} is outside ${range}`,
      `install Node ${min}.x  (nvm install ${min} && nvm use ${min})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Docker-socket posture (the 2026-07-29 boot refusal, T-896/B-170/T-1085)
// ---------------------------------------------------------------------------
function checkDockerSocket() {
  const sock = '/var/run/docker.sock';
  let sockGid;
  try {
    sockGid = fs.statSync(sock).gid;
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      ok('docker socket', 'no docker socket on this host — nothing to escape to');
      return;
    }
    warn(
      'docker socket',
      `${sock} exists but cannot be stat-ed (${err?.code || err?.message}); a SHARED-host install will refuse to boot`,
      `stat ${sock}`,
      'ls -ld /var /var/run /run   # look for permission or symlink damage',
    );
    return;
  }

  const gids = new Set([
    ...(typeof process.getgroups === 'function' ? process.getgroups() : []),
    ...(typeof process.getgid === 'function' ? [process.getgid()] : []),
    ...(typeof process.getegid === 'function' ? [process.getegid()] : []),
  ]);
  if (!gids.has(sockGid)) {
    ok('docker socket', `owned by gid ${sockGid}; this user does not hold it`);
    return;
  }

  // Held. Harmless on a single-user box (this human can already run docker),
  // fatal on a shared one — where the boot guard still refuses, by design.
  warn(
    'docker socket',
    `this user holds gid ${sockGid}, which owns ${sock}: nassaj can reach Docker and therefore host root. ` +
      'Single-user install: boots with a warning. Shared host (>1 account, platform mode, or ' +
      'NASSAJ_SECURITY_POSTURE=strict): REFUSES to boot.',
    `sudo gpasswd -d ${os.userInfo().username} docker`,
    'log out and back in, then: pm2 kill && pm2 resurrect   # a plain restart keeps the stale group',
  );
}

// ---------------------------------------------------------------------------
// 3. .env and secrets
// ---------------------------------------------------------------------------
function checkEnv() {
  if (!env.exists) {
    warn(
      '.env',
      'missing — the server will fall back to built-in defaults (port 3001, per-install JWT secret in the database)',
      'cp .env.example .env && chmod 600 .env',
    );
  } else {
    if (env.mode !== null && (env.mode & 0o077) !== 0) {
      warn(
        '.env permissions',
        `mode ${env.mode.toString(8)} is readable by other users on this host`,
        'chmod 600 .env',
      );
    } else {
      ok('.env', 'present and not world/group readable');
    }
  }

  const secret = cfg('JWT_SECRET');
  if (secret === undefined) {
    ok('JWT_SECRET', 'unset — a per-install secret is generated and persisted in the database');
  } else if (secret.length < 32) {
    fail(
      'JWT_SECRET',
      `${secret.length} characters; auth.js refuses to start below 32`,
      'JWT_SECRET=$(openssl rand -hex 32)   # then put it in .env and restart',
    );
  } else {
    ok('JWT_SECRET', `${secret.length} characters`);
  }
}

// ---------------------------------------------------------------------------
// 4. Port availability
// ---------------------------------------------------------------------------
function checkPort() {
  const port = Number(cfg('SERVER_PORT', '3001'));
  const host = cfg('HOST', '0.0.0.0');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        warn(
          'server port',
          `${host}:${port} is already in use — likely a nassaj instance still running (or a stale one holding the port)`,
          `pm2 list   # is this yours?`,
          `ss -ltnp 'sport = :${port}'   # who holds it`,
        );
      } else {
        warn('server port', `cannot bind ${host}:${port} (${err?.code || err?.message})`, `try HOST=127.0.0.1 in .env`);
      }
      resolve();
    });
    srv.once('listening', () => {
      srv.close(() => {
        ok('server port', `${host}:${port} is free`);
        resolve();
      });
    });
    srv.listen(port, host === '0.0.0.0' ? undefined : host);
  });
}

// ---------------------------------------------------------------------------
// 5. Database path
// ---------------------------------------------------------------------------
function checkDatabase() {
  const dbPath = cfg('DATABASE_PATH');
  if (!dbPath) {
    ok('database path', 'DATABASE_PATH unset — the legacy default under $HOME is used');
    return;
  }
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fail('database path', `${dir} does not exist`, `mkdir -p ${dir}`);
    return;
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    fail('database path', `${dir} is not writable by ${os.userInfo().username}`, `sudo chown -R $(whoami) ${dir}`);
    return;
  }
  ok('database path', `${dbPath}${fs.existsSync(dbPath) ? '' : ' (will be created on first boot)'}`);
}

// ---------------------------------------------------------------------------
// 6. Dependencies and build artefacts
// ---------------------------------------------------------------------------
function checkBuild() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    fail('dependencies', 'node_modules is missing', 'npm install --include=dev');
    return;
  }
  // NODE_ENV=production makes `npm install` prune devDependencies, and then
  // `npm run build` fails on a missing vite/tsc (memory: project_nassaj_dev_quirks).
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'vite'))) {
    fail(
      'dependencies',
      'devDependencies are pruned (vite absent) — `npm run build` cannot run. This is what NODE_ENV=production does to npm install.',
      'npm install --include=dev',
    );
  } else {
    ok('dependencies', 'installed, including devDependencies');
  }

  const client = path.join(ROOT, 'dist', 'index.html');
  const server = path.join(ROOT, 'dist-server', 'server', 'index.js');
  const missing = [client, server].filter((p) => !fs.existsSync(p));
  if (missing.length === 2) {
    warn('build artefacts', 'no build yet (dist/ and dist-server/ absent)', 'npm run build');
  } else if (missing.length === 1) {
    warn('build artefacts', `${path.relative(ROOT, missing[0])} is missing — half-built tree`, 'npm run build');
  } else {
    ok('build artefacts', 'dist/ and dist-server/ present');
  }
}

// ---------------------------------------------------------------------------
// 7. node-pty native binding (terminals silently die without it)
// ---------------------------------------------------------------------------
async function checkNodePty() {
  try {
    await import('node-pty');
    ok('node-pty', 'native binding loads');
  } catch (err) {
    warn(
      'node-pty',
      `cannot load (${err?.message?.split('\n')[0] || 'unknown error'}) — the terminal panel will not work`,
      'npm rebuild node-pty   # or: node scripts/fix-node-pty.js',
    );
  }
}

// ---------------------------------------------------------------------------

function report() {
  const icon = { ok: `${GREEN}✓${RESET}`, warn: `${YELLOW}!${RESET}`, fail: `${RED}✗${RESET}` };
  console.log('\nnassaj doctor\n');
  for (const r of results) {
    console.log(`  ${icon[r.level]} ${r.name}: ${r.detail}`);
    for (const line of r.fix) {
      console.log(`      ${DIM}→ ${line}${RESET}`);
    }
  }
  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(
    `\n  ${results.length - fails - warns} ok, ${warns} warning(s), ${fails} blocking problem(s)\n`,
  );
  if (fails > 0) {
    console.log(`  ${RED}nassaj will not start until the ✗ items are fixed.${RESET}\n`);
  }
  process.exit(fails > 0 ? 1 : 0);
}

checkNode();
checkDockerSocket();
checkEnv();
await checkPort();
checkDatabase();
checkBuild();
await checkNodePty();
report();
