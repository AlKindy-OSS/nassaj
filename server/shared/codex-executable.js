import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/*
 * T-1872: Nassaj launches the MACHINE-installed Codex CLI (the standalone
 * release that `~/.local/bin/codex` points at), never the npm copy bundled next
 * to @openai/codex-sdk. The SDK stays as the library; only its binary changes.
 *
 * One launch = one frozen identity (acquireCodexLaunchIdentity). That object is
 * what permission admission fingerprints and what the launch site executes; the
 * launch re-stats it (assertCodexIdentityUnchanged) right before the effect so a
 * release swapped or edited in between refuses instead of running unmeasured
 * bytes. The executable path is always the realpath INSIDE the versioned release
 * directory, so re-pointing `current` after measurement cannot change what runs.
 *
 * This module must stay self-contained (no project imports): release and
 * measurement tests copy it alone into compiled runtime roots.
 */

const triples = Object.freeze({
  'linux:x64': 'x86_64-unknown-linux-musl', 'linux:arm64': 'aarch64-unknown-linux-musl',
  'darwin:x64': 'x86_64-apple-darwin', 'darwin:arm64': 'aarch64-apple-darwin',
  'win32:x64': 'x86_64-pc-windows-msvc', 'win32:arm64': 'aarch64-pc-windows-msvc',
});

export const CODEX_MACHINE_CLI_MISSING = 'CODEX_MACHINE_CLI_MISSING';
export const CODEX_RUNTIME_CHANGED = 'CODEX_RUNTIME_CHANGED';
/** User-facing text for a host without the machine Codex CLI (Arabic / English). */
export const CODEX_MACHINE_CLI_MISSING_MESSAGE = 'Codex غير مثبّت على الجهاز؛ ثبّته بالطريقة الرسمية في ~/.local/bin/codex أو اضبط CODEX_PATH'
  + ' / Codex is not installed on this machine; install it officially at ~/.local/bin/codex or set CODEX_PATH';

/** Only the release's own root alias may be a symlink, and only to its entrypoint. */
const ROOT_ALIAS = Object.freeze({ name: 'codex', target: 'bin/codex' });
const RESOLUTION_CHAIN = Object.freeze([fileURLToPath(import.meta.url)]);

const codexError = code => Object.assign(new Error(code), { code });

/** True when an error means "no machine Codex CLI to run" (show the install hint). */
export const isCodexMachineCliMissing = error => error?.code === CODEX_MACHINE_CLI_MISSING
  || error?.message === CODEX_MACHINE_CLI_MISSING;

const digestCache = new Map();
const DIGEST_CACHE_LIMIT = 512;
const fileIdentity = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode']
  .map(key => String(stat[key])).join(':');
const sha256 = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const byCodePoint = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** Hash stable file bytes; cache only a full inode identity, checking every admission. */
export function codexFileDigest(filename, cachePolicy = {}) {
  try { return readStableFileDigest(filename, cachePolicy); } catch (error) {
    // Forget only the failing file; the other sealed digests stay valid (qa I5).
    digestCache.delete(filename);
    try { digestCache.delete(fs.realpathSync(filename)); } catch { /* Already gone. */ }
    throw error;
  }
}

function readStableFileDigest(filename, {
  platform = process.platform, wallNow = Date.now, monotonicNow = () => performance.now(),
  filesystemType = canonical => fs.statfsSync(canonical).type,
}) {
  const canonical = fs.realpathSync(filename);
  const beforeStat = fs.statSync(canonical, { bigint: true });
  if (!beforeStat.isFile()) { digestCache.delete(canonical); throw new Error('PERMISSION_CODEX_FILE_INVALID'); }
  const before = fileIdentity(beforeStat);
  const cached = digestCache.get(canonical);
  // Only the local ext filesystem timestamp contract is covered by this cache.
  let cacheAllowed = false;
  try { cacheAllowed = platform === 'linux' && filesystemType(canonical) === 0xef53; } catch { /* Hash on unsupported filesystems. */ }
  const now = monotonicNow();
  const stableBefore = BigInt(wallNow() - 2000) * 1000000n;
  if (cacheAllowed && cached?.identity === before && now - cached.observedAt >= 2000
    && beforeStat.ctimeNs <= stableBefore && beforeStat.mtimeNs <= stableBefore) return cached.digest;
  digestCache.delete(canonical);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(canonical, 'r');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    if (fileIdentity(fs.fstatSync(fd, { bigint: true })) !== before) throw new Error('PERMISSION_CODEX_FILE_CHANGED');
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    if (fileIdentity(fs.fstatSync(fd, { bigint: true })) !== before
      || fileIdentity(fs.statSync(canonical, { bigint: true })) !== before) throw new Error('PERMISSION_CODEX_FILE_CHANGED');
    const result = `sha256:${hash.digest('hex')}`;
    digestCache.delete(canonical);
    if (cacheAllowed) digestCache.set(canonical, { identity: before, digest: result,
      observedAt: cached?.identity === before && cached.digest === result ? cached.observedAt : now });
    if (digestCache.size > DIGEST_CACHE_LIMIT) digestCache.delete(digestCache.keys().next().value);
    return result;
  } finally { fs.closeSync(fd); }
}

/**
 * Locate the SDK *library* module this runtime imports. Used only to bind the
 * SDK source bytes into the build fingerprint — never to locate a binary.
 */
export const resolveCodexSdkSourceEntry = () => fileURLToPath(import.meta.resolve('@openai/codex-sdk'));

/**
 * The machine launcher path: server-process CODEX_PATH (absolute only), else
 * ~/.local/bin/codex. Deliberately takes no env argument — a member's resolved
 * provider env can never redirect the binary. No PATH lookup, no bundled copy.
 */
export function codexMachineLauncherPath() {
  const override = process.env.CODEX_PATH?.trim();
  if (override) {
    if (!path.isAbsolute(override)) throw codexError('PERMISSION_CODEX_PATH_NOT_ABSOLUTE');
    return override;
  }
  return path.join(os.homedir(), '.local', 'bin', 'codex');
}

const MISSING_ERRNO = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

function realLauncherTarget(launcher) {
  try { return fs.realpathSync(launcher); } catch (error) {
    if (MISSING_ERRNO.has(error?.code)) throw codexError(CODEX_MACHINE_CLI_MISSING);
    throw error;
  }
}

function readReleaseManifest(manifestPath) {
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (error) {
    if (MISSING_ERRNO.has(error?.code)) throw codexError('PERMISSION_CODEX_LAYOUT_UNSUPPORTED');
    throw codexError('PERMISSION_CODEX_LAYOUT_INVALID');
  }
}

/** Resolve a manifest-relative directory and require a real (non-symlink) directory inside the release. */
function releaseDirectory(releaseRoot, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw codexError('PERMISSION_CODEX_LAYOUT_INVALID');
  }
  const directory = path.join(releaseRoot, relative);
  if (path.relative(releaseRoot, directory).startsWith('..')) throw codexError('PERMISSION_CODEX_LAYOUT_INVALID');
  let stat;
  try { stat = fs.lstatSync(directory); } catch { throw codexError('PERMISSION_CODEX_LAYOUT_INVALID'); }
  if (!stat.isDirectory()) throw codexError('PERMISSION_CODEX_LAYOUT_INVALID');
  return directory;
}

/**
 * Resolve and validate the machine standalone release layout (layoutVersion 1):
 * <release>/bin/codex, <release>/codex-package.json, resources and path dirs.
 */
export function resolveCodexMachineRuntime({ platform = process.platform, arch = process.arch } = {}) {
  const triple = triples[`${platform}:${arch}`];
  if (!triple) throw codexError('PERMISSION_CODEX_PLATFORM_UNSUPPORTED');
  const executablePath = realLauncherTarget(codexMachineLauncherPath());
  if (!path.isAbsolute(executablePath) || !fs.statSync(executablePath).isFile()) {
    throw codexError('PERMISSION_CODEX_EXECUTABLE_INVALID');
  }
  fs.accessSync(executablePath, fs.constants.X_OK);
  assertNativeExecutable(executablePath, platform);
  const releaseRoot = path.dirname(path.dirname(executablePath));
  const manifestPath = path.join(releaseRoot, 'codex-package.json');
  const manifest = readReleaseManifest(manifestPath);
  if (manifest?.layoutVersion !== 1 || manifest.target !== triple
    || typeof manifest.entrypoint !== 'string' || path.isAbsolute(manifest.entrypoint)
    || path.join(releaseRoot, manifest.entrypoint) !== executablePath
    || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
    throw codexError('PERMISSION_CODEX_LAYOUT_INVALID');
  }
  releaseDirectory(releaseRoot, manifest.resourcesDir);
  const pathDir = releaseDirectory(releaseRoot, manifest.pathDir);
  return Object.freeze({
    executablePath, releaseRoot, manifestPath, version: manifest.version,
    pathDirs: Object.freeze([pathDir]), platform, arch,
  });
}

/** Walk the release tree without following links; reject anything but files, dirs and the root alias. */
function listReleaseEntries(releaseRoot) {
  const entries = [];
  const visit = relative => {
    const absolute = path.join(releaseRoot, relative);
    for (const name of fs.readdirSync(absolute).sort(byCodePoint)) {
      const child = relative ? path.posix.join(relative, name) : name;
      const stat = fs.lstatSync(path.join(releaseRoot, child), { bigint: true });
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(path.join(releaseRoot, child));
        if (child !== ROOT_ALIAS.name || target !== ROOT_ALIAS.target) {
          throw codexError('PERMISSION_CODEX_RELEASE_SYMLINK');
        }
        entries.push({ relative: child, kind: 'link', stat, target });
      } else if (stat.isDirectory()) {
        entries.push({ relative: child, kind: 'dir', stat });
        visit(child);
      } else if (stat.isFile()) {
        entries.push({ relative: child, kind: 'file', stat });
      } else {
        throw codexError('PERMISSION_CODEX_RELEASE_FILE_TYPE');
      }
    }
  };
  visit('');
  return entries;
}

/** Cheap metadata seal over every entry (plus the root) used by the pre-launch re-check. */
function releaseStatDigest(releaseRoot, entries = listReleaseEntries(releaseRoot)) {
  const rootStat = fs.lstatSync(releaseRoot, { bigint: true });
  return sha256(JSON.stringify([['', fileIdentity(rootStat)],
    ...entries.map(entry => [entry.relative, entry.kind, fileIdentity(entry.stat)])]));
}

/** Content seal over every regular file (relative path + permission bits + bytes). */
function releaseTreeDigest(releaseRoot, entries) {
  return sha256(JSON.stringify(entries.map(entry => {
    const mode = Number(entry.stat.mode & 0o7777n).toString(8);
    if (entry.kind === 'file') {
      return [entry.relative, 'file', mode, codexFileDigest(path.join(releaseRoot, entry.relative))];
    }
    return entry.kind === 'link' ? [entry.relative, 'link', entry.target] : [entry.relative, 'dir', mode];
  })));
}

const lstatIdentity = filename => fileIdentity(fs.lstatSync(filename, { bigint: true }));

/** Read the executable's own version with a fixed argv, no shell and an empty environment. */
export function readCodexCliVersion(executablePath) {
  const output = String(execFileSync(executablePath, ['--version'], {
    encoding: 'utf8', shell: false, timeout: 5000, env: {}, stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
  const version = output.match(/^codex-cli (\d+\.\d+\.\d+)$/u)?.[1];
  if (!version) throw codexError('PERMISSION_CODEX_CLI_VERSION_INVALID');
  return version;
}

/** Sorted digest over every module of the resolution chain (this module today). */
export const codexResolverDigest = () => sha256(JSON.stringify(RESOLUTION_CHAIN
  .map(file => [path.basename(file), codexFileDigest(file)]).sort(([a], [b]) => byCodePoint(a, b))));

const versionCache = new Map();
const VERSION_CACHE_LIMIT = 32;

/**
 * The executable's self-reported version, spawned once per exact native bytes
 * and inode (qa M2): a launch must not pay, or block the event loop on, a
 * `--version` child when nothing about the binary changed.
 */
function cachedCliVersion(executablePath, nativeDigest, entryIdentity, readVersion) {
  if (readVersion !== readCodexCliVersion) return readVersion(executablePath);
  const key = `${nativeDigest}\0${entryIdentity}`;
  if (!versionCache.has(key)) {
    versionCache.set(key, readVersion(executablePath));
    if (versionCache.size > VERSION_CACHE_LIMIT) versionCache.delete(versionCache.keys().next().value);
  }
  return versionCache.get(key);
}

/**
 * Acquire the ONE frozen identity a launch uses end-to-end. Call once per
 * launch and pass the object on; never re-resolve at the spawn seam.
 * @param {{ readVersion?: (executablePath: string) => string }} [options] test seam
 */
export function acquireCodexLaunchIdentity({ readVersion = readCodexCliVersion } = {}) {
  const runtime = resolveCodexMachineRuntime();
  const { executablePath, releaseRoot, manifestPath } = runtime;
  const entryIdentity = lstatIdentity(executablePath);
  const manifestIdentity = lstatIdentity(manifestPath);
  const entries = listReleaseEntries(releaseRoot);
  const releaseStat = releaseStatDigest(releaseRoot, entries);
  const treeDigest = releaseTreeDigest(releaseRoot, entries);
  const nativeDigest = codexFileDigest(executablePath);
  if (cachedCliVersion(executablePath, nativeDigest, entryIdentity, readVersion) !== runtime.version) {
    throw codexError('PERMISSION_CODEX_VERSION_MISMATCH');
  }
  const identity = Object.freeze({
    executablePath, releaseRoot, version: runtime.version, treeDigest, nativeDigest,
    entryIdentity, manifestIdentity, releaseStatDigest: releaseStat, pathDirs: runtime.pathDirs,
    resolverDigest: codexResolverDigest(), platform: runtime.platform, arch: runtime.arch,
  });
  // Hashing takes time; a file edited meanwhile must not be sealed as measured.
  assertCodexIdentityUnchanged(identity);
  return identity;
}

/**
 * The identity of a launch admitted by the permission gateway: exactly the
 * handle's fingerprinted object. When the gateway could not acquire one, its
 * recorded cause is rethrown; this never re-acquires (T-1872 qa M1).
 * @param {{ launchIdentity?: object | null, launchIdentityError?: Error | null }} permissionExecution
 */
export function codexIdentityFromExecution(permissionExecution) {
  if (permissionExecution?.launchIdentity) return permissionExecution.launchIdentity;
  throw permissionExecution?.launchIdentityError ?? codexError('PERMISSION_CODEX_IDENTITY_REQUIRED');
}

/**
 * Boot prewarm: hash the release once (~350 ms cold on this host) so the digest
 * cache serves the first real launch. Absence is not an error at boot.
 */
export function prewarmCodexLaunchIdentity(acquire = acquireCodexLaunchIdentity) {
  try { acquire(); return true; } catch { return false; }
}

/** Re-stat the measured release immediately before the effect; any drift refuses the launch. */
export function assertCodexIdentityUnchanged(identity) {
  if (!identity || !Object.isFrozen(identity) || typeof identity.executablePath !== 'string') {
    throw codexError('PERMISSION_CODEX_IDENTITY_REQUIRED');
  }
  let unchanged;
  try {
    unchanged = lstatIdentity(identity.executablePath) === identity.entryIdentity
      && lstatIdentity(path.join(identity.releaseRoot, 'codex-package.json')) === identity.manifestIdentity
      && releaseStatDigest(identity.releaseRoot) === identity.releaseStatDigest;
  } catch { unchanged = false; }
  if (!unchanged) throw codexError(CODEX_RUNTIME_CHANGED);
  return identity;
}

/** Fields of the identity that bind the permission build fingerprint (bytes, not inode stamps). */
export function codexFingerprintFields(identity) {
  if (!identity?.treeDigest) throw codexError('PERMISSION_CODEX_IDENTITY_REQUIRED');
  return {
    nativeDigest: identity.nativeDigest, treeDigest: identity.treeDigest,
    resolverDigest: identity.resolverDigest, sdkSourceDigest: codexFileDigest(resolveCodexSdkSourceEntry()),
    platform: identity.platform, arch: identity.arch,
  };
}

/** SDK constructor options for this exact identity; the identity argument is mandatory. */
export function codexLaunchOptions(env, identity) {
  if (!identity?.executablePath) throw codexError('PERMISSION_CODEX_IDENTITY_REQUIRED');
  const pathKey = process.platform === 'win32'
    ? Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path' : 'PATH';
  return { codexPathOverride: identity.executablePath, env: {
    ...env,
    ...(identity.pathDirs.length ? { [pathKey]: [...identity.pathDirs, env[pathKey] || ''].join(path.delimiter) } : {}),
  } };
}

/** POSIX single-quote a word for a `bash -c` command line. */
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * Build a shell command that runs this identity's executable (never a PATH `codex`).
 * @param {{ executablePath: string } | null} identity
 * @param {readonly string[]} [args]
 */
export const codexShellCommand = (identity, args = []) => {
  if (!identity?.executablePath) throw codexError('PERMISSION_CODEX_IDENTITY_REQUIRED');
  return [identity.executablePath, ...args].map(shellQuote).join(' ');
};

/** Reject wrappers even when placed at a familiar native-package pathname. */
function assertNativeExecutable(filename, platform) {
  const fd = fs.openSync(filename, 'r');
  const bytes = Buffer.alloc(4);
  try { fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
  const magic = bytes.toString('hex');
  const native = platform === 'linux' ? magic === '7f454c46'
    : platform === 'win32' ? magic.startsWith('4d5a')
      : ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic);
  if (!native) throw codexError('PERMISSION_CODEX_NATIVE_BINARY_REQUIRED');
}
