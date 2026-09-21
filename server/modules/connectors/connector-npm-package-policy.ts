/**
 * Strict resolver for catalog-owned npm MCP servers.
 *
 * It never invokes npm and never searches npm/npx caches or the application's
 * dependency tree. The policy is dormant unless explicitly armed. Once armed,
 * a catalog npm launcher must exist in the dedicated connector store and match
 * the catalog's exact version and lockfile SRI, otherwise resolution fails
 * closed before a provider receives an executable definition. SRI here proves
 * lock metadata provenance; it is not content attestation of an unpacked tree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONNECTOR_CATALOG, type CatalogEntry } from '../../../shared/connector-catalog.js';

export const CONNECTOR_STORE_ONLY_FLAG = 'NASSAJ_CONNECTOR_STORE_ONLY';

export type ConnectorPackageLaunch = { command: string; args: string[] };

export class ConnectorPackagePolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConnectorPackagePolicyError';
    this.code = code;
  }
}

/** The strict policy is opt-in; every other value, including absence, is off. */
export function connectorStoreOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CONNECTOR_STORE_ONLY_FLAG] === '1';
}

/** Dedicated operator-managed store. No application or npm cache fallback. */
export function connectorPackageStore(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.NASSAJ_CONNECTOR_SERVERS_DIR?.trim();
  if (configured) return path.resolve(configured);
  const effectiveHome = env.HOME?.trim() || os.homedir();
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(effectiveHome, '.local', 'share');
  return path.resolve(dataHome, 'nassaj-connector-servers');
}

function fail(code: string, detail: string): never {
  throw new ConnectorPackagePolicyError(code, `Connector package policy refused launch: ${detail}`);
}

function assertOwnedReadonly(stat: fs.Stats, code: string, detail: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail(code, `${detail} has a foreign owner`);
  if ((stat.mode & 0o222) !== 0) fail(code, `${detail} is writable`);
}

function readJsonFile(file: string, code: string): Record<string, unknown> {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return fail(code, `${path.basename(file)} is not a unique regular file`);
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) return fail(code, `${path.basename(file)} changed while opening`);
    assertOwnedReadonly(opened, code, path.basename(file));
  } catch (error) {
    if (error instanceof ConnectorPackagePolicyError) throw error;
    return fail(code, `${path.basename(file)} is missing`);
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      return fail(code, `${path.basename(file)} is not a regular file`);
    }
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConnectorPackagePolicyError) throw error;
    return fail(code, `${path.basename(file)} is invalid`);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relation = path.relative(parent, candidate);
  return relation === '' || (!relation.startsWith('..') && !path.isAbsolute(relation));
}

function assertReadonlyDirectoryChain(store: string, packageDir: string): void {
  const relative = path.relative(store, packageDir);
  let current = store;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      fail('CONNECTOR_PACKAGE_PATH_INSECURE', `${path.basename(current)} is not a real directory`);
    }
    assertOwnedReadonly(stat, 'CONNECTOR_PACKAGE_PATH_INSECURE', path.basename(current));
  }
}

function packageBin(
  packageDir: string,
  packageName: string,
  expected: { name: string; path: string },
  manifest: Record<string, unknown>,
): string {
  const bin = manifest.bin;
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)
    || (bin as Record<string, unknown>)[expected.name] !== expected.path) {
    return fail('CONNECTOR_PACKAGE_BIN_MISMATCH', `${packageName} does not match its catalog bin mapping`);
  }

  const candidate = path.resolve(packageDir, expected.path);
  if (!isInside(packageDir, candidate)) {
    return fail('CONNECTOR_PACKAGE_BIN_ESCAPE', `${packageName} bin escapes its package directory`);
  }
  assertReadonlyDirectoryChain(packageDir, path.dirname(candidate));
  let candidateStat: fs.Stats;
  let descriptor: number | null = null;
  try {
    candidateStat = fs.lstatSync(candidate);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink() || candidateStat.nlink !== 1) {
      return fail('CONNECTOR_PACKAGE_BIN_INVALID', `${packageName} bin is not a unique regular file`);
    }
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1
      || opened.dev !== candidateStat.dev || opened.ino !== candidateStat.ino) {
      return fail('CONNECTOR_PACKAGE_BIN_CHANGED', `${packageName} bin changed while opening`);
    }
    assertOwnedReadonly(opened, 'CONNECTOR_PACKAGE_BIN_INSECURE', `${packageName} bin`);
    const realPackageDir = fs.realpathSync(packageDir);
    const realCandidate = fs.realpathSync(candidate);
    const after = fs.lstatSync(candidate);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1) {
      return fail('CONNECTOR_PACKAGE_BIN_CHANGED', `${packageName} bin changed during verification`);
    }
    if (!isInside(realPackageDir, realCandidate)) {
      return fail('CONNECTOR_PACKAGE_BIN_ESCAPE', `${packageName} bin resolves outside its package directory`);
    }
    return realCandidate;
  } catch (error) {
    if (error instanceof ConnectorPackagePolicyError) throw error;
    return fail('CONNECTOR_PACKAGE_BIN_MISSING', `${packageName} bin is missing`);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

/**
 * Returns null while the flag is off. With the flag on, returns a direct local
 * launch or throws a typed fail-closed error; it never returns an npx fallback.
 */
export function resolvePinnedCatalogPackage(
  entry: CatalogEntry,
  env: NodeJS.ProcessEnv = process.env,
  trustedCatalog: readonly CatalogEntry[] = CONNECTOR_CATALOG,
): ConnectorPackageLaunch | null {
  if (!connectorStoreOnlyEnabled(env)) return null;
  try {
  if (!trustedCatalog.includes(entry)) {
    return fail('CONNECTOR_PACKAGE_NOT_CATALOG', `${entry.service} is not a trusted catalog record`);
  }
  if (entry.command !== 'npx' || entry.transport !== 'stdio') {
    return fail('CONNECTOR_PACKAGE_NOT_NPX', `${entry.service} is not an npm stdio connector`);
  }
  const pin = entry.npmPackage;
  if (!pin) return fail('CONNECTOR_PACKAGE_PIN_MISSING', `${entry.service} has no immutable npm pin`);
  const expectedSpec = `${pin.name}@${pin.version}`;
  const packageIndex = entry.args?.findIndex((arg) => arg === expectedSpec) ?? -1;
  if (packageIndex < 0) {
    return fail('CONNECTOR_PACKAGE_SPEC_MISMATCH', `${entry.service} does not request ${expectedSpec}`);
  }

  const store = connectorPackageStore(env);
  const storeStat = fs.lstatSync(store, { throwIfNoEntry: false });
  if (!storeStat?.isDirectory() || storeStat.isSymbolicLink()) {
    return fail('CONNECTOR_PACKAGE_STORE_MISSING', 'the dedicated connector store is missing');
  }
  assertOwnedReadonly(storeStat, 'CONNECTOR_PACKAGE_STORE_INSECURE', 'the dedicated connector store');
  const packageDir = path.join(store, 'node_modules', ...pin.name.split('/'));
  const packageStat = fs.lstatSync(packageDir, { throwIfNoEntry: false });
  if (!packageStat?.isDirectory() || packageStat.isSymbolicLink()) {
    return fail('CONNECTOR_PACKAGE_MISSING', `${expectedSpec} is absent from the dedicated store`);
  }
  assertOwnedReadonly(packageStat, 'CONNECTOR_PACKAGE_INSECURE', `${expectedSpec} directory`);
  const realStore = fs.realpathSync(store);
  const realPackageDir = fs.realpathSync(packageDir);
  if (!isInside(realStore, realPackageDir)) {
    return fail('CONNECTOR_PACKAGE_PATH_ESCAPE', `${expectedSpec} resolves outside the dedicated store`);
  }
  assertReadonlyDirectoryChain(store, packageDir);

  const manifest = readJsonFile(path.join(packageDir, 'package.json'), 'CONNECTOR_PACKAGE_MANIFEST_INVALID');
  if (manifest.name !== pin.name || manifest.version !== pin.version) {
    return fail('CONNECTOR_PACKAGE_VERSION_MISMATCH', `${pin.name} manifest does not match ${pin.version}`);
  }
  const lock = readJsonFile(path.join(store, 'package-lock.json'), 'CONNECTOR_PACKAGE_LOCK_INVALID');
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    return fail('CONNECTOR_PACKAGE_LOCK_INVALID', 'package-lock.json has no packages map');
  }
  const lockKey = path.posix.join('node_modules', pin.name);
  const locked = (packages as Record<string, unknown>)[lockKey];
  if (!locked || typeof locked !== 'object' || Array.isArray(locked)) {
    return fail('CONNECTOR_PACKAGE_LOCK_MISSING', `${expectedSpec} is absent from package-lock.json`);
  }
  const lockEntry = locked as Record<string, unknown>;
  if (lockEntry.version !== pin.version || lockEntry.integrity !== pin.integrity) {
    return fail('CONNECTOR_PACKAGE_INTEGRITY_MISMATCH', `${expectedSpec} does not match its catalog SRI`);
  }

  const bin = packageBin(packageDir, pin.name, pin.bin, manifest);
    return {
      command: process.execPath,
      args: [bin, ...(entry.args?.slice(packageIndex + 1) ?? [])],
    };
  } catch (error) {
    if (error instanceof ConnectorPackagePolicyError) throw error;
    return fail('CONNECTOR_PACKAGE_FS_ERROR', 'the dedicated store changed or became inaccessible');
  }
}
