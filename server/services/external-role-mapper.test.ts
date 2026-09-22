import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTERNAL_ROLE_MAP,
  ROLES_CLAIM_ABSENT_REASON,
  extractZitadelRoleNames,
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

test('absent, malformed or unknown attestations fall to the lowest role, never owner', () => {
  for (const input of [undefined, null, 'admin', {}, [], ['Admin'], ['superuser'], [42], ['owner'], ['__proto__']]) {
    assert.equal(mapExternalRoles(input), 'user', JSON.stringify(input));
  }
  assert.ok(!Object.values(EXTERNAL_ROLE_MAP).includes('owner'));
  assert.ok(Object.isFrozen(EXTERNAL_ROLE_MAP));
});

test('an owner is never changed; admins and users follow the attestation', () => {
  assert.deepEqual(reconcileLocalRole('owner', []), { role: 'owner', changed: false });
  assert.deepEqual(reconcileLocalRole('owner', ['viewer']), { role: 'owner', changed: false });
  assert.deepEqual(reconcileLocalRole('user', ['admin']), { role: 'admin', changed: true });
  assert.deepEqual(reconcileLocalRole('admin', ['member']), { role: 'user', changed: true });
  assert.deepEqual(reconcileLocalRole('admin', undefined), { role: 'user', changed: true });
  assert.deepEqual(reconcileLocalRole('user', ['owner']), { role: 'user', changed: false });
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
  assert.equal(syncExternalRole({ user: ownerRow, externalRoles: [], provider: 'oidc' }, owner.deps), ownerRow);
  assert.equal(owner.writes.length + owner.audits.length, 0, 'an owner row is never written');
});

test('an absent roles claim tags the demotion audit with a distinct reason; present does not', () => {
  // Claim absent entirely: demotion carries the diagnosable reason.
  const absent = fakeDeps({ id: 8, role: 'admin' });
  syncExternalRole(
    { user: { id: 8, role: 'admin' }, externalRoles: [], provider: 'oidc', claimPresent: false },
    absent.deps,
  );
  assert.deepEqual(absent.audits, [{
    action: 'external_role_synced',
    userId: 8,
    metadata: { provider: 'oidc', from: 'admin', to: 'user', reason: ROLES_CLAIM_ABSENT_REASON },
  }]);

  // Claim present but no recognized role: same demotion, no reason tag.
  const present = fakeDeps({ id: 9, role: 'admin' });
  syncExternalRole(
    { user: { id: 9, role: 'admin' }, externalRoles: ['unknown'], provider: 'oidc', claimPresent: true },
    present.deps,
  );
  assert.deepEqual(present.audits, [{
    action: 'external_role_synced',
    userId: 9,
    metadata: { provider: 'oidc', from: 'admin', to: 'user' },
  }]);

  // claimPresent omitted: back-compat, no reason tag.
  const legacy = fakeDeps({ id: 10, role: 'admin' });
  syncExternalRole({ user: { id: 10, role: 'admin' }, externalRoles: [], provider: 'oidc' }, legacy.deps);
  assert.deepEqual(legacy.audits[0]?.metadata, { provider: 'oidc', from: 'admin', to: 'user' });
});

test('a lost compare-and-set race is not audited and yields the stored role', () => {
  const stored = { id: 7, role: 'owner' };
  const { deps, audits } = fakeDeps(stored, false);
  const fresh = syncExternalRole({ user: { id: 7, role: 'admin' }, externalRoles: [], provider: 'oidc' }, deps);
  assert.equal(fresh?.role, 'owner');
  assert.equal(audits.length, 0);
});
