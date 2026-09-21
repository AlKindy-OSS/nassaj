import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  __setBrokenModelsStorePathForTests,
  brokenModelsUserKey,
  getBrokenModels,
  recordBrokenModel,
} from '@/modules/providers/list/claude/claude-broken-models.store.js';

const withTempStore = async (run: (storePath: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-broken-store-'));
  const storePath = path.join(dir, 'broken.json');
  __setBrokenModelsStorePathForTests(storePath);
  try {
    await run(storePath);
  } finally {
    __setBrokenModelsStorePathForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
};

test('brokenModelsUserKey: null/undefined/empty collapse to a single shared bucket', () => {
  assert.equal(brokenModelsUserKey(null), '__shared__');
  assert.equal(brokenModelsUserKey(undefined), '__shared__');
  assert.equal(brokenModelsUserKey(''), '__shared__');
  assert.equal(brokenModelsUserKey(7), '7');
  assert.equal(brokenModelsUserKey('alice'), 'alice');
});

test('recordBrokenModel: records a model and getBrokenModels returns it for the same user', async () => {
  await withTempStore(async () => {
    assert.deepEqual([...(await getBrokenModels('u1'))], []);
    const added = await recordBrokenModel('u1', 'claude-fable-5');
    assert.equal(added, true);
    assert.deepEqual([...(await getBrokenModels('u1'))], ['claude-fable-5']);
  });
});

test('recordBrokenModel: is idempotent (second record of the same value returns false)', async () => {
  await withTempStore(async () => {
    assert.equal(await recordBrokenModel('u1', 'claude-fable-5'), true);
    assert.equal(await recordBrokenModel('u1', 'claude-fable-5'), false);
    assert.deepEqual([...(await getBrokenModels('u1'))], ['claude-fable-5']);
  });
});

test('recordBrokenModel: ignores empty/whitespace model values', async () => {
  await withTempStore(async () => {
    assert.equal(await recordBrokenModel('u1', ''), false);
    assert.equal(await recordBrokenModel('u1', '   '), false);
    assert.deepEqual([...(await getBrokenModels('u1'))], []);
  });
});

test('broken models are isolated per user', async () => {
  await withTempStore(async () => {
    await recordBrokenModel('u1', 'claude-fable-5');
    await recordBrokenModel('u2', 'some-other-model');

    assert.deepEqual([...(await getBrokenModels('u1'))], ['claude-fable-5']);
    assert.deepEqual([...(await getBrokenModels('u2'))], ['some-other-model']);
    // A user with no broken models gets an empty set.
    assert.deepEqual([...(await getBrokenModels('u3'))], []);
  });
});

test('getBrokenModels returns a defensive copy (mutating it does not affect the store)', async () => {
  await withTempStore(async () => {
    await recordBrokenModel('u1', 'a');
    const first = await getBrokenModels('u1');
    first.add('mutation');
    const second = await getBrokenModels('u1');
    assert.deepEqual([...second], ['a'], 'store is unaffected by mutating a returned set');
  });
});

test('the store persists to disk and reloads after a fresh in-memory state', async () => {
  await withTempStore(async (storePath) => {
    await recordBrokenModel('u1', 'claude-fable-5');
    await recordBrokenModel('u1', 'another-broken');

    // The file is written with the expected shape.
    const onDisk = JSON.parse(await readFile(storePath, 'utf8')) as {
      version: number;
      entries: Record<string, string[]>;
    };
    assert.equal(onDisk.version, 1);
    assert.deepEqual(onDisk.entries.u1.sort(), ['another-broken', 'claude-fable-5']);

    // Simulate a restart: reset in-memory state but keep the SAME file path, then
    // a read must reload the persisted set from disk.
    __setBrokenModelsStorePathForTests(storePath);
    const reloaded = await getBrokenModels('u1');
    assert.deepEqual([...reloaded].sort(), ['another-broken', 'claude-fable-5']);
  });
});
