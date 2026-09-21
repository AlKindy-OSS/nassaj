#!/usr/bin/env node
/**
 * Owner-authority connector certification signing tool (ADR-138 M1, decision (b)).
 *
 * Generates the operator's own Ed25519 key, an `owner_import` trust bundle, and a
 * build-bound global certification pack, then verifies the pack with the SAME
 * production verifier the server uses (`verifyConnectorGlobalCertificationPack`).
 *
 * The private key is the operator's root of trust: it stays on the operator box,
 * never in git, never on the server. This tool signs INTEGRITY within one
 * installation; it is not a central nassaj attestation (see ADR-138 threat model).
 *
 * Commands: keygen | trust | pack | renew   (run with --help for usage).
 *
 * Note: the headless owner-auth refusal in connectors-trust.mjs / connectors-setup.mjs
 * is intentional and untouched. This tool only PRODUCES artifacts on disk; importing
 * them into a live installation still goes through the browser owner Setup handlers.
 */

import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DIST = path.join(REPO_ROOT, 'dist-server');

// Runs at import time, outside main()'s SignExit handler, so it refuses with exit 2 directly.
const need = rel => {
  const abs = path.join(DIST, rel);
  if (!fs.existsSync(abs)) {
    process.stdout.write(`FAIL CONNECTOR_SIGN_BUILD_MISSING: Missing ${rel}. `
      + 'Run "npm run build:server" first so this tool can load the production verifier.\n');
    process.exit(2);
  }
  return abs;
};

/**
 * T-1540: warn (do not fail) when a connector source file is newer than its dist-server
 * build output — a stale build silently signs packs against outdated digests/verifier.
 */
function warnIfDistStale() {
  const srcDir = path.join(REPO_ROOT, 'server/modules/connectors');
  const distDir = path.join(DIST, 'server/modules/connectors');
  if (!fs.existsSync(srcDir) || !fs.existsSync(distDir)) return;
  let newestSrcMs = 0;
  for (const entry of fs.readdirSync(srcDir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    const stat = fs.statSync(path.join(srcDir, entry), { throwIfNoEntry: false });
    if (stat && stat.mtimeMs > newestSrcMs) newestSrcMs = stat.mtimeMs;
  }
  let oldestDistMs = Infinity;
  for (const entry of fs.readdirSync(distDir)) {
    if (!entry.endsWith('.js')) continue;
    const stat = fs.statSync(path.join(distDir, entry), { throwIfNoEntry: false });
    if (stat && stat.mtimeMs < oldestDistMs) oldestDistMs = stat.mtimeMs;
  }
  if (Number.isFinite(oldestDistMs) && newestSrcMs > oldestDistMs) {
    process.stderr.write(
      'WARN CONNECTOR_SIGN_DIST_STALE: server/modules/connectors sources are newer than dist-server; ' +
      'run "npm run build:server" so this tool signs against the current verifier/digests.\n');
  }
}
warnIfDistStale();

const packMod = await import(need('server/modules/connectors/connector-global-certification-pack.js'));
const trustMod = await import(need('server/modules/connectors/connector-trust-bundle.js'));
const manifestMod = await import(need('server/modules/connectors/connector-runtime-manifest.js'));
const policyMod = await import(need('server/modules/connectors/connector-policy-v2.js'));
const fenceMod = await import(need('server/modules/connectors/connector-runtime-fence.js'));
const jcsMod = await import(need('server/modules/connectors/connector-jcs.js'));
const registryMod = await import(need('shared/connector-auth-registry.js'));

const {
  connectorGlobalPackSignedBytes, connectorGlobalPackDigest, verifyConnectorGlobalCertificationPack,
  CONNECTOR_GLOBAL_PACK_DOMAIN, CONNECTOR_GLOBAL_PACK_STANDARD_TTL_MS, CONNECTOR_GLOBAL_PACK_MAX_TTL_MS,
} = packMod;
const { parseConnectorTrustBundle, connectorTrustBundleDigest } = trustMod;
const { CONNECTOR_RUNTIME_MANIFEST, CONNECTOR_RUNTIME_PACK_EXPECTATIONS } = manifestMod;
const { KILLABLE_CONNECTOR_OPERATIONS } = policyMod;
const { CONNECTOR_RUNTIME_FLOOR, CONNECTOR_POLICY_SCHEMA_VERSION } = fenceMod;
const { connectorJcs } = jcsMod;
const { PROVIDER_AUTH_SPECS } = registryMod;

const KILLABLE = new Set(KILLABLE_CONNECTOR_OPERATIONS);

function fail(code, detail) {
  process.stdout.write(`FAIL ${code}: ${detail}\n`);
  process.exitCode = 2;
  throw new SignExit(code);
}
class SignExit extends Error {}

const DEFAULT_KEY_DIR = path.join(os.homedir(), '.config', 'nassaj', 'connector-signing');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const arg = (args, flag, fallback = null) => {
  const at = args.indexOf(flag);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const has = (args, flag) => args.includes(flag);

/** Reject key directories inside the repo/.git or on tmpfs (RAM-backed, per NASSAJ rules). */
function assertSafeKeyDir(dir) {
  const resolved = path.resolve(dir);
  const gitDir = path.join(REPO_ROOT, '.git');
  if (resolved === gitDir || resolved.startsWith(gitDir + path.sep)) {
    fail('CONNECTOR_SIGN_KEYDIR_FORBIDDEN', `Refusing to place private keys under .git (${resolved}).`);
  }
  for (const bad of ['/tmp', '/dev/shm']) {
    if (resolved === bad || resolved.startsWith(bad + path.sep)) {
      fail('CONNECTOR_SIGN_KEYDIR_FORBIDDEN',
        `Refusing tmpfs path ${resolved}; RAM-backed dirs never release memory. Use /var/tmp or a disk path.`);
    }
  }
  // T-1540: name lists miss tmpfs mounted elsewhere (e.g. a bind mount). Detect RAM-backed
  // filesystems by their statfs magic on the nearest existing ancestor of the target.
  if (typeof fs.statfsSync === 'function') {
    const TMPFS_MAGIC = 0x01021994;
    const RAMFS_MAGIC = 0x858458f6;
    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) { probe = null; break; }
      probe = parent;
    }
    if (probe) {
      try {
        const fsType = Number(fs.statfsSync(probe).type);
        if (fsType === TMPFS_MAGIC || fsType === RAMFS_MAGIC) {
          fail('CONNECTOR_SIGN_KEYDIR_FORBIDDEN',
            `Refusing RAM-backed (tmpfs/ramfs) path ${resolved}; such dirs never release memory. `
            + 'Use /var/tmp or a disk path.');
        }
      } catch (error) {
        if (error instanceof SignExit) throw error; // propagate our own refusal
        // statfs unavailable/unsupported: fall back to the name checks above.
      }
    }
  }
  return resolved;
}

const privatePath = (dir, keyId) => path.join(dir, `${keyId}.private.pem`);
const publicPath = (dir, keyId) => path.join(dir, `${keyId}.public.pem`);
const fingerprint = pubPem =>
  createHash('sha256').update(pubPem, 'utf8').digest('hex').replace(/(.{2})/g, '$1:').slice(0, 47);
const sha256b64u = value => createHash('sha256').update(connectorJcs(value), 'utf8').digest('base64url');
const nowIso = () => new Date().toISOString();
const plusDaysIso = (fromMs, days) => new Date(fromMs + days * 86_400_000).toISOString();

function validId(value, label) {
  if (!ID_RE.test(value)) fail('CONNECTOR_SIGN_ID_INVALID', `${label} "${value}" is not a valid connector id.`);
  return value;
}

function readPrivateKey(dir, keyId) {
  const p = privatePath(dir, keyId);
  const stat = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) fail('CONNECTOR_SIGN_KEY_MISSING', `No private key at ${p}. Run keygen first.`);
  if ((stat.mode & 0o077) !== 0) {
    fail('CONNECTOR_SIGN_KEY_PERMISSIONS', `Private key ${p} is group/other readable; expected mode 0600.`);
  }
  return fs.readFileSync(p, 'utf8');
}

function readJsonFile(p, label) {
  const stat = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) fail('CONNECTOR_SIGN_INPUT_MISSING', `No ${label} file at ${p}.`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { fail('CONNECTOR_SIGN_INPUT_JSON_INVALID', `${label} at ${p} is not valid JSON.`); }
}

function writeFileStrict(p, contents, mode) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, contents, { mode });
  fs.chmodSync(p, mode);
}

// --- certify spec: provider:service:op1,op2:authMethod ------------------------
const DEFAULT_CERTIFY = 'github:github:profile.configure,credential.verify,credential.use,placement.write:api_key';
const AUTH_METHODS = new Set(['dcr_pkce', 'byo_app', 'api_key']);

function parseCertify(spec) {
  const parts = spec.split(':');
  if (parts.length !== 4) {
    fail('CONNECTOR_SIGN_CERTIFY_INVALID',
      `--certify "${spec}" must be provider:service:op1,op2,...:authMethod`);
  }
  const [providerId, serviceId, opsRaw, authMethod] = parts;
  validId(providerId, 'providerId');
  validId(serviceId, 'serviceId');
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
  // Per-certification shape/contract digests are deterministic, build-derived documentary
  // bindings (verifier checks format only; the runtime binding is registry/operations/capability).
  const shapeDigest = sha256b64u({ providerId, serviceId, method: provider.method, services: provider.services });
  const contractDigest = sha256b64u({
    providerId, serviceId, authMethod,
    probe: provider.serviceProbe ?? null, expectedIssuer: provider.expectedIssuer ?? null,
  });
  return operations.map(operation => ({
    providerId, serviceId, operation, authMethod,
    shapeRevision: 1, shapeDigest, contractRevision: 1, contractDigest, status: 'certified',
  }));
}

function buildPack({ issuer, keyId, channel, sequence, issuedAtMs, ttlDays, certifications }) {
  const maxDays = channel === 'stable'
    ? CONNECTOR_GLOBAL_PACK_STANDARD_TTL_MS / 86_400_000
    : CONNECTOR_GLOBAL_PACK_MAX_TTL_MS / 86_400_000;
  if (ttlDays <= 0 || ttlDays > maxDays) {
    fail('CONNECTOR_SIGN_TTL_INVALID', `--ttl-days must be in 1..${maxDays} for channel ${channel}.`);
  }
  return {
    schemaVersion: 1,
    domain: CONNECTOR_GLOBAL_PACK_DOMAIN,
    issuerId: issuer,
    channel,
    sequence,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: plusDaysIso(issuedAtMs, ttlDays),
    minimumRuntimeFloor: CONNECTOR_RUNTIME_FLOOR,
    maximumPolicySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION,
    registryRevision: CONNECTOR_RUNTIME_MANIFEST.registryRevision,
    registryDigest: CONNECTOR_RUNTIME_MANIFEST.registryDigest,
    operationsRevision: CONNECTOR_RUNTIME_MANIFEST.operationsRevision,
    operationsDigest: CONNECTOR_RUNTIME_MANIFEST.operationsDigest,
    capabilityRevision: CONNECTOR_RUNTIME_MANIFEST.capabilityRevision,
    capabilityDigest: CONNECTOR_RUNTIME_MANIFEST.capabilityDigest,
    certifications,
    signingKeyId: keyId,
  };
}

function signAndVerify({ pack, privateKeyPem, trustBundle, sequence }) {
  const signature = sign(null, connectorGlobalPackSignedBytes(pack), privateKeyPem).toString('base64url');
  const envelope = { pack, signature };
  const result = verifyConnectorGlobalCertificationPack(envelope, {
    now: new Date(),
    wallClockHighWaterMs: 0,
    priorSequence: sequence - 1,
    minimumTrustBundleRevision: trustBundle.revision,
    runtimeFloor: CONNECTOR_RUNTIME_FLOOR,
    policySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION,
    trustBundle,
    ...CONNECTOR_RUNTIME_PACK_EXPECTATIONS,
  });
  if (!result.verified) {
    fail('CONNECTOR_SIGN_SELF_VERIFY_FAILED',
      `Production verifier rejected the freshly signed pack: ${result.reason}.`);
  }
  return { envelope, digest: result.digest };
}

function loadTrust(p) {
  const bundle = parseConnectorTrustBundle(readJsonFile(p, 'trust bundle'));
  if (!bundle) fail('CONNECTOR_SIGN_TRUST_INVALID', `Trust bundle at ${p} failed the production parser.`);
  return bundle;
}

// --- commands -----------------------------------------------------------------

function cmdKeygen(args) {
  const dir = assertSafeKeyDir(arg(args, '--dir', DEFAULT_KEY_DIR));
  const keyId = validId(arg(args, '--key-id', `owner-${createHash('sha256')
    .update(String(Date.now()) + Math.random()).digest('hex').slice(0, 12)}`), 'key-id');
  const issuer = validId(arg(args, '--issuer', 'nassaj-oss-owner'), 'issuer');
  const priv = privatePath(dir, keyId);
  const pub = publicPath(dir, keyId);
  if (!has(args, '--force') && (fs.existsSync(priv) || fs.existsSync(pub))) {
    fail('CONNECTOR_SIGN_KEY_EXISTS', `Key ${keyId} already exists in ${dir}; pass --force to overwrite.`);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileStrict(priv, privateKeyPem, 0o600);
  writeFileStrict(pub, publicKeyPem, 0o644);
  process.stdout.write(JSON.stringify({
    ok: true, command: 'keygen', keyId, issuer,
    fingerprintSha256: fingerprint(publicKeyPem),
    privateKeyPath: priv, publicKeyPath: pub,
  }, null, 2) + '\n');
}

function cmdTrust(args) {
  const dir = assertSafeKeyDir(arg(args, '--dir', DEFAULT_KEY_DIR));
  const keyId = validId(arg(args, '--key-id'), 'key-id');
  const issuer = validId(arg(args, '--issuer', 'nassaj-oss-owner'), 'issuer');
  const out = arg(args, '--out');
  if (!out) fail('CONNECTOR_SIGN_ARGUMENT_INVALID', '--out <trust-bundle.json> is required.');
  const revision = Number(arg(args, '--revision', '1'));
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail('CONNECTOR_SIGN_REVISION_INVALID', '--revision must be a positive integer (1 for first import).');
  }
  const validDays = Number(arg(args, '--valid-days', '400'));
  if (!Number.isSafeInteger(validDays) || validDays < 1) fail('CONNECTOR_SIGN_ARGUMENT_INVALID', '--valid-days invalid.');
  const revokedRaw = arg(args, '--revoked', '');
  const revokedKeyIds = revokedRaw ? revokedRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  for (const rk of revokedKeyIds) validId(rk, 'revoked keyId');
  const pubStat = fs.lstatSync(publicPath(dir, keyId), { throwIfNoEntry: false });
  if (!pubStat) fail('CONNECTOR_SIGN_KEY_MISSING', `No public key for ${keyId} in ${dir}. Run keygen first.`);
  const publicKeyPem = fs.readFileSync(publicPath(dir, keyId), 'utf8');
  const nowMs = Date.now();
  const bundle = {
    schemaVersion: 1,
    revision,
    distributionIssuerId: issuer,
    roots: [{
      issuerId: issuer, keyId, algorithm: 'Ed25519', publicKeyPem,
      validFrom: new Date(nowMs).toISOString(), validUntil: plusDaysIso(nowMs, validDays),
      source: 'owner_import',
    }],
    revokedKeyIds,
  };
  const parsed = parseConnectorTrustBundle(bundle);
  if (!parsed) fail('CONNECTOR_SIGN_TRUST_INVALID', 'Assembled trust bundle failed the production parser.');
  writeFileStrict(path.resolve(out), JSON.stringify(bundle, null, 2) + '\n', 0o644);
  // Key rotation is NOT importable today: owner Setup rejects any trust bundle at
  // revision > 1 with CONNECTOR_TRUST_ROTATION_REQUIRES_RECOVERY (409) because the
  // recovery flow is not wired (see connector-owner-setup.service.ts importTrust). Do
  // not promise the operator a rotation that the server will refuse.
  if (revision > 1) {
    process.stdout.write(
      'WARN CONNECTOR_TRUST_ROTATION_REQUIRES_RECOVERY: this revision > 1 bundle CANNOT be imported. ' +
      'Owner Setup (POST /owner/setup/trust/import) rejects any revision > 1 trust bundle with ' +
      'CONNECTOR_TRUST_ROTATION_REQUIRES_RECOVERY (409); in-product key rotation is not available yet ' +
      '(recovery flow unwired). On suspected key leak, reinitialize the connector installation from ' +
      'scratch instead. See docs/connectors-operator-setup.md section 4.\n');
  }
  process.stdout.write(JSON.stringify({
    ok: true, command: 'trust', out: path.resolve(out), revision, issuer, keyId,
    revokedKeyIds, digest: connectorTrustBundleDigest(parsed).toString('base64url'),
    note: revision === 1
      ? 'First import: owner Setup requires revision 1 (rotation needs the recovery flow).'
      : 'NOT IMPORTABLE: owner Setup rejects revision > 1 with CONNECTOR_TRUST_ROTATION_REQUIRES_RECOVERY '
        + '(409); rotation is unavailable until the recovery flow is wired.',
  }, null, 2) + '\n');
}

function cmdPack(args, { renew = false } = {}) {
  const dir = assertSafeKeyDir(arg(args, '--dir', DEFAULT_KEY_DIR));
  const trustFile = arg(args, '--trust');
  if (!trustFile) fail('CONNECTOR_SIGN_ARGUMENT_INVALID', '--trust <trust-bundle.json> is required.');
  const out = arg(args, '--out');
  if (!out) fail('CONNECTOR_SIGN_ARGUMENT_INVALID', '--out <pack.json> is required.');
  const trustBundle = loadTrust(trustFile);
  const ttlDays = Number(arg(args, '--ttl-days', '30'));

  let issuer;
  let keyId;
  let channel;
  let certifications;
  let sequence;
  if (renew) {
    // Re-mint the current pack: inherit issuer/key/channel/certifications, refresh expiry (T-1527).
    const prior = readJsonFile(path.resolve(arg(args, '--in')), 'existing pack');
    if (!prior || typeof prior !== 'object' || !prior.pack) {
      fail('CONNECTOR_SIGN_INPUT_JSON_INVALID', '--in must be a signed pack envelope {pack, signature}.');
    }
    issuer = validId(prior.pack.issuerId, 'issuer');
    keyId = validId(prior.pack.signingKeyId, 'key-id');
    channel = prior.pack.channel;
    certifications = prior.pack.certifications;
    const priorSeq = Number(prior.pack.sequence);
    sequence = Number(arg(args, '--sequence', String(priorSeq + 1)));
    if (sequence <= priorSeq) {
      fail('CONNECTOR_SIGN_SEQUENCE_INVALID', `renew sequence ${sequence} must exceed prior ${priorSeq}.`);
    }
  } else {
    keyId = validId(arg(args, '--key-id'), 'key-id');
    issuer = validId(arg(args, '--issuer', 'nassaj-oss-owner'), 'issuer');
    channel = arg(args, '--channel', 'stable');
    const specs = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--certify') specs.push(args[i + 1]);
    if (specs.length === 0) specs.push(DEFAULT_CERTIFY);
    certifications = specs.flatMap(parseCertify);
    sequence = Number(arg(args, '--sequence', '1'));
  }
  const privateKeyPem = readPrivateKey(dir, keyId);
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail('CONNECTOR_SIGN_SEQUENCE_INVALID', '--sequence invalid.');

  const pack = buildPack({
    issuer, keyId, channel, sequence, issuedAtMs: Date.now(), ttlDays, certifications,
  });
  const { envelope, digest } = signAndVerify({ pack, privateKeyPem, trustBundle, sequence });
  writeFileStrict(path.resolve(out), JSON.stringify(envelope, null, 2) + '\n', 0o644);
  process.stdout.write(JSON.stringify({
    ok: true, command: renew ? 'renew' : 'pack', out: path.resolve(out),
    issuer, keyId, channel, sequence, issuedAt: pack.issuedAt, expiresAt: pack.expiresAt, digest,
    certifications: certifications.map(c => `${c.providerId}/${c.serviceId}:${c.operation}(${c.authMethod})`),
    verified: 'verifyConnectorGlobalCertificationPack -> verified=true on this build',
  }, null, 2) + '\n');
}

const HELP = `Usage: node scripts/connectors-sign.mjs <command> [options]

Commands:
  keygen   Generate an Ed25519 owner key pair (private 0600, outside the repo).
           --dir <path>       key directory (default ~/.config/nassaj/connector-signing)
           --key-id <id>      key id (default owner-<random>)   --issuer <id>  (default nassaj-oss-owner)
           --force            overwrite an existing key

  trust    Emit an owner_import trust-bundle.json rooted in the public key.
           --dir --key-id --issuer   --out <file>   (required)
           --revision <n>     1 for first import; bump on rotation (default 1)
           --revoked a,b      revoked keyIds (rotation)   --valid-days <n>  (default 400)

  pack     Build + sign a build-bound global certification pack and self-verify it.
           --dir --key-id --issuer   --trust <bundle> --out <file>   (required)
           --certify provider:service:op1,op2,..:authMethod   (repeatable;
             default github:github:profile.configure,credential.verify,credential.use,placement.write:api_key)
           --channel stable   --sequence <n> (default 1)   --ttl-days <n> (<=30 stable, default 30)

  renew    Re-sign the current pack (same certifications) with a fresh expiry (T-1527).
           --dir --key-id --issuer   --trust <bundle> --in <old pack> --out <file>  (required)
           --sequence <n> (default prior+1)   --ttl-days <n> (default 30)

The private key is the operator's root of trust: keep it off the server and out of git.
`;

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') { process.stdout.write(HELP); return; }
  try {
    if (command === 'keygen') cmdKeygen(args);
    else if (command === 'trust') cmdTrust(args);
    else if (command === 'pack') cmdPack(args, { renew: false });
    else if (command === 'renew') cmdPack(args, { renew: true });
    else fail('CONNECTOR_SIGN_COMMAND_UNKNOWN', `Unknown command "${command}". Run --help.`);
  } catch (error) {
    if (error instanceof SignExit) return;
    process.stdout.write(`FAIL CONNECTOR_SIGN_UNEXPECTED: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 2;
  }
}

main();
