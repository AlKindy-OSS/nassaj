/**
 * Claude release verification for the owner CLI install (ADR-215 stage B,
 * conditions ش1–ش3, I-2, I-3). Takes the vendor's own path — `latest`, then
 * `<v>/manifest.json`, then `<v>/<platform>/claude` — and adds what the
 * vendor's bootstrap.sh does not: the detached GPG signature over the
 * manifest is checked with `gpgv` against a vendored binary keyring, and the
 * status stream must carry `VALIDSIG <pinned 40-hex fingerprint>`. The JSON
 * is parsed only from the exact bytes gpgv verified. `manifest.zst.json` is
 * ignored (I-2).
 */

import fs from 'node:fs';
import path from 'node:path';

import { readCapped } from './bounded-fetch.js';
import type { OwnedPath } from './install-sources.js';
import { CLAUDE_SIGNING_FINGERPRINT, CLAUDE_SIGNING_KEYRING_BASE64 } from './claude-signing-key.js';
import { fetchAllowed } from './opencode-asset.js';
import type { RunCommandOptions } from './run-command.js';
import type { RunResult } from './update-jobs.js';

/** The signed-manifest install source of claude. */
export interface SignedManifestSource {
  kind: 'signed-manifest';
  /** Release bucket; `{base}/latest`, `{base}/{v}/manifest.json[.sig]`, `{base}/{v}/{platform}/claude`. */
  baseUrl: string;
  allowedHosts: readonly string[];
  maxRedirects: number;
  keyFingerprint: string;
  keyringBase64: string;
  /** Oldest release with a published manifest signature (2.1.89). */
  minSignedVersion: string;
  /** Cap of `latest`, the manifest and the signature (ش3: ≤ 64 KB). */
  smallCapBytes: number;
  /** Cap of the platform binary (manifest `size` must also fit). */
  binaryCapBytes: number;
  /** `<binary> install <v>` process timeout. */
  timeoutMs: number;
  /** Free bytes required in HOME and in the staging parent. */
  minFreeBytes: number;
  /** The launcher symlink and the version file this install may create. */
  ownedPaths: (home: string, version: string) => readonly OwnedPath[];
}

/** A typed verification failure; `jobCode` is the install job error code. */
export class SignedManifestError extends Error {
  constructor(readonly jobCode: 'script_rejected' | 'verifier_unavailable', readonly cause: string) {
    super(cause);
  }
}

const reject = (cause: string) => new SignedManifestError('script_rejected', cause);
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;

/** True when `a` ≥ `b` (both plain x.y.z). */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i += 1) {
    if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]);
  }
  return true;
}

/** Facts the platform name is derived from (injectable for tests). */
export interface PlatformFacts {
  platform: NodeJS.Platform;
  arch: string;
  /** True on a musl libc (no glibc runtime reported). */
  musl: boolean;
}

/** Live platform facts: musl when node reports no glibc runtime version. */
export function currentPlatformFacts(): PlatformFacts {
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return { platform: process.platform, arch: process.arch, musl: process.platform === 'linux' && !report?.header?.glibcVersionRuntime };
}

/** I-3: the ONE detector of the vendor platform name, or null when unsupported. */
export function detectClaudePlatform(facts: PlatformFacts): string | null {
  const arch = facts.arch === 'x64' ? 'x64' : facts.arch === 'arm64' ? 'arm64' : null;
  if (!arch) return null;
  if (facts.platform === 'darwin') return `darwin-${arch}`;
  if (facts.platform === 'linux') return `linux-${arch}${facts.musl ? '-musl' : ''}`;
  return null;
}

/** Fetches a small body (latest pointer, manifest, signature) under the host allowlist. */
async function fetchSmall(source: SignedManifestSource, url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<Buffer> {
  try {
    const res = await fetchAllowed({ url, allowedHosts: source.allowedHosts, maxRedirects: source.maxRedirects }, fetchImpl, signal);
    const body = Buffer.from(await readCapped(res, source.smallCapBytes, signal));
    if (body.length === 0) throw reject('empty_body');
    return body;
  } catch (error) {
    if (error instanceof SignedManifestError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    throw reject(code === 'ASSET_DOWNLOAD_TIMEOUT' ? 'download_timeout' : typeof code === 'string' ? code : 'download_failed');
  }
}

/** Reads `latest`; it must be a plain x.y.z at or above the first signed release. */
export async function fetchLatestVersion(source: SignedManifestSource, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string> {
  const version = (await fetchSmall(source, `${source.baseUrl}/latest`, fetchImpl, signal)).toString('utf8').trim();
  if (!VERSION.test(version)) throw reject('bad_version');
  if (!versionAtLeast(version, source.minSignedVersion)) throw reject('below_min_signed');
  return version;
}

/**
 * ش3: true only when gpgv's status stream has a VALIDSIG whose primary-key
 * fingerprint (its last field) equals the full pinned `fingerprint`, and no
 * BADSIG/ERRSIG/EXPKEYSIG/REVKEYSIG/EXPSIG/NO_PUBKEY line.
 */
export function gpgvStatusValid(stdout: string, fingerprint: string): boolean {
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('[GNUPG:] '));
  if (lines.some((l) => /^\[GNUPG:\] (?:BADSIG|ERRSIG|EXPKEYSIG|REVKEYSIG|EXPSIG|NO_PUBKEY)\b/u.test(l))) return false;
  // VALIDSIG <sig-fpr> <date> <ts> <expire> <ver> <reserved> <pk-algo> <hash-algo> <class> <primary-fpr>
  return lines.some((l) => {
    const parts = l.split(' ');
    return parts[1] === 'VALIDSIG' && parts.length === 12 && parts[11] === fingerprint;
  });
}

/** Everything verifySignature reaches outside its logic. */
export interface GpgvDeps {
  gpgvPath: () => string | null;
  runCommand: (cmd: string, args: string[], opts: RunCommandOptions) => Promise<RunResult>;
}

/** Writes manifest, signature and keyring into `dir` and runs gpgv with a fixed argv. */
export async function verifyManifestSignature(
  source: SignedManifestSource,
  dir: string,
  manifest: Buffer,
  signature: Buffer,
  deps: GpgvDeps,
): Promise<void> {
  const gpgv = deps.gpgvPath();
  if (!gpgv) throw new SignedManifestError('verifier_unavailable', 'gpgv_missing');
  const files = { manifest: path.join(dir, 'manifest.json'), sig: path.join(dir, 'manifest.json.sig'), keyring: path.join(dir, 'k.gpg') };
  fs.writeFileSync(files.manifest, manifest, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(files.sig, signature, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(files.keyring, Buffer.from(source.keyringBase64, 'base64'), { mode: 0o600, flag: 'wx' });
  const result = await deps.runCommand(gpgv, ['--homedir', dir, '--keyring', files.keyring, '--status-fd', '1',
    files.sig, files.manifest], { env: { PATH: '/usr/bin:/bin', HOME: dir, LANG: 'C' }, cwd: dir, timeoutMs: 60_000 });
  if (result.timedOut) throw reject('gpgv_timeout');
  if (result.code !== 0 || !gpgvStatusValid(result.stdout, source.keyFingerprint)) throw reject('bad_signature');
}

/** The verified release facts of one platform. */
export interface VerifiedRelease {
  version: string;
  platform: string;
  checksum: string;
  size: number;
}

/** Parses the VERIFIED manifest bytes: version must equal the request, platform entry well-formed. */
export function parseVerifiedManifest(
  verified: Buffer,
  requested: string,
  platform: string,
  binaryCapBytes: number,
): VerifiedRelease {
  let json: unknown;
  try {
    json = JSON.parse(verified.toString('utf8'));
  } catch {
    throw reject('manifest_invalid');
  }
  const doc = json as { version?: unknown; platforms?: Record<string, { checksum?: unknown; size?: unknown }> };
  if (doc?.version !== requested) throw reject('version_mismatch');
  const entry = doc.platforms && Object.hasOwn(doc.platforms, platform) ? doc.platforms[platform] : undefined;
  if (!entry) throw reject('platform_missing');
  const { checksum, size } = entry;
  if (typeof checksum !== 'string' || !/^[0-9a-f]{64}$/u.test(checksum)) throw reject('manifest_invalid');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > binaryCapBytes) {
    throw reject('manifest_invalid');
  }
  return { version: requested, platform, checksum, size };
}

/**
 * ش1/ش3: resolves the latest signed release for `platform`. The manifest
 * and signature are fetched, gpgv-verified in `dir`, then parsed.
 */
export async function resolveSignedRelease(
  source: SignedManifestSource,
  input: { dir: string; platform: string | null; fetchImpl: typeof fetch; signal: AbortSignal; gpgv: GpgvDeps },
): Promise<VerifiedRelease> {
  if (!input.platform) throw reject('platform_unsupported');
  const version = await fetchLatestVersion(source, input.fetchImpl, input.signal);
  const manifestUrl = `${source.baseUrl}/${version}/manifest.json`;
  const manifest = await fetchSmall(source, manifestUrl, input.fetchImpl, input.signal);
  const signature = await fetchSmall(source, `${manifestUrl}.sig`, input.fetchImpl, input.signal);
  await verifyManifestSignature(source, input.dir, manifest, signature, input.gpgv);
  return parseVerifiedManifest(manifest, version, input.platform, source.binaryCapBytes);
}

/** The binary URL of a verified release. */
export function binaryUrl(source: SignedManifestSource, release: VerifiedRelease): string {
  return `${source.baseUrl}/${release.version}/${release.platform}/claude`;
}

/** Absolute gpgv from fixed locations only (never a PATH lookup); null when absent. */
export function findGpgv(candidates: readonly string[] = ['/usr/bin/gpgv', '/bin/gpgv']): string | null {
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The pinned key material (re-exported for the descriptor). */
export const CLAUDE_KEY = Object.freeze({ fingerprint: CLAUDE_SIGNING_FINGERPRINT, keyringBase64: CLAUDE_SIGNING_KEYRING_BASE64 });
