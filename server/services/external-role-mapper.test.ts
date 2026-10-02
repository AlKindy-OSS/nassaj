import assert from 'node:assert/strict';
import test from 'node:test';

import { FIXTURE_RULES, fixtureRowFields, PROVIDER_FIXTURES } from './__tests__/sso-provider-claims.js';
import { reconcileLocalRole, syncExternalRole } from './external-role-mapper.js';
import { buildSsoMapping, evaluateSsoClaims } from './sso-role-mapping.js';

test('an owner with a mapped role is never changed; no mapped role yields no role for anyone', () => {
  assert.deepEqual(reconcileLocalRole('owner', 'user'), { role: 'owner', changed: false });
  assert.deepEqual(reconcileLocalRole('owner', null), { role: null, changed: false });
  assert.deepEqual(reconcileLocalRole('user', 'admin'), { role: 'admin', changed: true });
  assert.deepEqual(reconcileLocalRole('admin', 'user'), { role: 'user', changed: true });
  assert.deepEqual(reconcileLocalRole('admin', undefined), { role: null, changed: false });
});

test('owner is never derived: anything but admin/user maps to no role', () => {
  for (const mapped of ['owner', 'Admin', 'superuser', '__proto__', 7, {}, ['admin']]) {
    assert.deepEqual(reconcileLocalRole('user', mapped), { role: null, changed: false }, JSON.stringify(mapped));
  }
});

test('multi-provider pipeline: claim path + rules + tenant, then the local reconcile', () => {
  for (const [name, fixture] of Object.entries(PROVIDER_FIXTURES)) {
    const decision = evaluateSsoClaims(fixture.claims, buildSsoMapping(fixtureRowFields(fixture)));
    const reconciled = reconcileLocalRole('user', decision.role);
    assert.equal(reconciled.role, fixture.expectedRole, name);
    assert.equal(reconcileLocalRole('owner', decision.role).role, fixture.expectedRole ? 'owner' : null, name);
  }
  assert.ok(FIXTURE_RULES.every((rule) => rule.role !== ('owner' as string)));
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
  const fresh = syncExternalRole({ user: { id: 5, role: 'user' }, mappedRole: 'admin', provider: 'oidc' }, deps);
  assert.equal(fresh?.role, 'admin');
  assert.deepEqual(writes, [[5, 'user', 'admin']]);
  assert.deepEqual(audits, [{ action: 'external_role_synced', userId: 5, metadata: { provider: 'oidc', from: 'user', to: 'admin' } }]);

  const unchanged = fakeDeps({ id: 6, role: 'admin' });
  const same = { id: 6, role: 'admin' };
  assert.equal(syncExternalRole({ user: same, mappedRole: 'admin', provider: 'oidc' }, unchanged.deps), same);
  assert.equal(unchanged.writes.length + unchanged.audits.length, 0);

  const owner = fakeDeps({ id: 1, role: 'owner' });
  const ownerRow = { id: 1, role: 'owner' };
  assert.equal(syncExternalRole({ user: ownerRow, mappedRole: 'user', provider: 'oidc' }, owner.deps), ownerRow);
  assert.equal(owner.writes.length + owner.audits.length, 0, 'an owner row is never written');
});

test('T-1939: no recognized role returns null and never writes, audits or downgrades', () => {
  for (const [role, mappedRole] of [['admin', null], ['user', 'superuser'], ['owner', undefined]] as const) {
    const stored = { id: 8, role };
    const { deps, audits, writes } = fakeDeps(stored);
    const applied: unknown[] = [];
    const result = syncExternalRole(
      { user: { id: 8, role }, mappedRole, provider: 'oidc' },
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
  const fresh = syncExternalRole({ user: { id: 7, role: 'admin' }, mappedRole: 'user', provider: 'oidc' }, deps);
  assert.equal(fresh?.role, 'owner');
  assert.equal(audits.length, 0);
});

test('B-1327: onRoleApplied fires only when the compare-and-set changed the role', () => {
  const applied: unknown[] = [];
  const onRoleApplied = (change: unknown) => applied.push(change);
  const demoted = fakeDeps({ id: 11, role: 'admin' });
  syncExternalRole({ user: { id: 11, role: 'admin' }, mappedRole: 'user', provider: 'oidc' },
    { ...demoted.deps, onRoleApplied });
  assert.deepEqual(applied, [{ userId: 11, from: 'admin', to: 'user' }]);

  const lost = fakeDeps({ id: 12, role: 'owner' }, false);
  syncExternalRole({ user: { id: 12, role: 'admin' }, mappedRole: 'user', provider: 'oidc' },
    { ...lost.deps, onRoleApplied });
  const unchanged = fakeDeps({ id: 13, role: 'admin' });
  syncExternalRole({ user: { id: 13, role: 'admin' }, mappedRole: 'admin', provider: 'oidc' },
    { ...unchanged.deps, onRoleApplied });
  assert.equal(applied.length, 1, 'a lost race or no change never revokes');
});

