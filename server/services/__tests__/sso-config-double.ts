/**
 * Test double for services/sso-config.service.js (ADR-194 D1). Route and
 * policy tests that mock the database module drive the SSO state directly
 * through `state`; the real state model is covered by
 * sso-config.service.test.ts against a real database.
 *
 * Usage: mock.module(url('../services/sso-config.service.js'),
 *   { namedExports: sso.exports }) before importing the code under test.
 */
import { buildSsoMapping, type SsoMapping } from '../sso-role-mapping.js';

export type SsoDoubleState = {
  enforced: boolean;
  loginAvailable: boolean;
  legacy: boolean;
  jitEnabled: boolean;
  maxAgeHours: number;
  /** The active row's D4/D5 mapping; returned only while login is available. */
  mapping: SsoMapping | null;
};

/** Row fields for the double's default mapping (role claim `roles`, no tenant restriction). */
export const DEFAULT_DOUBLE_MAPPING_FIELDS = Object.freeze({
  role_claim_path: 'roles',
  role_rules_json: JSON.stringify([
    { value: 'admin', role: 'admin' }, { value: 'member', role: 'user' }, { value: 'viewer', role: 'user' },
  ]),
  tenant_mode: 'none',
  tenant_claim_path: null,
  tenant_values_json: '[]',
});

/** Builds a mapping from row-field overrides on top of the double's default; throws when invalid. */
export function doubleMapping(overrides: Record<string, unknown> = {}): SsoMapping {
  const mapping = buildSsoMapping({ ...DEFAULT_DOUBLE_MAPPING_FIELDS, ...overrides });
  if (mapping === null) throw new Error('invalid test mapping');
  return mapping;
}

const HOUR_MS = 60 * 60 * 1000;

/** Returns a mutable state (default: SSO active) and the module's named exports. */
export function createSsoConfigDouble(initial: Partial<SsoDoubleState> = {}) {
  const state: SsoDoubleState = {
    enforced: true, loginAvailable: true, legacy: false, jitEnabled: false, maxAgeHours: 12,
    mapping: doubleMapping(), ...initial,
  };
  const ssoState = () => {
    if (state.loginAvailable) return 'active';
    if (!state.enforced) return 'off';
    return state.legacy ? 'paused' : 'unavailable';
  };
  const exports = {
    SSO_FORCE_OFF_ENV: 'NASSAJ_SSO_FORCE_OFF',
    ssoForceOff: () => false,
    ssoPolicyEnforced: () => state.enforced,
    ssoLoginAvailable: () => state.loginAvailable,
    legacyEnvPresent: () => state.legacy,
    ssoLegacyRedirectProposalAllowed: () => state.legacy,
    ssoRuntimeState: () => Object.freeze({
      enforced: state.enforced, loginAvailable: state.loginAvailable, legacy: state.legacy,
      readFailed: false, snapshot: null,
    }),
    ssoState,
    ssoAttestationPolicy: () => ({
      enforced: state.enforced, loginAvailable: state.loginAvailable, maxAgeMs: state.maxAgeHours * HOUR_MS,
    }),
    ssoJitEnabled: () => state.loginAvailable && state.jitEnabled,
    activeSsoMapping: () => (state.loginAvailable ? state.mapping : null),
    resetSsoConfigCacheForTests: () => {},
  };
  /** SSO fully on (`true`) or fully off (`false`), the two states most route tests need. */
  const setActive = (active: boolean) => {
    state.enforced = active;
    state.loginAvailable = active;
  };
  return { state, exports, setActive };
}
