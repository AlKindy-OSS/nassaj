/**
 * opencode "restore compatible" asset install (T-1871 stage 3, spec §10,
 * qa condition 4).
 *
 * Downloads the pinned release tarball with a fixed URL, at most 3 redirects
 * and only across {github.com, release-assets.githubusercontent.com}; the
 * Content-Length AND the streamed byte count must equal the published size
 * (hard cap 80 MB) and the tarball sha256 must match. The archive is parsed
 * here (no external tar): exactly ONE regular entry named `opencode` is
 * accepted — links, devices, directories, PAX/GNU extension headers, absolute
 * or `..` names, duplicates and a different name all fail closed — with a
 * 300 MB uncompressed cap. The extracted binary must hash to the verified pin
 * and report the pinned `--version` BEFORE it is renamed over the live path.
 * Staging lives in `/var/tmp/nassaj-harness-<jobId>` (0700), removed in finally.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import { PINNED_VENDOR_DIGESTS } from '@/services/isolation/vendor-binary-integrity.js';

import { copyFileHashed, fsyncPath, hashFile } from './snapshot/durable-fs.js';
import { snapshotError } from './snapshot/errors.js';
import { assertJobId, restoreTempPath } from './snapshot/paths.js';

/** A fixed, code-owned release asset description. */
export interface ReleaseAssetSpec {
  url: string;
  allowedHosts: readonly string[];
  maxRedirects: number;
  size: number;
  capBytes: number;
  tarballSha256: string;
  entryName: string;
  binarySha256: string;
  version: string;
  maxUncompressedBytes: number;
}

/** opencode 1.17.18 linux-x64 (docs/ops/t1871-measurements.md §c). */
export const OPENCODE_COMPAT_ASSET: ReleaseAssetSpec = Object.freeze({
  url: 'https://github.com/anomalyco/opencode/releases/download/v1.17.18/opencode-linux-x64.tar.gz',
  allowedHosts: Object.freeze(['github.com', 'release-assets.githubusercontent.com']),
  maxRedirects: 3,
  size: 69_427_073,
  capBytes: 80 * 1024 * 1024,
  tarballSha256: 'e149d32ee5667c0cd5fb84d0bf8393b312e93782eeb4d74d29bbb0392de7133c',
  entryName: 'opencode',
  binarySha256: PINNED_VENDOR_DIGESTS.opencode.sha256,
  version: PINNED_VENDOR_DIGESTS.opencode.version,
  maxUncompressedBytes: 300 * 1024 * 1024,
});

/** Inputs of one install; `fetchImpl` and `readVersion` are injectable. */
export interface AssetInstallOptions {
  jobId: string;
  destPath: string;
  readVersion: (binaryPath: string) => string | null | Promise<string | null>;
  spec?: ReleaseAssetSpec;
  fetchImpl?: typeof fetch;
  stagingParent?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BLOCK = 512;
const INSTALLED_MODE = 0o755;

function assertAllowedUrl(raw: string, spec: ReleaseAssetSpec): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw snapshotError('ASSET_HOST_NOT_ALLOWED');
  }
  const ok = url.protocol === 'https:' && url.port === '' && !url.username && !url.password
    && spec.allowedHosts.includes(url.hostname);
  if (!ok) throw snapshotError('ASSET_HOST_NOT_ALLOWED');
}

/** Follows at most `maxRedirects` redirects, every hop on the allowlist; returns the 200. */
export async function fetchAllowed(spec: ReleaseAssetSpec, fetchImpl: typeof fetch): Promise<Response> {
  let url = spec.url;
  for (let hop = 0; ; hop += 1) {
    assertAllowedUrl(url, spec);
    const res = await fetchImpl(url, { redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) {
      if (res.status !== 200) throw snapshotError('ASSET_HTTP_STATUS');
      return res;
    }
    await res.body?.cancel();
    if (hop >= spec.maxRedirects) throw snapshotError('ASSET_REDIRECT_LIMIT');
    const location = res.headers.get('location');
    if (!location) throw snapshotError('ASSET_HTTP_STATUS');
    url = new URL(location, url).toString();
  }
}

/** Streams the body to `file` (0600) enforcing Content-Length, size, cap and tarball sha. */
export async function downloadVerified(res: Response, file: string, spec: ReleaseAssetSpec): Promise<void> {
  const declared = Number(res.headers.get('content-length'));
  if (!Number.isSafeInteger(declared) || declared > spec.capBytes) throw snapshotError('ASSET_TOO_LARGE');
  if (declared !== spec.size) throw snapshotError('ASSET_SIZE_MISMATCH');
  if (!res.body) throw snapshotError('ASSET_SIZE_MISMATCH');
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'wx', 0o600);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      received += r.value.length;
      if (received > spec.size || received > spec.capBytes) {
        await reader.cancel();
        throw snapshotError('ASSET_TOO_LARGE');
      }
      hash.update(r.value);
      fs.writeSync(fd, r.value);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (received !== spec.size) throw snapshotError('ASSET_SIZE_MISMATCH');
  if (hash.digest('hex') !== spec.tarballSha256) throw snapshotError('ASSET_DIGEST_MISMATCH');
}

function cString(buf: Buffer, start: number, end: number): string {
  const slice = buf.subarray(start, end);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
}

function octal(buf: Buffer, start: number, end: number): number {
  if (buf[start] & 0x80) throw snapshotError('ASSET_ARCHIVE_INVALID');
  const text = cString(buf, start, end).trim();
  if (!/^[0-7]+$/.test(text)) throw snapshotError('ASSET_ARCHIVE_INVALID');
  return parseInt(text, 8);
}

/** Parsed and validated ustar header: only a regular file with a safe name passes. */
export function parseTarHeader(block: Buffer): { name: string; size: number } {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  if (sum !== octal(block, 148, 156)) throw snapshotError('ASSET_ARCHIVE_INVALID');
  const type = String.fromCharCode(block[156]);
  if (type !== '0' && type !== '\0') throw snapshotError('ASSET_ENTRY_UNSAFE');
  const base = cString(block, 0, 100);
  const prefix = cString(block, 257, 262) === 'ustar' ? cString(block, 345, 500) : '';
  const name = prefix ? `${prefix}/${base}` : base;
  if (!name || path.isAbsolute(name) || name.split('/').includes('..')) throw snapshotError('ASSET_ENTRY_UNSAFE');
  return { name, size: octal(block, 124, 136) };
}

/** Writable tar consumer that extracts the single expected entry to `outFile`. */
class SingleEntryExtractor extends Writable {
  private pending = Buffer.alloc(0);
  private state: 'header' | 'body' | 'pad' | 'end' = 'header';
  private remaining = 0;
  private padding = 0;
  private total = 0;
  private entries = 0;
  private fd: number | null = null;

  constructor(private readonly outFile: string, private readonly spec: ReleaseAssetSpec) {
    super();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, done: (error?: Error | null) => void): void {
    try {
      this.total += chunk.length;
      if (this.total > this.spec.maxUncompressedBytes) throw snapshotError('ASSET_TOO_LARGE');
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.step()) { /* consume */ }
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  override _final(done: (error?: Error | null) => void): void {
    this.closeFd();
    const complete = this.state === 'end' && this.entries === 1;
    done(complete ? null : snapshotError(this.entries === 0 ? 'ASSET_ENTRY_NAME_MISMATCH' : 'ASSET_ARCHIVE_INVALID'));
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.closeFd();
    done(error);
  }

  private closeFd(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  /** Consumes one unit of `pending`; false when more input is needed. */
  private step(): boolean {
    if (this.state === 'end') {
      if (this.pending.some((b) => b !== 0)) throw snapshotError('ASSET_ARCHIVE_INVALID');
      this.pending = Buffer.alloc(0);
      return false;
    }
    if (this.state === 'body') return this.stepBody();
    if (this.state === 'pad') {
      const n = Math.min(this.padding, this.pending.length);
      this.pending = this.pending.subarray(n);
      this.padding -= n;
      if (this.padding === 0) this.state = 'header';
      return n > 0 && this.pending.length > 0;
    }
    if (this.pending.length < BLOCK) return false;
    this.stepHeader(this.pending.subarray(0, BLOCK));
    this.pending = this.pending.subarray(BLOCK);
    return true;
  }

  private stepHeader(block: Buffer): void {
    if (block.every((b) => b === 0)) {
      this.state = 'end';
      return;
    }
    const { name, size } = parseTarHeader(block);
    if (name !== this.spec.entryName) throw snapshotError('ASSET_ENTRY_NAME_MISMATCH');
    if (this.entries > 0) throw snapshotError('ASSET_ENTRY_DUPLICATE');
    if (size > this.spec.maxUncompressedBytes) throw snapshotError('ASSET_TOO_LARGE');
    this.entries += 1;
    this.fd = fs.openSync(this.outFile, 'wx', 0o700);
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    this.state = size > 0 ? 'body' : 'header';
    if (size === 0) this.closeFd();
  }

  private stepBody(): boolean {
    const n = Math.min(this.remaining, this.pending.length);
    if (n === 0) return false;
    fs.writeSync(this.fd as number, this.pending, 0, n);
    this.pending = this.pending.subarray(n);
    this.remaining -= n;
    if (this.remaining === 0) {
      fs.fsyncSync(this.fd as number);
      this.closeFd();
      this.state = this.padding > 0 ? 'pad' : 'header';
    }
    return this.pending.length > 0;
  }
}

/** Gunzips `tarball` and extracts its single `spec.entryName` entry to `outFile`. */
export async function extractSingleEntry(tarball: string, outFile: string, spec: ReleaseAssetSpec): Promise<void> {
  try {
    await pipeline(fs.createReadStream(tarball), zlib.createGunzip(), new SingleEntryExtractor(outFile, spec));
  } catch (error) {
    if ((error as { code?: string }).code?.startsWith('ASSET_')) throw error;
    throw snapshotError('ASSET_ARCHIVE_INVALID');
  }
}

function makeStagingDir(parent: string, jobId: string): string {
  const dir = path.join(parent, `nassaj-harness-${jobId}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) {
    throw new Error('staging directory is not private');
  }
  return dir;
}

async function verifyExtracted(bin: string, spec: ReleaseAssetSpec, readVersion: AssetInstallOptions['readVersion']): Promise<void> {
  if (hashFile(bin).sha256 !== spec.binarySha256) throw snapshotError('ASSET_DIGEST_MISMATCH');
  if ((await readVersion(bin)) !== spec.version) throw snapshotError('ASSET_VERSION_MISMATCH');
}

function installOver(bin: string, dest: string, jobId: string, sha: string): void {
  const tmp = restoreTempPath(dest, jobId);
  fs.rmSync(tmp, { force: true });
  try {
    if (copyFileHashed(bin, tmp, INSTALLED_MODE).sha256 !== sha) throw snapshotError('ASSET_DIGEST_MISMATCH');
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fsyncPath(path.dirname(dest));
}

/**
 * Downloads, verifies and installs the compatible opencode binary over
 * `destPath`. Nothing touches `destPath` unless every check passed.
 */
export async function installCompatAsset(opts: AssetInstallOptions): Promise<void> {
  assertJobId(opts.jobId);
  const spec = opts.spec ?? OPENCODE_COMPAT_ASSET;
  const staging = makeStagingDir(opts.stagingParent ?? '/var/tmp', opts.jobId);
  try {
    const res = await fetchAllowed(spec, opts.fetchImpl ?? fetch);
    const tarball = path.join(staging, 'asset.tar.gz');
    await downloadVerified(res, tarball, spec);
    const bin = path.join(staging, spec.entryName);
    await extractSingleEntry(tarball, bin, spec);
    await verifyExtracted(bin, spec, opts.readVersion);
    installOver(bin, opts.destPath, opts.jobId, spec.binarySha256);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
