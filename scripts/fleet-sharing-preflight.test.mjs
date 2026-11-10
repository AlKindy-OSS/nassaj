/**
 * fleet-sharing-preflight.test — ADR-152 A1 §3.6 / §4 (T-2083, BE-14).
 *
 * The script is read-only and prints no secret. It reports the platform-mode
 * flag (per source), the active user count, the stored provider_sharing value,
 * and which install-wide vendor keys exist (presence only), and gives the
 * verdict "would refuse boot" exactly when platform mode is on with more than
 * one active user (exit 2).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fleet-sharing-preflight.mjs');
const Database = createRequire(import.meta.url)('better-sqlite3');
const SECRET = 'enc:v1:THIS-CIPHERTEXT-MUST-NEVER-BE-PRINTED';

/** A node install root with a DB, an .env and a home holding an install-wide key. */
function makeNode(t, { platform = false, activeUsers = 2, policy = '{"claude":"shared","agy":"isolated"}', viaEcosystem = false } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'nassaj-fleet-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(home, '.nassaj-provider-secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nassaj-provider-secrets', 'keys.json'), JSON.stringify({ kimi: SECRET, glm: '', 'speech:whisper': SECRET }));
  const dbPath = path.join(dir, 'db.sqlite');
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT, is_active INTEGER, status TEXT);
    CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  for (let i = 1; i <= activeUsers; i += 1) {
    db.prepare("INSERT INTO users (id, username, role, is_active, status) VALUES (?, ?, 'user', 1, 'active')").run(i, `u${i}`);
  }
  db.prepare("INSERT INTO users (id, username, role, is_active, status) VALUES (99, 'gone', 'user', 0, 'disabled')").run();
  if (policy !== null) db.prepare("INSERT INTO app_config (key, value) VALUES ('provider_sharing', ?)").run(policy);
  db.close();
  const flag = platform ? 'true' : 'false';
  fs.writeFileSync(path.join(root, '.env'), `DATABASE_PATH=${dbPath}\nJWT_SECRET=${SECRET}\n`
    + `AWS_SECRET_ACCESS_KEY=${SECRET}\nXDG_CONFIG_HOME=/home/operator/.config\n${viaEcosystem ? '' : `VITE_IS_PLATFORM=${flag}\n`}`);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'node.env'), `CLAUDE_CODE_USE_BEDROCK=1\nLANG=C.UTF-8\n`);
  if (viaEcosystem) {
    fs.writeFileSync(path.join(root, 'ecosystem.node.config.cjs'),
      `module.exports = { apps: [{ name: 'nassaj', env: { VITE_IS_PLATFORM: '${flag}', AWS_PROFILE: 'ops' } }] };\n`);
  }
  return { root, home, dbPath };
}

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(node, extra = []) {
  const env = { ...process.env };
  delete env.VITE_IS_PLATFORM;
  delete env.DATABASE_PATH;
  return spawnSync(process.execPath, [SCRIPT, '--root', node.root, '--home', node.home, ...extra],
    { encoding: 'utf8', env, timeout: 60_000 });
}

test('platform on with two active users: "would refuse boot", exit 2, no secret printed, DB untouched', (t) => {
  const node = makeNode(t, { platform: true, activeUsers: 2 });
  const before = digest(node.dbPath);
  const result = run(node, ['--json']);
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.platformMode.effective, true);
  assert.equal(report.activeUserCount, 2);
  assert.deepEqual(report.providerSharing, { present: true, value: '{"claude":"shared","agy":"isolated"}' });
  assert.deepEqual(report.installWideVendorKeys, { state: 'ok', present: ['kimi'], otherSecrets: ['speech:whisper'] });
  assert.equal(report.verdict, 'would_refuse_boot');
  assert.equal(report.changedByUpgrade, true, 'claude was shared: the pre-upgrade guard let it boot');
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET), 'a secret was printed');
  assert.equal(digest(node.dbPath), before, 'the database changed');
});

test('platform off: ok, exit 0; the human report names the verdict', (t) => {
  const node = makeNode(t, { platform: false, activeUsers: 3 });
  const result = run(node);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verdict: ok/);
  assert.match(result.stdout, /install-wide vendor keys: kimi/);
  assert.ok(!result.stdout.includes(SECRET));
});

test('platform on with one active user: ok; the flag is found in the pm2 ecosystem file too', (t) => {
  const node = makeNode(t, { platform: true, activeUsers: 1, viaEcosystem: true, policy: null });
  const report = JSON.parse(run(node, ['--json']).stdout);
  assert.equal(report.platformMode.effective, true);
  assert.deepEqual(report.platformMode.sources.map((s) => s.source), ['ecosystem.node.config.cjs']);
  assert.deepEqual(report.providerSharing, { present: false, value: null });
  assert.equal(report.verdict, 'ok');
});

test('a missing database is an error (exit 1), not a silent ok', (t) => {
  const node = makeNode(t);
  fs.rmSync(node.dbPath);
  const result = run(node, ['--json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /database/i);
});

test('the script holds no writer primitive (read-only by construction)', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /readonly: true/);
  assert.match(source, /fileMustExist: true/);
  assert.doesNotMatch(source, /writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|mkdirSync|\.run\(|\.exec\(/);
  assert.doesNotMatch(source, /node:crypto|createDecipher/, 'no decryption primitive');
});

test('qa: reports inherited-credential variable NAMES per source (XDG_*, Bedrock/Vertex, AWS_*), never values', (t) => {
  const node = makeNode(t, { platform: true, activeUsers: 1, viaEcosystem: true });
  const result = run(node, ['--json']);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.inheritedCredentialVariables, {
    '.env': ['AWS_SECRET_ACCESS_KEY', 'XDG_CONFIG_HOME'],
    'config/node.env': ['CLAUDE_CODE_USE_BEDROCK'],
    'ecosystem.node.config.cjs': ['AWS_PROFILE'],
  });
  assert.ok(!result.stdout.includes(SECRET) && !result.stdout.includes('/home/operator/.config'), 'a value was printed');
});

test('qa: runs piped over stdin from the node root (ssh node \'cd <root> && node -\' < script), writing nothing', (t) => {
  const node = makeNode(t, { platform: false, activeUsers: 2 });
  // A real node root ships its own node_modules; the piped script loads
  // better-sqlite3 from there (stdin has no script directory to fall back to).
  const modules = path.dirname(path.dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')));
  fs.symlinkSync(modules, path.join(node.root, 'node_modules'));
  const before = fs.readdirSync(node.root).sort();
  const env = { ...process.env, HOME: node.home };
  delete env.VITE_IS_PLATFORM;
  delete env.DATABASE_PATH;
  const result = spawnSync(process.execPath, ['-'], {
    cwd: node.root, input: fs.readFileSync(SCRIPT, 'utf8'), encoding: 'utf8', env, timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verdict: ok/);
  assert.match(result.stdout, /inherited credential variables: \.env: AWS_SECRET_ACCESS_KEY, XDG_CONFIG_HOME/);
  assert.deepEqual(fs.readdirSync(node.root).sort(), before, 'a file was written in the node root');
  assert.ok(!result.stdout.includes(SECRET));
});
