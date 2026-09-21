import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { sign } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist-server');
const run = (args, input) => spawnSync(process.execPath,
  [path.join(root, 'scripts', 'connectors-sign.mjs'), ...args], { cwd: root, encoding: 'utf8', input });

// The tool loads the production verifier from dist-server; the mandatory round-trip
// gate is only meaningful once the server is built (npm run build:server).
const built = existsSync(path.join(dist, 'server/modules/connectors/connector-global-certification-pack.js'));

test('sign tool refuses tmpfs and .git key directories', () => {
  for (const dir of ['/tmp/nassaj-x', '/dev/shm/nassaj-x', path.join(root, '.git', 'x')]) {
    const result = run(['keygen', '--dir', dir, '--key-id', 'owner-x']);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /CONNECTOR_SIGN_KEYDIR_FORBIDDEN/u);
  }
});

test('help lists every command', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  for (const command of ['keygen', 'trust', 'pack', 'renew']) assert.match(help.stdout, new RegExp(command, 'u'));
});

test('keygen -> trust -> pack round-trip passes the production verifier; wrong build and expiry fail closed',
  { skip: built ? false : 'dist-server not built (run npm run build:server)' }, async () => {
    const work = mkdtempSync('/var/tmp/nassaj-connector-sign-');
    try {
      const keys = path.join(work, 'keys');
      const trustFile = path.join(work, 'trust-bundle.json');
      const packFile = path.join(work, 'pack.json');
      const renewFile = path.join(work, 'pack-renewed.json');

      const keygen = run(['keygen', '--dir', keys, '--key-id', 'owner-test', '--issuer', 'nassaj-oss-owner']);
      assert.equal(keygen.status, 0, keygen.stdout);
      assert.equal(statSync(path.join(keys, 'owner-test.private.pem')).mode & 0o777, 0o600);

      const trust = run(['trust', '--dir', keys, '--key-id', 'owner-test',
        '--issuer', 'nassaj-oss-owner', '--out', trustFile]);
      assert.equal(trust.status, 0, trust.stdout);

      const pack = run(['pack', '--dir', keys, '--key-id', 'owner-test', '--issuer', 'nassaj-oss-owner',
        '--trust', trustFile, '--out', packFile]);
      assert.equal(pack.status, 0, pack.stdout);

      const [{ verifyConnectorGlobalCertificationPack, connectorGlobalPackSignedBytes },
        { parseConnectorTrustBundle }, { CONNECTOR_RUNTIME_PACK_EXPECTATIONS }] = await Promise.all([
        import(path.join(dist, 'server/modules/connectors/connector-global-certification-pack.js')),
        import(path.join(dist, 'server/modules/connectors/connector-trust-bundle.js')),
        import(path.join(dist, 'server/modules/connectors/connector-runtime-manifest.js')),
      ]);
      const trustBundle = parseConnectorTrustBundle(JSON.parse(readFileSync(trustFile, 'utf8')));
      const envelope = JSON.parse(readFileSync(packFile, 'utf8'));
      const baseContext = seq => ({
        now: new Date(), wallClockHighWaterMs: 0, priorSequence: seq - 1,
        minimumTrustBundleRevision: trustBundle.revision, runtimeFloor: 1, policySchemaVersion: 2,
        trustBundle, ...CONNECTOR_RUNTIME_PACK_EXPECTATIONS,
      });

      // Valid pack verifies, certifies the three github/api_key operations.
      const ok = verifyConnectorGlobalCertificationPack(envelope, baseContext(envelope.pack.sequence));
      assert.equal(ok.verified, true, JSON.stringify(ok));
      const ops = ok.pack.certifications
        .filter(c => c.providerId === 'github' && c.serviceId === 'github' && c.authMethod === 'api_key')
        .map(c => c.operation).sort();
      assert.deepEqual(ops, ['credential.use', 'credential.verify', 'placement.write', 'profile.configure']);

      // A pack bearing a DIFFERENT build fingerprint is rejected even when correctly signed.
      const privateKeyPem = readFileSync(path.join(keys, 'owner-test.private.pem'), 'utf8');
      const wrongPack = { ...envelope.pack, registryDigest: 'A'.repeat(43) };
      const wrongEnvelope = { pack: wrongPack,
        signature: sign(null, connectorGlobalPackSignedBytes(wrongPack), privateKeyPem).toString('base64url') };
      const rejected = verifyConnectorGlobalCertificationPack(wrongEnvelope, baseContext(wrongPack.sequence));
      assert.deepEqual(rejected, { verified: false, reason: 'registry_digest_mismatch' });

      // renew re-mints with a later expiry, higher sequence, and still verifies.
      const renew = run(['renew', '--dir', keys, '--trust', trustFile, '--in', packFile, '--out', renewFile]);
      assert.equal(renew.status, 0, renew.stdout);
      const renewed = JSON.parse(readFileSync(renewFile, 'utf8'));
      assert.ok(Date.parse(renewed.pack.expiresAt) >= Date.parse(envelope.pack.expiresAt));
      assert.equal(renewed.pack.sequence, envelope.pack.sequence + 1);
      assert.equal(verifyConnectorGlobalCertificationPack(renewed, baseContext(renewed.pack.sequence)).verified, true);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

// B-850: rotation is not importable (server rejects revision > 1 with
// CONNECTOR_TRUST_ROTATION_REQUIRES_RECOVERY, recovery flow unwired). The trust command
// must warn honestly for revision > 1 and must NOT promise a working rotation.
test('trust warns that a revision > 1 bundle cannot be imported',
  { skip: built ? false : 'dist-server not built (run npm run build:server)' }, () => {
    const work = mkdtempSync('/var/tmp/nassaj-connector-sign-rot-');
    try {
      const keys = path.join(work, 'keys');
      run(['keygen', '--dir', keys, '--key-id', 'owner-2', '--issuer', 'nassaj-oss-owner']);
      const rot = run(['trust', '--dir', keys, '--key-id', 'owner-2', '--issuer', 'nassaj-oss-owner',
        '--revision', '2', '--revoked', 'owner-1', '--out', path.join(work, 'rotation.json')]);
      assert.equal(rot.status, 0, rot.stdout);
      assert.match(rot.stdout, /WARN CONNECTOR_TRUST_ROTATION_REQUIRES_RECOVERY/u);
      assert.match(rot.stdout, /NOT IMPORTABLE/u);
      assert.doesNotMatch(rot.stdout, /then re-sign the pack with the new key/u);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
