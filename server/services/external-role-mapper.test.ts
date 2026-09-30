import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTERNAL_ROLE_MAP,
  extractZitadelRoleNames,
  extractZitadelRoleNamesFromOrgs,
  hasZitadelRolesClaim,
  isValidRoleProjectId,
  mapExternalRoles,
  reconcileLocalRole,
  syncExternalRole,
} from './external-role-mapper.js';

const GENERIC = 'urn:zitadel:iam:org:project:roles';
const PROJECT = '111';
const SCOPED = `urn:zitadel:iam:org:project:${PROJECT}:roles`;

test('maps admin/member/viewer and resolves multiple roles to the highest rank', () => {
  assert.equal(mapExternalRoles(['admin']), 'admin');
  assert.equal(mapExternalRoles(['member']), 'user');
  assert.equal(mapExternalRoles(['viewer']), 'user');
  assert.equal(mapExternalRoles(['viewer', 'admin', 'member']), 'admin');
});

test('T-1939: absent, malformed or only-unknown attestations map to NO role, never owner', () => {
  for (const input of [undefined, null, 'admin', {}, [], ['Admin'], ['superuser'], [42], ['owner'], ['__proto__']]) {
    assert.equal(mapExternalRoles(input), null, JSON.stringify(input));
  }
  assert.equal(mapExternalRoles(['superuser', 'member']), 'user', 'unknown names are ignored beside a known one');
  assert.ok(!Object.values(EXTERNAL_ROLE_MAP).includes('owner'));
  assert.ok(Object.isFrozen(EXTERNAL_ROLE_MAP));
});

test('an owner with a known role is never changed; no known role yields no role for anyone', () => {
  assert.deepEqual(reconcileLocalRole('owner', ['viewer']), { role: 'owner', changed: false });
  assert.deepEqual(reconcileLocalRole('owner', []), { role: null, changed: false });
  assert.deepEqual(reconcileLocalRole('user', ['admin']), { role: 'admin', changed: true });
  assert.deepEqual(reconcileLocalRole('admin', ['member']), { role: 'user', changed: true });
  assert.deepEqual(reconcileLocalRole('admin', undefined), { role: null, changed: false });
  assert.deepEqual(reconcileLocalRole('user', ['owner']), { role: null, changed: false });
});

test('Zitadel adapter reads native object and flat array shapes from the scoped claim, bounded', () => {
  assert.deepEqual(extractZitadelRoleNames({ [SCOPED]: { admin: { '1': 'org.example' } } }, PROJECT), ['admin']);
  assert.deepEqual(extractZitadelRoleNames({ [SCOPED]: ['member', 7, ''] }, PROJECT), ['member']);
  assert.deepEqual(extractZitadelRoleNames({}, PROJECT), []);
  assert.deepEqual(extractZitadelRoleNames({ [SCOPED]: 'admin' }, PROJECT), []);
  assert.deepEqual(extractZitadelRoleNames(null as never, PROJECT), []);
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`r${i}`, {}]));
  assert.equal(extractZitadelRoleNames({ [SCOPED]: many }, PROJECT).length, 64);
  assert.deepEqual(extractZitadelRoleNames({ [SCOPED]: ['x'.repeat(129)] }, PROJECT), []);
});

test('Zitadel adapter reads ONLY the configured project-scoped claim, never a foreign or generic one', () => {
  const claims = {
    [GENERIC]: { admin: {} },
    'urn:zitadel:iam:org:project:111:roles': { admin: {} },
    'urn:zitadel:iam:org:project:999:roles': { admin: {} },
  };
  assert.deepEqual(extractZitadelRoleNames(claims, '111'), ['admin'], 'reads its own project claim');
  assert.deepEqual(extractZitadelRoleNames(claims, '888'), [], 'a project with no scoped claim grants nothing');
  assert.deepEqual(
    extractZitadelRoleNames(claims, '999'),
    ['admin'],
    'a foreign project only grants when it is the configured project',
  );
});

test('fail-closed: the generic cross-project claim alone grants nothing', () => {
  const genericOnly = { [GENERIC]: { admin: { '1': 'org.example' } } };
  // No matter how the project id is (mis)configured, the generic claim is never read.
  assert.deepEqual(extractZitadelRoleNames(genericOnly, PROJECT), [], 'valid project id, generic claim ignored');
  assert.deepEqual(extractZitadelRoleNames(genericOnly, undefined), [], 'missing project id grants nothing');
  assert.deepEqual(extractZitadelRoleNames(genericOnly, ''), [], 'empty project id grants nothing');
  assert.deepEqual(extractZitadelRoleNames(genericOnly, '1:roles,x'), [], 'invalid project id is never interpolated');
});

test('isValidRoleProjectId enforces the fail-closed pattern', () => {
  assert.equal(isValidRoleProjectId('111'), true);
  assert.equal(isValidRoleProjectId('Proj_id-9'), true);
  assert.equal(isValidRoleProjectId('x'.repeat(64)), true);
  for (const bad of [undefined, null, '', '  ', 'x'.repeat(65), 'has space', 'a:b', 'x/y', 42]) {
    assert.equal(isValidRoleProjectId(bad as never), false, JSON.stringify(bad));
  }
});

test('hasZitadelRolesClaim distinguishes absent from present-but-empty on the scoped claim', () => {
  assert.equal(hasZitadelRolesClaim({ [SCOPED]: { admin: {} } }, PROJECT), true);
  assert.equal(hasZitadelRolesClaim({ [SCOPED]: {} }, PROJECT), true, 'present-but-empty still counts as present');
  assert.equal(hasZitadelRolesClaim({ [SCOPED]: 'garbage' }, PROJECT), true, 'present-but-malformed still counts');
  assert.equal(hasZitadelRolesClaim({}, PROJECT), false, 'absent');
  assert.equal(hasZitadelRolesClaim({ [GENERIC]: { admin: {} } }, PROJECT), false, 'the generic claim does not count');
  assert.equal(hasZitadelRolesClaim({ [SCOPED]: {} }, undefined), false, 'no valid project id ⇒ never present');
  assert.equal(hasZitadelRolesClaim(null as never, PROJECT), false);
});

function fakeDeps(stored: { id: number; role: string }, casResult = true) {
  const audits: Array<Record<string, unknown>> = [];
  const writes: unknown[][] = [];
  return {
    audits,
    writes,
    deps: {
      userDb: {
        setRoleIfUnchanged: (...args: unknown[]) => {
          writes.push(args);
          if (casResult) stored.role = args[2] as string;
          return casResult;
        },
        getUserById: () => ({ ...stored }),
      },
      auditLogDb: { record: (action: string, data: Record<string, unknown>) => audits.push({ action, ...data }) },
    },
  };
}

test('sync writes via compare-and-set, audits only real changes, returns the fresh row', () => {
  const stored = { id: 5, role: 'user' };
  const { deps, audits, writes } = fakeDeps(stored);
  const fresh = syncExternalRole({ user: { id: 5, role: 'user' }, externalRoles: ['admin'], provider: 'oidc' }, deps);
  assert.equal(fresh?.role, 'admin');
  assert.deepEqual(writes, [[5, 'user', 'admin']]);
  assert.deepEqual(audits, [{ action: 'external_role_synced', userId: 5, metadata: { provider: 'oidc', from: 'user', to: 'admin' } }]);

  const unchanged = fakeDeps({ id: 6, role: 'admin' });
  const same = { id: 6, role: 'admin' };
  assert.equal(syncExternalRole({ user: same, externalRoles: ['admin'], provider: 'oidc' }, unchanged.deps), same);
  assert.equal(unchanged.writes.length + unchanged.audits.length, 0);

  const owner = fakeDeps({ id: 1, role: 'owner' });
  const ownerRow = { id: 1, role: 'owner' };
  assert.equal(syncExternalRole({ user: ownerRow, externalRoles: ['member'], provider: 'oidc' }, owner.deps), ownerRow);
  assert.equal(owner.writes.length + owner.audits.length, 0, 'an owner row is never written');
});

test('T-1939: no recognized role returns null and never writes, audits or downgrades', () => {
  for (const [role, externalRoles] of [['admin', []], ['user', ['superuser']], ['owner', undefined]] as const) {
    const stored = { id: 8, role };
    const { deps, audits, writes } = fakeDeps(stored);
    const applied: unknown[] = [];
    const result = syncExternalRole(
      { user: { id: 8, role }, externalRoles, provider: 'oidc' },
      { ...deps, onRoleApplied: (change: unknown) => applied.push(change) },
    );
    assert.equal(result, null, role);
    assert.equal(writes.length + audits.length + applied.length, 0, role);
    assert.equal(stored.role, role, 'the stored role is left as is');
  }
});

test('a lost compare-and-set race is not audited and yields the stored role', () => {
  const stored = { id: 7, role: 'owner' };
  const { deps, audits } = fakeDeps(stored, false);
  const fresh = syncExternalRole({ user: { id: 7, role: 'admin' }, externalRoles: ['member'], provider: 'oidc' }, deps);
  assert.equal(fresh?.role, 'owner');
  assert.equal(audits.length, 0);
});

test('B-1327: onRoleApplied fires only when the compare-and-set changed the role', () => {
  const applied: unknown[] = [];
  const onRoleApplied = (change: unknown) => applied.push(change);
  const demoted = fakeDeps({ id: 11, role: 'admin' });
  syncExternalRole({ user: { id: 11, role: 'admin' }, externalRoles: ['viewer'], provider: 'oidc' },
    { ...demoted.deps, onRoleApplied });
  assert.deepEqual(applied, [{ userId: 11, from: 'admin', to: 'user' }]);

  const lost = fakeDeps({ id: 12, role: 'owner' }, false);
  syncExternalRole({ user: { id: 12, role: 'admin' }, externalRoles: ['member'], provider: 'oidc' },
    { ...lost.deps, onRoleApplied });
  const unchanged = fakeDeps({ id: 13, role: 'admin' });
  syncExternalRole({ user: { id: 13, role: 'admin' }, externalRoles: ['admin'], provider: 'oidc' },
    { ...unchanged.deps, onRoleApplied });
  assert.equal(applied.length, 1, 'a lost race or no change never revokes');
});

test('T-1939 slice 4: only roles granted by an allowed organization are returned', () => {
  const allowed = new Set(['org-a']);
  const claims = {
    [SCOPED]: {
      admin: { 'org-b': 'b.example' },
      member: { 'org-a': 'a.example', 'org-b': 'b.example' },
      viewer: {},
    },
    [GENERIC]: { admin: { 'org-a': 'a.example' } },
  };
  assert.deepEqual(extractZitadelRoleNamesFromOrgs(claims, PROJECT, allowed), ['member']);
  assert.deepEqual(extractZitadelRoleNamesFromOrgs(claims, PROJECT, new Set(['org-b'])), ['admin', 'member']);
});

test('T-1939 slice 4: no allowlist, no organization keys or the generic claim grant nothing', () => {
  const allowed = new Set(['org-a']);
  assert.deepEqual(extractZitadelRoleNamesFromOrgs({ [SCOPED]: { admin: { 'org-a': 'a' } } }, PROJECT, new Set()), []);
  assert.deepEqual(extractZitadelRoleNamesFromOrgs({ [SCOPED]: ['admin'] }, PROJECT, allowed), []);
  assert.deepEqual(extractZitadelRoleNamesFromOrgs({ [SCOPED]: { admin: ['org-a'] } }, PROJECT, allowed), []);
  assert.deepEqual(extractZitadelRoleNamesFromOrgs({ [GENERIC]: { admin: { 'org-a': 'a' } } }, PROJECT, allowed), []);
  assert.deepEqual(extractZitadelRoleNamesFromOrgs({ [SCOPED]: { admin: { 'org-a': 'a' } } }, undefined, allowed), []);
  assert.deepEqual(extractZitadelRoleNamesFromOrgs({ [SCOPED]: { admin: { 'org-a': 'a' } } }, PROJECT, ['org-a'] as never), []);
});
