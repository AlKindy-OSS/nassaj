/**
 * B-1531 — the image outbox must never hold an IndexedDB connection open.
 *
 * An identity purge deletes `nassaj-outbox`. A connection left open by a blob
 * operation (or one that ignores `versionchange`) blocked that delete and
 * locked the whole page behind the identity barrier.
 *
 * RUNNER: vitest — jsdom, with a minimal IndexedDB stand-in installed before
 * the module is imported (the blob store is chosen at import time).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type FakeDb = {
  name: string;
  closed: boolean;
  onversionchange: ((event?: unknown) => void) | null;
  close: () => void;
  objectStoreNames: { contains: () => boolean };
  createObjectStore: () => void;
  transaction: () => Record<string, unknown>;
};

const opened: FakeDb[] = [];

function makeDb(name: string): FakeDb {
  const db: FakeDb = {
    name,
    closed: false,
    onversionchange: null,
    close() { db.closed = true; },
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const tx: Record<string, unknown> = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = () => ({ clear() {}, put() {}, delete() {}, get() {
        const request: Record<string, unknown> = {};
        queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.());
        return request;
      } });
      setTimeout(() => (tx.oncomplete as (() => void) | null)?.(), 0);
      return tx;
    },
  };
  return db;
}

beforeEach(() => {
  opened.length = 0;
  vi.resetModules();
  vi.stubGlobal('indexedDB', {
    open(name: string) {
      const request: Record<string, unknown> = {};
      queueMicrotask(() => {
        const db = makeDb(name);
        opened.push(db);
        request.result = db;
        (request.onsuccess as (() => void) | undefined)?.();
      });
      return request;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('closes the blob-store connection once its transaction completes', async () => {
  const outbox = await import('./messageOutbox');
  outbox.clearOutbox();
  await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(opened.every((db) => db.closed)).toBe(true));
});

it('yields to a versionchange so a purge delete is never blocked by this page', async () => {
  const outbox = await import('./messageOutbox');
  outbox.clearOutbox();
  await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
  const [db] = opened;
  expect(typeof db.onversionchange).toBe('function');
  db.closed = false;
  db.onversionchange?.();
  expect(db.closed).toBe(true);
});
