/**
 * Secret files inside an otherwise valid project root are never readable or
 * writable through the project file guards:
 *   - dotenv files at any depth (templates excepted);
 *   - the live application database (DATABASE_PATH + SQLite side files);
 *   - on READ, any SQLite database by name or by its 16-byte header, so a
 *     backup copy under any name is refused;
 *   - transcript/history/credential stores of a harness home, judged on the
 *     canonical path (`~/.claude` may be a symlink into a registered project).
 *
 * Fixtures live under /var/tmp (never os.tmpdir()), with a throwaway $HOME,
 * DATABASE_PATH and CLAUDE_CONFIG_DIR, so no operator file is read.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  containsSqliteContent,
  hasSqliteHeader,
  isForbiddenProjectRoot,
  isSecretFileName,
  isSecretPath,
  isSqliteFileName,
  resetSecretPathGuardCache,
  SQLITE_HEADER,
} from '@/shared/secret-path-guard.js';

import {
  isResolvedPathInsideRootReal,
  openReadableProjectFile,
  resolveReadPathInProject,
} from '../utils/path-guard.js';

let sandbox = '';
let home = '';
let project = '';
let core = '';
let relocatedClaude = '';
let databasePath = '';
const saved: Record<string, string | undefined> = {};
const SQLITE_BYTES = Buffer.concat([SQLITE_HEADER, Buffer.from('page data JWT s3cret')]);

/** Writes `content` at `relative` below `root`, creating parents. */
function put(root: string, relative: string, content: string | Buffer): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

before(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'secret-files-')));
  home = path.join(sandbox, 'home');
  project = path.join(home, 'work', 'app');
  for (const name of ['.env', '.env.local', '.ENV.Production', '.envrc', 'config/.env', 'app.env',
    '.env~', '.env-backup', '.env_old']) {
    put(project, name, 'JWT_SECRET=s3cret');
  }
  for (const name of ['.env.example', '.env.sample', '.env.template', 'README.md', 'environment.ts', 'src/a.ts']) {
    put(project, name, 'public');
  }
  databasePath = put(project, 'data/app.sqlite', SQLITE_BYTES);
  put(project, 'data/app.sqlite-wal', 'wal');
  put(project, '.backups/db.pre-cutover-1.sqlite', SQLITE_BYTES);
  put(project, '.backups/db.pre-cutover-2.bak', SQLITE_BYTES);
  put(project, 'notes/renamed.txt', SQLITE_BYTES);
  put(project, 'tiny.txt', 'SQL');
  fs.symlinkSync(databasePath, path.join(project, 'innocent.txt'));
  fs.symlinkSync(path.join(project, '.env'), path.join(project, 'notes.md'));

  // Governance checkout registered as a project; ~/.claude points into it,
  // and a member's Claude home links its projects/ through ~/.claude.
  core = path.join(home, 'governance-core');
  put(core, 'README.md', 'governance');
  put(core, 'docs/guide.md', 'guide');
  put(core, 'projects/-x/session.jsonl', 'JWT_SECRET=s3cret');
  put(core, 'projects.backup-1/-x/session.jsonl', 'JWT_SECRET=s3cret');
  put(core, 'history.jsonl', 'secret prompt');
  // No `.credentials.json` here on purpose: a checkout holding one is already a
  // forbidden root (B-1373); this models the case only the harness rule covers.
  put(core, '.claude.json', '{}');
  put(core, 'sessions/1.json', '{}');
  fs.symlinkSync(core, path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.nassaj-users', '2', '.claude'), { recursive: true });
  fs.symlinkSync(path.join(home, '.claude', 'projects'), path.join(home, '.nassaj-users', '2', '.claude', 'projects'));
  relocatedClaude = path.join(sandbox, 'relocated-claude');
  put(relocatedClaude, 'projects/-y/s.jsonl', 'secret');

  for (const key of ['HOME', 'DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.DATABASE_PATH = databasePath;
  process.env.CLAUDE_CONFIG_DIR = relocatedClaude;
  delete process.env.CODEX_HOME;
  resetSecretPathGuardCache();
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSecretPathGuardCache();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('isSecretFileName matches dotenv files and spares templates', () => {
  for (const name of ['.env', '.env.local', '.env.production', '.ENV', '.Env.Dev', '.envrc', '.env.example.local',
    'foo.env', 'app.env', 'secrets.ENV', '.env~', '.env-backup', '.env_old', '.envrc.bak', '.envrc~']) {
    assert.equal(isSecretFileName(name), true, name);
  }
  for (const name of ['.env.example', '.ENV.EXAMPLE', '.env.sample', '.env.template', 'env', '.environment',
    'environment.ts', 'README.md', 'env.ts', '']) {
    assert.equal(isSecretFileName(name), false, name);
  }
});

test('isSqliteFileName, hasSqliteHeader and containsSqliteContent', () => {
  for (const name of ['a.sqlite', 'a.SQLITE3', 'auth.db', 'x.db3', 'a.sqlite-wal', 'a.db-shm', 'a.sqlite3-journal']) {
    assert.equal(isSqliteFileName(name), true, name);
  }
  for (const name of ['a.dbx', 'db', 'sqlite.md', 'a.sql', 'README.md']) {
    assert.equal(isSqliteFileName(name), false, name);
  }
  assert.equal(hasSqliteHeader(SQLITE_BYTES), true);
  assert.equal(hasSqliteHeader(Buffer.from('SQLite format 3')), false, 'header needs the NUL');
  assert.equal(hasSqliteHeader(Buffer.from('plain text file here')), false);
  assert.equal(containsSqliteContent(`+${SQLITE_BYTES.toString('latin1')}`), true);
  assert.equal(containsSqliteContent('SQLite format 3 is a file format'), false);
});

test('isSecretPath refuses dotenv files at any depth and the configured database files', () => {
  for (const name of ['.env', 'config/.env', '.envrc', 'app.env', '.env~', 'innocent.txt', 'notes.md']) {
    assert.equal(isSecretPath(path.join(project, name)), true, name);
  }
  assert.equal(isSecretPath(databasePath), true);
  assert.equal(isSecretPath(`${databasePath}-wal`), true);
  assert.equal(isSecretPath(`${databasePath}-shm`), true, 'not-yet-existing side file');
  for (const name of ['.env.example', 'README.md', 'data/other.sqlite']) {
    assert.equal(isSecretPath(path.join(project, name)), false, name);
  }
});

test('harness transcript stores are secret through every spelling; the rest of the checkout is not', () => {
  for (const target of [
    path.join(core, 'projects', '-x', 'session.jsonl'),
    path.join(core, 'projects.backup-1', '-x', 'session.jsonl'),
    path.join(core, 'history.jsonl'),
    path.join(core, '.claude.json'),
    path.join(core, 'sessions', '1.json'),
    path.join(home, '.nassaj-users', '2', '.claude', 'projects', '-x', 'session.jsonl'),
    path.join(relocatedClaude, 'projects', '-y', 's.jsonl'),
  ]) {
    assert.equal(isSecretPath(target), true, target);
  }
  assert.equal(isSecretPath(path.join(core, 'README.md')), false);
  assert.equal(isSecretPath(path.join(core, 'docs', 'guide.md')), false);
  assert.equal(isForbiddenProjectRoot(core), false, 'the checkout stays registrable');
});

test('a root holding a .env or the database is still a valid project root', () => {
  assert.equal(isForbiddenProjectRoot(project), false);
});

test('resolveReadPathInProject refuses secret files and SQLite names, still serves normal ones', async () => {
  for (const requested of ['.env', '.env.local', '.ENV.Production', 'config/.env', 'notes.md', 'app.env',
    '.env-backup', 'data/app.sqlite', 'data/app.sqlite-wal', 'innocent.txt', databasePath,
    '.backups/db.pre-cutover-1.sqlite']) {
    const guard = await resolveReadPathInProject(project, requested);
    assert.equal(guard.valid, false, requested);
    assert.equal(guard.valid === false && guard.code, 'SECRET_PATH', requested);
  }
  for (const requested of ['README.md', '.env.example', 'environment.ts']) {
    assert.equal((await resolveReadPathInProject(project, requested)).valid, true, requested);
  }
  for (const requested of ['projects/-x/session.jsonl', 'history.jsonl', '.claude.json']) {
    const guard = await resolveReadPathInProject(core, requested);
    assert.equal(guard.valid === false && guard.code, 'SECRET_PATH', requested);
  }
  assert.equal((await resolveReadPathInProject(core, 'docs/guide.md')).valid, true);
});

test('openReadableProjectFile refuses a database copy under a non-database name by its header', async () => {
  for (const requested of ['.backups/db.pre-cutover-2.bak', 'notes/renamed.txt']) {
    const guard = await openReadableProjectFile(project, requested);
    assert.equal(guard.valid === false && guard.code, 'SECRET_PATH', requested);
  }
  for (const [requested, content] of [['README.md', 'public'], ['tiny.txt', 'SQL']]) {
    const guard = await openReadableProjectFile(project, requested);
    assert.equal(guard.valid, true, requested);
    if (guard.valid) {
      try {
        assert.equal(await guard.handle.readFile('utf8'), content, 'the sniff does not consume the content');
      } finally {
        await guard.handle.close();
      }
    }
  }
});

test('the mutate guard refuses writing, creating or renaming onto secret files', () => {
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, '.env')), false);
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, 'config', '.env.new')), false);
  assert.equal(isResolvedPathInsideRootReal(project, `${databasePath}-journal`), false);
  assert.equal(isResolvedPathInsideRootReal(core, path.join(core, 'projects', '-x', 'new.jsonl')), false);
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, 'src', 'new.ts')), true);
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, '.env.sample')), true);
  assert.equal(isResolvedPathInsideRootReal(core, path.join(core, 'docs', 'new.md')), true);
});
