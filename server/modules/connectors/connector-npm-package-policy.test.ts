import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { mock } from 'node:test';

import { CONNECTOR_CATALOG, type CatalogEntry } from '../../../shared/connector-catalog.js';

import {
  ConnectorPackagePolicyError,
  connectorPackageStore,
  connectorStoreOnlyEnabled,
  resolvePinnedCatalogPackage,
} from './connector-npm-package-policy.js';

const roots: string[] = [];
const ENTRY: CatalogEntry = Object.freeze({
  service: 'fixture-npm',
  displayName: 'Fixture npm',
  summary: 'Test only',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@fixture/mcp@1.2.3', '--stdio'],
  npmPackage: {
    name: '@fixture/mcp',
    version: '1.2.3',
    integrity: 'sha512-YWJjZA==',
    bin: { name: 'fixture-mcp', path: 'dist/server.js' },
  },
  keyEnvVar: 'FIXTURE_KEY',
  allowsSharing: false,
  official: false,
});

function fixture(): { env: NodeJS.ProcessEnv; packageDir: string; lockPath: string } {
  const pin = ENTRY.npmPackage!;
  const root = fs.mkdtempSync('/var/tmp/nassaj-connector-package-policy-');
  roots.push(root);
  const packageDir = path.join(root, 'node_modules', ...pin.name.split('/'));
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(packageDir, 'dist', 'server.js'), '#!/usr/bin/env node\n', { mode: 0o444 });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: pin.name,
    version: pin.version,
    bin: { [pin.bin.name]: pin.bin.path },
  }), { mode: 0o444 });
  const lockPath = path.join(root, 'package-lock.json');
  fs.writeFileSync(lockPath, JSON.stringify({
    lockfileVersion: 3,
    packages: { [`node_modules/${pin.name}`]: { version: pin.version, integrity: pin.integrity } },
  }), { mode: 0o444 });
  for (const directory of [path.join(root, 'node_modules'), path.join(root, 'node_modules', '@fixture'), path.join(packageDir, 'dist'), packageDir, root]) {
    fs.chmodSync(directory, 0o555);
  }
  return {
    env: { NASSAJ_CONNECTOR_STORE_ONLY: '1', NASSAJ_CONNECTOR_SERVERS_DIR: root },
    packageDir,
    lockPath,
  };
}

function writable(file: string, operation: () => void): void {
  fs.chmodSync(file, 0o644);
  operation();
  fs.chmodSync(file, 0o444);
}

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) =>
    error instanceof ConnectorPackagePolicyError && error.code === code);
}

test.after(() => {
  for (const root of roots) {
    const makeWritable = (directory: string): void => {
      fs.chmodSync(directory, 0o755);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) makeWritable(target);
        else if (!entry.isSymbolicLink()) fs.chmodSync(target, 0o644);
      }
    };
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('policy is disabled by default and inert without a store', () => {
  assert.equal(connectorStoreOnlyEnabled({}), false);
  assert.equal(connectorStoreOnlyEnabled({ NASSAJ_CONNECTOR_STORE_ONLY: 'true' }), false);
  assert.equal(resolvePinnedCatalogPackage(CONNECTOR_CATALOG[0], {}), null);
});

test('armed policy accepts only a trusted catalog object', () => {
  const { env } = fixture();
  expectCode(() => resolvePinnedCatalogPackage(ENTRY, env), 'CONNECTOR_PACKAGE_NOT_CATALOG');
  assert.ok(resolvePinnedCatalogPackage(ENTRY, env, [ENTRY]));
});

test('exact package, version, SRI and bin mapping resolve to node without npx fallback', () => {
  const { env, packageDir } = fixture();
  const launch = resolvePinnedCatalogPackage(ENTRY, env, [ENTRY]);
  assert.equal(launch?.command, process.execPath);
  assert.deepEqual(launch?.args, [path.join(packageDir, 'dist/server.js'), '--stdio']);
  assert.equal(connectorPackageStore(env), env.NASSAJ_CONNECTOR_SERVERS_DIR);
  assert.equal(launch?.args.some((arg) => arg === '-y' || arg.includes('latest')), false);
});

test('missing pin/store/package fails closed with no npx fallback', () => {
  const unpinned = Object.freeze({ ...ENTRY, npmPackage: undefined });
  expectCode(
    () => resolvePinnedCatalogPackage(unpinned, { NASSAJ_CONNECTOR_STORE_ONLY: '1' }, [unpinned]),
    'CONNECTOR_PACKAGE_PIN_MISSING',
  );
  const { env, packageDir } = fixture();
  fs.chmodSync(path.dirname(packageDir), 0o755);
  fs.renameSync(packageDir, `${packageDir}.absent`);
  expectCode(() => resolvePinnedCatalogPackage(ENTRY, env, [ENTRY]), 'CONNECTOR_PACKAGE_MISSING');
});

test('version, SRI and exact bin mismatches fail closed', () => {
  const version = fixture();
  const manifestPath = path.join(version.packageDir, 'package.json');
  writable(manifestPath, () => fs.writeFileSync(manifestPath, JSON.stringify({
    name: ENTRY.npmPackage!.name,
    version: '9.9.9',
    bin: { [ENTRY.npmPackage!.bin.name]: ENTRY.npmPackage!.bin.path },
  })));
  expectCode(() => resolvePinnedCatalogPackage(ENTRY, version.env, [ENTRY]), 'CONNECTOR_PACKAGE_VERSION_MISMATCH');

  const integrity = fixture();
  writable(integrity.lockPath, () => {
    const lock = JSON.parse(fs.readFileSync(integrity.lockPath, 'utf8'));
    lock.packages['node_modules/@fixture/mcp'].integrity = 'sha512-wrong';
    fs.writeFileSync(integrity.lockPath, JSON.stringify(lock));
  });
  expectCode(() => resolvePinnedCatalogPackage(ENTRY, integrity.env, [ENTRY]), 'CONNECTOR_PACKAGE_INTEGRITY_MISMATCH');

  const bin = fixture();
  writable(path.join(bin.packageDir, 'package.json'), () => fs.writeFileSync(
    path.join(bin.packageDir, 'package.json'),
    JSON.stringify({ name: ENTRY.npmPackage!.name, version: ENTRY.npmPackage!.version, bin: { other: 'dist/server.js' } }),
  ));
  expectCode(() => resolvePinnedCatalogPackage(ENTRY, bin.env, [ENTRY]), 'CONNECTOR_PACKAGE_BIN_MISMATCH');
});

test('writable store metadata or symlink/escape bin is refused', () => {
  const writableStore = fixture();
  fs.chmodSync(writableStore.env.NASSAJ_CONNECTOR_SERVERS_DIR!, 0o755);
  expectCode(() => resolvePinnedCatalogPackage(ENTRY, writableStore.env, [ENTRY]), 'CONNECTOR_PACKAGE_STORE_INSECURE');

  const linked = fixture();
  const bin = path.join(linked.packageDir, 'dist/server.js');
  fs.chmodSync(path.dirname(bin), 0o755);
  fs.rmSync(bin);
  fs.symlinkSync('/usr/bin/true', bin);
  fs.chmodSync(path.dirname(bin), 0o555);
  expectCode(() => resolvePinnedCatalogPackage(ENTRY, linked.env, [ENTRY]), 'CONNECTOR_PACKAGE_BIN_INVALID');

  const writableParent = fixture();
  fs.chmodSync(path.join(writableParent.packageDir, 'dist'), 0o755);
  expectCode(
    () => resolvePinnedCatalogPackage(ENTRY, writableParent.env, [ENTRY]),
    'CONNECTOR_PACKAGE_PATH_INSECURE',
  );
});

test('bin inode substitution between lstat and open is refused', () => {
  const changed = fixture();
  const bin = path.join(changed.packageDir, 'dist/server.js');
  const originalOpen = fs.openSync;
  let substituted = false;
  const openMock = mock.method(fs, 'openSync', ((file: fs.PathLike, ...args: unknown[]) => {
    if (!substituted && String(file) === bin) {
      substituted = true;
      fs.chmodSync(path.dirname(bin), 0o755);
      fs.renameSync(bin, `${bin}.old`);
      fs.writeFileSync(bin, '#!/usr/bin/env node\n', { mode: 0o444 });
      fs.chmodSync(path.dirname(bin), 0o555);
    }
    return Reflect.apply(originalOpen, fs, [file, ...args]);
  }) as typeof fs.openSync);
  try {
    expectCode(() => resolvePinnedCatalogPackage(ENTRY, changed.env, [ENTRY]), 'CONNECTOR_PACKAGE_BIN_CHANGED');
  } finally {
    openMock.mock.restore();
  }
});
