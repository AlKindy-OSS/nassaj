/**
 * ADR-194 D8 (T-1962 S4): the owner SSO settings API surface — role matrix,
 * cookie mutation guard, rate limits, no-store, the write-only secret, draft
 * versioning, private-network step-up (I5), test-discovery pins (I4), the
 * test sign-in start/result, import-env and the installation origin.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { setSsoNetworkOverridesForTests } from '../services/sso-oidc-runtime.service.js';

import {
  admin, api, baseUrl, db, draftBody, member, op, ORIGIN, owner, resetSsoFixture, runTestSignIn, STEP_UP,
} from './__tests__/settings-sso-harness.js';

const ROUTES: Array<[string, string]> = [
  ['GET', '/'], ['PUT', '/draft'], ['POST', '/draft/test-discovery'], ['POST', '/draft/test-login/start'],
  ['GET', `/draft/test-login/result/${'A'.repeat(43)}`], ['POST', '/apply'], ['POST', '/enable'],
  ['POST', '/disable'], ['POST', '/import-env'], ['PUT', '/installation-origin'],
];

beforeEach(() => resetSsoFixture());

const draftRow = () => db.prepare("SELECT * FROM sso_oidc_config WHERE slot = 'draft'").get() as
  Record<string, unknown> | undefined;
const proofs = () => db.prepare('SELECT kind, passed, config_hash, draft_version FROM sso_apply_proofs ORDER BY id')
  .all() as Array<{ kind: string; passed: number; config_hash: string; draft_version: number }>;

test('every route is owner-only: admin and member get 403 and nothing is written', async () => {
  for (const userId of [admin.id, member.id]) {
    for (const [method, route] of ROUTES) {
      const res = await api(method, route, method === 'GET' ? undefined : draftBody(), { userId });
      assert.equal(res.status, 403, `${method} ${route} as ${userId}`);
    }
  }
  assert.equal(draftRow(), undefined);
  const owned = await api('GET', '/');
  assert.equal(owned.status, 200);
  assert.equal(owned.headers.get('cache-control'), 'no-store');
  assert.equal(owned.body.ssoState, 'off');
});

test('cookie identities need the mutation guard on every write; reads pass', async () => {
  const device = { 'x-test-device': '1' };
  for (const [method, route] of ROUTES.filter(([verb]) => verb !== 'GET')) {
    const res = await api(method, route, draftBody(), { headers: device });
    assert.equal(res.status, 403, `${method} ${route}`);
    assert.equal(res.body.code, 'csrf_or_origin_rejected');
  }
  assert.equal((await api('GET', '/', undefined, { headers: device })).status, 200);
  assert.equal(draftRow(), undefined);
});

test('writes are rate limited per owner (10 per minute)', async () => {
  for (let index = 0; index < 10; index += 1) assert.equal((await api('PUT', '/draft', draftBody())).status, 200);
  const limited = await api('PUT', '/draft', draftBody());
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'rate_limited');
  assert.ok(limited.headers.get('retry-after'));
});

test('the client secret is write-only: never in responses, the row view or audit metadata', async () => {
  const secret = 'super-secret-client-value-42';
  const saved = await api('PUT', '/draft', draftBody({ clientAuth: 'client_secret_basic', clientSecret: secret }));
  assert.equal(saved.status, 200);
  const draft = saved.body.draft as Record<string, unknown>;
  assert.equal(draft.hasClientSecret, true);
  assert.equal(draft.secretVersion, 1);
  const status = await api('GET', '/');
  for (const text of [saved.text, status.text]) {
    assert.ok(!text.includes(secret), 'plaintext never returned');
    assert.ok(!text.includes('ssooidc:'), 'ciphertext never returned');
  }
  const audits = db.prepare('SELECT metadata FROM audit_log').all() as Array<{ metadata: string | null }>;
  assert.ok(audits.every((row) => !String(row.metadata).includes(secret)));

  const kept = await api('PUT', '/draft', draftBody({ clientAuth: 'client_secret_basic', attestationMaxAgeHours: 6 }));
  assert.equal((kept.body.draft as Record<string, unknown>).hasClientSecret, true, 'omitted keeps it');
  assert.equal((kept.body.draft as Record<string, unknown>).secretVersion, 1);
  const moved = await api('PUT', '/draft', draftBody({ clientAuth: 'client_secret_basic', clientId: 'other-client' }));
  const movedDraft = moved.body.draft as Record<string, unknown>;
  assert.equal(movedDraft.hasClientSecret, false, 'a new client id invalidates the old secret');
  assert.equal(movedDraft.secretVersion, 2);
  assert.deepEqual(movedDraft.missing, ['client_secret', 'pinned_endpoints']);
  const bad = await api('PUT', '/draft', draftBody({ clientSecret: secret }));
  assert.equal(bad.status, 400, 'a public client takes no secret');
  assert.equal(bad.body.field, 'clientSecret');
});

test('PUT /draft validates every supplied field and accepts an incomplete mapping', async () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ issuer: 'http://idp.example' }, 'sso_draft_invalid', 'issuer'],
    [{ extraScopes: 'openid' }, 'sso_draft_invalid', 'extraScopes'],
    [{ attestationMaxAgeHours: 25 }, 'sso_draft_invalid', 'attestationMaxAgeHours'],
    [{ issuerPort: 8443 }, 'sso_draft_invalid', 'issuerPort'],
    [{ roleClaimPath: 'name' }, 'sso_mapping_invalid', ''],
    [{ tenantMode: 'none', tenantClaimPath: null, tenantValues: [], jitEnabled: true }, 'sso_mapping_invalid', ''],
  ];
  for (const [overrides, code, field] of cases) {
    const res = await api('PUT', '/draft', draftBody(overrides));
    assert.equal(res.status, 400, JSON.stringify(overrides));
    assert.equal(res.body.code, code);
    if (field) assert.equal(res.body.field, field);
  }
  assert.equal(draftRow(), undefined);
  const partial = await api('PUT', '/draft', draftBody({ roleClaimPath: '', roleRules: [] }));
  assert.equal(partial.status, 200);
  assert.deepEqual((partial.body.draft as { missing: string[] }).missing,
    ['role_claim_path', 'role_rules', 'pinned_endpoints']);
  assert.equal((partial.body.draft as { redirectUri: string }).redirectUri, `${ORIGIN}/api/auth/oidc/callback`);
});

test('every draft write bumps draft_version, honours expectedDraftVersion and invalidates a started test', async () => {
  await api('PUT', '/draft', draftBody());
  assert.equal((await api('POST', '/draft/test-discovery')).body.passed, true);
  const version = Number(draftRow()?.draft_version);
  const started = await api('POST', '/draft/test-login/start');
  assert.equal(started.status, 200);
  assert.equal(started.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(started.headers.get('cache-control'), 'no-store');
  const stale = await api('PUT', '/draft', draftBody({ expectedDraftVersion: version - 1 }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'sso_draft_changed');
  const saved = await api('PUT', '/draft', draftBody({ expectedDraftVersion: version }));
  assert.equal((saved.body.draft as { draftVersion: number }).draftVersion, version + 1);
  assert.equal((saved.body.draft as { pinnedEndpoints: unknown }).pinnedEndpoints, null, 'a save clears the pins');

  const cookie = (started.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  const { code, state } = op.authorize(String(started.body.authorizationUrl), { sub: 'o', roles: ['member'], org: 'org-1' });
  const back = await runCallback(state, code, cookie);
  const id = back.searchParams.get('ssoTest') ?? '';
  const result = await api('GET', `/draft/test-login/result/${id}`);
  assert.deepEqual((result.body.result as { diagnostics: string[] }).diagnostics, ['sso_test_config_changed']);
});

async function runCallback(state: string, code: string, cookie: string) {
  const res = await fetch(`${baseUrl}/api/auth/oidc/callback?${new URLSearchParams({ state, code })}`,
    { headers: { cookie }, redirect: 'manual' });
  return new URL(res.headers.get('location') ?? '', ORIGIN);
}

test('I5: private network or an issuer port change needs sso_config step-up (local evidence only)', async () => {
  await api('PUT', '/draft', draftBody());
  const privateBody = draftBody({ allowPrivateNetwork: true });
  const missing = await api('PUT', '/draft', privateBody);
  assert.equal(missing.status, 403);
  assert.equal(missing.body.code, 'step_up_required');
  const wrong = await api('PUT', '/draft', { ...privateBody, stepUp: { method: 'password', password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'step_up_failed');
  const grant = await api('PUT', '/draft', { ...privateBody, stepUp: { method: 'oidc_grant', grant: 'g' } });
  assert.equal(grant.status, 400, 'an SSO grant never authorizes SSO configuration');
  assert.equal(grant.body.code, 'step_up_invalid_request');
  assert.equal(draftRow()?.allow_private_network, 0);

  assert.equal((await api('PUT', '/draft', { ...privateBody, stepUp: STEP_UP })).status, 200);
  assert.equal(draftRow()?.allow_private_network, 1);
  assert.equal((await api('PUT', '/draft', draftBody({ allowPrivateNetwork: true, extraScopes: 'groups' }))).status, 200,
    'keeping private reach needs no new step-up');
  const port = await api('PUT', '/draft', draftBody({ allowPrivateNetwork: true, issuerPort: 8443 }));
  assert.equal(port.status, 403, 'setting a port needs step-up');
  assert.equal((await api('PUT', '/draft', { ...draftBody({ allowPrivateNetwork: true, issuerPort: 8443 }),
    stepUp: STEP_UP })).status, 200);
  const cleared = await api('PUT', '/draft', draftBody({ allowPrivateNetwork: true, issuerPort: null }));
  assert.equal(cleared.status, 403, 'clearing the port is a change too');
  assert.equal(draftRow()?.issuer_port, 8443);
});

test('sso_config step-up refuses an owner who must change the password', async () => {
  await api('PUT', '/draft', draftBody());
  db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(owner.id);
  const res = await api('PUT', '/draft', { ...draftBody({ allowPrivateNetwork: true }), stepUp: STEP_UP });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'password_change_required');
});

test('I4: test-discovery pins endpoints and flags, bumps draft_version and records a proof', async () => {
  const before = await api('POST', '/draft/test-discovery');
  assert.equal(before.status, 404);
  assert.equal(before.body.code, 'sso_draft_missing');
  await api('PUT', '/draft', draftBody());
  const version = Number(draftRow()?.draft_version);
  const res = await api('POST', '/draft/test-discovery');
  assert.equal(res.status, 200);
  assert.equal(res.body.passed, true);
  assert.equal(res.body.jwksKeyCount, 1);
  assert.deepEqual(res.body.endpoints, {
    authorization_endpoint: `${op.issuer}/authorize`, token_endpoint: `${op.issuer}/token`, jwks_uri: `${op.issuer}/jwks`,
  });
  const draft = res.body.draft as { draftVersion: number; configHash: string; pinnedEndpoints: unknown;
    discoveryFlags: Record<string, unknown>; missing: string[] };
  assert.equal(draft.draftVersion, version + 1);
  assert.deepEqual(draft.pinnedEndpoints, res.body.endpoints);
  assert.equal(draft.discoveryFlags.backchannel_logout_supported, false);
  assert.deepEqual(draft.missing, []);
  assert.deepEqual(proofs(), [{ kind: 'discovery', passed: 1, config_hash: draft.configHash, draft_version: version + 1 }]);
});

test('a failing discovery writes no pins, a failed proof and a fixed code only', async () => {
  await api('PUT', '/draft', draftBody());
  op.discoveryOverrides.issuer = 'https://elsewhere.example';
  const res = await api('POST', '/draft/test-discovery');
  assert.equal(res.body.passed, false);
  assert.equal(res.body.failure, 'discovery_issuer_mismatch');
  assert.equal(draftRow()?.pinned_endpoints_json, null);
  assert.deepEqual(proofs().map((row) => [row.kind, row.passed]), [['discovery', 0]]);
  assert.ok(!res.text.includes('elsewhere'), 'the discovery body is never echoed');
});

test('test sign-in start needs pins; the display result is one-time', async () => {
  await api('PUT', '/draft', draftBody());
  const early = await api('POST', '/draft/test-login/start');
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'sso_test_discovery_required');
  await api('POST', '/draft/test-discovery');
  const { location } = await runTestSignIn();
  assert.equal(location?.pathname, '/');
  assert.equal(location?.searchParams.get('settings'), 'sso');
  const id = location?.searchParams.get('ssoTest') ?? '';
  const result = await api('GET', `/draft/test-login/result/${id}`);
  assert.equal(result.status, 200);
  assert.equal((result.body.result as { mappedRole: string }).mappedRole, 'user');
  const again = await api('GET', `/draft/test-login/result/${id}`);
  assert.equal(again.status, 404);
  assert.equal(again.body.code, 'sso_test_result_not_found');
});

test('import-env pre-fills the draft from legacy env and is refused once an active row exists', async () => {
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ISSUER_URL = op.issuer;
  process.env.OIDC_CLIENT_ID = op.clientId;
  process.env.OIDC_ALLOWED_ORG_IDS = 'org-a,org-b';
  process.env.OIDC_REDIRECT_URI = 'https://old.example/api/auth/oidc/callback';
  assert.equal((await api('GET', '/')).body.ssoState, 'paused');
  const res = await api('POST', '/import-env');
  assert.equal(res.status, 200);
  const draft = res.body.draft as Record<string, unknown>;
  assert.equal(draft.issuer, op.issuer);
  assert.equal(draft.tenantMode, 'role_grant_scope');
  assert.deepEqual(draft.tenantValues, ['org-a', 'org-b']);
  assert.equal(draft.allowPrivateNetwork, false);
  assert.deepEqual((res.body.warnings as Array<{ code: string }>).map((warning) => warning.code), ['redirect_uri_mismatch']);
  db.prepare("INSERT INTO sso_oidc_config (slot, issuer, client_id, client_auth, role_claim_path, role_rules_json, tenant_mode, config_hash) VALUES ('active','https://x.example','c','none','roles','[]','none','h')").run();
  const refused = await api('POST', '/import-env');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'sso_active_config_exists');
});

test('the installation origin write path needs step-up and the ADR-193 validator', async () => {
  const missing = await api('PUT', '/installation-origin', { origin: 'https://new.example' });
  assert.equal(missing.status, 403);
  assert.equal(missing.body.code, 'step_up_required');
  const invalid = await api('PUT', '/installation-origin', { origin: 'https://new.example/path', stepUp: STEP_UP });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'installation_origin_invalid');
  const ok = await api('PUT', '/installation-origin', { origin: 'https://new.example', stepUp: STEP_UP });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.origin, 'https://new.example');
  const status = await api('GET', '/');
  assert.equal((status.body.ourValues as { redirectUri: string }).redirectUri,
    'https://new.example/api/auth/oidc/callback');
  assert.equal((status.body.ourValues as { backchannelLogoutUri: string }).backchannelLogoutUri,
    'https://new.example/api/auth/oidc/backchannel-logout');
});

/** Routes the mock provider through `resolver` (and optionally a wrapped transport). */
function routeProvider(resolver: () => Promise<Array<{ address: string; family: 4 | 6 }>>,
  transport = op.network.dependencies.transport) {
  setSsoNetworkOverridesForTests({ dependencies: { ...op.network.dependencies, resolver, transport } });
}

test('test-discovery reports the typed fetch code; a private address offers the private-network option', async () => {
  await api('PUT', '/draft', draftBody());
  routeProvider(async () => [{ address: '10.0.0.5', family: 4 }]);
  const privateAddress = await api('POST', '/draft/test-discovery');
  assert.deepEqual([privateAddress.body.passed, privateAddress.body.failure, privateAddress.body.failureStage,
    privateAddress.body.addressCategory, privateAddress.body.privateNetworkMayHelp],
  [false, 'fetch_address_private', 'discovery_unavailable', 'private', true]);

  routeProvider(async () => [{ address: '100.100.100.100', family: 4 }]);
  const resolverAddress = await api('POST', '/draft/test-discovery');
  assert.deepEqual([resolverAddress.body.failure, resolverAddress.body.addressCategory,
    resolverAddress.body.privateNetworkMayHelp], ['fetch_address_blocked', 'tailnet_resolver', false]);

  routeProvider(async () => [{ address: '127.0.0.1', family: 4 }]);
  assert.equal((await api('POST', '/draft/test-discovery')).body.addressCategory, 'loopback');
  routeProvider(async () => { throw new Error('nxdomain'); });
  assert.equal((await api('POST', '/draft/test-discovery')).body.failure, 'fetch_dns_failed');
  const audit = db.prepare("SELECT metadata FROM audit_log WHERE action = 'sso_discovery_tested' ORDER BY id DESC")
    .get() as { metadata: string };
  assert.deepEqual(JSON.parse(audit.metadata).failure, 'fetch_dns_failed');
  assert.equal(draftRow()?.pinned_endpoints_json, null);
});

test('with private networks allowed, CGNAT passes, other ports are refused and stages are named', async () => {
  await api('PUT', '/draft', { ...draftBody({ allowPrivateNetwork: true }), stepUp: STEP_UP });
  routeProvider(async () => [{ address: '100.80.1.2', family: 4 }]);
  assert.equal((await api('POST', '/draft/test-discovery')).body.passed, true, 'CGNAT under private_allowed');

  const portIssuer = 'https://idp.example:8443';
  // Moving the issuer to another origin under private reach needs step-up (S9 M2).
  await api('PUT', '/draft', { ...draftBody({ issuer: portIssuer, allowPrivateNetwork: true }), stepUp: STEP_UP });
  const port = await api('POST', '/draft/test-discovery');
  assert.deepEqual([port.body.failure, port.body.privateNetworkMayHelp], ['fetch_port_blocked', false]);

  await api('PUT', '/draft', { ...draftBody({ allowPrivateNetwork: true }), stepUp: STEP_UP });
  const base = op.network.dependencies.transport;
  routeProvider(async () => [{ address: '10.1.2.3', family: 4 }], async (input) => (
    input.url.pathname === '/jwks'
      ? { status: 503, headers: { 'content-type': 'text/html' }, body: (async function* b() { yield Buffer.from('<h1>down</h1>'); })() }
      : base(input)));
  const jwks = await api('POST', '/draft/test-discovery');
  assert.deepEqual([jwks.body.failure, jwks.body.failureStage], ['fetch_http_5xx', 'jwks_unavailable']);
  assert.ok(!jwks.text.includes('down'), 'never a body');
});

test('S9 M2: with private reach on, moving the issuer to another origin needs step-up', async () => {
  await api('PUT', '/draft', { ...draftBody({ allowPrivateNetwork: true }), stepUp: STEP_UP });
  const moved = draftBody({ allowPrivateNetwork: true, issuer: 'https://idp-other.example' });
  const refused = await api('PUT', '/draft', moved);
  assert.deepEqual([refused.status, refused.body.code], [403, 'step_up_required']);
  assert.equal(draftRow()?.issuer, op.issuer, 'nothing written');
  const samePath = await api('PUT', '/draft', draftBody({ allowPrivateNetwork: true, issuer: `${op.issuer}/realm` }));
  assert.equal(samePath.status, 200, 'same origin, new path: no step-up');
  const turnedOff = await api('PUT', '/draft', draftBody({ allowPrivateNetwork: false, issuer: 'https://idp-other.example' }));
  assert.equal(turnedOff.status, 403, 'private reach still on in the stored draft');
  assert.equal((await api('PUT', '/draft', { ...moved, stepUp: STEP_UP })).status, 200);
  assert.equal(draftRow()?.issuer, 'https://idp-other.example');
  await api('PUT', '/draft', { ...draftBody(), stepUp: STEP_UP });
  assert.equal((await api('PUT', '/draft', draftBody({ issuer: 'https://idp-third.example' }))).status, 200,
    'public reach: an origin change needs no step-up (apply has its own)');
});
