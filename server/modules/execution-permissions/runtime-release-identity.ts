import type { SealedPermissionPolicy } from './types.js';
import { validateSealedPermissionPolicy } from './validation.js';

const HEX64 = /^[a-f0-9]{64}$/u;
const FIELDS = [
  'NASSAJ_PERMISSION_PROFILE',
  'NASSAJ_PERMISSION_CONTRACT_VERSION',
  'NASSAJ_PERMISSION_PROFILE_DIGEST',
  'NASSAJ_PERMISSION_CAPABILITY_DIGEST',
  'NASSAJ_PERMISSION_PROTOCOL_GENERATION',
  'NASSAJ_PERMISSION_MINIMUM_BUILD',
  'NASSAJ_PERMISSION_MANIFEST_SHA256',
] as const;

export type RuntimePermissionIdentity = Readonly<{
  authority: SealedPermissionPolicy;
  releaseBuild: string;
  manifestSha256: string | null;
}>;

/**
 * Parses launcher-owned, non-secret attestation. All-absent means explicit local development;
 * a partial or malformed release identity is rejected rather than downgraded to development.
 */
export const resolveRuntimePermissionIdentity = (
  environment: NodeJS.ProcessEnv,
): RuntimePermissionIdentity => {
  const present = FIELDS.filter(field => environment[field] !== undefined);
  if (present.length === 0) {
    return Object.freeze({
      authority: Object.freeze({
        source: 'development_unsealed',
        profileId: 'full_delegation',
        contractVersion: 'permission-parity/v1',
        profileDigest: `sha256:${'0'.repeat(64)}`,
        capabilityDigest: `sha256:${'0'.repeat(64)}`,
        protocolGeneration: 1,
      }),
      releaseBuild: 'development-unsealed',
      manifestSha256: null,
    });
  }
  if (present.length !== FIELDS.length) throw new Error('PERMISSION_RELEASE_IDENTITY_PARTIAL');
  const generation = Number(environment.NASSAJ_PERMISSION_PROTOCOL_GENERATION);
  const authority: SealedPermissionPolicy = Object.freeze({
    source: 'sealed_release_manifest',
    profileId: environment.NASSAJ_PERMISSION_PROFILE as 'full_delegation',
    contractVersion: environment.NASSAJ_PERMISSION_CONTRACT_VERSION ?? '',
    profileDigest: environment.NASSAJ_PERMISSION_PROFILE_DIGEST ?? '',
    capabilityDigest: environment.NASSAJ_PERMISSION_CAPABILITY_DIGEST ?? '',
    protocolGeneration: generation,
  });
  const releaseBuild = environment.NASSAJ_PERMISSION_MINIMUM_BUILD ?? '';
  const manifestSha256 = environment.NASSAJ_PERMISSION_MANIFEST_SHA256 ?? '';
  if (!validateSealedPermissionPolicy(authority) || !HEX64.test(releaseBuild)
    || !HEX64.test(manifestSha256)) {
    throw new Error('PERMISSION_RELEASE_IDENTITY_INVALID');
  }
  return Object.freeze({ authority, releaseBuild, manifestSha256 });
};
