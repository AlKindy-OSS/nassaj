import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { connectorsDb } from '@/modules/database/repositories/connectors.db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { INIT_SCHEMA_SQL } from '@/modules/database/schema.js';

/**
 * Runs against a REAL database built by the real connector migration path
 * (T-1226), not a hand-written connectors table. Production boot additionally
 * installs the runtime writer fence; that lifecycle is tested separately and
 * must not turn this repository contract suite into an unfenced raw writer.
 */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp('/var/tmp/connectors-db-');
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  const database = getConnection();
  database.exec(INIT_SCHEMA_SQL);
  runMigrations(database);

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('migration creates the connectors table on a fresh database', async () => {
  await withIsolatedDatabase(() => {
    const columns = getConnection()
      .prepare('PRAGMA table_info(connectors)')
      .all() as { name: string }[];
    const names = columns.map((column) => column.name).sort();

    assert.deepEqual(names, [
      'account_label',
      'allows_sharing',
      'args_json',
      'auth_mode',
      'command',
      'created_at',
      'created_by',
      'credential_mode',
      'display_name',
      'enabled',
      'extra_env_json',
      'id',
      'key_env_var',
      'key_header',
      'key_header_prefix',
      'owner_user_id',
      'service',
      'source_revision',
      'transport',
      'updated_at',
      'url',
    ]);

    // ADR-098 §1: the role gate was dropped by owner decision. Asserted rather
    // than merely documented so re-adding it is a failing test, not a silent
    // return of a boundary the runtime cannot enforce.
    assert.ok(!names.includes('min_role'), 'connectors must not carry a role gate');
  });
});

test('a created connector round-trips with org_shared defaults', async () => {
  await withIsolatedDatabase(() => {
    const created = connectorsDb.create({
      id: 'canva',
      service: 'canva',
      displayName: 'Canva',
      command: 'npx',
      createdBy: null,
    });

    assert.equal(created.id, 'canva');
    assert.equal(created.credentialMode, 'org_shared');
    assert.equal(created.allowsSharing, true);
    assert.equal(created.enabled, true);
    assert.equal(created.accountLabel, '');
    assert.equal(created.sourceRevision, 0);
    assert.deepEqual(connectorsDb.get('canva'), created);
    assert.deepEqual(connectorsDb.listEnabled().map((row) => row.id), ['canva']);
  });
});

test('source seqlock serializes credential promotion and metadata revisions', async () => {
  await withIsolatedDatabase(() => {
    connectorsDb.create({
      id: 'seqlock', service: 'seqlock', displayName: 'Seqlock', command: 'npx',
    });
    assert.equal(connectorsDb.beginSourceMutation('seqlock', 0), 1);
    assert.equal(connectorsDb.beginSourceMutation('seqlock', 0), null);
    assert.equal(connectorsDb.setEnabled('seqlock', false), false);
    assert.equal(connectorsDb.finishSourceMutation('seqlock', 3), null);
    assert.equal(connectorsDb.finishSourceMutation('seqlock', 1), 2);
    assert.equal(connectorsDb.setEnabled('seqlock', false), true);
    assert.equal(connectorsDb.get('seqlock')?.sourceRevision, 4);

    getConnection().prepare(
      'UPDATE connectors SET source_revision = 9007199254740988 WHERE id = ?',
    ).run('seqlock');
    assert.equal(connectorsDb.setEnabled('seqlock', true), true);
    assert.equal(connectorsDb.get('seqlock')?.sourceRevision, 9007199254740990);
    assert.equal(connectorsDb.setEnabled('seqlock', false), false);
    assert.equal(connectorsDb.beginSourceMutation('seqlock'), null);
  });
});

test('allowsSharing is recorded per row so a restricted platform stays restricted', async () => {
  await withIsolatedDatabase(() => {
    connectorsDb.create({
      id: 'canva-team',
      service: 'canva',
      displayName: 'Canva (team)',
      command: 'npx',
      allowsSharing: false,
    });
    assert.equal(connectorsDb.get('canva-team')?.allowsSharing, false);
  });
});

test('one shared connection per platform; each member may still have their own', async () => {
  await withIsolatedDatabase(() => {
    // Real users: owner_user_id carries a foreign key, so a personal connector
    // cannot point at a member who does not exist.
    const one = userDb.createUser('one', 'hash', 'user').id;
    const two = userDb.createUser('two', 'hash', 'user').id;
    connectorsDb.create({ id: 'notion', service: 'notion', displayName: 'Notion', command: 'npx' });

    // A second SHARED Notion would shadow the first — refused.
    assert.throws(
      () =>
        connectorsDb.create({
          id: 'notion-again',
          service: 'notion',
          displayName: 'Notion',
          command: 'npx',
        }),
      /UNIQUE/i,
    );

    // But two members each connecting their OWN Notion is the normal case, and
    // the old team-wide UNIQUE would have refused the second member outright.
    connectorsDb.create({
      id: 'notion-u1', service: 'notion', displayName: 'Notion', command: 'npx',
      credentialMode: 'per_member', ownerUserId: one,
    });
    connectorsDb.create({
      id: 'notion-u2', service: 'notion', displayName: 'Notion', command: 'npx',
      credentialMode: 'per_member', ownerUserId: two,
    });

    // Though one member cannot connect the same platform twice unlabelled.
    assert.throws(
      () =>
        connectorsDb.create({
          id: 'notion-u1-again', service: 'notion', displayName: 'Notion', command: 'npx',
          credentialMode: 'per_member', ownerUserId: one,
        }),
      /UNIQUE/i,
    );

    // A label separates two accounts on the same platform for the same member.
    connectorsDb.create({
      id: 'notion-u1-client', service: 'notion', displayName: 'Notion', command: 'npx',
      accountLabel: 'client', credentialMode: 'per_member', ownerUserId: one,
    });

    assert.equal(connectorsDb.list().length, 4);
  });
});

/**
 * Pins the WORDS the storage engine uses for both duplicate shapes, because
 * connectors.service classifies on them: it turns anything matching "UNIQUE
 * constraint failed" into CONNECTOR_ALREADY_EXISTS so the member reads a
 * sentence instead of our column layout (B-556). If a future SQLite rephrases
 * either one, the classification silently stops firing and the raw text starts
 * reaching the browser again — this test is what fails first.
 */
test('every duplicate shape is worded "UNIQUE constraint failed"', async () => {
  await withIsolatedDatabase(() => {
    const one = userDb.createUser('one', 'hash', 'user').id;
    const notion = { service: 'notion', displayName: 'Notion', command: 'npx' };

    connectorsDb.create({ id: 'notion', ...notion });
    connectorsDb.create({ id: 'notion-u1', ...notion, credentialMode: 'per_member', ownerUserId: one });
    connectorsDb.create({ id: 'stripe', service: 'stripe', displayName: 'Stripe', command: 'npx' });

    const messageFrom = (run: () => void): string => {
      try {
        run();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('expected the duplicate to be refused');
    };

    assert.deepEqual(
      {
        // A second SHARED connection to one platform — the shared partial index.
        shared: messageFrom(() => connectorsDb.create({ id: 'notion-2', ...notion })),
        // One member, one platform, twice — the personal partial index. Note it
        // fires BEFORE the primary key even when the id is identical too, which
        // is why nothing here may key on `connectors.id` alone.
        personal: messageFrom(() =>
          connectorsDb.create({
            id: 'notion-u1', ...notion, credentialMode: 'per_member', ownerUserId: one,
          }),
        ),
        // Two different platforms handed the same id — the primary key itself.
        // This is the shape B-556 produced: the derived id ignored the owner, so
        // a colleague's row already held the string the next member needed.
        primaryKey: messageFrom(() =>
          connectorsDb.create({ id: 'stripe', service: 'figma', displayName: 'Figma', command: 'npx' }),
        ),
      },
      {
        shared: 'UNIQUE constraint failed: connectors.service, connectors.account_label',
        personal:
          'UNIQUE constraint failed: connectors.service, connectors.account_label, connectors.owner_user_id',
        primaryKey: 'UNIQUE constraint failed: connectors.id',
      },
    );
  });
});

test('an OAuth connector round-trips with authMode oauth and no key env var', async () => {
  await withIsolatedDatabase(() => {
    const created = connectorsDb.create({
      id: 'canva', service: 'canva', displayName: 'Canva', command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.canva.com/mcp'],
      authMode: 'oauth', allowsSharing: false,
    });
    assert.equal(created.authMode, 'oauth');
    assert.equal(created.keyEnvVar, null, 'an OAuth row carries no key variable');
    assert.equal(connectorsDb.get('canva')?.authMode, 'oauth');
  });
});

test('a row defaults to key auth when nothing says otherwise', async () => {
  await withIsolatedDatabase(() => {
    const created = connectorsDb.create({
      id: 'plain', service: 'plain', displayName: 'Plain', command: 'npx',
    });
    assert.equal(created.authMode, 'key');
  });
});

test('a personal connector without an owner is refused', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () =>
        connectorsDb.create({
          id: 'orphan', service: 'notion', displayName: 'Notion', command: 'npx',
          credentialMode: 'per_member',
        }),
      /personal connector requires an owner/,
    );
  });
});

test('visibility: a member sees shared connectors plus only their own', async () => {
  await withIsolatedDatabase(() => {
    const one = userDb.createUser('one', 'hash', 'user').id;
    const two = userDb.createUser('two', 'hash', 'user').id;
    connectorsDb.create({ id: 'team', service: 'stripe', displayName: 'Stripe', command: 'npx' });
    connectorsDb.create({
      id: 'mine', service: 'notion', displayName: 'Notion', command: 'npx',
      credentialMode: 'per_member', ownerUserId: one,
    });
    connectorsDb.create({
      id: 'theirs', service: 'figma', displayName: 'Figma', command: 'npx',
      credentialMode: 'per_member', ownerUserId: two,
    });

    assert.deepEqual(connectorsDb.listVisibleTo(one).map((r) => r.id).sort(), ['mine', 'team']);
    assert.deepEqual(connectorsDb.listVisibleTo(two).map((r) => r.id).sort(), ['team', 'theirs']);
    assert.deepEqual(
      connectorsDb.listEnabledForUser(two).map((r) => r.id).sort(),
      ['team', 'theirs'],
    );
  });
});

test('malformed ids are rejected before they reach the secret store', async () => {
  await withIsolatedDatabase(() => {
    for (const bad of ['a:b', '', '../escape', '-leading', 'x'.repeat(65)]) {
      assert.throws(
        () => connectorsDb.create({ id: bad, service: 'canva', displayName: 'Canva' }),
        /Connector id must match/,
      );
    }
    assert.throws(
      () => connectorsDb.create({ id: 'ok', service: '  ', displayName: 'X' }),
      /service must be a non-empty string/,
    );
    assert.throws(
      () => connectorsDb.create({ id: 'ok', service: 'canva', displayName: '  ' }),
      /displayName must be a non-empty string/,
    );

    // A row that names a platform but no way to reach it is not a connector.
    // Rejected at birth so no later stage has to cope with it.
    assert.throws(
      () => connectorsDb.create({ id: 'ok', service: 'canva', displayName: 'Canva' }),
      /stdio connector requires a command/,
    );
    assert.throws(
      () =>
        connectorsDb.create({
          id: 'ok',
          service: 'canva',
          displayName: 'Canva',
          transport: 'http',
        }),
      /http connector requires a url/,
    );
  });
});

test('disabling keeps the row but removes it from the distribution set', async () => {
  await withIsolatedDatabase(() => {
    connectorsDb.create({ id: 'wafeq', service: 'wafeq', displayName: 'Wafeq', command: 'npx' });

    assert.equal(connectorsDb.setEnabled('wafeq', false), true);
    assert.equal(connectorsDb.get('wafeq')?.enabled, false);
    assert.deepEqual(connectorsDb.listEnabled(), [], 'disabled rows are not distributed');
    assert.equal(connectorsDb.list().length, 1, 'but the row and its key survive');

    assert.equal(connectorsDb.setEnabled('wafeq', true), true);
    assert.deepEqual(connectorsDb.listEnabled().map((row) => row.id), ['wafeq']);
  });
});

test('rename and remove report whether they matched a row', async () => {
  await withIsolatedDatabase(() => {
    connectorsDb.create({ id: 'gdrive', service: 'google', displayName: 'Drive', command: 'npx' });

    assert.equal(connectorsDb.rename('gdrive', 'Google Drive'), true);
    assert.equal(connectorsDb.get('gdrive')?.displayName, 'Google Drive');
    assert.equal(connectorsDb.rename('missing', 'X'), false);

    assert.equal(connectorsDb.remove('gdrive'), true);
    assert.equal(connectorsDb.remove('gdrive'), false, 'removal is idempotent');
    assert.equal(connectorsDb.get('gdrive'), null);
  });
});

test('OAuth first-start compensation deletes only the exact newborn personal row', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('oauth-owner', 'hash', 'user').id;
    const other = userDb.createUser('oauth-other', 'hash', 'user').id;
    const created = connectorsDb.create({
      id: `notion-u${owner}`, service: 'notion', displayName: 'Notion', command: 'node',
      authMode: 'oauth', credentialMode: 'per_member', ownerUserId: owner,
    });
    const odd = connectorsDb.beginSourceMutation(created.id, created.sourceRevision)!;
    assert.equal(
      connectorsDb.removeExactClaimedNewbornPersonalOAuth(
        created.id, other, odd, created.sourceRevision,
      ),
      false,
      'wrong owner cannot compensate',
    );
    assert.equal(
      connectorsDb.removeExactClaimedNewbornPersonalOAuth(
        created.id, owner, odd + 2, created.sourceRevision,
      ),
      false,
      'stale revision cannot compensate',
    );
    assert.ok(connectorsDb.get(created.id));
    assert.equal(
      connectorsDb.removeExactClaimedNewbornPersonalOAuth(
        created.id, owner, odd, created.sourceRevision,
      ),
      true,
    );
    assert.equal(connectorsDb.get(created.id), null);

    const key = connectorsDb.create({
      id: `github-u${owner}`, service: 'github', displayName: 'GitHub', transport: 'http',
      url: 'https://example.test/mcp', authMode: 'key', credentialMode: 'per_member',
      ownerUserId: owner,
    });
    const keyOdd = connectorsDb.beginSourceMutation(key.id, key.sourceRevision)!;
    assert.equal(
      connectorsDb.removeExactClaimedNewbornPersonalOAuth(
        key.id, owner, keyOdd, key.sourceRevision,
      ),
      false,
      'key connectors are outside OAuth compensation',
    );
    assert.equal(connectorsDb.releaseSourceMutationUnchanged(key.id, keyOdd), key.sourceRevision);
  });
});

test('OAuth start claims release unchanged and stale claims cannot release or delete', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('claim-owner', 'hash', 'user').id;
    const created = connectorsDb.create({
      id: `linear-u${owner}`, service: 'linear', displayName: 'Linear', command: 'node',
      authMode: 'oauth', credentialMode: 'per_member', ownerUserId: owner,
    });
    const odd = connectorsDb.beginSourceMutation(created.id, created.sourceRevision);
    assert.equal(odd, created.sourceRevision + 1);
    assert.equal(connectorsDb.beginSourceMutation(created.id, created.sourceRevision), null);
    assert.equal(connectorsDb.releaseSourceMutationUnchanged(created.id, odd! + 2), null);
    assert.equal(connectorsDb.get(created.id)?.sourceRevision, odd);
    assert.equal(connectorsDb.releaseSourceMutationUnchanged(created.id, odd!), created.sourceRevision);
    assert.equal(connectorsDb.get(created.id)?.sourceRevision, created.sourceRevision);

    const claimedAgain = connectorsDb.beginSourceMutation(created.id, created.sourceRevision)!;
    assert.equal(
      connectorsDb.removeExactClaimedNewbornPersonalOAuth(
        created.id, owner, claimedAgain + 2, created.sourceRevision,
      ),
      false,
    );
    assert.ok(connectorsDb.get(created.id));
    assert.equal(
      connectorsDb.removeExactClaimedNewbornPersonalOAuth(
        created.id, owner, claimedAgain, created.sourceRevision,
      ),
      true,
    );
    assert.equal(connectorsDb.get(created.id), null);
  });
});

/**
 * The split that the whole design rests on: the registry is safe to serve to a
 * client because it cannot carry key material. If a secret ever becomes
 * reachable from a row, this fails.
 */
test('no connector row can carry secret material', async () => {
  await withIsolatedDatabase(() => {
    const created = connectorsDb.create({
      id: 'canva',
      service: 'canva',
      displayName: 'Canva',
      command: 'npx',
    });
    const serialized = JSON.stringify(created).toLowerCase();
    for (const forbidden of ['apikey', 'api_key', 'secret', 'token', 'password']) {
      assert.ok(!serialized.includes(forbidden), `row must not expose ${forbidden}`);
    }
  });
});
