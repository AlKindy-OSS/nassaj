import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const triples = Object.freeze({
  'linux:x64': 'x86_64-unknown-linux-musl', 'linux:arm64': 'aarch64-unknown-linux-musl',
  'darwin:x64': 'x86_64-apple-darwin', 'darwin:arm64': 'aarch64-apple-darwin',
  'win32:x64': 'x86_64-pc-windows-msvc', 'win32:arm64': 'aarch64-pc-windows-msvc',
});

const digestCache = new Map();
const fileIdentity = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode']
  .map(key => String(stat[key])).join(':');

/** Hash stable file bytes; cache only a full inode identity, checking every admission. */
export function codexFileDigest(filename, cachePolicy = {}) {
  try { return readStableFileDigest(filename, cachePolicy); } catch (error) {
    digestCache.clear();
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
    if (digestCache.size > 64) digestCache.delete(digestCache.keys().next().value);
    return result;
  } finally { fs.closeSync(fd); }
}

/** Locate the SDK module that this runtime actually imports. */
export const resolveCodexSdkEntry = () => fileURLToPath(import.meta.resolve('@openai/codex-sdk'));

/** Resolve only SDK-local native package layouts; never consult PATH or a shell wrapper. */
export function resolveCodexRuntime({
  sdkEntry = resolveCodexSdkEntry(),
  platform = process.platform, arch = process.arch,
} = {}) {
  const triple = triples[`${platform}:${arch}`];
  if (!triple) throw new Error('PERMISSION_CODEX_PLATFORM_UNSUPPORTED');
  const sdkRequire = createRequire(sdkEntry);
  const cliPackage = sdkRequire.resolve('@openai/codex/package.json');
  const nativePackage = createRequire(cliPackage).resolve(`@openai/codex-${platform}-${arch}/package.json`);
  const nativeRoot = path.join(path.dirname(nativePackage), 'vendor', triple);
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  const current = path.join(nativeRoot, 'bin', name);
  const legacy = path.join(nativeRoot, 'codex', name);
  const executable = fs.existsSync(current) && fs.existsSync(path.join(nativeRoot, 'codex-package.json'))
    ? current : legacy;
  const resolved = fs.realpathSync(executable);
  if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isFile()) throw new Error('PERMISSION_CODEX_EXECUTABLE_INVALID');
  fs.accessSync(resolved, fs.constants.X_OK);
  assertNativeExecutable(resolved, platform);
  const companion = path.join(nativeRoot, executable === current ? 'codex-path' : 'path');
  const pathDirs = fs.existsSync(companion) && fs.statSync(companion).isDirectory()
    ? [fs.realpathSync(companion)] : [];
  return { executablePath: resolved, pathDirs };
}

/** Evidence binds native bytes, resolver bytes, SDK implementation, and target platform. */
export function readCodexExecutableIdentity() {
  const sdkEntry = resolveCodexSdkEntry();
  const { executablePath, pathDirs } = resolveCodexRuntime({ sdkEntry });
  return {
    executablePath, pathDirs,
    pathClosure: pathDirs.map(directory => hashDirectory(directory)),
    nativeDigest: codexFileDigest(executablePath),
    resolverDigest: codexFileDigest(fileURLToPath(import.meta.url)),
    sdkSourceDigest: codexFileDigest(sdkEntry),
    platform: process.platform, arch: process.arch,
  };
}

/** Resolve the exact public SDK override and preserve its packaged tool search path. */
export function codexLaunchOptions(env, runtime = resolveCodexRuntime()) {
  const pathKey = process.platform === 'win32'
    ? Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path' : 'PATH';
  return { codexPathOverride: runtime.executablePath, env: {
    ...env,
    ...(runtime.pathDirs.length ? { [pathKey]: [...runtime.pathDirs, env[pathKey] || ''].join(path.delimiter) } : {}),
  } };
}

/** Bind every packaged companion tool by relative name and bytes. */
function hashDirectory(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('PERMISSION_CODEX_COMPANION_SYMLINK_UNSUPPORTED');
      return [entry.name, entry.isDirectory() ? hashDirectory(filename) : codexFileDigest(filename)];
    });
}

/** Reject wrappers even when placed at a familiar native-package pathname. */
function assertNativeExecutable(filename, platform) {
  const fd = fs.openSync(filename, 'r');
  const bytes = Buffer.alloc(4);
  try { fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
  const magic = bytes.toString('hex');
  const native = platform === 'linux' ? magic === '7f454c46'
    : platform === 'win32' ? magic.startsWith('4d5a')
      : ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic);
  if (!native) throw new Error('PERMISSION_CODEX_NATIVE_BINARY_REQUIRED');
}
