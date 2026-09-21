/**
 * connector-oauth-flow tests.
 *
 * These assert the two things that silently break a link and are invisible until
 * a member complains: the FILE NAMES `mcp-remote` looks for, and the refusal to
 * accept a callback nassaj did not start. The network legs (discovery,
 * registration, token exchange) are exercised against the real platform by
 * scripts/connector-oauth-check.mjs rather than mocked here — a mocked OAuth
 * server proves only that the mock agrees with itself (fleet lesson: synthetic
 * fixtures, 2026-06-28).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';

import { getConnection, migrateConnectorOAuthPending } from '@/modules/database/index.js';

import {
  beginLink,
  completeLink,
  grantFilePath,
  pendingLinkCount,
  remoteUrlFromArgs,
} from './connector-oauth-flow.js';
import { markGrantRevocationPending } from './grant-file.js';

/** A member id no real install has, so the tree can be removed wholesale. */
const TEST_USER = 987654321;
const TEST_TREE = path.join(os.homedir(), '.nassaj-users', String(TEST_USER));
const TEST_SOURCE_GATE = {
  get: (id: string) => ({
    id,
    credentialMode: 'per_member' as const,
    ownerUserId: TEST_USER,
    sourceRevision: 0,
  }),
  beginSourceMutation: () => 1,
  finishSourceMutation: () => 2,
};

before(() => {
  migrateConnectorOAuthPending(getConnection());
});

after(() => {
  fs.rmSync(TEST_TREE, { recursive: true, force: true });
});

describe('remoteUrlFromArgs', () => {
  it('reads the endpoint out of the stored launch command', () => {
    assert.equal(
      remoteUrlFromArgs(['-y', 'mcp-remote', 'https://mcp.canva.com/mcp']),
      'https://mcp.canva.com/mcp',
    );
  });

  it('returns null when the command names no endpoint', () => {
    assert.equal(remoteUrlFromArgs(['-y', '@notionhq/notion-mcp-server']), null);
    assert.equal(remoteUrlFromArgs(undefined), null);
  });
});

describe('completeLink', () => {
  it('refuses a callback nassaj never started', async () => {
    await assert.rejects(
      () => completeLink({ state: 'not-a-state-we-minted', code: 'whatever' }),
      /expired or was already used/,
    );
    assert.equal(pendingLinkCount(), 0);
  });

  it('fails closed when a crashed start left the connector source odd', async () => {
    const prefix = 'NASSAJ_TEST_ODD_CALLBACK';
    const connectorId = 'odd-callback';
    process.env[`${prefix}_CLIENT_ID`] = 'odd-client';
    process.env[`${prefix}_CLIENT_SECRET`] = 'odd-secret';
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(
      JSON.stringify({ access_token: 'must-not-persist', refresh_token: 'must-not-persist' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    try {
      const started = await beginLink({
        userId: TEST_USER,
        connectorId,
        remoteUrl: 'https://odd.example.test/mcp',
        redirectUri: 'https://nassaj.test/connectors/oauth/callback',
        configuredClient: {
          authorizeUrl: 'https://odd.example.test/authorize',
          tokenUrl: 'https://odd.example.test/token',
          scopes: ['read'],
          clientEnvPrefix: prefix,
        },
        builtIn: true,
      });
      await assert.rejects(
        () => completeLink({
          state: started.state,
          code: 'odd-code',
          sourceGate: {
            get: (id: string) => ({
              id, credentialMode: 'per_member', ownerUserId: TEST_USER, sourceRevision: 1,
            }),
            beginSourceMutation: () => { throw new Error('must not begin'); },
            finishSourceMutation: () => { throw new Error('must not finish'); },
          },
        }),
        /source is being changed/,
      );
      assert.equal(fs.existsSync(grantFilePath(TEST_USER, connectorId)), false);
    } finally {
      fetchMock.mock.restore();
      delete process.env[`${prefix}_CLIENT_ID`];
      delete process.env[`${prefix}_CLIENT_SECRET`];
    }
  });

  it('holds an exchange lease across fetch so revocation intent wins before grant write', async () => {
    const prefix = 'NASSAJ_TEST_EXCHANGE_LEASE';
    process.env[`${prefix}_CLIENT_ID`] = 'exchange-client';
    process.env[`${prefix}_CLIENT_SECRET`] = 'exchange-secret';
    const connectorId = 'exchange-lease-test';
    let markFetchStarted = () => {};
    let resumeFetch = () => {};
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetchPaused = new Promise<void>((resolve) => { resumeFetch = resolve; });
    let fetchCalls = 0;
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1;
      markFetchStarted();
      await fetchPaused;
      return new Response(JSON.stringify({
        access_token: 'must-not-persist',
        refresh_token: 'must-not-persist-refresh',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    try {
      const started = await beginLink({
        userId: TEST_USER,
        connectorId,
        remoteUrl: 'https://exchange.example.test/mcp',
        redirectUri: 'https://nassaj.test/connectors/oauth/callback',
        configuredClient: {
          authorizeUrl: 'https://exchange.example.test/authorize',
          tokenUrl: 'https://exchange.example.test/token',
          scopes: ['read'],
          clientEnvPrefix: prefix,
        },
        builtIn: true,
      });
      const file = grantFilePath(TEST_USER, connectorId);
      const completing = completeLink({
        state: started.state, code: 'paused-code', sourceGate: TEST_SOURCE_GATE,
      });
      await fetchStarted;
      const marking = markGrantRevocationPending(file, { drainMs: 1_000 });
      for (let attempt = 0; attempt < 100
        && !fs.existsSync(`${file}.revocation-pending.json`); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(fs.existsSync(`${file}.revocation-pending.json`), true);
      resumeFetch();
      await assert.rejects(() => completing, /pending revocation/);
      assert.deepEqual(await marking, { drained: true });
      assert.equal(fetchCalls, 1, 'the already-leased exchange may finish; no successor may start');
      assert.equal(fs.existsSync(file), false, 'tokens returned after intent are never persisted');
    } finally {
      resumeFetch();
      fetchMock.mock.restore();
      delete process.env[`${prefix}_CLIENT_ID`];
      delete process.env[`${prefix}_CLIENT_SECRET`];
    }
  });

  it('exchanges before begin, and finalizes even when grant promotion fails', async () => {
    const prefix = 'NASSAJ_TEST_PROMOTION_OAUTH';
    const connectorId = 'promotion-failure';
    process.env[`${prefix}_CLIENT_ID`] = 'client';
    process.env[`${prefix}_CLIENT_SECRET`] = 'secret';
    let exchanged = false;
    let markFetchStarted = () => {};
    let resumeFetch = () => {};
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetchPaused = new Promise<void>((resolve) => { resumeFetch = resolve; });
    let revision = 0;
    const events: string[] = [];
    const sourceGate = {
      get: (id: string) => ({
        id, credentialMode: 'per_member' as const, ownerUserId: TEST_USER, sourceRevision: revision,
      }),
      beginSourceMutation: () => {
        assert.equal(exchanged, true, 'network exchange must finish before the source becomes odd');
        events.push('begin');
        revision = 1;
        return revision;
      },
      finishSourceMutation: (_id: string, odd: number) => {
        events.push('finish');
        assert.equal(odd, 1);
        revision = 2;
        return revision;
      },
    };
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      exchanged = true;
      markFetchStarted();
      await fetchPaused;
      return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    let renameMock: ReturnType<typeof mock.method> | null = null;
    try {
      const started = await beginLink({
        userId: TEST_USER,
        connectorId,
        remoteUrl: 'https://promotion.example.test/mcp',
        redirectUri: 'https://nassaj.test/connectors/oauth/callback',
        configuredClient: {
          authorizeUrl: 'https://promotion.example.test/authorize',
          tokenUrl: 'https://promotion.example.test/token',
          scopes: ['read'],
          clientEnvPrefix: prefix,
        },
        builtIn: true,
      });
      const completing = completeLink({ state: started.state, code: 'code', sourceGate });
      await fetchStarted;
      renameMock = mock.method(fs, 'renameSync', () => {
        throw new Error('injected grant promotion failure');
      });
      resumeFetch();
      await assert.rejects(
        () => completing,
        /injected grant promotion failure/,
      );
      assert.deepEqual(events, ['begin', 'finish']);
      assert.equal(revision, 2);
    } finally {
      resumeFetch();
      renameMock?.mock.restore();
      fetchMock.mock.restore();
      delete process.env[`${prefix}_CLIENT_ID`];
      delete process.env[`${prefix}_CLIENT_SECRET`];
    }
  });
});

describe('unmanaged OAuth containment', () => {
  it('refuses every flow that would fall back to a shared mcp-remote store', async () => {
    await assert.rejects(
      () => beginLink({
        userId: TEST_USER,
        connectorId: 'legacy-unmanaged',
        remoteUrl: 'https://mcp.example.test/mcp',
        redirectUri: 'https://nassaj.test/connectors/oauth/callback',
        builtIn: false,
      }),
      (error: unknown) => error instanceof Error && error.message.includes('locked bridge'),
    );
  });
});

describe('Google provider profile', () => {
  it('uses offline incremental consent, omits resource, and does not prompt again with a refresh token', async () => {
    const prefix = 'NASSAJ_TEST_GOOGLE_OAUTH';
    process.env[`${prefix}_CLIENT_ID`] = 'google-client';
    process.env[`${prefix}_CLIENT_SECRET`] = 'google-secret';
    const connectorId = 'google-profile-test';
    const spec = {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['scope.readonly'],
      clientEnvPrefix: prefix,
      registerAppUrl: 'https://console.cloud.google.com/apis/credentials',
      providerProfile: 'google' as const,
    };

    try {
      const first = await beginLink({
        userId: TEST_USER,
        connectorId,
        remoteUrl: 'https://drivemcp.googleapis.com/mcp/v1',
        redirectUri: 'https://nassaj.test/connectors/oauth/callback',
        configuredClient: spec,
        builtIn: true,
      });
      const authorize = new URL(first.authorizeUrl);
      assert.equal(authorize.searchParams.get('access_type'), 'offline');
      assert.equal(authorize.searchParams.get('include_granted_scopes'), 'true');
      assert.equal(authorize.searchParams.get('prompt'), 'consent');
      assert.equal(authorize.searchParams.has('resource'), false);

      const grantPath = grantFilePath(TEST_USER, connectorId);
      fs.mkdirSync(path.dirname(grantPath), { recursive: true, mode: 0o755 });
      fs.writeFileSync(`${grantPath}.refreshing.json`, JSON.stringify({
        id: 'ambiguous-old-refresh',
        fromGeneration: 0,
        createdAt: Date.now(),
      }), { mode: 0o644 });

      let tokenBody = '';
      let tokenAuthorization: string | null = null;
      const fetchMock = mock.method(globalThis, 'fetch', async (_url, init) => {
        tokenBody = String(init?.body ?? '');
        tokenAuthorization = new Headers(init?.headers).get('Authorization');
        return new Response(JSON.stringify({
          access_token: 'access-one',
          refresh_token: 'refresh-one',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      try {
        await completeLink({
          state: first.state, code: 'authorization-code', sourceGate: TEST_SOURCE_GATE,
        });
      } finally {
        fetchMock.mock.restore();
      }
      assert.equal(new URLSearchParams(tokenBody).has('resource'), false);
      assert.equal(tokenAuthorization, null, 'Google uses client_secret_post, not Basic auth');
      assert.equal(fs.existsSync(`${grantPath}.refreshing.json`), false);
      assert.equal(fs.statSync(grantPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(grantPath)).mode & 0o777, 0o700);

      const second = await beginLink({
        userId: TEST_USER,
        connectorId,
        remoteUrl: 'https://drivemcp.googleapis.com/mcp/v1',
        redirectUri: 'https://nassaj.test/connectors/oauth/callback',
        configuredClient: spec,
        builtIn: true,
      });
      assert.equal(new URL(second.authorizeUrl).searchParams.has('prompt'), false);
      assert.equal(
        JSON.parse(fs.readFileSync(grantPath, 'utf8')).refresh_token,
        'refresh-one',
      );
      await markGrantRevocationPending(grantPath);
      await assert.rejects(() => beginLink({
        userId: TEST_USER,
        connectorId,
        remoteUrl: 'https://drivemcp.googleapis.com/mcp/v1',
        redirectUri: 'https://nassaj.test/connectors/oauth/callback',
        configuredClient: spec,
        builtIn: true,
      }), /pending revocation/);
      await assert.rejects(
        () => completeLink({
          state: second.state, code: 'must-not-exchange', sourceGate: TEST_SOURCE_GATE,
        }),
        /pending revocation/,
      );
    } finally {
      delete process.env[`${prefix}_CLIENT_ID`];
      delete process.env[`${prefix}_CLIENT_SECRET`];
    }
  });
});

describe('DCR bridge grant', () => {
  it('stores refresh client identity in locked grant.json instead of seeding mcp-remote', async () => {
    const connectorId = 'dcr-bridge-test';
    const remoteUrl = 'https://mcp.example.test/mcp';
    const fetchMock = mock.method(globalThis, 'fetch', async (url, init) => {
      const href = String(url);
      if (href.endsWith('/.well-known/oauth-protected-resource')) {
        return new Response(JSON.stringify({ authorization_servers: ['https://auth.example.test'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (href.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://auth.example.test/authorize',
          token_endpoint: 'https://auth.example.test/token',
          registration_endpoint: 'https://auth.example.test/register',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (href.endsWith('/register')) {
        return new Response(JSON.stringify({
          client_id: 'dynamic-client',
          redirect_uris: ['https://nassaj.test/connectors/oauth/callback'],
          token_endpoint_auth_method: 'none',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(href, 'https://auth.example.test/token');
      assert.equal(new URLSearchParams(String(init?.body)).get('client_id'), 'dynamic-client');
      return new Response(JSON.stringify({
        access_token: 'dcr-access',
        refresh_token: 'dcr-refresh',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    try {
      const started = await beginLink({
        userId: TEST_USER,
        connectorId,
        remoteUrl,
        redirectUri: 'https://nassaj.test/connectors/oauth/callback',
        builtIn: true,
      });
      await completeLink({ state: started.state, code: 'dcr-code', sourceGate: TEST_SOURCE_GATE });

      const file = grantFilePath(TEST_USER, connectorId);
      const grant = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      assert.equal(grant.client_id, 'dynamic-client');
      assert.equal(grant.token_auth_method, 'none');
      assert.equal(grant.refresh_token, 'dcr-refresh');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(
        fs.readdirSync(path.dirname(file)).some((name) => name.startsWith('mcp-remote-')),
        false,
      );
    } finally {
      fetchMock.mock.restore();
    }
  });
});
