// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import zlib from 'node:zlib';

import { PINNED_VENDOR_DIGESTS } from '@/services/isolation/vendor-binary-integrity.js';

import { installCompatAsset, OPENCODE_COMPAT_ASSET, type ReleaseAssetSpec } from './opencode-asset.js';
import { hasErrorCode, type SnapshotErrorCode } from './snapshot/errors.js';
import { makeFixtureRoot, modeOf, removeFixture, writeFixtureFile } from './snapshot/__tests__/fixtures.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const BIN = Buffer.from('#!fake opencode 1.18.32\n'.repeat(40));
const START = 'https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-linux-x64.tar.gz';
const CDN = 'https://release-assets.githubusercontent.com/signed?x=1';

type Entry = { name: string; data?: Buffer; type?: string; prefix?: string; badSum?: boolean };

function header(e: Entry): Buffer {
  const b = Buffer.alloc(512);
  b.write(e.name, 0, 100);
  b.write('0000755\0', 100);
  b.write('0000000\0', 108);
  b.write('0000000\0', 116);
  b.write(`${(e.data?.length ?? 0).toString(8).padStart(11, '0')}\0`, 124);
  b.write('00000000000\0', 136);
  b.write('        ', 148);
  b.write(e.type ?? '0', 156);
  b.write('ustar\0', 257);
  b.write('00', 263);
  if (e.prefix) b.write(e.prefix, 345, 155);
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${(e.badSum ? sum + 1 : sum).toString(8).padStart(6, '0')}\0 `, 148);
  return b;
}

function tarGz(entries: Entry[], trailer = Buffer.alloc(1024)): Buffer {
  const parts = entries.flatMap((e) => {
    const data = e.data ?? Buffer.alloc(0);
    return [header(e), data, Buffer.alloc((512 - (data.length % 512)) % 512)];
  });
  return zlib.gzipSync(Buffer.concat([...parts, trailer]));
}

function specFor(gz: Buffer, over: Partial<ReleaseAssetSpec> = {}): ReleaseAssetSpec {
  return {
    ...OPENCODE_COMPAT_ASSET, url: START, size: gz.length, capBytes: 1 << 20,
    tarballSha256: sha(gz), binarySha256: sha(BIN), version: '1.18.32', maxUncompressedBytes: 1 << 16, ...over,
  };
}

/** fetch stub: url → response factory; records every requested url. */
function fakeFetch(routes: Record<string, () => Response>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const route = routes[url];
    return route ? route() : new Response('nope', { status: 404 });
  }) as typeof fetch;
}

const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });
const body = (gz: Buffer, length = gz.length) => () => new Response(gz, { status: 200, headers: { 'content-length': String(length) } });

let seq = 0;
async function run(gz: Buffer, opts: { spec?: Partial<ReleaseAssetSpec>; routes?: Record<string, () => Response>; version?: string } = {}) {
  seq += 1;
  const dest = path.join(root, `dest${seq}/opencode`);
  writeFixtureFile(dest, 'current-1.18.33', 0o755);
  const versions: string[] = [];
  const jobId = `job-${seq}`;
  const promise = installCompatAsset({
    jobId, destPath: dest, stagingParent: root, spec: specFor(gz, opts.spec),
    fetchImpl: fakeFetch(opts.routes ?? { [START]: redirect(CDN), [CDN]: body(gz) }),
    readVersion: (p) => { versions.push(p); return opts.version ?? '1.18.32'; },
  });
  return { promise, dest, versions, staging: path.join(root, `nassaj-harness-${jobId}`) };
}

async function refused(expected: SnapshotErrorCode, gz: Buffer, opts: Parameters<typeof run>[1] = {}) {
  const r = await run(gz, opts);
  await assert.rejects(r.promise, (e) => hasErrorCode(e, expected));
  assert.equal(fs.readFileSync(r.dest, 'utf8'), 'current-1.18.33', 'live binary untouched');
  assert.deepEqual(fs.readdirSync(path.dirname(r.dest)), ['opencode'], 'no temp left');
  assert.equal(fs.existsSync(r.staging), false, 'staging removed');
}

test('fixed asset constants: pin digest reused, allowlist and caps from the spec', () => {
  assert.equal(OPENCODE_COMPAT_ASSET.binarySha256, PINNED_VENDOR_DIGESTS.opencode.sha256);
  assert.equal(OPENCODE_COMPAT_ASSET.version, '1.18.32');
  assert.deepEqual([...OPENCODE_COMPAT_ASSET.allowedHosts], ['github.com', 'release-assets.githubusercontent.com']);
  assert.equal(OPENCODE_COMPAT_ASSET.size, 60_608_353);
  assert.equal(OPENCODE_COMPAT_ASSET.tarballSha256, '3046e0404fdc60fb80307e7a47824ba07477364178a4d09baa8548496dd6d43b');
  assert.equal(OPENCODE_COMPAT_ASSET.maxRedirects, 3);
  assert.equal(OPENCODE_COMPAT_ASSET.capBytes, 80 * 1024 * 1024);
  assert.equal(OPENCODE_COMPAT_ASSET.url, START);
});

test('happy path: redirect to the CDN, verified, version read in staging, renamed in 0755', async () => {
  const gz = tarGz([{ name: 'opencode', data: BIN }]);
  const r = await run(gz);
  await r.promise;
  assert.deepEqual(fs.readFileSync(r.dest), BIN);
  assert.equal(modeOf(r.dest), 0o755);
  assert.equal(r.versions.length, 1);
  assert.equal(path.dirname(r.versions[0]), r.staging, 'version read BEFORE rename, from staging');
  assert.equal(fs.existsSync(r.staging), false);
});

test('redirect to a foreign host or plain http is refused', async () => {
  const gz = tarGz([{ name: 'opencode', data: BIN }]);
  await refused('ASSET_HOST_NOT_ALLOWED', gz, { routes: { [START]: redirect('https://evil.example/x') } });
  await refused('ASSET_HOST_NOT_ALLOWED', gz, { routes: { [START]: redirect('http://github.com/x') } });
  await refused('ASSET_HOST_NOT_ALLOWED', gz, { routes: { [START]: redirect('https://github.com:8443/x') } });
});

test('more than 3 redirects, a non-200 and a redirect without location are refused', async () => {
  const gz = tarGz([{ name: 'opencode', data: BIN }]);
  const hop = (n: number) => `https://github.com/hop${n}`;
  await refused('ASSET_REDIRECT_LIMIT', gz, { routes: { [START]: redirect(hop(1)), [hop(1)]: redirect(hop(2)), [hop(2)]: redirect(hop(3)), [hop(3)]: redirect(hop(4)) } });
  await refused('ASSET_HTTP_STATUS', gz, { routes: { [START]: () => new Response('x', { status: 500 }) } });
  await refused('ASSET_HTTP_STATUS', gz, { routes: { [START]: () => new Response(null, { status: 302 }) } });
});

test('size checks: declared length, cap, streamed overrun and underrun', async () => {
  const gz = tarGz([{ name: 'opencode', data: BIN }]);
  await refused('ASSET_SIZE_MISMATCH', gz, { routes: { [START]: body(gz, gz.length - 1) } });
  await refused('ASSET_TOO_LARGE', gz, { spec: { capBytes: 10 }, routes: { [START]: body(gz) } });
  const longer = Buffer.concat([gz, Buffer.from('extra')]);
  await refused('ASSET_TOO_LARGE', gz, { routes: { [START]: body(longer, gz.length) } });
  await refused('ASSET_SIZE_MISMATCH', gz, { routes: { [START]: body(gz.subarray(0, 10), gz.length) } });
});

test('tarball digest mismatch is refused', async () => {
  const gz = tarGz([{ name: 'opencode', data: BIN }]);
  await refused('ASSET_DIGEST_MISMATCH', gz, { spec: { tarballSha256: '0'.repeat(64) } });
});

test('archive attacks: symlink, hard link, dir, pax header, ../, absolute, duplicate, other name', async () => {
  const cases: [SnapshotErrorCode, Entry[]][] = [
    ['ASSET_ENTRY_UNSAFE', [{ name: 'opencode', type: '2' }]],
    ['ASSET_ENTRY_UNSAFE', [{ name: 'opencode', type: '1' }]],
    ['ASSET_ENTRY_UNSAFE', [{ name: 'bin', type: '5' }]],
    ['ASSET_ENTRY_UNSAFE', [{ name: 'PaxHeader', type: 'x', data: Buffer.from('20 path=opencode\n') }]],
    ['ASSET_ENTRY_UNSAFE', [{ name: '../opencode', data: BIN }]],
    ['ASSET_ENTRY_UNSAFE', [{ name: '/opencode', data: BIN }]],
    ['ASSET_ENTRY_UNSAFE', [{ name: 'opencode', prefix: '..', data: BIN }]],
    ['ASSET_ENTRY_DUPLICATE', [{ name: 'opencode', data: BIN }, { name: 'opencode', data: BIN }]],
    ['ASSET_ENTRY_NAME_MISMATCH', [{ name: 'bin/opencode', data: BIN }]],
    ['ASSET_ENTRY_NAME_MISMATCH', [{ name: 'opencode', data: BIN }, { name: 'README', data: BIN }]],
    ['ASSET_ENTRY_NAME_MISMATCH', []],
  ];
  for (const [expected, entries] of cases) await refused(expected, tarGz(entries));
});

test('archive integrity: bad checksum, not gzip, truncated, trailing garbage, uncompressed cap', async () => {
  await refused('ASSET_ARCHIVE_INVALID', tarGz([{ name: 'opencode', data: BIN, badSum: true }]));
  await refused('ASSET_ARCHIVE_INVALID', Buffer.from('not a gzip stream at all'));
  const full = zlib.gunzipSync(tarGz([{ name: 'opencode', data: BIN }]));
  await refused('ASSET_ARCHIVE_INVALID', zlib.gzipSync(full.subarray(0, 700)));
  await refused('ASSET_ARCHIVE_INVALID', tarGz([{ name: 'opencode', data: BIN }], Buffer.concat([Buffer.alloc(1024), Buffer.from('junk')])));
  await refused('ASSET_TOO_LARGE', tarGz([{ name: 'opencode', data: BIN }]), { spec: { maxUncompressedBytes: 600 } });
});

test('extracted sha ≠ pin or wrong --version → nothing renamed', async () => {
  const other = tarGz([{ name: 'opencode', data: Buffer.from('a different build') }]);
  await refused('ASSET_DIGEST_MISMATCH', other);
  await refused('ASSET_VERSION_MISMATCH', tarGz([{ name: 'opencode', data: BIN }]), { version: '1.18.33' });
});

test('a pre-existing staging dir is refused and left alone', async () => {
  const gz = tarGz([{ name: 'opencode', data: BIN }]);
  const planted = path.join(root, 'nassaj-harness-planted');
  fs.mkdirSync(planted);
  await assert.rejects(installCompatAsset({
    jobId: 'planted', destPath: path.join(root, 'nowhere'), stagingParent: root, spec: specFor(gz),
    fetchImpl: fakeFetch({}), readVersion: () => '1.18.32',
  }));
  assert.equal(fs.existsSync(planted), true);
});
