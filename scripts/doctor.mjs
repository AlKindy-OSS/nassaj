#!/usr/bin/env node
/**
 * nassaj doctor (T-1085) — pre-flight for "why won't this install boot?".
 *
 * Every check here exists because it actually cost someone hours: the
 * docker-group boot refusal on a deployed node (2026-07-29), devDependencies pruned
 * by NODE_ENV=production so `build` fails, a port already held by a stale
 * daemon, an unwritable DATABASE_PATH, a JWT_SECRET too short for auth.js.
 *
 * Contract: READ-ONLY by default. It never edits a file, installs anything, or
 * touches the host — it prints the exact command YOU run. Exit 1 if any check
 * FAILS (nassaj will not work), 0 if everything is ok or only WARNS. The two
 * exceptions are the owner-privileged writers below (`--reopen-gate` and
 * `--seal-overlay`); `--explain-divergence` stays strictly read-only.
 *
 *   npm run doctor
 *   npm run doctor -- --update-preflight
 *   npm run doctor -- --reopen-gate [--complete-source-rollback] [--yes] [--project <path>]
 *   sudo npm run doctor -- --seal-overlay
 *   npm run doctor -- --explain-divergence [--target <ref>]
 *
 * `--seal-overlay` (ADR-156 §3.1 C1.1, T-1730 W10) is the owner-privileged
 * sealer: it enumerates each overlay mount directory, REFUSES every symlink and
 * non-regular file, and writes `config/node-overlay.lock.json` (sha256 + size
 * per file, keyed by the path relative to `config/overlay/` that W3's service
 * matches). Run under `sudo` so the manifest is root-owned; a service-owned
 * manifest is refused by the server.
 *
 * `--explain-divergence` (ADR-156 §3.2.3, M11) classifies the local divergence
 * against a target release and prints — never executes — a backup-branch plus
 * `git reset --keep`. It REFUSES to print when the `code` class is non-empty or
 * the local dependency diff is not contained in the target package.json.
 *
 * `--reopen-gate` (ADR-156 ب.6, WI-14/T-1729) is the ONE writer action in this
 * tool, and it stays outside this file: every writer primitive lives in
 * `scripts/lib/doctor-reopen-gate.mjs`, so the structural contract above holds
 * for doctor.mjs itself. Without `--yes` it prints the plan and changes
 * nothing. With `--yes` it still prints the plan first, asks for the explicit
 * permission a production write needs, copies the maintenance journal into
 * `.artifacts/` before touching it, and only then takes the same ب.5 exit path
 * the server takes on its own. It replaces hand-editing `journal.json`, which
 * is how the 2026-09-11 outage was actually cleared.
 *
 * `--complete-source-rollback` (qa-critic H3) is the same action's second
 * form, under the same consent rules: it takes the exit path a DEGRADED
 * reopen names, returning the source tree to its original commit under the
 * gate's write contract, so `degraded` stops being a dead end.
 *
 * `--update-preflight` (ADR-156 ط.2, WI-8/T-1720) runs exactly the codes of
 * GET /api/system/update/preflight — the same module, not a second copy, so a
 * code added there (`source_state_unreconciled`, `pm2_entry`) arrives here too
 * and no count is kept in this file. A
 * node can be cleared for the bridge release from the command line, including
 * when its server cannot boot. The READ-ONLY contract above is what makes that
 * safe, and it is not relaxed for this mode: no writer action exists in this
 * file. It must be run AS THE PM2 SERVICE ACCOUNT and with the service
 * environment; running it as the operator is the false green that produced
 * B-1053, so the run context is checked first and reported on its own.
 */

import { spawnSync } from 'node:child_process';
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

/** Reads an env file into a plain object without mutating process.env. */
function readDotEnv(file = path.join(ROOT, '.env')) {
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
      'Default (trusted) posture: boots with a warning. NASSAJ_SECURITY_POSTURE=strict or ' +
      'platform mode: REFUSES to boot until this is fixed.',
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
// 8. Update pre-flight (ADR-156 ط.2, WI-8/T-1720) — read-only, opt-in
// ---------------------------------------------------------------------------

/**
 * The pm2 service account that actually owns this install, read with `pm2
 * jlist` — a read command only. Returns null when pm2 cannot be consulted,
 * which is reported as "unverified", never as a pass.
 */
function pm2ServiceAccount() {
  const result = spawnSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout) return null;
  let apps;
  try { apps = JSON.parse(result.stdout); } catch { return null; }
  if (!Array.isArray(apps)) return null;
  const owning = apps.find((app) => {
    try { return fs.realpathSync(app?.pm2_env?.pm_cwd || '') === fs.realpathSync(ROOT); } catch { return false; }
  });
  if (!owning) return null;
  const account = owning.pm2_env?.USER || owning.pm2_env?.username || null;
  return account ? { name: owning.name, account } : null;
}

/**
 * Guard the two ways this run can be a FALSE GREEN (plan ط.2): a different
 * account, whose git credentials and ssh agent are not the ones the updater
 * will have, and an operator token in the environment. Both are reported before
 * any code, because a green result under either is worth nothing.
 */
function checkPreflightRunContext() {
  const current = os.userInfo().username;
  const service = pm2ServiceAccount();
  if (!service) {
    // Unverified is NOT a pass: the whole point of this mode is to certify a
    // node before the jump, and a verdict produced by an account whose
    // credentials may differ from the updater's certifies nothing. It fails, so
    // the exit code never says "cleared" on an unverified run (م-4).
    fail(
      'service account',
      `cannot be verified: pm2 does not report an app whose cwd is ${ROOT}. This verdict is UNTRUSTED — running as anyone but the pm2 service account is a FALSE GREEN, because discovery succeeds with your credentials while the updater's fetch fails (B-1053).`,
      'pm2 jlist   # confirm the app and its USER, then re-run as that account',
    );
  } else if (service.account !== current) {
    fail(
      'service account',
      `running as "${current}" but pm2 runs "${service.name}" as "${service.account}": this result is a FALSE GREEN (B-1053).`,
      `sudo -u ${service.account} -H npm --prefix ${ROOT} run doctor -- --update-preflight`,
    );
  } else {
    ok('service account', `running as the pm2 service account "${current}" for "${service.name}"`);
  }

  const tokens = ['GH_TOKEN', 'GITHUB_TOKEN'].filter((key) => process.env[key]);
  if (tokens.length > 0) {
    warn(
      'fetch environment',
      `${tokens.join(' and ')} present in this shell. The probe strips it, so the result below stays honest — but its presence means this is an operator shell, not the service environment pm2 hands the updater.`,
      `env -u ${tokens.join(' -u ')} npm run doctor -- --update-preflight`,
    );
  } else {
    ok('fetch environment', 'no GH_TOKEN/GITHUB_TOKEN to mask a missing deploy credential');
  }

  ok('write actions', 'none: this run reads git, one lock file and `mv --help`, and writes nothing');
}

/** One code, printed with a single reason and a single action in both languages. */
function printPreflightCode(check) {
  const icon = { ok: `${GREEN}✓${RESET}`, warn: `${YELLOW}!${RESET}`, blocker: `${RED}✗${RESET}` };
  console.log(`  ${icon[check.severity]} ${check.code}`);
  console.log(`      ${DIM}ع:${RESET}  ${check.reason_ar}`);
  console.log(`      ${DIM}en:${RESET} ${check.reason_en}`);
  if (check.action_ar) console.log(`      ${DIM}→ ع:${RESET}  ${check.action_ar}`);
  if (check.action_en) console.log(`      ${DIM}→ en:${RESET} ${check.action_en}`);
  if (check.command) console.log(`      ${DIM}$ ${check.command}${RESET}`);
}

/**
 * Run and print every preflight code. Exits 1 when a blocker is present or when the
 * run context itself invalidates the answer, so this is usable as the gate
 * before the bridge release rather than as advice a human may skim.
 */
async function reportUpdatePreflight() {
  const { runUpdatePreflightChecks } = await import('./lib/update-preflight-checks.mjs');
  checkPreflightRunContext();

  console.log('\nnassaj doctor — update preflight / التحقق المسبق للتحديث\n');
  const icon = { ok: `${GREEN}✓${RESET}`, warn: `${YELLOW}!${RESET}`, fail: `${RED}✗${RESET}` };
  for (const r of results) {
    console.log(`  ${icon[r.level]} ${r.name}: ${r.detail}`);
    for (const line of r.fix) console.log(`      ${DIM}→ ${line}${RESET}`);
  }

  // config/node.env is what pm2 loads into the service environment, and هـ.3
  // makes it the authoritative source of the release-source value — so it wins
  // over .env, not the other way round. The operator shell usually carries
  // neither, which is exactly how a node gets diagnosed against the wrong
  // repository.
  const serviceEnv = {
    ...process.env,
    ...env.values,
    ...readDotEnv(path.join(ROOT, 'config', 'node.env')).values,
  };

  let result;
  try {
    result = await runUpdatePreflightChecks({ appRoot: ROOT, env: serviceEnv });
  } catch (error) {
    console.log(`\n  ${RED}✗ preflight could not run: ${error?.message || error}${RESET}\n`);
    process.exit(1);
  }

  console.log('');
  for (const check of result.checks) printPreflightCode(check);

  const blockers = result.checks.filter((check) => check.severity === 'blocker').length;
  const warnings = result.checks.filter((check) => check.severity === 'warn').length;
  const contextFails = results.filter((r) => r.level === 'fail').length;
  console.log(`\n  ${result.checks.length - blockers - warnings} ok, ${warnings} warning(s), ${blockers} blocker(s)`);
  console.log(`  ${DIM}المحدّث المثبَّت على هذه العقدة / installed updater on this node: ${result.installedVersion || 'unknown'}${RESET}`);
  if (contextFails > 0) {
    console.log(`\n  ${RED}حكم غير موثوق / UNTRUSTED VERDICT: سياق التشغيل أعلاه يُبطل النتيجة، لا تعتمدها حارساً للقفزة.${RESET}`);
  }
  if (result.blocker) {
    console.log(`\n  ${RED}الحاجز / blocker: ${result.blocker.code}${RESET}`);
    console.log(`  ع:  ${result.blocker.ar}`);
    console.log(`  en: ${result.blocker.en}`);
  }
  if (result.repairs.length > 0) {
    console.log(`\n  ${DIM}يصلحها مسار التحديث تحت عقد الكتابة / repaired by the update path under the write contract: ${result.repairs.join(', ')}${RESET}`);
  }
  console.log('');
  process.exit(blockers > 0 || contextFails > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------

/**
 * ADR-156 ب.6 / WI-14. Print the plan, then — only under `--yes`, and only from
 * a run context that is not itself a false green — apply it.
 */
async function reportReopenGate() {
  const { runReopenGate } = await import('./lib/doctor-reopen-gate.mjs');
  const confirmed = process.argv.includes('--yes');
  const completeSourceRollback = process.argv.includes('--complete-source-rollback');
  const projectFlag = process.argv.indexOf('--project');
  const appRoot = projectFlag >= 0 && process.argv[projectFlag + 1] ? path.resolve(process.argv[projectFlag + 1]) : ROOT;

  console.log(completeSourceRollback
    ? '\nnassaj doctor — complete the source rollback / إكمال تراجع المصدر\n'
    : '\nnassaj doctor — reopen maintenance gate / إعادة فتح بوابة الصيانة\n');
  checkPreflightRunContext();
  const icon = { ok: `${GREEN}✓${RESET}`, warn: `${YELLOW}!${RESET}`, fail: `${RED}✗${RESET}` };
  for (const r of results) {
    console.log(`  ${icon[r.level]} ${r.name}: ${r.detail}`);
    for (const line of r.fix) console.log(`      ${DIM}→ ${line}${RESET}`);
  }
  const contextFails = results.filter((r) => r.level === 'fail').length;

  let outcome;
  try {
    outcome = await runReopenGate({
      appRoot,
      confirmed: confirmed && contextFails === 0,
      artifactsRoot: path.join(appRoot, '.artifacts'),
      completeSourceRollback,
    });
  } catch (error) {
    console.log(`\n  ${RED}✗ البوابة غير قابلة للقراءة / the gate could not be read: ${error?.message || error}${RESET}\n`);
    process.exit(1);
  }

  const { plan } = outcome;
  console.log(`\n  ${DIM}العقدة / node: ${appRoot}${RESET}`);
  console.log(`  الآن / now:     state=${plan.from.state} gateClosed=${plan.from.gateClosed} degraded=${plan.from.degraded ?? 'none'}`);
  if (plan.source) console.log(`  المصدر / source: head=${plan.source.head} treeApplied=${plan.source.treeApplied}`);
  if (!plan.to) {
    console.log(`\n  ${YELLOW}لا مسار خروج معرَّف: ${plan.reason}${RESET}`);
    console.log(`  ${YELLOW}no defined exit path; the gate is left exactly as it is.${RESET}\n`);
    process.exit(contextFails > 0 ? 1 : 0);
  }
  console.log(`  بعد التنفيذ / after: state=${plan.to.state} gateClosed=${plan.to.gateClosed} degraded=${plan.to.degraded ?? 'none'}`);
  if (plan.to.exitPath) console.log(`  مسار الخروج / exit path: ${plan.to.exitPath}`);
  if (Number.isSafeInteger(plan.paths)) console.log(`  مسارات المصدر / source paths to restore: ${plan.paths}`);

  if (contextFails > 0) {
    console.log(`\n  ${RED}حكم غير موثوق / UNTRUSTED: سياق التشغيل أعلاه يُبطل هذا التنفيذ، لم يُكتب شيء.${RESET}\n`);
    process.exit(1);
  }
  if (!confirmed) {
    console.log(`\n  ${YELLOW}لم يُكتب شيء. هذه عملية إنتاج تحتاج إذناً صريحاً: أعد التشغيل بـ--yes.${RESET}`);
    console.log(`  ${YELLOW}Nothing was written. This is a production write and needs explicit permission: re-run with --yes.${RESET}`);
    console.log(`      ${DIM}$ npm run doctor -- --reopen-gate${completeSourceRollback ? ' --complete-source-rollback' : ''} --yes${RESET}\n`);
    process.exit(0);
  }
  if (!outcome.applied) {
    console.log(`\n  ${RED}✗ لم يكتمل / not applied: ${outcome.result?.reason ?? 'unknown'}${RESET}`);
  } else if (completeSourceRollback) {
    console.log(`\n  ${GREEN}✓ أُعيد المصدر وفُتحت البوابة كاملة / source rolled back, gate fully reopened${RESET}`);
  } else {
    console.log(`\n  ${GREEN}✓ أُعيد فتح البوابة / gate reopened${RESET}`);
  }
  console.log(`  ${DIM}نسخة السجل قبل اللمس / journal copy taken before the touch: ${outcome.backupPath}${RESET}\n`);
  process.exit(outcome.applied ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 9. Seal the node overlay (ADR-156 §3.1 C1.1, T-1730 W10) — owner-privileged
// ---------------------------------------------------------------------------

/** Read-only git under a neutralized config, so a hostile system git cannot lie. */
function gitRead(args) {
  const result = spawnSync('git', ['-C', ROOT, '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', timeout: 20_000,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  return { ok: result.status === 0, stdout: result.stdout || '' };
}

/** NUL-delimited fields, trailing empties dropped. */
function nulList(stdout) {
  const parts = String(stdout).split('\0');
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Enumerate a sealed directory, refusing every symlink and every non-regular
 * file (contract §3.1 C1.1). Returns `{ files, rejected }`: `files` maps the
 * manifest key (path relative to config/overlay/, the key W3's service uses) to
 * `{ sha256, size }`; a non-empty `rejected` means the seal must not be written.
 */
async function enumerateSealDir({ overlayRoot, dir, sealDigest }) {
  const files = {};
  const rejected = [];
  const base = path.join(overlayRoot, dir);
  const walk = (absDir) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (err) {
      rejected.push(`${path.relative(overlayRoot, absDir)} (unreadable: ${err.code || err.message})`);
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(overlayRoot, abs).split(path.sep).join('/');
      let st;
      try { st = fs.lstatSync(abs); } catch (err) { rejected.push(`${rel} (unreadable: ${err.code || err.message})`); continue; }
      if (st.isSymbolicLink()) { rejected.push(`${rel} (symlink)`); continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      if (!st.isFile()) { rejected.push(`${rel} (not a regular file)`); continue; }
      const buffer = fs.readFileSync(abs);
      files[rel] = { sha256: sealDigest(buffer), size: buffer.length };
    }
  };
  // The mount directory itself must be a real directory, never a symlink.
  let baseStat;
  try { baseStat = fs.lstatSync(base); } catch (err) {
    rejected.push(`${dir} (missing: ${err.code || err.message})`);
    return { files, rejected };
  }
  if (baseStat.isSymbolicLink()) { rejected.push(`${dir} (symlink)`); return { files, rejected }; }
  if (!baseStat.isDirectory()) { rejected.push(`${dir} (not a directory)`); return { files, rejected }; }
  walk(base);
  return { files, rejected };
}

async function reportSealOverlay() {
  const { parseNodeOverlay, sealDigest, writeSealManifest } = await import('./lib/node-overlay.mjs');
  console.log('\nnassaj doctor — seal node overlay / ختم overlay العقدة\n');

  const euid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
  if (euid !== 0) {
    // The service (agent) account must not be able to rewrite the seal, so the
    // manifest is meant to be root-owned; a non-root seal is served-side refused.
    console.log(`  ${YELLOW}! هذا الأمر يجب أن يُشغَّل بامتياز المالك (sudo) ليكون البيان مملوكاً root؛ بيان يملكه حساب الخدمة يرفضه الخادم.${RESET}`);
    console.log(`  ${YELLOW}! Run this under owner privilege (sudo): a service-account-owned manifest is refused by the server.${RESET}`);
    console.log(`      ${DIM}$ sudo npm run doctor -- --seal-overlay${RESET}\n`);
  }

  const configPath = path.join(ROOT, 'config', 'node-overlay.json');
  const overlayRoot = path.join(ROOT, 'config', 'overlay');
  const lockPath = path.join(ROOT, 'config', 'node-overlay.lock.json');

  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch {
    console.log(`  ${RED}✗ لا يوجد config/node-overlay.json لختمه / no config/node-overlay.json to seal${RESET}\n`);
    process.exit(1);
  }
  let config;
  try { config = parseNodeOverlay(raw); } catch (err) {
    console.log(`  ${RED}✗ config/node-overlay.json غير صالح / invalid (${err.field || 'config'}): ${err.message}${RESET}\n`);
    process.exit(1);
  }
  if (config.static.length === 0) {
    console.log(`  ${YELLOW}! لا نقاط تحميل معلنة، فلا شيء لختمه / no mounts declared, nothing to seal${RESET}\n`);
    process.exit(0);
  }

  const files = {};
  const rejected = [];
  for (const { mount, dir } of config.static) {
    const result = await enumerateSealDir({ overlayRoot, dir, sealDigest });
    for (const line of result.rejected) rejected.push(`${mount}: ${line}`);
    Object.assign(files, result.files);
  }

  if (rejected.length > 0) {
    console.log(`  ${RED}✗ يُرفض الختم: عُثر على وصلات رمزية أو ملفات غير عادية / seal refused: symlinks or non-regular files found:${RESET}`);
    for (const line of rejected) console.log(`      ${RED}- ${line}${RESET}`);
    console.log(`\n  ${DIM}لم يُكتب بيان / no manifest was written.${RESET}\n`);
    process.exit(1);
  }

  const manifest = { schema: 1, sealedAt: new Date().toISOString(), files };
  // The atomic write lives in the overlay module so this doctor holds no writer
  // primitive and its READ-ONLY contract stays structural (contract §3.1).
  writeSealManifest(lockPath, manifest);
  const count = Object.keys(files).length;
  console.log(`  ${GREEN}✓ خُتم ${count} ملفاً في ${config.static.length} نقطة تحميل / sealed ${count} file(s) across ${config.static.length} mount(s)${RESET}`);
  console.log(`  ${DIM}البيان / manifest: ${lockPath}${RESET}`);
  if (euid === 0) console.log(`  ${DIM}مملوك root بصلاحية 0644 / owned by root, mode 0644${RESET}`);
  console.log('');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 10. Explain local divergence (ADR-156 §3.2.3, M11, T-1730 W10) — read-only
// ---------------------------------------------------------------------------

/** Every JSON leaf as `dotted.path -> JSON.stringify(value)`; arrays are opaque leaves. */
function jsonLeaves(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) jsonLeaves(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

/**
 * Is every LOCAL package.json change (mergeBase→HEAD) already present in the
 * target? If not, `git reset --keep <target>` would drop the local dependency
 * customization (e.g. an `allowScripts` block) and the next `npm ci` would skip
 * building the native packages silently (contract §3.2.3, M11).
 */
function dependencyDiffContainedInTarget(basePkg, headPkg, targetPkg) {
  const base = jsonLeaves(basePkg);
  const head = jsonLeaves(headPkg);
  const target = jsonLeaves(targetPkg);
  for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (base[key] === head[key]) continue; // unchanged locally
    if (target[key] !== head[key]) return { contained: false, key };
  }
  return { contained: true };
}

function newestLocalReleaseTag(isRelease, compare) {
  const listed = gitRead(['tag', '--list']);
  if (!listed.ok) return null;
  const versions = listed.stdout.split('\n').map((t) => t.trim())
    .filter((t) => t.startsWith('v')).map((t) => t.slice(1)).filter(isRelease);
  if (versions.length === 0) return null;
  versions.sort(compare);
  const version = versions[versions.length - 1];
  const commit = gitRead(['rev-parse', '--verify', `v${version}^{commit}`]);
  return commit.ok ? { tag: `v${version}`, version, commit: commit.stdout.trim() } : null;
}

function showJson(ref) {
  const result = gitRead(['show', `${ref}:package.json`]);
  if (!result.ok) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

async function reportExplainDivergence() {
  const { classifyDivergence, diffDependencyVersions } = await import('./lib/local-divergence.mjs');
  const { isNassajReleaseVersion, compareNassajReleaseVersions } = await import('../shared/release-version-policy.js');
  console.log('\nnassaj doctor — explain local divergence / تفسير التباعد المحلي\n');

  const targetFlag = process.argv.indexOf('--target');
  let target;
  if (targetFlag >= 0 && process.argv[targetFlag + 1]) {
    const ref = process.argv[targetFlag + 1];
    const commit = gitRead(['rev-parse', '--verify', `${ref}^{commit}`]);
    if (!commit.ok) { console.log(`  ${RED}✗ لا يمكن حلّ الهدف / cannot resolve target: ${ref}${RESET}\n`); process.exit(1); }
    target = { tag: ref, version: ref, commit: commit.stdout.trim() };
  } else {
    target = newestLocalReleaseTag(isNassajReleaseVersion, compareNassajReleaseVersions);
    if (!target) {
      console.log(`  ${RED}✗ لا وسم إصدار محلي لأخذه هدفاً؛ مرّر --target <ref> / no local release tag; pass --target <ref>${RESET}\n`);
      process.exit(1);
    }
  }

  const mergeBaseResult = gitRead(['merge-base', 'HEAD', target.commit]);
  const mergeBase = mergeBaseResult.ok ? mergeBaseResult.stdout.trim() : '';
  if (!mergeBase) { console.log(`  ${RED}✗ تعذّر حساب merge-base مع ${target.tag} / could not compute merge-base${RESET}\n`); process.exit(1); }

  const ancestor = gitRead(['merge-base', '--is-ancestor', 'HEAD', target.commit]);
  if (ancestor.ok) {
    console.log(`  ${GREEN}✓ لا تباعد محلي: HEAD سلف لـ${target.tag} (تقدّم سريع) / no local divergence: HEAD is an ancestor of ${target.tag}${RESET}\n`);
    process.exit(0);
  }

  const nameStatus = gitRead(['diff', '--name-status', '-z', `${mergeBase}..HEAD`]);
  const targetTree = gitRead(['ls-tree', '-r', '--name-only', '-z', target.commit]);
  const numstat = gitRead(['diff', '--numstat', '-z', `${mergeBase}..HEAD`, '--', '.gitignore']);
  let gitignoreAddedOnly = false;
  if (numstat.ok) {
    const record = numstat.stdout.split('\0').find(Boolean);
    const columns = record ? /^(\d+|-)\t(\d+|-)\t/.exec(record) : null;
    if (columns && columns[2] === '0') gitignoreAddedOnly = true;
  }
  const basePkg = showJson(mergeBase);
  const headPkg = showJson('HEAD');
  const targetPkg = showJson(target.commit);
  let packages = [];
  try { if (basePkg && headPkg) packages = diffDependencyVersions(basePkg, headPkg); } catch { packages = []; }

  const divergence = classifyDivergence({
    nameStatusZ: nameStatus.ok ? nameStatus.stdout : '',
    targetTrackedPaths: targetTree.ok ? nulList(targetTree.stdout) : [],
    gitignoreAddedOnly, packages,
  });

  console.log(`  ${DIM}الهدف / target: ${target.tag} (${target.commit.slice(0, 12)})  merge-base: ${mergeBase.slice(0, 12)}${RESET}`);
  console.log(`  ${DIM}overlayable: ${divergence.overlayable.length}  dependency: ${divergence.dependency.length}  code: ${divergence.code.length}${RESET}`);
  if (divergence.overlayable.length) console.log(`      ${DIM}overlayable → ${divergence.overlayable.map((o) => `${o.path} (${o.target})`).join(', ')}${RESET}`);
  if (divergence.dependency.length) console.log(`      ${DIM}dependency → ${divergence.dependency.join(', ')}${RESET}`);
  if (packages.length) console.log(`      ${DIM}packages → ${packages.map((p) => `${p.name} ${p.from ?? '∅'}→${p.to ?? '∅'}`).join(', ')}${RESET}`);
  if (divergence.code.length) console.log(`      ${DIM}code → ${divergence.code.map((c) => c.path).join(', ')}${RESET}`);

  // Refusal 1: a code-class change has no counterpart on the node (M11).
  if (divergence.code.length > 0) {
    console.log(`\n  ${RED}يُرفض طبع أمر المحاذاة: العقدة تحمل تخصيص كود لا مقابل له upstream (فئة code غير فارغة).${RESET}`);
    console.log(`  ${RED}Refusing to print an alignment command: this node carries code-class changes with no upstream counterpart.${RESET}`);
    console.log(`  ${DIM}ارفع هذه المسارات upstream أولاً؛ تخصيص الكود غير مدعوم على العقدة.${RESET}\n`);
    process.exit(1);
  }

  // Refusal 2: the local dependency diff is not contained in the target (M11).
  if (divergence.dependency.length > 0 && basePkg && headPkg && targetPkg) {
    const contained = dependencyDiffContainedInTarget(basePkg, headPkg, targetPkg);
    if (!contained.contained) {
      console.log(`\n  ${RED}يُرفض طبع أمر المحاذاة: فرق الاعتماديات المحلي (${contained.key}) غير محتوى في package.json الإصدار الهدف؛ المحاذاة تُسقطه ويتخطى npm ci بناء الحزم الأصلية بصمت.${RESET}`);
      console.log(`  ${RED}Refusing to print an alignment command: the local dependency diff (${contained.key}) is not contained in the target package.json; aligning would drop it and the next npm ci would skip building native packages silently.${RESET}`);
      console.log(`  ${DIM}ارفع هذا التغيير upstream أولاً (W14/T-1762) ثم أعد الفحص.${RESET}\n`);
      process.exit(1);
    }
  }

  // Allowed: prove the tree is clean, then PRINT (never execute) the alignment.
  const status = gitRead(['status', '--porcelain=v1', '--untracked-files=no', '-z']);
  if (!status.ok) { console.log(`\n  ${RED}✗ تعذّرت قراءة حالة الشجرة / could not read the tree status${RESET}\n`); process.exit(1); }
  if (nulList(status.stdout).length > 0) {
    console.log(`\n  ${RED}يُرفض طبع أمر المحاذاة: الشجرة ليست نظيفة (تعديلات متتبَّعة غير ملتزمة). التزمها أو تراجع عنها أولاً.${RESET}`);
    console.log(`  ${RED}Refusing: the working tree is not clean (uncommitted tracked changes). Commit or revert them first.${RESET}\n`);
    process.exit(1);
  }
  const headShort = (gitRead(['rev-parse', '--short', 'HEAD']).stdout || 'HEAD').trim();
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  console.log(`\n  ${GREEN}المحاذاة مسموحة / alignment allowed.${RESET} ${DIM}هذا الأمر يطبع فقط ولا يُنفَّذ / this only prints, nothing runs.${RESET}`);
  if (divergence.overlayable.length > 0) {
    console.log(`  ${YELLOW}أولاً انقل التخصيص القابل للتراكب إلى E1/E2 (config/overlay + .git/info/exclude) ثم اختمه، وإلا فُقد بالمحاذاة.${RESET}`);
    console.log(`  ${YELLOW}First move the overlayable customization into E1/E2 and seal it, or the alignment loses it.${RESET}`);
  }
  console.log(`\n      ${DIM}$ git branch backup/node-local-${stamp}-${headShort} HEAD${RESET}`);
  console.log(`      ${DIM}$ git reset --keep ${target.tag}${RESET}`);
  console.log(`\n  ${DIM}‑‑keep يرفض إن تعارض مع تعديل محلي، فلا يفقد عملاً كما يفعل ‑‑hard.${RESET}\n`);
  process.exit(0);
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

if (process.argv.includes('--update-preflight')) {
  await reportUpdatePreflight();
} else if (process.argv.includes('--reopen-gate')) {
  await reportReopenGate();
} else if (process.argv.includes('--seal-overlay')) {
  await reportSealOverlay();
} else if (process.argv.includes('--explain-divergence')) {
  await reportExplainDivergence();
} else {
  checkNode();
  checkDockerSocket();
  checkEnv();
  await checkPort();
  checkDatabase();
  checkBuild();
  await checkNodePty();
  report();
}
