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
  classifySecretPath,
  classifySqliteContentPath,
  containsServiceRoot,
  containsServiceSecretValue,
  containsSqliteContent,
  hasAppDatabaseSchema,
  hasSqliteWalHeader,
  registerServiceSecretValue,
  isSecretRepositoryPath,
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

const SERVICE_SECRETS = ['data/app.sqlite', 'data/app.sqlite-wal', 'innocent.txt'];
const PROJECT_SECRETS = ['.env', '.env.local', '.ENV.Production', 'config/.env', 'notes.md', 'app.env',
  '.env-backup', '.backups/db.pre-cutover-1.sqlite'];

test('classifySecretPath separates service secrets from project secret files (B-1593)', () => {
  for (const name of SERVICE_SECRETS) {
    assert.equal(classifySecretPath(path.join(project, name)), 'service', name);
  }
  assert.equal(classifySecretPath(databasePath), 'service');
  assert.equal(classifySecretPath(path.join(core, 'projects', '-x', 'session.jsonl')), 'service');
  assert.equal(classifySecretPath(path.join(home, '.ssh', 'id_ed25519')), 'service');
  for (const name of PROJECT_SECRETS) {
    assert.equal(classifySecretPath(path.join(project, name)), 'project', name);
  }
  for (const name of ['README.md', '.env.example', 'environment.ts']) {
    assert.equal(classifySecretPath(path.join(project, name)), null, name);
  }
});

test('dotenv and SQLite files under a service root are service secrets', () => {
  const installEnv = put(sandbox, 'install/.env', 'JWT_SECRET=s3cret');
  const installRoot = path.dirname(installEnv);
  put(installRoot, 'backups/copy.db', SQLITE_BYTES);
  const previous = process.env.NASSAJ_SERVICE_SECRET_ROOTS;
  process.env.NASSAJ_SERVICE_SECRET_ROOTS = installRoot;
  resetSecretPathGuardCache();
  try {
    assert.equal(classifySecretPath(installEnv), 'service');
    assert.equal(classifySecretPath(path.join(installRoot, 'backups', 'copy.db')), 'service');
    assert.equal(classifySecretPath(path.join(installRoot, 'README.md')), null);
    assert.equal(classifySqliteContentPath(path.join(installRoot, 'any.bin')), 'service');
    assert.equal(classifySqliteContentPath(path.join(project, 'notes', 'renamed.txt')), 'project');
  } finally {
    if (previous === undefined) delete process.env.NASSAJ_SERVICE_SECRET_ROOTS;
    else process.env.NASSAJ_SERVICE_SECRET_ROOTS = previous;
    resetSecretPathGuardCache();
  }
});

test('isSecretRepositoryPath hides dotenv and SQLite history paths at any depth (B-1592)', () => {
  for (const entry of ['.env', 'a/b/.env.local', 'cfg/app.env', 'x/y.sqlite', 'db.db-wal']) {
    assert.equal(isSecretRepositoryPath(project, entry), true, entry);
  }
  for (const entry of ['.env.example', 'src/a.ts', 'README.md', '']) {
    assert.equal(isSecretRepositoryPath(project, entry), false, entry);
  }
  assert.equal(isSecretRepositoryPath(core, 'projects/-x/session.jsonl'), true, 'secret on disk');
});

test('resolveReadPathInProject refuses service secrets and asks to confirm project secret files', async () => {
  for (const requested of [...SERVICE_SECRETS, databasePath]) {
    for (const confirmSecret of [false, true]) {
      const guard = await resolveReadPathInProject(project, requested, { confirmSecret });
      assert.equal(guard.valid === false && guard.code, 'SECRET_PATH', `${requested} ${confirmSecret}`);
    }
  }
  for (const requested of PROJECT_SECRETS) {
    const asked = await resolveReadPathInProject(project, requested);
    assert.equal(asked.valid === false && asked.code, 'SECRET_CONFIRMATION_REQUIRED', requested);
    const confirmed = await resolveReadPathInProject(project, requested, { confirmSecret: true });
    assert.equal(confirmed.valid && confirmed.secretFile, true, requested);
  }
  for (const requested of ['README.md', '.env.example', 'environment.ts']) {
    const guard = await resolveReadPathInProject(project, requested);
    assert.equal(guard.valid, true, requested);
    assert.equal(guard.valid && guard.secretFile, false, requested);
  }
  for (const requested of ['projects/-x/session.jsonl', 'history.jsonl', '.claude.json']) {
    const guard = await resolveReadPathInProject(core, requested, { confirmSecret: true });
    assert.equal(guard.valid === false && guard.code, 'SECRET_PATH', requested);
  }
  assert.equal((await resolveReadPathInProject(core, 'docs/guide.md')).valid, true);
});

test('openReadableProjectFile treats SQLite content under an innocent name as a project secret', async () => {
  for (const requested of ['.backups/db.pre-cutover-2.bak', 'notes/renamed.txt']) {
    const asked = await openReadableProjectFile(project, requested);
    assert.equal(asked.valid === false && asked.code, 'SECRET_CONFIRMATION_REQUIRED', requested);
    const confirmed = await openReadableProjectFile(project, requested, { confirmSecret: true });
    assert.equal(confirmed.valid, true, requested);
    if (confirmed.valid) {
      assert.equal(confirmed.secretFile, true);
      await confirmed.handle.close();
    }
  }
  for (const [requested, content] of [['README.md', 'public'], ['tiny.txt', 'SQL']]) {
    const guard = await openReadableProjectFile(project, requested);
    assert.equal(guard.valid, true, requested);
    if (guard.valid) {
      try {
        assert.equal(guard.secretFile, false);
        assert.equal(await guard.handle.readFile('utf8'), content, 'the sniff does not consume the content');
      } finally {
        await guard.handle.close();
      }
    }
  }
});

test('allowProjectSecretFiles reopens project secret files but never service secrets', () => {
  const allow = { allowProjectSecretFiles: true };
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, '.env'), allow), true);
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, 'config', '.env.new'), allow), true);
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, 'data', 'other.db'), allow), true);
  assert.equal(isResolvedPathInsideRootReal(project, `${databasePath}-journal`, allow), false);
  assert.equal(isResolvedPathInsideRootReal(project, databasePath, allow), false);
  assert.equal(isResolvedPathInsideRootReal(core, path.join(core, 'projects', '-x', 'new.jsonl'), allow), false);
});

test('the strict mutate guard refuses writing, creating or renaming onto secret files', () => {
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, '.env')), false);
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, 'config', '.env.new')), false);
  assert.equal(isResolvedPathInsideRootReal(project, `${databasePath}-journal`), false);
  assert.equal(isResolvedPathInsideRootReal(core, path.join(core, 'projects', '-x', 'new.jsonl')), false);
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, 'src', 'new.ts')), true);
  assert.equal(isResolvedPathInsideRootReal(project, path.join(project, '.env.sample')), true);
  assert.equal(isResolvedPathInsideRootReal(core, path.join(core, 'docs', 'new.md')), true);
});

test('hasAppDatabaseSchema and hasSqliteWalHeader recognise the application database by bytes', () => {
  const appDb = Buffer.concat([SQLITE_BYTES, Buffer.from(
    'CREATE TABLE "app_config" (key TEXT) ... CREATE TABLE IF NOT EXISTS audit_log (id INTEGER)')]);
  assert.equal(hasAppDatabaseSchema(appDb), true);
  assert.equal(hasAppDatabaseSchema(Buffer.concat([SQLITE_BYTES, Buffer.from('CREATE TABLE app_config (k)')])),
    false, 'one table name alone is not the application schema');
  assert.equal(hasAppDatabaseSchema(Buffer.concat([SQLITE_BYTES, Buffer.from('CREATE TABLE todos (id)')])), false);
  assert.equal(hasSqliteWalHeader(Buffer.from([0x37, 0x7f, 0x06, 0x82])), true);
  assert.equal(hasSqliteWalHeader(Buffer.from([0x37, 0x7f, 0x06, 0x83, 1])), true);
  assert.equal(hasSqliteWalHeader(Buffer.from([0x37, 0x7f, 0x06, 0x84])), false);
  assert.equal(hasSqliteWalHeader(Buffer.from([0x37, 0x7f])), false);
});

test('containsServiceSecretValue matches secret env values and registered secrets only', () => {
  const previous = process.env.EXAMPLE_SIGNING_SECRET;
  process.env.EXAMPLE_SIGNING_SECRET = 'env-secret-value-0123456789';
  try {
    assert.equal(containsServiceSecretValue('A=env-secret-value-0123456789\n'), true);
    assert.equal(containsServiceSecretValue(Buffer.from('nothing to see')), false);
    assert.equal(containsServiceSecretValue('registered-secret-abcdefghijklmnop'), false);
    registerServiceSecretValue('registered-secret-abcdefghijklmnop');
    assert.equal(containsServiceSecretValue('x registered-secret-abcdefghijklmnop y'), true);
    registerServiceSecretValue('short');
    assert.equal(containsServiceSecretValue('short'), false, 'short values are ignored');
    assert.equal(containsServiceSecretValue(undefined as unknown as string), false);
  } finally {
    if (previous === undefined) delete process.env.EXAMPLE_SIGNING_SECRET;
    else process.env.EXAMPLE_SIGNING_SECRET = previous;
  }
});

test('a target that is or contains a service root is never renamed, moved or deleted', () => {
  const installRoot = path.join(project, 'vendor-install');
  fs.mkdirSync(installRoot, { recursive: true });
  const previous = process.env.NASSAJ_SERVICE_SECRET_ROOTS;
  process.env.NASSAJ_SERVICE_SECRET_ROOTS = installRoot;
  resetSecretPathGuardCache();
  try {
    assert.equal(containsServiceRoot(installRoot), true);
    assert.equal(containsServiceRoot(project), true, 'an ancestor contains the root');
    assert.equal(containsServiceRoot(path.join(installRoot, 'README.md')), false);
    for (const allowProjectSecretFiles of [false, true]) {
      assert.equal(isResolvedPathInsideRootReal(project, installRoot, { allowProjectSecretFiles }), false);
    }
    assert.equal(isResolvedPathInsideRootReal(project, path.join(project, 'src', 'x.ts')), true);
  } finally {
    if (previous === undefined) delete process.env.NASSAJ_SERVICE_SECRET_ROOTS;
    else process.env.NASSAJ_SERVICE_SECRET_ROOTS = previous;
    resetSecretPathGuardCache();
  }
});
