/**
 * T-1854 (design test 26, qa M1): every mutation that can REDUCE project access
 * lives in a reviewed file that re-runs the fenced-run sweep after its commit.
 * A new `UPDATE users SET role|status|is_active`, `DELETE FROM
 * project_members|projects|users` or raw `projectMembersDb.add/remove/setRole`
 * anywhere else fails this test until it is wired to a sweep entry point
 * (a rotate or retire helper, or revalidateUserProjectAccess) and added below.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SERVER_ROOT = path.resolve(import.meta.dirname, '../../..');

const ACCESS_REDUCING = [
  /UPDATE\s+users\s+SET[^;'"`]*\b(role|status|is_active)\b/i,
  /DELETE\s+FROM\s+(project_members|projects|users)\b/i,
  /projectMembersDb\.(add|remove|setRole)\(/,
];

const SWEEP_ENTRY = /\b(rotateProjectSubjectAccess|retireProjectSubjectAccess|rotateProjectStructure|retireProjectStructure|rotateProjectStructureForPath|rotateWorkspaceTopology|revalidateUserProjectAccess)\(/;

/** Reviewed mutators → the file that performs their post-commit sweep. */
const REVIEWED: Record<string, string | null> = {
  'modules/database/repositories/users.ts': 'modules/database/repositories/users.ts',
  'modules/database/repositories/project-members.db.ts': 'modules/database/repositories/project-members.db.ts',
  'modules/database/repositories/projects.db.ts': 'modules/database/repositories/projects.db.ts',
  // The deletion transaction commits here; its service rotates after commit.
  'modules/database/deletion-operation.repository.ts': 'modules/database/deletion-operation.service.ts',
  // Boot-time owner promotion only ever GRANTS access, before any run exists.
  'modules/database/migrations.ts': null,
};

function listSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSources(full));
    else if (/\.(ts|js)$/.test(entry.name) && !/\.test\.|test-helper|__tests__/.test(full)) files.push(full);
  }
  return files;
}

test('every access-reducing mutation is in a reviewed file wired to the fenced-run sweep', () => {
  const found = new Set<string>();
  for (const file of listSources(SERVER_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    if (ACCESS_REDUCING.some((pattern) => pattern.test(source))) {
      found.add(path.relative(SERVER_ROOT, file));
    }
  }
  const unreviewed = [...found].filter((file) => !(file in REVIEWED));
  assert.deepEqual(unreviewed, [], 'new access-reducing mutator: wire a sweep, then list it here');
  for (const [mutator, sweeper] of Object.entries(REVIEWED)) {
    assert.equal(found.has(mutator), true, `stale allowlist entry: ${mutator}`);
    if (sweeper) {
      const source = fs.readFileSync(path.join(SERVER_ROOT, sweeper), 'utf8');
      assert.match(source, SWEEP_ENTRY, `${sweeper} must call a sweep entry point`);
    }
  }
});

test('qa M1: deleteUser and the platform role/status setters re-validate fenced runs', () => {
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'modules/database/repositories/users.ts'), 'utf8');
  for (const method of ['setStatus', 'setRole', 'setRoleIfUnchanged', 'deleteUser']) {
    const start = source.indexOf(`  ${method}(`);
    assert.notEqual(start, -1, method);
    const next = source.indexOf('\n  },', start);
    assert.match(source.slice(start, next), /revalidateUserProjectAccess\(userId\)/, method);
  }
  const deleteUser = source.slice(source.indexOf('  deleteUser('));
  assert.ok(deleteUser.indexOf('runDelete(userId)') < deleteUser.indexOf('revalidateUserProjectAccess(userId)'),
    'deleteUser re-validates AFTER the delete committed');
});
