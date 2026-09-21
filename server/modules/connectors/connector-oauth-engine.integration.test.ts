import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

// eslint-disable-next-line boundaries/dependencies -- integration test exercises the real persistence adapter.
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- integration test exercises the real persistence adapter.
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';

import { encryptConnectorVaultSecret } from './connector-auth-vault.crypto.js';
import {
  ConnectorOAuthEngineError,
  connectorOAuthAcceptedScopePlan,
  connectorOAuthScopePlan,
  connectorOAuthTokenHeaders,
  createConnectorOAuthEngine,
} from './connector-oauth-engine.js';
import { createConnectorUserGrantService } from './connector-user-grant.service.js';

const CALLBACK = 'https://nassaj.example/connectors/oauth/callback';
const USER_ID = 7;
const keyring = {
  activeKekVersion: () => 1,
  readKek: () => Buffer.alloc(32, 4),
  activeHmacKeyVersion: () => 1,
  readHmacKey: () => Buffer.alloc(32, 5),
};
const env = Object.freeze({
  NASSAJ_CONNECTOR_OAUTH_V2: '1',
  NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
  NASSAJ_CONNECTOR_AUTH_CERT_GOOGLE_WORKSPACE: '1',
  NASSAJ_CONNECTOR_OAUTH_CERT_GOOGLE_WORKSPACE: '1',
  NASSAJ_CONNECTOR_GRANTS_V2: '1',
  NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2: '1',
  NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GOOGLE_CALENDAR: '1',
  NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GOOGLE_DRIVE: '1',
  NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GMAIL: '1',
});

const DCR_SCOPE_CASES = Object.freeze({
  notion: ['default'],
  sentry: ['org:read'],
  linear: ['read'],
  atlassian: ['read:jira-work'],
} satisfies Readonly<Record<string, readonly string[]>>);

test('every pending DCR contract drops prior and callback scopes outside its documented allowlist', () => {
  for (const [serviceId, minimum] of Object.entries(DCR_SCOPE_CASES)) {
    const requested = connectorOAuthScopePlan(serviceId, ['openid', 'unexpected', ...minimum]);
    assert.deepEqual(requested, minimum, `${serviceId} prior scopes`);
    assert.deepEqual(
      connectorOAuthAcceptedScopePlan(serviceId, requested, [...minimum, 'unexpected', 'openid']),
      minimum,
      `${serviceId} callback extras`,
    );
    assert.throws(
      () => connectorOAuthAcceptedScopePlan(serviceId, requested, ['unexpected']),
      /connector_oauth_scope_missing/u,
      `${serviceId} callback missing minimum`,
    );
  }
});

const profileField = (
  repository: ReturnType<typeof createConnectorAuthDb>,
  installationId: string,
  profileId: string,
  purpose: 'client_id' | 'client_secret',
  value: string,
  fence: NonNullable<ReturnType<ReturnType<typeof createConnectorAuthDb>['acquireLease']>>,
) => {
  const secretRef = randomUUID();
  const raw = Buffer.from(value);
  try {
    assert.equal(repository.stageVaultSecret({
      secretRef, installationId, providerId: 'google-workspace', profileId,
      fieldPurpose: purpose, secretKind: purpose,
      envelope: encryptConnectorVaultSecret(raw, {
        vaultSecretId: secretRef, installationId, providerId: 'google-workspace',
        subjectType: 'profile', subjectId: profileId, profileId, userId: null,
        fieldPurpose: purpose, secretRevision: 1,
      }, keyring),
      fence,
    }), true);
  } finally { raw.fill(0); }
  return secretRef;
};

const fixture = () => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    INSERT INTO users (id, username) VALUES (${USER_ID}, 'owner');
  `);
  migrateConnectorAuthSchema(database);
  const repository = createConnectorAuthDb(database);
  const installationId = repository.getOrCreateInstallation();
  const profileId = randomUUID();
  const fence = repository.acquireLease(
    `profile-provider:${installationId}:google-workspace`, randomUUID(), 60,
  );
  assert.ok(fence);
  assert.ok(repository.createPendingProfile({
    profileId, installationId, providerId: 'google-workspace',
    canonicalOrigin: 'https://nassaj.example', catalogRevision: '2026-08-26.m1', fence,
  }));
  const clientIdRef = profileField(repository, installationId, profileId, 'client_id', 'client-1', fence);
  const clientSecretRef = profileField(
    repository, installationId, profileId, 'client_secret', 'secret-1', fence,
  );
  assert.ok(repository.activateProfile({
    profileId, expectedVersion: 1, catalogRevision: '2026-08-26.m1',
    secretRefs: { client_id: clientIdRef, client_secret: clientSecretRef }, fence,
  }));
  repository.releaseLease(fence);
  return { database, repository, installationId, profileId };
};

test('Canva refresh credentials use Basic auth while the unverified identity contract stays closed', async () => {
  assert.equal(
    connectorOAuthTokenHeaders('canva', 'canva-client', 'canva-secret').authorization,
    `Basic ${Buffer.from('canva-client:canva-secret').toString('base64')}`,
  );
  const { database, repository, installationId } = fixture();
  try {
    const engine = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK, repository, keyring,
      env: {
        NASSAJ_CONNECTOR_OAUTH_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
        NASSAJ_CONNECTOR_AUTH_CERT_CANVA: '1', NASSAJ_CONNECTOR_OAUTH_CERT_CANVA: '1',
      },
      verifyIdentity: async () => ({ subject: 'unused' }),
    });
    await assert.rejects(() => engine.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'canva',
    }), /connector_oauth_provider_disabled/u);
  } finally { database.close(); }
});

test('Google requires id_token and uses one encrypted grant with incremental scopes, replay protection, rotation, and local revoke', async () => {
  const { database, repository, installationId } = fixture();
  const requests: string[] = [];
  let refreshNumber = 0;
  let verifiedSubject = 'google-user-1';
  let revokeAttempts = 0;
  try {
    const engine = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK, repository, keyring, env,
      exchange: async ({ body }) => {
        const encoded = body.toString();
        requests.push(encoded);
        const values = new URLSearchParams(encoded);
        if (values.get('grant_type') === 'refresh_token') {
          refreshNumber += 1;
          return {
            access_token: `access-refresh-${refreshNumber}`,
            refresh_token: `refresh-${refreshNumber + 1}`,
            expires_in: 3600,
          };
        }
        return {
          access_token: `access-${requests.length}`,
          refresh_token: 'refresh-1',
          expires_in: 3600,
          id_token: 'signed-id-token',
        };
      },
      verifyIdentity: async ({ nonce }) => {
        assert.match(nonce, /^[A-Za-z0-9_-]{43}$/u);
        return { subject: verifiedSubject };
      },
      revokeRemote: async () => { revokeAttempts += 1; throw new Error('provider unavailable'); },
    });

    const calendar = await engine.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'google-calendar',
    });
    const calendarUrl = new URL(calendar.authorizeUrl);
    assert.equal(calendarUrl.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(calendarUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.match(calendarUrl.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/u);
    assert.match(calendar.state, /^v2\./u);
    const first = await engine.callback({ state: calendar.state, code: 'code-one' });
    assert.equal(first.serviceId, 'google-calendar');
    assert.equal(repository.bindOAuthConnectorGrant({
      connectorId: 'calendar-work', installationId, userId: USER_ID,
      serviceId: 'google-calendar', grantId: first.grantId,
    }), true);
    assert.deepEqual(repository.readOAuthConnectorGrantBinding(
      'calendar-work', installationId, USER_ID, 'google-calendar',
    ), { grantId: first.grantId });
    await assert.rejects(
      () => engine.callback({ state: calendar.state, code: 'replay' }),
      (error: unknown) => error instanceof ConnectorOAuthEngineError
        && error.message === 'connector_oauth_state_unknown',
    );

    const gmailDisabled = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK, repository, keyring,
      env: { ...env, NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GMAIL: '0' },
      exchange: async () => { throw new Error('disabled service reached provider'); },
      verifyIdentity: async () => ({ subject: 'google-user-1' }),
    });
    await assert.rejects(() => gmailDisabled.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'gmail',
    }), /connector_oauth_grant_ineligible:policy_disabled/u);

    let fallbackVerifierCalls = 0;
    const noIdTokenEngine = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK, repository, keyring, env,
      exchange: async () => ({ access_token: 'access-with-sub-only', sub: 'google-user-1' }),
      verifyIdentity: async () => { fallbackVerifierCalls += 1; return { subject: 'google-user-1' }; },
    });
    const noIdToken = await noIdTokenEngine.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'gmail',
    });
    await assert.rejects(
      () => noIdTokenEngine.callback({ state: noIdToken.state, code: 'sub-is-not-an-id-token' }),
      /connector_oauth_id_token_required/u,
    );
    assert.equal(fallbackVerifierCalls, 0);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_oauth_grant_services WHERE grant_id = ?',
    ).get(first.grantId) as { count: number }).count, 1);

    const requestsBeforeUnlinkedRefresh = requests.length;
    await assert.rejects(
      () => engine.refresh(USER_ID, 'gmail'),
      /connector_oauth_grant_missing/u,
    );
    assert.equal(requests.length, requestsBeforeUnlinkedRefresh);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_oauth_grant_services WHERE grant_id = ?',
    ).get(first.grantId) as { count: number }).count, 1, 'refresh cannot create a new service mapping');

    const drive = await engine.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'google-drive',
      connectorId: 'calendar-work', grantId: first.grantId,
    });
    const scope = new URL(drive.authorizeUrl).searchParams.get('scope') ?? '';
    assert.match(scope, /calendar/u);
    assert.match(scope, /drive/u);
    const second = await engine.callback({ state: drive.state, code: 'code-two' });
    assert.equal(second.grantId, first.grantId, 'Workspace services share one account grant');
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_user_grants WHERE user_id = ?',
    ).get(USER_ID) as { count: number }).count, 1);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_oauth_grant_services WHERE grant_id = ?',
    ).get(first.grantId) as { count: number }).count, 2);
    const grantDtos = createConnectorUserGrantService({
      installationId, repository, keyring, env,
      testApiKeyCandidate: async () => { throw new Error('not used for OAuth list'); },
    }).list(USER_ID, 'google-drive');
    assert.equal(grantDtos.length, 1, 'secondary OAuth service resolves through the public list contract');
    assert.equal(grantDtos[0]!.grantId, first.grantId);
    assert.equal(grantDtos[0]!.eligible, true);
    assert.equal(grantDtos[0]!.reasonCode, 'placement_pending');
    assert.equal(grantDtos[0]!.canReconnect, true);
    assert.deepEqual(grantDtos[0]!.grantedServices, ['google-calendar', 'google-drive']);
    const oauthOff = createConnectorUserGrantService({
      installationId, repository, keyring, env: { ...env, NASSAJ_CONNECTOR_OAUTH_V2: '0' },
      testApiKeyCandidate: async () => { throw new Error('not used for OAuth list'); },
    }).list(USER_ID, 'google-drive');
    assert.equal(oauthOff[0]!.canReconnect, false);

    verifiedSubject = 'different-google-user';
    const gmail = await engine.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'gmail',
      connectorId: 'calendar-work', grantId: first.grantId,
    });
    await assert.rejects(
      () => engine.callback({ state: gmail.state, code: 'account-swap' }),
      /connector_oauth_account_swap/u,
    );
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_oauth_grant_services WHERE grant_id = ?',
    ).get(first.grantId) as { count: number }).count, 2);
    verifiedSubject = 'google-user-1';

    const beforeRefresh = database.prepare(
      'SELECT secret_ref FROM connector_user_grants WHERE grant_id = ?',
    ).get(first.grantId) as { secret_ref: string };
    const vaultCountBeforeStaleRefresh = (database.prepare(
      'SELECT count(*) AS count FROM connector_vault_secrets',
    ).get() as { count: number }).count;
    const staleRefreshEngine = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK,
      repository: { ...repository, promoteOAuthGrant: () => false }, keyring, env,
      exchange: async () => ({ access_token: 'must-be-discarded', refresh_token: 'also-discarded' }),
      verifyIdentity: async () => ({ subject: 'unused' }),
    });
    await assert.rejects(
      () => staleRefreshEngine.refresh(USER_ID, 'google-drive'),
      /connector_oauth_grant_stale/u,
    );
    assert.equal((database.prepare(
      'SELECT secret_ref FROM connector_user_grants WHERE grant_id = ?',
    ).get(first.grantId) as { secret_ref: string }).secret_ref, beforeRefresh.secret_ref);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_vault_secrets',
    ).get() as { count: number }).count, vaultCountBeforeStaleRefresh);
    await engine.refresh(USER_ID, 'google-drive');
    const afterRefresh = database.prepare(
      'SELECT secret_ref FROM connector_user_grants WHERE grant_id = ?',
    ).get(first.grantId) as { secret_ref: string };
    assert.notEqual(afterRefresh.secret_ref, beforeRefresh.secret_ref);
    assert.equal(database.prepare(
      'SELECT 1 FROM connector_vault_secrets WHERE secret_ref = ?',
    ).get(beforeRefresh.secret_ref), undefined, 'rotated secret is deleted atomically');
    assert.match(requests.at(-1) ?? '', /refresh_token=refresh-1/u);

    const encrypted = database.prepare(
      'SELECT ciphertext FROM connector_vault_secrets WHERE secret_ref = ?',
    ).get(afterRefresh.secret_ref) as { ciphertext: Buffer };
    const callsBeforeCorruption = requests.length;
    database.prepare(
      'UPDATE connector_vault_secrets SET ciphertext = ? WHERE secret_ref = ?',
    ).run(Buffer.from('corrupt'), afterRefresh.secret_ref);
    await assert.rejects(() => engine.refresh(USER_ID, 'google-drive'));
    assert.equal(requests.length, callsBeforeCorruption, 'corrupt V2 never falls through to provider traffic');
    database.prepare(
      'UPDATE connector_vault_secrets SET ciphertext = ? WHERE secret_ref = ?',
    ).run(encrypted.ciphertext, afterRefresh.secret_ref);

    verifiedSubject = 'google-user-2';
    const personalStart = await engine.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'google-calendar',
      connectorId: 'calendar-personal', accountLabel: 'Personal',
    });
    const personal = await engine.callback({ state: personalStart.state, code: 'code-personal' });
    assert.notEqual(personal.grantId, first.grantId, 'an unbound connector creates a new account grant');
    assert.equal(repository.bindOAuthConnectorGrant({
      connectorId: 'calendar-personal', installationId, userId: USER_ID,
      serviceId: 'google-calendar', grantId: personal.grantId,
    }), true);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_user_grants WHERE user_id = ? AND provider_id = ?',
    ).get(USER_ID, 'google-workspace') as { count: number }).count, 2);
    assert.deepEqual(repository.readOAuthConnectorGrantBinding(
      'calendar-work', installationId, USER_ID, 'google-calendar',
    ), { grantId: first.grantId });
    assert.deepEqual(repository.readOAuthConnectorGrantBinding(
      'calendar-personal', installationId, USER_ID, 'google-calendar',
    ), { grantId: personal.grantId });
    const workSecretBeforePersonalRefresh = (database.prepare(
      'SELECT secret_ref FROM connector_user_grants WHERE grant_id = ?',
    ).get(first.grantId) as { secret_ref: string }).secret_ref;
    const personalSecretBeforeRefresh = (database.prepare(
      'SELECT secret_ref FROM connector_user_grants WHERE grant_id = ?',
    ).get(personal.grantId) as { secret_ref: string }).secret_ref;
    await engine.refresh(USER_ID, 'google-calendar', personal.grantId);
    assert.equal((database.prepare(
      'SELECT secret_ref FROM connector_user_grants WHERE grant_id = ?',
    ).get(first.grantId) as { secret_ref: string }).secret_ref, workSecretBeforePersonalRefresh);
    assert.notEqual((database.prepare(
      'SELECT secret_ref FROM connector_user_grants WHERE grant_id = ?',
    ).get(personal.grantId) as { secret_ref: string }).secret_ref, personalSecretBeforeRefresh);

    const result = await engine.revoke(USER_ID, 'google-calendar', first.grantId);
    assert.equal(result.revoked, true);
    assert.equal(revokeAttempts, 1, 'remote failure cannot block authoritative local revocation');
    assert.equal(database.prepare(
      'SELECT 1 FROM connector_vault_secrets WHERE secret_ref = ?',
    ).get(afterRefresh.secret_ref), undefined);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_oauth_grant_services WHERE grant_id = ?',
    ).get(first.grantId) as { count: number }).count, 0);
  } finally {
    database.close();
  }
});

test('callback rejects a rotated profile generation before token exchange', async () => {
  const { database, repository, installationId, profileId } = fixture();
  let exchanges = 0;
  try {
    const engine = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK, repository, keyring, env,
      exchange: async () => { exchanges += 1; return {}; },
      verifyIdentity: async () => ({ subject: 'unused' }),
    });
    const started = await engine.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'google-drive',
    });
    database.prepare(
      'UPDATE connector_auth_profiles SET version = version + 1 WHERE profile_id = ?',
    ).run(profileId);
    await assert.rejects(
      () => engine.callback({ state: started.state, code: 'must-not-exchange' }),
      /connector_oauth_profile_generation_changed/u,
    );
    assert.equal(exchanges, 0);
  } finally { database.close(); }
});

test('promotion fence rejects profile rotation that lands during token exchange', async () => {
  const { database, repository, installationId, profileId } = fixture();
  let exchanges = 0;
  try {
    const beforeVault = (database.prepare(
      'SELECT count(*) AS count FROM connector_vault_secrets',
    ).get() as { count: number }).count;
    const engine = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK, repository, keyring, env,
      exchange: async () => {
        exchanges += 1;
        database.prepare(
          'UPDATE connector_auth_profiles SET version = version + 1 WHERE profile_id = ?',
        ).run(profileId);
        return {
          access_token: 'must-not-commit', refresh_token: 'must-not-commit', id_token: 'id-token',
        };
      },
      verifyIdentity: async () => ({ subject: 'google-user-raced' }),
    });
    const started = await engine.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'google-drive',
    });
    await assert.rejects(
      () => engine.callback({ state: started.state, code: 'rotate-during-exchange' }),
      /connector_oauth_profile_generation_changed/u,
    );
    assert.equal(exchanges, 1);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_user_grants',
    ).get() as { count: number }).count, 0);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_vault_secrets',
    ).get() as { count: number }).count, beforeVault);
  } finally { database.close(); }
});

test('failed grant promotion cleans both a new pending grant and its staged secret', async () => {
  const { database, repository, installationId } = fixture();
  try {
    const failingRepository = { ...repository, promoteOAuthGrant: () => false };
    const engine = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK, repository: failingRepository, keyring, env,
      exchange: async () => ({
        access_token: 'access', refresh_token: 'refresh', id_token: 'id-token', expires_in: 3600,
      }),
      verifyIdentity: async () => ({ subject: 'google-user-cleanup' }),
    });
    const beforeVault = (database.prepare(
      'SELECT count(*) AS count FROM connector_vault_secrets',
    ).get() as { count: number }).count;
    const started = await engine.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'google-drive',
    });
    await assert.rejects(
      () => engine.callback({ state: started.state, code: 'stale-write' }),
      /connector_oauth_grant_stale/u,
    );
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_user_grants',
    ).get() as { count: number }).count, 0);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_vault_secrets',
    ).get() as { count: number }).count, beforeVault);
  } finally { database.close(); }
});

test('feature flags and corrupt V2 material fail closed before provider traffic', async () => {
  const { database, repository, installationId, profileId } = fixture();
  let calls = 0;
  try {
    const disabled = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK, repository, keyring, env: {},
      exchange: async () => { calls += 1; return {}; },
      verifyIdentity: async () => ({ subject: 'unused' }),
    });
    await assert.rejects(() => disabled.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'google-drive',
    }), /connector_oauth_provider_disabled/u);

    database.prepare(`DELETE FROM connector_auth_profile_secret_bindings
      WHERE profile_id = ? AND field_purpose = 'client_id'`).run(profileId);
    const enabled = createConnectorOAuthEngine({
      installationId, callbackUrl: CALLBACK, repository, keyring, env,
      exchange: async () => { calls += 1; return {}; },
      verifyIdentity: async () => ({ subject: 'unused' }),
    });
    await assert.rejects(() => enabled.start({
      userId: USER_ID, sessionId: randomUUID(), serviceId: 'google-drive',
    }), /connector_oauth_profile_corrupt/u);
    assert.equal(calls, 0);
    assert.equal((database.prepare(
      'SELECT count(*) AS count FROM connector_oauth_transactions',
    ).get() as { count: number }).count, 0);
  } finally {
    database.close();
  }
});
