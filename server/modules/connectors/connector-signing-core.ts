/**
 * Shared owner-authority connector signing core (ADR-138 / ADR-162, T-1831).
 *
 * Pure minting + key-custody helpers reused by BOTH the operator CLI
 * (`scripts/connectors-sign.mjs`, loaded from dist-server) and the server-side
 * boot auto-setup (`connector-auto-setup.ts`). Extracting them here keeps a
 * single implementation of the safe-key-dir policy, the Ed25519 key handling,
 * and the trust-bundle / certification-pack build + self-verify — no duplication.
 *
 * These functions sign INTEGRITY within one installation; the private key is the
 * operator's own root of trust. Nothing here reads request headers, contacts a
 * provider, or writes runtime state — callers persist the artifacts.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PROVIDER_AUTH_SPECS } from '../../../shared/connector-auth-registry.js';

import {
  CONNECTOR_GLOBAL_PACK_DOMAIN, CONNECTOR_GLOBAL_PACK_MAX_TTL_MS,
  CONNECTOR_GLOBAL_PACK_STANDARD_TTL_MS, connectorGlobalPackSignedBytes,
  verifyConnectorGlobalCertificationPack,
} from './connector-global-certification-pack.js';
import { connectorJcs } from './connector-jcs.js';
import { KILLABLE_CONNECTOR_OPERATIONS } from './connector-policy-v2.js';
import { CONNECTOR_POLICY_SCHEMA_VERSION, CONNECTOR_RUNTIME_FLOOR } from './connector-runtime-fence.js';
import {
  CONNECTOR_RUNTIME_MANIFEST, CONNECTOR_RUNTIME_PACK_EXPECTATIONS,
} from './connector-runtime-manifest.js';
import {
  connectorTrustBundleDigest, parseConnectorTrustBundle, type ConnectorTrustBundle,
} from './connector-trust-bundle.js';

/** Typed refusal carrying the stable machine code the CLI prints as `FAIL <code>`. */
export class ConnectorSigningError extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ConnectorSigningError';
  }
}

const fail = (code: string, detail: string): never => { throw new ConnectorSigningError(code, detail); };

/** The default operator key directory, outside the repository and off tmpfs. */
export const CONNECTOR_SIGNING_DEFAULT_KEY_DIR_SEGMENTS = ['.config', 'nassaj', 'connector-signing'] as const;
/** Repeatable default certification: github/github api_key over the four killable ops. */
export const CONNECTOR_SIGNING_DEFAULT_CERTIFY =
  'github:github:profile.configure,credential.verify,credential.use,placement.write:api_key';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const AUTH_METHODS = new Set(['dcr_pkce', 'byo_app', 'api_key']);
const KILLABLE = new Set<string>(KILLABLE_CONNECTOR_OPERATIONS);
const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

const sha256b64u = (value: unknown): string =>
  createHash('sha256').update(connectorJcs(value), 'utf8').digest('base64url');
const plusDaysIso = (fromMs: number, days: number): string =>
  new Date(fromMs + days * 86_400_000).toISOString();

/** Validates a connector id (key id, issuer, provider, service) or refuses. */
export const validateConnectorSigningId = (value: string, label: string): string => {
  if (!ID_RE.test(value)) fail('CONNECTOR_SIGN_ID_INVALID', `${label} "${value}" is not a valid connector id.`);
  return value;
};

/** Real path of `target` if it exists, else the lexical path unchanged. */
const realpathIfExists = (target: string): string => {
  try { return fs.realpathSync(target); } catch { return target; }
};

/** Real path of `target` with symlinks resolved on its nearest existing ancestor. */
const realpathNearestExistingAncestor = (target: string): string => {
  let probe = target;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      return probe === target ? real : path.join(real, path.relative(probe, target));
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return target;
      probe = parent;
    }
  }
};

/**
 * Resolves a key directory and refuses the repo/.git tree and any RAM-backed
 * (tmpfs/ramfs) path, so a private root of trust never lands somewhere that
 * either leaks into git or never releases memory (NASSAJ rules, T-1540).
 */
export const assertSafeConnectorKeyDir = (dir: string, forbiddenGitDir: string): string => {
  const resolved = path.resolve(dir);
  // Resolve symlinks on the nearest existing ancestor before the .git comparison, so a
  // key dir (or one of its parents) that symlinks INTO the repo's .git tree is rejected
  // even though the lexical path looks safe.
  const realResolved = realpathNearestExistingAncestor(resolved);
  const gitDir = realpathIfExists(path.resolve(forbiddenGitDir));
  for (const candidate of new Set([resolved, realResolved])) {
    if (candidate === gitDir || candidate.startsWith(gitDir + path.sep)) {
      fail('CONNECTOR_SIGN_KEYDIR_FORBIDDEN', `Refusing to place private keys under .git (${candidate}).`);
    }
  }
  for (const bad of ['/tmp', '/dev/shm']) {
    if (resolved === bad || resolved.startsWith(bad + path.sep)) {
      fail('CONNECTOR_SIGN_KEYDIR_FORBIDDEN',
        `Refusing tmpfs path ${resolved}; RAM-backed dirs never release memory. Use /var/tmp or a disk path.`);
    }
  }
  assertKeyDirNotRamBacked(resolved);
  return resolved;
};

/** Detects tmpfs mounted outside the name list via statfs magic on the nearest existing ancestor. */
const assertKeyDirNotRamBacked = (resolved: string): void => {
  if (typeof fs.statfsSync !== 'function') return;
  let probe: string | null = resolved;
  while (probe && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    probe = parent === probe ? null : parent;
  }
  if (!probe) return;
  try {
    const fsType = Number(fs.statfsSync(probe).type);
    if (fsType === TMPFS_MAGIC || fsType === RAMFS_MAGIC) {
      fail('CONNECTOR_SIGN_KEYDIR_FORBIDDEN',
        `Refusing RAM-backed (tmpfs/ramfs) path ${resolved}; such dirs never release memory. `
        + 'Use /var/tmp or a disk path.');
    }
  } catch (error) {
    if (error instanceof ConnectorSigningError) throw error;
    // statfs unsupported: the name checks above already ran.
  }
};

/** Absolute path of the private key PEM for one key id inside a directory. */
export const connectorPrivateKeyPath = (dir: string, keyId: string): string =>
  path.join(dir, `${keyId}.private.pem`);
/** Absolute path of the public key PEM for one key id inside a directory. */
export const connectorPublicKeyPath = (dir: string, keyId: string): string =>
  path.join(dir, `${keyId}.public.pem`);

/** SHA-256 colon-grouped fingerprint of a public key PEM. */
export const connectorPublicKeyFingerprint = (publicKeyPem: string): string =>
  createHash('sha256').update(publicKeyPem, 'utf8').digest('hex').replace(/(.{2})/g, '$1:').slice(0, 47);

/** Writes a file with an exact mode, creating parents 0700; chmods to defeat umask. */
export const writeConnectorSigningFile = (filePath: string, contents: string, mode: number): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode });
  fs.chmodSync(filePath, mode);
};

/** Reads a private key PEM, refusing a missing file or group/other-readable (non-0600) mode. */
export const readConnectorPrivateKey = (dir: string, keyId: string): string => {
  const keyPath = connectorPrivateKeyPath(dir, keyId);
  const stat = fs.lstatSync(keyPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    fail('CONNECTOR_SIGN_KEY_MISSING', `No private key at ${keyPath}. Run keygen first.`);
  }
  if ((stat!.mode & 0o077) !== 0) {
    fail('CONNECTOR_SIGN_KEY_PERMISSIONS', `Private key ${keyPath} is group/other readable; expected mode 0600.`);
  }
  return fs.readFileSync(keyPath, 'utf8');
};

export type ConnectorSigningKeyPair = Readonly<{ privateKeyPem: string; publicKeyPem: string }>;

/** Generates a fresh Ed25519 key pair as PKCS8/SPKI PEM strings. */
export const generateConnectorEd25519KeyPair = (): ConnectorSigningKeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return Object.freeze({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
};

export type ConnectorSigningCertification = Readonly<{
  providerId: string; serviceId: string; operation: string;
  authMethod: 'dcr_pkce' | 'byo_app' | 'api_key';
  shapeRevision: 1; shapeDigest: string; contractRevision: 1; contractDigest: string; status: 'certified';
}>;

/** Parses one `provider:service:op1,op2:authMethod` spec into build-bound certifications. */
export const parseConnectorCertifySpec = (spec: string): ConnectorSigningCertification[] => {
  const parts = spec.split(':');
  if (parts.length !== 4) {
    fail('CONNECTOR_SIGN_CERTIFY_INVALID', `--certify "${spec}" must be provider:service:op1,op2,...:authMethod`);
  }
  const [providerId, serviceId, opsRaw, authMethod] = parts;
  validateConnectorSigningId(providerId, 'providerId');
  validateConnectorSigningId(serviceId, 'serviceId');
  if (!AUTH_METHODS.has(authMethod)) fail('CONNECTOR_SIGN_AUTH_METHOD_INVALID', `authMethod "${authMethod}" unknown.`);
  const operations = opsRaw.split(',').map(o => o.trim()).filter(Boolean);
  if (operations.length === 0) fail('CONNECTOR_SIGN_CERTIFY_INVALID', `--certify "${spec}" lists no operations.`);
  for (const op of operations) {
    if (!KILLABLE.has(op)) fail('CONNECTOR_SIGN_OPERATION_INVALID', `operation "${op}" is not a killable connector op.`);
  }
  const provider = PROVIDER_AUTH_SPECS.find(s => s.profileId === providerId && s.services.includes(serviceId));
  if (!provider) {
    fail('CONNECTOR_SIGN_PROVIDER_UNKNOWN',
      `provider/service ${providerId}/${serviceId} is not in this build's connector auth registry.`);
  }
  const providerSpec = provider as unknown as {
    method: string; services: readonly string[]; serviceProbe?: unknown; expectedIssuer?: unknown;
  };
  const shapeDigest = sha256b64u({ providerId, serviceId,
    method: providerSpec.method, services: providerSpec.services });
  const contractDigest = sha256b64u({ providerId, serviceId, authMethod,
    probe: providerSpec.serviceProbe ?? null, expectedIssuer: providerSpec.expectedIssuer ?? null });
  return operations.map(operation => Object.freeze({
    providerId, serviceId, operation, authMethod: authMethod as ConnectorSigningCertification['authMethod'],
    shapeRevision: 1 as const, shapeDigest, contractRevision: 1 as const, contractDigest, status: 'certified' as const,
  }));
};

export type ConnectorTrustBundleBuildInput = Readonly<{
  issuer: string; keyId: string; publicKeyPem: string;
  revision?: number; validDays?: number; revokedKeyIds?: readonly string[]; nowMs: number;
}>;

/** Assembles and parse-validates an `owner_import` trust bundle rooted in the public key. */
export const buildConnectorTrustBundle = (input: ConnectorTrustBundleBuildInput): ConnectorTrustBundle => {
  const revision = input.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail('CONNECTOR_SIGN_REVISION_INVALID', 'revision must be a positive integer (1 for first import).');
  }
  const validDays = input.validDays ?? 400;
  if (!Number.isSafeInteger(validDays) || validDays < 1) fail('CONNECTOR_SIGN_ARGUMENT_INVALID', 'valid-days invalid.');
  for (const rk of input.revokedKeyIds ?? []) validateConnectorSigningId(rk, 'revoked keyId');
  const bundle = {
    schemaVersion: 1, revision, distributionIssuerId: input.issuer,
    roots: [{ issuerId: input.issuer, keyId: input.keyId, algorithm: 'Ed25519', publicKeyPem: input.publicKeyPem,
      validFrom: new Date(input.nowMs).toISOString(), validUntil: plusDaysIso(input.nowMs, validDays),
      source: 'owner_import' }],
    revokedKeyIds: [...(input.revokedKeyIds ?? [])],
  };
  const parsed = parseConnectorTrustBundle(bundle);
  if (!parsed) fail('CONNECTOR_SIGN_TRUST_INVALID', 'Assembled trust bundle failed the production parser.');
  return parsed!;
};

export type ConnectorGlobalPackBuildInput = Readonly<{
  issuer: string; keyId: string; channel: string; sequence: number;
  issuedAtMs: number; ttlDays: number; certifications: readonly ConnectorSigningCertification[];
}>;

/** Builds an unsigned build-bound global certification pack; enforces the channel TTL ceiling. */
export const buildConnectorGlobalPack = (input: ConnectorGlobalPackBuildInput): Record<string, unknown> => {
  const maxDays = input.channel === 'stable'
    ? CONNECTOR_GLOBAL_PACK_STANDARD_TTL_MS / 86_400_000
    : CONNECTOR_GLOBAL_PACK_MAX_TTL_MS / 86_400_000;
  if (input.ttlDays <= 0 || input.ttlDays > maxDays) {
    fail('CONNECTOR_SIGN_TTL_INVALID', `ttl-days must be in 1..${maxDays} for channel ${input.channel}.`);
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    fail('CONNECTOR_SIGN_SEQUENCE_INVALID', 'sequence invalid.');
  }
  return {
    schemaVersion: 1, domain: CONNECTOR_GLOBAL_PACK_DOMAIN, issuerId: input.issuer, channel: input.channel,
    sequence: input.sequence, issuedAt: new Date(input.issuedAtMs).toISOString(),
    expiresAt: plusDaysIso(input.issuedAtMs, input.ttlDays),
    minimumRuntimeFloor: CONNECTOR_RUNTIME_FLOOR, maximumPolicySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION,
    registryRevision: CONNECTOR_RUNTIME_MANIFEST.registryRevision,
    registryDigest: CONNECTOR_RUNTIME_MANIFEST.registryDigest,
    operationsRevision: CONNECTOR_RUNTIME_MANIFEST.operationsRevision,
    operationsDigest: CONNECTOR_RUNTIME_MANIFEST.operationsDigest,
    capabilityRevision: CONNECTOR_RUNTIME_MANIFEST.capabilityRevision,
    capabilityDigest: CONNECTOR_RUNTIME_MANIFEST.capabilityDigest,
    certifications: input.certifications, signingKeyId: input.keyId,
  };
};

export type ConnectorSignedPack = Readonly<{ envelope: { pack: unknown; signature: string }; digest: string }>;

/**
 * Signs a built pack with the operator private key and self-verifies it with the
 * SAME production verifier the server enforces. Refusal to verify is fail-closed.
 */
export const signAndVerifyConnectorGlobalPack = (input: Readonly<{
  pack: Record<string, unknown>; privateKeyPem: string; trustBundle: ConnectorTrustBundle;
  sequence: number; nowMs?: number;
}>): ConnectorSignedPack => {
  const signature = sign(null, connectorGlobalPackSignedBytes(input.pack as never), input.privateKeyPem)
    .toString('base64url');
  const envelope = { pack: input.pack, signature };
  const result = verifyConnectorGlobalCertificationPack(envelope, {
    now: new Date(input.nowMs ?? Date.now()), wallClockHighWaterMs: 0, priorSequence: input.sequence - 1,
    minimumTrustBundleRevision: input.trustBundle.revision, runtimeFloor: CONNECTOR_RUNTIME_FLOOR,
    policySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION, trustBundle: input.trustBundle,
    ...CONNECTOR_RUNTIME_PACK_EXPECTATIONS,
  });
  if (!result.verified) {
    fail('CONNECTOR_SIGN_SELF_VERIFY_FAILED', `Production verifier rejected the freshly signed pack: ${result.reason}.`);
  }
  return Object.freeze({ envelope, digest: (result as { digest: string }).digest });
};

/** Parses and validates an on-disk trust bundle JSON value or refuses. */
export const loadConnectorTrustBundle = (value: unknown): ConnectorTrustBundle => {
  const bundle = parseConnectorTrustBundle(value);
  if (!bundle) fail('CONNECTOR_SIGN_TRUST_INVALID', 'Trust bundle failed the production parser.');
  return bundle!;
};

/** Base64url SHA-512 digest of a trust bundle, matching the server's stored digest. */
export const connectorTrustBundleDigestB64u = (bundle: ConnectorTrustBundle): string =>
  connectorTrustBundleDigest(bundle).toString('base64url');
