/**
 * ADR-219 P2 §8 N9 (م-8): the N-1 build boots on a database migrated by N with
 * held and promoted rows, drives its S1 repository over them, and its own S1
 * suite stays green. N-1 is extracted with `git archive` into the run dir (no
 * worktree); every database and HOME lives under the run dir.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const N_MINUS_1 = 'ba5d9c59d';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../../../..');
const S1_SUITE = [
  'server/claude-sdk.peer-relay.test.ts', 'server/modules/providers/tests/peer-messages.routes.test.ts',
  'server/modules/database/peer-messages.migration.test.ts',
];

/** A child env with no inherited NASSAJ_* roots, debug switches or operator config dir. */
function childEnv(run, extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NASSAJ_') || key.startsWith('DEBUG') || key === 'CLAUDE_CONFIG_DIR') continue;
    env[key] = value;
  }
  return { ...env, HOME: path.join(run.dir, 'home-n9'), TMPDIR: '/var/tmp', ...extra };
}

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const lastJson = (text) => {
  const line = text.trim().split('\n').reverse().find((l) => l.startsWith('{'));
  return line ? JSON.parse(line) : null;
};

function extractNMinus1(dir) {
  fs.mkdirSync(dir, { mode: 0o700 });
  const archive = path.join(path.dirname(dir), 'n1.tar');
  const made = run('git', ['archive', '-o', archive, N_MINUS_1], { cwd: REPO });
  if (made.status !== 0) throw new Error('git archive of the N-1 build failed');
  if (run('tar', ['-xf', archive, '-C', dir]).status !== 0) throw new Error('extracting the N-1 build failed');
  fs.rmSync(archive);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
}

/** Runs N9; `pass` only when N-1 booted, read every row and its S1 suite passed. */
export function runN9({ run: runCtx }) {
  const n1 = path.join(runCtx.dir, 'n1');
  const project = path.join(runCtx.dir, 'n9-project');
  fs.mkdirSync(project, { mode: 0o700 });
  fs.mkdirSync(path.join(runCtx.dir, 'home-n9'), { mode: 0o700 });
  const db = path.join(runCtx.dir, 'n.db');
  const seed = run('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', path.join(HERE, 'seed-n-db.mts')],
    { cwd: REPO, env: childEnv(runCtx, { DATABASE_PATH: db, N9_PROJECT: project }) });
  const seeded = lastJson(seed.stdout);
  extractNMinus1(n1);
  fs.copyFileSync(path.join(HERE, 'n1-boot-probe.mts'), path.join(n1, 'n1-boot-probe.mts'));
  const boot = run(process.execPath, ['--import', 'tsx', 'n1-boot-probe.mts'],
    { cwd: n1, env: childEnv(runCtx, { DATABASE_PATH: db, TSX_TSCONFIG_PATH: path.join(n1, 'server/tsconfig.json') }) });
  const booted = lastJson(boot.stdout);
  const relayTests = fs.readdirSync(path.join(n1, 'server/modules/peer-relay/__tests__'))
    .filter((f) => f.endsWith('.test.ts')).map((f) => `server/modules/peer-relay/__tests__/${f}`);
  const suite = run(process.execPath, ['scripts/run-isolated-node-tests.mjs', 'server', ...relayTests, ...S1_SUITE],
    { cwd: n1, env: childEnv(runCtx, { NASSAJ_TEST_TEMP_ROOT: '/var/tmp' }) });
  const exits = [...suite.stdout.matchAll(/^## test file (\S+) exited (\S+)$/gmu)].map((m) => ({ file: m[1], exit: m[2] }));
  const counts = [...suite.stdout.matchAll(/^ℹ (pass|fail) (\d+)$/gmu)]
    .reduce((acc, m) => ({ ...acc, [m[1]]: (acc[m[1]] ?? 0) + Number(m[2]) }), {});
  const pass = Boolean(seeded?.seeded) && booted?.booted === true && booted.holdsTable && booted.claimed === true
    && booted.settled === true && exits.length > 0 && exits.every((e) => e.exit === '0');
  return { test: 'N9', pass, seeded, booted, bootStderr: boot.status === 0 ? null : boot.stderr.slice(-600),
    s1Suite: { files: exits.length, ...counts, failedFiles: exits.filter((e) => e.exit !== '0').map((e) => e.file) } };
}
