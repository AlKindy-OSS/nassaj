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
 * The minting/crypto/key-custody logic lives in the shared, server-side module
 * `connector-signing-core` (compiled to dist-server) so the boot auto-setup
 * (ADR-162, T-1831) reuses one implementation instead of duplicating it. This
 * script is the CLI adapter: argument parsing, file I/O, and human output only.
 *
 * Note: the headless owner-auth refusal in connectors-trust.mjs / connectors-setup.mjs
 * is intentional and untouched. This tool only PRODUCES artifacts on disk; importing
 * them into a live installation still goes through the browser owner Setup handlers.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DIST = path.join(REPO_ROOT, 'dist-server');

// Runs at import time, outside main()'s catch, so it refuses with exit 2 directly.
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

const core = await import(need('server/modules/connectors/connector-signing-core.js'));

const {
  ConnectorSigningError, CONNECTOR_SIGNING_DEFAULT_CERTIFY,
  assertSafeConnectorKeyDir, validateConnectorSigningId,
  connectorPrivateKeyPath, connectorPublicKeyPath, connectorPublicKeyFingerprint,
  writeConnectorSigningFile, readConnectorPrivateKey, generateConnectorEd25519KeyPair,
  parseConnectorCertifySpec, buildConnectorTrustBundle, buildConnectorGlobalPack,
  signAndVerifyConnectorGlobalPack, loadConnectorTrustBundle, connectorTrustBundleDigestB64u,
} = core;

class SignExit extends Error {}
function fail(code, detail) {
  process.stdout.write(`FAIL ${code}: ${detail}\n`);
  process.exitCode = 2;
  throw new SignExit(code);
}

const GIT_DIR = path.join(REPO_ROOT, '.git');
const DEFAULT_KEY_DIR = path.join(os.homedir(), '.config', 'nassaj', 'connector-signing');

const arg = (args, flag, fallback = null) => {
  const at = args.indexOf(flag);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
};
const has = (args, flag) => args.includes(flag);
const safeDir = raw => assertSafeConnectorKeyDir(arg(raw, '--dir', DEFAULT_KEY_DIR), GIT_DIR);

function readJsonFile(p, label) {
  const stat = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) fail('CONNECTOR_SIGN_INPUT_MISSING', `No ${label} file at ${p}.`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { fail('CONNECTOR_SIGN_INPUT_JSON_INVALID', `${label} at ${p} is not valid JSON.`); }
}

// --- commands -----------------------------------------------------------------

function cmdKeygen(args) {
  const dir = safeDir(args);
  const keyId = validateConnectorSigningId(arg(args, '--key-id', `owner-${createHash('sha256')
    .update(String(Date.now()) + Math.random()).digest('hex').slice(0, 12)}`), 'key-id');
  const issuer = validateConnectorSigningId(arg(args, '--issuer', 'nassaj-oss-owner'), 'issuer');
  const priv = connectorPrivateKeyPath(dir, keyId);
  const pub = connectorPublicKeyPath(dir, keyId);
  if (!has(args, '--force') && (fs.existsSync(priv) || fs.existsSync(pub))) {
    fail('CONNECTOR_SIGN_KEY_EXISTS', `Key ${keyId} already exists in ${dir}; pass --force to overwrite.`);
  }
  const { privateKeyPem, publicKeyPem } = generateConnectorEd25519KeyPair();
  writeConnectorSigningFile(priv, privateKeyPem, 0o600);
  writeConnectorSigningFile(pub, publicKeyPem, 0o644);
  process.stdout.write(JSON.stringify({
    ok: true, command: 'keygen', keyId, issuer,
    fingerprintSha256: connectorPublicKeyFingerprint(publicKeyPem), privateKeyPath: priv, publicKeyPath: pub,
  }, null, 2) + '\n');
}

function cmdTrust(args) {
  const dir = safeDir(args);
  const keyId = validateConnectorSigningId(arg(args, '--key-id'), 'key-id');
  const issuer = validateConnectorSigningId(arg(args, '--issuer', 'nassaj-oss-owner'), 'issuer');
  const out = arg(args, '--out');
  if (!out) fail('CONNECTOR_SIGN_ARGUMENT_INVALID', '--out <trust-bundle.json> is required.');
  const revision = Number(arg(args, '--revision', '1'));
  const validDays = Number(arg(args, '--valid-days', '400'));
  const revokedRaw = arg(args, '--revoked', '');
  const revokedKeyIds = revokedRaw ? revokedRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const pubStat = fs.lstatSync(connectorPublicKeyPath(dir, keyId), { throwIfNoEntry: false });
  if (!pubStat) fail('CONNECTOR_SIGN_KEY_MISSING', `No public key for ${keyId} in ${dir}. Run keygen first.`);
  const publicKeyPem = fs.readFileSync(connectorPublicKeyPath(dir, keyId), 'utf8');
  const bundle = buildConnectorTrustBundle({ issuer, keyId, publicKeyPem, revision, validDays,
    revokedKeyIds, nowMs: Date.now() });
  writeConnectorSigningFile(path.resolve(out), JSON.stringify(bundle, null, 2) + '\n', 0o644);
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
    revokedKeyIds, digest: connectorTrustBundleDigestB64u(bundle),
    note: revision === 1
      ? 'First import: owner Setup requires revision 1 (rotation needs the recovery flow).'
      : 'NOT IMPORTABLE: owner Setup rejects revision > 1 with CONNECTOR_TRUST_ROTATION_REQUIRES_RECOVERY '
        + '(409); rotation is unavailable until the recovery flow is wired.',
  }, null, 2) + '\n');
}

function cmdPack(args, { renew = false } = {}) {
  const dir = safeDir(args);
  const trustFile = arg(args, '--trust');
  if (!trustFile) fail('CONNECTOR_SIGN_ARGUMENT_INVALID', '--trust <trust-bundle.json> is required.');
  const out = arg(args, '--out');
  if (!out) fail('CONNECTOR_SIGN_ARGUMENT_INVALID', '--out <pack.json> is required.');
  const trustBundle = loadConnectorTrustBundle(readJsonFile(path.resolve(trustFile), 'trust bundle'));
  const ttlDays = Number(arg(args, '--ttl-days', '30'));

  let issuer; let keyId; let channel; let certifications; let sequence;
  if (renew) {
    // Re-mint the current pack: inherit issuer/key/channel/certifications, refresh expiry (T-1527).
    const prior = readJsonFile(path.resolve(arg(args, '--in')), 'existing pack');
    if (!prior || typeof prior !== 'object' || !prior.pack) {
      fail('CONNECTOR_SIGN_INPUT_JSON_INVALID', '--in must be a signed pack envelope {pack, signature}.');
    }
    issuer = validateConnectorSigningId(prior.pack.issuerId, 'issuer');
    keyId = validateConnectorSigningId(prior.pack.signingKeyId, 'key-id');
    channel = prior.pack.channel;
    certifications = prior.pack.certifications;
    const priorSeq = Number(prior.pack.sequence);
    sequence = Number(arg(args, '--sequence', String(priorSeq + 1)));
    if (sequence <= priorSeq) {
      fail('CONNECTOR_SIGN_SEQUENCE_INVALID', `renew sequence ${sequence} must exceed prior ${priorSeq}.`);
    }
  } else {
    keyId = validateConnectorSigningId(arg(args, '--key-id'), 'key-id');
    issuer = validateConnectorSigningId(arg(args, '--issuer', 'nassaj-oss-owner'), 'issuer');
    channel = arg(args, '--channel', 'stable');
    const specs = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--certify') specs.push(args[i + 1]);
    if (specs.length === 0) specs.push(CONNECTOR_SIGNING_DEFAULT_CERTIFY);
    certifications = specs.flatMap(parseConnectorCertifySpec);
    sequence = Number(arg(args, '--sequence', '1'));
  }
  const privateKeyPem = readConnectorPrivateKey(dir, keyId);
  const pack = buildConnectorGlobalPack({ issuer, keyId, channel, sequence,
    issuedAtMs: Date.now(), ttlDays, certifications });
  const { envelope, digest } = signAndVerifyConnectorGlobalPack({ pack, privateKeyPem, trustBundle, sequence });
  writeConnectorSigningFile(path.resolve(out), JSON.stringify(envelope, null, 2) + '\n', 0o644);
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
    if (error instanceof ConnectorSigningError) {
      process.stdout.write(`FAIL ${error.code}: ${error.detail}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`FAIL CONNECTOR_SIGN_UNEXPECTED: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 2;
  }
}

main();
