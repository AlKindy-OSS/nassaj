/** ADR-156 WI-6 / م-9: the runtime identity of the build actually loaded. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { isRunningFromDistServer, readRuntimeIdentity } from './runtime-identity.js';

const TMP_BASE = process.env.TMPDIR || '/var/tmp';

async function withAppRoot(run) {
  const root = await mkdtemp(path.join(TMP_BASE, 'runtime-identity-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The URL this module would have if it shipped inside dist-server. */
const asDistServer = (root) =>
  `file://${path.join(root, 'dist-server', 'server', 'services', 'runtime-identity.js')}`;

async function writeProvenance(root, value) {
  await mkdir(path.join(root, 'dist-server'), { recursive: true });
  await writeFile(
    path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

test('reports the loaded build version and commit when running from dist-server', async () => {
  await withAppRoot(async (root) => {
    await writeProvenance(root, { version: '1.47.0.10', commit: 'a'.repeat(40), buildId: 'b'.repeat(64) });
    assert.deepEqual(readRuntimeIdentity(root, asDistServer(root)), {
      runtimeVersion: '1.47.0.10', runtimeCommit: 'a'.repeat(40),
    });
  });
});

test('reports nothing when the process runs from source, even with a build on disk', async () => {
  await withAppRoot(async (root) => {
    await writeProvenance(root, { version: '1.47.0.10', commit: 'a'.repeat(40) });
    // tsx dev: dist-server exists but is NOT what is running. Publishing it
    // would restate the lie B-1055 exists to end.
    const fromSource = `file://${path.join(root, 'server', 'services', 'runtime-identity.js')}`;
    assert.equal(isRunningFromDistServer(root, fromSource), false);
    assert.deepEqual(readRuntimeIdentity(root, fromSource), {
      runtimeVersion: null, runtimeCommit: null,
    });
  });
});

test('an absent, corrupt or implausible provenance file degrades to null', async () => {
  await withAppRoot(async (root) => {
    assert.deepEqual(readRuntimeIdentity(root, asDistServer(root)),
      { runtimeVersion: null, runtimeCommit: null }, 'absent');

    await writeProvenance(root, '{not json');
    assert.deepEqual(readRuntimeIdentity(root, asDistServer(root)),
      { runtimeVersion: null, runtimeCommit: null }, 'corrupt');

    await writeProvenance(root, { version: 42, commit: 'x'.repeat(5000) });
    assert.deepEqual(readRuntimeIdentity(root, asDistServer(root)),
      { runtimeVersion: null, runtimeCommit: null }, 'implausible');
  });
});

test('the real repository ships a provenance file this reader understands', () => {
  const provenance = path.join(process.cwd(), 'dist-server', 'BUILD_PROVENANCE.json');
  if (!fs.existsSync(provenance)) return; // no build in this checkout
  const identity = readRuntimeIdentity(process.cwd(), asDistServer(process.cwd()));
  assert.match(identity.runtimeVersion ?? '', /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(identity.runtimeCommit ?? '', /^[a-f0-9]{40}$/);
});
