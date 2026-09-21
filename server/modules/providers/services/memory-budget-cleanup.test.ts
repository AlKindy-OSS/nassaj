/** Local synthetic resources only; close faults retain real descriptors until explicitly repaired. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { HistoryAdmission, HistoryReadLease, HISTORY_LIMITS } from './history-budget.service.js';
const descriptor = { user: 'fixture', session: 'fixture', provider: 'codex' };
async function fixture(run: (root: string, file: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.resolve('.memory-c1-cleanup-'));
  try { const file = path.join(root, 'main.jsonl'); await fs.writeFile(file, '{"text":"fixture"}\n'); await run(root, file); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
test('failed descriptor close keeps job/admission; queued/new readers fail busy and shared retry releases once', async () => fixture(async (_, file) => {
  const open = fs.open, handles: { restore(): void; calls(): number }[] = [], admission = new HistoryAdmission();
  const lease = new HistoryReadLease(new AbortController().signal); let fail = true, repair!: () => void, releaseGate!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const release = await admission.acquire(descriptor, new AbortController().signal);
  try {
    fs.open = async (...args: Parameters<typeof open>) => {
      const fd = await open(...args), close = fd.close.bind(fd); let calls = 0;
      fd.close = async () => { calls++; if (fail) throw new Error('close fault'); entered(); await gate; await close(); };
      repair = () => { fd.close = close; }; handles.push({ restore: repair, calls: () => calls }); return fd;
    };
    await lease.initialize(file); fs.open = open;
    const waiting = assert.rejects(admission.acquire({ ...descriptor, session: 'queued' }, new AbortController().signal), { code: 'HISTORY_BUSY' });
    await assert.rejects(admission.closeAndRelease(lease, release), { code: 'HISTORY_SOURCE_UNAVAILABLE' }); await waiting;
    assert.equal(admission.active, 1); assert.equal(admission.queued, 0); assert.equal(admission.quarantined, true);
    assert.equal(lease.counts.jobBytes, HISTORY_LIMITS.jobBytes); release(); assert.equal(admission.active, 1);
    await assert.rejects(admission.acquire(descriptor, new AbortController().signal), { code: 'HISTORY_BUSY' });
    await assert.rejects(lease.admit(file), { code: 'HISTORY_SOURCE_UNAVAILABLE' });
    fail = false; const first = admission.retryCleanup(), second = admission.retryCleanup(); await started;
    assert.equal(admission.active, 1); assert.equal(handles[0].calls(), 2); releaseGate(); await Promise.all([first, second]);
    assert.equal(admission.active, 0); assert.equal(admission.quarantined, false); await admission.retryCleanup(); assert.equal(handles[0].calls(), 2);
    (await admission.acquire(descriptor, new AbortController().signal))(); assert.equal(admission.active, 0);
  } finally { fs.open = open; releaseGate(); handles.forEach(handle => handle.restore()); await admission.retryCleanup(); await lease.close(); release(); }
}));
test('failed close before fstat admission retains the same descriptor instead of losing it outside sources', async () => fixture(async (_, file) => {
  const open = fs.open, admission = new HistoryAdmission(), lease = new HistoryReadLease(new AbortController().signal);
  const release = await admission.acquire(descriptor, new AbortController().signal); let restore!: () => void, attempts = 0;
  try {
    fs.open = async (...args: Parameters<typeof open>) => {
      const fd = await open(...args), close = fd.close.bind(fd); restore = () => { fd.close = close; };
      fd.stat = async () => { throw new Error('stat fault'); };
      fd.close = async () => { attempts++; throw new Error('close fault'); }; return fd;
    };
    await assert.rejects(lease.initialize(file), { code: 'HISTORY_SOURCE_UNAVAILABLE' }); fs.open = open;
    await assert.rejects(admission.closeAndRelease(lease, release), { code: 'HISTORY_SOURCE_UNAVAILABLE' });
    assert.equal(attempts, 2); assert.equal(admission.active, 1); restore(); await admission.retryCleanup(); assert.equal(admission.active, 0);
  } finally { fs.open = open; restore?.(); await admission.retryCleanup(); await lease.close(); release(); }
}));
test('stream destruction waits for its pending read and close before releasing admission', async () => fixture(async (_, file) => {
  const open = fs.open, admission = new HistoryAdmission(), lease = new HistoryReadLease(new AbortController().signal);
  const release = await admission.acquire(descriptor, new AbortController().signal); let unblock!: () => void, entered!: () => void, settled = false;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    fs.open = async (...args: Parameters<typeof open>) => {
      const fd = await open(...args), read = fd.read.bind(fd), close = fd.close.bind(fd);
      fd.read = (async (...values: Parameters<typeof read>) => { entered(); await gate; const result = await read(...values); settled = true; return result; }) as typeof fd.read;
      fd.close = async () => { assert.equal(settled, true); await close(); }; return fd;
    };
    await lease.initialize(file); fs.open = open; const stream = lease.stream(file); stream.on('error', () => {}); stream.resume(); await started;
    const closing = admission.closeAndRelease(lease, release); assert.equal(admission.active, 1); assert.equal(stream.closed, false);
    unblock(); await closing; assert.equal(stream.closed, true); assert.equal(admission.active, 0);
  } finally { fs.open = open; unblock(); await admission.retryCleanup(); await lease.close(); release(); }
}));
test('close drains a late open before handle registration and forbids new streams while waiting', async () => fixture(async (_, file) => {
  const open = fs.open, admission = new HistoryAdmission(), lease = new HistoryReadLease(new AbortController().signal);
  const release = await admission.acquire(descriptor, new AbortController().signal); let unblock!: () => void, entered!: () => void, closed = false;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    fs.open = async (...args: Parameters<typeof open>) => {
      const fd = await open(...args), close = fd.close.bind(fd); fd.close = async () => { await close(); closed = true; };
      entered(); await gate; return fd;
    };
    const initializing = assert.rejects(lease.initialize(file), { code: 'HISTORY_SOURCE_UNAVAILABLE' }); await started;
    const closing = admission.closeAndRelease(lease, release); await new Promise(resolve => setImmediate(resolve));
    assert.equal(admission.active, 1); assert.equal(closed, false); assert.throws(() => lease.stream(file), { code: 'HISTORY_SOURCE_UNAVAILABLE' });
    unblock(); await initializing; await closing; assert.equal(closed, true); assert.equal(admission.active, 0);
  } finally { fs.open = open; unblock(); await admission.retryCleanup(); await lease.close(); release(); }
}));
test('pending directory open is adopted and closed before admission release', async () => fixture(async (root, file) => {
  const directory = path.join(root, 'sidecars'); await fs.mkdir(directory);
  const opendir = fs.opendir, admission = new HistoryAdmission(), lease = new HistoryReadLease(new AbortController().signal);
  const release = await admission.acquire(descriptor, new AbortController().signal); let unblock!: () => void, entered!: () => void, closed = false;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    await lease.initialize(file);
    fs.opendir = (async (...args: Parameters<typeof opendir>) => {
      const dir = await opendir(...args), close = dir.close.bind(dir);
      dir.close = (async () => { await close(); closed = true; }) as typeof dir.close;
      entered(); await gate; return dir;
    }) as typeof fs.opendir;
    const enumerating = assert.rejects(lease.directory(directory), { code: 'HISTORY_SOURCE_UNAVAILABLE' }); await started;
    const closing = admission.closeAndRelease(lease, release); await new Promise(resolve => setImmediate(resolve));
    assert.equal(admission.active, 1); assert.equal(closed, false); unblock(); await enumerating; await closing;
    assert.equal(closed, true); assert.equal(admission.active, 0);
  } finally { fs.opendir = opendir; unblock(); await admission.retryCleanup(); await lease.close(); release(); }
}));
test('retry skips handles already closed successfully when another source close fails', async () => fixture(async (root, file) => {
  const sidecar = path.join(root, 'sidecar.jsonl'); await fs.writeFile(sidecar, '{}\n');
  const open = fs.open, lease = new HistoryReadLease(new AbortController().signal); let repair!: () => void, successfulCalls = 0;
  try {
    fs.open = async (...args: Parameters<typeof open>) => {
      const fd = await open(...args), close = fd.close.bind(fd);
      if (args[0] === file) { repair = () => { fd.close = close; }; fd.close = async () => { throw new Error('close fault'); }; }
      else fd.close = async () => { successfulCalls++; await close(); }; return fd;
    };
    await lease.initialize(file); await lease.admit(sidecar); fs.open = open;
    await assert.rejects(lease.close(), { code: 'HISTORY_SOURCE_UNAVAILABLE' }); assert.equal(successfulCalls, 1);
    repair(); await Promise.all([lease.close(), lease.close()]); assert.equal(successfulCalls, 1);
  } finally { fs.open = open; repair?.(); await lease.close(); }
}));
test('close waits for an already started stat and rejects source reuse after it settles', async () => fixture(async (_, file) => {
  const lstat = fs.lstat, lease = new HistoryReadLease(new AbortController().signal), admission = new HistoryAdmission();
  const release = await admission.acquire(descriptor, new AbortController().signal); let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    await lease.initialize(file);
    fs.lstat = (async (...args: Parameters<typeof lstat>) => { entered(); await gate; return lstat(...args); }) as typeof fs.lstat;
    const reading = assert.rejects(lease.stat(file), { code: 'HISTORY_SOURCE_UNAVAILABLE' }); await started;
    const closing = admission.closeAndRelease(lease, release); await new Promise(resolve => setImmediate(resolve)); assert.equal(admission.active, 1);
    unblock(); await reading; await closing; assert.equal(admission.active, 0);
  } finally { fs.lstat = lstat; unblock(); await admission.retryCleanup(); await lease.close(); release(); }
}));
test('direct generator pending read settles and drops its frame before descriptor closure', async () => fixture(async (_, file) => {
  const open = fs.open, lease = new HistoryReadLease(new AbortController().signal), admission = new HistoryAdmission();
  const release = await admission.acquire(descriptor, new AbortController().signal); let unblock!: () => void, entered!: () => void, settled = false;
  const gate = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    fs.open = async (...args: Parameters<typeof open>) => {
      const fd = await open(...args), read = fd.read.bind(fd), close = fd.close.bind(fd);
      fd.read = (async (...values: Parameters<typeof read>) => { entered(); await gate; const value = await read(...values); settled = true; return value; }) as typeof fd.read;
      fd.close = async () => { assert.equal(settled, true); await close(); }; return fd;
    };
    await lease.initialize(file); fs.open = open; const iterator = lease.lines(file);
    const next = assert.rejects(iterator.next(), { code: 'HISTORY_SOURCE_UNAVAILABLE' }); await started;
    const closing = admission.closeAndRelease(lease, release); assert.equal(admission.active, 1); unblock(); await next; await closing;
    assert.equal((await iterator.next()).done, true); assert.equal(admission.active, 0);
  } finally { fs.open = open; unblock(); await admission.retryCleanup(); await lease.close(); release(); }
}));
