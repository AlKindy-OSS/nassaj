/** New accounts are provisioned without copying any existing connector config. */
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

let nextUserId = 10;
let accepted = false;
let connectorFanoutCalls = 0;
const users = new Map<string, Record<string, unknown>>();

mock.module(url('../modules/connectors/index.js'), {
  namedExports: {
    connectorsService: {
      distributeAllToUser: async () => { connectorFanoutCalls += 1; return []; },
    },
  },
});
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userDb: {
      getUserByUsername: (username: string) => users.get(username) ?? null,
      createUser: (username: string, _hash: string, role: string, invitedBy: number) => {
        const user = { id: nextUserId++, username, role, invited_by: invitedBy };
        users.set(username, user);
        return user;
      },
    },
    invitesDb: {
      findByTokenHash: () => ({
        id: 2,
        role: 'user',
        invited_by: 1,
        status: 'pending',
        expires_at: '2999-01-01 00:00:00',
      }),
      markAccepted: () => { accepted = true; return true; },
    },
    auditLogDb: { record: () => {} },
  },
});
mock.module(url('./isolation/provision-user-dirs.js'), {
  namedExports: { provisionUserDirs: () => {} },
});
mock.module(url('./password.service.js'), {
  namedExports: { hashPassword: async () => 'argon2-hash' },
});

const { acceptInvite, createOidcUser } = await import('./invite.service.js');

test('invite acceptance creates the account without connector fan-out or config writes', async () => {
  accepted = false;
  connectorFanoutCalls = 0;
  const user = await acceptInvite({ token: 'token', username: 'invite_user', password: 'password12' });
  assert.equal(user.username, 'invite_user');
  assert.equal(accepted, true);
  assert.equal(connectorFanoutCalls, 0);
});

test('OIDC account creation also leaves connector placement untouched', async () => {
  connectorFanoutCalls = 0;
  const user = await createOidcUser(
    { id: 1, role: 'owner' },
    { username: 'oidc_user', role: 'user' },
  );
  assert.equal(user.username, 'oidc_user');
  assert.equal(connectorFanoutCalls, 0);
});
