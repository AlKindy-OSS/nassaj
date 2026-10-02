/** ADR-194 D3 legacy env import (T-1962 S1) against a real database. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { readSlotOn } from '@/modules/database/repositories/sso-oidc-config.js';
import { userDb } from '@/modules/database/repositories/users.js';

import { clearSsoConfig, writeSsoRow } from './__tests__/sso-config-fixture.js';
import { computeSsoConfigHash, ssoConfigInvalidReason } from './sso-config-record.js';
import {
  buildDraftFromLegacyEnv, computeRedirectUri, importLegacyEnvToDraft, LEGACY_DEFAULT_ROLE_RULES, SsoImportError,
} from './sso-import-env.service.js';

const ORIGIN = 'https://nassaj.example';
const LEGACY_ENV = {
  OIDC_ENABLED: 'true',
  OIDC_ISSUER_URL: 'https://idp.example/realm/',
  OIDC_CLIENT_ID: 'legacy-client',
  OIDC_ROLE_PROJECT_ID: 'proj-1',
  OIDC_ALLOWED_ORG_IDS: ' 111 , bad id ,222',
  OIDC_JIT_ENABLED: 'true',
  OIDC_ATTESTATION_MAX_AGE_HOURS: '48',
  OIDC_REDIRECT_URI: 'https://old-host.example/api/auth/oidc/callback',
};
let tempDirectory = '';
let previousDatabasePath: string | undefined;
let ownerId = 0;

before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'sso-import-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
  await initializeDatabase();
  stopReconcileScheduler();
  ownerId = userDb.createUser('import_owner', 'hash', 'owner').id;
});
after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(tempDirectory, { recursive: true, force: true });
});
beforeEach(() => clearSsoConfig(getConnection()));

const importDraft = (env: Record<string, string> = LEGACY_ENV, installationOrigin: string | null = ORIGIN) =>
  importLegacyEnvToDraft({ actorUserId: ownerId, installationOrigin, env });

test('D3 field list: issuer byte-identical, public client, rules, tenant values, JIT, clamped hours', () => {
  const { draft, warnings } = importDraft();
  assert.equal(draft.issuer, 'https://idp.example/realm/');
  assert.equal(draft.client_id, 'legacy-client');
  assert.equal(draft.client_auth, 'none');
  assert.equal(draft.hasClientSecret, false);
  assert.deepEqual(JSON.parse(draft.role_rules_json), LEGACY_DEFAULT_ROLE_RULES);
  assert.equal(draft.role_claim_path, '', 'the owner enters the role claim path');
  assert.equal(draft.tenant_mode, 'role_grant_scope');
  assert.deepEqual(JSON.parse(draft.tenant_values_json), ['111', '222']);
  assert.equal(draft.jit_enabled, 1);
  assert.equal(draft.attestation_max_age_hours, 24);
  assert.equal(draft.allow_private_network, 0, 'import never enables private network');
  assert.equal(draft.issuer_port, null);
  assert.equal(draft.redirect_uri, `${ORIGIN}/api/auth/oidc/callback`);
  assert.equal(draft.draft_version, 1);
  assert.equal(draft.config_hash, computeSsoConfigHash(draft));
  assert.equal(draft.updated_by, ownerId);
  assert.deepEqual(warnings, [{
    code: 'redirect_uri_mismatch', legacyRedirectUri: LEGACY_ENV.OIDC_REDIRECT_URI,
    redirectUri: `${ORIGIN}/api/auth/oidc/callback`,
  }]);
  assert.equal(ssoConfigInvalidReason(readSlotOn(getConnection(), 'draft')), 'role_claim_path_invalid',
    'an imported draft is not usable until the owner completes it');
  assert.equal(readSlotOn(getConnection(), 'active'), undefined, 'nothing is applied');
});

test('defaults: empty org list → tenant none; JIT only for exact "true"; hours default 12; no warning when equal', () => {
  const env = { OIDC_ISSUER_URL: 'https://idp.example', OIDC_CLIENT_ID: 'c', OIDC_JIT_ENABLED: 'TRUE',
    OIDC_REDIRECT_URI: `${ORIGIN}/api/auth/oidc/callback` };
  const { draft, warnings } = importDraft(env);
  assert.equal(draft.tenant_mode, 'none');
  assert.equal(draft.tenant_values_json, '[]');
  assert.equal(draft.jit_enabled, 0);
  assert.equal(draft.attestation_max_age_hours, 12);
  assert.deepEqual(warnings, []);
});

test('unconfirmed installation origin: no redirect URI, a warning instead', () => {
  const { draft, warnings } = importDraft(LEGACY_ENV, null);
  assert.equal(draft.redirect_uri, null);
  assert.deepEqual(warnings, [{ code: 'installation_origin_unconfirmed' }]);
  assert.equal(computeRedirectUri('https://nassaj.example/path'), null, 'only a bare origin counts');
});

test('every import bumps draft_version and clears a stored secret with a secret_version bump', () => {
  writeSsoRow(getConnection(), { client_auth: 'client_secret_basic', client_secret_enc: 'ssooidc:v1:a:b:c',
    secret_version: 4, draft_version: 7 }, 'draft');
  const { draft } = importDraft();
  assert.equal(draft.draft_version, 8);
  assert.equal(draft.secret_version, 5);
  assert.equal(draft.hasClientSecret, false);
  assert.equal(importDraft().draft.secret_version, 5, 'no secret to clear: unchanged');
});

test('refused once an active row exists (env is then ignored), and without issuer + client', () => {
  assert.throws(() => importDraft({ OIDC_ISSUER_URL: 'https://idp.example' }),
    (error: unknown) => error instanceof SsoImportError && error.code === 'legacy_env_incomplete');
  writeSsoRow(getConnection());
  assert.throws(() => importDraft(),
    (error: unknown) => error instanceof SsoImportError && error.code === 'sso_active_config_exists');
  assert.equal(readSlotOn(getConnection(), 'draft'), undefined);
});

test('the import is audited with warning codes only and never writes the disabled record', () => {
  importDraft();
  const audit = getConnection().prepare("SELECT user_id, metadata FROM audit_log WHERE action = 'sso_legacy_env_imported'")
    .get() as { user_id: number; metadata: string };
  assert.equal(audit.user_id, ownerId);
  assert.deepEqual(JSON.parse(audit.metadata), { warnings: ['redirect_uri_mismatch'] });
  assert.equal(getConnection().prepare("SELECT 1 FROM app_config WHERE key = 'sso.disabled'").get(), undefined);
});

test('buildDraftFromLegacyEnv is pure and rejects oversized values', () => {
  assert.throws(() => buildDraftFromLegacyEnv({ OIDC_ISSUER_URL: `https://${'a'.repeat(3000)}`, OIDC_CLIENT_ID: 'c' },
    { installationOrigin: ORIGIN }), SsoImportError);
});
