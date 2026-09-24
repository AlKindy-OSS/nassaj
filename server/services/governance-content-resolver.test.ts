import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { calculateGovernanceRootDigest } from './governance-content-catalog.js';
import { GovernanceContentUnavailable, __test__, tryResolveGovernanceContent } from './governance-content-resolver.js';

const PUBLISHER_UID = process.getuid();
const SERVICE_UID = PUBLISHER_UID + 1;
const fixtureParents = new Set<string>();

after(() => {
  for (const parent of fixtureParents) {
    try {
      for (const directory of fs.globSync('**/', { cwd: parent }).sort().reverse()) {
        fs.chmodSync(path.join(parent, directory), 0o700);
      }
      fs.chmodSync(parent, 0o700);
      fs.rmSync(parent, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});

function hash(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(relativePath = 'projects/demo/state.json') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-resolver-'));
  fixtureParents.add(parent);
  const root = path.join(parent, 'snapshot');
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const content = JSON.stringify({ tasks: [{ id: 'T-1' }] });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o400);
  for (let current = path.dirname(file); current !== parent; current = path.dirname(current)) {
    fs.chmodSync(current, 0o500);
  }
  const entry = {
    key: { projectId: 'demo', kind: 'project-state' }, path: relativePath,
    bytes: Buffer.byteLength(content), sha256: hash(content), format: 'json',
    visibility: { mode: 'actors', actorIds: ['7'] },
  };
  const catalog: any = {
    schemaVersion: 1, snapshotId: 'snapshot-1', root, trustedUid: PUBLISHER_UID,
    rootDigest: '0'.repeat(64), entries: [entry],
  };
  catalog.rootDigest = calculateGovernanceRootDigest(catalog);
  const catalogPath = path.join(parent, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o400 });
  const catalogFd = fs.openSync(catalogPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  return { parent, root, file, catalog, catalogPath, catalogFd, content };
}

function selector(overrides = {}) {
  return { projectId: 'demo', actorId: 7, kind: 'project-state', ...overrides };
}

function dependencies(value: ReturnType<typeof fixture>, overrides = {}) {
  return { catalogFd: value.catalogFd, catalogOwnerUid: PUBLISHER_UID, serviceUid: SERVICE_UID, ...overrides };
}

function resolve(value: ReturnType<typeof fixture>, selectorOverrides = {}, dependencyOverrides = {}) {
  return __test__.resolveWithDependencies(selector(selectorOverrides), dependencies(value, dependencyOverrides));
}

function tryResolve(value: ReturnType<typeof fixture>, selectorOverrides = {}, dependencyOverrides = {}) {
  return __test__.tryWithDependencies(selector(selectorOverrides), dependencies(value, dependencyOverrides));
}

function openFileDescriptorCount() {
  return fs.readdirSync('/proc/self/fd').length;
}

function replaceCatalog(value: ReturnType<typeof fixture>, mutate: (catalog: any) => void) {
  fs.closeSync(value.catalogFd);
  const catalog = structuredClone(value.catalog);
  mutate(catalog);
  fs.chmodSync(value.catalogPath, 0o600);
  fs.writeFileSync(value.catalogPath, JSON.stringify(catalog));
  fs.chmodSync(value.catalogPath, 0o400);
  value.catalog = catalog;
  value.catalogFd = fs.openSync(value.catalogPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
}

test('reads a digest-pinned logical record and exposes snapshot provenance', () => {
  const value = fixture();
  const result = resolve(value);
  assert.equal(result.value.tasks[0].id, 'T-1');
  assert.equal(result.provenance.snapshotId, 'snapshot-1');
  assert.equal(result.provenance.rootDigest, value.catalog.rootDigest);
  assert.equal(Object.hasOwn(result.provenance, 'path'), false);
});

test('production has a fixed catalog path and ignores the former environment override', () => {
  const previous = process.env.NASSAJ_GOVERNANCE_CONTENT_CONFIG_JSON;
  process.env.NASSAJ_GOVERNANCE_CONTENT_CONFIG_JSON = JSON.stringify({ enabled: true });
  try {
    assert.equal(tryResolveGovernanceContent(selector()).available, false);
  } finally {
    if (previous === undefined) delete process.env.NASSAJ_GOVERNANCE_CONTENT_CONFIG_JSON;
    else process.env.NASSAJ_GOVERNANCE_CONTENT_CONFIG_JSON = previous;
  }
});

test('rejects catalog replay when snapshotId no longer matches rootDigest', () => {
  const value = fixture();
  replaceCatalog(value, (catalog) => { catalog.snapshotId = 'snapshot-replayed'; });
  assert.equal(tryResolve(value).reason, 'root_digest_mismatch');
});

test('a path-level catalog swap invalidates the already-open descriptor', () => {
  const value = fixture();
  const replacement = `${value.catalogPath}.replacement`;
  fs.writeFileSync(replacement, '{"malicious":true}', { mode: 0o400 });
  fs.renameSync(replacement, value.catalogPath);
  assert.equal(tryResolve(value).reason, 'unsafe_file');
});

test('rejects an intermediate symlink in the snapshot', () => {
  const value = fixture('safe/state.json');
  fs.chmodSync(value.root, 0o700);
  fs.renameSync(path.join(value.root, 'safe'), path.join(value.root, 'safe-real'));
  fs.symlinkSync(path.join(value.root, 'safe-real'), path.join(value.root, 'safe'));
  fs.chmodSync(value.root, 0o500);
  assert.equal(tryResolve(value).available, false);
});

test('rejects root and file digest drift after publication', () => {
  const replay = fixture();
  replaceCatalog(replay, (catalog) => { catalog.rootDigest = 'f'.repeat(64); });
  assert.equal(tryResolve(replay).reason, 'root_digest_mismatch');

  const changed = fixture();
  fs.chmodSync(changed.file, 0o600);
  fs.writeFileSync(changed.file, changed.content.replace('T-1', 'T-2'));
  fs.chmodSync(changed.file, 0o400);
  assert.equal(tryResolve(changed).reason, 'file_digest_mismatch');
});

test('rejects app-writable snapshot root, directories, files and shared UID', () => {
  for (const target of ['root', 'directory', 'file']) {
    const value = fixture();
    if (target === 'root') fs.chmodSync(value.root, 0o700);
    if (target === 'directory') fs.chmodSync(path.dirname(value.file), 0o700);
    if (target === 'file') fs.chmodSync(value.file, 0o600);
    assert.equal(tryResolve(value).available, false, target);
  }
  const sameUid = fixture();
  assert.equal(tryResolve(sameUid, {}, { serviceUid: PUBLISHER_UID }).reason, 'shared_service_uid');
});

test('repeated root and nested-directory rejection leaves the descriptor count stable', () => {
  const writableRoot = fixture();
  fs.chmodSync(writableRoot.root, 0o700);
  const beforeRoot = openFileDescriptorCount();
  for (let attempt = 0; attempt < 128; attempt += 1) {
    assert.equal(tryResolve(writableRoot).reason, 'unsafe_directory');
  }
  assert.equal(openFileDescriptorCount(), beforeRoot, 'rejected snapshot roots must be closed');

  const writableNested = fixture('unsafe/state.json');
  fs.chmodSync(path.dirname(writableNested.file), 0o700);
  const beforeNested = openFileDescriptorCount();
  for (let attempt = 0; attempt < 128; attempt += 1) {
    assert.equal(tryResolve(writableNested).reason, 'unsafe_directory');
  }
  assert.equal(openFileDescriptorCount(), beforeNested, 'rejected nested directories must be closed');
});

test('missing, malformed, writable, or wrong-owner catalog is unavailable', () => {
  assert.equal(tryResolveGovernanceContent(selector()).available, false);

  const malformed = fixture();
  replaceCatalog(malformed, (catalog) => { catalog.extra = true; });
  assert.equal(tryResolve(malformed).available, false);

  const writable = fixture();
  fs.chmodSync(writable.catalogPath, 0o600);
  assert.equal(tryResolve(writable).reason, 'unsafe_file');

  const owner = fixture();
  assert.equal(tryResolve(owner, {}, { catalogOwnerUid: PUBLISHER_UID + 9 }).reason, 'unsafe_file');
});

test('rejects hidden actors and invalid JSON after digest verification', () => {
  const hidden = fixture();
  assert.throws(() => resolve(hidden, { actorId: 8 }), GovernanceContentUnavailable);

  const invalid = fixture();
  fs.chmodSync(invalid.file, 0o600);
  fs.writeFileSync(invalid.file, '{bad json');
  fs.chmodSync(invalid.file, 0o400);
  replaceCatalog(invalid, (catalog) => {
    catalog.entries[0].bytes = 9;
    catalog.entries[0].sha256 = hash('{bad json');
    catalog.rootDigest = calculateGovernanceRootDigest(catalog);
  });
  assert.equal(tryResolve(invalid).reason, 'invalid_json');
});
