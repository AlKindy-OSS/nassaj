/**
 * Validation of the owner's SSO draft form (ADR-194 D3/D4/D5, T-1962 S4).
 *
 * The draft may be saved before it is complete (the wizard saves the provider
 * step before the role step), so an empty role claim path and an empty rule
 * list are accepted and reported as missing. Everything that IS supplied is
 * validated strictly with the same rules apply uses. Refusals carry a fixed
 * field code only; a submitted value is never echoed.
 */
import { extraScopesValid } from './sso-config-record.js';
import { parseExactHttpsIssuer } from './oidc-verifier.service.js';
import { ssoMappingRefusal } from './sso-role-mapping.js';
import { SsoSettingsError } from './sso-settings-error.js';

const CLIENT_AUTHS = new Set(['none', 'client_secret_basic', 'client_secret_post']);
const TENANT_MODES = new Set(['none', 'claim', 'role_grant_scope']);
const MAX_CLIENT_ID_LENGTH = 256;
const MAX_SECRET_LENGTH = 1024;
const MAX_PATH_LENGTH = 256;
const MAX_LIST = 64;
const CONTROL = /[\u0000-\u001f\u007f]/u;
// Stand-ins used only to validate the tenant and JIT rules of an incomplete draft.
const PLACEHOLDER_PATH = 'roles';
const PLACEHOLDER_RULES = JSON.stringify([{ value: 'placeholder', role: 'user' }]);

function invalid(field) {
  return new SsoSettingsError('sso_draft_invalid', 400, { field });
}

const boundedString = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !CONTROL.test(value);

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw invalid(field);
  return value ? 1 : 0;
}

function parseClient(body) {
  try {
    parseExactHttpsIssuer(body.issuer);
  } catch {
    throw invalid('issuer');
  }
  if (typeof body.issuer !== 'string' || body.issuer.length > 2048) throw invalid('issuer');
  if (!boundedString(body.clientId, MAX_CLIENT_ID_LENGTH)) throw invalid('clientId');
  if (!CLIENT_AUTHS.has(body.clientAuth)) throw invalid('clientAuth');
  if (body.clientSecret !== undefined && !boundedString(body.clientSecret, MAX_SECRET_LENGTH)) {
    throw invalid('clientSecret');
  }
  if (body.clientSecret !== undefined && body.clientAuth === 'none') throw invalid('clientSecret');
  if (body.clearClientSecret !== undefined && typeof body.clearClientSecret !== 'boolean') {
    throw invalid('clearClientSecret');
  }
  if (body.clientSecret !== undefined && body.clearClientSecret === true) throw invalid('clearClientSecret');
  return {
    issuer: body.issuer, clientId: body.clientId, clientAuth: body.clientAuth,
    clientSecret: body.clientSecret, clearClientSecret: body.clearClientSecret === true,
  };
}

function parseNetwork(body) {
  const extraScopes = body.extraScopes ?? '';
  if (!extraScopesValid(extraScopes)) throw invalid('extraScopes');
  const hours = body.attestationMaxAgeHours ?? 12;
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) throw invalid('attestationMaxAgeHours');
  const allowPrivateNetwork = requireBoolean(body.allowPrivateNetwork ?? false, 'allowPrivateNetwork');
  const port = body.issuerPort ?? null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535 || allowPrivateNetwork !== 1)) {
    throw invalid('issuerPort');
  }
  return { extraScopes, hours, allowPrivateNetwork, issuerPort: port };
}

function stringList(value, field) {
  if (!Array.isArray(value) || value.length > MAX_LIST) throw invalid(field);
  return value;
}

function parseRules(value) {
  const rules = stringList(value ?? [], 'roleRules')
    .map((rule) => ({ value: rule?.value, role: rule?.role }));
  return JSON.stringify(rules);
}

function parseMapping(body) {
  const roleClaimPath = body.roleClaimPath ?? '';
  if (typeof roleClaimPath !== 'string' || roleClaimPath.length > MAX_PATH_LENGTH) throw invalid('roleClaimPath');
  if (!TENANT_MODES.has(body.tenantMode ?? 'none')) throw invalid('tenantMode');
  const tenantClaimPath = body.tenantClaimPath ?? null;
  if (tenantClaimPath !== null && (typeof tenantClaimPath !== 'string' || tenantClaimPath.length > MAX_PATH_LENGTH)) {
    throw invalid('tenantClaimPath');
  }
  return {
    roleClaimPath, roleRulesJson: parseRules(body.roleRules), tenantMode: body.tenantMode ?? 'none',
    tenantClaimPath, tenantValuesJson: JSON.stringify(stringList(body.tenantValues ?? [], 'tenantValues')),
    jitEnabled: requireBoolean(body.jitEnabled ?? false, 'jitEnabled'),
  };
}

/** D4/D5 rules on the supplied parts; missing role path or rules are filled with stand-ins. */
function mappingRefusal(mapping) {
  const rulesEmpty = mapping.roleRulesJson === '[]';
  return ssoMappingRefusal({
    role_claim_path: mapping.roleClaimPath === '' ? PLACEHOLDER_PATH : mapping.roleClaimPath,
    role_rules_json: rulesEmpty ? PLACEHOLDER_RULES : mapping.roleRulesJson,
    tenant_mode: mapping.tenantMode, tenant_claim_path: mapping.tenantClaimPath,
    tenant_values_json: mapping.tenantValuesJson, jit_enabled: mapping.jitEnabled,
  });
}

/**
 * Parses and validates a PUT /draft body. Throws SsoSettingsError
 * (`sso_draft_invalid` with `details.field`, or `sso_mapping_invalid` with a
 * fixed `details.reason`).
 */
export function parseSsoDraftInput(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('body');
  const expected = body.expectedDraftVersion;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
    throw invalid('expectedDraftVersion');
  }
  const mapping = parseMapping(body);
  const refusal = mappingRefusal(mapping);
  if (refusal !== null) throw new SsoSettingsError('sso_mapping_invalid', 400, { reason: refusal });
  return { ...parseClient(body), ...parseNetwork(body), ...mapping, expectedDraftVersion: expected };
}

/** The origin of an issuer URL, or null when it does not parse. */
function issuerOrigin(issuer) {
  try {
    return new URL(issuer).origin;
  } catch {
    return null;
  }
}

/**
 * I5: a draft write that turns private-network reach on, or changes the
 * explicit issuer port (including clearing it), needs `sso_config` step-up.
 * S9 M2: so does moving the issuer to another origin while private-network
 * reach is on in the stored draft or in the result, since that points the
 * private reach at a new host.
 */
export function draftNeedsStepUp(previous, input) {
  const wasPrivate = previous?.allow_private_network === 1;
  const previousPort = previous?.issuer_port ?? null;
  if ((input.allowPrivateNetwork === 1 && !wasPrivate) || input.issuerPort !== previousPort) return true;
  const privateReach = wasPrivate || input.allowPrivateNetwork === 1;
  return privateReach && previous !== undefined && previous !== null
    && issuerOrigin(previous.issuer) !== issuerOrigin(input.issuer);
}
