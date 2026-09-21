import { useEffect } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import {
  getOutboxAccountEpoch, getOutboxSnapshot, subscribeOutbox,
  reserveOutboxRecoveryAttempt, hasCanonicalOutboxProof, removeOutboxEntryWithProof,
  canReconcileOutboxHistory,
  type OutboxEntry,
} from '../utils/messageOutbox';

export const OUTBOX_RECOVERY_BODY_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const DELAYS = [0, 2000, 5000, 15000, 30000];
type HistoryRow = Parameters<typeof hasCanonicalOutboxProof>[1][number];
type Page = { messages: HistoryRow[]; hasMore?: boolean; nextCursor?: string | null; revision?: string };

/** Bound decoded response bytes before parsing, including chunked responses. */
export async function readBoundedOutboxHistory(response: Response, signal: AbortSignal): Promise<Page> {
  if (!response.body) throw new Error('history_body_missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > OUTBOX_RECOVERY_BODY_BYTES) throw new Error('history_body_limit');
      chunks.push(value);
    }
    if (signal.aborted) throw new Error('history_aborted');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!data || !Array.isArray(data.messages) || data.messages.length > 20
      || data.messages.some((row: HistoryRow) => !row || typeof row.id !== 'string' || typeof row.kind !== 'string')
      || (data.historySchema !== undefined && data.historySchema !== 1)
      || (data.payloadMode !== undefined && data.payloadMode !== 'full')
      || (data.hasMore !== undefined && typeof data.hasMore !== 'boolean')
      || (data.nextCursor != null && (typeof data.nextCursor !== 'string' || data.nextCursor.length > 2048))
      || (data.revision !== undefined && (typeof data.revision !== 'string' || data.revision.length > 2048))) {
      throw new Error('history_unsupported_response');
    }
    return data as Page;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** One scoped session pass; every page and retry consumes a durable budget slot. */
export async function recoverOutboxSession(
  entries: readonly OutboxEntry[], account: string, signal: AbortSignal, current: () => boolean,
): Promise<'permanent' | void> {
  const entry = entries[0];
  if (!entry?.sessionId || !entry.intent.provider) return;
  const scope = JSON.stringify([account, entry.projectId, entry.intent.provider, entry.sessionId]);
  const params = new URLSearchParams({ limit: '20', payload: 'full', offset: '0' });
  for (let attempt = 0; attempt < DELAYS.length; attempt += 1) {
    await delay(DELAYS[attempt], signal);
    if (!current() || !await reserveOutboxRecoveryAttempt(scope) || !current()) return;
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, 10000);
    try {
      const response = await authenticatedFetch(
        `/api/providers/sessions/${encodeURIComponent(entry.sessionId)}/messages?${params.toString()}`,
        { signal: request.signal, __isRetry: true },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status < 500 && response.status !== 429) return 'permanent';
        continue;
      }
      const page = await readBoundedOutboxHistory(response, request.signal);
      if (!current() || request.signal.aborted) return;
      for (const candidate of entries) {
        if (!current()) return;
        // A refreshed/replaced payload must be verified in its own pass.
        if (!getOutboxSnapshot().includes(candidate)) continue;
        const proof = hasCanonicalOutboxProof(candidate, page.messages);
        if (proof) await removeOutboxEntryWithProof(candidate, proof);
      }
      if (!getOutboxSnapshot().some(row => entries.some(candidate => candidate.id === row.id))) return;
      if (page.hasMore) {
        if (page.nextCursor) {
          params.delete('offset'); params.set('cursor', page.nextCursor);
          if (page.revision) params.set('revision', page.revision);
        } else if (!params.has('cursor') && page.messages.length > 0) {
          params.set('offset', String(Number(params.get('offset')) + page.messages.length));
        } else return;
      } else {
        params.delete('cursor'); params.delete('revision'); params.set('offset', '0');
      }
    } catch {
      // Missing/oversized/aborted history is unknown evidence, never deletion.
      if (!current()) return;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
      request.abort();
    }
  }
}

function automaticRecoveryEnabled(): boolean {
  try { return localStorage.getItem('nassaj_ob2_automatic_recovery') !== 'disabled'; }
  catch { return false; }
}

/** Auth-owned recovery survives chat navigation and never sends a user message. */
export function useOutboxDurableRecovery(account: string | number | null): void {
  useEffect(() => {
    if (account === null || !navigator.locks) return;
    let disposed = false;
    let running = false;
    let requested = false;
    const blockedScopes = new Set<string>();
    let controller: AbortController | null = null;
    let wake: ReturnType<typeof setTimeout> | undefined;
    const eligible = () => !disposed && document.visibilityState === 'visible'
      && navigator.onLine && automaticRecoveryEnabled();
    const run = async () => {
      if (!eligible()) return;
      if (running) { requested = true; return; }
      requested = false;
      running = true;
      const epoch = getOutboxAccountEpoch();
      controller = new AbortController();
      const signal = controller.signal;
      const current = () => eligible() && !signal.aborted && getOutboxAccountEpoch() === epoch;
      try {
        await navigator.locks.request('nassaj-outbox-v2-recovery', { ifAvailable: true }, async lock => {
          if (!lock || !current()) return;
          const groups = new Map<string, OutboxEntry[]>();
          for (const entry of getOutboxSnapshot()) {
            // Unsupported providers and incomplete original inventories can
            // never produce a positive proof. Keep their visible recovery UI,
            // but do not spend the five bounded background history reads.
            if (!entry.sessionId || !entry.intent.provider || !canReconcileOutboxHistory(entry)) continue;
            const key = JSON.stringify([entry.projectId, entry.intent.provider, entry.sessionId]);
            groups.set(key, [...(groups.get(key) ?? []), entry]);
          }
          for (const [key, entries] of groups) {
            if (!current()) break;
            if (blockedScopes.has(key)) continue;
            if (await recoverOutboxSession(entries, String(account), signal, current) === 'permanent') blockedScopes.add(key);
          }
        });
      } catch { /* Storage/lock failure preserves every local copy. */ }
      finally {
        running = false;
        controller = null;
        if (!disposed) { clearTimeout(wake); wake = setTimeout(() => { void run(); }, requested ? 2000 : DAY_MS); }
      }
    };
    const changed = () => {
      if (!eligible()) { controller?.abort(); return; }
      clearTimeout(wake);
      wake = setTimeout(() => { void run(); }, 2000);
    };
    const unsubscribe = subscribeOutbox(changed);
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    window.addEventListener('focus', changed);
    window.addEventListener('storage', changed);
    void run();
    return () => {
      disposed = true;
      controller?.abort(); clearTimeout(wake); unsubscribe();
      document.removeEventListener('visibilitychange', changed);
      for (const event of ['online', 'offline', 'focus', 'storage']) window.removeEventListener(event, changed);
    };
  }, [account]);
}
