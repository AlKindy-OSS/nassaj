import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

import { calculateGovernanceRootDigest } from './governance-content-catalog.js';
import { __test__ as resolverTest } from './governance-content-resolver.js';

type FixtureEntry = {
  projectId: string;
  kind?: 'project-state' | 'project-plan' | 'project-status';
  filename: string;
  content: string;
  actorIds?: Array<string | number>;
};

const fixtureParents = new Set<string>();

after(() => {
  for (const parent of fixtureParents) {
    try {
      for (const directory of fs.globSync('**/', { cwd: parent }).sort().reverse()) {
        fs.chmodSync(path.join(parent, directory), 0o700);
      }
      fs.chmodSync(parent, 0o700);
      fs.rmSync(parent, { recursive: true, force: true });
    } catch { /* runner scratch cleanup remains a final fallback */ }
  }
});

/** Build an immutable canonical publication and a resolver bound to its descriptors. */
export function createGovernanceTestFixture(entries: FixtureEntry[]) {
  const ownerUid = process.getuid?.() ?? 1000;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-test-'));
  fixtureParents.add(parent);
  const root = path.join(parent, 'snapshot');
  fs.mkdirSync(root, { mode: 0o700 });
  const catalogEntries = entries.map((entry) => {
    const target = path.join(root, entry.filename);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, entry.content, { mode: 0o400 });
    return {
      key: { projectId: entry.projectId, kind: entry.kind ?? 'project-state' },
      path: entry.filename,
      bytes: Buffer.byteLength(entry.content),
      sha256: createHash('sha256').update(entry.content).digest('hex'),
      format: 'json',
      visibility: entry.actorIds
        ? { mode: 'actors', actorIds: entry.actorIds.map(String).sort() }
        : { mode: 'authenticated' },
    };
  }).sort((left, right) => {
    const a = `${left.key.projectId}\0${left.key.kind}`;
    const b = `${right.key.projectId}\0${right.key.kind}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const entry of entries) {
    for (let current = path.dirname(path.join(root, entry.filename)); current !== parent; current = path.dirname(current)) {
      fs.chmodSync(current, 0o500);
    }
  }
  const catalog: any = {
    schemaVersion: 1, snapshotId: 'test-snapshot', root, trustedUid: ownerUid,
    rootDigest: '0'.repeat(64), entries: catalogEntries,
  };
  catalog.rootDigest = calculateGovernanceRootDigest(catalog);
  const catalogPath = path.join(parent, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), { mode: 0o400 });
  const catalogFd = fs.openSync(catalogPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const resolver = (selector: unknown) => resolverTest.tryWithDependencies(selector, {
    catalogFd, catalogOwnerUid: ownerUid, serviceUid: ownerUid + 1,
  });
  return { parent, root, catalogFd, resolver };
}
