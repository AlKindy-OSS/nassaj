/**
 * Test double for services/sso-oidc-runtime.service.js (ADR-194 D2/D9). Route
 * tests that mock the database module drive the active client, the version
 * fence and the back-channel selection through `runtime`; the real runtime is
 * covered against a real database and an in-process mock provider.
 *
 * Usage: mock.module(url('../services/sso-oidc-runtime.service.js'),
 *   { namedExports: runtimeDouble.exports }) before importing the routes.
 */
import type { SsoDoubleState } from './sso-config-double.js';

export const DOUBLE_ISSUER = 'https://issuer.example';
export const DOUBLE_CLIENT_ID = 'client-synthetic';
export const DOUBLE_REDIRECT_URI = 'https://app.example/api/auth/oidc/callback';

export type FakeVerifier = Record<string, unknown> & {
  exchangeAuthorizationCode?: (input: unknown) => Promise<unknown>;
  verifyIdToken?: (token: unknown, nonce: unknown) => Promise<unknown>;
  verifyLogoutToken?: (token: unknown) => Promise<unknown>;
};

export type SsoRuntimeDoubleState = {
  /** Active version at selection; entries started now bind it. */
  version: number;
  /** Version the fence reads (null = `version`); set to simulate an apply before the writes. */
  fenceVersion: number | null;
  /** Version the post-mint re-check reads (null = `version`); simulates an apply after the writes. */
  postMintVersion: number | null;
  discoveryFlags: Record<string, unknown>;
  backchannelAvailable: boolean;
  fenceCalls: number;
};

const FENCE_REFUSED = Symbol('sso_fence_refused');

/** Returns the mutable runtime state and the module's named exports. */
export function createSsoRuntimeDouble(sso: { state: SsoDoubleState }, verifier: FakeVerifier) {
  const runtime: SsoRuntimeDoubleState = {
    version: 7, fenceVersion: null, postMintVersion: null, discoveryFlags: {}, backchannelAvailable: true, fenceCalls: 0,
  };
  const fullVerifier = () => ({
    issuer: DOUBLE_ISSUER,
    authorizationEndpoint: async () => `${DOUBLE_ISSUER}/authorize`,
    checkDiscoveryDrift: async () => 'ok',
    ...verifier,
  });
  const activeSsoClient = () => (sso.state.loginAvailable ? Object.freeze({
    slot: 'active', version: runtime.version, issuer: DOUBLE_ISSUER, clientId: DOUBLE_CLIENT_ID,
    redirectUri: DOUBLE_REDIRECT_URI, scope: 'openid profile email', discoveryFlags: runtime.discoveryFlags,
    mapping: sso.state.mapping, verifier: fullVerifier(),
  }) : null);
  const exports = {
    DISCOVERY_ENDPOINT_CHANGED: 'discovery_endpoint_changed',
    SSO_FENCE_REFUSED: FENCE_REFUSED,
    activeSsoClient,
    currentActiveVersion: () => runtime.version,
    activeVersionStillIs: (configVersion: unknown) => (runtime.postMintVersion ?? runtime.version) === configVersion,
    runUnderVersionFence: (configVersion: unknown, work: () => unknown) => {
      runtime.fenceCalls += 1;
      return (runtime.fenceVersion ?? runtime.version) === configVersion ? work() : FENCE_REFUSED;
    },
    backchannelSsoVerifier: () => {
      if (!sso.state.enforced) return { status: 501 };
      if (!runtime.backchannelAvailable) return { status: 503 };
      return { verifier: fullVerifier(), issuer: DOUBLE_ISSUER };
    },
    draftSsoClient: () => ({ refusal: 'sso_test_config_changed' }),
    draftTestBinding: () => ({ refusal: 'sso_test_discovery_required' }),
    recordDiscoveryDrift: () => true,
    setSsoNetworkOverridesForTests: () => {},
  };
  return { runtime, exports };
}
