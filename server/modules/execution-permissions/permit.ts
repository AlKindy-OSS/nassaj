import type { LaunchPurpose } from './types.js';

export type LaunchPermit = Readonly<Record<never, never>>;

export type LaunchPermitBinding = Readonly<{
  decisionId: string;
  leaseId: string;
  userId: number;
  authorizationGeneration: number;
  provider: string;
  body: string;
  engine: string;
  entrypoint: string;
  purpose: LaunchPurpose;
  launchId: string;
  sessionId: string | null;
  workspaceDigest: string;
  contractVersion: string;
  profileDigest: string;
  capabilityDigest: string;
  protocolGeneration: number;
  expiresAtMs: number;
}>;

export type LaunchPermitExpectation = Readonly<Omit<
  LaunchPermitBinding,
  'decisionId' | 'leaseId' | 'expiresAtMs'
>>;

export class LaunchPermitError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'LaunchPermitError';
  }
}

type PermitState = { binding: LaunchPermitBinding; consumed: boolean; revoked: boolean };

const sameBinding = (binding: LaunchPermitBinding, expected: LaunchPermitExpectation): boolean =>
  Object.entries(expected).every(([key, value]) =>
    binding[key as keyof LaunchPermitBinding] === value);

/**
 * Creates an isolated permit authority. Only its issuer can mint members; adapters receive
 * the consumer capability alone, so a look-alike object or permit from another broker fails.
 */
export const createLaunchPermitBroker = (): Readonly<{
  issuer: Readonly<{
    issue(binding: LaunchPermitBinding): LaunchPermit;
    revoke(permit: LaunchPermit): boolean;
  }>;
  consumer: Readonly<{
    consume(
      permit: LaunchPermit,
      expectation: LaunchPermitExpectation,
      nowMs: number,
    ): LaunchPermitBinding;
  }>;
}> => {
  const states = new WeakMap<object, PermitState>();
  const issue = (binding: LaunchPermitBinding): LaunchPermit => {
    if (!Number.isSafeInteger(binding.expiresAtMs) || binding.expiresAtMs <= 0) {
      throw new LaunchPermitError('PERMIT_EXPIRY_INVALID');
    }
    const permit = Object.freeze(Object.create(null)) as LaunchPermit;
    states.set(permit, { binding: Object.freeze({ ...binding }), consumed: false, revoked: false });
    return permit;
  };
  const revoke = (permit: LaunchPermit): boolean => {
    const state = states.get(permit);
    if (!state || state.consumed || state.revoked) return false;
    state.revoked = true;
    return true;
  };
  const consume = (
    permit: LaunchPermit,
    expectation: LaunchPermitExpectation,
    nowMs: number,
  ): LaunchPermitBinding => {
    const state = states.get(permit);
    if (!state) throw new LaunchPermitError('PERMIT_FORGED');
    if (state.revoked) throw new LaunchPermitError('PERMIT_REVOKED');
    if (state.consumed) throw new LaunchPermitError('PERMIT_REPLAYED');
    if (nowMs >= state.binding.expiresAtMs) throw new LaunchPermitError('PERMIT_EXPIRED');
    if (!sameBinding(state.binding, expectation)) throw new LaunchPermitError('PERMIT_SCOPE_MISMATCH');
    state.consumed = true;
    return state.binding;
  };
  return Object.freeze({
    issuer: Object.freeze({ issue, revoke }),
    consumer: Object.freeze({ consume }),
  });
};
