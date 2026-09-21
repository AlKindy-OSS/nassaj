import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  atomicWritePrivateJson,
  acquireGrantRequestLease,
  isGrantRevocationPending,
  markGrantRevocationPending,
  refreshGrantSingleFlight,
  withGrantLock,
  withGrantRequestLease,
} from './grant-file.js';

test('revocation tombstone is durable, idempotent, and blocks refresh inside the grant lock', async () => {
  const root = scratch('grant-revocation');
  const file = path.join(root, 'grant.json');
  try {
    atomicWritePrivateJson(file, {
      access_token: 'kept-for-revoke', refresh_token: 'refresh', expires_at: 0,
      token_url: 'https://example.test/token',
    });
    await markGrantRevocationPending(file);
    await markGrantRevocationPending(file);
    assert.equal(isGrantRevocationPending(file), true);
    let refreshCalls = 0;
    await assert.rejects(() => refreshGrantSingleFlight({
      file,
      needsRefresh: () => true,
      refresh: async (current) => { refreshCalls += 1; return current; },
    }), /طلب إبطال/);
    assert.equal(refreshCalls, 0);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refresh_token, 'refresh');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('durable tombstone blocks new leases while an already-started request drains', async () => {
  const root = scratch('grant-request-gate');
  const file = path.join(root, 'grant.json');
  try {
    atomicWritePrivateJson(file, {
      access_token: 'live', refresh_token: 'refresh', expires_at: Date.now() + 60_000,
      token_url: 'https://example.test/token',
    });
    const lease = await acquireGrantRequestLease(file);
    const marking = markGrantRevocationPending(file, { drainMs: 1_000 });
    for (let attempt = 0; attempt < 100 && !isGrantRevocationPending(file); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await assert.rejects(() => acquireGrantRequestLease(file), /طلب إبطال/);
    assert.equal(fs.existsSync(`${file}.revocation-pending.json`), true,
      'DELETE-visible tombstone is durable before drain completes');
    lease.release();
    assert.deepEqual(await marking, { drained: true });
    assert.equal(fs.existsSync(`${file}.revocation-pending.json`), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('request lease is the final launch gate and starts no fetch after intent', async () => {
  const root = scratch('grant-final-launch-gate');
  const file = path.join(root, 'grant.json');
  try {
    atomicWritePrivateJson(file, { access_token: 'never-send' });
    await markGrantRevocationPending(file);
    let requestStarts = 0;
    await assert.rejects(
      () => withGrantRequestLease(file, async () => {
        requestStarts += 1;
        await fetch('https://127.0.0.1:1/must-not-start');
      }),
      /طلب إبطال/,
    );
    assert.equal(requestStarts, 0, 'the callback containing fetch never begins');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lock-held marker timeout fails explicitly, then retry gates every future request', async () => {
  const root = scratch('grant-marker-lock-timeout');
  const file = path.join(root, 'grant.json');
  let releaseOwner = () => {};
  let ownerEntered = () => {};
  try {
    atomicWritePrivateJson(file, { access_token: 'kept' });
    const entered = new Promise<void>((resolve) => { ownerEntered = resolve; });
    const owner = withGrantLock(file, async () => {
      ownerEntered();
      await new Promise<void>((resolve) => { releaseOwner = resolve; });
    });
    await entered;
    await assert.rejects(
      () => markGrantRevocationPending(file, { lockWaitMs: 40 }),
      /تعذّر قفل/,
    );
    assert.equal(fs.existsSync(`${file}.revocation-pending.json`), false,
      'a failed lock attempt must not claim a persisted tombstone');
    releaseOwner();
    await owner;

    assert.deepEqual(await markGrantRevocationPending(file), { drained: true });
    let futureStarts = 0;
    await assert.rejects(() => withGrantRequestLease(file, async () => {
      futureStarts += 1;
    }), /طلب إبطال/);
    assert.equal(futureStarts, 0);
  } finally {
    releaseOwner();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('drain timeout keeps its tombstone and a dead PID lease is swept on retry', async () => {
  const root = scratch('grant-drain-timeout');
  const file = path.join(root, 'grant.json');
  try {
    atomicWritePrivateJson(file, { access_token: 'kept' });
    const live = await acquireGrantRequestLease(file);
    assert.deepEqual(await markGrantRevocationPending(file, { drainMs: 30 }), { drained: false });
    assert.equal(fs.existsSync(`${file}.revocation-pending.json`), true);
    live.release();

    const leases = `${file}.request-leases`;
    fs.mkdirSync(leases, { recursive: true, mode: 0o700 });
    atomicWritePrivateJson(path.join(leases, 'dead.json'), {
      pid: 2_147_483_000,
      createdAt: Date.now() - 10 * 60 * 1000,
    });
    assert.deepEqual(await markGrantRevocationPending(file), { drained: true });
    assert.deepEqual(fs.readdirSync(leases), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('revocation markers and grant directories never follow symlinks', async () => {
  const root = scratch('grant-symlink');
  try {
    const file = path.join(root, 'grant.json');
    atomicWritePrivateJson(file, { access_token: 'kept' });
    const outside = path.join(root, 'outside');
    fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, `${file}.revocation-pending.json`);
    assert.throws(() => isGrantRevocationPending(file), /غير آمن/);
    assert.equal(fs.existsSync(outside), true);

    const realDirectory = path.join(root, 'real-auth');
    fs.mkdirSync(realDirectory);
    const linkedDirectory = path.join(root, 'linked-auth');
    fs.symlinkSync(realDirectory, linkedDirectory);
    await assert.rejects(
      () => markGrantRevocationPending(path.join(linkedDirectory, 'grant.json')),
      /غير آمن/,
    );

    const ancestorTarget = path.join(root, 'ancestor-target');
    const ancestorLink = path.join(root, 'ancestor-link');
    fs.mkdirSync(ancestorTarget);
    fs.symlinkSync(ancestorTarget, ancestorLink);
    assert.throws(
      () => atomicWritePrivateJson(path.join(ancestorLink, 'nested', 'grant.json'), { access_token: 'x' }),
      /غير آمن/,
    );
    assert.equal(fs.existsSync(path.join(ancestorTarget, 'nested')), false,
      'ancestor rejection happens before recursive mkdir mutates the target');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scratch(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

test('atomic JSON promotion repairs legacy file and directory modes', () => {
  const root = scratch('grant-mode');
  const file = path.join(root, 'grant.json');
  try {
    fs.chmodSync(root, 0o755);
    fs.writeFileSync(file, '{"old":true}', { mode: 0o644 });
    atomicWritePrivateJson(file, { current: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { current: true });
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale lock owned by a dead process is recovered without touching the grant', async () => {
  const root = scratch('grant-stale-lock');
  const file = path.join(root, 'grant.json');
  const lock = `${file}.lock`;
  try {
    atomicWritePrivateJson(file, { access_token: 'kept' });
    fs.mkdirSync(lock);
    atomicWritePrivateJson(path.join(lock, 'owner.json'), {
      token: 'dead-owner',
      pid: 2_147_483_000,
      createdAt: Date.now() - 10 * 60 * 1000,
    });
    let ran = false;
    await withGrantLock(file, () => { ran = true; });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lock), false);
    assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { access_token: string }).access_token, 'kept');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a committed generation clears its leftover journal and advances without ambiguity', async () => {
  const root = scratch('grant-committed-journal');
  const file = path.join(root, 'grant.json');
  try {
    atomicWritePrivateJson(file, {
      access_token: 'new',
      refresh_token: 'rotated',
      expires_at: 0,
      token_url: 'https://example.test/token',
      generation: 8,
      last_refresh_id: 'attempt-8',
    });
    atomicWritePrivateJson(`${file}.refreshing.json`, {
      id: 'attempt-8',
      fromGeneration: 7,
      createdAt: Date.now(),
    });
    let refreshCalls = 0;
    const grant = await refreshGrantSingleFlight({
      file,
      needsRefresh: () => true,
      refresh: async (current) => {
        refreshCalls += 1;
        return { ...current, access_token: 'newer' };
      },
    });
    assert.equal(refreshCalls, 1);
    assert.equal(grant.generation, 9);
    assert.equal(fs.existsSync(`${file}.refreshing.json`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
