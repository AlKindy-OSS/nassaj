import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    assertAssetDigest, assertManifestAttested, hashFile, manifestAssetEntry, sha256Hex, subjectDigestMap,
    verifyAssetFile,
} from './release-digests.mjs';
import { ReleaseManifestError } from './release-manifest-codes.mjs';
import { parseReleaseManifest, serializeReleaseManifest } from './release-manifest.mjs';
import { digest, manifestFixture } from './release-manifest.test.fixture.mjs';

const code = expected => error => error instanceof ReleaseManifestError && error.code === expected;
const subject = (name, sha256) => ({ name, digest: { sha256 } });
const scratch = () => fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TMP ?? os.tmpdir(), 'release-digests-'));

/** Manifest whose installer entry matches `bytes`, plus subjects binding everything. */
function boundRelease(bytes) {
    const manifest = manifestFixture({ installer: { name: 'nassaj-install.mjs', size: bytes.length, sha256: sha256Hex(bytes) } });
    const parsed = parseReleaseManifest(serializeReleaseManifest(manifest));
    const subjects = [
        subject('release-manifest.json', parsed.sha256),
        subject(manifest.installer.name, manifest.installer.sha256),
        subject(manifest.targets[0].archive.name, manifest.targets[0].archive.sha256),
    ];
    return { manifest: parsed.manifest, sha256: parsed.sha256, subjects };
}

test('sha256Hex is canonical lowercase hex', () => {
    assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.throws(() => sha256Hex('abc'), TypeError);
});

test('subject list must be well formed and unambiguous', () => {
    assert.throws(() => subjectDigestMap([]), code('manifest_not_attested'));
    assert.throws(() => subjectDigestMap(null), code('manifest_not_attested'));
    assert.throws(() => subjectDigestMap([{ name: 'a' }]), code('manifest_not_attested'));
    assert.throws(() => subjectDigestMap([subject('a', 'A'.repeat(64))]), code('manifest_not_attested'));
    assert.throws(() => subjectDigestMap([subject(1, digest('a'))]), code('manifest_not_attested'));
    assert.throws(() => subjectDigestMap([subject('a', digest('a')), subject('a', digest('b'))]),
        code('manifest_not_attested'));
    assert.equal(subjectDigestMap([subject('a', digest('a')), subject('a', digest('a'))]).get('a'), digest('a'));
});

test('manifest must be an attestation subject by its exact digest (rule 4)', () => {
    const { sha256, subjects } = boundRelease(Buffer.from('installer'));
    assert.doesNotThrow(() => assertManifestAttested(sha256, subjects));
    assert.throws(() => assertManifestAttested(digest('9'), subjects), code('manifest_not_attested'));
    assert.throws(() => assertManifestAttested(sha256, subjects.slice(1)), code('manifest_not_attested'));
    assert.throws(() => assertManifestAttested(undefined, subjects), code('manifest_not_attested'));
    const renamed = [subject('other.json', sha256), ...subjects.slice(1)];
    assert.throws(() => assertManifestAttested(sha256, renamed), code('manifest_not_attested'));
});

test('asset digest must equal manifest entry and subject', () => {
    const bytes = Buffer.from('installer');
    const { manifest, subjects } = boundRelease(bytes);
    const observed = { size: bytes.length, sha256: sha256Hex(bytes) };
    const name = 'nassaj-install.mjs';
    assert.equal(assertAssetDigest({ manifest, subjects, name, observed }).name, name);
    assert.throws(() => manifestAssetEntry(manifest, 'unknown.tar'), code('artifact_digest_mismatch'));
    const cases = [
        { observed: { ...observed, sha256: digest('0') } },
        { observed: { ...observed, size: observed.size + 1 } },
        { observed: undefined },
        { subjects: subjects.filter(entry => entry.name !== name) },
        { subjects: subjects.map(entry => (entry.name === name ? subject(name, digest('0')) : entry)) },
    ];
    for (const override of cases) {
        assert.throws(() => assertAssetDigest({ manifest, subjects, name, observed, ...override }),
            code('artifact_digest_mismatch'));
    }
    const archive = manifest.targets[0].archive;
    assert.throws(() => assertAssetDigest({ manifest, subjects, name: archive.name, observed }),
        code('artifact_digest_mismatch'));
});

test('file hashing binds downloaded bytes and refuses tampering, growth and symlinks', () => {
    const dir = scratch();
    const bytes = Buffer.from('installer bytes');
    const { manifest, subjects } = boundRelease(bytes);
    const file = path.join(dir, 'nassaj-install.mjs');
    fs.writeFileSync(file, bytes);
    assert.deepEqual(hashFile(file), { size: bytes.length, sha256: sha256Hex(bytes) });
    assert.equal(verifyAssetFile({ manifest, subjects, name: 'nassaj-install.mjs', file }).size, bytes.length);
    fs.writeFileSync(file, Buffer.from('installer bytez'));
    assert.throws(() => verifyAssetFile({ manifest, subjects, name: 'nassaj-install.mjs', file }),
        code('artifact_digest_mismatch'));
    fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from('!')]));
    assert.throws(() => verifyAssetFile({ manifest, subjects, name: 'nassaj-install.mjs', file }),
        code('artifact_digest_mismatch'));
    const link = path.join(dir, 'link.mjs');
    fs.symlinkSync(file, link);
    assert.throws(() => hashFile(link), code('artifact_digest_mismatch'));
    assert.throws(() => hashFile(dir), code('artifact_digest_mismatch'));
    assert.throws(() => hashFile(path.join(dir, 'missing')), { code: 'ENOENT' });
    fs.rmSync(dir, { recursive: true, force: true });
});
