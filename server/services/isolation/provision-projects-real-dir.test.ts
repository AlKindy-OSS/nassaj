/**
 * ADR-173 rev.3 M7: a member whose `.claude/projects` is a real directory (drift, not
 * intent) gets ONE warning per user; a link gets none. Nothing is migrated or moved.
 * HOME and DATABASE_PATH are sandboxed before importing any project module.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'nassaj-provision-projects-')));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
process.env.HOME = path.join(sandbox, 'home');
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
fs.mkdirSync(process.env.HOME, { recursive: true });

const { warnRealClaudeProjectsDirOnce } = await import('./provision-user-dirs.js');

test.after(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('a real projects dir warns once per user and is left in place', () => {
  const projects = path.join(sandbox, 'users', '7', '.claude', 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const warnings: unknown[][] = [];
  const warn = (...args: unknown[]) => { warnings.push(args); };
  warnRealClaudeProjectsDirOnce(7, projects, warn);
  warnRealClaudeProjectsDirOnce(7, projects, warn);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /ADR-173/u);
  assert.ok(fs.lstatSync(projects).isDirectory(), 'no migration');
});

test('a linked projects dir never warns', () => {
  const shared = path.join(sandbox, 'shared-projects');
  fs.mkdirSync(shared);
  const projects = path.join(sandbox, 'users', '8', '.claude', 'projects');
  fs.mkdirSync(path.dirname(projects), { recursive: true });
  fs.symlinkSync(shared, projects);
  const warnings: unknown[][] = [];
  warnRealClaudeProjectsDirOnce(8, projects, (...args: unknown[]) => { warnings.push(args); });
  assert.equal(warnings.length, 0);
});
