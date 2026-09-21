import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { acquirePublicPageLock, classifyFlockExit, PublicPagePublisherError } from './public-page-publisher-lock.mjs';

const ID = '0123456789abcdef0123456789abcdef';

function fixture(t) {
  const root = mkdtempSync(path.join(process.cwd(), 'public-page-lock-'));
  chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('kernel lock excludes a concurrent publication and releases exactly once', async t => {
  const root = fixture(t);
  const first = await acquirePublicPageLock(root, ID, { waitMs: 0 });
  await assert.rejects(acquirePublicPageLock(root, ID, { waitMs: 0 }), { code: 'PUBLICATION_BUSY' });
  first.release(); first.release();
  const second = await acquirePublicPageLock(root, ID, { waitMs: 0 });
  second.release();
});

test('unsafe lock roots and lock files fail closed', async t => {
  const root = fixture(t);
  chmodSync(root, 0o755);
  await assert.rejects(acquirePublicPageLock(root, ID), { code: 'PUBLICATION_LOCK_UNCERTAIN' });
  chmodSync(root, 0o700);
  symlinkSync(root, `${root}/${ID}.lock`);
  await assert.rejects(acquirePublicPageLock(root, ID), { code: 'PUBLICATION_LOCK_UNCERTAIN' });
  const nested = `${root}-nested`; mkdirSync(nested, { mode: 0o700 }); t.after(() => rmSync(nested, { recursive: true, force: true }));
  symlinkSync(nested, `${root}/linked-parent`);
  await assert.rejects(acquirePublicPageLock(`${root}/linked-parent`, ID), { code: 'PUBLICATION_LOCK_UNCERTAIN' });
});

test('invalid identities and waits are uncertain rather than guessed', async t => {
  const root = fixture(t);
  // T-1799 widened the id rule to slug publications, so the rejected set is
  // everything still outside it: uppercase, too short, edge hyphen, and any
  // character that is not filename-safe.
  for (const id of ['x', '-lead', 'trail-', 'has_underscore', 'has.dot', 'has/slash', '', ID.toUpperCase()]) {
    await assert.rejects(acquirePublicPageLock(root, id), { code: 'PUBLICATION_LOCK_UNCERTAIN' });
  }
  await assert.rejects(acquirePublicPageLock(root, ID, { waitMs: -1 }), { code: 'PUBLICATION_LOCK_UNCERTAIN' });
});

test('only flock contention exit 75 is retryable busy', () => {
  assert.equal(classifyFlockExit(0), 'ACQUIRED');
  assert.equal(classifyFlockExit(75), 'PUBLICATION_BUSY');
  assert.equal(classifyFlockExit(2), 'PUBLICATION_LOCK_UNCERTAIN');
  assert.equal(classifyFlockExit(null, 'SIGKILL'), 'PUBLICATION_LOCK_UNCERTAIN');
});

test('kernel releases a dead holder without stale cleanup', async t => {
  const root = fixture(t);
  const module = new URL('./public-page-publisher-lock.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquirePublicPageLock } from ${JSON.stringify(module)};
    await acquirePublicPageLock(process.env.LOCK_ROOT, ${JSON.stringify(ID)}, { waitMs: 0 });
    process.stdout.write('READY\\n'); setInterval(() => {}, 1000);
  `], { env: { PATH: process.env.PATH, LOCK_ROOT: root }, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout, 'data');
  child.kill('SIGKILL'); await once(child, 'close');
  const lock = await acquirePublicPageLock(root, ID, { waitMs: 200 });
  lock.release();
});
